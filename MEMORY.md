# MEMORY.md — project state and gotchas

Facts that are not obvious from the code and go stale. Update this file when they
change; date each section. Rules and commands are in `AGENTS.md`.

## Snapshot (2026-10-30)

- **Version:** root `package.json` is **1.2.1** (the only source of the version).
- **Migrations:** `packages/db/migrations` reaches **0053**
  (`0052_qualifications`, `0053_maintenance_contracts_deadlines`). The next one is 0054.
- **Plan:** v1.2 "scheduling" phases are `IN PROGRESS` — P25 calendar & dispatch board,
  P26 skills & certificates, P27 maintenance plans, contracts & response deadlines.
  v1.3 (P28–P31) and v2.0 (P32–P35) are `NOT STARTED`. Many v1.0 phases (P16–P19) are
  still `[~]` in `plan/README.md` even though their features exist in code.
- **Recently merged to `main`:** engineer qualifications (PR #125), maintenance
  contracts/deadlines (PR #126), version bump to 1.2.1 (PR #127).
- **In flight (branch `fix/company-app-build-trigger`, uncommitted):** starting a
  company's app build from the platform dashboard. `apps/api/src/platform/app-builds.ts`
  adds an `AppBuildTrigger` interface with `RecordingAppBuildTrigger` and
  `GitHubAppBuildTrigger` (dispatches `build-company-apps.yml`). New API config:
  `APP_BUILDS` (`off` | `github`), `GITHUB_BUILD_TOKEN`, `GITHUB_BUILD_REPOSITORY`,
  `GITHUB_BUILD_REF` (default `main`), validated by `appBuildProblems()` in `config.ts`.
  Still to check: OpenAPI/client regeneration, `.env.example`, setup checklist, docs.

## Places that state the version or migration count

All brought in line with 1.2.1 / 0053 on 2026-10-30. Update them together at each release
or new migration:

- `README.md`: "Current version" line and the migration table.
- `PROJECT_INDEX.md` ("Read carefully" line) and `PROJECT_INDEX.json` (`version`).
- `docs/deployment/setup-checklist.md` **and** `.html`: header line, Stage 0 "Nothing to
  merge", Stage 3 `APP_VERSION`/`API_RELEASE`, Stage 6 latest release, Stage 7 company
  release name, Stage 12 example bump and feature parts, Stage 14, footer. References
  like "included in v1.1.2" are history and stay as they are.
- Released versions: `gh release list`. v1.2.1 (2026-10-27) carries migrations 0051–0053.

## Gotchas

- GitHub branch protection is **not** in force (private repo on the Free plan). The only
  guard against pushing to `main`/`staging`/`dev` is the local pre-push hook
  (`scripts/git-hooks/pre-push-branch-guard.sh`); `INTEGR8_ALLOW_PROTECTED_PUSH=1`
  bypasses it.
- In practice feature PRs have been merged straight into `main`, despite the documented
  `dev → staging → main` flow.
- CI's database job runs only when the repo variable `DATABASE_TESTS=enabled`.
- Integration tests refuse to run without `APP_ENV=test` and
  `INTEGR8_TEST_DATABASE=i-know-this-database-is-disposable`.
- TypeScript stays on 6.0.3: TypeScript 7 would silently switch off type-aware linting.
- `APP_ENV=production` refuses to start on any stand-in service.
- `PUBLIC_SIGNUP=off` by default: companies are created only by Integr8 staff.
- ETA e-invoicing is not production-validated (live PreProd submission and hardware-token
  signing untested). The ledger and payroll are management tools, not statutory.

## Idea backlog

`new-idea.md` (2026-10-26) lists candidate features for desktop/mobile, numbered so they
can be picked by number. None is approved; #2 (visual scheduling board) is marked done.
