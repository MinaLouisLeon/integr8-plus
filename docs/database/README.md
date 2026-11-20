# The database

One Postgres, one schema, every company separated by `tenant_id`. This folder
explains how that separation is enforced, how to change the schema safely, and
what to do when the database needs restoring.

| Document                                                         | When you need it                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| [migrations.md](./migrations.md)                                 | Read before every migration, and to roll back; where the 1.x numbers went |
| [runbook-backup-and-restore.md](./runbook-backup-and-restore.md) | Nightly dumps, copies off the machine, restores                           |

The database is a plain Postgres 16: the `postgres` container in
`deploy/compose.yml` on a server, or one on your machine for development.
Creating an environment from nothing is the
[setup checklist](../deployment/setup-checklist.md). The self-hosted Supabase
Auth keeps its sign-in accounts in the same database, in its own `auth` schema
([`docs/auth/`](../auth/README.md#the-auth-container)); everything
below is about `public`.

---

## The tenancy model in one page

Every table is one of three things.

**The tenant.** `tenants` — one row per customer company. Its `id` is the
`tenant_id` every other table carries.

**Outside all tenants.** `platform_users` (super admins), `schema_migrations`,
sign-in's `login_attempts`, `account_locks` and `rate_limit_buckets`, the form
template library, staff sessions and audit, announcements, exports and
deletions, feature flags, plan allowances, scheduled task runs, billing and
sign-up records, the assistant's plan policies and help articles, and website
keys: 26 tables in all. They are listed in `PLATFORM_TABLES` in
`packages/db/src/schema.ts`, and that list is the only way to opt a table out of
tenant scoping.

**Tenant-scoped.** Everything else. A non-null `tenant_id` with a foreign key to
`tenants(id)`, row-level security enabled, and a policy keyed on the current
tenant context. The schema-invariant suite checks all four of those against the
live catalogue, for every table, on every CI run, so a new table that forgets
one of them fails the build rather than shipping.

## The migrations

2.0.0 started the schema again from one migration per module, in
`packages/db/migrations/`. Each creates its module's tables, functions,
triggers, row-level security policies and grants; comments on tables and
columns carry the why into the database.

| Migration            | Holds                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `0001_foundation`    | Tenants, staff, settings, feature flags, plans and allowances, the job queue, rate limits, idempotency, `ensure_year_partitions()`         |
| `0002_identity`      | Members, company roles, sessions, refresh tokens, invitations, grants, devices, lockout, the audit log                                     |
| `0003_platform`      | Staff sessions and audit, subscriptions and billing events, sign-up, exports, deletions and `purge_tenant()`, announcements, `test_outbox` |
| `0004_files`         | Files, upload intents, storage usage and samples                                                                                           |
| `0005_field_work`    | Customers, sites, job types, work orders and their events, visits, shifts, qualifications, imports, saved views                            |
| `0006_forms`         | Forms, versions, submissions, values and events, form actions and links, the template library, document templates, documents, website keys |
| `0007_sync`          | The phone change log (`sync_touches`), sync reports                                                                                        |
| `0008_crm`           | Leads, pipelines and stages, opportunities and amounts, activities                                                                         |
| `0009_ledger`        | Accounts, journals and lines, periods, year-end closes, postings                                                                           |
| `0010_inventory`     | Items, locations, stock movements and balances, counts, lots, materials used on jobs                                                       |
| `0011_purchasing`    | Suppliers, purchase orders, goods receipts, supplier prices, van requests                                                                  |
| `0012_sales`         | Quotes, sales orders, deliveries                                                                                                           |
| `0013_finance`       | Invoices, credit notes, payments, allocations, reversals                                                                                   |
| `0014_assets`        | Customer assets and their history                                                                                                          |
| `0015_hr`            | Employees, expense categories and claims, pay terms, payroll rule sets, runs and lines                                                     |
| `0016_manufacturing` | Bills of materials, assembly orders, material planning                                                                                     |
| `0017_contracts`     | Service contracts, maintenance plans and occurrences, deadline rules and deadlines                                                         |
| `0018_e_invoicing`   | ETA settings, documents, attempts, signing requests, codes and mappings                                                                    |
| `0019_assistant`     | Conversations, messages, actions, usage, limits and cost                                                                                   |

The next migration is `0020`. A database built by a 1.x release is refused
(`before-baseline`) and has to be created again; a previous release may start on
a newer schema (`ahead-of-build`).

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

**Functions that run as their owner** (`SECURITY DEFINER`, listed in
`SECURITY_DEFINER_FUNCTIONS` in `schema.ts`) skip row-level security, so since
0022 (SEC-002) each is closed to PUBLIC and opened only to the role that calls it
(the schema-invariant suite pins who); trigger functions need no grant, as
Postgres does not check EXECUTE when a trigger fires. One that takes a company id
refuses another company's on the runtime role's connection: the ledger's
`erp_ledger_capture`, `erp_ledger_try_post`, `erp_ledger_backfill` and
`erp_ledger_backfill_more` are wrappers that check, then call the body kept under
an `_unchecked` name nobody may call. **Every new function starts closed to
PUBLIC** (the owner's default privileges): a migration that adds one the
runtime role calls grants `EXECUTE ... TO integr8_app` itself.

### The platform role

Staff screens, creating a company, the job queue, metering, dunning, the
scheduled purge and the first step of sign-in work across companies, through
`getPlatformDataSource()`. They used to connect as the owner, a superuser, so a
compromised API or worker process could have dropped the schema, lifted the
append-only triggers, read files on the database server or reached any other
database in the cluster.

`integr8_platform` does that work instead. Bootstrap gives it
`BYPASSRLS` (only a superuser can) and makes sure it is not a superuser and
cannot create roles or databases. The migrations grant it `select, insert, update,
delete` on every table in `public`, `select` only on `schema_migrations` (the
readiness check reads it), the sequences, and `execute` on `purge_tenant()`.
It owns nothing, so it cannot alter, drop or truncate a table, disable a
trigger or grant anything; the append-only triggers bind it as they bind every
role. The purge still works when it calls it: `purge_tenant()` is security
definer, owned by the superuser that runs migrations, and that is what lets it
set `session_replication_role`.

Unlike the two narrow roles, it reaches tables made by later migrations
through default privileges set in `0001_foundation`: it stands where the owner stood, and a
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

## Tables split by year

The tables that grow forever and that no other table points at are
partitioned by range on their date, one partition per UTC year
(`audit_log_y2026`), plus `<table>_default` for anything outside the years
made: `audit_log`, `platform_audit_log`, `work_order_events`,
`submission_values`, `erp_journal_lines` (by `entry_date`, which a foreign key
with `on update cascade` keeps equal to its journal's), `ai_messages`,
`ai_action_events`, `ai_provider_calls`, `login_attempts`, `signup_events`,
`eta_attempts` and `sync_touches`. A query with a date range reads only the
years in it, and an old year can one day be detached and archived as a whole.

To the code a partitioned table is one table. What differs:

- **Keys include the date.** A primary or unique key must name the partition
  column, so these tables' keys are `(tenant_id, id, <date>)`, and a foreign key
  into one carries the date too (`impersonation_grants.audit_log_occurred_at`).
  A table whose key must be unique across all time (`erp_stock_movements`'
  `source_key`, `submission_events`' sequence) is **not** partitioned for that
  reason.
- **Nobody names a partition.** Partitions carry no grants, so every role
  reaches the rows through the parent and its policy, and cannot write past
  the parent's append-only trigger by naming a year. The schema-invariant suite
  checks it.
- **Years are made ahead.** `ensure_year_partitions()` (security definer,
  callable by the platform role) makes this year's and next year's partitions
  of every partitioned table, and gives its own year to any row already in a
  default partition. Migrations call it, the worker runs it daily
  (`partitions.ensure`), and an import calls it.
- **Delete by key, never by `ctid`**: a `ctid` is only unique within one
  partition.

A new partitioned table: `partition by range (<date column>)` on the parent,
keys that include the column, then `select ensure_year_partitions();` at the end
of the migration. Nothing else is needed.

## Seeing query plans at real sizes

A development database is empty, so a slow query hides until production.

```bash
pnpm --filter @integr8/db db:volume --companies 20 --years 5 --scale 1   # ~10 million made-up rows
pnpm --filter @integr8/db db:plans --source '*'                          # plan every statement recorded
```

`db:volume` writes test companies (`is_test`, slugs `volume-…`) straight from
SQL with triggers off, in minutes. `db:plans` reads the statements
`pg_stat_statements` recorded (run the suites or use the app first), plans each
with `EXPLAIN (GENERIC_PLAN)` as the runtime role acting for the largest
company, and lists every plan that reads a large table whole. Postgres must be
started with `shared_preload_libraries=pg_stat_statements`; the compose
`postgres` service is, and also logs the plan of any statement slower than
500 ms (`auto_explain`). On a deployed stack (the Proxmox test machine) the
same two tools run from the `transfer` service: setup guide Stage 12.

The rules the plans hold the code to: indexes on tenant tables lead with
`tenant_id`; lists page by cursor and always have a limit; history tables are
read with a date range on their partition column; optional filters are added
only when given, never written as `($1 is null or col >= $1)`.

## Moving a company between servers

`apps/api/src/transfer/` (staff only, the `transfer` service in compose; [deployment/](../deployment/README.md#moving-a-company-to-another-server)
has the commands) writes one company to a
`.tar.gz` and reads it into another server. The rows come from
`@integr8/db`'s `transfer/`: every table whose `tenant_id` points at `tenants`,
worked out from the catalogue, minus `NOT_TRANSFERRED` (sessions, queues and
other things bound to the old server), paged by primary key and carried as JSON
text that Postgres writes and reads, so nothing is rounded on the way. The
import writes everything in one transaction with triggers off, checks every
foreign key itself, then calls `ensure_year_partitions()`. Files and the
people's sign-in accounts (with their password hashes) follow. Every company
table therefore needs a primary key.

An archive records its format and schema. A newer server reads an older
archive: columns are matched by name, so a column added since takes its
default and one dropped is reported. That holds only while migrations follow
the expand/contract rule in [migrations.md](./migrations.md).

## One pool today, a database per company later

`getTenantDataSource(tenantId)` returns a handle onto the one shared pool for
every company. A dedicated-database tier would return a data source backed by
that company's own database and nothing above it would change; the cache of
handles is already bounded and disposes what it evicts.

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
