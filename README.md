# Integr8 Plus

Multi-tenant field operations platform: inventory, work orders, scheduling, and a
super-admin-built form engine, sold to companies on subscription.

The full build plan lives in [`plan/`](./plan/README.md). Start with
[`plan/ROADMAP.md`](./plan/ROADMAP.md).

## Requirements

| Tool | Version | Notes                                                    |
| ---- | ------- | -------------------------------------------------------- |
| Node | 22.x    | Pinned in `.nvmrc`; run `nvm use`                        |
| pnpm | 10.x    | `corepack enable` picks up the version in `package.json` |

## Getting started

```bash
git clone https://github.com/MinaLouisLeon/integr8-plus.git
cd integr8-plus
corepack enable
pnpm install          # also installs the git hooks
pnpm build
```

Copy the environment template for each app you intend to run:

```bash
for app in api desktop mobile; do cp "apps/$app/.env.example" "apps/$app/.env"; done
cp apps/web/.env.example apps/web/.env.local   # Next reads .env.local
cp packages/db/.env.example packages/db/.env
cp packages/auth/.env.example packages/auth/.env
pnpm --filter @integr8/auth keygen   # prints the three signing-key variables
```

Anything touching the database needs a Postgres to point at.
[`docs/database/runbook-supabase-setup.md`](./docs/database/runbook-supabase-setup.md)
creates one from nothing in about fifteen minutes. Until then, `pnpm build`,
`pnpm lint`, `pnpm typecheck` and `pnpm test` all work without one.

## Running the apps

```bash
pnpm dev                                   # every app, in parallel
pnpm --filter @integr8/api dev             # the API — everything else calls it
pnpm --filter @integr8/web dev             # http://localhost:3001
pnpm --filter @integr8/desktop dev         # http://localhost:3002, as a browser page
pnpm --filter @integr8/desktop tauri:dev   # the same bundle, as a window
pnpm --filter @integr8/mobile dev          # Metro; press i or a
```

Interface conventions — tokens, translation and right-to-left layout — are in
[`docs/ui/`](./docs/ui/README.md).

| App            | Package            | What it is today                                                                             |
| -------------- | ------------------ | -------------------------------------------------------------------------------------------- |
| `apps/api`     | `@integr8/api`     | Fastify service: versioned `/v1` routes, generated OpenAPI, idempotency, jobs, rate limiting |
| `apps/web`     | `@integr8/web`     | Placeholder. Next.js shell arrives in **P05**                                                |
| `apps/desktop` | `@integr8/desktop` | Placeholder. React SPA + Tauri v2 shell arrive in **P05**                                    |
| `apps/mobile`  | `@integr8/mobile`  | Placeholder. Expo shell arrives in **P05**                                                   |

Check the API is up:

```bash
pnpm --filter @integr8/api dev
curl http://localhost:3000/health
```

## Shared packages

| Package                      | Purpose                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `@integr8/core`              | Domain types and zod schemas. The only place a shared type lives              |
| `@integr8/db`                | Schema, migrations, repositories, tenant isolation. The only place SQL is run |
| `@integr8/typescript-config` | `base` / `node` / `react` tsconfig presets                                    |
| `@integr8/eslint-config`     | Flat ESLint config with type-aware rules                                      |

Nothing outside `@integr8/db` may import `kysely` or `pg` — ESLint rejects it.
Application code reaches the database through `getTenantDataSource(tenantId)` and
the repositories, which is what keeps one company's data away from another's.
See [`docs/database/`](./docs/database/README.md).

## Everyday commands

| Command                 | Does                                                  |
| ----------------------- | ----------------------------------------------------- |
| `pnpm build`            | Builds every package in dependency order              |
| `pnpm lint`             | ESLint across the workspace                           |
| `pnpm typecheck`        | `tsc --noEmit` per package                            |
| `pnpm test`             | Vitest per package; needs no database                 |
| `pnpm test:integration` | Database, auth and API suites against a real Postgres |
| `pnpm format`           | Prettier, writing changes                             |
| `pnpm format:check`     | Prettier, failing on drift (what CI runs)             |
| `pnpm clean`            | Removes build output and caches                       |

Add `--filter @integr8/<name>` to scope any of them to one package.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branch naming, commit format, the git hooks
and the CI pipeline.
