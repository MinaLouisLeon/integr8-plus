# Deploying Integr8 Plus

How to run a production-shaped stack: for testing first, then for a customer.
What ships is two container images, a database and a sign-in server, all on
one machine; everything else is configuration.

**Following along?** [The setup checklist](./setup-checklist.md) walks every
step in order, from creating the accounts and keys to a running stack, going
live, updating, and wiping or rebuilding the machine. The same guide is a page
with tick boxes that remember your progress: download
[`setup-checklist.html`](./setup-checklist.html), `setup-checklist.css` and
`setup-checklist.js` into one folder and open the `.html` in a browser.

```
                      ┌──────────────────────────┐
  browsers ──TLS────▶ │ reverse proxy (Caddy/LB) │
  phones  ──TLS────▶  └──────┬───────────┬───────┘
                             │           │
                     app.example.com   api.example.com
                             │           │
                      ┌──────▼──────┐ ┌──▼─────────────┐    ┌─────────────────┐
                      │  web image  │ │   api image    │    │   api image     │
                      │  Next.js    │ │   Fastify      │    │   worker        │
                      └──────┬──────┘ └──┬─────────────┘    └──┬──────────────┘
                             │ API_BASE_URL │                  │
                             └──────────────┴────────┬─────────┘
                                                     ▼
                                      Postgres  ·  Supabase Auth (http://auth:9999)
                                      ── both in the compose stack, no published port ──
                                      R2 · Stripe · Resend · Mapbox · Expo · Sentry
```

| Piece                  | Where                                       | Notes                                                                   |
| ---------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| API image              | `apps/api/Dockerfile`                       | Also the worker (`node dist/jobs/worker-main.js`) and the migrator      |
| Web image              | `apps/web/Dockerfile`                       | Next.js standalone server; `NEXT_PUBLIC_*` baked in at build time       |
| Compose stack          | `deploy/compose.yml`, `deploy/.env.example` | Postgres + bootstrap + migrate + auth + api + worker + web, one machine |
| Machine preparation    | `deploy/vps/setup.sh`, `Caddyfile.example`  | Firewall, Docker and Caddy on a fresh Ubuntu or Oracle Linux machine    |
| Images in the registry | `.github/workflows/publish-images.yml`      | `ghcr.io/<owner>/integr8-api` and `integr8-web`: `vX.Y.Z` per release   |
| Database runbooks      | `docs/database/`                            | Migrations, nightly backups and restore                                 |
| Sign-in server         | `docs/auth/self-hosted-auth.md`             | The Supabase Auth container: settings, secrets, rotation                |
| Company apps           | `docs/deployment/company-apps.md`           | Installers and phone apps built per company, and the staff desktop      |

## Two modes

`APP_ENV` decides how strict the API is at startup (`assertProductionReady` in
`apps/api/src/config.ts`):

- **`staging`** — a production-shaped stack where the fakes are allowed: local
  media storage, the recording billing and email providers, the fake geocoder.
  Nothing leaves the machine, sign-in included: the Auth container is part of
  the stack. **Start here.**
- **`production`** — the API refuses to start unless Sentry, R2, Mapbox, Expo
  push, Stripe, Resend, `WEB_APP_URL`, `API_CORS_ORIGINS` and `API_RELEASE` are
  all configured. The refusal lists exactly what is missing.

## First deployment, step by step

1. **A machine with Docker** (2 vCPU, 4 GB is plenty for testing) and two DNS
   names pointing at it: `app.` for the web app and `api.` for the API. Put a
   reverse proxy with TLS in front (Caddy does this in four lines; any load
   balancer works). The API must be reachable from phones, so it needs its own
   public hostname. On a fresh Ubuntu or Oracle Linux machine,
   `deploy/vps/setup.sh` opens the firewall, installs Docker and Caddy, and
   `deploy/vps/Caddyfile.example` is the proxy configuration; see **Oracle
   Cloud** below for the free machine this was written against.
2. **Configuration.** `cp deploy/.env.example deploy/.env`, then:
   - set the three addresses and `API_CORS_ORIGINS`;
   - set three database passwords (the compose Postgres is created from them);
   - run `pnpm --filter @integr8/auth keygen` once and paste what it prints:
     the four signing-key lines, and the three for the Auth container
     (`SUPABASE_AUTH_JWT_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`,
     `SUPABASE_AUTH_DB_PASSWORD`). There is no Supabase project to create;
   - leave the fakes (`MEDIA_STORAGE=local`, `BILLING_PROVIDER=recording`,
     `EMAIL_SENDER=recording`, `GEOCODER=fake`, `PUSH_SENDER=recording`) for the
     first run.
