<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Integr8 Plus — guide for coding agents

A multi-tenant field-operations platform sold to service companies on subscription.
Office staff use the web app or their company's desktop app; engineers use an
offline-first phone app; Integr8 staff run tenants from the platform dashboard.

Longer references: `README.md` (product + setup), `CONTRIBUTING.md` (rules and
checklists), `docs/` (one folder per area), `plan/README.md` (what is built and next).
Current project state and known gotchas: `MEMORY.md`.

## Workspace

pnpm 10 workspaces + Turborepo, Node 22.22.1 or newer 22.x (22.22.2 recommended, see `.nvmrc`), TypeScript 6.0.3 (pinned on purpose —
see `CONTRIBUTING.md`), Vitest, ESLint (type-aware, flat config), Prettier. Every dependency
is pinned to an exact version.

| Path                         | Package                      | What                                                                            |
| ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------- |
| `apps/api`                   | `@integr8/api`               | Fastify `/v1` service, OpenAPI, worker, platform/storage CLIs. Port 3000        |
| `apps/web`                   | `@integr8/web`               | Next.js: marketing, office app, billing, platform dashboard. Port 3001          |
| `apps/desktop`               | `@integr8/desktop`           | React + Vite SPA in Tauri v2; `staff` / `company` flavours. Port 3002           |
| `apps/mobile`                | `@integr8/mobile`            | Expo Router, offline-first (SQLCipher); one build per company                   |
| `apps/forms-ai`              | `@integr8/forms-ai`          | Offline MCP server + installer for AI tools writing `.integr8form`; Node SEA    |
| `packages/core`              | `@integr8/core`              | Domain types, zod schemas, permission matrix, navigation model                  |
| `packages/db`                | `@integr8/db`                | Migrations, repositories, tenant isolation, seeds — the only place SQL runs     |
| `packages/auth`              | `@integr8/auth`              | Sessions, EdDSA tokens, refresh rotation, impersonation, offline grants         |
| `packages/api-client`        | `@integr8/api-client`        | Typed client generated from `apps/api/openapi.json`                             |
| `packages/form-engine`       | `@integr8/form-engine`       | Pure form engine + conformance suite (Node and Hermes must agree byte-for-byte) |
| `packages/form-package`      | `@integr8/form-package`      | The `.integr8form` file: pack, strict unpack, publish-level check (Node only)   |
| `packages/form-input`        | `@integr8/form-input`        | Engine state → what a form filler shows                                         |
| `packages/form-renderer-dom` | `@integr8/form-renderer-dom` | Form/submission screens for web + desktop                                       |
| `packages/operations-dom`    | `@integr8/operations-dom`    | Operations screens shared by web + desktop                                      |
| `packages/offline`           | `@integr8/offline`           | Phone SQLite schema, queries, sync engine (no React Native inside)              |
| `packages/i18n`              | `@integr8/i18n`              | English + Arabic catalogues (TypeScript), direction helpers                     |
| `packages/tokens`            | `@integr8/tokens`            | Design tokens, themes, brand accent                                             |
| `packages/document-render`   | `@integr8/document-render`   | Printable business documents                                                    |
| `packages/eta`               | `@integr8/eta`               | Egyptian Tax Authority e-invoicing                                              |

## Commands

```bash
pnpm build | lint | typecheck | test     # whole workspace; none need a database
pnpm test:integration                    # needs a disposable Postgres (see README "Everyday commands")
pnpm format:check                        # what CI runs; `pnpm format` writes
pnpm guide:check                         # setup checklist MD/HTML parity (see below)
pnpm pins:check                          # exact dependency versions; one Node release everywhere
pnpm --filter @integr8/<name> <script>   # scope anything to one package
pnpm --filter @integr8/api openapi && pnpm --filter @integr8/api-client generate   # after any API schema change
pnpm --filter @integr8/db db new <slug>  # scaffold a migration up/down pair
pnpm --filter @integr8/db db up          # apply migrations
```

Git hooks (husky): pre-commit runs lint-staged; commit-msg runs commitlint; pre-push
refuses pushes to `main`/`staging`/`dev`, then runs `pnpm typecheck` and `pnpm test`.

## Rules that are enforced (break them and lint, tests or CI fail)

- **Only `@integr8/db` touches Postgres.** Importing `kysely` or `pg` elsewhere is a lint
  error. Application code goes through `getTenantDataSource(tenantId)` and repositories;
  RLS is the backstop.
