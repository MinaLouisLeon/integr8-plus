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
| Images in the registry | `.github/workflows/publish-images.yml`      | `ghcr.io/<owner>/integr8-api` and `integr8-web`, tagged per branch/sha |
| Database runbooks      | `docs/database/`                            | Supabase setup, migrations, backup and restore                         |

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
   public hostname.
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
   `/platform/sign-in`, then change the password. `docs/platform/README.md`
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

## Moving the database to Supabase

Follow `docs/database/runbook-supabase-setup.md`, then set `DATABASE_URL`
(pooler, `integr8_app`), `DATABASE_URL_ADMIN` (direct, owner) and
`DATABASE_URL_AUTH` (pooler, `integr8_auth`) in `deploy/.env` and remove the
`postgres` service and the `depends_on` that point at it. `migrate` keeps
running on every deploy; it is idempotent.

## Releasing a new version

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
