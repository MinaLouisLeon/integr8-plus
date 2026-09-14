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
a checklist, instructions, a default priority and an expected duration. The work order gets
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
- **completing while a required form has no submitted submission for this job** — the error
  names the forms;
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

### Lists, saved views, bulk changes

`GET /v1/work-orders` filters by state, priority, type, customer, site, assignee (or `me`),
unassigned, due window, overdue and words or a reference, with counts by state. A saved view
is a named set of exactly those parameters, one's own or shared. `POST /v1/work-orders/bulk`
reassigns, reschedules (set a window, or shift by minutes) or cancels up to 200 jobs, each on
its own: the result lists every job it could not change and why.

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
