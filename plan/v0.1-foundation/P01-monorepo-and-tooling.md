# P01 — Monorepo and tooling

**Version:** v0.1 Foundation
**Status:** `NOT STARTED`
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
- [ ] pnpm workspace with Turborepo; pipeline for `build`, `lint`, `typecheck`, `test`
- [ ] Shared TypeScript config, ESLint and Prettier as packages, extended by every app
- [ ] `packages/core` — domain types and zod schemas, the only place a shared type lives
- [ ] Vitest configured at the root, running per-package
- [ ] Conventional commits with commitlint; pre-commit hook running lint and typecheck on staged files only
- [ ] GitHub Actions: install, cache, lint, typecheck, test, build — on every pull request
- [ ] `.env.example` for every app; a documented list of required variables
- [ ] `CONTRIBUTING.md` covering branch naming, commit format and how to run each app
- [ ] Dependabot or Renovate for dependency updates
- [ ] Secret scanning enabled in CI

## Exit criteria
- [ ] `pnpm install && pnpm build` succeeds from a clean clone
- [ ] `pnpm lint && pnpm typecheck && pnpm test` all pass and are enforced on pull requests
- [ ] A deliberately broken type in `packages/core` fails CI in the app that imports it
- [ ] A new developer can go from clone to all four apps running by following the README alone

## Notes
- Turborepo's remote cache is worth enabling early; four apps rebuilt serially gets slow fast.
- Do not put shared **UI components** in `packages/`. React DOM and React Native do not
  share components usefully. Share logic, types and clients — never widgets.
