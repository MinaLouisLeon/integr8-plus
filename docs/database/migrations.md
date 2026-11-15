# Migrations, and the expand/contract convention

Read this before changing an existing column or table. Adding a new one is
usually just a migration; changing one that shipped is a sequence of them.

---

## The mechanics

Migrations are ordered pairs of SQL files in `packages/db/migrations/`:

```
0020_add_route_plans.up.sql
0020_add_route_plans.down.sql
```

- The four-digit prefix orders them. `db new <slug>` allocates the next one.
- Every `up` needs a `down`. The loader refuses to start without one, so a
  rollback that nobody wrote is found in CI rather than during the incident that
  needs it.
- Each pair runs in a transaction. A migration that cannot (`create index
concurrently`) opts out with `-- integr8:no-transaction` on its own line, and
  accepts that failing halfway leaves the schema halfway.
- `schema_migrations` records version, name, SHA-256 of the `up` text, who
  applied it and how long it took.
- A session advisory lock serialises concurrent runners, so two deploys queue
  instead of interleaving.

```bash
pnpm --filter @integr8/db db status          # what has run
pnpm --filter @integr8/db db up              # apply everything pending
pnpm --filter @integr8/db db up --to 0020    # apply up to and including 0020
pnpm --filter @integr8/db db down            # roll back exactly one
pnpm --filter @integr8/db db down --steps 3
pnpm --filter @integr8/db db down --to 0019  # roll back everything above 0019
pnpm --filter @integr8/db db verify          # checksums still match
pnpm --filter @integr8/db db new add_sites
```

## The 2.0.0 baseline

2.0.0 started the numbering again. `0001_foundation` to `0019_assistant`
are one migration per module, generated from the schema release 1.4.0's
migrations 0001–0079 built and checked object by object against it; the old
files and their reasoning are in git before 2.0.0, and comments on tables and
columns carry the why into the database. A database built by 1.x is refused
with a message saying to create it afresh (state `before-baseline`). New work
takes the next number after the highest file, and is immutable once applied
like any other.

### Where the old numbers went

Code comments, commit messages and the documents removed at 2.0.0 (in git
history) name the 1.x migrations ("added in 0061", "see 0003"). Those numbers are history: they say when something was
built, not a file you can open. This table says which baseline migration now
holds what each old one made. Several old ones touched more than one area (a
column added to `tenants` sits in `0001_foundation` whatever module wanted it),
so the list names the main home first. Every baseline migration grants its own
tables to the roles, so 0058's grants are spread across all nineteen.

| 1.x migrations                                                                                                                                                                              | Now in                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| 0001 core tenancy, 0002 row-level security, 0004 API infrastructure (idempotency, jobs), 0022 branding, 0057 Egyptian working week, 0075 tab switches, 0077 `is_test`                       | `0001_foundation`                          |
| 0003 authentication, 0005 membership check, 0041 company roles, 0054 self-hosted sign-in, 0066 push device language, 0078 accountant role                                                   | `0002_identity`                            |
| 0015 platform admin, 0017–0021 subscriptions, billing, sign-up, 0023 staff management, 0055 purge, 0056 no default retention, 0077 staff session scope and `test_outbox`                    | `0003_platform`                            |
| 0009 media ledger, 0016 storage metering                                                                                                                                                    | `0004_files`                               |
| 0010 customers, sites, work orders, 0013 job execution, 0051 visits, 0052 qualifications                                                                                                    | `0005_field_work`                          |
| 0006–0008 forms, builder, submissions, 0012 submit location, 0014 repeating groups, 0048 documents, 0050 website keys, 0060, 0061, 0067, 0068, 0069, 0074, 0075 document fields, 0076, 0079 | `0006_forms`                               |
| 0011 offline sync                                                                                                                                                                           | `0007_sync`                                |
| 0024 CRM foundation, 0025 pipelines and activities, 0043 opportunity amounts                                                                                                                | `0008_crm`                                 |
| 0033 ledger, 0034 postings, 0035 year close                                                                                                                                                 | `0009_ledger`                              |
| 0026 inventory, 0028 work-order materials, 0040 stock follow-ups, 0042 serial and batch, 0062 parts after close                                                                             | `0010_inventory`                           |
| 0027 purchasing                                                                                                                                                                             | `0011_purchasing`                          |
| 0029 sales                                                                                                                                                                                  | `0012_sales`                               |
| 0030 finance, 0064 rounding and reversals                                                                                                                                                   | `0013_finance`                             |
| 0031 assets, 0032 asset carry-over and import                                                                                                                                               | `0014_assets`                              |
| 0036 HR roles and profiles, 0037 expenses, 0038 payroll, 0079 approved claim amounts                                                                                                        | `0015_hr`                                  |
| 0039 manufacturing                                                                                                                                                                          | `0016_manufacturing`                       |
| 0053 contracts, maintenance plans and deadlines, 0063 maintenance plan failures                                                                                                             | `0017_contracts`                           |
| 0049 e-invoicing                                                                                                                                                                            | `0018_e_invoicing`                         |
| 0044 AI assistant, 0045 retention grants, 0046 token quotas, 0047 answer source                                                                                                             | `0019_assistant`                           |
| 0058 platform role, 0065 table housekeeping                                                                                                                                                 | every baseline migration (grants, indexes) |

