# P16 — Storage metering and quotas

**Version:** v1.0 Launch
**Status:** `IN PROGRESS — enforcement and metering are done; three reporting gaps and the Cloudflare run remain`
**Depends on:** P09, P15

## Goal

You can see exactly how much R2 storage each company uses, trust the number, and act on it.

## Scope

The reporting and enforcement layer over the P09 ledger. This is the feature that
originally justified one bucket per company.

## Tasks

- [~] Usage view per company: total bytes, object count, and a breakdown by images, video, PDFs and other
- [~] Thirty and ninety day growth trend per company, plotted against the plan allowance
- [x] Cloudflare GraphQL Analytics client reading `r2StorageAdaptiveGroups` per bucket
- [x] Nightly reconciliation job comparing the ledger total against Cloudflare's reported bucket size
- [x] Drift alert when the two disagree beyond a threshold, naming the company
- [~] R2 operations and transfer per company (Class A and Class B), so expensive tenants are visible early
- [~] Quota enforcement: warn at eighty percent, block or bill at one hundred, per plan
- [~] In-app warning to the company before they hit their limit, not after
- [x] Company-facing usage view, showing them the same numbers you see
- [x] Platform-wide totals and projected monthly Cloudflare cost
- [x] Retention policy job deleting media past the plan's retention window

### What the partial marks mean

Every one of these is **built in the API and tested**; what is missing in each case is the last
hop to a screen, or a half of the task that was never built at all. Marked honestly rather than
closed, because a tick against something nobody can see is how a gap survives to launch.

- **Per-company usage view (1), the trend (2) and per-company operations (6)** all land on
  `GET /v1/platform/companies/:tenantId/storage`, which returns the breakdown, ninety days of
  daily samples with the allowance that applied to each, and the recent reconciliations. It is
  tested and it works — and **no dashboard screen reads it.** The platform side has the
  platform-wide page only, so a super admin who wants one company's figures has to call the API
  by hand. The company's own screen (9) does exist, which is why that one is ticked.
- **"Plotted against the plan allowance" (2)** is not built in either sense: the company's screen
  renders the most recent thirty samples as a table of day and bytes, with no allowance line and
  no chart. The data to draw both is in the response already.
- **Transfer per company (6)** is not built and is not going to be — see _What is deliberately not
  here_. Operations are metered by class, stored on each sample, and priced into the projected
  monthly cost.
- **"Or bill at one hundred" (7)** is not built. A plan set to `allow` records the overage on the
  day's sample and nothing charges for it; P17 shipped seats and submissions and did not pick this
  up. The samples carry the allowance and the overage, so a later release can bill retrospectively
  rather than losing the months in between — but until something does, **overage on the larger
  plans is free.**
- **The eighty-percent warning (8)** is computed correctly and returned by the API, and the
  company's storage screen shows it. Nothing _delivers_ it: there is no banner outside that page,
  the successful-upload response says nothing about approaching the line, and there is no email
  sender anywhere in this system. A company is warned only if somebody chooses to visit the page.

## Exit criteria

- [~] For every company, the dashboard figure matches Cloudflare's reported bucket size within one percent
- [x] Uploading past a company's quota is refused with a clear, actionable message
- [x] The reconciliation job runs nightly, and a deliberately introduced drift raises an alert
- [~] A company approaching their limit is warned automatically, without you noticing first

Tested in `apps/api/src/media/metering.integration.test.ts`.

**The first** cannot be finished here: the harness stores media on local disk, so there is no
Cloudflare to agree with. What is tested is that a run with nothing to ask records `unavailable`
rather than claiming a match, that the comparison and the threshold work, and that a drift raises
the alert. The agreement itself needs one run against the real account, like the media suite.

**The fourth** was previously ticked and should not have been. The test behind it asserts that the
API _reports_ `state: 'warning'` with the numbers — which is the computation, not the delivery.
The word in the criterion is **automatically**, and a warning that waits on a page for somebody to
visit is not automatic. Closing this needs somewhere to push it from: the P15 announcement channel
would do it today, and an email sender would do it properly.

## Decisions taken before building

- **Per plan: block the small plans, allow overage on the large ones.** Trial and starter
  refuse new uploads at the line; standard and enterprise keep accepting. The consequence,
  written down because it is a real cost: until P17 exists, overage on the larger plans accrues
  **unbilled**. The daily sample carries the allowance that applied and the overage against it,
  so P17 can bill retrospectively rather than losing the months in between.
  **Update, after P17 shipped:** it did not. The samples are still being written, so nothing is
  lost and the retrospective bill is still possible — but the assumption in this bullet turned
  out to be wrong, and the overage is still free.
- **Allowances live in the database, edited from the dashboard.** A limit that needs a deploy
  to change is a limit somebody works around by not setting one.
- **Retention soft-deletes into the existing thirty-day restore window.** Automatic deletion of
  a customer's data stays reversible for a month, and there is one path that removes bytes
  rather than two.
- **Drift goes to Sentry and the platform audit log.** Sentry is where an engineer already
  looks; the audit log is the permanent record naming the company and both numbers.

## What is deliberately not here

- **Billing.** P17 owns plan definitions in full — seats, submissions, prices — and the
  entitlement service. P16 holds the storage half only, because that is the half that costs money
  the moment it is wrong. Note that P17 shipped **without** picking up storage overage billing, so
  the gap in task 7 is now nobody's, and belongs to whichever release next touches invoicing.
- **Per-company allowance overrides.** Negotiated deals were a P17 task, and P17 did not build
  them either. The allowance is still per plan.
- **Transfer volume per company.** The plan asks for operations _and_ transfer; Cloudflare's
  analytics report operations by class, and R2 charges no egress, so what is metered is what is
  billed. There is no transfer figure to show that would mean anything.
- **A cron.** There is no scheduler in this system. The nightly tasks run from the worker's
  existing housekeeping timer and claim a turn in the database, which is the smallest thing
  that makes a nightly job nightly when several workers are running.
- **Event-driven usage.** R2 event notifications into a queue would update usage within
  seconds instead of nightly. That is a Scale item and the plan already tracks it separately.

## What is left to do here

Small, and worth naming precisely so it is not rediscovered:

1. **A per-company storage screen on the dashboard**, reading the route that already exists.
2. **A chart, against the allowance**, on that screen and on the company's own — the ninety days
   and the allowance per day are both in the response.
3. **Push the eighty-percent warning** rather than waiting to be asked for it. The P15
   announcement channel is the cheapest honest option.
4. **One reconciliation run against the real Cloudflare account**, which closes the first exit
   criterion and nothing else will.

Billing the overage is deliberately not on this list: it belongs with invoicing, not with metering.

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
