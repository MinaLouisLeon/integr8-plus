# P15 — Super admin dashboard

**Version:** v1.0 Launch
**Status:** `IN PROGRESS — built and verified; the R2 half of deletion awaits a real Cloudflare run`
**Depends on:** P03, P10

## Goal

You can run the business: see every company, onboard one, support one, and suspend one,
without opening a terminal.

## Scope

Your dashboard, inside the Next.js app on a separately authorised route.

## Tasks

- [x] Company directory: status, plan, seats, storage used, created date, last activity
- [x] Onboard a company in one action — create tenant, seed roles and job types, create the R2 bucket, send the owner invite
- [x] Suspend, reactivate and delete, with deletion forcing an export first
- [x] Impersonation UI: reason prompt, time limit, persistent banner while active, one-click exit
- [x] Platform audit log, searchable, immutable, showing every super admin action
- [x] Per-company activity: active users, jobs per month, submissions, ~~API calls~~ recorded actions
- [x] Feature flags per company
- [x] Global announcement banner pushed to desktop, mobile and web
- [x] Global form template library management
- [x] Support toolkit: recent errors for a company, resend invite, reset MFA, unlock account, clear a stuck sync queue
- [~] Release view: which desktop and mobile versions are live in the field — mobile only; see below
- [x] Company data export and hard delete

## Exit criteria

- [x] A new company is onboarded end to end through the UI, with no manual database or Cloudflare step
- [x] Every impersonation session appears in the audit log with its reason and duration
- [x] Suspending a company puts all three of their apps into read-only within one minute
- [~] Deleting a company removes their database rows and their bucket, verified in Cloudflare

The first three are tested end to end in
`apps/api/src/routes/v1/platform/platform.integration.test.ts`. The fourth is tested against
local-disk storage, which proves the ordering and the ledger; the R2 half needs one run against
the real account, like the media suite.

Suspension is stricter than "read-only": every request is refused, reads included. The decision
and its cost are written up in [docs/platform](../../docs/platform/README.md).

## Notes

- The impersonation banner must be impossible to miss. Support engineers who forget they
  are impersonating cause the worst incidents.
- Onboarding automation is not a convenience. Any manual step becomes the bottleneck the
  moment you have ten customers.

## Decisions taken before building

- **Platform sign-in: password plus TOTP.** A separate path minting a platform-only token with
  no company in it, and short sessions. A third token type rather than a nullable `tid`, so a
  platform token cannot reach a tenant handler however the routing is wired.
- **Impersonation gives full access as that user.** A read-only mode would mean reproducing half
  of every reported problem. What makes it acceptable is that every action is attributed to the
  super admin, in both audit logs, and the grant is re-checked on every request.
- **Suspension blocks at the door.** Every request refused, not read-only: a suspension is a
  commercial event, and half-working software is worse to be on the end of than software that
  says plainly it has stopped.
- **Deletion is export, wait, then purge.** Suspended immediately, purged after a seven-day
  cooling-off, reversible until it runs. The database enforces the order.

## What is deliberately not here

- **Desktop and web in the release view.** `sync_reports.app_version` is the only place a client
  version is recorded, and only the phone writes it. Desktop and web send `x-client-version` on
  every request and nothing stores it. The fix is to record it, not to guess it in the query.
- **"API calls" per company.** There is no request-level counter and no honest way to derive
  one. The activity view counts audited actions instead, which is what people mean when they
  ask how busy a customer is.
- **Clearing one device's sync queue.** The queue lives on the device. What the server can do is
  forget the change log so every device bootstraps again, which fixes the failure people report.
- **Editing a form template's definition in the dashboard.** The form builder is the editor; a
  second, worse one here would be a way to save a template that does not compile. The library
  screen lists and the API replaces.

## Found while building this

- **`purge_tenant()` could not delete a company's history.** It lifted the no-delete guard on
  `audit_log` but not on `submission_events` or `work_order_events`, so a purge failed on the
  first company that had ever filled in a form. It now lifts all three, and puts them back.
