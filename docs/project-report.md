# Integr8 Plus — Project Report

**What has been built, how it is built, and every technology and library it uses.**

|                 |                                                                                                                                                       |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Product         | Integr8 Plus: a multi-tenant field-operations platform                                                                                                |
| Repository      | `MinaLouisLeon/integr8-plus`                                                                                                                          |
| Version         | `1.1.0` (root `package.json`)                                                                                                                         |
| Report date     | 11 October 2026                                                                                                                                       |
| Source of truth | The `main` branch of the repository, after pull request #71: every number, version and endpoint below was read from the code, not written from memory |

---

## Contents

1. [Summary](#1-summary)
2. [Who uses it, and through which app](#2-who-uses-it-and-through-which-app)
3. [Architecture](#3-architecture)
4. [Technology stack at a glance](#4-technology-stack-at-a-glance)
5. [The repository: a pnpm and Turborepo monorepo](#5-the-repository-a-pnpm-and-turborepo-monorepo)
6. [The applications](#6-the-applications)
7. [The shared packages](#7-the-shared-packages)
8. [The database](#8-the-database)
9. [Authentication, roles and security](#9-authentication-roles-and-security)
10. [Features, area by area](#10-features-area-by-area)
11. [The API, endpoint by endpoint](#11-the-api-endpoint-by-endpoint)
12. [Background work](#12-background-work)
13. [External services](#13-external-services)
14. [Languages and right-to-left](#14-languages-and-right-to-left)
15. [Testing and code quality](#15-testing-and-code-quality)
16. [Continuous integration and releases](#16-continuous-integration-and-releases)
17. [Deployment](#17-deployment)
18. [Configuration](#18-configuration)
19. [Documentation in the repository](#19-documentation-in-the-repository)
20. [Roadmap: what is done and what is not](#20-roadmap-what-is-done-and-what-is-not)
21. [Appendix A: every library, by package, with versions](#appendix-a-every-library-by-package-with-versions)

---

## 1. Summary

Integr8 Plus runs a field-service company's day. The office sets up customers, their sites, and jobs ("work orders"). It assigns jobs to engineers. Engineers do the work from a phone, even with no signal, filling in inspection forms with photos, signatures and GPS. The office then reviews the results.

Integr8 (the company that runs the platform) onboards each customer company itself. It builds each company's forms and job types, sets its branding, and builds that company's own branded desktop and phone apps.

**In numbers**

|                            |                                                              |
| -------------------------- | ------------------------------------------------------------ |
| Applications               | 4: API (with its worker), web, desktop, mobile               |
| Shared packages            | 13                                                           |
| API endpoints              | 158 under `/v1`, plus 3 health endpoints                     |
| Database migrations        | 23 (each with an `up` and a `down` file), 6,181 lines of SQL |
| TypeScript source          | about 149,000 lines (generated code excluded)                |
| Test files                 | 108 unit-test files and 39 integration-test files            |
| Languages in the interface | English and Arabic, complete, with right-to-left layout      |
| Git history                | 257 commits, from 9 September 2026 to 11 October 2026        |

---

## 2. Who uses it, and through which app

| Who                              | App                                      | What they do there                                                                                                                                                             |
| -------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Company owners and admins**    | Web app; their company's own desktop app | Manage people, customers, sites and jobs; review submissions; billing; storage; settings                                                                                       |
| **Dispatchers**                  | Web app; their company's desktop app     | Create and assign jobs; reschedule; watch progress                                                                                                                             |
| **Engineers**                    | Their company's own phone app            | See today's jobs; travel, arrive, work; fill forms offline; capture photos, signatures and GPS; get the customer's sign-off; clock in and out                                  |
| **Viewers**                      | Web app                                  | Read-only access                                                                                                                                                               |
| **Integr8 staff** (super admins) | Web platform dashboard at `/platform`    | Onboard companies; invite owners; support, suspend and close companies; plans and billing mode; feature flags; announcements; audit log; health; storage; the **Staff** screen |
| **Integr8 staff**                | **Integr8 Plus Staff** desktop app       | Act as a company to build its forms and job types, and set its logo, app icon, colours, theme and website                                                                      |

The five company roles are `owner`, `admin`, `dispatcher`, `engineer` and `viewer`, in that order of rank. Three permissions are **staff-only**: no company member holds them, only Integr8 staff acting as the company.

- `form.manage`
- `job_type.manage`
- `branding.manage`

---

## 3. Architecture

```
            ┌──────────────┐  ┌───────────────────────┐  ┌──────────────────────┐
            │  Web app     │  │ Desktop app (Tauri)   │  │ Phone app (Expo)     │
            │  Next.js 16  │  │ React + Vite + Rust   │  │ React Native + SQLite│
            └──────┬───────┘  └──────────┬────────────┘  └──────────┬───────────┘
                   │  typed client (openapi-fetch), JSON over HTTPS │  offline outbox,
                   └────────────────────┬───────────────────────────┘  pull/push sync
                                        ▼
                         ┌─────────────────────────────┐
                         │ API (Fastify 5, Node 22)     │  ← same image →  Worker
                         │ zod schemas → OpenAPI 3.0.3  │                  (background jobs)
                         └──────────────┬──────────────┘
                                        ▼
                         ┌─────────────────────────────┐
                         │ PostgreSQL 16                │  Row-level security per company,
                         │ Kysely + node-postgres       │  three database roles
                         └─────────────────────────────┘
     External: Supabase Auth · Cloudflare R2 · Stripe · Resend · Mapbox · Expo Push · Sentry
```

**Main design decisions**

- **One API for every client.** Web, desktop and phone all call the same versioned REST API (`/v1`). The API is described by zod schemas, which emit an OpenAPI 3.0.3 file (`apps/api/openapi.json`). The typed TypeScript client in `packages/api-client` is generated from that file, and CI fails if the client drifts from the API.
- **Multi-tenancy that is enforced twice.** Every company-owned row carries a `tenant_id`. The repository layer scopes every query to one company. PostgreSQL row-level security (RLS) is the backstop: the runtime database role cannot read another company's rows even if a query forgets its filter.
- **The phone is offline-first.** The phone app keeps a local SQLite database and an outbox of changes. It syncs with `/v1/sync/pull` and `/v1/sync/push` when it has signal. Uploads are resumable.
- **Forms are versioned and immutable once published.** Every submission records the exact version it answered, so editing a form never changes past data.
- **One container image** runs the API, the background worker and the database migrator, so the worker always runs exactly the API's code.

---

## 4. Technology stack at a glance

| Layer                    | Technology                                                | Version                                |
| ------------------------ | --------------------------------------------------------- | -------------------------------------- |
| Language                 | TypeScript (strict)                                       | 6.0.3                                  |
| Runtime                  | Node.js                                                   | 22 (`.nvmrc`: 22.22.2)                 |
| Node.js type definitions | `@types/node`                                             | 26.6.4                                 |
| Package manager          | pnpm workspaces                                           | 10.33.0                                |
| Build orchestration      | Turborepo                                                 | 2.11.7                                 |
| API framework            | Fastify                                                   | 5.12.3                                 |
| Validation and schemas   | zod                                                       | 4.6.1                                  |
| Database                 | PostgreSQL                                                | 16                                     |
| Query builder            | Kysely                                                    | 0.28.9                                 |
| Postgres driver          | node-postgres (`pg`)                                      | 8.16.3                                 |
| Tokens (JWT)             | jose (EdDSA signing)                                      | 6.2.0                                  |
| Web framework            | Next.js (App Router)                                      | 16.3.4                                 |
| UI library               | React                                                     | 19.3.0                                 |
| Styling                  | Tailwind CSS                                              | 4.3.3                                  |
| Server-state caching     | TanStack Query                                            | 5.102.8                                |
| Desktop shell            | Tauri                                                     | 2 (CLI 2.11.4, API 2.12.0)             |
| Desktop bundler          | Vite                                                      | 8.2.2                                  |
| Desktop routing          | React Router                                              | 8.3.1                                  |
| Desktop native code      | Rust (edition 2021, minimum 1.77)                         | —                                      |
| Phone framework          | Expo SDK                                                  | 58 (`expo` 58.0.14)                    |
| Phone runtime            | React Native                                              | 0.88.0                                 |
| Phone routing            | Expo Router                                               | 58.0.23                                |
| Phone local database     | SQLite (`expo-sqlite`)                                    | 58.0.13                                |
| Translation              | i18next and react-i18next                                 | 26.4.2 / 17.0.13                       |
| Maps                     | Leaflet with OpenStreetMap tiles                          | 1.9.4                                  |
| Image processing         | sharp                                                     | 0.35.4                                 |
| Object storage client    | AWS SDK v3 for S3 (talking to Cloudflare R2)              | 3.1131.0                               |
| Error reporting          | Sentry: Node and Next.js / React (desktop) / React Native | 10.74.0 / 11.1.0 / 7.11.0              |
| Tests                    | Vitest                                                    | 5.0.3                                  |
| Property-based tests     | fast-check                                                | 4.10.0                                 |
| DOM tests                | Testing Library, jsdom, axe-core                          | see Appendix A                         |
| Linting                  | ESLint, typescript-eslint, jsx-a11y, react-hooks          | 10.12.0 / 8.71.1                       |
| Formatting               | Prettier                                                  | 3.9.9                                  |
| Git hooks                | Husky, lint-staged, commitlint (Conventional Commits)     | 9.1.7 / 17.6.0 / 21.2.3                |
| Containers               | Docker, Docker Compose                                    | `node:22-bookworm-slim`, `postgres:16` |
| Reverse proxy and TLS    | Caddy                                                     | official build                         |
| CI/CD                    | GitHub Actions; GitHub Container Registry                 | —                                      |
| Phone builds             | Expo Application Services (EAS)                           | —                                      |

---

## 5. The repository: a pnpm and Turborepo monorepo

```
integr8-plus/
├── apps/
│   ├── api/        Fastify API, background worker, admin CLI, storage CLI, OpenAPI emitter
│   ├── web/        Next.js: marketing site, company web app, platform dashboard
│   ├── desktop/    Tauri app: staff flavour and per-company flavour
│   └── mobile/     Expo app: the engineer's phone app, built per company
├── packages/
│   ├── api-client/        typed HTTP client generated from openapi.json
│   ├── auth/              tokens, sessions, passwords, TOTP, impersonation, invitations
│   ├── core/              ids, roles, permissions, claims, navigation, job rules
│   ├── db/                schema, migrations, migrator, repositories, seed, test harness
│   ├── form-engine/       form definitions, logic, validation, versioning, templates
│   ├── form-input/        turning user input into answers, shared by every renderer
│   ├── form-renderer-dom/ form filler for web and desktop
│   ├── operations-dom/    customers, sites, jobs and timesheet screens for web and desktop
│   ├── offline/           phone database, outbox and sync engine
│   ├── i18n/              English and Arabic catalogues, formatting, direction
│   ├── tokens/            design tokens and company brand colours, emitted as CSS
│   ├── eslint-config/     shared lint rules
│   └── typescript-config/ shared tsconfig presets
├── deploy/        compose.yml (with the self-hosted Auth), VPS setup script, Caddyfile, backups
├── docs/          operator and developer documentation, by area
├── plan/          the phased roadmap (P01–P35)
├── scripts/       repository scripts
├── AGENTS.md      guidance Turborepo writes for AI coding agents, kept committed
└── .github/       workflows, rulesets, Dependabot, PR template
```

**Root tooling**

- **Turborepo tasks:** `build`, `typecheck`, `lint`, `test`, `test:integration`, `dev`, `clean`. Every task builds its workspace dependencies first (`dependsOn: ["^build"]`).
- **Root scripts:** `build`, `dev`, `lint`, `lint:fix`, `typecheck`, `test`, `test:integration`, `format`, `format:check`, `clean`.
- **Husky** runs **lint-staged** before each commit, which applies ESLint `--fix` and Prettier to staged files. **commitlint** enforces Conventional Commit messages, such as `feat(platform): …`.
- **pnpm** blocks dependency install scripts by default. Only `esbuild` and `@sentry/cli` may run theirs, on purpose.

---

## 6. The applications

### 6.1 API — `apps/api`

**Built with:** Fastify 5, zod 4, Kysely and Postgres through `@integr8/db`, jose through `@integr8/auth`, sharp, AWS SDK S3, and Sentry for Node.

**What is in it**

| Folder               | Purpose                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/routes/v1/`     | Every endpoint. Each is declared with `defineRoute` (method, path, zod schemas for params, query and body, every response, and its security level) |
| `src/http/`          | Errors, CORS, idempotency keys, client-version checks, request logging, suspension guard, OpenAPI generation                                       |
| `src/jobs/`          | The background worker and its job handlers                                                                                                         |
| `src/media/`         | Uploads to Cloudflare R2 or local disk, thumbnails, storage metering, quotas, Cloudflare usage audit, storage CLI                                  |
| `src/billing/`       | Stripe provider, webhooks, entitlements per plan, dunning                                                                                          |
| `src/sync/`          | The phone sync engine: pull, push, merge, maintenance                                                                                              |
| `src/signup/`        | Self-serve signup and its expiry (signup is switched off by default; companies are onboarded by Integr8)                                           |
| `src/imports/`       | CSV import of customers, sites and work orders, including time-zone handling                                                                       |
| `src/email/`         | Email delivery (Resend, or a recorder in tests): invitations, signup verification, dunning                                                         |
| `src/push/`          | Expo push notifications for work-order events                                                                                                      |
| `src/geo/`           | Geocoding site addresses through Mapbox                                                                                                            |
| `src/platform/`      | `admin-cli` (create, remove and list Integr8 staff accounts) and company onboarding                                                                |
| `src/openapi/`       | Writes `openapi.json`                                                                                                                              |
| `src/observability/` | Sentry setup                                                                                                                                       |

**Security levels on each route:** `public`, `authenticated` (a company session, with a named permission) or `platform` (an Integr8 staff session).

**Protections built into the HTTP layer**

- Rate limits per IP address and per company.
- Idempotency keys, so a retried request is never applied twice.
- A request body size limit.
- CORS restricted to the listed origins.
- A minimum supported client version: an app that is too old is told to update.
- A suspended company is refused service.
- Every error answers with a stable `code` and a request id.

**Health checks:** `GET /health` (alive), `GET /health/ready` (database reachable) and `GET /health/probe-error` (proves Sentry receives errors).

**Command-line entry points**

| Script                                                     | What it does                                     |
| ---------------------------------------------------------- | ------------------------------------------------ |
| `node dist/index.js`                                       | Runs the API on port 3000                        |
| `node dist/jobs/worker-main.js`                            | Runs the background worker                       |
| `node dist/platform/admin-cli.js create \| remove \| list` | Manages Integr8 staff accounts from the terminal |
| `pnpm openapi`                                             | Writes the OpenAPI file                          |
| `pnpm storage`                                             | Storage maintenance                              |

### 6.2 Web — `apps/web`

**Built with:** Next.js 16 (App Router), React 19, Tailwind CSS 4 (PostCSS plugin), TanStack Query, Sentry for Next.js, and the shared packages `form-renderer-dom`, `operations-dom`, `i18n` and `tokens`.

**Pages**

| Area               | Pages                                                                                                                                                                                                                                                                                                  |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Marketing (public) | `/features`, `/pricing`, `/contact`, `/help`                                                                                                                                                                                                                                                           |
| Accounts           | `/sign-in`, `/sign-up`, `/sign-up/verify`, `/accept-invitation`                                                                                                                                                                                                                                        |
| Company app        | `/dashboard`, `/get-started`, `/work-orders`, `/work-orders/new`, `/work-orders/[id]`, `/customers`, `/customers/[id]`, `/sites/[id]`, `/fill`, `/submissions`, `/submissions/[id]`, `/timesheets`, `/imports`, `/billing`, `/storage`, `/settings/company`, `/settings/people`, `/settings/job-types` |
| Platform dashboard | `/platform/sign-in`, `/platform` (companies), `/platform/companies/[tenantId]`, `/platform/funnel`, `/platform/storage`, `/platform/plans`, `/platform/audit`, `/platform/flags`, `/platform/announcements`, `/platform/templates`, `/platform/releases`, `/platform/health`, `/platform/staff`        |

**Shell:** a dashboard layout with a collapsible sidebar that remembers its state. Its sections come from one navigation model in `@integr8/core`, filtered by the signed-in person's permissions.

**Preferences:** a language switch (English or Arabic) and a theme (light, dark or system).

### 6.3 Desktop — `apps/desktop`

**Built with:** Tauri 2 with a Rust core, React 19, Vite 8, React Router 8, Tailwind CSS 4, TanStack Query, and dnd-kit (drag-and-drop in the form builder). It also uses `@tauri-apps/plugin-updater` and Sentry for React (version 11, like the web app; the API uses Sentry 10).

**Rust dependencies:** `tauri`, `tauri-plugin-updater`, `serde`, `serde_json`, and `keyring`. `keyring` stores the session in the macOS Keychain, the Windows Credential Manager or the Linux Secret Service. Release builds are size-optimised: LTO, `opt-level = "s"`, symbols stripped, `panic = "abort"`.

**Two flavours from one codebase**

- **Integr8 Plus Staff** (`com.integr8.plus.staff`). For Integr8's own people. Staff sign in with their platform account (password and a six-digit code), pick a company and give a reason. They then work inside that company through an audited impersonation grant. This is where forms and job types are built and company branding is set.
- **Per-company app.** It carries the company's name, icon and colours, opens on that company's sign-in screen, and refuses anybody from another company.

**Screens:** dashboard, the form builder and its version history, fill a form, submissions, work orders, customers, sites, job types, imports, timesheets, and company branding (staff only).

**Desktop-only touches**

- A custom right-click menu on job, form, customer and site rows. It is permission-aware, works with the keyboard, and places itself correctly in right-to-left layouts.
- Automatic updates from signed release feeds.
- A strict content-security policy.

### 6.4 Mobile — `apps/mobile`

**Built with:** Expo SDK 58, React Native 0.88, Expo Router, and `expo-sqlite` for the local database, plus Sentry for React Native.

**Expo modules used**

| Module                                        | Used for                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `expo-background-task`, `expo-task-manager`   | Syncing in the background                                                                   |
| `expo-battery`, `expo-network`                | Deciding when to sync                                                                       |
| `expo-camera`                                 | Photos and barcode scanning                                                                 |
| `expo-image-picker`, `expo-image-manipulator` | Choosing and compressing photos                                                             |
| `expo-document-picker`                        | File uploads                                                                                |
| `expo-file-system`                            | Local file storage                                                                          |
| `expo-sharing`                                | Sharing files                                                                               |
| `expo-location`                               | GPS fields and where a form was submitted                                                   |
| `expo-notifications`                          | Push notifications about jobs                                                               |
| `expo-local-authentication`                   | App lock with fingerprint or face                                                           |
| `expo-secure-store`                           | Keeping the session secure                                                                  |
| `expo-crypto`                                 | Ids and hashing                                                                             |
| `expo-device`, `expo-constants`               | Device and build information                                                                |
| `expo-localization`                           | Device language and region                                                                  |
| `expo-updates`                                | Over-the-air updates per channel                                                            |
| `expo-web-browser`                            | Opening links                                                                               |
| `@expo/metro-runtime`                         | The Metro runtime Expo Router needs, installed directly at the version Expo 58.0.14 expects |
| `expo-status-bar`                             | Status bar                                                                                  |

**Other native libraries:**

- `react-native-svg` (signature pad and icons)
- `react-native-view-shot` (signature capture)
- `react-native-webview` (the company website screen)
- `@react-native-community/datetimepicker`
- `react-native-screens`
- `react-native-safe-area-context`

**Screens:** welcome (the company's website with a Login button), sign-in, home (today's jobs), job detail, job completion, form filling, customer, site, sync status, sync conflicts, and settings.

**Per-company builds:** each company's phone app is built from `company.json` (name, slug, colours, icon, website) by the "Build company apps" workflow on EAS. Each company gets its own update channel, so companies' apps install side by side. There is no staff login on the phone.

---

## 7. The shared packages

| Package                      | What it does                                                                                                                                                                                                                                                                                                                                                                                           | Third-party libraries                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `@integr8/core`              | Branded id types; roles and rank; the permission list and which roles hold what; token claims; the navigation model for web, desktop and platform; work-order state rules; job-execution rules; environment and app info                                                                                                                                                                               | zod                                                                                                      |
| `@integr8/db`                | The Kysely schema types; 23 SQL migrations and a migrator CLI (`up`, `down`, `status`, `deploy`); about 40 repositories (one per table area); data sources (tenant-scoped, auth, platform); demo seed; global form templates; integration test harness                                                                                                                                                 | kysely, pg, zod                                                                                          |
| `@integr8/auth`              | EdDSA-signed access tokens; refresh-token rotation with reuse detection; sessions and sign-out everywhere; password hashing with scrypt; password policy; TOTP second factor (RFC 6238); secrets encrypted with AES-256-GCM; Supabase Auth identity provider over HTTP; invitations; audited impersonation; platform (staff) sessions; key generation                                                  | jose, zod                                                                                                |
| `@integr8/api-client`        | The typed client generated from `openapi.json`; token storage; refresh on 401; session adoption                                                                                                                                                                                                                                                                                                        | openapi-fetch (runtime), openapi-typescript (generator)                                                  |
| `@integr8/form-engine`       | The form definition schema; 18 field types; conditional visibility; `requiredWhen`; dependent choices; calculated fields; expression evaluation; validation identical on client and server; decimal and date-time arithmetic; repeating groups; canonical JSON; version comparison; reporting helpers; global templates; conformance suites (including one that runs on Hermes, React Native's engine) | zod (tests: fast-check, esbuild, coverage-v8)                                                            |
| `@integr8/form-input`        | Turns what a person types or picks into answers: text, choices, files, signatures, repeating entries, prefill and error mapping. Shared by the web, desktop and phone renderers                                                                                                                                                                                                                        | —                                                                                                        |
| `@integr8/form-renderer-dom` | The form filler for web and desktop: widgets for every field type, repeating entries, media upload with client-side compression, answer view                                                                                                                                                                                                                                                           | React (peer), TanStack Query (peer)                                                                      |
| `@integr8/operations-dom`    | Customers, sites, work orders, crew, access notes, site map, timesheets: the screens web and desktop share                                                                                                                                                                                                                                                                                             | leaflet                                                                                                  |
| `@integr8/offline`           | The phone's SQLite database and migrations; the outbox; the sync engine; local search; eviction of old data; wipe on sign-out; tracking unsent work                                                                                                                                                                                                                                                    | —                                                                                                        |
| `@integr8/i18n`              | English and Arabic catalogues (identical keys, checked by a parity test); locale negotiation; direction (LTR/RTL); number, currency, date, time, list and relative-time formatting                                                                                                                                                                                                                     | i18next, react-i18next                                                                                   |
| `@integr8/tokens`            | Design tokens (palette, semantic colours for light and dark) emitted as CSS variables; turning a company's brand colour into an accessible palette                                                                                                                                                                                                                                                     | —                                                                                                        |
| `@integr8/eslint-config`     | Shared lint rules: TypeScript, React hooks, accessibility (jsx-a11y), Prettier compatibility, and a rule that allows only logical CSS properties so layouts flip for Arabic                                                                                                                                                                                                                            | @eslint/js, typescript-eslint, eslint-plugin-jsx-a11y, eslint-plugin-react-hooks, eslint-config-prettier |
| `@integr8/typescript-config` | Shared strict `tsconfig` presets                                                                                                                                                                                                                                                                                                                                                                       | —                                                                                                        |

---

## 8. The database

**Engine:** PostgreSQL 16, accessed through Kysely with node-postgres connection pools.

**Three database roles, three connections**

| Role              | Used by                                        | Can do                                                                                                                                                            |
| ----------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `integr8_app`     | Everyday API requests                          | Only what RLS allows for the company set on the transaction. It has no access at all to platform tables; the API refuses to start if it can read `platform_users` |
| `integr8_auth`    | Sign-in and sessions                           | The authentication tables only                                                                                                                                    |
| Owner (admin URL) | Migrations, the platform dashboard, the worker | Everything; bypasses RLS. Kept to a pool of 2 connections                                                                                                         |

**Migrations** (each has an `up.sql` and a `down.sql`; a test applies them all, rolls them all back, and applies them again)

| #    | Name                        | What it adds                                                                                                                                                                                                                                                                    |
| ---- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0001 | core_tenancy                | `tenants` (companies), `platform_users` (Integr8 staff), `tenant_users` (memberships with a role), `audit_log`. Passwords for company users live in Supabase Auth, not here                                                                                                     |
| 0002 | row_level_security          | RLS policies on every company table, and the runtime grants                                                                                                                                                                                                                     |
| 0003 | authentication              | `sessions`, `refresh_tokens`, `offline_grants`, `invitations`, `impersonation_grants`, `login_attempts`, `account_locks`                                                                                                                                                        |
| 0004 | api_infrastructure          | `idempotency_keys`, `jobs` (the background queue), `rate_limit_buckets`                                                                                                                                                                                                         |
| 0005 | membership_check_as_definer | Keeps Integr8 staff from ever becoming members of a company                                                                                                                                                                                                                     |
| 0006 | forms_and_versions          | `forms`, `form_versions` (immutable once published), `submissions` bound to one version                                                                                                                                                                                         |
| 0007 | form_builder                | `form_templates` (the global library), plus what the builder stores: drafts, fill roles, cloning                                                                                                                                                                                |
| 0008 | submissions_lifecycle       | `submission_events` (submit, reopen, amend history), `submission_values`, `media_objects`                                                                                                                                                                                       |
| 0009 | media_ledger                | `files` (every stored object), `upload_intents`, `tenant_storage`, `tenant_storage_usage`                                                                                                                                                                                       |
| 0010 | customers_sites_work_orders | `customers`, `customer_contacts`, `sites`, `job_types`, `job_type_forms`, `work_orders`, `work_order_counters`, `work_order_forms`, `work_order_checklist_items`, `work_order_assignments`, `work_order_comments`, `work_order_events`, `attachments`, `saved_views`, `imports` |
| 0011 | offline_sync                | `sync_touches` (what changed, for pulls), `sync_log_marks`, `sync_reports`                                                                                                                                                                                                      |
| 0012 | submit_location             | Where a form was submitted from                                                                                                                                                                                                                                                 |
| 0013 | job_execution               | When things happened on the phone (travel, arrival, completion), `shifts`, `push_devices`                                                                                                                                                                                       |
| 0014 | repeating_groups            | Repeatable sections stored as lists of entries with stable ids                                                                                                                                                                                                                  |
| 0015 | platform_admin              | Staff credentials (password and TOTP), `platform_sessions`, `platform_refresh_tokens`, `platform_audit_log`, `feature_flags`, `tenant_feature_flags`, `announcements`, `tenant_exports`, `tenant_deletions`, company suspension                                                 |
| 0016 | storage_metering            | `plan_allowances`, `tenant_storage_samples`, `storage_reconciliations` (against Cloudflare), `scheduled_task_runs`                                                                                                                                                              |
| 0017 | subscriptions_and_billing   | `subscriptions`, `billing_events`                                                                                                                                                                                                                                               |
| 0018 | signup_and_settings         | `signup_requests`, `signup_events` (the funnel), `tenant_settings` (logo, accent colour)                                                                                                                                                                                        |
| 0019 | signup_resend_limit         | A cap on resent verification links                                                                                                                                                                                                                                              |
| 0020 | signup_verifying_claim      | A signup is claimed before it is provisioned                                                                                                                                                                                                                                    |
| 0021 | billing_mode                | `self_serve` (pays in the app through Stripe) or `invoiced` (Integr8 invoices directly)                                                                                                                                                                                         |
| 0022 | company_branding            | Shell colour, default theme, website, app icon, and whether the company's own apps are built                                                                                                                                                                                    |
| 0023 | staff_management            | `can_manage_staff` (true only for terminal-made staff accounts) and who added each account                                                                                                                                                                                      |

**Integrity guarantees enforced in the database itself (not only in code)**

- Published form versions cannot be changed.
- An impersonation grant cannot exist without its audit entry: it has a foreign key to the audit row.
- The audit log is append-only.
- Branding images must belong to the same company.

A schema-invariants test suite checks these properties on every CI run.

---

## 9. Authentication, roles and security

**Company users**

- **Credentials:** Supabase Auth (GoTrue), called over HTTP, verifies passwords and magic links. The API then issues its own session.
- **Tokens:** short-lived access tokens (15 minutes by default) signed with **EdDSA**. Refresh tokens are opaque and single-use: each one is rotated on use, and reusing an old one ends the whole session. A session lasts at most 90 days.
- **Sign-in protection:** account lockout after repeated failures, a per-IP attempt limit, and a password policy.
- **Session management:** a person can switch between their companies, list their signed-in devices, and sign out one device or every device. Admins can revoke another member's sessions.
- **Offline grants:** phones receive a time-limited grant so they keep working without signal.

**Integr8 staff (the platform)**

- A separate account table (`platform_users`), a separate token type and a separate session. A platform token can never reach a company endpoint, and a company token can never reach a platform endpoint.
- **Password plus a six-digit TOTP code, always.** Passwords are hashed with scrypt. TOTP secrets are encrypted at rest with AES-256-GCM using `PLATFORM_SECRET_KEY`.
- Access tokens last 5 minutes; a session lasts at most 8 hours.
- **Staff managers:** only accounts created with the terminal command (`admin-cli create`) can add, reset or remove staff on the **Staff** screen. Accounts added from the dashboard can never manage staff, and terminal accounts can never be changed from the dashboard.
- **Impersonation** ("act as a company or a user") requires a written reason. It is recorded in the audit log _before_ access is granted, expires after an hour by default, is checked again on every request, and can be ended at once. A company can see every impersonation of it.

**Other protections**

- Row-level security (section 8).
- Idempotency keys.
- Rate limits.
- Upload size limits and storage quotas.
- Signed, expiring media links.
- Secret scanning in CI (gitleaks).
- Dependabot updates.
- A strict content-security policy on the desktop app.
- The audit log for both company actions and platform actions.
- Error reports carry no personal data. The API and web app set Sentry's `sendDefaultPii: false`; the desktop app, on Sentry 11, switches off each of its data-collection categories instead (user info, cookies, request headers, request bodies and URL query parameters), because Sentry 11 collects them all by default.

---

## 10. Features, area by area

### 10.1 Forms (form engine and builder)

- **18 field types:**
  - writing: text, long text, barcode;
  - measuring: number, decimal, rating;
  - scheduling: date, time, date-time;
  - choosing: dropdown, radio, multi-select, checkbox, yes/no (optionally with "not applicable");
  - evidence: signature, photo, file;
  - location: GPS.
- **Logic:**
  - conditional visibility;
  - `requiredWhen` (required only under a condition);
  - dependent choices (options that depend on an earlier answer);
  - calculated fields;
  - patterns;
  - minimum and maximum limits.
  - The builder's cards show each condition as a readable sentence.
- **Repeating groups:** sections that can be filled many times, such as one per room or one per appliance.
- **Drafts and versions:**
  - The draft autosaves.
  - Before publishing, it is checked and compared with the live version, and can be test-submitted without storing anything.
  - Publishing creates an immutable version, with a full version history.
- **Global template library:** Integr8 maintains starting templates; a company's form can be started from one.
- **Fill roles:** which roles may fill each form.
- **Built by Integr8 only:** the builder lives in the staff desktop app.

### 10.2 Submissions

- Answers autosave.
- Submit; reopen to correct; submit the correction. Every change is kept in the history.
- Where the form was submitted from is recorded.
- Search by form, person, job or date.
- Export one form's submissions as CSV.

### 10.3 Customers, sites and work orders

- **Customers:** contacts, tags, archiving.
- **Sites:** an address that is geocoded automatically, a map, access notes (shown first on a job), and attached files.
- **Work orders:**
  - a lifecycle of states with defined transitions;
  - a crew assignment;
  - a job type;
  - a checklist;
  - comments;
  - the customer's sign-off;
  - required or optional forms per job (the job's "tasks");
  - attachments.
- Bulk reassign, reschedule or cancel.
- Saved views (private or shared).
- **CSV import** of customers, sites and work orders, with templates, a description of each column, and per-row errors.

### 10.4 The engineer's day on the phone

- Today's jobs.
- Travel, arrive, work and complete, each time-stamped even when offline.
- Forms with photos, signatures, barcodes and GPS.
- The customer's sign-off.
- Shifts and time on jobs, which feed timesheets in the office.
- Push notifications when a job is assigned or changed.
- App lock with fingerprint or face.

### 10.5 Offline sync

- **Local data:** the phone keeps its jobs, forms and customers in SQLite.
- **Outbox:** every change is queued, folded together where possible, and sent in order with idempotency keys.
- **Pull and push:** the server sends what changed since the phone's cursor, merges what the phone pushes, and reports conflicts for the engineer to resolve.
- **Resumable media:** multipart uploads survive the app being killed.
- **Unsticking a company:** the platform dashboard can reset a company's sync.
- **Health reporting:** phones report how sync went, which the platform's Health page shows.

### 10.6 Media and storage

- **Storage:** Cloudflare R2, through the S3 API with presigned multipart uploads, or local disk.
- **Thumbnails:** generated with sharp.
- **Deletion:** a deleted file can be restored for a set number of days before it is purged.
- **Usage:** each company's storage use is metered daily and checked against Cloudflare's own numbers.
- **Quotas:** set per plan.

### 10.7 People and company settings

- Invite people, resend or withdraw invitations, change roles, suspend, remove, and revoke sessions.
- Company settings.
- An onboarding checklist, with sample data that can be added and removed.

### 10.8 Billing

- Plans with prices, limits and seats.
- Two billing modes:
  - **self-serve:** Stripe Checkout, the customer portal and invoices;
  - **invoiced:** Integr8 bills the company directly, and the app shows no payment screens.
- Stripe webhooks.
- A trial period.
- A grace period and dunning emails for failed payments.
- Limits are enforced by the API.

### 10.9 Branding and per-company apps

- Integr8 sets each company's:
  - logo;
  - square app icon;
  - accent and sidebar colours;
  - default theme;
  - website.
- Accessible palettes are generated from the brand colour.
- A public brand endpoint lets the build pipeline read a company's brand.
- The "Build company apps" workflow produces branded Windows, macOS and Linux installers and phone apps, published as a release named `company-<short name>-v<version>`.

### 10.10 The platform dashboard (Integr8 staff)

- **Companies**
  - Onboard a company in one step; the owner invitation can be sent later, once the company is ready.
  - A company page showing activity, invitations, errors, storage, impersonations and flags.
  - Change plan, seats and billing mode.
  - Suspend and reactivate.
  - Export everything.
  - Schedule a purge, or call it off.
  - Unlock a user; reset a company's phones.
- **Sign-up funnel** and where it leaks.
- **Storage** across the platform, and its likely cost.
- **Plans** and what each allows.
- **Audit log** search.
- **Feature flags:** a default, plus per-company overrides.
- **Announcements:** banners shown in every app.
- **Form templates:** the global library.
- **Releases:** which app versions are in the field.
- **Health:** what is failing quietly.
- **Staff:**
  - everybody who can sign in, visible to all staff;
  - staff managers add, reset and remove people, with credentials shown once.

---

## 11. The API, endpoint by endpoint

158 endpoints, grouped by their OpenAPI tag. The full machine-readable contract is `apps/api/openapi.json` (OpenAPI 3.0.3).

### authentication (7)

| Method | Path                           | What it does                               |
| ------ | ------------------------------ | ------------------------------------------ |
| POST   | `/v1/auth/magic-link`          | Send a one-time sign-in link               |
| POST   | `/v1/auth/magic-link/complete` | Exchange a magic-link token for a session  |
| POST   | `/v1/auth/refresh`             | Exchange a refresh token for a new pair    |
| POST   | `/v1/auth/sign-in`             | Sign in with an email address and password |
| POST   | `/v1/auth/sign-out`            | End this session, or every session         |
| POST   | `/v1/auth/switch-tenant`       | Move to another of your companies          |
| POST   | `/v1/invitations/accept`       | Accept an invitation and sign in           |

### billing (5)

| Method | Path                       | What it does                                            |
| ------ | -------------------------- | ------------------------------------------------------- |
| POST   | `/v1/billing/checkout`     | Begin paying for a plan                                 |
| GET    | `/v1/billing/invoices`     | The invoices this company has been sent                 |
| POST   | `/v1/billing/portal`       | Open the provider’s billing portal                      |
| GET    | `/v1/billing/subscription` | What this company is paying for, and what it is allowed |
| POST   | `/v1/billing/webhook`      | What the billing provider says happened                 |

### brand (4)

| Method | Path                                   | What it does                           |
| ------ | -------------------------------------- | -------------------------------------- |
| GET    | `/v1/build/companies`                  | The companies whose own apps are built |
| GET    | `/v1/public/companies/{slug}/app-icon` | A company’s app icon                   |
| GET    | `/v1/public/companies/{slug}/brand`    | A company’s brand, by its short name   |
| GET    | `/v1/public/companies/{slug}/logo`     | A company’s logo                       |

### customers (14)

| Method | Path                                              | What it does                                              |
| ------ | ------------------------------------------------- | --------------------------------------------------------- |
| POST   | `/v1/attachments`                                 | Attach an uploaded file to a customer, site or work order |
| DELETE | `/v1/attachments/{attachmentId}`                  | Take a file off a customer, site or work order            |
| GET    | `/v1/customer-tags`                               | Tags in use on customers                                  |
| GET    | `/v1/customers`                                   | Find customers                                            |
| POST   | `/v1/customers`                                   | Add a customer                                            |
| GET    | `/v1/customers/{customerId}`                      | A customer, with contacts, sites and recent jobs          |
| PATCH  | `/v1/customers/{customerId}`                      | Change a customer                                         |
| POST   | `/v1/customers/{customerId}/contacts`             | Add a contact to a customer                               |
| PATCH  | `/v1/customers/{customerId}/contacts/{contactId}` | Change or archive a contact                               |
| POST   | `/v1/customers/{customerId}/sites`                | Add a site to a customer                                  |
| GET    | `/v1/sites`                                       | Find sites                                                |
| GET    | `/v1/sites/{siteId}`                              | A site, its customer, contact, files and recent jobs      |
| PATCH  | `/v1/sites/{siteId}`                              | Change a site                                             |
| PUT    | `/v1/sites/{siteId}/access`                       | Correct a site’s access notes                             |

### forms (14)

| Method | Path                                       | What it does                                            |
| ------ | ------------------------------------------ | ------------------------------------------------------- |
| GET    | `/v1/form-templates`                       | The global template library                             |
| GET    | `/v1/form-templates/{key}`                 | One template, to preview                                |
| POST   | `/v1/form-templates/{key}/clone`           | Start a form from a template                            |
| GET    | `/v1/forms`                                | Forms in this company                                   |
| POST   | `/v1/forms`                                | Start a new form                                        |
| GET    | `/v1/forms/{formId}`                       | A form, its draft and its live version                  |
| PATCH  | `/v1/forms/{formId}`                       | Rename a form or change its settings                    |
| POST   | `/v1/forms/{formId}/clone`                 | Copy a form into a new one                              |
| PUT    | `/v1/forms/{formId}/draft`                 | Autosave the draft                                      |
| POST   | `/v1/forms/{formId}/draft/check`           | Validate the draft and compare it with the live version |
| POST   | `/v1/forms/{formId}/draft/publish`         | Publish the draft as a new, immutable version           |
| POST   | `/v1/forms/{formId}/draft/test-submission` | Submit a test fill of the draft, storing nothing        |
| GET    | `/v1/forms/{formId}/versions`              | Version history                                         |
| GET    | `/v1/forms/{formId}/versions/{versionId}`  | One version, read-only                                  |

### imports (5)

| Method | Path                           | What it does                                    |
| ------ | ------------------------------ | ----------------------------------------------- |
| GET    | `/v1/imports`                  | Recent imports                                  |
| POST   | `/v1/imports`                  | Import customers, sites or work orders from CSV |
| GET    | `/v1/imports/{importId}`       | An import’s progress and per-row errors         |
| GET    | `/v1/imports/columns/{kind}`   | What each column of an import means             |
| GET    | `/v1/imports/templates/{kind}` | The CSV template for an import                  |

### job-types (4)

| Method | Path                        | What it does                 |
| ------ | --------------------------- | ---------------------------- |
| GET    | `/v1/job-types`             | Job types                    |
| POST   | `/v1/job-types`             | Add a job type               |
| GET    | `/v1/job-types/{jobTypeId}` | A job type                   |
| PATCH  | `/v1/job-types/{jobTypeId}` | Change or archive a job type |

### media (9)

| Method | Path                           | What it does                                                |
| ------ | ------------------------------ | ----------------------------------------------------------- |
| POST   | `/v1/media`                    | Start uploading a file                                      |
| DELETE | `/v1/media/{mediaId}`          | Delete a file                                               |
| GET    | `/v1/media/{mediaId}`          | A link to read a stored file                                |
| PUT    | `/v1/media/{mediaId}`          | Start or resume uploading a file, by an id the client chose |
| POST   | `/v1/media/{mediaId}/complete` | Confirm an upload arrived                                   |
| GET    | `/v1/media/{mediaId}/parts`    | The parts of a file that have arrived                       |
| POST   | `/v1/media/{mediaId}/parts`    | Links to send parts of a file to                            |
| POST   | `/v1/media/{mediaId}/restore`  | Restore a deleted file                                      |
| GET    | `/v1/storage/usage`            | The company's storage use                                   |

### platform (45)

| Method | Path                                                                  | What it does                                                  |
| ------ | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| POST   | `/v1/platform/admins/{platformUserId}/second-factor/reset`            | Let a super admin enrol a new authenticator                   |
| GET    | `/v1/platform/announcements`                                          | Banners now showing, and the ones still to start              |
| POST   | `/v1/platform/announcements`                                          | Put a banner in front of everybody                            |
| POST   | `/v1/platform/announcements/{id}/end`                                 | Take a banner down                                            |
| GET    | `/v1/platform/audit`                                                  | Search the platform audit log                                 |
| POST   | `/v1/platform/auth/refresh`                                           | Exchange a platform refresh token for a new pair              |
| POST   | `/v1/platform/auth/sign-in`                                           | Sign in to the platform dashboard                             |
| POST   | `/v1/platform/auth/sign-out`                                          | End this platform session                                     |
| GET    | `/v1/platform/companies`                                              | Every company on the platform                                 |
| POST   | `/v1/platform/companies`                                              | Onboard a company, end to end                                 |
| GET    | `/v1/platform/companies/{tenantId}`                                   | One company, with its activity and flags                      |
| POST   | `/v1/platform/companies/{tenantId}/deletion`                          | Schedule this company to be purged                            |
| POST   | `/v1/platform/companies/{tenantId}/deletion/cancel`                   | Call off a scheduled purge                                    |
| GET    | `/v1/platform/companies/{tenantId}/errors`                            | Background work that failed for this company                  |
| GET    | `/v1/platform/companies/{tenantId}/exports`                           | Exports taken of this company                                 |
| POST   | `/v1/platform/companies/{tenantId}/exports`                           | Export everything this company has                            |
| PUT    | `/v1/platform/companies/{tenantId}/flags/{key}`                       | Turn a flag on or off for one company                         |
| POST   | `/v1/platform/companies/{tenantId}/impersonate`                       | Act as a user in this company                                 |
| POST   | `/v1/platform/companies/{tenantId}/impersonate/{grantId}/end`         | Stop acting as that user                                      |
| GET    | `/v1/platform/companies/{tenantId}/impersonations`                    | Every time somebody acted as a user in this company           |
| POST   | `/v1/platform/companies/{tenantId}/invitations/{invitationId}/resend` | Send somebody their invitation, or a fresh link to it         |
| PATCH  | `/v1/platform/companies/{tenantId}/plan`                              | Change a company’s plan, seat count or billing mode           |
| POST   | `/v1/platform/companies/{tenantId}/reactivate`                        | Start serving this company again                              |
| PATCH  | `/v1/platform/companies/{tenantId}/settings`                          | Change a company’s website, or whether its own apps are built |
| GET    | `/v1/platform/companies/{tenantId}/storage`                           | What this company is using, and whether the number is true    |
| POST   | `/v1/platform/companies/{tenantId}/suspend`                           | Stop serving this company                                     |
| POST   | `/v1/platform/companies/{tenantId}/sync/reset`                        | Unstick this company’s phones                                 |
| POST   | `/v1/platform/companies/{tenantId}/users/{userId}/unlock`             | Lift a lockout after too many failed sign-ins                 |
| GET    | `/v1/platform/deletions`                                              | Companies on their way out                                    |
| GET    | `/v1/platform/flags`                                                  | Every feature flag and its default                            |
| PUT    | `/v1/platform/flags/{key}`                                            | Declare a flag, or change what it does by default             |
| GET    | `/v1/platform/form-templates`                                         | The global form template library                              |
| GET    | `/v1/platform/form-templates/{key}`                                   | One template, with its definition                             |
| PUT    | `/v1/platform/form-templates/{key}`                                   | Add a template, or replace one                                |
| GET    | `/v1/platform/funnel`                                                 | The signup funnel, and where it leaks                         |
| GET    | `/v1/platform/health`                                                 | What is failing quietly                                       |
| GET    | `/v1/platform/me`                                                     | Who this platform session belongs to                          |
| GET    | `/v1/platform/plans`                                                  | What each plan allows                                         |
| PATCH  | `/v1/platform/plans/{plan}`                                           | Change what a plan allows                                     |
| GET    | `/v1/platform/releases`                                               | Which app versions are live in the field                      |
| GET    | `/v1/platform/staff`                                                  | Everybody who can sign in to the dashboard                    |
| POST   | `/v1/platform/staff`                                                  | Give somebody a dashboard account                             |
| DELETE | `/v1/platform/staff/{platformUserId}`                                 | Take somebody off the staff                                   |
| POST   | `/v1/platform/staff/{platformUserId}/credentials`                     | Give a staff member a new password and second factor          |
| GET    | `/v1/platform/storage`                                                | Platform-wide storage, and what it is likely to cost          |

### signup (5)

| Method | Path                | What it does                           |
| ------ | ------------------- | -------------------------------------- |
| GET    | `/v1/plans`         | What each plan costs and allows        |
| POST   | `/v1/signup`        | Ask for a company                      |
| POST   | `/v1/signup/resend` | Send the verification link again       |
| POST   | `/v1/signup/step`   | Record a step of the signup funnel     |
| POST   | `/v1/signup/verify` | Prove the address, and get the company |

### submissions (7)

| Method | Path                                     | What it does                                          |
| ------ | ---------------------------------------- | ----------------------------------------------------- |
| GET    | `/v1/submissions`                        | Find submissions                                      |
| POST   | `/v1/submissions`                        | Start filling a form                                  |
| GET    | `/v1/submissions/{submissionId}`         | A submission, the version it answers, and its history |
| PUT    | `/v1/submissions/{submissionId}/answers` | Autosave answers                                      |
| POST   | `/v1/submissions/{submissionId}/reopen`  | Reopen a submission to correct it                     |
| POST   | `/v1/submissions/{submissionId}/submit`  | Submit, or submit a correction                        |
| GET    | `/v1/submissions/export`                 | Export submissions of one form as CSV                 |

### sync (3)

| Method | Path               | What it does                           |
| ------ | ------------------ | -------------------------------------- |
| GET    | `/v1/sync/pull`    | What changed for me since my last pull |
| POST   | `/v1/sync/push`    | Apply changes made offline             |
| POST   | `/v1/sync/reports` | Report how sync went on this phone     |

### time (3)

| Method | Path                            | What it does                             |
| ------ | ------------------------------- | ---------------------------------------- |
| PUT    | `/v1/me/push-device`            | Receive push notifications on this phone |
| POST   | `/v1/me/push-device/unregister` | Stop push notifications to this phone    |
| GET    | `/v1/timesheets`                | Shifts and time on jobs in a window      |

### work-orders (16)

| Method | Path                                               | What it does                                            |
| ------ | -------------------------------------------------- | ------------------------------------------------------- |
| GET    | `/v1/saved-views`                                  | Saved views: one’s own and those shared by colleagues   |
| POST   | `/v1/saved-views`                                  | Save the current filters as a view                      |
| DELETE | `/v1/saved-views/{viewId}`                         | Delete one of your saved views                          |
| GET    | `/v1/work-orders`                                  | Find work orders                                        |
| POST   | `/v1/work-orders`                                  | Create a work order                                     |
| GET    | `/v1/work-orders/{workOrderId}`                    | A work order, with its site access notes first          |
| PATCH  | `/v1/work-orders/{workOrderId}`                    | Change a work order                                     |
| POST   | `/v1/work-orders/{workOrderId}/checklist`          | Add a checklist item to one job                         |
| PATCH  | `/v1/work-orders/{workOrderId}/checklist/{itemId}` | Tick or untick a checklist item                         |
| POST   | `/v1/work-orders/{workOrderId}/comments`           | Comment on a job                                        |
| PUT    | `/v1/work-orders/{workOrderId}/crew`               | Assign the crew                                         |
| POST   | `/v1/work-orders/{workOrderId}/forms`              | Add a form to one job, or change whether it is required |
| DELETE | `/v1/work-orders/{workOrderId}/forms/{formId}`     | Take a form off one job                                 |
| PUT    | `/v1/work-orders/{workOrderId}/signoff`            | Record the customer’s sign-off on a job                 |
| POST   | `/v1/work-orders/{workOrderId}/transitions`        | Move a work order to another state                      |
| POST   | `/v1/work-orders/bulk`                             | Reassign, reschedule or cancel many work orders         |

### workspace (17)

| Method | Path                                            | What it does                              |
| ------ | ----------------------------------------------- | ----------------------------------------- |
| GET    | `/v1/me`                                        | The signed-in person and what they may do |
| GET    | `/v1/members`                                   | People in this company                    |
| DELETE | `/v1/members/{userId}`                          | Remove somebody from this company         |
| PATCH  | `/v1/members/{userId}/role`                     | Change what somebody may do               |
| POST   | `/v1/members/{userId}/sessions/revoke`          | Sign one person out of every device       |
| PATCH  | `/v1/members/{userId}/status`                   | Suspend somebody, or let them back in     |
| GET    | `/v1/members/invitations`                       | Invitations not yet accepted              |
| POST   | `/v1/members/invitations`                       | Invite somebody to this company           |
| DELETE | `/v1/members/invitations/{invitationId}`        | Withdraw an invitation                    |
| POST   | `/v1/members/invitations/{invitationId}/resend` | Send an invitation again                  |
| GET    | `/v1/onboarding`                                | What this company has set up so far       |
| DELETE | `/v1/onboarding/demo`                           | Take the sample data away                 |
| POST   | `/v1/onboarding/demo`                           | Put some sample data in                   |
| GET    | `/v1/sessions`                                  | Devices signed in to this company         |
| DELETE | `/v1/sessions/{sessionId}`                      | Sign a device out                         |
| GET    | `/v1/settings`                                  | How this company works                    |
| PATCH  | `/v1/settings`                                  | Change how this company works             |

**Health endpoints (outside `/v1`)**

| Method | Path                  | What it does                                       |
| ------ | --------------------- | -------------------------------------------------- |
| GET    | `/health`             | The process is alive                               |
| GET    | `/health/ready`       | The database answers                               |
| GET    | `/health/probe-error` | Throws on purpose, to prove Sentry receives errors |

---

## 12. Background work

The worker (`node dist/jobs/worker-main.js`) runs the same code as the API. It claims jobs from the Postgres `jobs` table using leases, retries failures with exponential backoff, and fences a lease so two workers never finish the same job. A job that keeps failing is dead-lettered and shown on the platform Health page.

| Queue                   | What it does                                                |
| ----------------------- | ----------------------------------------------------------- |
| `audit.record`          | Writes audit entries off the request path                   |
| `media.thumbnail`       | Makes image thumbnails with sharp                           |
| `import.run`            | Runs a CSV import and records per-row errors                |
| `site.geocode`          | Turns a site's address into coordinates through Mapbox      |
| `push.work_order_event` | Sends a push notification when a job is assigned or changed |
| `push.receipts`         | Checks Expo's delivery receipts and drops dead devices      |
| `tenant.export`         | Exports everything a company has                            |
| `tenant.purge`          | Deletes a company once its scheduled deletion date passes   |

The worker also runs scheduled maintenance, recorded in `scheduled_task_runs`:

- media maintenance: purging expired deleted files and abandoned uploads;
- daily storage samples, and the reconciliation against Cloudflare;
- trimming the sync log;
- expiring old signups;
- billing dunning.

---

## 13. External services

| Service                                 | Used for                                                            | How it is called                                  | Switch                                           |
| --------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------ |
| **Supabase Auth** (GoTrue), self-hosted | Company users' passwords and 6-digit sign-in codes (P36)            | HTTP, no SDK                                      | `SUPABASE_AUTH_URL`, `SUPABASE_SERVICE_ROLE_KEY` |
| **Cloudflare R2**                       | File storage                                                        | AWS SDK v3 S3 client, presigned multipart uploads | `MEDIA_STORAGE=r2` or `local`                    |
| **Cloudflare GraphQL API**              | Checking storage use against Cloudflare's numbers                   | `api.cloudflare.com/client/v4/graphql`            | `CLOUDFLARE_API_TOKEN`                           |
| **Stripe**                              | Checkout, customer portal, invoices, webhooks                       | REST (`api.stripe.com/v1`), no SDK                | `BILLING_PROVIDER`                               |
| **Resend**                              | Email: invitations, verification, dunning                           | REST (`api.resend.com/emails`)                    | `EMAIL_SENDER`                                   |
| **Mapbox**                              | Geocoding addresses; map tiles                                      | Geocoding v6 REST                                 | `GEOCODER`, `MAPBOX_ACCESS_TOKEN`                |
| **OpenStreetMap**                       | Map tiles in Leaflet                                                | Tile server                                       | —                                                |
| **Expo Push**                           | Phone notifications                                                 | `exp.host/--/api/v2/push`                         | `PUSH_SENDER`, `EXPO_ACCESS_TOKEN`               |
| **Expo Application Services**           | Building and updating the phone apps                                | EAS Build and EAS Update                          | GitHub secrets                                   |
| **Sentry**                              | Errors and traces from every app, with release tags and source maps | Official SDKs                                     | `SENTRY_DSN`, `WEB_SENTRY_DSN`                   |
| **GitHub**                              | Code, CI/CD, container registry, release downloads                  | GitHub Actions, GHCR                              | —                                                |

Every external service has a **recording** or **local** stand-in for development and tests: a recording email sender, a recording billing provider, local-disk media, and a recording push sender. The whole system therefore runs and is tested with no accounts at all. In `production` mode the API refuses to start unless every real service is configured.

---

## 14. Languages and right-to-left

- **Languages:** English and Arabic, both complete. A parity test fails the build if a key exists in one catalogue and not the other. Arabic plurals use all six forms.
- **Direction follows the language.** Arabic switches the whole interface to right-to-left on web, desktop and phone.
- **Layouts flip correctly** because only logical CSS properties are allowed (`ms-`, `me-`, `ps-`, `pe-`, `start`, `end`), enforced by a lint rule. Arrows and the right-click menu flip too.
- **Formatting:** numbers, currency, dates, times, lists and relative times follow the locale, through `Intl`.
- **Server messages:** server error messages are never shown to people. Each error's `code` maps to a translated message.

---

## 15. Testing and code quality

| Kind                 | Tool                                                | Scope                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests           | Vitest 5                                            | 108 test files across every package and app                                                                                                                                                    |
| Integration tests    | Vitest against a real PostgreSQL 16                 | 39 files: every API area, RLS isolation, migrations up, down and up again, schema invariants, sessions, impersonation, sync, billing, media (local and R2), storage metering, the staff screen |
| Property-based tests | fast-check                                          | Form-engine logic, repeating entries                                                                                                                                                           |
| Conformance suites   | Golden files; the Hermes engine                     | The form engine gives identical results in Node and in React Native's JavaScript engine                                                                                                        |
| Component tests      | Testing Library, jsdom, user-event, jest-dom        | Form filler, widgets, operations screens                                                                                                                                                       |
| Accessibility tests  | axe-core                                            | Rendered screens are checked for accessibility violations                                                                                                                                      |
| Contract test        | OpenAPI test                                        | Every route is documented; public routes never answer 401; the generated client matches the API                                                                                                |
| Type checking        | TypeScript 6, strict                                | Every workspace                                                                                                                                                                                |
| Linting              | ESLint 10, typescript-eslint, jsx-a11y, react-hooks | Every workspace                                                                                                                                                                                |
| Formatting           | Prettier 3                                          | Checked in CI                                                                                                                                                                                  |
| Secret scanning      | gitleaks                                            | Every pull request                                                                                                                                                                             |
| Commit messages      | commitlint (Conventional Commits)                   | Every pull request                                                                                                                                                                             |

A full review of the codebase was done in October 2026 and its fixes were applied; see `docs/review-2026-10.md`.

---

## 16. Continuous integration and releases

**Branch flow:** any branch → `dev` → `staging` → `main`. The `Branch policy` workflow and GitHub rulesets enforce it.

| Workflow                                | Runs on                                                       | What it does                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci.yml` (CI)                           | Every pull request                                            | Verification (typecheck, lint, unit tests, format, OpenAPI drift), commit-message check, form-engine conformance on Hermes, database integration suites on a Postgres service container, secret scan |
| `verify.yml` (Verify)                   | Called by the three branch workflows                          | The shared verification, in one place, so every build checks the same things                                                                                                                         |
| `branch-policy.yml`                     | Pull requests and pushes                                      | Refuses pull requests from the wrong branch and direct pushes                                                                                                                                        |
| `release-dev.yml` (Dev build)           | Merge into `dev`                                              | Builds and tests the integrated result; ships nothing                                                                                                                                                |
| `release-staging.yml` (Nightly release) | Merge into `staging`                                          | Builds everything and publishes a nightly release                                                                                                                                                    |
| `release-main.yml` (Version release)    | Merge into `main`                                             | Builds everything, builds every company's apps, and publishes a release named after the `package.json` version                                                                                       |
| `build-release-artifacts.yml`           | Called by the releases                                        | Server images, desktop installers (Windows `.msi` and `.exe`, macOS `.dmg`, Linux `.deb` and `.AppImage`), phone builds                                                                              |
| `build-company-apps.yml`                | By hand for one company or `all`, and by each version release | Reads the company's brand from the API; builds its branded desktop installers and phone app; publishes `company-<slug>-v<version>`                                                                   |
| `publish-images.yml`                    | Merges into `staging` and `main`                              | Publishes the API and web images to GitHub Container Registry                                                                                                                                        |

**Dependabot** keeps dependencies current. A pull request template is in `.github/pull_request_template.md`.

---

## 17. Deployment

**Containers** (`deploy/compose.yml`)

| Service     | Image                                            | Role                                     |
| ----------- | ------------------------------------------------ | ---------------------------------------- |
| `postgres`  | `postgres:16`                                    | The database, on a named volume          |
| `bootstrap` | API image                                        | Creates the database roles once          |
| `migrate`   | API image                                        | Applies migrations before the API starts |
| `api`       | API image (`node:22-bookworm-slim`, multi-stage) | The API on port 3000                     |
| `worker`    | API image                                        | Background jobs                          |
| `web`       | Web image                                        | The Next.js app                          |

**Hosting options documented and supported**

- **A VPS** (the main path; Oracle Cloud's Always Free ARM machine in the deployment guide). `deploy/vps/setup.sh` prepares a fresh Ubuntu, Debian or Oracle Linux machine:
  - opens ports 80 and 443 in the machine's firewall;
  - installs Docker and Compose from Docker's own repository;
  - installs Caddy, which obtains and renews TLS certificates by itself;
  - turns on automatic security updates.
  - It is safe to run twice. `Caddyfile.example` serves the API and web on two names. `backup-postgres.sh` takes database backups.
- **Everything self-hosted** (P36): the bundled Postgres is the database, and sign-in is a Supabase Auth container in the same stack. Railway and the move to a Supabase cloud database were dropped.
- **ZimaOS** at home, as a test box (covered in the deployment guide).

**Staff accounts on a server** are created with:

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env \
  run --rm api node dist/platform/admin-cli.js create you@example.com "Your Name"
```

A step-by-step deployment guide, "From zero to a running deployment", is published separately as an interactive checklist.

---

## 18. Configuration

All configuration is through environment variables, each validated with zod at start-up. A missing or malformed value stops the process with a clear message.

| Area                    | Variables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Environment and release | `APP_ENV` (development, test, staging, production), `API_RELEASE`, `APP_VERSION`, `HOST`, `PORT`, `API_PUBLIC_URL`, `WEB_APP_URL`                                                                                                                                                                                                                                                                                                                                                          |
| HTTP                    | `API_CORS_ORIGINS`, `API_MAX_BODY_BYTES`, `API_IDEMPOTENCY_TTL_SECONDS`, `API_IP_RATE_LIMIT`, `API_IP_RATE_WINDOW_SECONDS`, `API_TENANT_RATE_LIMIT`, `API_TENANT_RATE_WINDOW_SECONDS`, `API_MIN_SUPPORTED_CLIENT`, `API_UPDATE_URL`                                                                                                                                                                                                                                                        |
| Database                | `DATABASE_URL`, `DATABASE_URL_AUTH`, `DATABASE_URL_ADMIN`, `DB_POOL_MAX`, `DB_AUTH_POOL_MAX`, `DB_POOL_IDLE_MS`, `DB_POOL_ACQUIRE_TIMEOUT_MS`, `DB_STATEMENT_TIMEOUT_MS`, `DB_TENANT_CACHE_MAX`, `DB_TENANT_CACHE_IDLE_MS`                                                                                                                                                                                                                                                                 |
| Company sign-in         | `AUTH_SIGNING_KEY`, `AUTH_SIGNING_KEY_ID`, `AUTH_VERIFICATION_KEYS`, `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_ACCESS_TOKEN_TTL_SECONDS`, `AUTH_REFRESH_TOKEN_TTL_SECONDS`, `AUTH_SESSION_MAX_TTL_SECONDS`, `AUTH_OFFLINE_GRANT_TTL_SECONDS`, `AUTH_INVITATION_TTL_SECONDS`, `AUTH_IMPERSONATION_TTL_SECONDS`, `AUTH_LOCKOUT_THRESHOLD`, `AUTH_LOCKOUT_WINDOW_SECONDS`, `AUTH_LOCKOUT_DURATION_SECONDS`, `AUTH_IP_ATTEMPT_LIMIT`, `AUTH_IP_ATTEMPT_WINDOW_SECONDS`, `AUTH_MIN_PASSWORD_LENGTH` |
| Staff sign-in           | `PLATFORM_SECRET_KEY`, `PLATFORM_ACCESS_TOKEN_TTL_SECONDS`, `PLATFORM_REFRESH_TOKEN_TTL_SECONDS`, `PLATFORM_SESSION_TTL_SECONDS`, `PLATFORM_LOCKOUT_THRESHOLD`, `PLATFORM_LOCKOUT_DURATION_SECONDS`                                                                                                                                                                                                                                                                                        |
| Signup                  | `PUBLIC_SIGNUP` (off by default)                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Media                   | `MEDIA_STORAGE`, `MEDIA_LOCAL_DIR`, `MEDIA_MAX_BYTES`, `MEDIA_RESTORE_DAYS`, `MEDIA_URL_SECRET`, `MEDIA_MAINTENANCE_INTERVAL_SECONDS`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_PREFIX`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`                                                                                                                                                                                                                      |
| Billing                 | `BILLING_PROVIDER`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `BILLING_RETURN_URL`, `BILLING_TRIAL_DAYS`, `BILLING_GRACE_DAYS`                                                                                                                                                                                                                                                                                                                                                         |
| Email                   | `EMAIL_SENDER`, `EMAIL_FROM`, `RESEND_API_KEY`                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Maps                    | `GEOCODER`, `MAPBOX_ACCESS_TOKEN`                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Push                    | `PUSH_SENDER`, `EXPO_ACCESS_TOKEN`                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Sync                    | `SYNC_REPLAY_DAYS`, `SYNC_LOG_RETENTION_DAYS`                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Worker                  | `WORKER_BATCH_SIZE`, `WORKER_IDLE_POLL_MS`, `WORKER_LEASE_MS`, `WORKER_RETRY_BASE_MS`, `WORKER_RETRY_MAX_MS`                                                                                                                                                                                                                                                                                                                                                                               |
| Company app builds      | `BUILD_TOKEN`                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Errors                  | `SENTRY_DSN`, `SENTRY_TRACES_SAMPLE_RATE`, plus `WEB_SENTRY_DSN` and `WEB_PUBLIC_SENTRY_DSN` for the web app                                                                                                                                                                                                                                                                                                                                                                               |

---

## 19. Documentation in the repository

| File                                                                                                | Covers                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                                                                                         | The whole product, every app, how to run it                                                                                                                                      |
| `CONTRIBUTING.md`, `docs/contributing/branching.md`                                                 | How to contribute; the branch flow                                                                                                                                               |
| `AGENTS.md`                                                                                         | Written by Turborepo 2.11 for AI coding agents: read the installed Turborepo's own docs before changing its configuration. `"agentGuidance": false` in `turbo.json` turns it off |
| `docs/api/README.md`, `docs/api/versioning.md`                                                      | API conventions and versioning rules                                                                                                                                             |
| `docs/auth/README.md`, `self-hosted-auth.md`, `offline-access.md`                                   | Sessions, tokens, offline grants, and the self-hosted Auth                                                                                                                       |
| `docs/database/README.md`, `migrations.md`, `runbook-backup-and-restore.md`                         | Schema, migration rules, backups                                                                                                                                                 |
| `docs/form-engine/README.md`, `builder.md`, `repeating-groups.md`, `submissions.md`                 | The form engine                                                                                                                                                                  |
| `docs/media/README.md`                                                                              | Uploads, storage, quotas                                                                                                                                                         |
| `docs/sync/README.md`                                                                               | Offline sync                                                                                                                                                                     |
| `docs/mobile/README.md`, `company-builds.md`, `device-checklist.md`, `forms.md`, `job-execution.md` | The phone app                                                                                                                                                                    |
| `docs/operations/README.md`                                                                         | Customers, sites, work orders                                                                                                                                                    |
| `docs/billing/README.md`                                                                            | Plans, Stripe, invoiced companies                                                                                                                                                |
| `docs/onboarding/README.md`                                                                         | Signup and onboarding                                                                                                                                                            |
| `docs/platform/README.md`                                                                           | The platform dashboard, including Staff                                                                                                                                          |
| `docs/deployment/README.md`, `company-apps.md`                                                      | Deploying, and per-company apps                                                                                                                                                  |
| `docs/ui/README.md`                                                                                 | Design tokens, shell, right-to-left rules                                                                                                                                        |
| `docs/review-2026-10.md`                                                                            | The October 2026 code review and its fixes                                                                                                                                       |
| `plan/README.md`, `plan/ROADMAP.md`, `plan/*/P*.md`                                                 | The phased plan                                                                                                                                                                  |

---

## 20. Roadmap: what is done and what is not

The plan (`plan/ROADMAP.md`) is a ladder of versions, each answering one question. Each phase file carries its own status line.

| Version               | Question                                       | Phases                                                                                                                                                                 | State                                                                                                                                          |
| --------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.1 Foundation       | Can we build safely on this?                   | P01 monorepo · P02 database and multi-tenancy · P03 authentication and roles · P04 API skeleton · P05 application shells                                               | Built. P01 is marked complete; the others are marked in progress                                                                               |
| v0.2 Form Engine      | Can a non-developer build a form that works?   | P06 schema and logic · P07 builder · P08 renderer and submissions · P09 media on R2                                                                                    | Built. P08 complete; P09 awaits a run against real R2                                                                                          |
| v0.3 Field Loop       | Does it work in a basement with no signal?     | P10 customers, sites, work orders · P11 mobile shell and local database · P12 offline sync · P13 mobile forms · P13b repeating groups · P14 job execution              | Built and verified off-device; each awaits its on-phone checklist                                                                              |
| v1.0 Launch           | Will someone pay for it?                       | P15 platform dashboard · P16 storage metering · P17 billing · P18 marketing and onboarding · P19 production hardening · P20 packaging and signing · P21 first customer | P15–P19 built (waiting on real Cloudflare and Stripe runs); P20 and P21 not started (installers are not yet code-signed)                       |
| v1.1 Inventory        | Can they stop using their spreadsheet?         | P22–P24                                                                                                                                                                | Not started                                                                                                                                    |
| v1.2 Scheduling       | Can the dispatcher run their whole day here?   | P25–P27                                                                                                                                                                | Not started                                                                                                                                    |
| v1.3 Reporting and AI | Why would they renew?                          | P28–P31                                                                                                                                                                | Not started                                                                                                                                    |
| v2.0 Scale            | Can we sell to a company with a security team? | P32 Arabic and RTL · P33 public API · P34 enterprise access · P35 dedicated instances                                                                                  | P32's substance is done (complete Arabic catalogue, right-to-left everywhere) even though its file still says not started; P33–P35 not started |

**Built beyond the original phase list** (from the review and later requests):

- forms and job types managed by Integr8 only;
- public sign-up switched off, with onboarding from the dashboard;
- a billing mode per company;
- staff sign-in to the desktop app through audited impersonation;
- company branding set by Integr8;
- staff and per-company desktop flavours, and per-company phone apps;
- the dashboard shell with a collapsible sidebar;
- form-builder rules (`requiredWhen`, dependent choices, readable conditions);
- forms attached to a job;
- back navigation on nested screens;
- the desktop right-click menu;
- owner invitations sent when the company is ready;
- the Staff screen.

---

## Appendix A: every library, by package, with versions

Versions are exactly as pinned in each `package.json`. "Runtime" libraries ship with the app; "development" libraries are used to build and test it; "peer" libraries must be provided by the app using the package. Packages from this repository (`@integr8/*`) are listed separately at the top of each entry.

**Desktop native (Rust, `apps/desktop/src-tauri/Cargo.toml`)**

| Crate                                                               | Version | Used for                                                       |
| ------------------------------------------------------------------- | ------- | -------------------------------------------------------------- |
| `tauri`                                                             | 2       | The desktop shell                                              |
| `tauri-build`                                                       | 2       | Build step                                                     |
| `tauri-plugin-updater`                                              | 2       | Signed automatic updates                                       |
| `serde` (with `derive`)                                             | 1       | Serialisation                                                  |
| `serde_json`                                                        | 1       | JSON                                                           |
| `keyring` (`apple-native`, `windows-native`, `sync-secret-service`) | 3       | Storing the session in the operating system's credential store |

**JavaScript and TypeScript, by workspace**

### `integr8-plus` — repository root

Tooling shared by the whole monorepo. Workspace packages used: `@integr8/eslint-config`

| Library                           | Version | Kind        |
| --------------------------------- | ------- | ----------- |
| `@commitlint/cli`                 | 21.2.3  | development |
| `@commitlint/config-conventional` | 21.2.3  | development |
| `eslint`                          | 10.12.0 | development |
| `husky`                           | 9.1.7   | development |
| `lint-staged`                     | 17.6.0  | development |
| `prettier`                        | 3.9.9   | development |
| `turbo`                           | 2.11.7  | development |
| `typescript`                      | 6.0.3   | development |

### `@integr8/api` — `apps/api`

Workspace packages used: `@integr8/auth`, `@integr8/core`, `@integr8/db`, `@integr8/form-engine`, `@integr8/api-client`, `@integr8/eslint-config`, `@integr8/form-input`, `@integr8/offline`, `@integr8/typescript-config`

| Library                         | Version  | Kind        |
| ------------------------------- | -------- | ----------- |
| `@aws-sdk/client-s3`            | 3.1149.0 | runtime     |
| `@aws-sdk/s3-request-presigner` | 3.1149.0 | runtime     |
| `@sentry/node`                  | 10.74.0  | runtime     |
| `fastify`                       | 5.12.3   | runtime     |
| `sharp`                         | 0.35.4   | runtime     |
| `zod`                           | 4.6.1    | runtime     |
| `@types/node`                   | 26.6.5   | development |
| `eslint`                        | 10.12.0  | development |
| `tsx`                           | 4.23.13  | development |
| `typescript`                    | 6.0.3    | development |
| `vitest`                        | 5.0.3    | development |

### `@integr8/desktop` — `apps/desktop`

Workspace packages used: `@integr8/api-client`, `@integr8/core`, `@integr8/form-engine`, `@integr8/form-renderer-dom`, `@integr8/i18n`, `@integr8/operations-dom`, `@integr8/tokens`, `@integr8/eslint-config`, `@integr8/typescript-config`

| Library                      | Version | Kind        |
| ---------------------------- | ------- | ----------- |
| `@dnd-kit/core`              | 6.3.1   | runtime     |
| `@dnd-kit/sortable`          | 10.0.0  | runtime     |
| `@dnd-kit/utilities`         | 3.2.2   | runtime     |
| `@sentry/react`              | 11.1.0  | runtime     |
| `@tanstack/react-query`      | 5.102.8 | runtime     |
| `@tauri-apps/api`            | 2.12.0  | runtime     |
| `@tauri-apps/plugin-updater` | 2.11.0  | runtime     |
| `react`                      | 19.3.0  | runtime     |
| `react-dom`                  | 19.3.0  | runtime     |
| `react-router`               | 8.3.1   | runtime     |
| `@tailwindcss/vite`          | 4.3.3   | development |
| `@tauri-apps/cli`            | 2.11.4  | development |
| `@types/node`                | 26.6.5  | development |
| `@types/react`               | 19.3.0  | development |
| `@types/react-dom`           | 19.3.0  | development |
| `@vitejs/plugin-react`       | 6.1.1   | development |
| `eslint`                     | 10.12.0 | development |
| `tailwindcss`                | 4.3.3   | development |
| `typescript`                 | 6.0.3   | development |
| `vite`                       | 8.2.2   | development |
| `vitest`                     | 5.0.3   | development |

### `@integr8/mobile` — `apps/mobile`

Workspace packages used: `@integr8/api-client`, `@integr8/core`, `@integr8/form-engine`, `@integr8/form-input`, `@integr8/i18n`, `@integr8/offline`, `@integr8/tokens`, `@integr8/eslint-config`, `@integr8/typescript-config`

| Library                                  | Version | Kind        |
| ---------------------------------------- | ------- | ----------- |
| `@expo/metro-runtime`                    | 58.0.14 | runtime     |
| `@react-native-community/datetimepicker` | 9.2.1   | runtime     |
| `@sentry/react-native`                   | 8.28.0  | runtime     |
| `expo`                                   | 58.0.14 | runtime     |
| `expo-background-task`                   | 58.0.11 | runtime     |
| `expo-battery`                           | 58.0.3  | runtime     |
| `expo-camera`                            | 58.0.10 | runtime     |
| `expo-constants`                         | 58.0.12 | runtime     |
| `expo-crypto`                            | 58.0.7  | runtime     |
| `expo-device`                            | 58.0.5  | runtime     |
| `expo-document-picker`                   | 58.0.4  | runtime     |
| `expo-file-system`                       | 58.0.9  | runtime     |
| `expo-image-manipulator`                 | 58.0.14 | runtime     |
| `expo-image-picker`                      | 58.0.10 | runtime     |
| `expo-local-authentication`              | 58.0.2  | runtime     |
| `expo-localization`                      | 58.0.4  | runtime     |
| `expo-location`                          | 58.0.17 | runtime     |
| `expo-network`                           | 58.0.3  | runtime     |
| `expo-notifications`                     | 58.1.5  | runtime     |
| `expo-router`                            | 58.0.23 | runtime     |
| `expo-secure-store`                      | 58.0.2  | runtime     |
| `expo-sharing`                           | 58.0.19 | runtime     |
| `expo-sqlite`                            | 58.0.13 | runtime     |
| `expo-status-bar`                        | 58.0.3  | runtime     |
| `expo-task-manager`                      | 58.0.12 | runtime     |
| `expo-updates`                           | 58.0.17 | runtime     |
| `expo-web-browser`                       | ~58.0.6 | runtime     |
| `react`                                  | 19.3.0  | runtime     |
| `react-dom`                              | 19.3.0  | runtime     |
| `react-native`                           | 0.88.0  | runtime     |
| `react-native-safe-area-context`         | 5.10.1  | runtime     |
| `react-native-screens`                   | 4.30.0  | runtime     |
| `react-native-svg`                       | 15.16.0 | runtime     |
| `react-native-view-shot`                 | 6.1.1   | runtime     |
| `react-native-webview`                   | 14.0.1  | runtime     |
| `@types/node`                            | 26.6.5  | development |
| `@types/react`                           | 19.3.0  | development |
| `eslint`                                 | 10.12.0 | development |
| `typescript`                             | 6.0.3   | development |
| `vitest`                                 | 5.0.3   | development |

### `@integr8/web` — `apps/web`

Workspace packages used: `@integr8/api-client`, `@integr8/core`, `@integr8/form-engine`, `@integr8/form-renderer-dom`, `@integr8/i18n`, `@integr8/operations-dom`, `@integr8/tokens`, `@integr8/eslint-config`, `@integr8/typescript-config`

| Library                 | Version | Kind        |
| ----------------------- | ------- | ----------- |
| `@sentry/nextjs`        | 11.7.0  | runtime     |
| `@tanstack/react-query` | 5.102.8 | runtime     |
| `next`                  | 16.3.4  | runtime     |
| `react`                 | 19.3.0  | runtime     |
| `react-dom`             | 19.3.0  | runtime     |
| `@tailwindcss/postcss`  | 4.3.3   | development |
| `@types/node`           | 26.6.5  | development |
| `@types/react`          | 19.3.0  | development |
| `@types/react-dom`      | 19.3.0  | development |
| `eslint`                | 10.12.0 | development |
| `tailwindcss`           | 4.3.3   | development |
| `typescript`            | 6.0.3   | development |
| `vitest`                | 5.0.3   | development |

### `@integr8/api-client` — `packages/api-client`

Workspace packages used: `@integr8/core`, `@integr8/eslint-config`, `@integr8/typescript-config`

| Library              | Version | Kind        |
| -------------------- | ------- | ----------- |
| `openapi-fetch`      | 0.17.0  | runtime     |
| `@types/node`        | 26.6.5  | development |
| `eslint`             | 10.12.0 | development |
| `openapi-typescript` | 7.13.0  | development |
| `typescript`         | 6.0.3   | development |
| `vitest`             | 5.0.3   | development |

### `@integr8/auth` — `packages/auth`

Workspace packages used: `@integr8/core`, `@integr8/db`, `@integr8/eslint-config`, `@integr8/typescript-config`

| Library       | Version | Kind        |
| ------------- | ------- | ----------- |
| `jose`        | 6.2.0   | runtime     |
| `zod`         | 4.6.1   | runtime     |
| `@types/node` | 26.6.5  | development |
| `eslint`      | 10.12.0 | development |
| `tsx`         | 4.23.13 | development |
| `typescript`  | 6.0.3   | development |
| `vitest`      | 5.0.3   | development |

### `@integr8/core` — `packages/core`

Workspace packages used: `@integr8/eslint-config`, `@integr8/typescript-config`

| Library       | Version | Kind        |
| ------------- | ------- | ----------- |
| `zod`         | 4.6.1   | runtime     |
| `@types/node` | 26.6.5  | development |
| `eslint`      | 10.12.0 | development |
| `typescript`  | 6.0.3   | development |
| `vitest`      | 5.0.3   | development |

### `@integr8/db` — `packages/db`

Workspace packages used: `@integr8/core`, `@integr8/form-engine`, `@integr8/eslint-config`, `@integr8/typescript-config`

| Library       | Version | Kind        |
| ------------- | ------- | ----------- |
| `kysely`      | 0.28.9  | runtime     |
| `pg`          | 8.16.3  | runtime     |
| `zod`         | 4.6.1   | runtime     |
| `@types/node` | 26.6.5  | development |
| `@types/pg`   | 8.15.6  | development |
| `eslint`      | 10.12.0 | development |
| `tsx`         | 4.23.13 | development |
| `typescript`  | 6.0.3   | development |
| `vitest`      | 5.0.3   | development |

### `@integr8/eslint-config` — `packages/eslint-config`

| Library                     | Version | Kind        |
| --------------------------- | ------- | ----------- |
| `@eslint/js`                | 10.0.1  | runtime     |
| `eslint-config-prettier`    | 10.1.8  | runtime     |
| `eslint-plugin-jsx-a11y`    | 6.10.2  | runtime     |
| `eslint-plugin-react-hooks` | 7.1.1   | runtime     |
| `typescript-eslint`         | 8.71.1  | runtime     |
| `eslint`                    | 10.12.0 | development |
| `eslint`                    | ^10.0.0 | peer        |

### `@integr8/form-engine` — `packages/form-engine`

Workspace packages used: `@integr8/eslint-config`, `@integr8/typescript-config`

| Library               | Version | Kind        |
| --------------------- | ------- | ----------- |
| `zod`                 | 4.6.1   | runtime     |
| `@types/node`         | 26.6.5  | development |
| `@vitest/coverage-v8` | 5.0.0   | development |
| `esbuild`             | 0.28.2  | development |
| `eslint`              | 10.12.0 | development |
| `fast-check`          | 4.10.0  | development |
| `tsx`                 | 4.23.13 | development |
| `typescript`          | 6.0.3   | development |
| `vitest`              | 5.0.3   | development |

### `@integr8/form-input` — `packages/form-input`

Workspace packages used: `@integr8/form-engine`, `@integr8/eslint-config`, `@integr8/typescript-config`

| Library       | Version | Kind        |
| ------------- | ------- | ----------- |
| `@types/node` | 26.6.5  | development |
| `eslint`      | 10.12.0 | development |
| `typescript`  | 6.0.3   | development |
| `vitest`      | 5.0.3   | development |

### `@integr8/form-renderer-dom` — `packages/form-renderer-dom`

Workspace packages used: `@integr8/form-engine`, `@integr8/i18n`, `@integr8/api-client`, `@integr8/form-input`, `@integr8/eslint-config`, `@integr8/typescript-config`

| Library                       | Version | Kind        |
| ----------------------------- | ------- | ----------- |
| `@testing-library/dom`        | 10.4.2  | development |
| `@testing-library/jest-dom`   | 7.0.1   | development |
| `@testing-library/react`      | 16.3.3  | development |
| `@testing-library/user-event` | 14.6.7  | development |
| `@types/node`                 | 26.6.5  | development |
| `@types/react`                | 19.3.0  | development |
| `@types/react-dom`            | 19.3.0  | development |
| `axe-core`                    | 4.14.0  | development |
| `eslint`                      | 10.12.0 | development |
| `jsdom`                       | 30.0.1  | development |
| `react`                       | 19.3.0  | development |
| `react-dom`                   | 19.3.0  | development |
| `typescript`                  | 6.0.3   | development |
| `vitest`                      | 5.0.3   | development |
| `@tanstack/react-query`       | 5.102.8 | development |
| `react`                       | >=19    | peer        |
| `react-dom`                   | >=19    | peer        |
| `@tanstack/react-query`       | >=5     | peer        |

### `@integr8/i18n` — `packages/i18n`

Workspace packages used: `@integr8/eslint-config`, `@integr8/form-engine`, `@integr8/typescript-config`

| Library         | Version | Kind        |
| --------------- | ------- | ----------- |
| `i18next`       | 26.4.2  | runtime     |
| `react-i18next` | 17.0.13 | runtime     |
| `@types/node`   | 26.6.5  | development |
| `@types/react`  | 19.3.0  | development |
| `eslint`        | 10.12.0 | development |
| `react`         | 19.3.0  | development |
| `typescript`    | 6.0.3   | development |
| `vitest`        | 5.0.3   | development |
| `react`         | >=19    | peer        |

### `@integr8/offline` — `packages/offline`

Workspace packages used: `@integr8/api-client`, `@integr8/core`, `@integr8/eslint-config`, `@integr8/typescript-config`

| Library       | Version | Kind        |
| ------------- | ------- | ----------- |
| `@types/node` | 26.6.5  | development |
| `eslint`      | 10.12.0 | development |
| `typescript`  | 6.0.3   | development |
| `vitest`      | 5.0.3   | development |

### `@integr8/operations-dom` — `packages/operations-dom`

Workspace packages used: `@integr8/api-client`, `@integr8/core`, `@integr8/form-renderer-dom`, `@integr8/i18n`, `@integr8/eslint-config`, `@integr8/typescript-config`

| Library                       | Version | Kind        |
| ----------------------------- | ------- | ----------- |
| `leaflet`                     | 1.9.4   | runtime     |
| `@testing-library/dom`        | 10.4.2  | development |
| `@testing-library/jest-dom`   | 7.0.1   | development |
| `@testing-library/react`      | 16.3.3  | development |
| `@testing-library/user-event` | 14.6.7  | development |
| `@types/node`                 | 26.6.5  | development |
| `@types/react`                | 19.3.0  | development |
| `@types/react-dom`            | 19.3.0  | development |
| `axe-core`                    | 4.14.0  | development |
| `eslint`                      | 10.12.0 | development |
| `jsdom`                       | 30.0.1  | development |
| `react`                       | 19.3.0  | development |
| `react-dom`                   | 19.3.0  | development |
| `typescript`                  | 6.0.3   | development |
| `vitest`                      | 5.0.3   | development |
| `@tanstack/react-query`       | 5.102.8 | development |
| `@types/leaflet`              | 1.9.22  | development |
| `react`                       | >=19    | peer        |
| `react-dom`                   | >=19    | peer        |
| `@tanstack/react-query`       | >=5     | peer        |

### `@integr8/tokens` — `packages/tokens`

Workspace packages used: `@integr8/eslint-config`, `@integr8/typescript-config`

| Library       | Version | Kind        |
| ------------- | ------- | ----------- |
| `@types/node` | 26.6.5  | development |
| `eslint`      | 10.12.0 | development |
| `tsx`         | 4.23.13 | development |
| `typescript`  | 6.0.3   | development |
| `vitest`      | 5.0.3   | development |

### `@integr8/typescript-config` — `packages/typescript-config`

No third-party libraries.
