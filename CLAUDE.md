# CLAUDE.md

Guidance for Claude (and any coding agent) working in this repository. Read
this first, then [`MEMORY.md`](./MEMORY.md) for the project's current state and
recent decisions. Keep both up to date when you change something they describe.

@AGENTS.md

@MEMORY.md

## What this is

**Integr8 Plus**: a multi-tenant field-operations and business platform that
Integr8 sells to service companies (maintenance, installation, inspection),
mainly in Egypt (EGP, Egyptian payroll, Egyptian Tax Authority e-invoicing),
in English and Arabic (right-to-left). Every company is onboarded by Integr8
staff from the platform dashboard; there is no public sign-up by default.

| Who                          | Uses                                         |
| ---------------------------- | -------------------------------------------- |
| Integr8 staff (super admins) | Web `/platform` dashboard, staff desktop app |
| A company's office           | Web app, or the company's own desktop app    |
| A company's engineers        | The company's own phone app (works offline)  |

## Repository layout (pnpm + Turborepo monorepo)

| Path                   | What                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api`             | Fastify `/v1` API, route registry → OpenAPI, background worker, CLIs (`platform/admin-cli.ts`, `demo/cli.ts`, storage)               |
| `apps/web`             | Next.js: marketing site, company workspace `(app)/…`, platform dashboard `platform/…`                                                |
| `apps/desktop`         | React + Tauri (staff app and per-company branded builds)                                                                             |
| `apps/mobile`          | Expo / React Native, local SQLite, queued sync                                                                                       |
| `packages/core`        | Domain rules: roles, permissions matrix, state machines, money, payroll, etc.                                                        |
| `packages/db`          | Postgres via Kysely: `migrations/NNNN_name.{up,down}.sql`, `schema.ts`, repositories, migrator, RLS                                  |
| `packages/auth`        | Tokens, sessions, impersonation, invitations, the identity provider (self-hosted Supabase Auth)                                      |
| `packages/form-engine` | Form definitions, validation, evaluation, template library                                                                           |
| `packages/*` (others)  | `api-client` (generated), `i18n`, `offline`, `operations-dom`, `form-renderer-dom`, `form-input`, `document-render`, `eta`, `tokens` |
| `docs/`                | Per-area docs; `docs/deployment/setup-checklist.{md,html}` is the operator's guide                                                   |
| `deploy/`              | `compose.yml` (with the self-hosted Auth container), `.env.example`, `vps/` (setup script, Caddyfile, backups)                       |
| `plan/`                | The build plan and roadmap                                                                                                           |

## Commands

```bash
pnpm install                     # Node >= 22.22.1 (lint-staged's engine); add --config.engine-strict=false on 22.22.0
pnpm build | lint | typecheck | test     # whole workspace; add --filter @integr8/<pkg>
pnpm test:integration            # needs a disposable Postgres (see below)
pnpm format:check                # Prettier, what CI runs
pnpm guide:check                 # setup guide: Markdown and HTML must agree
pnpm --filter @integr8/api openapi && pnpm --filter @integr8/api-client generate   # after changing a route
pnpm --filter @integr8/db db up | status | deploy   # migrations (deploy = bootstrap roles + up)
pnpm --filter @integr8/db db:templates               # sync the form template library
pnpm --filter @integr8/api demo-company --owner-email you@example.com   # demo company, see below
```

Git hooks (husky): pre-commit runs eslint + prettier on staged files;
commit messages must be Conventional Commits (`feat(api): …`); pre-push refuses
pushes to `main`/`staging`/`dev` and runs `pnpm typecheck` and `pnpm test`
(a few minutes).

## Local development database

Integration suites and the CLIs need Postgres 16 and three connection strings (a fourth is optional):

```bash
DATABASE_URL_ADMIN=postgres://postgres:postgres@localhost:5432/integr8_dev     # owner: migrations, platform data
DATABASE_URL=postgres://integr8_app:PASSWORD@localhost:5432/integr8_dev        # tenant runtime role, RLS applies
DATABASE_URL_AUTH=postgres://integr8_auth:PASSWORD@localhost:5432/integr8_dev  # pre-auth role: sign-in only
DATABASE_URL_PLATFORM=postgres://integr8_platform:PASSWORD@localhost:5432/integr8_dev  # optional locally: staff/platform work; falls back to the admin URL, required in production
INTEGR8_APP_PASSWORD=… INTEGR8_AUTH_PASSWORD=… INTEGR8_PLATFORM_PASSWORD=…   # used by `db bootstrap` to create the roles
```

Put them in `packages/db/.env` and `apps/api/.env` (both git-ignored; templates
are the `.env.example` files). `apps/api/.env` also needs signing keys
(`pnpm --filter @integr8/auth keygen`), `PLATFORM_SECRET_KEY`, and `SUPABASE_AUTH_URL`
plus `SUPABASE_SERVICE_ROLE_KEY` for an Auth container. Integration tests additionally
need `APP_ENV=test` and `INTEGR8_TEST_DATABASE=i-know-this-database-is-disposable`,
pointed at a separate database: they truncate tables.

## Rules that are easy to break

- **The API is the only boundary.** Clients never touch the database or
  the Auth container directly. Writes go through routes, which do validation, numbering,
  stock movements, ledger postings and audit lines.
- **Tenant isolation.** Every table has `tenant_id` + RLS keyed on
  `app_current_tenant_id()`, except the ones listed in `PLATFORM_TABLES`
  (`packages/db/src/schema.ts`). Adding a non-tenant table means adding it
  there, and the schema-invariant suite
  (`packages/db/src/testing/schema-invariants.integration.test.ts`) pins exactly
  what `integr8_auth` may reach; update it on purpose.
- **Migrations** are numbered `NNNN_name.up.sql` + `.down.sql`, never edited
  after release; the test setup rolls every migration down and up again.
- **Permissions** live in `packages/core/src/permissions.ts`. Some are
  staff-only (`STAFF_ONLY_PERMISSIONS`: forms, job types, branding, document
  design, the ETA switch): a company's own owner cannot do them; staff act as
  the company through an audited impersonation grant.
- **Feature flags** (one per business module: `crm`, `sales`, `finance`,
  `ledger`, `inventory`, `purchasing`, `assets`, `hr`, `payroll`,
  `manufacturing`, `documents`, `e_invoicing`, `website_*`) are off by default
  per company.
- **Lint is strict**: no `any` (use a type or `unknown`), `interface` over
  `type` for object shapes, Prettier everywhere.
- **The setup guide** has two copies that must match (see AGENTS.md above);
  the user also keeps a published copy of it as a claude.ai artifact (see
  MEMORY.md).
- Do not put model identifiers in commits, PRs or code.

## API facts worth knowing before calling it

- Writes that must not repeat need an `Idempotency-Key` header.
- Every request needs `x-client-version` and `x-client-app` headers.
- Some routes answer `204` with no body.
- Work-order transitions need `expectedRevision`. A completed, reviewed or
  cancelled job refuses starting a form, and the submit route refuses a draft on
  it (`submission_job_closed`); phone sync accepts a draft the phone started
  before the job closed, marked `submittedAfterClose` with a history entry, and
  refuses one started after. INSPECT and INSTALL job types require certificates.
- Company `workingDays` are ISO numbers 1–7 (Monday = 1).
- Passwords must not contain the email's local part (`AUTH_MIN_PASSWORD_LENGTH`
  and policy in `packages/auth/src/password-policy.ts`).
- Full request and response schemas for every route are in
  `apps/api/openapi.json` (generated; large, so query it with a small script
  rather than reading it whole). The integration tests in
  `apps/api/src/routes/v1/*.integration.test.ts` are the best examples of valid
  flows.

## Sign-in

Company people's passwords and one-time sign-in codes are kept by a
**self-hosted Supabase Auth container** (`auth` in `deploy/compose.yml`,
reached as `SUPABASE_AUTH_URL`, `http://auth:9999`), with its tables in the
`auth` schema of the same database. There is no Supabase cloud project; the
API refuses to start if the old `SUPABASE_URL` is set. Everything goes through
`IdentityProvider` (`packages/auth/src/identity-provider.ts`); the suites use
`FakeIdentityProvider`. Emailed 6-digit codes (`/v1/auth/magic-link`) and
Change password (`/v1/me/password`) are described in
`docs/auth/self-hosted-auth.md`. Staff accounts always use their own password

- authenticator code in `platform_users`. Details: `docs/auth/README.md`.

`node dist/platform/admin-cli.js` (in the API container): `create`, `remove`,
`list` for staff; `user-password <email>` gives a company person a new password
in the Auth container, prints it once and signs out their devices.

## The demo company seeder

`apps/api/src/demo/`: `node dist/demo/cli.js --owner-email you@example.com`
creates one new company with every module on and realistic data in every
section, by booting the API in-process and calling the real routes as the
company's people (so all side effects are real). `--help` for options;
`--confirm-production` is required when `APP_ENV` is staging or production;
`--only <keys>` runs some sections; `--without-sign-in` (development only)
skips creating sign-in accounts. Sections are in `apps/api/src/demo/sections/`,
run in the order of `sections/index.ts`, and share ids through `ctx.refs`.
When a feature adds a screen, add its data to the matching section.

## Deployment

One Oracle Cloud ARM machine running `deploy/compose.yml` (Postgres, bootstrap,
migrate, auth, api, worker, web) behind Caddy; settings in `deploy/.env` on the
machine. Commands run there as
`docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api node dist/…`.
The whole operator procedure is `docs/deployment/setup-checklist.md`.

## Claude Code notes

- **Git:** do not commit, push or open PRs unless asked in the session. Leave changes in
  the working tree. When asked to commit, follow the Conventional Commits rules above —
  the commit-msg hook rejects anything else.
- **Shell:** the machine is Windows. Prefer the Bash tool (Git Bash) for repo scripts;
  husky hooks and `scripts/` are POSIX `sh`.
- **Verify before claiming done:** run the narrowest useful checks
  (`pnpm --filter @integr8/<pkg> typecheck`, `... test`, `... lint`), then the workspace
  ones if the change crosses packages. Integration suites need a disposable Postgres;
  say so when they were not run instead of implying they passed.
- **API changes:** regenerate `apps/api/openapi.json` and the api-client and include both
  in the change.
- **Deployment-affecting changes** (new env var, migration, rollout or recovery step):
  update `docs/deployment/setup-checklist.md` **and** `.html` together, the relevant
  `.env.example`, then run `pnpm guide:check`.
- **Docs and plan:** a feature also updates its `docs/<area>/` page and its phase file in
  `plan/`. Keep `MEMORY.md` current when the project state it describes changes.
- **Turborepo:** check the installed version's bundled docs before touching `turbo.json`
  (see the managed block in `AGENTS.md`).
