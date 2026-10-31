# Integr8 Plus — Build Plan

Multi-tenant field operations platform: inventory, work orders, scheduling, and a
super-admin-built form engine, sold to companies on subscription.

This folder is the single source of truth for **what gets built, in what order, and
what is already done**.

---

## How this plan is organised

Work is grouped into **versions**. Each version is a shippable release with a goal and
exit criteria. Each version contains numbered **phases** (`P01`…`P36`), one file each.

```
plan/
├── README.md              ← you are here: index + progress
├── ROADMAP.md             ← the version ladder and why this order
└── v<version>-<name>/
    └── P<nn>-<slug>.md    ← one phase
```

Phases are numbered globally and sequentially. `P07` always means the same thing no
matter which version folder it lives in.

## Status values

Every phase file carries a `**Status:**` line in its header. Only these values are used:

| Value                    | Meaning                                                  |
| ------------------------ | -------------------------------------------------------- |
| `NOT STARTED`            | No work has begun                                        |
| `IN PROGRESS`            | Started, not finished                                    |
| `BLOCKED`                | Cannot proceed — the reason is written in the phase file |
| `COMPLETED — YYYY-MM-DD` | Every exit criterion is met and verified                 |

## Completing a phase

A phase is complete when **every exit criterion in its file is verifiably true** — not
when the code is written. Then, in one commit:

1. Tick every `- [ ]` box in the phase file.
2. Change its `**Status:**` line to `COMPLETED — YYYY-MM-DD`.
3. Tick the phase's row in the progress table below.
4. Commit as `docs(plan): complete P07 — form builder UI`.

Do not mark a phase complete with unticked exit criteria. If something was cut, delete
it from the file and note why, so the plan stays honest.

---

## Progress

Legend: `[ ]` not started · `[~]` in progress · `[x]` completed · `[!]` blocked

### v0.1 — Foundation

> The rails. Nothing user-visible ships here, and skipping it means rewriting everything later.

- [x] **P01** — Monorepo and tooling
- [~] **P02** — Database and multi-tenancy
- [~] **P03** — Authentication and roles
- [x] **P04** — API skeleton and contract
- [~] **P05** — Application shells

### v0.2 — Form Engine

> The heart of the product. An admin builds a form on the desktop; someone fills it and it is stored correctly and immutably.

- [~] **P06** — Form schema and logic core
- [~] **P07** — Form builder UI
- [x] **P08** — Web renderer and submissions
- [~] **P09** — Media pipeline on R2

### v0.3 — Field Loop

> A real engineer completes a real job on a phone, in a basement, with no signal.

- [~] **P10** — Customers, sites and work orders
- [~] **P11** — Mobile shell and local database
- [~] **P12** — Offline sync engine
- [~] **P13** — Mobile form renderer
- [~] **P13b** — Repeating groups
- [~] **P14** — Job execution on mobile

### v1.0 — Launch

> One paying company running production work through the product.

- [~] **P15** — Super admin dashboard
- [~] **P16** — Storage metering and quotas
- [~] **P17** — Subscriptions and billing
- [~] **P18** — Marketing site and self-serve onboarding
- [~] **P19** — Production hardening
- [ ] **P20** — Packaging, signing and release
- [ ] **P21** — First customer onboarding
- [~] **P36** — Self-hosted sign-in (merged; the test-box run remains)

### v1.1 — Inventory and Assets

- [x] **P22** — Item catalogue and stock ledger
- [~] **P23** — Van stock and job consumption
- [~] **P24** — Asset register and service history

### v1.2 — Scheduling and Dispatch

- [~] **P25** — Calendar and dispatch board
- [~] **P26** — Skills and certificates
- [~] **P27** — Maintenance plans, contracts and response deadlines

### v1.3 — Reporting, Comms and AI

> Not started as phases, but parts already exist from the module plans below (October 2026
> review): CSV exports and the CRM and ledger reports (P28), the PDF document designer with
> Arabic PDFs (P29), and the AI assistant, which answers and prepares actions but does not
> build forms (P30).

- [ ] **P28** — Reporting and dashboards
- [ ] **P29** — Branded PDF reports and customer notifications
- [ ] **P30** — AI form generation
- [ ] **P31** — Meetings and calendar sync

### v2.0 — Scale and Enterprise

> P32 is largely built (every string in Arabic, RTL enforced by lint). Website keys are a first
> piece of P33, and company roles, the audit log and per-company export are pieces of P34.

- [~] **P32** — Arabic and full RTL
- [ ] **P33** — Public API, webhooks and integrations
- [ ] **P34** — Enterprise access and security review
- [ ] **P35** — Dedicated-instance tier

---

## Module plans outside the phase list

Several modules were planned and built in their own documents rather than as phases. Their
status lives there:

| Module                                                                                 | Plan and status                                                                                                     |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| CRM, sales, finance, ledger, inventory, purchasing, assets, HR, payroll, manufacturing | [`docs/crm-erp/PLAN.md`](../docs/crm-erp/PLAN.md), tracker in [`docs/crm-erp/README.md`](../docs/crm-erp/README.md) |
| AI assistant                                                                           | [`docs/ai/IMPLEMENTATION_STATUS.md`](../docs/ai/IMPLEMENTATION_STATUS.md)                                           |
| PDF business documents and the company website data API                                | [`docs/documents/PLAN.md`](../docs/documents/PLAN.md), [`WEBSITE-LOOKUP.md`](../docs/documents/WEBSITE-LOOKUP.md)   |
| Egyptian e-invoicing (test-only until validated)                                       | [`docs/e-invoicing/PLAN.md`](../docs/e-invoicing/PLAN.md)                                                           |

## Locked technical decisions

These were decided before planning and are assumed throughout. Changing one invalidates
several phases, so change them deliberately.

| Decision       | Choice                                                                                                                       |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Database       | Self-hosted Postgres, one shared database; every company isolated by `tenant_id` + RLS (P36)                                 |
| Authentication | Self-hosted Supabase Auth (identity only), tenant claims in our own JWT; super admin identity kept outside tenant auth (P36) |
| File storage   | Cloudflare R2, **one bucket per company**, so usage is measurable per company                                                |
| API            | Own service in front of Postgres; REST + OpenAPI, versioned; clients never query Postgres or Auth directly                   |
| Desktop        | React SPA wrapped by Tauri v2; the same bundle also deploys as a browser app                                                 |
| Mobile         | Expo, offline-first; fills forms, never builds them                                                                          |
| Website        | Next.js — marketing, sign-up (off by default: staff onboard companies), billing portal, super admin dashboard                |

## Explicit non-goals

- No form building on mobile.
- No database per company at launch — that is P35, sold as an enterprise tier.
- No custom code per customer. Everything customer-specific goes through forms, task
  types, roles or feature flags.
- No on-premise deployment.
- No statutory accounting. The finance and ledger modules (docs/crm-erp, ADR-0007 and ADR-0009)
  are management tools; a company's statutory accounts stay with its accountant. This line
  once said "no invoicing engine — export to QuickBooks, Xero or Zoho instead"; invoicing was
  built and the accounting export was not (it belongs to P33).
