# P15 — Super admin dashboard

**Version:** v1.0 Launch
**Status:** `NOT STARTED`
**Depends on:** P03, P10

## Goal

You can run the business: see every company, onboard one, support one, and suspend one,
without opening a terminal.

## Scope

Your dashboard, inside the Next.js app on a separately authorised route.

## Tasks

- [ ] Company directory: status, plan, seats, storage used, created date, last activity
- [ ] Onboard a company in one action — create tenant, seed roles and job types, create the R2 bucket, send the owner invite
- [ ] Suspend, reactivate and delete, with deletion forcing an export first
- [ ] Impersonation UI: reason prompt, time limit, persistent banner while active, one-click exit
- [ ] Platform audit log, searchable, immutable, showing every super admin action
- [ ] Per-company activity: active users, jobs per month, submissions, API calls
- [ ] Feature flags per company
- [ ] Global announcement banner pushed to desktop, mobile and web
- [ ] Global form template library management
- [ ] Support toolkit: recent errors for a company, resend invite, reset MFA, unlock account, clear a stuck sync queue
- [ ] Release view: which desktop and mobile versions are live in the field
- [ ] Company data export and hard delete

## Exit criteria

- [ ] A new company is onboarded end to end through the UI, with no manual database or Cloudflare step
- [ ] Every impersonation session appears in the audit log with its reason and duration
- [ ] Suspending a company puts all three of their apps into read-only within one minute
- [ ] Deleting a company removes their database rows and their bucket, verified in Cloudflare

## Notes

- The impersonation banner must be impossible to miss. Support engineers who forget they
  are impersonating cause the worst incidents.
- Onboarding automation is not a convenience. Any manual step becomes the bottleneck the
  moment you have ten customers.
