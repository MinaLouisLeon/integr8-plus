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
for app in api web desktop mobile; do cp "apps/$app/.env.example" "apps/$app/.env"; done
```

## Running the apps

```bash
pnpm dev                            # every app, in parallel
pnpm --filter @integr8/api dev      # just one
```

| App            | Package            | What it is today                                                                                         |
| -------------- | ------------------ | -------------------------------------------------------------------------------------------------------- |
| `apps/api`     | `@integr8/api`     | Node HTTP process serving `/health`. Framework, OpenAPI contract and tenant middleware arrive in **P04** |
| `apps/web`     | `@integr8/web`     | Placeholder. Next.js shell arrives in **P05**                                                            |
| `apps/desktop` | `@integr8/desktop` | Placeholder. React SPA + Tauri v2 shell arrive in **P05**                                                |
| `apps/mobile`  | `@integr8/mobile`  | Placeholder. Expo shell arrives in **P05**                                                               |

Check the API is up:

```bash
pnpm --filter @integr8/api dev
curl http://localhost:3000/health
```

## Shared packages

| Package                      | Purpose                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| `@integr8/core`              | Domain types and zod schemas. The only place a shared type lives |
| `@integr8/typescript-config` | `base` / `node` / `react` tsconfig presets                       |
| `@integr8/eslint-config`     | Flat ESLint config with type-aware rules                         |

## Everyday commands

| Command             | Does                                      |
| ------------------- | ----------------------------------------- |
| `pnpm build`        | Builds every package in dependency order  |
| `pnpm lint`         | ESLint across the workspace               |
| `pnpm typecheck`    | `tsc --noEmit` per package                |
| `pnpm test`         | Vitest per package                        |
| `pnpm format`       | Prettier, writing changes                 |
| `pnpm format:check` | Prettier, failing on drift (what CI runs) |
| `pnpm clean`        | Removes build output and caches           |

Add `--filter @integr8/<name>` to scope any of them to one package.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branch naming, commit format, the git hooks
and the CI pipeline.
