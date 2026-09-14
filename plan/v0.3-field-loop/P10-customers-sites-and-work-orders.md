# P10 — Customers, sites and work orders

**Version:** v0.3 Field Loop
**Status:** `NOT STARTED`
**Depends on:** P08

## Goal

The operational records everything else attaches to: who the customer is, where the work
happens, and what the job is.

## Scope

Records and lifecycle on desktop and web. Mobile consumption is P14.

## Tasks

- [ ] Customer records: contacts, addresses, tags, notes, account status
- [ ] Multiple sites per customer, each geocoded, each with its own contact
- [ ] **Site access notes** — gate codes, parking, who to ask for, safety hazards on arrival
- [ ] Job types, configurable per company, carrying default forms, checklist and expected duration
- [ ] Work order records: customer, site, type, priority, description, due window, instructions
- [ ] Explicit state machine — scheduled, dispatched, travelling, on site, in progress, awaiting parts, complete, reviewed — with allowed transitions enforced server-side
- [ ] Assignment to one or more engineers, with a lead where a crew attends
- [ ] Required forms attached to a job type; a job cannot close until they are submitted
- [ ] Form settings: which job types require each form — moved here from P07, which built the other form settings but had no job types to choose from. The desktop settings screen already shows the option disabled; enable it and store it with the job type
- [ ] Checklists and instructions on the job
- [ ] Attachments: site plans, manuals, previous reports
- [ ] Comments, with internal notes kept separate from customer-visible notes
- [ ] Job list with filters, saved views and bulk reassign / reschedule / cancel
- [ ] Filter submissions by linked entity (customer, site, job) — moved here from P08, which built every other submission filter but had nothing to link a submission to. Needs a link from a submission to its job, and a `linkedEntity` filter on `GET /v1/submissions` and the list screen
- [ ] CSV import for customers, sites and jobs

## Exit criteria

- [ ] An invalid state transition is rejected by the API, not merely hidden in the UI
- [ ] A job whose required forms are unsubmitted cannot be marked complete, from any client
- [ ] Site access notes are the first thing visible on the job screen — verified with a real engineer
- [ ] Importing a thousand jobs from CSV reports per-row errors without aborting the whole file

## Notes

- Free-text status fields are how field service products become unreportable. Keep the
  state machine explicit and server-enforced from the first commit.
- Access notes sound trivial and are the most-read field in the entire product.
