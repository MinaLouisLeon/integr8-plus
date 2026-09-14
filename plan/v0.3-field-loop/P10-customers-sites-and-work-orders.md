# P10 — Customers, sites and work orders

**Version:** v0.3 Field Loop
**Status:** `IN PROGRESS — built and verified; awaiting a real engineer on the job screen`
**Depends on:** P08

## Goal

The operational records everything else attaches to: who the customer is, where the work
happens, and what the job is.

## Scope

Records and lifecycle on desktop and web. Mobile consumption is P14.

## Tasks

- [x] Customer records: contacts, addresses, tags, notes, account status
- [x] Multiple sites per customer, each geocoded, each with its own contact
- [x] **Site access notes** — gate codes, parking, who to ask for, safety hazards on arrival
- [x] Job types, configurable per company, carrying default forms, checklist and expected duration
- [x] Work order records: customer, site, type, priority, description, due window, instructions
- [x] Explicit state machine — scheduled, dispatched, travelling, on site, in progress, awaiting parts, complete, reviewed — with allowed transitions enforced server-side
- [x] Assignment to one or more engineers, with a lead where a crew attends
- [x] Required forms attached to a job type; a job cannot close until they are submitted
- [x] Form settings: which job types require each form — moved here from P07, which built the other form settings but had no job types to choose from. The desktop settings screen already shows the option disabled; enable it and store it with the job type
- [x] Checklists and instructions on the job
- [x] Attachments: site plans, manuals, previous reports
- [x] Comments, with internal notes kept separate from customer-visible notes
- [x] Job list with filters, saved views and bulk reassign / reschedule / cancel
- [x] Filter submissions by linked entity (customer, site, job) — moved here from P08, which built every other submission filter but had nothing to link a submission to. Needs a link from a submission to its job, and a `linkedEntity` filter on `GET /v1/submissions` and the list screen
- [x] CSV import for customers, sites and jobs

## Exit criteria

- [x] An invalid state transition is rejected by the API, not merely hidden in the UI
- [x] A job whose required forms are unsubmitted cannot be marked complete, from any client
- [ ] Site access notes are the first thing visible on the job screen — verified with a real engineer
- [x] Importing a thousand jobs from CSV reports per-row errors without aborting the whole file

## Notes

- Free-text status fields are how field service products become unreportable. Keep the
  state machine explicit and server-enforced from the first commit.
- Access notes sound trivial and are the most-read field in the entire product.

---

## Progress

Everything in the task list is built and passes against the database, the API and a real
browser on both web and desktop. The third exit criterion stays open: access notes are the
first thing on the job screen for every role and in both directions of text, but "verified
with a real engineer" means a person who does the work looking at it, which has not
happened. The design is in [docs/operations](../../docs/operations/README.md).

| Claim                                                 | How it was proven                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An invalid transition is rejected by the API          | API integration: a transition the table does not have is 409 naming both states; an engineer is refused an office transition (403) and a job is invisible to someone not on its crew (404); dispatch with nobody assigned is refused. Database suite: every transition not in the table is refused when written directly as the runtime role; a cancellation without a reason is refused from the owner connection. The schema-invariant suite checks all 81 pairs of states against `@integr8/core` |
| A job with unsubmitted required forms cannot complete | API integration: completion is refused naming the missing form, then succeeds once that form is submitted for this job. Database suite: refused "however it is written" — as the runtime role and as the owner — and a submission cannot name a form that is not one of the job's, or move to another job                                                                                                                                                                                            |
| Access notes come first on the job screen             | DOM test: the access region precedes every other heading, hazards first. Real Chromium, web: the engineer's job screen opens on "Getting in"; the same in Arabic, mirrored. Desktop app in Vite, as the owner: the same order. **Not yet seen by a real engineer**                                                                                                                                                                                                                                   |
| A 1,000-job import reports per-row errors, no abort   | API integration: 1,000 rows with seven bad ones (site, priority, impossible date, unknown engineer, due window backwards, unknown customer, unknown type) and an unknown column: 993 written, each bad row reported by spreadsheet row and column, London wall-clock times read correctly. A file that cannot be parsed fails before any row. Real browser: a 40-row file with three bad rows reported "37 imported, 3 with problems"                                                                |
| The field loop works end to end in a browser          | Web app against the API and PostgreSQL: a dispatcher dispatched from tabs with counts; the engineer saw only their job, arrived, started, was refused completion ("Before completing, submit: Gas safety check"), filled the form from the job, ticked the checklist and completed; the history recorded each step. Bulk reassign and reschedule, a saved view, a site pin placed by hand on the map                                                                                                 |
| Form settings and job types agree, both directions    | Real desktop app: unticking a job type in form settings shows the form as optional on the job types screen without a reload; marking it required on the job types screen shows it ticked in form settings, and saving an unrelated setting there leaves it required                                                                                                                                                                                                                                  |
| Nothing else regressed                                | Workspace lint, typecheck, unit tests and build (53 tasks); db integration 221, API integration 104 (the R2 suite skipped, as P09), core 63, API unit 100, form renderer 45, operations screens 6, desktop 34                                                                                                                                                                                                                                                                                        |

## Decisions taken during implementation

- **The database enforces the lifecycle.** The transition table, the reason rule, dispatch
  needing a crew, completion needing every required form and frozen closed jobs are a
  trigger on `work_orders`, so no client, role or future route can skip them. `@integr8/core`
  holds the same table for the screens, and a test holds the two together. The history is
  written by trigger and nobody can change it.
- **`cancelled` is a state.** The plan's list had no way to end a job that will not happen,
  and bulk cancel needs one. Cancelling, reopening a completed job and restoring a cancelled
  one all need a reason.
- **A job copies its type.** Forms, checklist, instructions and priority are copied when the
  job is created, so editing a type never changes jobs already out.
- **Crew changes unassign rather than delete,** keeping who was on a job; at most one lead.
- **Engineers see only jobs they are on,** on every list and detail route; customers and
  sites are readable to them, and they may correct the access notes of a site they are
  working at, because they are the first to find a gate code has changed.
- **Imports write each row in its own transaction and run once.** A failure part-way is
  recorded with the count reached; running it again would write the saved rows twice.
- **Geocoding behind an interface; Mapbox with `permanent=true` in production,** a
  deterministic fake in development and tests. Maps use Leaflet with configured tiles;
  OpenStreetMap's tiles only in development.
- **Screens in a shared package,** `@integr8/operations-dom`, hosted by both web and desktop,
  as the form renderer is.

## Found while building this

- **The OpenAPI document dropped every union request body (P04).** `isEmpty` treated a schema
  with no `properties` as empty, so the bulk route's discriminated union produced no body and
  no client type. Fixed, with a test.
- **The desktop CSP blocked R2 (P09).** `connect-src` had no R2 host, so uploads from the
  Tauri window would have failed in production; `img-src` also lacked the API and R2. Added,
  with the map tile hosts.
- **Form settings could undo a job type change.** The settings panel took which job types
  require the form from the form, cached for as long as the builder is open, and sent the
  whole list back on every save. It now reads the job types themselves, sends the list only
  when a box was changed, and refreshes the job types after saving.
- **Shifting an undated job reported a change.** Bulk reschedule by minutes counted a job
  with no due dates as changed; it is now refused `no_due_window`.
- **i18next's key types hit TypeScript's depth limit** once the catalogue grew; helpers that
  take `t` use `TFunction`.
- **pg sends a JS array as a PostgreSQL array literal,** so jsonb arrays are sent as JSON
  text, and `text[] || 'x'` in a trigger needs `array_append`. Events written in one
  transaction share `now()`, so the history is ordered by an identity column.
