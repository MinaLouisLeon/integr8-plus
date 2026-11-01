# The database

One Postgres, one schema, every company separated by `tenant_id`. This folder
explains how that separation is enforced, how to change the schema safely, and
what to do when the database needs restoring.

| Document                                                         | When you need it                                |
| ---------------------------------------------------------------- | ----------------------------------------------- |
| [migrations.md](./migrations.md)                                 | Read before every migration, and to roll back   |
| [runbook-backup-and-restore.md](./runbook-backup-and-restore.md) | Nightly dumps, copies off the machine, restores |

The database is a plain Postgres 16: the `postgres` container in
`deploy/compose.yml` on a server, or one on your machine for development.
Creating an environment from nothing is the
[setup checklist](../deployment/setup-checklist.md). The self-hosted Supabase
Auth keeps its sign-in accounts in the same database, in its own `auth` schema
([`docs/auth/self-hosted-auth.md`](../auth/self-hosted-auth.md)); everything
below is about `public`.

---

## The tenancy model in one page

Every table is one of three things.

**The tenant.** `tenants` — one row per customer company. Its `id` is the
`tenant_id` every other table carries.

**Outside all tenants.** `platform_users` (super admins) and
`schema_migrations`. These are listed in `PLATFORM_TABLES` in
`packages/db/src/schema.ts`, and that list is the only way to opt a table out of
tenant scoping.

**Tenant-scoped.** Everything else. A non-null `tenant_id` with a foreign key to
`tenants(id)`, row-level security enabled, and a policy keyed on the current
tenant context. The schema-invariant suite checks all four of those against the
live catalogue, for every table, on every CI run — so a table added in P10 that
forgets one of them fails the build rather than shipping.

## Three controls, each sufficient alone

Isolation does not rest on one mechanism, and each is tested with the others
switched off so that none can quietly be covering for another.

**1. The repository layer — the primary control.** Nothing outside
`packages/db` may import `kysely` or `pg`; ESLint rejects it. Callers get
`getTenantDataSource(tenantId)` and repositories, and every repository method
filters by the `tenant_id` of the transaction's scope. Inserts take it from that
scope rather than from a parameter, so there is no argument to pass wrongly.

_Proven by_ `repository-isolation.integration.test.ts`, which runs the
repositories as the schema owner — no RLS, no query guard. Remove a `tenant_id`
predicate and the other company's rows come back and the suite fails.

**2. The query guard.** `TenantGuardPlugin` inspects every statement before it
reaches the driver. If it touches a tenant-scoped table and names `tenant_id`
nowhere, it throws instead of running. Coarse by design: it proves a predicate
exists, not that it is right.

_Proven by_ `tenant-guard.test.ts`, which needs no database and runs on every
commit.

**3. Row-level security — the backstop.** Policies compare `tenant_id` against
`app_current_tenant_id()`, which reads the `app.tenant_id` GUC. The runtime role
`integr8_app` is neither superuser, nor `BYPASSRLS`, nor an owner of any table,
and `assertRlsEnforced()` refuses to open a pool if any of that stops being
true.

_Proven by_ `rls-backstop.integration.test.ts`, which issues deliberately
unfiltered raw SQL as `integr8_app`.

RLS is the backstop, not the primary control. Relying on it alone would make
every future query a security review.

## Why the context is transaction-local

The tenant is set by `set_config('app.tenant_id', $1, true)` as the first
statement of every tenant transaction — the `true` makes it transaction-local.

This is not a style preference. A pooled connection is handed to different
tenants between transactions — by the API's own pool today, and by a
transaction-mode pooler such as PgBouncer if one is ever put in front. A session-level setting would survive into the next
tenant's work and leak — intermittently, in proportion to load, and invisibly.
`tenant-data-source.integration.test.ts` forces the pool to a single connection
and interleaves two companies to prove it does not.

Unset context yields NULL, and `tenant_id = NULL` is NULL rather than true. No
context therefore means no rows: the failure mode is a blank screen, not a leak.

## The roles

| Role               | Used by                                                                         | RLS applies    |
| ------------------ | ------------------------------------------------------------------------------- | -------------- |
| `integr8_app`      | Every tenant request (`DATABASE_URL`)                                           | Yes            |
| `integr8_platform` | The API and worker outside one company (`DATABASE_URL_PLATFORM`)                | No (BYPASSRLS) |
| owner — `postgres` | Migrations, the template library sync, seeds, the suites (`DATABASE_URL_ADMIN`) | No             |

