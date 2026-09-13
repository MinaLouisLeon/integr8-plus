# P02 — Database and multi-tenancy

**Version:** v0.1 Foundation
**Status:** `IN PROGRESS`
**Depends on:** P01

## Goal

A Postgres schema where it is structurally difficult to leak one company's data to
another, and a migration process that is safe to run against production.

## Scope

The tenancy model, the migration toolchain, and the isolation test harness. This is the
most consequential phase in the entire plan.

## Tasks

- [ ] Supabase project created; connection through Supavisor in transaction mode
- [x] Migration tooling with ordered files and a version table — never ad-hoc schema pushes
- [x] Core tables: `tenants`, `tenant_users`, `platform_users`, `audit_log`
- [x] Every tenant-scoped table carries a non-null `tenant_id` with a foreign key
- [x] Repository layer that injects `tenant_id` into every query; raw query access is lint-banned outside it
- [x] RLS enabled on every tenant table, policies keyed on a JWT claim, as a backstop behind the repository layer
- [x] `getTenantDataSource(tenantId)` — returns the shared pool today; the seam P35 later changes
- [x] Warm LRU connection pool keyed by tenant, sized and bounded
- [x] Automated tenant-isolation test suite: for every table and endpoint, prove tenant A cannot read or write tenant B
- [x] Seed script producing two demo companies with overlapping-looking data
- [ ] Automated daily backup plus a written, rehearsed restore procedure
- [x] Expand/contract migration convention documented with a worked example

## Exit criteria

- [ ] The isolation suite runs in CI and fails the build if any cross-tenant access succeeds
- [x] Deliberately removing a `tenant_id` filter from one repository method makes the isolation suite fail
- [ ] A migration can be applied and rolled back against a copy of production data
- [ ] A restore from backup has been performed end to end and timed

## Notes

- RLS is the backstop, not the primary control. The repository layer is the primary
  control. Relying on RLS alone makes every future query a security review.
- Run the API on long-lived containers, not serverless functions. Per-tenant connection
  pools and serverless cold starts are incompatible.

---

## What remains, and why

Every unticked box above needs a Supabase project, which is an account-level act rather
than a code change. The code is written, type-checked, linted and — where it can be —
unit-tested. What it has not been is executed against Postgres.

Do these in order; they are the whole of the remaining phase.

1. **Create the project and run the setup runbook.**
   [`docs/database/runbook-supabase-setup.md`](../../docs/database/runbook-supabase-setup.md)
   — about fifteen minutes, steps 1–6. This ticks the first task and, at step 5, proves
   the isolation suite passes against real Postgres.

2. **Enable the CI job.** Step 8 of the same runbook sets `DATABASE_TESTS=enabled` and
   the two test connection secrets. This ticks the first exit criterion.

3. **Break something on purpose.** Delete the `.where('tenant_users.tenant_id', ...)`
   from `TenantUsersRepository`'s `#scoped()` and run `pnpm test:integration`. The
   repository-isolation suite must fail with Southgate's rows in Northwind's results.
   Put it back. This ticks the second exit criterion, and it is worth doing by hand
   once rather than trusting that it would.

4. **Turn on backups and rehearse a restore.**
   [`docs/database/runbook-backup-and-restore.md`](../../docs/database/runbook-backup-and-restore.md)
   — about an hour. Fill in the rehearsal log at the bottom of that file. This ticks the
   last task and the last exit criterion.

5. **Apply and roll back against production-shaped data.** Restore a dump into a scratch
   project, then `db down --steps 1` and `db up`. The third exit criterion needs a copy of
   production data, so it cannot be met before there is production data; until then,
   record the rehearsal against seeded data and revisit at P21.

## Decisions taken during implementation

- **Kysely, with hand-written SQL migrations.** Kysely type-checks queries against the
  schema without owning the schema. Migrations stay as ordered `.sql` pairs so the exact
  text that will run against production is the text in the pull request, and a rollback is
  a file someone wrote rather than an inversion someone hopes is correct. Drizzle's
  generated migrations were rejected on the second point; this phase requires rollbacks
  that work.

- **The JWT claim reaches Postgres as a transaction-local GUC, not as a token.** The task
  list says "policies keyed on a JWT claim". Clients never query Supabase directly (a
  locked decision), so there is no JWT at the database — the API verifies the token and
  copies `tenant_id` into `app.tenant_id` via `set_config(..., true)` as the first
  statement of every tenant transaction. Policies read it through
  `app_current_tenant_id()`. Transaction-local rather than session-local because Supavisor
  runs in transaction mode: a session GUC would be inherited by whichever tenant got the
  connection next. There is a test that forces the pool to one connection and interleaves
  two companies specifically to prove it is not.

- **Three controls, each tested with the others switched off.** The repository layer, a
  query-node guard, and RLS. The repository-isolation suite runs as the schema owner —
  no RLS, no guard — so a missing filter leaks and fails the suite; the RLS suite issues
  raw unfiltered SQL as `integr8_app` with the repository layer bypassed. Testing them
  together would let either quietly cover for the other, and the P02 exit criterion about
  deleting a filter would silently stop meaning anything.

- **`enable row level security`, not `force`.** The owner therefore bypasses policies,
  which is what makes the repository suite meaningful, and what makes connecting as the
  owner catastrophic. `assertRlsEnforced()` runs once per pool and refuses to serve
  traffic if the connection turns out to be a superuser, a `BYPASSRLS` role, or an owner —
  four catalogue checks plus an empirical probe against `platform_users`.

