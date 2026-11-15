# Deployment

One Oracle Cloud Always Free ARM machine (Ampere A1, 4 cores, 24 GB) runs
`deploy/compose.yml` from `/opt/integr8`, behind Caddy, with its settings in
`deploy/.env`. Web at `app.integr8-media.com`, API at `api.integr8-media.com`; R2
for files, Resend for mail, Expo for push. The machine is to be shared with the
MyRooms project, which keeps its own Supabase; the two Auth containers stay
separate. A home test box (Ubuntu 24.04, Docker) checks out `staging`.

**The operator's procedure is the setup guide**,
[setup-checklist.md](./setup-checklist.md) (and the same as an interactive
`setup-checklist.html`): every stage, part and tick box, from an empty machine
to updates and recovery. Commands on the machine run as
`docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api node dist/…`.

## The services

| Service     | Image                          | Does                                                                                                         | Memory |
| ----------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------ |
| `postgres`  | `postgres:16`                  | The database; `pg_stat_statements` and `auto_explain` (plans over 500 ms)                                    | 1 GB   |
| `bootstrap` | the API image                  | Creates the roles and Auth's schema, resets their passwords, on every start                                  | 512 MB |
| `migrate`   | the API image                  | Applies migrations; refuses a 1.x database                                                                   | 512 MB |
| `auth`      | `supabase/auth:v2.197.0`       | Passwords and sign-in codes; no published port                                                               | 256 MB |
| `api`       | built on the machine           | `/v1` on port 3000; Chromium for PDF previews                                                                | 1 GB   |
| `worker`    | the API image                  | Jobs and scheduled tasks; Chromium for documents                                                             | 1.5 GB |
| `transfer`  | the API image, profile `tools` | Moving a company between servers; the only service with both the owner's database URL and the API's settings | 1 GB   |
| `web`       | built on the machine           | Next.js on port 3001                                                                                         | 768 MB |

