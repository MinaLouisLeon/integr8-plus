# Architecture

## The shape

```
 browsers ──────────┐          ┌──── desktop apps (Tauri)        phones (Expo, offline)
   apps/web (Next.js)│          │     apps/desktop                  apps/mobile
                     ▼          ▼                                       │ queued changes,
                 ┌──────────────────────────────┐ ◀─────────────────────┘ pull by cursor
                 │ apps/api — Fastify, /v1 only │
                 │ routes → repositories        │──── Auth container (passwords, codes)
                 └──────────────┬───────────────┘──── R2 / local files, mail, push, PDF
                                │ @integr8/db only
                        ┌───────▼────────┐
                        │ Postgres 16    │ ◀── worker (same code, apps/api/src/jobs)
                        └────────────────┘
```

**The API is the only boundary.** No client reaches Postgres or the Auth
container. Every write goes through a route, which does validation, numbering,
stock movements, ledger postings and audit lines; that is also why the demo
seeder calls the real routes rather than inserting rows.

**Only `@integr8/db` runs SQL.** Importing `kysely` or `pg` anywhere else is a
lint error. Application code gets `getTenantDataSource(tenantId)` (row-level
security applies) or `getPlatformDataSource()` (staff and cross-company work)
and calls repositories. See [database/](./database/README.md).

## The monorepo

pnpm 10 workspaces and Turborepo. Node `>=22.22.1 <23` (22.23.4 in `.nvmrc`),
TypeScript 6.0.3 (pinned: TypeScript 7 switches off type-aware linting), Vitest,
ESLint flat config, Prettier. Every dependency is pinned to an exact version
(`pnpm pins:check`).

| Path                         | What                                                                                                           |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `apps/api`                   | Fastify `/v1` service (port 3000), the worker, CLIs: `platform/admin-cli`, `demo/cli`, `transfer/cli`, storage |
| `apps/web`                   | Next.js: public site, company workspace `(app)/…`, platform dashboard `platform/…` (port 3001)                 |
| `apps/desktop`               | React + Vite SPA in Tauri v2, `staff` and `company` flavours (port 3002 in a browser)                          |
| `apps/mobile`                | Expo Router, SQLCipher database, queued sync; one build per company                                            |
| `apps/forms-ai`              | Integr8 Forms for AI: offline MCP server and installer for AI tools writing `.integr8form` files               |
| `apps/dev-mcp`               | Developer MCP server: test companies on a running API, plus every Forms for AI tool                            |
| `packages/core`              | Domain types, zod schemas, roles and the permission matrix, navigation model, state machines, money            |
| `packages/db`                | Migrations, `schema.ts`, repositories, tenant isolation, the migrator, seeds, `db:volume`/`db:plans`           |
| `packages/auth`              | Tokens, sessions, refresh rotation, impersonation, offline grants, `IdentityProvider`                          |
| `packages/api-client`        | Typed client generated from `apps/api/openapi.json`, and `SessionManager`                                      |
| `packages/form-engine`       | The pure form engine, form actions, the conformance suite                                                      |
| `packages/form-package`      | The `.integr8form` file: pack, strict unpack, publish-level check (Node only)                                  |
| `packages/form-input`        | Engine state → what a form filler shows                                                                        |
| `packages/form-renderer-dom` | Form and submission screens for web and desktop                                                                |
| `packages/operations-dom`    | The office's screens shared by web and desktop                                                                 |
| `packages/offline`           | The phone's SQLite schema, queries, search, eviction and sync engine (no React Native inside)                  |
| `packages/i18n`              | English and Arabic catalogues, the help library, direction helpers                                             |
| `packages/tokens`            | Design tokens, themes, brand accent, self-hosted fonts                                                         |
| `packages/document-render`   | Printable documents (PDF templates and business PDFs)                                                          |
| `packages/eta`               | Egyptian Tax Authority e-invoicing: canonical form, documents, client                                          |

Apps never import from each other, with one exception: `apps/dev-mcp` (never
shipped) imports `@integr8/forms-ai/tools`. Shared domain types live only in
`@integr8/core`. There is no shared UI component package: each app owns its
`components/ui`, and web and desktop share whole screens through
`operations-dom` and `form-renderer-dom`.

