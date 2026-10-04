# P19 — Production hardening

**Version:** v1.0 Launch
**Status:** `IN PROGRESS — the groundwork: suites in CI, images, a compose stack, a health screen`
**Depends on:** P16

## Goal

The product can be trusted with a real company's operations, and you will find out about
problems before they do.

## Scope

Everything invisible to customers that determines whether the product survives its second year.

## Tasks

- [~] Tenant isolation suite expanded to cover every endpoint added since P02, running on every pull request
- [~] Staging environment mirroring production, with a seeded demo tenant that also serves App Store review
- [ ] Backups verified by an actual restore drill, timed and documented
- [ ] Point-in-time recovery configured and tested
- [ ] Rate limiting tuned per endpoint against real traffic shapes
- [~] Uptime and health monitoring with alerting to a channel you actually read
- [ ] Sentry alert rules that distinguish a new error from a known one
- [ ] Performance budgets: API p95, cold start, job list render, sync duration — measured, with regression alarms
- [ ] Database indexes reviewed against real query plans; slow query log watched
- [ ] End-to-end tests on the critical paths: signup, build a form, complete a job offline, sync
- [ ] Immutable per-tenant audit log covering every meaningful action
- [ ] Dependency and secret scanning enforced in CI
- [ ] Incident runbook: who is called, how to roll back, how to communicate
- [ ] Terms of service, privacy policy and a DPA published

Three marks need explaining:

- **The isolation suite is `[~]`: it runs on every pull request now, but has not been
  expanded.** The `database` job in `ci.yml` and `verify.yml` runs the db, auth and API
  integration suites against a Postgres 16 service container, so the suite that had only
  ever run on a laptop runs on every change. Coverage of every endpoint, and the check that
  enforces it, are still to do.
- **Staging is `[~]`: the shape exists, the environment does not.** `apps/api/Dockerfile`
  (also the worker and the migrator), `apps/web/Dockerfile`, `deploy/compose.yml` with its
  env template, `publish-images.yml` pushing both images to GHCR, and
  `docs/deployment/README.md` describing the first production-for-testing stack. A
  super admin can be created from the image (`admin-cli`), which nothing outside the
  development seed could do before. Nobody has run it on a machine yet.
- **Monitoring is `[~]`: the dashboard has a Health page**, showing phones whose sync runs
  are in trouble, billing deliveries recorded but not applied, and background work that gave
  up — the three things the October review found failing quietly. It is a screen somebody
  has to open, not an alert in a channel.

## Exit criteria

- [ ] A restore from backup has been performed end to end, and the time it took is written down
- [ ] The isolation suite covers one hundred percent of endpoints, enforced by a coverage check
- [ ] An intentionally broken deploy is detected by monitoring before a human notices
- [ ] Rolling back a release is a documented procedure someone other than you could follow

## Notes

- An untested backup is not a backup. The restore drill is the single highest-value task
  in this phase.
- Write the incident runbook while calm. You will not write it during an incident.
