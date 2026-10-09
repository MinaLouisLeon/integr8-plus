# Integr8 Plus

A multi-tenant field operations platform. Integr8 sells it to service companies
(maintenance, installation, inspection) on subscription, and sets each company up
with its own forms, job types, look and apps. The company's office plans and
dispatches work; its engineers do the work on a phone that keeps working with no
signal; the office sees the result the moment the phone reconnects.

Current version: **0.1.3**. The build plan lives in [`plan/`](./plan/README.md);
start with [`plan/ROADMAP.md`](./plan/ROADMAP.md).

---

## Contents

1. [Who uses it, and with what](#who-uses-it-and-with-what)
2. [What it does](#what-it-does)
3. [Roles and permissions](#roles-and-permissions)
4. [Apps built for each company](#apps-built-for-each-company)
5. [Architecture](#architecture)
6. [How the hard parts work](#how-the-hard-parts-work)
7. [Getting started](#getting-started)
8. [Configuration](#configuration)
9. [Everyday commands and tests](#everyday-commands-and-tests)
10. [Languages and right-to-left](#languages-and-right-to-left)
11. [The API](#the-api)
12. [The database](#the-database)
13. [Branches, CI and releases](#branches-ci-and-releases)
14. [Deploying](#deploying)
15. [Documentation map](#documentation-map)
16. [Contributing](#contributing)

---

## Who uses it, and with what

| Who                                                       | Uses                                      | To                                                                                                                |
| --------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **Integr8 staff** (super admins)                          | Web platform dashboard (`/platform`)      | Onboard, support, suspend and close companies; set plans and billing; feature flags; announcements; audit; health |
| **Integr8 staff**                                         | **Integr8 Plus Staff** desktop app        | Act as a company to build its forms and job types, and set its logo, icon, colours, theme and website             |
| **A company's office** (owner, admin, dispatcher, viewer) | Web app, or the company's own desktop app | Customers and sites, work orders, dispatch, submissions, timesheets, imports, people, billing                     |
| **A company's engineers**                                 | The company's own phone app               | Their day: clock in, travel, arrive, work, fill forms, photos, signatures, complete. Works offline                |

There is no public sign-up by default (`PUBLIC_SIGNUP=off`): every company is
created by Integr8 from the platform dashboard, and the marketing site sends
visitors to a contact page instead.

## What it does

**Customers, sites and work orders.** Customers with contacts, tags and an account
status (active, on hold, closed); sites with addresses geocoded to a map pin and
access notes (gate code, parking, hazards) shown first on every job; work orders
with a state machine (scheduled → dispatched → travelling → on site → in progress
→ awaiting parts → complete → reviewed, or cancelled), a crew with a lead, a
checklist, comments, attachments, before and after photos, the customer's
sign-off, and a full history. Bulk reassign, reschedule and cancel; saved views;
CSV import of customers, sites and jobs. See [`docs/operations/`](./docs/operations/README.md).

**Job types and their forms.** A job type sets the checklist, instructions,
expected duration and the forms a job of that type needs. A job's attached forms
are its tasks: each shows its status and opens, or starts, its submission.

**The form engine.** Forms are built in the desktop app's drag-and-drop builder
from 18 field types (text, long text, number, decimal, date, time, date-time,
dropdown, radio, multi-select, checkbox, yes/no, rating, signature, photo, file,
GPS, barcode), in pages and sections, with repeatable sections ("one entry per
appliance"), calculated fields, validation rules with custom messages, and three
kinds of condition:

- **Show when** — a field, section or page appears only when other answers call
  for it. Every question card prints its rules in words ("Shown when Result is
  Fail") and has a _Show when…_ button.
- **Required only when** — a field is mandatory only when a rule is true.
- **Dependent choices** — a choice question's options narrow with the answer to
  another (Area → Room).

Publishing freezes a version forever; a submission stays bound to the version it
was filled against, and the publish screen names every breaking change before it
happens. A library of templates gives a starting point. The same engine runs in
the browser, the desktop app, on the phone (Hermes) and on the server, and a
conformance suite proves they agree byte for byte. See
[`docs/form-engine/`](./docs/form-engine/README.md).

**Submissions.** Filled on the web, desktop or phone; autosaved; revalidated on the
server; reopened and corrected only with a reason, with every version kept and
nobody able to rewrite history. Reportable values, CSV export, filtering by form,
customer, site, job and person. See [`docs/form-engine/submissions.md`](./docs/form-engine/submissions.md).

**The engineer's phone.** Offline-first: the phone holds an encrypted copy of the
engineer's work (SQLCipher) and every screen reads from it. Clock in and out,
the next job and its one step forward, directions, access notes, the checklist,
forms, photos, signatures, the customer's sign-off, completion. Everything is
recorded on the phone first and synced when there is signal, exactly once and in
order; conflicts come back with both versions. A signed offline grant lets the
app open for seven days with no network. Push notifications for new and changed
jobs; app lock with biometrics; over-the-air updates. See
[`docs/mobile/`](./docs/mobile/README.md), [`docs/sync/`](./docs/sync/README.md) and
[`docs/auth/offline-access.md`](./docs/auth/offline-access.md).

**Timesheets.** Shifts, travel and time on each job, week by week, for the office.

**Media.** Photos, signatures and files go straight from the device to the
company's own Cloudflare R2 bucket (one bucket per company), compressed first,
with thumbnails made by the worker and every byte recorded in a ledger the
platform can bill from. See [`docs/media/`](./docs/media/README.md).

**Billing.** Each company is either **invoiced by Integr8** (the plan is set from
the dashboard; no trial, no card in the app) or **pays in the app** (a trial, then
Stripe checkout and the customer portal, reminders, a grace period and finally
read-only). Plan limits — seats, submissions a month, storage, retention — are
enforced by the API, not by screens. See [`docs/billing/`](./docs/billing/README.md).

**Company branding.** Logo, square app icon, accent colour, menu colour, default
theme (light, dark or the device's) and website. Set by Integr8 staff from the
desktop app's _Company branding_ screen with a live preview; the company's own
people see it read-only and cannot change the theme. Every app wears it, and the
sign-in screen remembers it on each device.

**The dashboard.** The web app and the desktop app share one layout: a side menu
grouped by Work, Operations, Set-up and Company, showing only what the person may
use, that folds to icons (remembered) and becomes a drawer on narrow windows, and
a top bar with the page title and a back link on nested screens. The platform
dashboard uses the same layout.

**The desktop app's right-click menu.** In the installed window the webview's own
menu is replaced: a job, customer, site, job type, timesheet, submission or form
row offers its own actions; text fields offer Cut, Copy, Paste and Select all.

**Running the business.** The platform dashboard covers companies (onboard in one
action: company, starter job types, owner invitation and storage bucket), plans
and billing mode, impersonation with a reason and an audit entry, suspension,
data export, scheduled deletion and purge, feature flags, announcements, the form
template library, the sign-up funnel, storage metering, releases in the field,
recent failures, unlocking accounts and unsticking sync. See
[`docs/platform/`](./docs/platform/README.md).

## Roles and permissions

Five roles per company. The whole policy is one table in
[`packages/core/src/permissions.ts`](./packages/core/src/permissions.ts); a test
fails if a permission is added without deciding it for every role.

| Role           | In short                                                                            |
| -------------- | ----------------------------------------------------------------------------------- |
| **owner**      | Everything in the company, including company settings and the subscription          |
| **admin**      | Everything except company settings and changing the subscription (may read billing) |
| **dispatcher** | Runs the day: customers, sites and work orders; reads every submission; fills forms |
| **engineer**   | Does the work: their assigned jobs, filling forms, their own submissions            |
| **viewer**     | Reads everything, changes nothing                                                   |

Three permissions are **staff-only**: `form.manage`, `job_type.manage` and
`branding.manage`. The company's owner and admins hold them on paper but only use
them while Integr8 staff sit in the seat through an audited impersonation; a
company's own people are told "This is set up for your company by Integr8".

## Apps built for each company

One codebase produces three kinds of build, fixed when the build is made:

| Build               | Installed by          | Sign-in shown | Name and identifier                            |
| ------------------- | --------------------- | ------------- | ---------------------------------------------- |
| Staff desktop       | Integr8's own people  | Staff only    | `Integr8 Plus Staff`, `com.integr8.plus.staff` |
| A company's desktop | That company's people | Company only  | The company's name, `com.integr8.plus.<slug>`  |
| A company's phone   | That company's people | Company only  | The company's name, `com.integr8.plus.<slug>`  |

A company build sends its short name (slug) when signing in, and the API answers
`403 wrong_company` to an account from any other company. Its phone app opens on
the company's website with a **Login** button.

Builds run on GitHub, never on a laptop:

- **One company:** Actions → **Build company apps** → company short name.
- **Every company, every release:** a merge into `main` with a new version builds
  the staff app and then every company with _Build apps for this company_ ticked
  on its page in the platform dashboard.
- Each company gets its own GitHub release, `company-<slug>-v<version>`, with its
  Windows, macOS and Linux installers, its Android app and links to the Expo builds.
- Store submission (Google Play internal track, App Store Connect) runs only when
  the `STORE_SUBMIT` variable is `enabled`.

Full detail: [`docs/deployment/company-apps.md`](./docs/deployment/company-apps.md)
and [`docs/mobile/company-builds.md`](./docs/mobile/company-builds.md).

## Architecture

```
  browsers ─────────┐            ┌─────── desktop apps (Tauri)      phones (Expo, offline)
                    ▼            ▼                                         │
          apps/web (Next.js) ────┴──────────▶ apps/api (Fastify, /v1) ◀────┘  sync push/pull
                                                   │        │
                                     worker (same image)    │
                                                   ▼        ▼
                         Postgres (RLS, per-tenant)     Cloudflare R2 (a bucket per company)
                         Supabase Auth · Stripe · Resend · Mapbox · Expo push · Sentry
```

pnpm workspaces and Turborepo; Node 22; TypeScript everywhere; Vitest; ESLint
with type-aware rules; Prettier.

### Apps

| App            | Package            | What it is                                                                                                           |
| -------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `apps/api`     | `@integr8/api`     | Fastify service: versioned `/v1` routes, generated OpenAPI, idempotency, rate limits, the background worker, the CLI |
| `apps/web`     | `@integr8/web`     | Next.js: marketing pages, the company's office app, billing, the platform dashboard. Port 3001                       |
| `apps/desktop` | `@integr8/desktop` | React SPA in Tauri v2: form builder, branding, operations, submissions. Staff and per-company flavours. Port 3002    |
| `apps/mobile`  | `@integr8/mobile`  | Expo Router, offline-first: the engineer's day; one build per company                                                |

### Shared packages

| Package                      | Purpose                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `@integr8/core`              | Domain types and zod schemas, the permission matrix, the navigation model. The only place a shared type lives |
| `@integr8/db`                | Schema, migrations, repositories, tenant isolation, seeds. The only place SQL runs                            |
| `@integr8/auth`              | Sign-in, sessions, refresh rotation, impersonation, offline grants, platform sessions, key generation         |
| `@integr8/api-client`        | Typed client generated from the OpenAPI document, plus the session manager every app uses                     |
| `@integr8/form-engine`       | The form definition, compiler, evaluator, validation, versioning diff and conformance suite. No UI, no I/O    |
| `@integr8/form-input`        | Turning engine state into what a filler shows: navigation, entries, prefill, dependent choices                |
| `@integr8/form-renderer-dom` | The form renderer and submission screens for web and desktop                                                  |
| `@integr8/operations-dom`    | Customer, site, job type, work order, import and timesheet screens for web and desktop                        |
| `@integr8/offline`           | The phone's SQLite schema, queries, eviction and the sync engine — no React Native inside                     |
| `@integr8/i18n`              | English and Arabic catalogues, locale and direction helpers, formatting                                       |
| `@integr8/tokens`            | Design tokens (colour, spacing, type), light and dark themes, brand accent and shell derivation               |
| `@integr8/typescript-config` | `base` / `node` / `react` tsconfig presets                                                                    |
| `@integr8/eslint-config`     | Flat ESLint config: type-aware rules, React, accessibility, and the right-to-left rule                        |

Nothing outside `@integr8/db` may import `kysely` or `pg` — ESLint rejects it. Shared
packages hold no app-specific widgets: the web and desktop draw the same screens
with the same Tailwind classes.

## How the hard parts work

- **Tenant isolation.** Application code reaches the database only through
  `getTenantDataSource(tenantId)` and its repositories, which set the tenant on the
  connection; Postgres row-level security is the backstop underneath. Every
  tenant-scoped table carries `tenant_id` and every key between two tenant tables
  carries it too, checked by a schema-invariants suite. See [`docs/database/`](./docs/database/README.md).
- **Authentication.** Supabase holds passwords and sends magic links; this service
  issues its own tokens (EdDSA over Ed25519): 15-minute access tokens, rotating
  refresh tokens with reuse detection, a seven-day offline grant the phone verifies
  itself, and impersonation tokens tied to an audited grant. Lockout, per-IP
  limits and remote device revocation. Super admins sign in with a password and a
  six-digit authenticator code. See [`docs/auth/`](./docs/auth/README.md).
- **Offline sync.** Screens write the phone's copy and an outbox in one SQLite
  transaction; the engine pushes changes in order with idempotency keys, uploads
  files in parts, and pulls changes since a cursor. See [`docs/sync/`](./docs/sync/README.md).
- **Forms that never change under a submission.** A published version is
  immutable in the database; a submission is bound to its version by trigger; its
  history is append-only. See [`docs/form-engine/`](./docs/form-engine/README.md).
- **Storage you can bill.** One R2 bucket per company, every object recorded in a
  ledger reconciled against Cloudflare's own figures. See [`docs/media/`](./docs/media/README.md).
- **Entitlements in one place.** The API refuses what a plan does not allow; the
  pricing page reads the same rows it enforces. See [`docs/billing/`](./docs/billing/README.md).

## Getting started

### Requirements

| Tool     | Version | Notes                                                         |
| -------- | ------- | ------------------------------------------------------------- |
| Node     | 22.x    | Pinned in `.nvmrc`; run `nvm use`                             |
| pnpm     | 10.x    | `corepack enable` picks up the version in `package.json`      |
| Postgres | 16      | Only for the API and the integration tests; Supabase or local |
| Rust     | stable  | Only to run the desktop app as a native window (`tauri:dev`)  |

### Install and build

```bash
git clone https://github.com/MinaLouisLeon/integr8-plus.git
cd integr8-plus
corepack enable
pnpm install          # also installs the git hooks
pnpm build
```

`pnpm build`, `pnpm lint`, `pnpm typecheck` and `pnpm test` all work without a
database.

### Environment files

```bash
for app in api desktop mobile; do cp "apps/$app/.env.example" "apps/$app/.env"; done
cp apps/web/.env.example apps/web/.env.local   # Next reads .env.local
cp packages/db/.env.example packages/db/.env
cp packages/auth/.env.example packages/auth/.env
pnpm --filter @integr8/auth keygen   # prints the signing-key variables
```

Every external service has a local stand-in, chosen by a variable, so a laptop
needs none of them: `MEDIA_STORAGE=local`, `GEOCODER=fake`, `PUSH_SENDER=recording`,
`BILLING_PROVIDER=recording`, `EMAIL_SENDER=recording`. Production refuses to
start on any of the stand-ins.

### A database

[`docs/database/runbook-supabase-setup.md`](./docs/database/runbook-supabase-setup.md)
creates one on Supabase in about fifteen minutes. For a local Postgres, point the
three `DATABASE_URL*` variables at it, then:

```bash
pnpm --filter @integr8/db db bootstrap   # creates the two application roles
pnpm --filter @integr8/db db up          # applies every migration
pnpm --filter @integr8/db db:seed        # optional sample data
pnpm --filter @integr8/db db:templates   # the global form template library
```

### Running the apps

```bash
pnpm dev                                   # every app, in parallel
pnpm --filter @integr8/api dev             # the API on http://localhost:3000
pnpm --filter @integr8/web dev             # http://localhost:3001
pnpm --filter @integr8/desktop dev         # http://localhost:3002, as a browser page
pnpm --filter @integr8/desktop tauri:dev   # the same bundle, as a native window
pnpm --filter @integr8/mobile dev          # Metro; press i or a
curl http://localhost:3000/health          # is the API up?
```

A desktop app with no `VITE_APP_FLAVOR` set is a development build and shows both
the company and the staff sign-in. A phone app with no `apps/mobile/company.json`
is the generic app and opens straight on its sign-in.

## Configuration

Every variable is documented where it is read; the templates are the reference.

| Where                  | Template                     | Covers                                                                                                           |
| ---------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| A deployment (compose) | `deploy/.env.example`        | Everything below for the API, worker and web image, in one file                                                  |
| API and worker         | `apps/api/.env.example`      | Mode, ports, CORS, rate limits, media/R2, geocoder, push, billing, email, sign-up, `BUILD_TOKEN`, Sentry, worker |
| Authentication         | `packages/auth/.env.example` | Issuer, signing keys, token lifetimes, lockout, platform sessions, Supabase                                      |
| Database               | `packages/db/.env.example`   | The three connection strings (app, admin, auth), pool sizes, timeouts                                            |
| Web                    | `apps/web/.env.example`      | `API_BASE_URL`, `NEXT_PUBLIC_*` (API, environment, Sentry, sign-up mode, contact email, map tiles)               |
| Desktop                | `apps/desktop/.env.example`  | `VITE_API_BASE_URL`, `VITE_APP_FLAVOR` (`staff` / `company`), `VITE_COMPANY_SLUG`, Sentry, updater keys          |
| Phone                  | `apps/mobile/.env.example`   | `EXPO_PUBLIC_API_BASE_URL`, environment, Sentry; `company.json` for a company build                              |

Notable switches:

| Variable           | Effect                                                                                            |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `APP_ENV`          | `staging` tolerates stand-in services; `production` refuses to start without the real ones        |
| `PUBLIC_SIGNUP`    | `off` (default): companies are created only by Integr8; `open` turns the public sign-up back on   |
| `BUILD_TOKEN`      | Lets GitHub list the companies whose apps to build; must match the repository secret of that name |
| `MEDIA_STORAGE`    | `local` disk or `r2`                                                                              |
| `BILLING_PROVIDER` | `recording` or `stripe`                                                                           |

## Everyday commands and tests

| Command                 | Does                                                              |
| ----------------------- | ----------------------------------------------------------------- |
| `pnpm build`            | Builds every package in dependency order                          |
| `pnpm lint`             | ESLint across the workspace                                       |
| `pnpm typecheck`        | `tsc --noEmit` per package                                        |
| `pnpm test`             | Vitest per package; needs no database                             |
| `pnpm test:integration` | Database, auth and API suites against a real, disposable Postgres |
| `pnpm format`           | Prettier, writing changes                                         |
| `pnpm format:check`     | Prettier, failing on drift (what CI runs)                         |
| `pnpm clean`            | Removes build output and caches                                   |

Add `--filter @integr8/<name>` to scope any of them to one package. Also useful:

| Command                                                 | Does                                                                  |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `pnpm --filter @integr8/api openapi`                    | Writes `apps/api/openapi.json` from the route registry                |
| `pnpm --filter @integr8/api-client generate`            | Regenerates the typed client from it (CI fails if either has drifted) |
| `pnpm --filter @integr8/api storage provision --all`    | Creates any missing per-company R2 bucket                             |
| `pnpm --filter @integr8/form-engine conformance:golden` | Regenerates the engine's conformance golden file                      |
| `pnpm --filter @integr8/form-engine conformance:hermes` | Runs the conformance suite on Hermes, the phone's JavaScript engine   |

Integration tests need `APP_ENV=test`, `INTEGR8_TEST_DATABASE=i-know-this-database-is-disposable`
and the three test `DATABASE_URL*` variables; CI runs them against a Postgres
service container on every pull request.

## Languages and right-to-left

English and Arabic (formal Modern Standard Arabic) are both complete. The catalogues
are TypeScript (`packages/i18n/src/messages/en.ts` and `ar.ts`), so a wrong key is a
compile error, and a parity test fails when the two drift apart in keys,
placeholders or plural forms (Arabic carries all six). Text direction follows the
language: Arabic reads right to left on every screen of every app. Every layout uses
logical properties only (`ms-`, `pe-`, `start-`, `text-start`); ESLint rejects
`ml-`, `left-`, `text-left` and their kind. The web reads the language from a
cookie or the browser, the desktop from its own setting, the phone from the
device. See [`docs/ui/`](./docs/ui/README.md).

## The API

One HTTP service in front of Postgres; clients never query the database or
Supabase directly. About 150 operations under `/v1`, each declared once with its
zod schemas, security (public, authenticated or platform), permission,
idempotency and responses; the OpenAPI document and the typed client are
generated from those declarations. Requests pass through, in order: request id,
client version check, per-IP rate limit, validation, authentication, suspension,
permission, per-tenant rate limit, idempotency. Breaking changes go to `/v2`; old
clients are told when they are too old (`min-supported-client`). See
[`docs/api/`](./docs/api/README.md) and [`docs/api/versioning.md`](./docs/api/versioning.md).

Public, unauthenticated routes include the plans (`/v1/plans`), the sign-up flow
(off by default), invitation acceptance, the billing webhook, and a company's
brand by short name (`/v1/public/companies/{slug}/brand`, with its logo and icon),
which a freshly installed company app reads before anyone signs in.

## The database

Postgres 16, migrated forward by numbered SQL files in `packages/db/migrations`,
each with a down file, applied by `pnpm --filter @integr8/db db up` (or
`migrator deploy` on a host's pre-deploy hook). Two runtime roles: `integr8_app`
(row-level security applies) and `integr8_auth` (the sign-in path).

| Migration | Adds                                                                          |
| --------- | ----------------------------------------------------------------------------- |
| 0001–0005 | Tenants, members, row-level security, authentication, API infrastructure      |
| 0006–0008 | Forms, versions, the builder, submissions and their lifecycle                 |
| 0009      | The media ledger                                                              |
| 0010      | Customers, sites, work orders and their state machine                         |
| 0011–0013 | Offline sync, submit location, job execution (shifts, photos, sign-off)       |
| 0014      | Repeating groups                                                              |
| 0015–0016 | The platform: sessions, audit, flags, exports, deletions; storage metering    |
| 0017      | Subscriptions and billing                                                     |
| 0018–0020 | Sign-up, company settings, sample data                                        |
| 0021      | Billing mode per company (invoiced or self-serve)                             |
| 0022      | Company branding: menu colour, default theme, website, app icon, build switch |

See [`docs/database/migrations.md`](./docs/database/migrations.md) and the
[backup and restore runbook](./docs/database/runbook-backup-and-restore.md).

## Branches, CI and releases

```
your branch ──▶ dev ──▶ staging ──▶ main
                 │         │          │
            test build  nightly   version release
```

| Workflow                 | When                                    | Does                                                                                            |
| ------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `ci.yml`                 | Every pull request                      | Format, lint, typecheck, unit tests, OpenAPI drift, integration suites on Postgres, secret scan |
| `branch-policy.yml`      | Pull requests                           | Checks which branch may merge into which                                                        |
| `release-dev.yml`        | Merge into `dev`                        | A test build                                                                                    |
| `release-staging.yml`    | Merge into `staging`                    | A nightly pre-release against the staging API, including a generic phone build for testers      |
| `release-main.yml`       | Merge into `main`                       | Version release: API and web archives, the staff desktop installers, then every company's apps  |
| `build-company-apps.yml` | By hand, or from a release              | One company's (or every company's) desktop installers and phone app, as their own release       |
| `publish-images.yml`     | Push to `staging` or `main`, a `v*` tag | The API and web container images to GHCR (`:main`, `:staging`, per commit and tag)              |

The version is the root `package.json` `version` and nothing else: bump it to
release, and a release for a version that already exists is refused. Repository
variables and secrets the workflows read (`PUBLIC_API_URL`, `EXPO_TOKEN`,
`EAS_BUILDS`, `BUILD_TOKEN`, `STORE_SUBMIT`, the Tauri signing key and others) are
listed in [`docs/contributing/branching.md`](./docs/contributing/branching.md).

## Deploying

What ships is two container images (API, which is also the worker and the
migrator; and web) and a Postgres database; everything else is configuration.

- [`docs/deployment/README.md`](./docs/deployment/README.md) — a first stack with
  `deploy/compose.yml` (Postgres, bootstrap, migrate, API, worker, web) behind
  Caddy on one machine, including Oracle Cloud's Always Free ARM instance; the
  Railway alternative (`deploy/railway/`); moving the database to Supabase;
  backups (`deploy/vps/backup-postgres.sh`); releasing a new version.
- [`docs/deployment/company-apps.md`](./docs/deployment/company-apps.md) — the
  staff desktop app and each company's own apps.
- `deploy/vps/setup.sh` prepares a fresh Ubuntu or Oracle Linux machine (firewall,
  Docker, Caddy, security updates).

## Documentation map

| Area                   | Start at                                                                                                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API                    | [`docs/api/`](./docs/api/README.md)                                                                                                                                                                                                     |
| Authentication         | [`docs/auth/`](./docs/auth/README.md)                                                                                                                                                                                                   |
| Database               | [`docs/database/`](./docs/database/README.md)                                                                                                                                                                                           |
| Form engine            | [`docs/form-engine/`](./docs/form-engine/README.md), [builder](./docs/form-engine/builder.md), [repeating groups](./docs/form-engine/repeating-groups.md), [submissions](./docs/form-engine/submissions.md)                             |
| Operations             | [`docs/operations/`](./docs/operations/README.md)                                                                                                                                                                                       |
| Mobile                 | [`docs/mobile/`](./docs/mobile/README.md), [forms](./docs/mobile/forms.md), [the working day](./docs/mobile/job-execution.md), [company builds](./docs/mobile/company-builds.md), [device checklist](./docs/mobile/device-checklist.md) |
| Offline sync           | [`docs/sync/`](./docs/sync/README.md)                                                                                                                                                                                                   |
| Media                  | [`docs/media/`](./docs/media/README.md)                                                                                                                                                                                                 |
| Billing                | [`docs/billing/`](./docs/billing/README.md)                                                                                                                                                                                             |
| Sign-up and onboarding | [`docs/onboarding/`](./docs/onboarding/README.md)                                                                                                                                                                                       |
| Platform dashboard     | [`docs/platform/`](./docs/platform/README.md)                                                                                                                                                                                           |
| Interface, tokens, RTL | [`docs/ui/`](./docs/ui/README.md)                                                                                                                                                                                                       |
| Deployment             | [`docs/deployment/`](./docs/deployment/README.md)                                                                                                                                                                                       |
| Branches and CI        | [`docs/contributing/branching.md`](./docs/contributing/branching.md)                                                                                                                                                                    |
| The plan               | [`plan/ROADMAP.md`](./plan/ROADMAP.md)                                                                                                                                                                                                  |

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the repository layout, branch naming,
the commit format (Conventional Commits with a scope), the git hooks (lint-staged
on commit; typecheck and tests on push), how to add a package, and the checklists
for changing the interface, the API or the database.
