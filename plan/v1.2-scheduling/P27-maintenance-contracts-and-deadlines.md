# P27 — Maintenance plans, contracts and response deadlines

**Version:** v1.2 Scheduling and Dispatch
**Status:** `IN PROGRESS`
**Depends on:** P26

## Goal

Recurring work creates itself, each job says whether the customer's contract covers it, and a
missed response deadline is recorded, not merely displayed.

## Scope

Ideas 1, 7 and 8 in `new-idea.md`: recurring maintenance plans per asset, service contracts and
their coverage, and company response deadlines with alerts and a report.

Agreed on 2026-10-27:

- **Only ideas 1, 7 and 8.** Reminders before a visit, follow-up jobs and the capacity view move
  to a later phase. Customer self-booking is dropped from the plan.
- **A maintenance plan belongs to one asset.** Recurring maintenance therefore needs the assets
  module switched on for the company.
- **Recurrence is chosen per plan.** Either a fixed calendar (every 3 months from the start
  date, whatever happened last time) or from the last completion (3 months after the previous
  job was completed).
- **Jobs are created ahead, unplanned.** A set number of days before each due date, the plan
  creates a job with a due window. It appears in the schedule's unplanned list for a dispatcher
  to place and staff.
- **Grouping is flexible** (see "To confirm", item 1).
- **Contract coverage marks each job** as covered or chargeable, on desktop and phone. No
  automatic billing or quoting.
- **Contracts are renewed by hand.** Managers are reminded before the end date. Renewing creates
  a new contract linked to the old one. Plans linked to an ended contract stop creating jobs.
- **Response deadlines are company-wide, per priority.** Contracts do not change them.
- **Each rule picks its clock:** around the clock, or the company's working hours only.
- **Response is met when the job is dispatched; completion when it is completed.** The clock
  never pauses.

## Design

### 1. Maintenance plans (idea 1)

- **A plan** has:
  - the asset, job type, title and instructions
  - an interval: every N days, weeks, months or years
  - the counting mode: fixed calendar, or from the last completion
  - a start date and an optional end date
  - a due window: days before and after the due date, which become the job's "due from" and
    "due by"
  - how many days ahead to create the job (default 30)
  - an optional contract
  - a "can share a job" switch
- **Status:** a plan is active, paused or ended.
- **Not RRULE.** "Every N units" covers quarterly, monthly and yearly servicing, and is easier to
  edit and test than the RRULE that the original plan named.
- **Occurrences.** Each due date a plan produces is stored as one occurrence: plan, due date,
  job, and whether it was created or skipped. It is unique per plan and due date, so running the
  task twice never creates two jobs.
- **Changing a plan** only affects occurrences that have no job yet. Jobs already created or
  completed are left alone, as the exit criteria require.
- **From the last completion:**
  - Only one open occurrence exists at a time.
  - When its job is completed, the next due date is counted from the completion day.
  - A cancelled job counts from its original due date, so a cancellation does not stop the plan.
- **The daily task** (the same worker timer as the expiry alerts):
  - For each active plan, it creates the jobs whose creation day has arrived.
  - Due dates are counted in the company's time zone and stored as UTC. Sites have no time zone
    of their own today.
  - Occurrences that fell before the plan was created are not created.
  - Occurrences missed while the worker was down are created on its next run.
  - A retired asset, or a plan past its end date or its contract's end, creates nothing more.
- **The job** is a normal job:
  - it names the asset and the plan, and links to the contract
  - it takes the job type's priority, forms and required qualifications (P26)
  - its history says "Created by maintenance plan X"
- **Desktop:**
  - The asset screen gets a "Maintenance plans" section to add, edit, pause and end plans.
  - A new **Maintenance** screen (Work menu) lists upcoming, created, completed and overdue
    maintenance, with filters by customer, site and job type. "Upcoming" also shows the next 12
    months of each plan, worked out on the fly rather than stored.
