# The database

One Postgres, one schema, every company separated by `tenant_id`. This folder
explains how that separation is enforced, how to change the schema safely, and
what to do when the database needs restoring.

| Document                                                         | When you need it                                  |
| ---------------------------------------------------------------- | ------------------------------------------------- |
| [runbook-supabase-setup.md](./runbook-supabase-setup.md)         | Creating an environment from nothing              |
| [migrations.md](./migrations.md)                                 | Changing the schema — read before every migration |
| [runbook-backup-and-restore.md](./runbook-backup-and-restore.md) | Rehearsing or performing a restore                |

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

This is not a style preference. The API connects through Supavisor in
transaction mode, which hands the same physical connection to different tenants
between transactions. A session-level setting would survive into the next
tenant's work and leak — intermittently, in proportion to load, and invisibly.
`tenant-data-source.integration.test.ts` forces the pool to a single connection
and interleaves two companies to prove it does not.

Unset context yields NULL, and `tenant_id = NULL` is NULL rather than true. No
context therefore means no rows: the failure mode is a blank screen, not a leak.

## Two roles

| Role                           | Used by                                                        | RLS applies |
| ------------------------------ | -------------------------------------------------------------- | ----------- |
| `integr8_app`                  | Every tenant request (`DATABASE_URL`)                          | Yes         |
| owner — `postgres` on Supabase | Migrations, seeds, company provisioning (`DATABASE_URL_ADMIN`) | No          |

Tables are `enable row level security` but **not** `force`, so the owner
bypasses policies. That is deliberate: it is what makes the repository suite
meaningful. It is also what makes connecting as the owner catastrophic, which is
why `assertRlsEnforced()` checks at startup rather than trusting the connection
string.

An API container should not have `DATABASE_URL_ADMIN` set at all.

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
