# P16 — Storage metering and quotas

**Version:** v1.0 Launch
**Status:** `IN PROGRESS — built and verified; the Cloudflare half awaits a real account run`
**Depends on:** P09, P15

## Goal

You can see exactly how much R2 storage each company uses, trust the number, and act on it.

## Scope

The reporting and enforcement layer over the P09 ledger. This is the feature that
originally justified one bucket per company.

## Tasks

- [x] Usage view per company: total bytes, object count, and a breakdown by images, video, PDFs and other
- [x] Thirty and ninety day growth trend per company, plotted against the plan allowance
- [x] Cloudflare GraphQL Analytics client reading `r2StorageAdaptiveGroups` per bucket
- [x] Nightly reconciliation job comparing the ledger total against Cloudflare's reported bucket size
- [x] Drift alert when the two disagree beyond a threshold, naming the company
- [x] R2 operations and transfer per company (Class A and Class B), so expensive tenants are visible early
- [x] Quota enforcement: warn at eighty percent, block or bill at one hundred, per plan
- [x] In-app warning to the company before they hit their limit, not after
- [x] Company-facing usage view, showing them the same numbers you see
- [x] Platform-wide totals and projected monthly Cloudflare cost
- [x] Retention policy job deleting media past the plan's retention window

## Exit criteria

- [~] For every company, the dashboard figure matches Cloudflare's reported bucket size within one percent
- [x] Uploading past a company's quota is refused with a clear, actionable message
- [x] The reconciliation job runs nightly, and a deliberately introduced drift raises an alert
- [x] A company approaching their limit is warned automatically, without you noticing first

Tested in `apps/api/src/media/metering.integration.test.ts`. The first criterion is the one
that cannot be finished here: the harness stores media on local disk, so there is no Cloudflare
to agree with. What is tested is that a run with nothing to ask records `unavailable` rather
than claiming a match, that the comparison and the threshold work, and that a drift raises the
alert. The agreement itself needs one run against the real account, like the media suite.

## Decisions taken before building

- **Per plan: block the small plans, allow overage on the large ones.** Trial and starter
  refuse new uploads at the line; standard and enterprise keep accepting. The consequence,
  written down because it is a real cost: until P17 exists, overage on the larger plans accrues
  **unbilled**. The daily sample carries the allowance that applied and the overage against it,
  so P17 can bill retrospectively rather than losing the months in between.
- **Allowances live in the database, edited from the dashboard.** A limit that needs a deploy
  to change is a limit somebody works around by not setting one.
- **Retention soft-deletes into the existing thirty-day restore window.** Automatic deletion of
  a customer's data stays reversible for a month, and there is one path that removes bytes
  rather than two.
- **Drift goes to Sentry and the platform audit log.** Sentry is where an engineer already
  looks; the audit log is the permanent record naming the company and both numbers.

## What is deliberately not here

- **Billing.** P17 owns plan definitions in full — seats, forms, submissions, retention,
  modules — and the entitlement service. P16 holds the storage half only, because that is the
  half that costs money the moment it is wrong.
- **Per-company allowance overrides.** Negotiated deals are explicitly a P17 task. The
  allowance is per plan here.
- **Transfer volume per company.** The plan asks for operations _and_ transfer; Cloudflare's
  analytics report operations by class, and R2 charges no egress, so what is metered is what is
  billed. There is no transfer figure to show that would mean anything.
- **A cron.** There is no scheduler in this system. The nightly tasks run from the worker's
  existing housekeeping timer and claim a turn in the database, which is the smallest thing
  that makes a nightly job nightly when several workers are running.
- **Event-driven usage.** R2 event notifications into a queue would update usage within
  seconds instead of nightly. That is a Scale item and the plan already tracks it separately.

## Found while building this

- **`TRUNCATE platform_users CASCADE` in the test harness emptied the plan allowances.** The
  new table referenced `platform_users` for "who changed this last", and a cascade follows
  foreign keys regardless of `on delete set null`. The column now carries no foreign key, for
  the same reason the platform audit log does not: what a plan allows outlives whoever set it.
  Without this the quota silently did not enforce, because a plan with no row reads as
  uncapped.
- **A `date` column comes back as a `Date` at local midnight, not a string.** Formatting it
  with `toISOString` moved every sample back a day for any positive UTC offset — on the row
  P17 bills from. It is formatted from the local parts instead.
- **An optional chain inverted a guard.** `location?.purgedAt != null` skips a _missing_
  bucket's early return, because `undefined != null` is false; `!== null` is the form that
  covers both. Caught by the compiler, not by a test.
- **An allowance is global, and a test that edits one edits it for everybody.** The metering
  suite capped `trial` at a kilobyte and fourteen tests in the media suite started failing,
  because every test company is on `trial` in the same database. The suite puts the allowances
  back now. Worth remembering beyond the tests: changing a plan changes it for every company on
  it, at once.
- **Changing a company's plan did not take effect for up to thirty seconds.** The plan is read
  off the row the suspension door-check caches, and the dashboard's plan route did not clear it
  the way suspend and reactivate do. It does now.
