# Contributing

## Repository layout

```
apps/
  api        Node service — the only thing that talks to Postgres
  web        Next.js: marketing, billing portal, super admin dashboard
  desktop    React SPA wrapped by Tauri; also deploys as a browser app
  mobile     Expo, offline-first
packages/
  core                Domain types and zod schemas
  db                  Schema, migrations, repositories, tenant isolation
  auth                Sessions, tokens, invitations, impersonation
  api-client          Typed client generated from apps/api/openapi.json
  tokens              Design tokens as data, consumed by all three UIs
  i18n                Translations, locales and locale-aware formatting
  typescript-config   Shared tsconfig presets
  eslint-config       Shared flat ESLint config
plan/                 The build plan — phases, status, exit criteria
```

Rules that hold across the workspace:

- **A shared type lives in `@integr8/core` and nowhere else.** Duplicating a domain type
  into an app is how the four clients drift apart.
- **No shared UI component package.** React DOM and React Native do not share components
  usefully. Share tokens, types and clients; write the widgets twice. Each app owns its
  own `components/ui`.
- **Every user-facing string goes through `@integr8/i18n`.** A literal in a component is
  a string no translator will ever see.
- **Never a physical direction.** `ms-4` not `ml-4`, `text-start` not `text-left`,
  `textAlign: 'auto'` not `'left'`. Lint rejects the physical forms; see
  [`docs/ui/`](./docs/ui/README.md).
- **Apps never import from each other.** They share only through `packages/`.
- **Only `@integr8/db` talks to Postgres.** Importing `kysely` or `pg` anywhere else is a
  lint error. A query written outside the repository layer is a query with no `tenant_id`
  filter, which is how one company reads another's data. See
  [`docs/database/`](./docs/database/README.md).
- **Never store a token in `localStorage`.** Any script on the page can read it.
  Clients use the OS keychain, SecureStore, or an httpOnly cookie; the contract
  is `TokenStore` in `@integr8/core`. See [`docs/auth/`](./docs/auth/README.md).
- **Nothing breaking ships inside an API version.** A signed desktop binary and an
  App Store build cannot be force-updated. Read
  [`docs/api/versioning.md`](./docs/api/versioning.md) before changing any endpoint's
  shape; CI fails if `openapi.json` drifts from the code.

## Branches

| Branch        | Purpose                                                              |
| ------------- | -------------------------------------------------------------------- |
| `main`        | What has shipped. Takes `staging` only; a merge is a version release |
| `staging`     | What is being tested. Takes `dev` only; a merge is a nightly         |
| `dev`         | Where work lands. Takes any branch; a merge is a test build          |
| `feat/<slug>` | A feature, e.g. `feat/maintenance-contracts-deadlines`               |
| `fix/<slug>`  | A bug fix                                                            |

Nothing is pushed straight to `main`, `staging` or `dev`; the pre-push hook refuses it.
The rules, and what enforces each, are in
[`docs/contributing/branching.md`](./docs/contributing/branching.md).

## Commits

