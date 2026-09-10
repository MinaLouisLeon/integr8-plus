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
  typescript-config   Shared tsconfig presets
  eslint-config       Shared flat ESLint config
plan/                 The build plan — phases, status, exit criteria
```

Rules that hold across the workspace:

- **A shared type lives in `@integr8/core` and nowhere else.** Duplicating a domain type
  into an app is how the four clients drift apart.
- **No shared UI component package.** React DOM and React Native do not share components
  usefully. Share tokens, types and clients; write the widgets twice.
- **Apps never import from each other.** They share only through `packages/`.

## Branches

| Branch         | Purpose                                                     |
| -------------- | ----------------------------------------------------------- |
| `main`         | Always releasable. Protected                                |
| `foundation`   | Long-lived branch for the v0.1 phases                       |
| `p<nn>-<slug>` | One branch per phase, e.g. `p02-database-and-multi-tenancy` |
| `fix/<slug>`   | Bug fixes outside a phase                                   |

## Commits

[Conventional Commits](https://www.conventionalcommits.org), enforced by commitlint at
commit time and again in CI.

```
<type>(<scope>): <subject>
```

Types: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`, `perf`, `build`, `ci`, `revert`.

Scopes: `api`, `web`, `desktop`, `mobile`, `core`, `config`, `ci`, `deps`, `plan`, `repo`.

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

`.github/workflows/ci.yml` runs on every pull request and on pushes to `main`:

1. **verify** — install, `format:check`, `lint`, `typecheck`, `test`, `build`
2. **commit-messages** — commitlint over the PR's commit range
3. **secret-scan** — gitleaks over full history

All three must pass before merge.

## Toolchain versions and why they are pinned

Every dependency is pinned to an exact version. Dependabot proposes upgrades weekly,
grouped so each pull request covers one concern.

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

## Working through the plan

`plan/README.md` is the source of truth for what is built and what is next. A phase is
complete when **every exit criterion in its file is verifiably true** — not when the code
is written. Then, in one commit: tick the boxes, set the `**Status:**` line to
`COMPLETED — YYYY-MM-DD`, and tick the phase's row in `plan/README.md`.
