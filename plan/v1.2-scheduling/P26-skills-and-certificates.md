# P26 — Skills and certificates

**Version:** v1.2 Scheduling and Dispatch
**Status:** `IN PROGRESS`
**Depends on:** P25

## Goal

The board knows who is qualified for each job, warns the dispatcher before they send someone
without a valid certificate, and records why when they go ahead anyway.

## Scope

Qualifications per person, the qualifications each job needs, the check when people are put on
a visit, and expiry alerts.

Agreed on 2026-10-27 (idea 5 in `new-idea.md`):

- **One qualification record per person.** A skill has no expiry. A certificate has an issue
  date, an expiry date, a number and an optional scan. Records belong to the company member,
  not the HR employee profile, so the feature works without the HR module.
- **Who manages them.** Owners, admins and HR managers add and change qualifications (a new
  `qualification.manage` permission). Dispatchers and engineers can read them.
- **Requirements.** A job type lists the qualifications it needs. Each new job copies that list,
  and office staff can change it on a single job.
- **The check.** For each requirement, at least one person on each visit must hold that
  qualification, valid on the visit's date (not today's). Helpers without it can join the
  visit.
- **Warn, then override with a reason.** When nobody on the visit qualifies, the dispatcher
  sees who is missing what (missing, expired, or expiring before the visit) and must give a
  reason to go ahead. The override and its reason are saved in the job history. Bulk actions
  ask for one reason for the whole batch. Nothing is blocked.
- **People pickers.** People without a valid qualification are shown last and flagged, not
  hidden, because overriding is allowed.
- **Expiry alerts.** A daily task warns managers and the engineer before a certificate lapses.
  The warning period is a company setting, 30 days by default. When a certificate lapses, the
  alert lists the planned visits that no longer meet their requirements.
- **Mobile is view only.** Engineers see their own qualifications with expiry dates, and each
  job shows what it requires. They do not edit or upload certificates.
- **No overrides report yet.** Managers find overrides in the job history.

## Tasks

- [x] Qualifications per member: skills and certificates, with issue and expiry dates, number
      and an optional scan as an attachment
- [x] `qualification.manage` for owner, admin and HR manager; read access for dispatchers and
      engineers
- [x] Required qualifications per job type, copied to each new job and editable on the job
- [x] The check on the visit's date, in the API, for the visit dialog, dragging on the board
      and bulk reassign
- [x] Override with a required reason, recorded in the job history; one reason for a bulk action
- [x] People pickers order and flag people without a valid qualification
- [x] Expiry warning period as a company setting (default 30 days)
- [x] Daily expiry task: alerts to managers and the engineer before lapse, and a list of
      affected planned visits on lapse
- [x] Mobile: "My qualifications" and each job's required qualifications, read only, synced
- [x] Setup guide (Markdown and HTML) updated for the migration and rollout

## Exit criteria

To confirm once the integration suites (`qualifications` in db and api) pass in CI against Postgres, and on a test company.

- [ ] Assigning a visit where nobody holds a valid required qualification shows a clear warning
      and cannot go ahead without a reason
- [ ] A certificate that expires before the visit's date counts as not valid for that visit
- [ ] Every override and its reason appear in the job history
- [ ] A lapsed certificate alerts managers and the engineer, and lists the affected visits

## Notes

- Certification enforcement is a compliance feature, not a convenience. For regulated
  trades it can be the reason a company buys.
- Moved out of this phase on 2026-10-27:
  - Working hours, leave, sickness and non-working time go to idea 6 (leave requests and
    availability). P25 already accepts work outside office hours.
  - Map view, travel time estimates and travel-time conflicts go to idea 4 (daily route
    planning).
  - Reminders to the engineer and customer before a job go to P27, which moved them again to a
    later phase.
  - Double-booking is already refused by the database (P25).