Notes that said "rows written before 00NN keep the old behaviour" no longer
apply: a 2.0.0 database starts empty, so every row follows the current rules.

## An applied migration is immutable

The checksum exists to enforce one rule: once a migration has run anywhere, its
file never changes again. Editing it makes `db up` refuse to run, with the
version named.

The temptation is real — a typo in a column name, a missing index, a constraint
you meant to add. Fix it in a **new** migration. An edited migration produces two
databases with the same version number and different schemas, and the difference
surfaces as an inexplicable production-only bug weeks later.

If you hit a checksum mismatch on a migration that has only ever run on your own
machine, roll it back (`db down`), edit, and reapply.

## Every tenant-scoped table, every time

A new tenant-scoped table needs all four of these. The schema-invariant suite
fails the build if any is missing, so this is a checklist rather than a
convention:

```sql
create table work_orders (
  id         uuid        primary key default gen_random_uuid(),
  tenant_id  uuid        not null references tenants (id) on delete cascade,
  -- ...
);

create index work_orders_tenant_idx on work_orders (tenant_id);

grant select, insert, update, delete on work_orders to integr8_app;

alter table work_orders enable row level security;

create policy work_orders_isolation on work_orders
  for all
  to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
```

Then add `'work_orders'` to `TENANT_SCOPED_TABLES` and the `Database` interface
in `packages/db/src/schema.ts`, and give it a repository extending
`TenantScopedRepository`.

There is no `alter default privileges` anywhere in this schema, deliberately. A
table with no grant is invisible to the runtime until somebody writes one, which
is the right default and a line a reviewer will see.

