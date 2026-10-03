# P27 — Preventive maintenance and reminders

**Version:** v1.2 Scheduling and Dispatch
**Status:** `NOT STARTED`
**Depends on:** P26

## Goal

Recurring work generates itself, so a contract never quietly lapses.

## Scope

Recurrence, contracts and SLA timing.

## Tasks

- [ ] Recurrence rules (RRULE) attached to an asset, a site or a contract
- [ ] Automatic job generation on a rolling horizon, not all at once
- [ ] Contracts and entitlements per customer, defining what is covered
- [ ] SLA timers: response due, resolution due, warning before breach, breach recorded
- [ ] SLA compliance reporting per customer
- [ ] Follow-up job creation from a completed job, carrying context forward
- [ ] Capacity view: booked against available hours per week
- [ ] Customer self-booking link with a slot picker

## Exit criteria

- [ ] A quarterly maintenance rule generates the correct jobs across a daylight-saving boundary
- [ ] Changing a recurrence rule does not disturb jobs already completed against it
- [ ] An SLA breach is recorded and reportable, not merely displayed

## Notes

- Recurrence and timezones together are a classic bug source. Store rules in the site's
  timezone and generate in UTC, and test across a DST change explicitly.