Two more login roles exist beside them: `integr8_auth`, the narrow
pre-authentication role sign-in uses (`DATABASE_URL_AUTH`; see
[`docs/auth/`](../auth/README.md)), and `supabase_auth_admin`, which owns the
`auth` schema and is used only by the Auth container. `pnpm --filter
@integr8/db db bootstrap` creates all of them (the last only when
`SUPABASE_AUTH_DB_PASSWORD` is set; the others need `INTEGR8_APP_PASSWORD`,
`INTEGR8_AUTH_PASSWORD` and `INTEGR8_PLATFORM_PASSWORD`); the compose stack
runs it on every start. None of our roles holds anything on `auth`.

Tables are `enable row level security` but **not** `force`, so the owner
bypasses policies. That is deliberate: it is what makes the repository suite
meaningful. It is also what makes connecting as the owner catastrophic, which is
why `assertRlsEnforced()` checks at startup rather than trusting the connection
string.

### The platform role

Staff screens, creating a company, the job queue, metering, dunning, the
scheduled purge and the first step of sign-in work across companies, through
`getPlatformDataSource()`. They used to connect as the owner, a superuser, so a
compromised API or worker process could have dropped the schema, lifted the
append-only triggers, read files on the database server or reached any other
database in the cluster.

`integr8_platform` (migration 0058) does that work instead. Bootstrap gives it
`BYPASSRLS` (only a superuser can) and makes sure it is not a superuser and
cannot create roles or databases. 0058 grants it `select, insert, update,
delete` on every table in `public`, `select` only on `schema_migrations` (the
readiness check reads it), the sequences, and `execute` on `purge_tenant()`.
It owns nothing, so it cannot alter, drop or truncate a table, disable a
trigger or grant anything; the append-only triggers bind it as they bind every
role. The purge still works when it calls it: `purge_tenant()` is security
definer, owned by the superuser that runs migrations, and that is what lets it
set `session_replication_role`.

Unlike the two narrow roles, it reaches tables made by later migrations
through default privileges set in 0058: it stands where the owner stood, and a
table the platform code reads must not work everywhere but production. The
schema-invariant suite checks it covers every table and nothing more, and
`platform-role.integration.test.ts` tries what it must not be able to do.

`DATABASE_URL_PLATFORM` unset means the owner stands in for it, which is what a
laptop and the CLIs run in the `migrate` container do. In production the API
and the worker refuse to start with `DATABASE_URL_ADMIN` set or
`DATABASE_URL_PLATFORM` missing, and check at start-up that the platform
connection is not a superuser (`assertPlatformRoleIsLimited()`).

### Who holds which password

`deploy/compose.yml` gives each container only the settings it needs, by name:

| Service         | Gets                                                                                    |
| --------------- | --------------------------------------------------------------------------------------- |
| `postgres`      | `POSTGRES_PASSWORD`                                                                     |
| `bootstrap`     | `DATABASE_URL_ADMIN`, the three role passwords, `SUPABASE_AUTH_DB_PASSWORD`             |
| `migrate`       | `DATABASE_URL_ADMIN`                                                                    |
| `auth`          | its own connection string and `SUPABASE_AUTH_JWT_SECRET`                                |
| `api`, `worker` | `DATABASE_URL`, `DATABASE_URL_AUTH`, `DATABASE_URL_PLATFORM` and the app's own settings |

The API and the worker never get `POSTGRES_PASSWORD`, `DATABASE_URL_ADMIN`, a
role password or `SUPABASE_AUTH_JWT_SECRET`. A setting the API reads has to be
named in compose's `x-api-env` list; `apps/api/src/compose-env.test.ts` fails
until it is.

## The P35 seam

`getTenantDataSource(tenantId)` returns a handle onto the one shared pool for
every tenant today. When P35 sells a dedicated-instance tier, it returns a data
source backed by that company's own database and nothing above it changes. The
warm LRU that caches these handles is already bounded and already disposes what
it evicts, because the day an entry owns a real connection pool is not the day
to discover it does not.

## Running things

```bash
# Apply migrations, roll back, inspect
pnpm --filter @integr8/db db status
pnpm --filter @integr8/db db up
pnpm --filter @integr8/db db down --steps 1
pnpm --filter @integr8/db db new add_work_orders

# Two demo companies with deliberately confusable data
pnpm --filter @integr8/db db:seed

# The suites
pnpm test                # unit, everywhere, no database
pnpm test:integration    # needs a disposable Postgres
```
