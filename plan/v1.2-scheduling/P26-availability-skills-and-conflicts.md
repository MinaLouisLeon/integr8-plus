# P26 — Availability, skills and conflicts

**Version:** v1.2 Scheduling and Dispatch
**Status:** `NOT STARTED`
**Depends on:** P25

## Goal
The board knows who is actually available and actually qualified, and refuses to let the
dispatcher make an impossible plan.

## Scope
The constraints layer under the board.

## Tasks
- [ ] Working patterns, hours and shift definitions per engineer
- [ ] Leave, sickness and non-working time
- [ ] Skills and certifications per engineer, with expiry dates
- [ ] Job types requiring specific skills; unqualified engineers hidden or warned
- [ ] Certification expiry alerts before they lapse
- [ ] Conflict detection: double-booking, overtime breach, travel time impossible
- [ ] Map view with jobs plotted and engineer last-known position
- [ ] Travel time estimates between consecutive jobs, feeding conflict detection
- [ ] Automatic reminders to engineer and customer before a job

## Exit criteria
- [ ] Assigning a job to an engineer without the required certification is blocked or clearly warned
- [ ] A lapsed certification removes that engineer from eligible assignment automatically
- [ ] Double-booking is impossible to create accidentally

## Notes
- Certification enforcement is a compliance feature, not a convenience. For regulated
  trades it can be the reason a company buys.
