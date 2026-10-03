# Migrations, and the expand/contract convention

Read this before changing an existing column or table. Adding a new one is
usually just a migration; changing one that shipped is a sequence of them.

---

## The mechanics

Migrations are ordered pairs of SQL files in `packages/db/migrations/`:

```
0003_add_work_orders.up.sql
0003_add_work_orders.down.sql
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
pnpm --filter @integr8/db db up --to 0004    # apply up to and including 0004
pnpm --filter @integr8/db db down            # roll back exactly one
pnpm --filter @integr8/db db down --steps 3
pnpm --filter @integr8/db db down --to 0002  # roll back everything above 0002
pnpm --filter @integr8/db db verify          # checksums still match
pnpm --filter @integr8/db db new add_sites
```

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
back, new schema meets old code for longer. Any migration that removes or
renames something breaks during that window.

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

#### Migration 0007 — expand

```sql
-- 0007 — expand: add first_name and last_name alongside display_name.
--
-- Both nullable, and display_name untouched. Code deployed before this
-- migration keeps working; code deployed after it writes all three.

alter table tenant_users add column first_name text;
alter table tenant_users add column last_name  text;
```

```sql
-- 0007 — down.
alter table tenant_users drop column if exists last_name;
alter table tenant_users drop column if exists first_name;
```

Note what is _not_ here: no `not null`, no default, no backfill. Adding a
`not null` column to a populated table rewrites it under an ACCESS EXCLUSIVE
lock, and the deploy that fills it has not happened yet.

Deploy the code that writes `first_name`, `last_name` **and** `display_name`,
and reads the new columns falling back to the old.

#### Migration 0008 — backfill

```sql
-- 0008 — backfill first_name and last_name from display_name.
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
-- 0008 — down.
update tenant_users set first_name = null, last_name = null;
```

For a large table, do this in batches from a background job rather than in one
statement — a single `update` holds row locks over the whole table for its
duration. `tenant_users` is small enough not to care.

#### Migration 0009 — tighten, next release

```sql
-- 0009 — first_name is now always written by the application.
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
-- 0009 — down.
alter table tenant_users drop constraint if exists tenant_users_first_name_present;
```

#### Migration 0012 — contract, a release later still

```sql
-- 0012 — contract: display_name goes.
--
-- Safe only because no deployed version still reads it. Check before merging:
--   git grep display_name
-- and confirm the oldest client version the API still supports (the
-- min_supported_client header from P04) does not send it.

alter table tenant_users drop column display_name;
```

```sql
-- 0012 — down.
--
-- Restores the column and reconstructs its values. Not byte-identical for names
-- the 0008 split got wrong, which is the honest cost of the contract step and
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
- [ ] `pnpm test:integration` passes against a scratch database.
- [ ] A long-running statement on a large table is batched, or is
      `concurrently`, or the table is small and you have said so in the file.