- **`TenantGuardPlugin` — a control the plan did not ask for.** The plan makes the
  repository layer the primary control, which makes the primary control "somebody
  remembered to write a `where` clause". The plugin inspects every compiled statement and
  refuses any that touches a tenant-scoped table without naming `tenant_id`. It is coarse
  — it proves a predicate exists, not that it is correct — but it needs no database, so
  the most important safety net in the package is covered by the suite that runs on every
  commit.

- **No enum types; `text` with check constraints.** Widening a vocabulary is then a
  transactional `drop constraint` / `add constraint` pair that expand/contract can
  express. The schema-invariant suite asserts the role constraint still matches `ROLES`
  in `@integr8/core`, so the two cannot drift.

- **No `citext`, no extensions at all.** Emails and slugs are `text` with a
  `lower()`-equality check constraint, normalised by the repository layer. Supabase
  installs extensions into an `extensions` schema, and a schema that depends on
  `search_path` resolution is a schema that behaves differently under the pooler.

- **`audit_log.tenant_id` is non-null.** Every audited action concerns a company, so the
  table obeys the same rule as every other tenant-scoped table and needs no special case
  in the invariant suite. Platform events touching no tenant get their own table when P03
  needs one.

- **Append-only is enforced by statement-level trigger, not by grants.** A grant merely
  withheld would let the owner delete history. The trigger rejects update, delete and
  truncate for every role. Statement-level matters: a row-level trigger would let
  `delete from audit_log where false` succeed silently and a reader would conclude
  deletion works.

- **A platform user cannot hold a tenant membership — by trigger.** P03's exit criterion
  asks for a test proving super admins have no membership row. It is a tenancy invariant,
  so it is a constraint here instead, and P03's test will confirm an invariant rather than
  a habit.

- **`getPlatformDataSource()`, added alongside the seam the plan named.** Creating a
  company is by definition an act outside every company, and the runtime role holds no
  write grant on `tenants`. It connects as the owner, is deliberately capped at two
  connections, and P03 puts platform authentication and a mandatory audit entry in front
  of every caller.

- **Roles are created by `db bootstrap`, not by a migration.** Roles are cluster-level
  and migrations are per-database, and a password has no business in git. The password
  reaches Postgres through a GUC rather than string interpolation.

- **The integration suite refuses to run without two independent acknowledgements.** It
  truncates tables. `APP_ENV=test` alone is the kind of variable left set in a shell that
  later runs something else, so `INTEGR8_TEST_DATABASE` must also equal one exact string
  with no other purpose.

- **Tests live under `src/`, not `test/`.** They are then type-checked by `pnpm typecheck`
  and linted by `pnpm lint` like everything else. The isolation suite is the most
  consequential code in the repository; it does not get to sit outside the checks.

## Verified so far

| Claim                                      | How it was proven                                                                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace still builds and passes          | `pnpm build`, `lint`, `typecheck`, `test`, `format:check` — all green; 8 packages, 64 unit tests                                               |
| Raw database access is banned outside `db` | A probe file in `apps/api` importing `kysely` and `pg` produced two `no-restricted-imports` errors naming the replacement                      |
| The tenant guard is not decorative         | 13 unit tests: unfiltered select, update, delete and insert on both tenant-scoped tables are rejected; platform tables and scoped queries pass |
| The warm LRU is bounded and disposes       | 11 unit tests covering capacity eviction, idle eviction, single-flight construction, failed-factory recovery, and drain                        |
| Migration files are well-formed            | An `up` with no `down`, a duplicated version, and a mismatched name each fail to load; checksums ignore CRLF so Windows and CI agree           |
| Configuration fails loudly                 | Missing and malformed variables are reported together, each named                                                                              |
| Against a live database                    | **Run on 2026-09-13** against PostgreSQL 17.10, not yet in CI: 111 of 111 after two fixes. See "First run against a real database" below       |

## First run against a real database — 2026-09-13

Until this date the integration suites had been written and type-checked but never run:
there was no Supabase project. They were run against **PostgreSQL 17.10** on a developer
machine (a disposable embedded server, bootstrapped with `db bootstrap` and migrated from
zero exactly as `global-setup.ts` does). That is a real Postgres with the real roles, grants
and policies — not CI, and not Supabase — and the criteria ticked above were ticked on that
evidence and no other.

The first run found two defects in this phase's code, both fixed in `fix/database-suite-first-run`:

- **No member could be added through the runtime role.** `reject_platform_user_membership()`
  reads `platform_users`, ran as the caller, and `integr8_app` deliberately cannot read that
  table. Every `tenant_users` insert on the tenant path failed with "permission denied".
  Migration `0005` makes the function `security definer` with a pinned `search_path`, rather
  than granting the runtime role a read on super-admin identity. Security-definer functions are
  now allow-listed and checked by the invariant suite, as views already were.
- **The query guard covered two of nine tenant tables.** `TENANT_SCOPED_TABLES` was never
  updated when P03 and P04 added seven tables, and `satisfies` could not notice: it proves every
  entry is a tenant table, not that every tenant table is an entry. It is now a record, so a
  missing table is a compile error that names it. The invariant checks that iterate that list —
  non-null `tenant_id`, the foreign key, the policy — had likewise been checking two tables.

It also found three tests that were wrong rather than the code: a truncate test masked by a
foreign key added in P03, a role-vocabulary test that inserted zero rows when no company existed,
and an RLS test that committed a delete the next test depended on.

| Suite                                                                                 | Result                                                 |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `@integr8/db` integration, including a full roll-down and re-apply of every migration | 111 of 111                                             |
| Removing the `tenant_id` predicate from `TenantUsersRepository#scoped()` by hand      | 13 of 21 isolation tests fail; restored, 21 of 21 pass |

Still open: running the suite **in CI** (needs `DATABASE_TESTS` and the test connection strings),
rehearsing a migration against a copy of production data, and a timed restore.
