# Integr8 Plus

A multi-tenant field-operations and business platform. Integr8 sells it to
service companies (maintenance, installation, inspection), mainly in Egypt, and
sets each company up with its own forms, job types, look and apps. The company's
office plans and dispatches work in its own desktop app; its engineers do the
work on its own phone app, which keeps working with no signal; Integr8 staff run
everything from the staff desktop app. The web app is the public site only.
English and Arabic throughout.

Current version: **2.0.0**. The documentation starts at
[`docs/README.md`](./docs/README.md); what is not finished is in
[`plan/README.md`](./plan/README.md).

| Who                          | Uses                                        |
| ---------------------------- | ------------------------------------------- |
| Integr8 staff (super admins) | The staff desktop app                       |
| A company's office           | The company's own desktop app               |
| A company's engineers        | The company's own phone app (works offline) |

**What it does:** customers and sites, work orders, dispatch and the schedule
board, visits, timesheets, skills and certificates, contracts, maintenance plans
and deadlines; forms built by Integr8 and filled on any device, with PDF
documents; and, switched on per company, CRM, sales, finance, a general ledger,
inventory, purchasing, assets, HR and expenses, Egyptian payroll, manufacturing,
Egyptian Tax Authority e-invoicing (test only) and an AI assistant. See
[`docs/modules/`](./docs/modules/README.md).

## The repository

A pnpm and Turborepo monorepo: `apps/api` (Fastify `/v1`, the worker, CLIs),
`apps/web` (Next.js), `apps/desktop` (React in Tauri), `apps/mobile` (Expo),
`apps/forms-ai` and `apps/dev-mcp` (MCP servers for AI tools), and shared
packages under `packages/`. See [`docs/architecture.md`](./docs/architecture.md).

## Getting started

| Tool     | Version                                     | For                                         |
| -------- | ------------------------------------------- | ------------------------------------------- |
| Node     | 22.22.1 or newer 22.x (22.23.4 in `.nvmrc`) | Everything                                  |
| pnpm     | 10.x (`corepack enable`)                    | Everything                                  |
| Postgres | 16                                          | The API, the CLIs and the integration tests |
| Rust     | stable                                      | Only the desktop app as a native window     |

```bash
corepack enable
pnpm install          # also installs the git hooks
pnpm build            # build, lint, typecheck and test need no database

for app in api desktop mobile; do cp "apps/$app/.env.example" "apps/$app/.env"; done
cp apps/web/.env.example apps/web/.env.local
cp packages/db/.env.example packages/db/.env
cp packages/auth/.env.example packages/auth/.env
pnpm --filter @integr8/auth keygen         # signing keys and the Auth container's secrets

pnpm --filter @integr8/db db deploy        # create the database roles, apply the migrations
pnpm --filter @integr8/db db:templates     # the form template library
pnpm --filter @integr8/api demo-company --owner-email you@example.com   # optional: a full demo company

pnpm --filter @integr8/api dev             # http://localhost:3000
pnpm --filter @integr8/web dev             # the public site, http://localhost:3001
pnpm --filter @integr8/desktop dev         # http://localhost:3002 (tauri:dev for a window)
pnpm --filter @integr8/mobile dev          # Metro
```

Every outside service has a local stand-in chosen by a setting
(`MEDIA_STORAGE=local`, `GEOCODER=fake`, `PUSH_SENDER=recording`,
`EMAIL_SENDER=recording`, `APP_RELEASES=off`); production refuses to
start on any of them. The database settings are in
[`docs/contributing/`](./docs/contributing/README.md#before-you-start).

## The database

Postgres 16, one schema shared by every company, each row keyed by `tenant_id`
with row-level security as the backstop. 2.0.0 started the migrations again from
one per module; 0020 removed sign-up and card billing (P42); a new feature adds
the next number after `0020`.

| Migration | Module                                                                               |
| --------- | ------------------------------------------------------------------------------------ |
| 0001      | Foundation: tenants, platform staff, settings, feature flags, plans, the job queue   |
| 0002      | Identity: people, roles, sign-in, sessions, devices, the audit log                   |
| 0003      | Platform: staff sessions and audit, billing, sign-up, exports and deletions          |
| 0004      | Files: stored files, uploads, storage metering                                       |
| 0005      | Field work: customers, sites, job types, work orders, visits, shifts, qualifications |
| 0006      | Forms: forms, versions, submissions, the template library, PDF documents             |
| 0007      | Phone sync: the change log and sync reports                                          |
| 0008      | CRM: leads, pipelines, opportunities, activities                                     |
| 0009      | Ledger: chart of accounts, journals, periods, year-end closes, postings              |
| 0010      | Inventory: items, locations, stock movements, counts, lots, materials on jobs        |
| 0011      | Purchasing: suppliers, purchase orders, receipts, supplier prices, van requests      |
| 0012      | Sales: quotes, sales orders, deliveries                                              |
| 0013      | Finance: invoices, credit notes, payments                                            |
| 0014      | Assets: customer assets and their history                                            |
| 0015      | HR: employees, expense claims, payroll                                               |
| 0016      | Manufacturing: bills of materials, assembly orders, material planning                |
| 0017      | Contracts: service contracts, maintenance plans, deadlines                           |
| 0018      | E-invoicing: the Egyptian Tax Authority                                              |
| 0019      | The AI assistant: conversations, actions, usage and cost                             |
| 0020      | Desktop only (P42): drops sign-up, card billing and the web assistant switch         |

See [`docs/database/`](./docs/database/README.md).

## Deploying

One server running `deploy/compose.yml` behind Caddy; the operator's whole
procedure is [`docs/deployment/setup-checklist.md`](./docs/deployment/setup-checklist.md)
(also as an interactive HTML page). Overview: [`docs/deployment/`](./docs/deployment/README.md).

## Contributing

Branches, commits, checks and the rules lint and tests enforce:
[`docs/contributing/`](./docs/contributing/README.md). Coding agents start with
[`CLAUDE.md`](./CLAUDE.md), [`AGENTS.md`](./AGENTS.md) and [`MEMORY.md`](./MEMORY.md).
