# P41 — Database restructure: a clean baseline, yearly partitions, export and import

**Version:** v2.0 (released as 2.0.0)
**Status:** `IN PROGRESS` — started 2026-11-14 on branch `ccr-c6dc87d8-3hlhaw` (from `dev`)
**Depends on:** everything up to migration 0079; replaces migrations 0001–0079

## Goal

The database stays fast as many companies add years of data. A company's data can be taken out
of one server and put into another (a newer release included) without losing anything, and a
feature added later never collides with data from before it. The schema, the migrations and the
queries are as clean as the owner can review.

## Decisions (owner, 2026-11-14)

| Question                             | Decision                                                                                                                                                                   |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One set of tables or one per company | **Shared tables**, every row keyed by `tenant_id`, RLS as the backstop (unchanged). A company that needs its own database later is P35.                                    |
| Organised in years                   | **Yearly range partitions** on the tables that grow forever and that no other table points at ("leaf" tables). Headers (jobs, submissions, invoices, journals) stay whole. |
| Migrations                           | **A clean restart.** 0001–0079 are replaced by a baseline split by module. Every database is created again; all data so far is test data, no backup is needed.             |
| Who imports                          | **Staff only**, from the platform dashboard and the admin CLI.                                                                                                             |
| Files in an export                   | **Records and the files** themselves (photos, signatures, PDFs), so a company moves to a new server or bucket complete.                                                    |
| Sign-in on the new server            | **People keep their passwords**: the export carries the Auth container's password hashes for the company's people. The archive is a credential.                            |
| Version                              | **2.0.0**. `/v1` does not change; shipped phone and desktop apps keep working once people sign in again.                                                                   |

Claude's choices, open to change: years follow the UTC calendar (the split is for speed, not
accounting); an import keeps every id and refuses when the company id or its slug already exists
on the target.

## Design

### Baseline by module

