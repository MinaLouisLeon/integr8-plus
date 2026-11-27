# Deployment

One Oracle Cloud Always Free ARM machine (Ampere A1, 4 cores, 24 GB) runs
`deploy/compose.yml` from `/opt/integr8`, behind the server's front proxy
([vps-edge](#the-servers-front-proxy)), with its settings in
`deploy/.env`. Web at `app.integr8-media.com`, API at `api.integr8-media.com`; R2
for files, Resend for mail, Expo for push. The machine is to be shared with the
MyRooms project, which keeps its own Supabase; the two Auth containers stay
separate. A home test box (Ubuntu 24.04, Docker) checks out `staging`.

**The operator's procedure is the setup guide**,
[setup-checklist.md](./setup-checklist.md) (and the same as an interactive
`setup-checklist.html` in the Integr8 Media look): a short checklist of every
step, from an empty machine to going live, updates and starting fresh. Jobs
done rarely are below, under [Occasional procedures](#occasional-procedures). Commands on the machine run as
`docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api node dist/…`.

**The guide on GitHub Pages**, behind a username and password:
`.github/workflows/guide-pages.yml` runs when the guide reaches `main` (or by
hand) and publishes `scripts/guide/build-site.mjs`'s output. Pages has no
sign-in, so the guide (its stylesheet and script inlined) is encrypted with
AES-256-GCM under a key derived from the username and password (PBKDF2-SHA-256,
600 000 rounds); the page holds only that and a sign-in form, and the browser
decrypts it, keeping the key (not the password) for the tab. The credentials
are the repository secrets `GUIDE_USERNAME` and `GUIDE_PASSWORD`, never in the
repository; Pages' source must be "GitHub Actions". Anyone with the page can
guess passwords offline, so a long password is what protects it, and the
Markdown and HTML in the repository are as readable as the repository is.
Locally: `GUIDE_USERNAME=… GUIDE_PASSWORD=… pnpm guide:site` writes
`dist/guide-site/`.

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

## The server's front proxy

Nothing in `deploy/compose.yml` publishes a port. The machine's ports 80 and 443
belong to **one Caddy container from the separate `vps-edge` repository**
(`github.com/mihawk-solutions/vps-edge`, cloned to `/opt/vps-edge`), which gets
the certificates (here from Let's Encrypt: the two DNS records are Cloudflare
"DNS only") and sends each public name to an app's own edge container over the
Docker network `proxy`. This stack's is the `edge` service
(`deploy/edge/Caddyfile`), reached there as `integr8-edge:8080` (the public
site, `app.`) and `integr8-edge:8081` (the API, `api.`). The hostnames live in
`vps-edge` (`caddy/hosts/integr8-vps/sites/integr8.caddy`), not here: if
`app.` or `api.` changes, change `PUBLIC_API_URL` and `WEB_APP_URL` here and
that file there, together. Other apps on the machine (MyRooms, later) are their
own Compose projects behind the same proxy; none of them can reach this stack's
database, Auth or API, because only `edge` is on the shared network.

The address a request is blamed on reaches the API through three hops, each
replacing `X-Forwarded-For` with the one real address: `vps-edge`, the `edge`
service, and the API, which trusts only the `edge` connection
(`apps/api/src/http/trust-proxy.ts`). The edge must trust `vps-edge`
(`trusted_proxies`), or it rewrites the protocol to `http` and every link and
cookie is built wrong. `vps-edge`'s README ("The real-client-IP contract")
has the rule every app's edge follows.

## Security headers

The `edge` service (`deploy/edge/Caddyfile`) sends HSTS for a year (no
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
schema fits the build) are for the machine only. The API publishes no port, so
they are asked from inside its container: `bash deploy/vps/ready.sh` prints the
answer and exits 0 when ready, and `deploy/vps/heartbeat.sh`, from root's cron
every five minutes, runs it and calls `HEALTH_PING_URL` (or it with `/fail`), so
the outside monitor alerts on failure and on silence.

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
   A company set to publish in its own stores also gets a store build sent to
   its own Google Play and App Store accounts (below).
4. With `APP_BUILDS=github` (and `GITHUB_BUILD_TOKEN`, a fine-grained token with
   Actions read and write, and `GITHUB_BUILD_REPOSITORY`), ticking the box and
   **Rebuild apps** start builds from the dashboard; with `off` (the default) run
   **Build company apps** by hand from GitHub Actions on `main`. Test companies
   get no apps.

One Expo account and project (EAS slug always `integr8-plus`) and one Firebase
project (an Android app per company) serve every company
([apps/mobile.md](../apps/mobile.md#a-companys-own-build)). Desktop apps update
themselves from `app.integr8-media.com/desktop-updates`; the updater and the
invitation page's installer list need `GITHUB_RELEASES_TOKEN` because the
repository is private. Builds
are unsigned until certificates are bought: Windows shows SmartScreen, macOS
needs right-click → Open, Linux and macOS downloads need `chmod +x`.

## Occasional procedures

Taken out of the setup guide in its short rewrite (the long edition is in git
history before that commit). Every command runs on the machine from
`/opt/integr8`; `dc` below stands for
`docker compose -f deploy/compose.yml --env-file deploy/.env`.

### Changing the HR key

The server seals with `HR_DATA_KEY` and still opens what the keys in
`HR_DATA_KEYS_PREVIOUS` sealed. Change it if it may have been seen, or on a
schedule.

1. Make a new key (setup guide, Stage 1). In the password manager save it as
   current with today's date; relabel the old one "retired", never delete it.
2. Back up (`sudo deploy/vps/backup-postgres.sh`).
3. In `deploy/.env`: the old value into `HR_DATA_KEYS_PREVIOUS=` (first, comma
   before any already there), the new one after `HR_DATA_KEY=`; `dc up -d`.
4. Re-seal: `dc run --rm api node dist/platform/admin-cli.js hr-reseal`
   (add a company id to try one first). It ends with "HR_DATA_KEYS_PREVIOUS can
   be emptied"; a "No key opens" count means a key missing from both lines.
5. Open an employee with an ID number and **Show** it; then empty
   `HR_DATA_KEYS_PREVIOUS=` and `dc up -d`. Keep the retired key as long as
   backups older than today exist: restoring one needs it back, then a re-seal.

### Moving a company to another server

One company's rows, files and sign-in accounts (with password hashes, so
everyone keeps their password) to a server on the same release or newer. The
archive is a credential: delete it once the move is done.

```bash
# old server
sudo install -d -o 1000 -g 1000 -m 700 deploy/transfers
dc --profile tools run --rm transfer node dist/transfer/cli.js export SLUG --out /transfers/SLUG.tar.gz
# copy deploy/transfers/SLUG.tar.gz to the same folder on the new server (owner 1000:1000), then there:
dc --profile tools run --rm transfer node dist/transfer/cli.js inspect /transfers/SLUG.tar.gz
dc --profile tools run --rm transfer node dist/transfer/cli.js import /transfers/SLUG.tar.gz
```

If the import stops after the rows, run it again with `--continue`. Check a
person signs in with their old password and a job opens with its photos; then
`shred -u` the archive on both servers and the laptop, and close the company on
the old server (Suspend, Export their data, Close this company).

### Code signing

Optional; updates work without it. Each set is used only when all its secrets
exist.

- **Windows, Azure Artifact Signing** (about $10 a month, check Integr8 Media is
  eligible): secrets `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID`;
  variables `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`,
  `AZURE_SIGNING_PROFILE`. Or a `.pfx` certificate: `WINDOWS_CERTIFICATE`
  (base64) and `WINDOWS_CERTIFICATE_PASSWORD`.
- **macOS, a Developer ID Application certificate** (Apple Developer Program as
  an organisation): `APPLE_CERTIFICATE` (the `.p12` as base64),
  `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`; notarisation with
  `ASC_API_KEY`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, or `APPLE_ID`, `APPLE_PASSWORD`,
  `APPLE_TEAM_ID`.

The release's "Stamp" step prints which signing it used.

### The app stores (0023)

Each company's phone app reaches its people one of two ways, chosen on its page
in the staff app under **Phone app distribution**:

- **APK sent by Integr8** (the default): each release makes an installable
  `.apk`; staff send it from the company page's **Installers**. iPhones are not
  covered this way.
- **The company's own Google Play and App Store accounts**: each release makes a
  store build and submits it to the company's own accounts, on the Google Play
  track chosen there (internal testing first, then public release, released
  at once; Google still reviews it). For iPhone, Expo uploads the build to App
  Store Connect; sending it to Apple's review is a button there. Update in the
  phone app then opens the company's store page.

Expo stays Integr8's, and the apps keep their identifiers
(`com.integr8.plus.<slug>`), so phones that installed the APK update from Google
Play once the company publishes there, provided the Play listing is signed with
the key Expo already uses ("Use existing app signing key" in Play App Signing).
The store keys are not in GitHub: each company's Google Play service-account key
and App Store Connect API key are uploaded to Expo for that app with
`eas credentials`, and `eas submit` finds them by the app's identifiers. The
setup guide's Stage 8 has the steps, including the **store reviewer account**
(an engineer with one sample job, holding no seat) for each store's "App
access" form. Template apps may need to go out as unlisted apps (Apple
guideline 4.2.6). With several companies, move Expo to its Production plan.

### The test box

A home Ubuntu 24.04 machine with Docker runs the same stack from `staging`:
its own generated secrets (never production's), every stand-in on
(`MEDIA_STORAGE=local`, `GEOCODER=fake`, `PUSH_SENDER=recording`,
`EMAIL_SENDER=recording`), the names `test.` and `api-test.` served by a
Cloudflare Tunnel (`cloudflare/cloudflared` with `--network host`) instead of
the front proxy, which it does not run: it starts the stack with
`-f deploy/compose.yml -f deploy/compose.test.yml`, whose only job is to publish
the API and the web app on `127.0.0.1:3000` and `:3001` for the tunnel (or an
SSH tunnel). Docker's `proxy` network must exist there too
(`docker network create proxy`, or vps-edge's `setup-host.sh --no-firewall`),
because the compose file declares it. Update it with `git pull` and
`dc -f deploy/compose.test.yml up -d --build`; `down -v` gives a clean
database. Try it with the development desktop build:
`VITE_API_BASE_URL=https://api-test.integr8-media.com pnpm --filter @integr8/desktop dev`
(and `http://localhost:3002` in its `API_CORS_ORIGINS`).

A test machine on Proxmox filled with made-up volume, to find slow queries
(`db:volume`, `pg_stat_statements`, `db:plans`), is setup guide Stage 12.

## Not done yet

A restore rehearsed on the real machine, code-signed desktop builds,
store-signed phone builds, the R2 test secrets in CI, and the owner's steps in
[the plan](../../plan/README.md#owner-steps).
