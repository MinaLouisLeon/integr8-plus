# P25 — Calendar and dispatch board

**Version:** v1.2 Scheduling and Dispatch
**Status:** `IN PROGRESS`
**Depends on:** P21

## Goal

A dispatcher plans and reassigns a whole day by dragging, faster than they could by phone.

## Scope

The screen a dispatcher lives in. Speed and density matter more than features here.

Agreed on 2026-10-26 (idea 2 in `new-idea.md`):

- **Visits, not one slot per job.** A job can take several days and trips. Each visit has its
  own start, end and people from the job's crew; the job keeps its workflow, and a visit is
  only planned, done or cancelled.
- **A calendar, not engineer columns.** Day, week and month views, visits coloured by person,
  a sidebar to show or hide people. Dragging changes the time; people change in the visit
  dialog or by reassigning a selection.
- **Conflicts.** The same engineer on overlapping visits of different jobs is refused, by the
  database. Overlapping visits of the same job are allowed. Work outside office hours is
  always accepted: companies run 24/7 teams and flexible hours.
- **Desktop only** for the board; engineers see their visits on the phone.

## Tasks

- [x] Visits: `work_order_visits` and `work_order_visit_assignees` (migration 0051), with the
      double-booking exclusion constraint, history, push and sync
- [x] Schedule API: the calendar, the unscheduled list, plan, move, reassign, cancel, done,
      and bulk reassign, shift and cancel
- [x] Calendar views: day, week and month, everyone or chosen people
- [x] Drag to move and to change the end; drag a job from the unscheduled list to plan it
- [x] Unscheduled queue sorted by priority and age
- [x] Inline visit preview and editing without leaving the board (the visit dialog)
- [x] Bulk reschedule and reassign of selected visits
- [ ] Keyboard shortcuts for the common actions (the dialog covers every action from the
      keyboard; dedicated shortcuts are not done)
- [x] Push to the affected engineer's phone on any change
- [x] The engineer's visit timeline on the phone, and marking a visit done offline
- [ ] Timezone per site (times show in the device's time zone; the board says when that is not
      the company's)
- [x] Board state persisted per dispatcher — view and people shown (in the browser's storage)

## Exit criteria

- [ ] A dispatcher reschedules twenty jobs in under five minutes, observed
- [ ] The board stays responsive with two hundred jobs and thirty engineers loaded
- [ ] An engineer's phone reflects a board change within thirty seconds
- [ ] The integration suites (`work-order-visits`, `schedule`) pass in CI against Postgres

## Notes

- Watch a dispatcher work before designing this. They optimise for keystrokes and glance
  time, not for discoverability.
- Per-engineer working hours, leave and skills stay in P26.