Do **not** enable `force row level security`. The repository-isolation suite
depends on the owner bypassing policies; see
[README.md](./README.md#three-controls-each-sufficient-alone).

---

## Expand and contract

A migration and a deploy are not simultaneous. For a window measured in minutes,
old application code is talking to the new schema — and if you roll the deploy
back, new schema meets old code for as long as the rollback lasts: the
previous release runs on the new schema, with the new migrations left applied
(see [Rolling back a release](#rolling-back-a-release)). Any migration that
removes or renames something breaks during that window.

So every destructive change is split in two, with a deploy between them:

| Phase        | Migration does                           | Safe because                     |
| ------------ | ---------------------------------------- | -------------------------------- |
| **Expand**   | Adds the new shape, keeps the old        | Old code still works             |
| _(deploy)_   | Ships code writing both, reading the new |                                  |
| _(backfill)_ | Copies existing rows into the new shape  | Nothing reads it exclusively yet |
| **Contract** | Removes the old shape                    | Nothing references it any more   |

Contract goes out in a **later release**, not later the same afternoon. If you
might still want to roll back to the previous version, the old column must still
be there.

### Worked example: splitting `display_name` into first and last

`tenant_users.display_name` is one column. Reports need to sort by surname.

#### Migration 0020 — expand

```sql
-- 0020 — expand: add first_name and last_name alongside display_name.
--
-- Both nullable, and display_name untouched. Code deployed before this
-- migration keeps working; code deployed after it writes all three.

alter table tenant_users add column first_name text;
alter table tenant_users add column last_name  text;
```

```sql
-- 0020 — down.
alter table tenant_users drop column if exists last_name;
alter table tenant_users drop column if exists first_name;
```

Note what is _not_ here: no `not null`, no default, no backfill. Adding a
`not null` column to a populated table rewrites it under an ACCESS EXCLUSIVE
lock, and the deploy that fills it has not happened yet.

Deploy the code that writes `first_name`, `last_name` **and** `display_name`,
and reads the new columns falling back to the old.

#### Migration 0021 — backfill

```sql
-- 0021 — backfill first_name and last_name from display_name.
--
-- Naive split on the first space: wrong for some names, and deliberately not
-- the source of truth. New rows are written correctly by the application; this
-- only makes existing rows usable. Anything it gets wrong is fixable by a human
-- editing their own profile.

update tenant_users
   set first_name = split_part(display_name, ' ', 1),
       last_name  = nullif(substr(display_name, strpos(display_name, ' ') + 1), '')
 where first_name is null;
```

```sql
-- 0021 — down.
update tenant_users set first_name = null, last_name = null;
```

For a large table, do this in batches from a background job rather than in one
statement — a single `update` holds row locks over the whole table for its
duration. `tenant_users` is small enough not to care.

#### Migration 0022 — tighten, next release

```sql
-- 0022 — first_name is now always written by the application.
--
-- `not valid` then `validate` takes a SHARE UPDATE EXCLUSIVE lock instead of
-- ACCESS EXCLUSIVE, so reads and writes continue while existing rows are
-- checked.

alter table tenant_users
  add constraint tenant_users_first_name_present
  check (first_name is not null) not valid;

alter table tenant_users validate constraint tenant_users_first_name_present;
```

```sql
-- 0022 — down.
alter table tenant_users drop constraint if exists tenant_users_first_name_present;
```

#### Migration 0025 — contract, a release later still

```sql
-- 0025 — contract: display_name goes.
--
-- Safe only because no deployed version still reads it. Check before merging:
--   git grep display_name
-- and confirm the oldest client version the API still supports (the
-- min-supported-client header) does not send it.

alter table tenant_users drop column display_name;
```

```sql
-- 0025 — down.
--
-- Restores the column and reconstructs its values. Not byte-identical for names
-- the 0021 split got wrong, which is the honest cost of the contract step and
-- the reason it waits for a release where rolling back is unlikely.

alter table tenant_users add column display_name text;

update tenant_users
   set display_name = btrim(concat_ws(' ', first_name, last_name))
 where display_name is null;

alter table tenant_users alter column display_name set not null;
```

### The quick reference

| Change                      | How                                                                     |
| --------------------------- | ----------------------------------------------------------------------- |
| Add a nullable column       | One migration. Safe.                                                    |
| Add a column with a default | One migration. Safe on PG11+ — the default is not written to every row. |
| Add `not null`              | Expand nullable → backfill → `check ... not valid` → `validate`.        |
| Rename a column             | Add new → dual-write → backfill → drop old. Never `alter ... rename`.   |
| Drop a column               | Contract only, a release after nothing reads it.                        |
| Widen a check constraint    | `drop constraint` + `add constraint` in one transaction. Safe.          |
| Narrow a check constraint   | Fix the offending rows first, in an earlier migration.                  |
| Add an index                | `create index concurrently` with `-- integr8:no-transaction`.           |
| Change a column type        | Treat as a rename: new column, dual-write, backfill, drop.              |

### Before you merge a migration

- [ ] There is a `down`, and you have run it and then `up` again locally.
- [ ] A new tenant-scoped table has `tenant_id`, a foreign key, a grant, RLS and
      a policy — and is in `TENANT_SCOPED_TABLES`.
- [ ] Nothing destructive ships in the same release as the code that stopped
      using it.
- [ ] The previous release still works with this migration applied: a
      rollback leaves it in place.
- [ ] `pnpm test:integration` passes against a scratch database.
- [ ] A long-running statement on a large table is batched, or is
      `concurrently`, or the table is small and you have said so in the file.

---

## Rolling back a release

Rolling back a release means starting the previous release's image on a
database the newer release has already migrated. Expand/contract is what makes
that safe; the migrator is what lets it start.

The previous image has no files for the newer release's migrations. The
migrator calls an applied migration with no file **`ahead-of-build`** when it
is newer than every file the build has: a contiguous tail of migrations from a
later release. On such a database:

- `db up` (the `migrate` service) applies nothing, prints a warning naming the
  migrations that are ahead, and exits 0, so the API and worker start;
- `db status` lists them as `ahead-of-build` and exits 0;
- the API's readiness check (`/health/ready`) passes, with a note on the
  `schema` check naming them, so `web` starts and the uptime check stays green.

Some things still fail, exactly as before, because no rollback explains them:

- an applied migration with no file that is **older** than the build's newest
  file: a gap, meaning a file was deleted or renamed;
- an applied migration whose file has changed (a checksum mismatch);
- a migration this build has that is still pending while newer ones are
  applied: the newer release did not contain it, so this build is not its
  predecessor.

**Undoing a migration is a separate, deliberate step, done with the release
that added it.** Only its image has the `.down.sql` file. With the newer
release still running, read the down file, then run
`db down --steps N` from that image, and only then switch to the previous one.
The previous image refuses to roll back a migration it has no file for, and
checks every target before touching any, so a refusal changes nothing. Most
down files delete what their up added; on a production database, leaving the
migration applied is almost always the right choice.

Releases up to v1.2.1 predate this: their `migrate` refuses any database with
an applied migration it has no file for, so their API and worker never start
on a newer schema. The setup guide (Stage 11, part Q) has the way round it for
going back from the self-hosted sign-in release to v1.2.1.