- **New tenant-scoped table** = non-null `tenant_id` with FK, explicit grant, RLS enabled,
  and a policy keyed on `app_current_tenant_id()`. Keys between tenant tables carry
  `tenant_id` too. The schema-invariants suite checks all of it.
- **Migrations are immutable once applied** (checksummed). Every `up` has a `down`.
  Destructive changes are split expand/contract across two releases —
  read `docs/database/migrations.md` first.
- **API routes are declared once** in `apps/api/src/routes/` (zod schemas, security,
  permission, idempotency) and registered in `routes/index.ts`. Regenerate and commit
  `openapi.json` and the client after any change; CI fails on drift.
- **Nothing breaking inside `/v1`.** Shipped desktop and phone builds cannot be
  force-updated. Read `docs/api/versioning.md` before changing an endpoint's shape.
- **Every user-facing string goes through `@integr8/i18n`**, in both `en.ts` and `ar.ts`
  (a parity test checks keys, placeholders and Arabic's six plural forms).
- **Logical directions only** for RTL: `ms-`/`pe-`/`start-`/`text-start`, never
  `ml-`/`left-`/`text-left`; `textAlign: 'auto'` on native. ESLint rejects physical forms.
- **New permission** must be decided for every role in `packages/core/src/permissions.ts`,
  and given its row (`yes`/`no` per role, and Staff only) in `packages/core/src/permissions.table.md`.
- **Plan limits are enforced by the API**, not by screens.

## Conventions

- Shared domain types live only in `@integr8/core`. Apps never import from each other.
- No shared UI component package: each app owns its `components/ui`; web and desktop share
  screens through `form-renderer-dom` / `operations-dom`.
- Never store tokens in `localStorage` — use the `TokenStore` contract (keychain,
  SecureStore, httpOnly cookie).
- External services have local stand-ins selected by env (`MEDIA_STORAGE=local`,
  `GEOCODER=fake`, `PUSH_SENDER=recording`, `BILLING_PROVIDER=recording`,
  `EMAIL_SENDER=recording`, `APP_BUILDS=off`). New integrations follow the same pattern:
  an interface, a `Recording…` stand-in, the real adapter, and a config check that
  refuses to start production on a half-configured switch (`apps/api/src/config.ts`).
- Everything is self-hosted (P36): Postgres and a Supabase Auth container in
  `deploy/compose.yml`, no Supabase cloud project. Auth only holds passwords and
  makes sign-in codes; it is reached through `IdentityProvider`
  (`packages/auth/src/identity-provider.ts`), whose `FakeIdentityProvider` is the
  stand-in for tests only. See `docs/auth/self-hosted-auth.md`.
- Config vars are documented where they are read (zod schema comments) and in the
  matching `.env.example`; `deploy/.env.example` covers a whole deployment.
- Code comments explain _why_, in plain prose — match the existing style.
- A cross-cutting feature usually lands as a sequence: `feat(db)` → `feat(api)` →
  `feat(desktop)`/`feat(web)` → `feat(mobile)` → `docs`, plus the plan phase update.

## Commits, branches, releases

- Conventional Commits, `type(scope): subject`, header ≤ 100 chars. Allowed scopes are the
  `scope-enum` in `commitlint.config.js` (authoritative; the list in `CONTRIBUTING.md` is
  older). `docs:` with no scope is also used.
- Work branches: `feat/<slug>`, `fix/<slug>`. Flow per `docs/contributing/branching.md`:
  branch → `dev` → `staging` → `main`. Never push directly to `main`, `staging` or `dev`.
- The version is the root `package.json` `version` only; a merge to `main` releases it and
  refuses a version already released.
- Completing a plan phase: tick every exit criterion, set `**Status:** COMPLETED — YYYY-MM-DD`,
  tick its row in `plan/README.md`, one commit (`docs(plan): complete P<nn> — …`).

# The setup guide

The deployment checklist has two maintained content versions:

1. **`docs/deployment/setup-checklist.md`**: the Markdown checklist.
2. **`docs/deployment/setup-checklist.html`**: the downloadable interactive checklist. Its `setup-checklist.css` and `setup-checklist.js` files support the HTML presentation and behavior; they are assets, not additional checklist content versions.

Update the Markdown and HTML together whenever a feature adds or changes deployment, configuration, migration, rollout, or recovery steps. Keep their stages, parts, tick boxes, and wording aligned. Update CSS or JavaScript only when the HTML's presentation or behavior needs to change. Keep the guide's stated current release synchronized with the root `package.json` version.

Run `pnpm guide:check` before committing: it checks that Markdown and HTML agree on stages, parts, tick boxes, and their words, and that the HTML loads its stylesheet and script.
