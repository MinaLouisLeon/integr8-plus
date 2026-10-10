# Deploying Integr8 Plus

How to run a production-shaped stack: for testing first, then for a customer.
What ships is two container images and a database; everything else is
configuration.

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
                                      Postgres (compose, then Supabase)
                                      Supabase Auth · R2 · Stripe · Resend · Mapbox · Expo · Sentry
```

| Piece                  | Where                                       | Notes                                                                  |
| ---------------------- | ------------------------------------------- | ---------------------------------------------------------------------- |
| API image              | `apps/api/Dockerfile`                       | Also the worker (`node dist/jobs/worker-main.js`) and the migrator     |
| Web image              | `apps/web/Dockerfile`                       | Next.js standalone server; `NEXT_PUBLIC_*` baked in at build time      |
| Compose stack          | `deploy/compose.yml`, `deploy/.env.example` | Postgres + bootstrap + migrate + api + worker + web, on one machine    |
| Railway services       | `deploy/railway/*.json`                     | The same three processes as managed services, no machine; see below    |
| Machine preparation    | `deploy/vps/setup.sh`, `Caddyfile.example`  | Firewall, Docker and Caddy on a fresh Ubuntu or Oracle Linux machine   |
| Images in the registry | `.github/workflows/publish-images.yml`      | `ghcr.io/<owner>/integr8-api` and `integr8-web`, tagged per branch/sha |
| Database runbooks      | `docs/database/`                            | Supabase setup, migrations, backup and restore                         |
| Company apps           | `docs/deployment/company-apps.md`           | Installers and phone apps built per company, and the staff desktop     |

## Two modes

`APP_ENV` decides how strict the API is at startup (`assertProductionReady` in
`apps/api/src/config.ts`):

- **`staging`** — a production-shaped stack where the fakes are allowed: local
  media storage, the recording billing and email providers, the fake geocoder.
  Nothing leaves the machine. Sign-in still needs a real Supabase Auth project,
  because there is no fake identity provider outside the tests. **Start here.**
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
2. **A Supabase project for identity.** Only Auth is used at this stage. Copy
   `SUPABASE_URL` and the service role key. Later the same project (or another)
   provides the database; see the runbook.
3. **Configuration.** `cp deploy/.env.example deploy/.env`, then:
   - set the three addresses and `API_CORS_ORIGINS`;
   - set three database passwords (the compose Postgres is created from them);
   - run `pnpm --filter @integr8/auth keygen` once and paste the four lines;
   - set the Supabase values;
   - leave the fakes (`MEDIA_STORAGE=local`, `BILLING_PROVIDER=recording`,
     `EMAIL_SENDER=recording`, `GEOCODER=fake`, `PUSH_SENDER=recording`) for the
     first run.
4. **Start it.**
   ```bash
   docker compose -f deploy/compose.yml --env-file deploy/.env up -d --build
   docker compose -f deploy/compose.yml --env-file deploy/.env logs -f migrate api
   ```
   On an ARM machine the same command builds ARM images; nothing changes.
   `bootstrap` creates the roles, `migrate` applies the schema, then the API
   answers `GET /health/ready` with `status: ready` and the web app starts.
5. **Create the first super admin.** The dashboard has no self-service signup,
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
6. **Walk the path a customer walks.** `/sign-up` → verification link (with the
   recording email sender it is in the API log, not an inbox) → first-run
   checklist → build a form on the desktop app → dispatch a job → complete it
   on a phone → see it in the office. The platform dashboard's **Health** page
   shows sync trouble, billing deliveries and failed background work.
7. **Then turn the services real, one at a time**, restarting the API and
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

## Running it on Railway instead of a machine

The compose stack needs a server, Docker and a reverse proxy. Railway runs the
same two images as managed services and takes care of the machine, TLS and
restarts. This is the shape for someone who would rather not operate a server:

```
  browsers/phones ──TLS──▶ web.up.railway.app      api.up.railway.app
                                  │ API_BASE_URL          │
                           ┌──────▼──────┐     ┌──────────▼───────┐    ┌───────────────┐
                           │  web        │     │  api             │    │  worker       │
                           │  web.json   │     │  api.json        │    │  worker.json  │
                           └─────────────┘     └──┬───────────────┘    └──┬────────────┘
                                                  │   pre-deploy: migrator deploy
                                                  ▼
                                      Railway Postgres (then Supabase)
```

1. **A project with a Postgres database.** Railway → New Project → Deploy
   PostgreSQL. It exposes `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGDATABASE` and
   the rest as variables other services can reference.
2. **Three services from this repository.** For each: New → GitHub Repo →
   this repository, then Settings → **Config-as-code** → the matching file:
   `deploy/railway/api.json`, `deploy/railway/worker.json`,
   `deploy/railway/web.json`. The file sets the Dockerfile, the start command,
   the health check and, for the API, the pre-deploy command that runs
   `migrator deploy` (roles, then migrations) before a new build takes traffic.
   The API and the web service each need a public domain (Settings →
   Networking → Generate Domain; the API listens on 3000, the web app on 3001).
3. **Variables.** The API and the worker take the same set, `deploy/.env.example`
   minus the compose-only lines (`POSTGRES_PASSWORD`, `API_PORT`, `WEB_PORT`,
   `PUBLIC_API_URL`, `API_IMAGE`, `WEB_IMAGE`). The database strings reference
   the Postgres service:

   ```
   DATABASE_URL_ADMIN=${{Postgres.DATABASE_URL}}
   DATABASE_URL=postgresql://integr8_app:APP_PASSWORD@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}
   DATABASE_URL_AUTH=postgresql://integr8_auth:AUTH_PASSWORD@${{Postgres.PGHOST}}:${{Postgres.PGPORT}}/${{Postgres.PGDATABASE}}
   ```

   The web service takes `NEXT_PUBLIC_API_BASE_URL` (the API's public URL; a
   build argument, so set it before the first build), `API_BASE_URL` (the same
   URL), `APP_ENV`, `NEXT_PUBLIC_APP_ENV` and `PORT=3001`. Changing a variable
   redeploys the service.

4. **One-off commands** (the super admin, storage provisioning) run inside the
   API service with the Railway CLI: `railway ssh --service api`, then
   `node dist/platform/admin-cli.js create you@example.com "Your Name"`.
5. **Releases** are pushes to the branch each service is connected to. Pick
   `main` for all three; Railway builds and deploys on every merge, the API's
   pre-deploy command migrates first, and a rollback is "Redeploy" on the
   previous deployment in the dashboard.

Moving the database to Supabase later is the same as below: change the three
`DATABASE_URL*` variables on the API and the worker, let the API redeploy
(its pre-deploy command bootstraps and migrates the new database), then delete
the Postgres service.

## Moving the database to Supabase

Follow `docs/database/runbook-supabase-setup.md`, then set `DATABASE_URL`
(pooler, `integr8_app`), `DATABASE_URL_ADMIN` (direct, owner) and
`DATABASE_URL_AUTH` (pooler, `integr8_auth`) in `deploy/.env` and remove the
`postgres` service and the `depends_on` that point at it. `migrate` keeps
running on every deploy; it is idempotent.

## Backups, before any real data

The compose Postgres is one volume on one disk. `deploy/vps/backup-postgres.sh`
dumps it daily from root's cron (its header has the line and the restore
command) and keeps the last fourteen files under `/var/backups/integr8`. That
covers a bad migration or a deleted company. Losing the machine needs a copy
elsewhere: a boot-volume backup policy in the cloud console (Oracle's Always
Free tier includes five), or `rclone` from the backup directory to an R2
bucket. Moving the database to Supabase (below) replaces all of this with
managed backups and point-in-time recovery, and is the right answer before a
paying customer's data exists.

Container logs are capped at 50 MB per container by the `x-logging` block in
`deploy/compose.yml`, so a chatty week cannot fill the disk.

## Releasing a new version

0. **Bump the version** in the root `package.json` in the pull request that
   promotes `staging` to `main`. `release-main.yml` refuses `0.0.0` and refuses
   a version that already has a release, so a merge into `main` without a bump
   fails its release job (the images still publish). The version also stamps
   `APP_VERSION`/`API_RELEASE` in a deployment's env file. Until signed desktop
   installers are wanted (P20), set the repository variable
   `DESKTOP_BUILDS=disabled` so the release does not spend macOS and Windows
   runner minutes on unsigned builds.
1. Merge to `staging`. `publish-images.yml` pushes `integr8-api:staging` and
   `integr8-web:staging`.
2. On the machine: set `API_IMAGE`/`WEB_IMAGE` in `deploy/.env` to the tags,
   then `docker compose pull && docker compose up -d`. `migrate` runs first; the
   API's readiness check refuses traffic until the schema matches the build.
3. Roll back by setting the previous tag and running the same two commands.
   Migrations are rolled back deliberately, never automatically:
   `node node_modules/@integr8/db/dist/migrator/cli.js down --steps 1` from an
   `api` container, after reading the migration's down file.

## What is not here yet

Backups and a rehearsed restore (`docs/database/runbook-backup-and-restore.md`
covers Supabase; the compose Postgres needs `pg_dump` on a timer until then),
uptime monitoring and alerting, signed desktop and mobile builds (P20), and the
rest of P19. The compose stack is a first production for testing, not the
final shape.