## A request, end to end

1. The client sends `x-client-app` and `x-client-version` with every request, a
   bearer token (or the web's cookie, turned into one by the Next.js server),
   and `Idempotency-Key` on a write that must not repeat.
2. The API checks, cheapest first: CORS, client version, per-address rate limit,
   validation, authentication and session liveness, suspension, permission,
   module switch, per-company rate limit, idempotency. See [api/](./api/README.md).
3. The handler opens one tenant transaction (`set_config('app.tenant_id', …,
true)` first), calls repositories, writes its audit line and queues any
   background job in the same transaction.
4. The worker picks queued jobs up (PDFs, mail, push, document re-prints, ETA
   submissions) and runs the scheduled tasks below.

## The worker

`apps/api/src/jobs/worker-main.ts`, the `worker` service in compose. It drains
the `jobs` queue (leases, retries with backoff: `WORKER_*` settings) and runs
these tasks on their own schedules, the daily ones claim their turn in the database (`scheduled_task_runs`), so they run once a night however many workers run:

| Task                     | Does                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Media maintenance        | Sweeps unconfirmed uploads and aborted parts, deletes files due to go                                       |
| Sync maintenance         | Prunes the phone change log (`SYNC_LOG_RETENTION_DAYS`)                                                     |
| Scheduled deletions      | Purges companies whose closing period has passed                                                            |
| Metering                 | Daily storage samples per company                                                                           |
| Dunning                  | Unpaid companies: refuses writes and posts banners; never deletes data                                      |
| Signup expiry            | Expires unverified sign-up requests                                                                         |
| Qualification expiry     | Warns once, by email and to the phone, of certificates expiring or lapsed                                   |
| Maintenance plans        | Makes jobs ahead of due dates and renews contracts, daily; a failed plan is retried alone, up to five times |
| Deadline alerts          | Records missed deadlines and sends warnings, at most every ten minutes                                      |
| Assistant reconciliation | Frees unsettled usage slots, expires unconfirmed proposals, deletes chats past retention                    |
| Table housekeeping       | Nightly: rate-limit counters, spent idempotency records, old login attempts                                 |
| Year partitions          | `ensure_year_partitions()`: this year's and next year's partitions exist                                    |

## External services and their stand-ins

Each outside service sits behind an interface with a recording stand-in, chosen
by a setting, and `apps/api/src/config.ts` refuses to start production on a
stand-in or a half-configured switch.

| Setting            | Values (default first)                                       | Real service                            |
| ------------------ | ------------------------------------------------------------ | --------------------------------------- |
| `MEDIA_STORAGE`    | `local`, `r2`                                                | Cloudflare R2, a bucket per company     |
| `EMAIL_SENDER`     | `recording`, `resend`                                        | Resend                                  |
| `PUSH_SENDER`      | `recording`, `expo`                                          | Expo push                               |
| `GEOCODER`         | `fake`, `mapbox`                                             | Mapbox geocoding                        |
| `BILLING_PROVIDER` | `recording`, `none`, `stripe`                                | Stripe (or invoiced only)               |
| `PDF_RENDERER`     | `chromium`, `recording`                                      | Chromium in the API image               |
| `AI_PROVIDER`      | `none`, `recording`, `groq`, `gemini`, `anthropic`, `openai` | The chosen model provider               |
| `APP_BUILDS`       | `off`, `github`                                              | GitHub Actions company builds           |
| Identity           | `FakeIdentityProvider` in tests only                         | The self-hosted Supabase Auth container |

Test companies never reach the real mail or push service: their messages go to
`test_outbox` whatever the setting says.

## Settings

Every setting is documented where it is read (the zod schema comments in each
app's `config.ts`) and in the matching `.env.example`; `deploy/.env.example`
covers a whole deployment, and `deploy/compose.yml` hands each service only the
settings it reads (`compose-env.test.ts` fails otherwise). Errors and traces go
to Sentry when `SENTRY_DSN` is set (`apps/api/src/observability/sentry.ts`).
