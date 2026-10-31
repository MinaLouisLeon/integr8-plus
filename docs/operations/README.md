# Customers, sites and work orders

The operational records everything else attaches to: who the customer is, where the work
happens, and what the job is (P10). Records and lifecycle on web and desktop; the mobile app
consumes the same API from P14.

```
@integr8/operations-dom      the screens, shared by web and desktop
        │
apps/api  routes/v1/customers.ts, job-types.ts, work-orders.ts, imports.ts
        │  who may do what; geocoding and imports in the worker
@integr8/db  migration 0010  the state machine, the completion rule and the history, by trigger
```

---

## Customers and contacts

A customer has contacts, sites, tags, notes and an account status:

| Status    | Meaning                                                                 |
| --------- | ----------------------------------------------------------------------- |
| `active`  | Normal.                                                                 |
| `on_hold` | New work needs `acknowledgeOnHold` — the screen asks "create anyway?".  |
| `closed`  | No new work. Existing jobs are unaffected. Customers are never deleted. |

Account numbers are unique per company, ignoring case. Tags are stored trimmed and in lower
case. One contact is primary. Contacts are archived, not deleted.

## Sites

Each site belongs to one customer for good, has its own address and contact (one of its
customer's), and is archived rather than deleted.

**Access notes** are separate fields — gate code, parking, who to ask for, hazards on
arrival, other notes — because they are the most-read part of a job. They come first on the
job screen and the site screen, hazards highlighted, gate code large. The office can edit
them; so can anyone working a job at the site (`PUT /v1/sites/:id/access`), because the
engineer at the gate is the first to learn the code has changed. Every change records who
and when.

### Geocoding

A site is created `pending` and the worker geocodes it (`site.geocode` job):

| `geocodeStatus` | Meaning                                                                                         |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `pending`       | Waiting for the geocoder.                                                                       |
| `found`         | Placed from the address; `geocodeAccuracy` says how precisely (a postcode is not a front door). |
| `not_found`     | The address matched nothing. Place it by hand.                                                  |
| `failed`        | The provider failed three times. Place it by hand, or change the address to retry.              |
| `manual`        | Placed by a person: on the map, by coordinates, or from their device's location.                |

A changed address clears the coordinates and puts the site back to `pending` (by trigger);
a pin placed by hand is kept until then. A geocoder answer for an address that has since
changed is discarded.

| Setting               | Meaning                                                                                                                        |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GEOCODER`            | `mapbox` in production; `fake` (stable coordinates from the address text) in development and tests. Production refuses `fake`. |
| `MAPBOX_ACCESS_TOKEN` | A secret token with geocoding scope. Requests use `permanent=true`, which Mapbox requires for results that are stored.         |

**Maps.** The site screen shows a Leaflet map for dropping a pin when the app is given tiles:
`NEXT_PUBLIC_MAP_TILES_URL` / `VITE_MAP_TILES_URL` with `…_ATTRIBUTION`, such as a Mapbox
raster style URL with a public token. In development, OpenStreetMap's tiles stand in; their
usage policy does not allow a product to rely on them. Without tiles, a site is placed by
coordinates or device location.

## Job types

A job type carries onto every new work order of its type: forms (each required or optional),
a checklist, instructions, a default priority, an expected duration, and how many before and
after photos a job needs and whether the customer signs off (P14). The work order gets
a **copy**, so changing a type changes jobs created afterwards and none already out. Codes are
upper case and unique (`BOILER-SERVICE`); imports name types by code or name.

A form's settings screen says which job types require it (`requiredByJobTypeIds` on
`PATCH /v1/forms/:id`) — the same links, seen from the form.

## Work orders

A job for a customer, at one of the customer's sites, of a type. References are per company
(`WO-000123`), handed out by a counter the runtime role cannot write.

### The state machine

```
scheduled ─▶ dispatched ─▶ travelling ─▶ on_site ─▶ in_progress ─▶ complete ─▶ reviewed
```

| From             | To                                       | Who            |
| ---------------- | ---------------------------------------- | -------------- |
| `scheduled`      | `dispatched`, `cancelled`\*              | office         |
| `dispatched`     | `travelling`, `on_site`                  | crew           |
| `dispatched`     | `scheduled`, `cancelled`\*               | office         |
| `travelling`     | `on_site`, `dispatched`                  | crew           |
| `travelling`     | `cancelled`\*                            | office         |
| `on_site`        | `in_progress`, `travelling`              | crew           |
| `in_progress`    | `awaiting_parts`, `complete`             | crew           |
| `awaiting_parts` | `in_progress`                            | crew           |
| `awaiting_parts` | `scheduled`, `dispatched`, `cancelled`\* | office         |
| `complete`       | `reviewed`, `in_progress`\*              | owner or admin |
| `cancelled`      | `scheduled`\*                            | office         |

\* needs a reason. "Office" is `work_order.manage` (owner, admin, dispatcher); "crew" is
`work_order.progress` on a job the person is assigned to (or the office); sign-off is
`work_order.review`.

The table lives in `@integr8/core` (`WORK_ORDER_TRANSITIONS`) and in the database
(`work_order_transition_allowed`); the schema-invariant suite checks every pair of states
against both. The database refuses, for every client and role:

- a transition not in the table, or without a reason where one is needed;
- dispatching with nobody assigned;
- **completing while anything the job needs is missing** (P14): a required form with no submitted
  submission for this job, fewer before or after photos than the job asks for, or no customer
  sign-off where one is required. The API answers 409 `completion_blocked`, with one detail per
  missing thing;
- editing a completed, reviewed or cancelled job's details.

A write names the revision it read; a stale one is refused `work_order_changed`.

### Crew

One or more people, at most one lead (a crew of one leads itself). Taking someone off
unassigns them rather than deleting the row. Engineers see only the jobs they are on.

### Forms, checklist, notes, files, history

- Forms are filled for a job with `POST /v1/submissions { formId, workOrderId }`: the form must
  be one of the job's, the job open, and the person on its crew. The link never changes.
  `GET /v1/submissions?workOrderId=|siteId=|customerId=` finds them again, and so does the
  submission list screen.
- Checklist items record who ticked them and when.
- Notes are `internal` or `customer` (may be shown to the customer, P29), and are not edited
  or deleted.
- Files are uploaded through `/v1/media` and attached (`POST /v1/attachments`) to a customer,
  a site or a job. An attached file cannot be deleted until it is taken off.
- `work_order_events` is written by trigger for creation, every transition, reschedule, edit
  and crew change, and nobody can change or delete it.
- The job screen lists earlier jobs at the same site: the previous reports.
- Before and after photos, the sign-off and the time on the job are in the job screen's
  Completion section. Time and the Timesheets screen are explained in
  [the working day](../mobile/job-execution.md#time).

### Lists, saved views, bulk changes

`GET /v1/work-orders` filters by state, priority, type, customer, site, assignee (or `me`),
unassigned, due window, overdue and words or a reference, with counts by state. A saved view
is a named set of exactly those parameters, one's own or shared. `POST /v1/work-orders/bulk`
reassigns, reschedules (set a window, or shift by minutes) or cancels up to 200 jobs, each on
its own: the result lists every job it could not change and why.

## Scheduling: visits and the schedule (P25)

**The company's calendar.** The schedule's shading, the visit-day certificate check,
maintenance due dates, contract years and deadlines counted in working hours all read the
company's timezone, working hours and working days from Settings (`PATCH /v1/settings`;
hours are minutes from midnight, days are ISO numbers with Monday as 1). A new company starts
on `Africa/Cairo`, 08:00 to 17:00, Sunday to Thursday (`[7, 1, 2, 3, 4]`), since migration
0057; before that it started on UTC, Monday to Friday, which ran Egyptian companies' deadlines
and maintenance through Fridays. Companies that existed before 0057 keep what they have: check
their settings rather than assuming.

A job can take several trips. Each is a **visit** (`work_order_visits`, migration 0051): a
start, an end, notes, and the people from the job's crew who go
(`work_order_visit_assignees`). The job keeps its own workflow; a visit is only `planned`,
`done` or `cancelled`, and done and cancelled are final. The job's due window stays what the
customer was promised; a visit outside it is allowed, with a warning.

Rules the database enforces for every client:

- **Nobody is on two jobs at once.** An exclusion constraint (`btree_gist`) refuses the same
  person on overlapping planned visits of different jobs. Visits of the same job may overlap,
  and visits that only touch (one ends at 10:00, the next starts at 10:00) do not clash. The
  API says `visit_double_booked`, with a detail naming each clash.
- **Only the crew goes.** A visit's people must be on the job's crew; leaving the crew takes
  someone off the job's planned visits.
- **A closed job has no planned visits.** Completing a job marks its started visits done and
  cancels the rest; cancelling it cancels them all.
- **Work at any hour is fine.** Companies run 24/7 teams and flexible hours: the company's
  working day only shades the calendar.

Each visit change writes `work_order_events` (`visit_scheduled`, `visit_rescheduled`,
`visit_done`, `visit_cancelled`, `visit_assigned`, `visit_unassigned`), touches its job for
sync and tells the people on it by push, once: someone put on the crew and a visit together
hears about the visit only.

| Request                           | Who                     | Does                                                 |
| --------------------------------- | ----------------------- | ---------------------------------------------------- |
| `GET /v1/schedule?from&to&userId` | `work_order.read_all`   | Visits in a window of up to 45 days, with their jobs |
| `GET /v1/schedule/unscheduled`    | `work_order.read_all`   | Open jobs with no planned visit, urgent first        |
| `POST /v1/work-orders/:id/visits` | `work_order.manage`     | Plan a visit; `addToCrew` puts people on the crew    |
| `PATCH /v1/visits/:id`            | `work_order.manage`     | Move it or change who goes, by `expectedRevision`    |
| `POST /v1/visits/:id/cancel`      | `work_order.manage`     | Call it off                                          |
| `POST /v1/visits/:id/done`        | the crew, or the office | Mark it done (the phone uses sync instead)           |
| `POST /v1/visits/bulk`            | `work_order.manage`     | Reassign, shift or cancel up to 200, one by one      |

The desktop **Schedule** (`packages/operations-dom/src/schedule`) shows day, week and month
views, coloured by person, with a sidebar to show or hide people and a "Needs a visit" list.
Dragging moves a visit, its bottom edge changes when it ends, and a job dropped on a day opens
the visit dialog, which also does everything dragging does from the keyboard. Selecting an
engineer's visits and reassigning them is how an unavailable engineer's day is redistributed.
The job screen lists its visits. On the phone, the Today screen lists the engineer's visits
and a started one can be marked done offline ([sync](../sync/README.md)).

## Skills and certificates (P26)

A company keeps a list of the qualifications it tracks (`qualification_types`, migration 0052):
a **skill**, which never expires, or a **certificate**, which may. People hold them
(`member_qualifications`): a record has an issue date, an expiry date (the last day it is
valid), a number, notes and scans attached as files. A renewal is a new record; the old one
stays, expired, as the history of what was held. Records are removed, never deleted, and a
removed record no longer counts. Qualifications belong to the company member, not to the HR
profile, so a company without the HR module has them too.

Who does what:

- Owners, admins and HR managers keep the list and the records (`qualification.manage`), and
  set how many days before expiry people are warned (30 by default).
- The dispatcher and viewers read them (`qualification.read`). Everyone reads their own.
- A job type lists the qualifications its jobs need (`job_type_qualifications`), set by Integr8
  staff or by the company's managers (product decision, 2026-10-27). Each new job copies the
  list (`work_order_qualifications`), and the office can change it for that job alone.

**The check on visits.** For each requirement, at least one person on each visit must hold that
qualification, valid on every day of the visit in the company's time zone; helpers without it
can join. When a plan, move or reassignment leaves nobody holding one, the API refuses it with
`visit_unqualified`, with a detail per person and requirement saying whether it is `missing`,
`expired` or `expires_before_visit`. Sent again with a reason (`qualificationOverride`, or one
`qualificationOverrideReason` for a bulk change), it goes ahead: the reason is kept in
`work_order_qualification_overrides`, append-only, which writes a `qualification_override`
event into the job's history. Only gaps a change opens ask for a reason: moving a visit with
the same people does not ask twice, putting someone else on it does. Nothing is ever refused
for good, and a visit with a gap carries an `unqualified` warning and its `qualificationGaps`.

The check is in the API, not the database: a certificate valid when the visit was planned can
lapse on its own, and the visit then shows the warning.

**Expiry alerts.** Once a day the worker finds certificates expiring within the warning period
and certificates that have lapsed, in every company. Each is announced once: to the holder by
email and on their phone, and to the people who keep the records in one email listing
everything. A lapse also lists the planned visits of the next 60 days that need that
certificate. A certificate already renewed, or held by someone no longer active, is passed
over. Changing a record's expiry date lets its alerts go out again. Emails need the
deployment's email sender; the managers' email links to `WEB_APP_URL/qualifications`.

| Request                                       | Who                                         | Does                                                    |
| --------------------------------------------- | ------------------------------------------- | ------------------------------------------------------- |
| `GET /v1/qualification-types`                 | `qualification.read`                        | The company's list, with the warning period             |
| `POST`, `PATCH /v1/qualification-types[/:id]` | `qualification.manage`                      | Add, rename, archive or restore; the kind never changes |
| `PATCH /v1/qualification-settings`            | `qualification.manage`                      | The warning period, 1 to 365 days                       |
| `GET /v1/qualifications`                      | `qualification.read`                        | Who holds what, with where each stands today            |
| `GET /v1/me/qualifications`                   | everyone                                    | One's own; the phone also gets them with every sync     |
| `POST`, `PATCH /v1/qualifications[/:id]`      | `qualification.manage`                      | Record or correct one; renewals are new records         |
| `POST /v1/qualifications/:id/remove`          | `qualification.manage`                      | Take one away, kept in the history                      |
| `PUT /v1/job-types/:id/qualifications`        | `job_type.manage` or `qualification.manage` | What a job type's jobs need                             |
| `PUT /v1/work-orders/:id/qualifications`      | `work_order.manage`                         | What one job needs                                      |
| `GET /v1/work-orders/:id/eligibility`         | `work_order.read_all`                       | Everyone ranked by what they hold for a visit's dates   |

A scan is attached with `POST /v1/attachments` and `{ memberQualificationId }`.

## Contracts, maintenance plans and deadlines (P27)

Migration 0053 adds three things that work together: service contracts say what a customer has
agreed to, maintenance plans make an asset's servicing jobs ahead of time, and deadlines count
down from when a job is created. The date rules are in `@integr8/core` (`calendar.ts`,
`maintenance.ts`, `contracts.ts`, `deadlines.ts`).

**Contracts.** A contract (`service_contracts`, numbered `CT-000001` per company) belongs to one
customer and has a term: a start day and an end day, the last day it covers. It covers all the
customer's sites, assets and job types, or the ones listed (`service_contract_sites`,
`_assets`, `_job_types`). It may include a number of call-outs per contract year: jobs that did
not come from a maintenance plan. Cancelling needs a reason, is final and ends coverage from the
day given. Renewing makes the next contract with the same coverage, from the day after the end
for as long again, names the old one (`renewed_from_id`, once only) and moves its maintenance
plans across. Managers are emailed once when a contract enters its renewal notice period (60
days by default) and once if it ends without being renewed.

Owners, admins and dispatchers keep contracts (`contract.manage`); viewers read them
(`contract.read`). Engineers see coverage on their own jobs.

**Coverage.** When a job is created, by any route (the screens, imports, sales orders, plans),
`WorkOrdersRepository.create` works out its coverage and stores it in `work_order_coverage`:
**covered** by a contract (`contract`) or by a plan's contract (`maintenance_plan`), or
**chargeable** with the reason (`no_contract`, `contract_ended`, `site_not_covered`,
`asset_not_covered`, `job_type_not_covered`, `callouts_used`). A customer who never had a
contract gets no coverage row, so a company that does not use contracts sees nothing. Linking or
unlinking an asset works it out again. The office can override it with a reason (`override`),
which writes a `coverage_changed` event into the job's history; an overridden job, or one a plan
made, is not worked out again.

**Maintenance plans.** A plan (`maintenance_plans`) belongs to one asset, so it needs the assets
module, and uses the asset permissions: `asset.manage` keeps plans, `asset.read` sees them. It
repeats every N days, weeks, months or years, counted one of two ways:

- `calendar`: every interval from the start date, whatever happened. The n-th date is always
  counted from the start date, so a plan that starts on the 31st comes back to the 31st after a
  shorter month.
- `completion`: one interval after the previous job was completed, or after the day it was due
  if it was cancelled. Only one of its jobs is open at a time.

Due dates are calendar days in the company's time zone. Once a day the worker makes each job
`lead_days` before its due date (30 by default), unplanned, with a due window from
`window_before_days` before to `window_after_days` after (7 each by default), so it waits under
**Needs a visit** on the schedule. Plans at the same site with the same job type and contract,
whose windows meet and which may share (`can_share`, on by default), become one job listing all
their assets; a sharing plan also joins such a job another plan made earlier while it is still
unplanned. Each due date is kept in `maintenance_occurrences`, unique per plan and date and
append-only, which writes a `maintenance_planned` event: running the worker twice makes nothing
twice. Dates from before a plan was created are not made; dates missed while the worker was
down are made on its next run. A retired asset's dates are skipped. A plan stops at its own end
date and at its contract's. Changing a plan only moves what has not been made yet. A paused
plan makes nothing; resuming carries on from today.

**Deadlines.** The company sets, per priority, how long it has to respond (to dispatch the job)
and to complete it (`deadline_rules`), counted around the clock or in the company's working
hours only, with a warning a set number of minutes before. Public holidays are not known. A new
job gets its deadlines from its creation time (`work_order_deadlines`); a priority with no rule
gives none, and a job a plan made gets none, since its due window is its target. Changing a
job's priority works them out again from the creation time. The job's own state changes meet
them, by trigger, whichever client makes the change: the first dispatch meets the response
deadline, the first completion the completion deadline. The clock never pauses. A cancelled job
closes its deadlines without a miss. A deadline met late, or passed unmet, is recorded once, is
never cleared, and writes a `deadline_missed` event. Every ten minutes the worker records the
deadlines that passed unmet and sends each warning and miss once, by email to the job's crew and
to holders of `work_order.manage`, and by push to the crew.

| Request                                     | Who                   | Does                                                      |
| ------------------------------------------- | --------------------- | --------------------------------------------------------- |
| `GET /v1/contracts[/:id]`                   | `contract.read`       | Contracts; one with its plans and the jobs it covered     |
| `POST`, `PATCH /v1/contracts[/:id]`         | `contract.manage`     | Add or change one; existing jobs keep their coverage      |
| `POST /v1/contracts/:id/cancel`, `/renew`   | `contract.manage`     | Cancel with a reason, or renew into the next term         |
| `PUT /v1/work-orders/:id/coverage`          | `contract.manage`     | Override a job's coverage, with a reason                  |
| `GET /v1/maintenance-plans`                 | `asset.read`          | Plans, with their next due dates                          |
| `POST`, `PATCH /v1/maintenance-plans[/:id]` | `asset.manage`        | Add or change one                                         |
| `POST /v1/maintenance-plans/:id/status`     | `asset.manage`        | Pause, resume or end one; ending is final                 |
| `GET /v1/maintenance`                       | `asset.read`          | Upcoming, made, completed, overdue and skipped due dates  |
| `GET /v1/deadline-rules`                    | `work_order.read_all` | The rules and the company's working week                  |
| `PUT /v1/deadline-rules`                    | `deadline.manage`     | Replace the rules                                         |
| `GET /v1/deadline-report`                   | `work_order.read_all` | Totals, totals per customer, and every miss, for a period |

Every job summary carries `coverage`, the `deadline` that matters now and whether a plan made
it (`maintenance`); the job screen, and the phone's copy, carry the full `coverage`,
`deadlines` and `maintenancePlans`.

## CSV import

`POST /v1/imports { kind, fileName, csv, timeZone }` stores the file (up to 5 MB and 20,000
rows) and the worker imports it. Each row is validated and written **in its own transaction**,
so a bad row is reported — spreadsheet row number (the header is row 1), column, reason — and
the rest of the file carries on. A file that cannot be read at all (broken quoting, a required
column missing) fails before any row is written.

Templates: `GET /v1/imports/templates/:kind`; column meanings: `GET /v1/imports/columns/:kind`.

- **customers** — `name` required; `account_number` unique; tags separated by semicolons.
- **sites** — the customer by `customer_account_number` or exact `customer_name`; `site_name`
  and `address_line1` required; `latitude`/`longitude` together place it by hand; access
  notes columns.
- **work_orders** — customer, `site_name`, `job_type` (code or name) required; dates as
  `2026-10-01`, `2026-10-01 09:00` (read in the importer's time zone; a bare `due_by` date
  means the end of that day) or ISO 8601 with an offset; `engineers` are email addresses.

An import runs once: if it stops part-way it is marked failed with the count it reached,
because running it again would write the saved rows twice.

## Desktop content policy

The Tauri window's CSP allows images from the API, R2 and the map tile hosts, and uploads to
R2 (`connect-src`). A new tile or storage host needs adding there.