- **Mobile:** a job from a plan shows "Planned maintenance" with the plan and asset. View only.
- **Permissions:** plans use the asset permissions. `asset.manage` (owner, admin, dispatcher)
  edits them and `asset.read` views them.

### 2. Service contracts (idea 7)

- **A contract** belongs to one customer and is numbered CT-000001 onwards. It has:
  - a title, start and end dates, an optional value and notes
  - a renewal notice period, 60 days by default
- **What it covers:**
  - all of the customer's sites, or chosen sites
  - all assets at those sites, or chosen assets
  - all job types, or chosen job types
  - optionally, a number of included call-outs (jobs not from a maintenance plan) per contract
    year
- **Coverage on each job** is worked out when the job is created, from the customer, site,
  assets, job type and date. The job stores the contract and one of:
  - **covered** by contract X
  - **chargeable**, with the reason: no contract, contract ended, site, asset or job type not
    covered, or included call-outs used up
- **Overriding coverage.** Office staff can change a job's coverage, with a reason that goes into
  the job history.
- **Jobs from a plan linked to a contract** are covered while the contract runs, and don't use
  up included call-outs.
- **States:**
  - A contract is active between its dates.
  - Cancelling it needs a reason and ends coverage from that day.
  - Renewing creates the next contract with the same coverage, starting the day after the end,
    and moves the plans across.
- **Renewal reminder:** the daily task emails contract managers once when a contract enters its
  notice period, and once when it ends without being renewed.
- **Desktop:**
  - a **Contracts** screen (list, detail, add, edit, renew, cancel)
  - a "Contracts" tab on the customer
  - a coverage badge on the job screen and the job list
- **Mobile:** the job shows "Covered by contract CT-000012" or "Chargeable" before the engineer
  starts. View only.
- **Permissions:**
  - new `contract.read` for owner, admin, dispatcher and viewer
  - new `contract.manage` for owner, admin and dispatcher, the same people who manage sales and
    assets
  - engineers see coverage only on their own jobs

### 3. Response deadlines (idea 8)

- **Rules:** one per priority (low, normal, high, urgent), each with:
  - an optional response time and an optional completion time
  - around the clock or working hours only
  - a warning before the deadline (minutes)

  Owners and admins set them in company settings. A priority with no rule has no deadline.

- **Per job.** When a job is created, its response and completion deadlines are worked out from
  its creation time and stored on the job.
  - Working hours use the company's hours and working days. There is no holiday calendar yet.
  - Changing the priority works the deadlines out again from the original creation time, and the
    change goes into the history.
- **Met and missed:**
  - Response is met when the job first becomes dispatched. Completion is met when it becomes
    complete.
  - The clock never pauses.
  - A cancelled job closes its deadlines without a miss.
  - A reopened job keeps its first completion time.
- **A miss is recorded:**
  - When a deadline passes unmet, a "response missed" or "completion missed" event goes into the
    job history and the job is marked missed. The record keeps the deadline itself as the time.
  - A deadline met late is also recorded as missed, with how late it was.
- **Alerts:**
  - The worker timer (every 15 minutes by default) sends the warning before a deadline and the
    alert when it is missed.
  - Each goes by email and push to the job's assignees and to holders of `work_order.manage`.
  - Each alert is sent once.
- **Countdowns:**
  - **Desktop:** the job list, the job screen and the schedule's unplanned list.
  - **Mobile:** the job screen and job list.
  - The colour changes at the warning and at the miss.
- **Report:** a **Response deadlines** report (Work menu, `work_order.read_all`) per customer for
  a chosen period. It shows:
  - jobs with deadlines
  - percentage responded and completed on time
  - average response time
  - the list of misses

  It can be exported to CSV.

### 4. Shared

- **Migration `0053`:**
  - plans and occurrences
  - contracts, their coverage lists and a counter
  - deadline rules
  - columns on `work_orders`: plan, contract, coverage, deadlines, met and missed times
  - new event kinds
  - additions to the export, purge and sync lists