`packages/db/migrations` starts again at `0001`, one up/down pair per module, in dependency order:
foundation (extensions, helper functions, tenants and the platform's own tables), identity and
audit, platform operations (billing, metering, jobs), field work, forms and documents, CRM,
sales, inventory and purchasing, finance and ledger, assets, HR and payroll, manufacturing,
contracts and maintenance, e-invoicing, the assistant, phone sync, partition maintenance. A
foreign key pointing at a later module is added by that later module. The baseline is generated
from a database migrated to 0079, so it is the shipped schema exactly, then tidied by hand.

A database that still carries the old history (version names that do not match) is refused by
the migrator with a message saying it predates 2.0.0 and must be created again.

### Yearly partitions

Partitioned by range on their date, one partition per UTC year (`<table>_y2026`) and a
`<table>_default` that catches anything outside the years made:

| Table                                                             | Key                         | Why it grows                             |
| ----------------------------------------------------------------- | --------------------------- | ---------------------------------------- |
| `audit_log`                                                       | `occurred_at`               | every write in every company             |
| `platform_audit_log`                                              | `occurred_at`               | every staff action                       |
| `work_order_events`                                               | `occurred_at`               | every state change on every job          |
| `submission_values`                                               | `submitted_at`              | one row per answer, for reporting        |
| `erp_journal_lines`                                               | `entry_date`                | every invoice, payment and stock posting |
| `ai_messages`, `ai_action_events`, `ai_provider_calls`            | `created_at` / `started_at` | every assistant turn                     |
| `login_attempts`, `signup_events`, `eta_attempts`, `sync_touches` | their time                  | high volume, pruned by age               |

`erp_journal_lines` gains `entry_date`, kept equal to its journal's by a composite foreign key
`(tenant_id, journal_id, entry_date) → erp_journals (tenant_id, id, entry_date) on update
cascade`: re-dating a draft moves its lines. `impersonation_grants` points at its audit line
with `(tenant_id, audit_log_id, audit_log_occurred_at)`.

Not partitioned on purpose: `erp_stock_movements` (its `source_key` must be unique across all
time, and a partitioned table can only enforce uniqueness within a year), `submission_events`
(unique sequence per submission), `erp_asset_events` and `sync_reports` (idempotency keys).
They keep `tenant_id`-first indexes on their dates instead.

Every partitioned table keeps one RLS policy and one grant on the parent; partitions get no
grant to `integr8_app`, so they are reachable only through the parent and its policy. A
function `ensure_year_partitions(years_ahead)` creates missing years (moving any rows the default
partition already holds), run by the baseline for the current and next year, and by the worker's
scheduler every day.

### Query rules (checked by a test and by review)

- Indexes on tenant tables lead with `tenant_id`.
- Lists page by cursor (`(sort key, id) > (…)`), never by offset, and always have a limit.
- History tables are read with a date range.
- Text search that matches inside a word uses a trigram index (`pg_trgm`).
- Optional filters are added to the query only when given, not written as `(x is null or …)`.
- `statement_timeout` stays at 15 s.
- `pg_stat_statements` and `auto_explain` (slow queries over 500 ms) are on in the compose
  Postgres, so slow queries on real data show up on their own.

A synthetic volume script (`packages/db/src/volume/`) fills a disposable database with tens of
companies and years of rows straight from SQL; a suite runs `EXPLAIN` on the main list and
report queries against it and fails on a sequential scan of a large table.

### Export and import

An export is one `.integr8data` archive (tar + gzip, streamed, never held in memory):

```
manifest.json            format version, schema version (last migration), release, company, modules on, counts, checksums
tables/<table>.ndjson     one row per line, in dependency order, read in batches by keyset
files/<file id>           each file's bytes from storage
auth/users.ndjson         the company's people: email, password hash, confirmed at (credential!)
```

The table list stays explicit (`EXPORTED_TABLES` / `NOT_EXPORTED_TABLES`, a test fails on a table
in neither). Import (staff only, `admin-cli import-company <file>` and a dashboard page) checks the
manifest, refuses a newer format or schema than the server, applies upgrade steps registered per
format version for older archives, then writes everything in one transaction in dependency order
with the same ids, uploads the files and creates the Auth accounts with their hashes. Because every
id is a UUID and new features only add tables or columns with defaults, an older archive always
fits a newer schema.

## Exit criteria

- [x] Baseline 0001–0019 created from the 0079 schema and compared with it object by object (only
      grant order differs); the database (499), auth (97) and API (732) integration suites pass on it.
- [x] The listed tables are partitioned; `ensure_year_partitions` runs daily from the worker
      (`partitions.ensure`); `year-partitions.integration.test.ts` proves rows land in their year,
      a late year empties the default partition (identity columns kept), the audit log stays
      append-only, and no role can name a partition.
- [x] The migrator refuses a pre-2.0.0 database in one line (`before-baseline`).
- [x] `db:volume` and `db:plans`; every statement the suites issue planned on ~3.6 million rows as
      the largest company. Findings fixed: ledger reports read the lines' own dates (partition
      pruning) and add a bound only when given; journal lines indexed by account and date; the
      login-attempt clean-up deletes by key, not `ctid`; a delete of reportable values names its
      company. Every company table has a primary key (`erp_stock_count_lines` gained one).
- [x] Versioned streamed export with files and Auth hashes; staff import with format upgrades and
      every reference checked; round trips proven byte-identical (`transfer.integration.test.ts`,
      `company-transfer.integration.test.ts`; 1.44 million rows by hand: read 14 s, written 36 s).
- [x] `pg_stat_statements` and `auto_explain` in `deploy/compose.yml`.
- [x] Version 2.0.0 everywhere; setup guide parts AJ (reset) and AK (moving a company); docs and
      MEMORY updated.
- [ ] Owner's run on the Proxmox test machine with the synthetic volume.

## Implementation notes

- Text search inside words (`ilike '%…%'` on assets, employees, contracts, receipts, journal memos)
  stayed as it was: it runs after the `tenant_id` index narrows to one company, and no plan on the
  volume data read a large table for it. Trigram indexes are the answer if one company's table
  grows past about a hundred thousand rows; `db:plans` will show it.
- The customer's own export (P15, `tenant.export`) still writes its one gzipped JSON; the
  transfer is a separate, staff-only archive.
- The transfer runs where the owner's connection and the API's storage and Auth settings meet:
  the `transfer` compose service (profile `tools`), never the API or worker.
- Comments in code that cite a 1.x migration number ("see 0043") are history; the baseline file
  of that module holds the object now.
