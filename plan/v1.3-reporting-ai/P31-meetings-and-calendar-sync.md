# P31 — Meetings and calendar sync

**Version:** v1.3 Reporting, Comms and AI
**Status:** `NOT STARTED`
**Depends on:** P27

## Goal
Meetings appear where people already look, and their outcomes become real tasks.

## Scope
Deliberately thin. A meeting is a calendar entry with an agenda, not a second scheduling
system.

## Tasks
- [ ] Schedule a meeting: attendees, agenda, location or video link, reminder
- [ ] Recurring meetings
- [ ] Notes and action items, with action items converting into tasks with an owner and due date
- [ ] Two-way Google Calendar and Outlook sync for jobs and meetings
- [ ] ICS invites for external attendees who have no account
- [ ] Attendance tracking for compliance-driven briefings
- [ ] Room and resource booking

## Exit criteria
- [ ] A meeting created in the product appears in the attendee's Google or Outlook calendar
- [ ] A change made in the external calendar reflects back without creating a duplicate
- [ ] An action item becomes a real task with a real owner

## Notes
- Two-way calendar sync creates duplicates if the identity mapping is sloppy. Store the
  external event id and reconcile on it, never on title and time.
