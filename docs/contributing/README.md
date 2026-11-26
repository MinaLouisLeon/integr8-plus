# Contributing

## Before you start

```bash
pnpm install                       # Node >=22.22.1 <23 (22.23.4 in .nvmrc), pnpm 10
pnpm build | lint | typecheck | test     # the whole workspace; none needs a database
pnpm --filter @integr8/<pkg> <script>    # one package
pnpm test:integration              # needs a disposable Postgres (below)
pnpm format:check                  # what CI runs; format only the files you changed
pnpm guide:check                   # the setup guide's Markdown and HTML agree
pnpm pins:check                    # exact versions; one Node release everywhere
pnpm licences:check                # dependency licences
```

**A local database** for the integration suites and the CLIs: Postgres 16 and,
in `packages/db/.env` and `apps/api/.env` (git-ignored; templates are the
`.env.example` files), `DATABASE_URL_ADMIN` (owner), `DATABASE_URL`
(`integr8_app`), `DATABASE_URL_AUTH` (`integr8_auth`), optionally
`DATABASE_URL_PLATFORM`, and `INTEGR8_APP_PASSWORD`, `INTEGR8_AUTH_PASSWORD`,
`INTEGR8_PLATFORM_PASSWORD` for `pnpm --filter @integr8/db db deploy` (bootstrap
roles, then migrate). `apps/api/.env` also needs signing keys (`pnpm --filter
@integr8/auth keygen`), `PLATFORM_SECRET_KEY`, and `SUPABASE_AUTH_URL` plus
`SUPABASE_SERVICE_ROLE_KEY` for an Auth container. Integration tests need
`APP_ENV=test` and `INTEGR8_TEST_DATABASE=i-know-this-database-is-disposable`, on
a separate database: they truncate tables. Screen tests wait up to 5 s in
`findBy…` because integration suites beside them slow the machine.

**Running the whole thing on one machine** (Docker needed): fill
`deploy/local/.env` from its `.env.example`, then `pnpm local` starts Postgres
(on port 5433) and the Auth container (9999) from `deploy/local/compose.yml`, runs
`db deploy`, builds what the apps need and runs the API (3000) and the desktop
app in a browser (3002). The public site is not started; run
`pnpm --filter @integr8/web dev` (3001) when you need it. Ctrl+C stops the apps;
`pnpm local:stop` stops the containers and keeps their data. `pnpm
local:services` and `pnpm local:apps` are the two halves.

## Branches

```
your branch ──▶ dev ──▶ staging ──▶ main
               CI on    the test    a versioned
               the PR   box builds  release
```

| Branch    | Takes          | A pull request into it runs | A merge into it produces         |
| --------- | -------------- | --------------------------- | -------------------------------- |
| `dev`     | any branch     | `ci.yml`, `branch-policy`   | nothing                          |
| `staging` | `dev` only     | `branch-policy`             | nothing (the test box builds it) |
| `main`    | `staging` only | `branch-policy`             | a release (`release-main.yml`)   |

Work branches are `feat/<slug>` and `fix/<slug>`. **GitHub branch protection is
not in force**: the repository is private and rulesets on a private repository
need a paid plan (`.github/rulesets/*.json` and
`scripts/github/apply-branch-protection.sh` are ready if that changes).
`branch-policy.yml` reports a wrong source branch but does not block. The only
guard against pushing to `main`, `staging` or `dev` is the local pre-push hook
(`scripts/git-hooks/pre-push-branch-guard.sh`; `INTEGR8_ALLOW_PROTECTED_PUSH=1`
bypasses it). Never edit `main` or `staging` on GitHub's web editor. Dependabot
opens pull requests against `main`: apply them on a branch from `dev` instead.

## Commits

Conventional Commits, `type(scope): subject`, header at most 100 characters.
Scopes are the `scope-enum` in `commitlint.config.js` (api, web, desktop, mobile,
core, form-engine, form-renderer, form-input, forms-ai, dev-mcp, operations, crm,
erp, offline, db, auth, config, ci, deps, plan, repo); `docs:` with no scope is
also used. A cross-cutting feature usually lands as `feat(db)` → `feat(api)` →
`feat(desktop)`/`feat(web)` → `feat(mobile)` → `docs`. Never put model names in
commits, pull requests or code.

Hooks (husky): pre-commit runs lint-staged (ESLint and Prettier on staged
files); commit-msg runs commitlint; pre-push refuses the three branches, then
runs `pnpm typecheck` and `pnpm test`.

## CI

`ci.yml` runs on pull requests into `dev` and calls `verify.yml`:

1. **verify**: install, `format:check`, `licences:check`, `pins:check`,
   `guide:check`, `lint`, `typecheck`, `test`, `build`, the OpenAPI drift check,
   and the form engine's conformance corpus in Hermes;
2. **commit messages**: commitlint over the range;
3. **database**: rolls every migration down and up again, runs the integration
   suites against a disposable Postgres and the identity provider against a real
   Auth container (the R2 suite only with the `R2_TEST_*` secrets);
4. **secret scan**: gitleaks over the full history.