[Conventional Commits](https://www.conventionalcommits.org), enforced by commitlint at
commit time and again in CI.

```
<type>(<scope>): <subject>
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `revert`.

Scopes (the `scope-enum` in `commitlint.config.js`, which is authoritative): `api`, `web`,
`desktop`, `mobile`, `core`, `form-engine`, `form-renderer`, `form-input`, `operations`,
`crm`, `erp`, `offline`, `db`, `auth`, `config`, `ci`, `deps`, `plan`, `repo`. The scope
may be left out, as in `docs: …`.

```
feat(core): add branded tenant and user identifiers
chore(deps): bump vitest to 5.0.0
docs(plan): complete P01 — monorepo and tooling
```

## Git hooks

Installed by `pnpm install` via husky.

| Hook         | Runs                                                        | Why                                |
| ------------ | ----------------------------------------------------------- | ---------------------------------- |
| `pre-commit` | `lint-staged` — ESLint `--fix` and Prettier on staged files | Fast; keeps commits clean          |
| `commit-msg` | `commitlint`                                                | Rejects a non-conventional message |
| `pre-push`   | `pnpm typecheck` and `pnpm test`                            | See below                          |

**Why typecheck runs at push, not at commit.** TypeScript analyses whole projects, so a
staged-file-only typecheck is not possible — checking one file still loads its entire
project graph. Running it per commit would make every commit slow for no extra safety, so
type and test checks run once at push instead.

Bypass with `--no-verify` only when you understand what you are skipping. CI runs
everything regardless.

## CI

`.github/workflows/ci.yml` runs on every pull request. `verify.yml` runs the same
checks on the merge result for every push to `dev`, `staging` and `main`:

1. **verify** — install, `format:check`, `licences:check`, `pins:check`, `guide:check`, `lint`, `typecheck`,
   `test`, `build`, and the OpenAPI drift check
2. **commit-messages** — commitlint over the PR's commit range
3. **database** — rolls the schema down and back up, then runs the tenant-isolation
   and authentication suites against a disposable Postgres, and the identity
   provider against a real Supabase Auth container. Always runs; the R2 media
   suite inside it runs for real only when the `R2_TEST_*` repository secrets
   exist (docs/media/README.md)
4. **secret-scan** — gitleaks over full history

All must pass before merge.

## Toolchain versions and why they are pinned

Every dependency is pinned to an exact version. Dependabot proposes upgrades weekly,
grouped so each pull request covers one concern.

`pnpm pins:check` (`scripts/pins/check.mjs`, run by CI) enforces it:

- Every workspace `package.json` names exact versions (`1.2.3`) in `dependencies`,
  `devDependencies` and `optionalDependencies`; `^`, `~`, `>=`, `x`, tags and URLs fail.
  Links to workspace packages (`workspace:*`) are the exception. `.npmrc` has
  `save-exact=true`, so `pnpm add` writes exact versions by itself.
- `peerDependencies` may hold ranges: a peer range says what a shared package works with
  (`react >=19`) and installs nothing; the app that installs React pins it.
- **Node is one release.** Use Node 22.22.1 or newer 22.x (22.22.2 recommended, see
  `.nvmrc`). `.nvmrc` names it and CI reads it; every `FROM node:` in the Dockerfiles is that
  exact release (`node:22.22.2-bookworm-slim`); and it must satisfy the root `package.json`
  `engines.node` (`>=22.22.1 <23`), which `engine-strict` makes pnpm enforce. 22.22.1 is
  lint-staged's minimum; Node 23 and later are not supported by this release. Moving Node
  means changing `.nvmrc` and both Dockerfiles in one change (Dependabot's base-image PR
  fails the check until `.nvmrc` follows); a new major also moves `engines`.

**TypeScript is pinned to 6.0.3, not the latest 7.x.** `typescript-eslint@8` declares
`typescript: >=4.8.4 <6.1.0`, so TypeScript 7 would silently disable type-aware linting —
which is most of the value of the lint step. Revisit when typescript-eslint ships TypeScript 7
support, and verify by confirming a `no-floating-promises` violation is still reported.

## Adding a package

1. Create the directory under `apps/` or `packages/`.
2. `package.json` with the `@integr8/<name>` name, `"type": "module"`, and the standard
   scripts: `build`, `clean`, `lint`, `typecheck`, `test`.
3. `tsconfig.json` extending `@integr8/typescript-config/node.json` (or `react.json`).
4. `eslint.config.js`:

   ```js
   import { integr8Config } from '@integr8/eslint-config';
   export default integr8Config(import.meta.dirname);
   ```

5. `vitest.config.ts` including `src/**/*.test.ts`.
6. `pnpm install` to link it into the workspace.
7. Add the package's scope to `scope-enum` in `commitlint.config.js`.

Turborepo picks it up automatically — there is no pipeline to edit.

There is also an `eslint.config.js` at the workspace root. It exists because
lint-staged invokes ESLint from the root with staged paths from several packages at
once, and ESLint resolves its config from the working directory. Both configs produce
the same rules: typescript-eslint's project service locates each file's nearest
`tsconfig.json`, so type-aware rules work from either entry point.

## Environment variables

Each app carries an `.env.example` listing everything it needs. `.env` files are
git-ignored and must never be committed; gitleaks fails the build if a credential lands
in history.

Read variables through `requireEnv` / `optionalEnv` from `@integr8/core` so a missing
value fails loudly at startup instead of surfacing as `undefined` inside a request handler.

`packages/db/.env.example` documents the database variables. `DATABASE_URL` is the runtime
role that RLS applies to; `DATABASE_URL_PLATFORM` is `integr8_platform`, which the API and
the worker use outside one company and which bypasses RLS without owning anything;
`DATABASE_URL_ADMIN` is the schema owner, for migrations and the suites. An API or worker
container must not have the last one set at all, and production refuses to start with it
(`docs/database/README.md`, "The roles").

## Changing the interface

Read [`docs/ui/`](./docs/ui/README.md) before adding a screen. The short version:

- Colours and spacing come from `@integr8/tokens`, never a literal.
- Every string comes from `@integr8/i18n`, keyed by meaning rather than by words.
- Layout uses logical properties, so Arabic mirrors for free. Tick "Preview
  right-to-left" in the app to check.

## Changing the API

Routes are declared one value at a time in `apps/api/src/routes/`, and the same
declaration drives Fastify, validation, authorisation, rate limiting and the OpenAPI
document. Adding a route to `routes/index.ts` is all the registration there is.

After changing any schema:

```bash
pnpm --filter @integr8/api openapi
pnpm --filter @integr8/api-client generate
```

Both outputs are committed, so a contract change is a diff in review. CI regenerates
them and fails if they differ.

## Changing the database

Read [`docs/database/migrations.md`](./docs/database/migrations.md) before changing an
existing column or table — destructive changes are split expand/contract across two
releases, and the reason is written up there with a worked example.

Short version: `pnpm --filter @integr8/db db new <slug>` scaffolds the migration pair,
every `up` needs a `down`, and an applied migration is immutable — its checksum is
recorded, and editing it makes the next deploy refuse to run.

A new tenant-scoped table needs a non-null `tenant_id` with a foreign key, an explicit
grant, RLS enabled, and a policy keyed on `app_current_tenant_id()`. The schema-invariant
suite fails the build if any of the four is missing, so it is a checklist rather than a
convention.

## Working through the plan

`plan/README.md` is the source of truth for what is built and what is next. A phase is
complete when **every exit criterion in its file is verifiably true** — not when the code
is written. Then, in one commit: tick the boxes, set the `**Status:**` line to
`COMPLETED — YYYY-MM-DD`, and tick the phase's row in `plan/README.md`.