Start order: `postgres` → `bootstrap` → `migrate` and `auth` → `api` and `worker`
(wait for Auth's health) → `web`. Each service gets only the settings it reads
(`x-api-env` in compose; `apps/api/src/compose-env.test.ts` fails when the API
reads one compose does not pass). The API and worker never get
`POSTGRES_PASSWORD`, `DATABASE_URL_ADMIN`, a role password or the Auth JWT secret;
they connect as `integr8_app`, `integr8_auth` and `integr8_platform`
([database/](../database/README.md#the-roles)). GitHub publishes no images: every
machine builds its own with `--build`.

## Settings

`deploy/.env.example` lists every setting for a whole deployment; each app's
`config.ts` documents what it reads. `APP_ENV` decides how strict start-up is:

- **`staging`**: production-shaped, stand-ins allowed (local files, recording
  mail and billing, fake geocoder). Logs what production would refuse.
- **`production`**: refuses to start without Sentry, R2, Mapbox, Expo push,
  mail, `WEB_APP_URL`, `API_CORS_ORIGINS` and `API_RELEASE`, on any stand-in, and
  on example values (`change-me`, `.example` hosts, public `.local` addresses,
  database passwords under 16 characters). Each refusal names the setting, never
  the value. `sh deploy/vps/check-env.sh` lists the offenders by name.

Keys that must be kept with the backups, because data sealed with them is
unreadable without them: `HR_DATA_KEY` (and `HR_DATA_KEYS_PREVIOUS`),
`ETA_CREDENTIALS_KEY`, `PLATFORM_SECRET_KEY`, the auth signing keys.

## Security headers

Caddy (`deploy/vps/Caddyfile.example`) sends HSTS for a year (no
`includeSubDomains`, no preload), and on the API `nosniff`, `Referrer-Policy:
no-referrer`, `X-Frame-Options: DENY`; it answers 404 for `/health*` on the
public name. The public site sets its own (`apps/web/src/lib/content-security-policy.ts`):
an enforced `frame-ancestors 'none'` and a full Content Security Policy in
**report-only** mode (to the API, R2 and Sentry), reported to Sentry when
`NEXT_PUBLIC_SENTRY_DSN` is set, to be enforced once reports are quiet. The
desktop app's policy is in `apps/desktop/src-tauri/tauri.conf.json`, enforced by
Tauri, with the API origin stamped in per build.

## Health and the heartbeat

`/health` (the process runs) and `/health/ready` (the database answers and the
schema fits the build) are for the machine only. `deploy/vps/heartbeat.sh` runs
from root's cron every five minutes, asks `/health/ready` locally, and calls
`HEALTH_PING_URL` (or it with `/fail`), so the outside monitor alerts on failure
and on silence.

## Backups

`deploy/vps/backup-postgres.sh` dumps the whole database (the `auth` schema
included) nightly and copies it off the machine with rclone to `BACKUP_REMOTE`;
`deploy/vps/restore-drill.sh` rehearses a restore. The procedure is
[database/runbook-backup-and-restore.md](../database/runbook-backup-and-restore.md).

## Releasing a version

The version is the root `package.json` `version` only (the phone and web read
it; `apps/api/src/app-info.ts` keeps a copy a test holds equal; the setup guide
and `deploy/.env.example` state it). The flow is `dev` → `staging` → `main`
([contributing/](../contributing/README.md)).

1. Bump the version in the pull request that promotes `staging` to `main`.
   `release-main.yml` refuses `0.0.0` and a version already released.
2. Merge to `staging`: nothing runs on GitHub; the test box builds it.
3. Merge to `main`: `release-main.yml` checks, builds the release's files (API
   and web archives, staff desktop installers, Forms for AI executables) and
   company apps, and publishes the release.
4. On the machine: check out the tag, `docker compose up -d --build`. `migrate`
   runs first; the API's readiness refuses traffic until the schema fits.
5. Rolling back: check out the previous tag and build. Its `migrate` finds newer
   migrations applied, applies nothing and exits cleanly (`ahead-of-build`); the
   expand/contract rule keeps that safe. A migration is rolled back only on
   purpose, by the release that added it (`… migrator/cli.js down --steps 1`).

Set the repository variable `DESKTOP_BUILDS=disabled` while no code-signing
certificates exist, to save runner minutes.

## Company apps

Every company gets its own desktop installers and phone app (its name, icon,
colours, `com.integr8.plus.<slug>`); a company app's sign-in sends its slug and
the API answers 403 `wrong_company` to anyone from another company. Integr8's own
people use the **staff** desktop build. There is no staff phone app.

1. Onboard the company; in the staff desktop app set its branding (logo, a square
   app icon of at least 512 × 512, accent and menu colours, theme, website).
2. On its dashboard page tick **Build apps for this company**: it joins
   `GET /v1/build/companies` (read by CI with `BUILD_TOKEN`), and every version
   release builds it.
3. A build: `build-company-apps.yml` reads the public brand endpoint, stamps the
   desktop (`apps/desktop/scripts/stamp.mjs`, then `tauri build` for Windows,
   macOS, Linux) and the phone (`company.json`, `eas build --channel
production-<slug>`), and publishes the release `company-<slug>-v<version>`.
   `STORE_SUBMIT=enabled` also submits to the Play internal track and the App
   Store.
4. With `APP_BUILDS=github` (and `GITHUB_BUILD_TOKEN`, a fine-grained token with
   Actions read and write, and `GITHUB_BUILD_REPOSITORY`), ticking the box and
   **Rebuild apps** start builds from the dashboard; with `off` (the default) run
   **Build company apps** by hand from GitHub Actions on `main`. Test companies
   get no apps.

One Expo account and project (EAS slug always `integr8-plus`) and one Firebase
project (an Android app per company) serve every company
([apps/mobile.md](../apps/mobile.md#a-companys-own-build)). Desktop apps update
themselves from `app.integr8-media.com/desktop-updates`; `/download` and the
updater need `GITHUB_RELEASES_TOKEN` because the repository is private. Builds
are unsigned until certificates are bought: Windows shows SmartScreen, macOS
needs right-click → Open, Linux and macOS downloads need `chmod +x`.

## Not done yet

A restore rehearsed on the real machine, code-signed desktop builds,
store-signed phone builds, the R2 test secrets in CI, and the owner's steps in
[the plan](../../plan/README.md#owner-steps).