`release-main.yml` (push to `main`) runs verify, the release's files
(`build-release-artifacts.yml`), the company apps (`build-company-apps.yml`)
and the release. Runner minutes are finite: set `DESKTOP_BUILDS=disabled` while
desktop builds are unsigned.

**Workflow safety (SEC-005).** Every third-party action is pinned to a full
commit with its version as a comment (`actions/checkout@<40 hex> # v7.0.1`);
`pins:check` fails on a tag or a branch, and Dependabot (`github-actions`)
proposes the next commit. Workflows are read-only unless a job asks for more.
The signing keys (desktop updater, `UPDATE_SIGNING_KEY`, Apple, Windows, Expo, Google) live in the
`release` GitHub environment, which only the signing jobs name
(`environment: release`); never move them back to repository secrets, and give a
new job that signs the same line. **Signed updates (SEC-004):** the release job
signs `integr8-update-manifest.json` (every file's SHA-256) with
`UPDATE_SIGNING_KEY` (`scripts/releases/sign-updates.mjs`, tested by
`pnpm releases:check`); Forms for AI and the developer program update
themselves only when that list, checked against the public key in
`apps/forms-ai/src/setup/signature.ts`, names the file's exact hash. To change
the key, add the new public key there and release before signing with it.

## The rules lint and tests enforce

- **Only `@integr8/db` touches Postgres** (`kysely`/`pg` elsewhere is a lint
  error); application code uses `getTenantDataSource(tenantId)` and repositories.
- **A new company table**: non-null `tenant_id` with a foreign key, explicit
  grants, row-level security and a policy on `app_current_tenant_id()`; keys
  between company tables carry `tenant_id`; a primary key (the transfer needs
  one); and a place in the export lists. A table outside companies goes in
  `PLATFORM_TABLES`. The schema-invariant, export and purge suites check it.
- **Migrations** are immutable once applied, always with a `down`, and split
  expand/contract across releases when destructive
  ([database/migrations.md](../database/migrations.md)).
- **Routes** are declared once and registered in `routes/index.ts`; regenerate
  and commit `openapi.json` and the client. **Nothing breaking inside `/v1`**
  ([api/](../api/README.md#versioning-nothing-breaking-inside-v1)).
- **Permissions**: a new one is decided for every role in
  `packages/core/src/permissions.ts` and in `permissions.table.md`.
- **Strings** go through `@integr8/i18n` in English and Arabic; **logical
  directions only** for right to left ([apps/](../apps/README.md#rules-every-screen-follows)).
- **Plan limits** are enforced by the API, not by screens.
- **Lint is strict**: no `any` (use a type or `unknown`), `interface` for object
  shapes, Prettier everywhere. TypeScript stays on 6.0.3 (7 would switch off
  type-aware linting).
- **Exact versions** for every dependency (`.npmrc` has `save-exact=true`); Node
  moves in `.nvmrc` and both Dockerfiles together.
- **Tokens** never in `localStorage`; use the `TokenStore` contract.
- **External services** follow the pattern: an interface, a `Recording…`
  stand-in, the real adapter, and a config check that refuses production on a
  half-configured switch.
- **Code comments** explain _why_, in plain prose.

## Checklists

- **A new package**: `apps/` or `packages/`, `@integr8/<name>`, `"type":
"module"`, scripts `build`, `clean`, `lint`, `typecheck`, `test`;
  `tsconfig.json` extending `@integr8/typescript-config`; `eslint.config.js`
  with `integr8Config(import.meta.dirname)`; `vitest.config.ts`; add its scope to
  `commitlint.config.js`. Turborepo picks it up (read the installed Turborepo's
  bundled docs before touching `turbo.json`).
- **A new setting**: documented in the reading `config.ts`, in the matching
  `.env.example` and `deploy/.env.example`, passed by compose, and in the setup
  guide.
- **A deployment-affecting change** (setting, migration, rollout or recovery
  step): update `docs/deployment/setup-checklist.md` **and** `.html` together
  (same stages, parts, tick boxes and words) and run `pnpm guide:check`. Keep the
  guide's stated release equal to the root `package.json`. The owner also keeps
  a published copy of the guide; republish it when the guide changes.
- **A new screen**: both languages, logical directions, the right section in
  `@integr8/core` navigation (`desktopOnly`/`webOnly` if needed), and its data in
  the demo seeder's matching section.
- **A feature**: its page in `docs/` and its entry in `plan/README.md`;
  `MEMORY.md` when the project state it describes changes.
- **A version bump**: the root `package.json`, `apps/api/src/app-info.ts`,
  `README.md`, `PROJECT_INDEX.md`/`.json`, `deploy/.env.example` and the setup
  guide (header, `APP_VERSION`/`API_RELEASE`, latest release, footer).

## Change requests

Wishes for the platform found while building forms arrive in `plan/requests/`.
Planning one follows [planning-a-change-request.md](./planning-a-change-request.md)
(Claude Code: `/plan-change-request <number>`) and ends with a plan for the
owner to approve, with no product code. The tools are in
[developer-tools.md](./developer-tools.md).