- **Rolling 0015 back left companies suspended with no way to say why.** The down migration
  drops `suspended_at` and `suspended_reason` but left `status = 'suspended'`, which then
  violated the check constraint when 0015 was applied again. The rollback now lifts the
  suspensions it can no longer describe.
- **The directory summed a column that does not exist.** `tenant_storage_usage.bytes`, not
  `byte_size` — caught the first time the API ran the query rather than by a type, because it
  was raw SQL for an aggregate Kysely would not express.
- **A `case` expression sent a timestamp to Postgres as text**, so recording a failed sign-in
  failed with a type error instead of locking the account. Both branches are cast now.
- **A flag key with a hyphen in it was a 500.** The table's check constraint allows
  underscores; the route now declares the same shape, so a bad key is a 422 that says what is
  wrong.
- **`/v1/me` gaining `features` and `announcements` broke the offline package's fixture** — the
  one place outside the API that builds that response by hand. Worth knowing the coupling is
  there.

## Found in review, after it was all working

A security review of the auth, suspension and purge paths found six real defects. All are
fixed, and the first two have regression tests.

- **A refresh-token race left two live chains and revoked nothing.** `executeTakeFirstOrThrow`
  on an update with no `returning` resolves to an `UpdateResult` even when it matched no rows,
  so `where used_at is null` — the entire concurrency control — was decorative. Two requests
  presenting the same platform refresh token in the same moment both got a working session and
  no reuse was ever detected. `rotate` now checks `numUpdatedRows`, rolls back the loser, and
  the service treats losing the race exactly as it treats a spent token: the session ends.
- **Platform sign-in told you which of the three it was.** "No platform account with that
  address", "Wrong password or code", "Platform account is not active" — and `AuthError.message`
  reaches the caller through the error model, so the careful equal-work checking above it was
  being undone one line later. All three are now the default message, and a disabled account no
  longer skips scrypt, which had made it measurable even without the wording.
- **The purge destroyed the export that justified it.** Exports were written into the company's
  own bucket, which `purgeTenantStorage` then deletes — while `tenant_exports`, deliberately
  outliving the company, went on reporting the archive as ready. Exports now go to a platform
  bucket, keyed by company.
- **A bad owner email stranded a company for ever.** `ownerEmail` was validated for length
  only; the invitations table checks for an `@`. The company row committed, the transaction
  around everything else rolled back, and nothing could then remove it — deleting a company
  needs a finished export and a week. The address is checked properly now, and a failure after
  the row exists takes it back out.
- **`cookies.delete(name)` does not delete a cookie set at a path.** Next sends `Path=/`, the
  browser matches on path, and the cookie survives. A super admin signing out while the API was
  unreachable kept a live refresh cookie and was silently signed back in on their next visit.
  Both refresh cookies are now cleared by name and path; the customer-side one had the same bug
  and predates this phase.
- **`purge_tenant` found its tables without a schema predicate** and then deleted from
  `public.<name>`, so a same-named table in another schema would either stop every purge for
  ever or point the delete at the wrong table.
- **An announcement could be invisible for the first millisecond of its life.**
  `announcementsFor` filtered `starts_at <= now` with a `Date` from Node, against a column
  Postgres fills with its own `now()`. Measured against the test database, the database clock
  reads up to a millisecond ahead _after_ the round trip — so a banner somebody had just posted
  could be missing from the next `/v1/me`, which is the worst possible moment for the one that
  says the system is going down. It now compares against the database's clock.

## Worth fixing next, found here but not P15's

- **`claimJobs` has the same two-clock bug** (`packages/db/src/repositories/jobs.ts:176`):
  `available_at <= ${now}` compares a Postgres-written timestamp to a `Date` from Node, so a job
  enqueued a moment ago can be unclaimable until the skew is made up. It shows up as an
  intermittent failure in P14's push-notification test. The fix is the same one used for
  announcements — default to the database's `now()` and keep the injectable clock for tests —
  but it is the queue every worker shares, so it deserves its own change rather than being
  smuggled in here.