3. **Start it.**
   ```bash
   docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
   docker compose -f deploy/compose.yml --env-file deploy/.env logs -f migrate api
   ```
   On an ARM machine the same command builds ARM images; nothing changes.
   `bootstrap` creates the roles and Auth's schema, `migrate` applies ours and
   `auth` migrates its own, then the API answers `GET /health/ready` with
   `status: ready` and the web app starts. `docker compose ps` shows `auth`
   healthy. The API and web ports are bound to `127.0.0.1`: only the proxy on
   the same machine reaches them.
4. **Create the first super admin.** The dashboard has no self-service signup,
   so the API image carries a small command for it:
   ```bash
   docker compose -f deploy/compose.yml --env-file deploy/.env \
     run --rm api node dist/platform/admin-cli.js create you@your-domain.example "Your Name"
   ```
   It prints a generated password and the authenticator secret (as an
   `otpauth://` URI to turn into a QR code) exactly once. Sign in at
   `/platform/sign-in`, then change the password. An account made this way is
   a staff manager: it can add and remove colleagues on the dashboard's
   **Staff** page, and the people it adds cannot. `docs/platform/README.md`
   covers what a super admin can do.
5. **Walk the path a customer walks.** `/sign-up` → verification link (with the
   recording email sender it is in the API log, not an inbox) → first-run
   checklist → build a form on the desktop app → dispatch a job → complete it
   on a phone → see it in the office. The platform dashboard's **Health** page
   shows sync trouble, billing deliveries and failed background work.
6. **Then turn the services real, one at a time**, restarting the API and
   worker after each: R2 (`MEDIA_STORAGE=r2`), Resend, Mapbox, Expo push,
   Stripe (`BILLING_PROVIDER=stripe`, point the Stripe webhook at
   `https://api.../v1/billing/webhook`), Sentry. Finally `APP_ENV=production`,
   which makes the API refuse to start if any of them is missing.

## Oracle Cloud Always Free, the machine this was first run on

Oracle's Always Free tier includes an ARM machine (shape `VM.Standard.A1.Flex`,
up to 4 OCPUs and 24 GB RAM, 200 GB of block storage) that never expires. It
runs the compose stack as is. Three things are specific to it:

- **ARM.** The images `publish-images.yml` pushes are built for both
  `linux/amd64` and `linux/arm64`, so `docker compose pull` works there;
  building on the machine with `up -d --build` also works and is the simplest
  path for a first deployment (allow ten to fifteen minutes).
- **Two firewalls.** The console's security list (VCN → subnet → Default
  Security List) must have ingress rules for TCP 80 and 443, _and_ the Ubuntu
  image's own iptables rules must allow them. `setup.sh` does the second
  part; the console cannot.
- **Capacity and idling.** ARM capacity in busy regions is often exhausted
  ("Out of host capacity"); retrying later, or asking for 2 OCPUs and 12 GB,
  usually works. Oracle also reclaims idle Always Free instances on tenancies
  that have not been upgraded to Pay As You Go; upgrading keeps the free
  resources free and removes both limits, at the cost of being charged if you
  create something that is not in the free tier.

The step-by-step version, from account creation to the first sign-up, is the
setup checklist shared alongside this repository; this README is the reference
it points back to.

## Sharing the machine with another product

The VPS also runs MyRooms, with its own full Supabase stack. The two stay
apart:

- **Separate Auth containers.** MyRooms' Supabase includes an Auth of the same
  version; Integr8 Plus still runs its own, because one shared Auth would mix
  two products' users.
- **No public ports.** The API and web are published on `127.0.0.1` only, as
  MyRooms' are. Ports Docker publishes go round Ubuntu's firewall, so binding
  to every address would expose them however the firewall is set. Caddy
  proxies to `localhost`; Postgres and Auth publish nothing at all.
- **Memory caps.** Each container has a `mem_limit` in `deploy/compose.yml`
  (Postgres 1 GB, API 768 MB, worker 1.5 GB for Chromium, web 768 MB, Auth
  256 MB, the one-off bootstrap and migrate 512 MB): starting values, to tune
  from `docker stats`, so one product cannot starve the other.

