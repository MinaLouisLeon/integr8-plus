# P25 — Calendar and dispatch board

**Version:** v1.2 Scheduling and Dispatch
**Status:** `NOT STARTED`
**Depends on:** P21

## Goal
A dispatcher plans and reassigns a whole day by dragging, faster than they could by phone.

## Scope
The screen a dispatcher lives in. Speed and density matter more than features here.

## Tasks
- [ ] Calendar views: day, week and month, per engineer and combined
- [ ] Drag-and-drop dispatch board — engineers as columns, time down the page
- [ ] Unassigned queue sorted by age and priority
- [ ] Inline job preview without leaving the board
- [ ] Bulk reschedule and reassign
- [ ] Keyboard shortcuts for the common actions
- [ ] Instant push to the affected engineer's phone on any change
- [ ] Timezone handling per company and per site
- [ ] Board state persisted per dispatcher — filters, visible engineers, zoom

## Exit criteria
- [ ] A dispatcher reschedules twenty jobs in under five minutes, observed
- [ ] The board stays responsive with two hundred jobs and thirty engineers loaded
- [ ] An engineer's phone reflects a board change within thirty seconds

## Notes
- Watch a dispatcher work before designing this. They optimise for keystrokes and glance
  time, not for discoverability.
