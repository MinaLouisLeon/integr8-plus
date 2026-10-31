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
- [~] Backups verified by an actual restore drill, timed and documented
- [ ] Point-in-time recovery configured and tested
- [ ] Rate limiting tuned per endpoint against real traffic shapes
- [~] Uptime and health monitoring with alerting to a channel you actually read
- [ ] Sentry alert rules that distinguish a new error from a known one
- [ ] Performance budgets: API p95, cold start, job list render, sync duration — measured, with regression alarms
- [ ] Database indexes reviewed against real query plans; slow query log watched
- [ ] End-to-end tests on the critical paths: signup, build a form, complete a job offline, sync
- [ ] Immutable per-tenant audit log covering every meaningful action
- [ ] Dependency and secret scanning enforced in CI
- [~] Incident runbook: who is called, how to roll back, how to communicate
- [ ] Terms of service, privacy policy and a DPA published — drafted, legal review pending (see below)

Five marks need explaining, and one open box:

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
- **The terms, privacy policy and DPA are drafted, not yet publishable** (pre-production audit,
  31 October 2026, High 10). `/legal/terms`, `/legal/privacy` and `/legal/dpa` exist in English
  and Arabic, written from what the product does, and are linked from the public footer, the web
  sign-in and sign-up pages and the desktop sign-in screen; the privacy page is the address for
  the store listings. The box stays open until an Egyptian lawyer has reviewed them and the
  operator's registered details are filled in: [docs/legal](../../docs/legal/README.md) has the
  list.
- **Monitoring is `[~]`: the dashboard has a Health page**, showing phones whose sync runs
  are in trouble, billing deliveries recorded but not applied, and background work that gave
  up — the three things the October review found failing quietly. It is a screen somebody
  has to open, not an alert in a channel.
- **The restore drill is `[~]`: the tools exist, the drill has not been run** (2026-10-31).
  `deploy/vps/backup-postgres.sh` copies each nightly dump off the machine when
  `BACKUP_REMOTE` names an rclone remote (an encrypted R2 bucket in the setup guide), fails
  loudly when the copy fails, and can ping a heartbeat monitor. `deploy/vps/restore-drill.sh`
  restores the newest dump, or with `--remote` the newest off-machine copy, into a
  throwaway Postgres container with no network, checks migrations, row counts, policies and
  grants, times it, removes the container and prints a row for the rehearsal log in
  `docs/database/runbook-backup-and-restore.md`. Both were tested against a local Postgres
  with stand-ins for Docker and rclone; neither has run on the Oracle machine or the test
  box, and the rehearsal log is still empty. The bucket, the rclone remotes and the
  heartbeat are the owner's to create (setup guide, Stage 9 part B).
- **The incident runbook is `[~]`: how to roll back is written and works; who is called
  and how to communicate are not** (2026-10-31). Rolling back to the previous image no
  longer stops at `migrate`: the migrator treats applied migrations newer than every file
  in the build as `ahead-of-build`, so `up` applies nothing with a warning, `status` and the
  readiness check pass, and `down` refuses a migration it has no file for (unit and
  integration tests in `packages/db`). Setup guide Stage 11 part I and
  `docs/database/migrations.md` ("Rolling back a release") describe it. Releases up to
  v1.2.1 predate it; part Q has the workaround for going back to v1.2.1. Nobody other than
  the author has followed the procedure yet, so the exit criterion stays open.

Hardening from the pre-production audit's Medium items (2026-10-31):

- **The API and the worker no longer run as a superuser.** Their connection outside one
  company is `integr8_platform` (migration 0058, created by the migrator's bootstrap with
  BYPASSRLS): rows in every table and `purge_tenant()`, and nothing else; it owns nothing
  and cannot alter, truncate, lift a trigger or create a role. `deploy/compose.yml` names
  the settings each service gets, so the API and the worker hold neither
  `POSTGRES_PASSWORD`, `DATABASE_URL_ADMIN` nor `SUPABASE_AUTH_JWT_SECRET`; a unit test keeps
  the list and the settings the code reads in step. Production refuses to start them with
  the owner's connection or without the platform one, and checks the role at start-up. CI
  runs every suite with the platform role; the schema-invariant suite pins its grants and
  `platform-role.integration.test.ts` tries what it must not do.

## Exit criteria

- [ ] A restore from backup has been performed end to end, and the time it took is written down
- [ ] The isolation suite covers one hundred percent of endpoints, enforced by a coverage check
- [ ] An intentionally broken deploy is detected by monitoring before a human notices
- [ ] Rolling back a release is a documented procedure someone other than you could follow

## Notes

- An untested backup is not a backup. The restore drill is the single highest-value task
  in this phase.
- Write the incident runbook while calm. You will not write it during an incident.
