# CLAUDE.md

The project rules live in `AGENTS.md` (shared with other coding agents) and are imported
here so there is one source of truth:

@AGENTS.md

Current state, recent decisions and known gotchas live in `MEMORY.md`:

@MEMORY.md

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
