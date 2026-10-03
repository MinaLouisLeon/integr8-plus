# P01 — Monorepo and tooling

**Version:** v0.1 Foundation
**Status:** `COMPLETED — 2026-09-10`
**Depends on:** —

## Goal

One repository where four applications and their shared packages build, lint, type-check
and test with a single command, and where CI enforces all of it.

## Scope

The workspace, the toolchain, and the conventions every later phase assumes. No product
code.

```
apps/   api · web (Next.js) · desktop (React + Tauri) · mobile (Expo)
packages/  core (domain types + zod) · form-engine · api-client · config
```

## Tasks

- [x] pnpm workspace with Turborepo; pipeline for `build`, `lint`, `typecheck`, `test`
- [x] Shared TypeScript config, ESLint and Prettier as packages, extended by every app
- [x] `packages/core` — domain types and zod schemas, the only place a shared type lives
- [x] Vitest configured at the root, running per-package
- [x] Conventional commits with commitlint; pre-commit hook running lint and typecheck on staged files only
- [x] GitHub Actions: install, cache, lint, typecheck, test, build — on every pull request
- [x] `.env.example` for every app; a documented list of required variables
- [x] `CONTRIBUTING.md` covering branch naming, commit format and how to run each app
- [x] Dependabot or Renovate for dependency updates
- [x] Secret scanning enabled in CI

## Exit criteria

- [x] `pnpm install && pnpm build` succeeds from a clean clone
- [x] `pnpm lint && pnpm typecheck && pnpm test` all pass and are enforced on pull requests
- [x] A deliberately broken type in `packages/core` fails CI in the app that imports it
- [x] A new developer can go from clone to all four apps running by following the README alone

## Notes

- Turborepo's remote cache is worth enabling early; four apps rebuilt serially gets slow fast.
- Do not put shared **UI components** in `packages/`. React DOM and React Native do not
  share components usefully. Share logic, types and clients — never widgets.
  **Exception (P08):** `packages/form-renderer-dom` holds the form widgets and submission
  screens the web and desktop apps both render. Both are React DOM, so the reason above does
  not apply, and two copies of eighteen accessible widgets would drift. React Native still
  gets its own renderer (P13).

## Decisions taken during implementation

- **TypeScript pinned to 6.0.3, not 7.x.** `typescript-eslint@8` declares
  `typescript: >=4.8.4 <6.1.0`. Using TypeScript 7 would silently disable type-aware
  linting, which is most of the value of the lint step. Revisit when typescript-eslint
  supports TypeScript 7; verify by confirming `no-floating-promises` still reports.
- **Typecheck runs at `pre-push`, not `pre-commit`.** The task list asked for a
  staged-file-only typecheck. That is not achievable: TypeScript analyses whole projects,
  so checking one file still loads its entire project graph. `pre-commit` runs ESLint and
  Prettier on staged files; `pre-push` runs `typecheck` and `test` across the workspace.
- **No project references between packages.** Turborepo already orders builds through
  `dependsOn: ["^build"]`, and references would have forced `composite: true` on every
  package for no additional guarantee.
- **`apps/*` are placeholders.** Each is a real workspace member that builds, lints,
  type-checks, tests and runs, and each imports `@integr8/core` so a breaking change there
  fails all four. The Next.js, Tauri and Expo shells are P05 — installing those frameworks
  now would add roughly a gigabyte of dependencies to a phase whose scope is "no product code".
- **Lint level is `recommendedTypeChecked` + `stylisticTypeChecked`**, not `strictTypeChecked`.
  Raise it once there is real code to measure the noise against.

## Verified at completion

| Exit criterion                  | How it was proven                                                                                                                                             |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clean install and build         | `pnpm install` then `pnpm build` — 5 tasks successful                                                                                                         |
| Lint, typecheck, test pass      | 6/6 tasks each; 26 tests across 8 packages                                                                                                                    |
| Lint is not a no-op             | A probe file with `any`, a floating promise and a redundant `async` produced 3 errors, including two type-aware rules                                         |
| Broken core type fails the apps | Adding a required parameter to `describeApp` (with core kept internally consistent) failed typecheck in all four apps with `TS2554`, while core itself passed |
| All four apps run               | `web`, `desktop`, `mobile` print their boot banner; `api` serves `/health` returning `{"status":"ok"}` and 404s elsewhere                                     |
| Commit conventions enforced     | commitlint rejects a bare message and an unknown scope, accepts `docs(plan): complete P01 — monorepo and tooling`                                             |