- **Core:** pure functions for:
  - stepping a plan's due dates in a time zone, tested across a daylight-saving change
  - adding working minutes across working days and hours
  - working out a job's coverage
- **API:** new routes, and regenerated OpenAPI and client. Job creation sets coverage and
  deadlines inside the same transaction.
- **Sync:** jobs carry coverage, plan and deadlines to the phone.
- **Strings:** English and Arabic.
- **Setup guide:** Markdown and HTML, kept in step. Stage 7 covers the company setup; Stage 12
  covers the release, migration and rollback.
- **Branch:** `feat/maintenance-contracts-deadlines` from `main`. Commits by layer (db, api,
  desktop, mobile, docs), as in P26.

## Filled in, and approved with the plan (2026-10-27)

1. **Grouping.** "Make it flexible" is read as: each plan has a "can share a job" switch, on by
   default. On a given day, plans that are due within each other's windows, at the same site,
   with the same job type and the same contract, and that all have the switch on, become one job
   listing all their assets. Plans with the switch off always get their own job.
2. **Deadlines and planned maintenance.** Jobs created by a maintenance plan get no response
   deadline, because they already have a due window. Their "due by" is the target instead.
3. **Contract permissions.** Owner, admin and dispatcher manage contracts.
4. **Included call-outs** are counted per contract year, and planned maintenance jobs don't
   count.
5. **A priority change** recalculates deadlines from the original creation time.

## Tasks

- [x] Migration 0053 and repositories: plans, occurrences, contracts, coverage, deadline rules,
      job columns, events, export, purge and sync
- [x] Core: due-date stepping (calendar and after completion, across a daylight-saving change),
      working-minutes arithmetic, coverage
- [x] Daily plan task: create jobs ahead, grouping, idempotent, catch-up
- [x] Contracts: CRUD, renew, cancel, coverage on job creation, override with reason, renewal
      reminders
- [x] Deadline rules in settings, deadlines on job creation and priority change, met and missed
      recording, warning and missed alerts
- [x] Response deadlines report with CSV
- [x] Desktop: asset plans section, Maintenance screen, Contracts screen and customer tab,
      coverage badge, countdowns, settings
- [x] Mobile: planned maintenance, coverage and countdown on the job, read only, synced
- [x] English and Arabic strings
- [x] Setup guide (Markdown and HTML) for the migration and rollout

## Exit criteria

Covered by the integration suites (`packages/db` and `apps/api`, `maintenance-contracts`) and the core unit tests; pending their first run in CI.

- [ ] A quarterly plan creates the correct jobs across a daylight-saving change
- [ ] Changing a plan does not disturb jobs already created or completed from it
- [ ] Running the plan task twice creates no duplicate job
- [ ] A job outside its contract's coverage is marked chargeable, with the reason
- [ ] A missed deadline is recorded in the job history and appears in the report, not merely on
      screen

## Notes

- Recurrence and time zones together are a classic bug source. Count due dates in the company's
  time zone, store UTC, and test across a daylight-saving change explicitly.
- Moved out to a later phase: reminders before a visit, follow-up jobs from a completed job, and
  the capacity view. Customer self-booking is dropped.
- Found while building this: migration 0052 (P26) never added the `qualifications.expiry` row to
  `scheduled_task_runs`, so the daily certificate expiry run never won a turn. 0053 adds it with
  this phase's own two runs.
- Found in the October 2026 audit: deadlines in working hours, maintenance due days and
  contract years read the company's calendar, and a new company's was UTC, Monday to Friday, so
  an Egyptian company's response clock ran through Friday and stopped on Sunday. Migration 0057
  makes new companies start on `Africa/Cairo`, Sunday to Thursday, and the repository fallbacks
  (`DEFAULT_SETTINGS`, the ledger's `erp_ledger_timezone`) match. Existing companies keep their
  settings.