## Backups, before any real data

The compose Postgres is one volume on one disk, and it holds everything:
company data and, in its `auth` schema, every sign-in account.
`deploy/vps/backup-postgres.sh` dumps the whole database nightly from root's
cron and keeps the last fourteen files under `/var/backups/integr8`;
[the backup and restore runbook](../database/runbook-backup-and-restore.md)
has the schedule, the checks and the restore. That covers a bad migration or a
deleted company. Losing the machine needs a copy elsewhere, set up before a
paying customer's data exists: with `BACKUP_REMOTE` in `deploy/.env` (an rclone
remote, recommended an R2 bucket of its own behind rclone's encrypting `crypt`
layer), the script copies each dump there and keeps the newest
`BACKUP_REMOTE_KEEP` (30). A copy that fails makes the run fail with an `ERROR`
line, and `BACKUP_PING_URL` tells a heartbeat monitor about every night, good
or bad. Without `BACKUP_REMOTE` each run says the dump is on this machine only.
A boot-volume backup policy in the Oracle console is a useful second layer
(check the schedule the console shows for it), but it stays in the same
account as the machine.

`deploy/vps/restore-drill.sh` proves a dump restores without going near the
live database: it loads the newest dump, or with `--remote` the newest
off-machine copy, into a throwaway Postgres container with no network, checks
the migrations, row counts, policies and grants that came back, times it,
removes the container and prints a row for the runbook's rehearsal log. Run it
monthly; the runbook also has the six-monthly full rehearsal on the test box.

Container logs are capped at 50 MB per container by the `x-logging` block in
`deploy/compose.yml`, so a chatty week cannot fill the disk.

## Releasing a new version

0. **Bump the version** in the root `package.json` in the pull request that
   promotes `staging` to `main`. `release-main.yml` refuses `0.0.0` and refuses
   a version that already has a release, so a merge into `main` without a bump
   fails its release job (the `:main` images still publish; no release images
   do). The version also stamps `APP_VERSION`/`API_RELEASE` in a deployment's
   env file. Until signed desktop
   installers are wanted (P20), set the repository variable
   `DESKTOP_BUILDS=disabled` so the release does not spend macOS and Windows
   runner minutes on unsigned builds.
1. Merge to `staging`. `publish-images.yml` pushes `integr8-api:staging` and
   `integr8-web:staging`, which the test box runs. They, `:main` and the
   per-commit tags move with unreleased code and are never for production.
2. Merge to `main`. Once the release is published, `release-main.yml` calls
   `publish-images.yml` with the release tag: `integr8-api:vX.Y.Z` and
   `integr8-web:vX.Y.Z` for amd64 and arm64, and `latest`, which only ever
   names the newest release. (A tag the release creates with `github.token`
   cannot start the `v*` trigger itself, which is why it is called.) To build
   the images of a release that already exists, run "Publish images" from the
   Actions tab with its tag.
3. On the machine: set `API_IMAGE`/`WEB_IMAGE` in `deploy/.env` to the new
   release tag, then `docker compose pull && docker compose up -d`. `migrate`
   runs first; the API's readiness check refuses traffic until the schema
   matches the build.
4. Roll back by setting the previous release's tag and running the same two
   commands (release images exist from v1.2.2; an older release is gone back
   to by checking out its tag and building). The previous image's `migrate` finds the newer release's migrations already
   applied, applies nothing, logs that the database is ahead of its build and
   exits cleanly; its readiness check passes with a note naming them. So the
   API, worker and web start on the newer schema, which expand/contract
   ([migrations.md](../database/migrations.md#rolling-back-a-release)) keeps
   safe. Releases up to v1.2.1 predate this and stop at `migrate`: the setup
   guide's Stage 11, part Q, has the way round it.
5. Migrations are rolled back deliberately, never automatically, and only by
   the release that added them, because only its image has their down files:
   with the newer tag still set, after reading the migration's down file,
   `docker compose run --rm api node node_modules/@integr8/db/dist/migrator/cli.js down --steps 1`,
   then set the previous tag. The previous image refuses to roll back a
   migration it has no file for.

## What is not here yet

A restore rehearsed on the real machine (the drill script and the steps are in
`docs/database/runbook-backup-and-restore.md`; nobody has run them there yet),
uptime monitoring and alerting, signed desktop and mobile builds (P20), and
the rest of P19. The compose stack is a first production for testing, not the
final shape.
