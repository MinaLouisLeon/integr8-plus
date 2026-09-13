# Integr8 Plus — Build Plan

Multi-tenant field operations platform: inventory, work orders, scheduling, and a
super-admin-built form engine, sold to companies on subscription.

This folder is the single source of truth for **what gets built, in what order, and
what is already done**.

---

## How this plan is organised

Work is grouped into **versions**. Each version is a shippable release with a goal and
exit criteria. Each version contains numbered **phases** (`P01`…`P35`), one file each.

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
- [~] **P04** — API skeleton and contract
- [~] **P05** — Application shells

### v0.2 — Form Engine

> The heart of the product. An admin builds a form on the desktop; someone fills it and it is stored correctly and immutably.

- [~] **P06** — Form schema and logic core
- [ ] **P07** — Form builder UI
- [ ] **P08** — Web renderer and submissions
- [ ] **P09** — Media pipeline on R2

### v0.3 — Field Loop

> A real engineer completes a real job on a phone, in a basement, with no signal.

- [ ] **P10** — Customers, sites and work orders
- [ ] **P11** — Mobile shell and local database
- [ ] **P12** — Offline sync engine
- [ ] **P13** — Mobile form renderer
- [ ] **P14** — Job execution on mobile

### v1.0 — Launch

> One paying company running production work through the product.

- [ ] **P15** — Super admin dashboard
- [ ] **P16** — Storage metering and quotas
- [ ] **P17** — Subscriptions and billing
- [ ] **P18** — Marketing site and self-serve onboarding
- [ ] **P19** — Production hardening
- [ ] **P20** — Packaging, signing and release
- [ ] **P21** — First customer onboarding

### v1.1 — Inventory and Assets

- [ ] **P22** — Item catalogue and stock ledger
- [ ] **P23** — Van stock and job consumption
- [ ] **P24** — Asset register and service history

### v1.2 — Scheduling and Dispatch

- [ ] **P25** — Calendar and dispatch board
- [ ] **P26** — Availability, skills and conflicts
- [ ] **P27** — Preventive maintenance and reminders

### v1.3 — Reporting, Comms and AI

- [ ] **P28** — Reporting and dashboards
- [ ] **P29** — Branded PDF reports and customer notifications
- [ ] **P30** — AI form generation
- [ ] **P31** — Meetings and calendar sync

### v2.0 — Scale and Enterprise

- [ ] **P32** — Arabic and full RTL
- [ ] **P33** — Public API, webhooks and integrations
- [ ] **P34** — Enterprise access and security review
- [ ] **P35** — Dedicated-instance tier

---

## Locked technical decisions

These were decided before planning and are assumed throughout. Changing one invalidates
several phases, so change them deliberately.

| Decision       | Choice                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------- |
| Database       | One shared Supabase Postgres; every company isolated by `tenant_id` + RLS                          |
| Authentication | Supabase Auth, tenant claims in the JWT; super admin identity kept outside tenant auth             |
| File storage   | Cloudflare R2, **one bucket per company**, so usage is measurable per company                      |
| API            | Own service in front of Postgres; REST + OpenAPI, versioned; clients never query Supabase directly |
| Desktop        | React SPA wrapped by Tauri v2; the same bundle also deploys as a browser app                       |
| Mobile         | Expo, offline-first; fills forms, never builds them                                                |
| Website        | Next.js — marketing, self-serve signup, billing portal, super admin dashboard                      |

## Explicit non-goals

- No form building on mobile.
- No database per company at launch — that is P35, sold as an enterprise tier.
- No custom code per customer. Everything customer-specific goes through forms, task
  types, roles or feature flags.
- No on-premise deployment.
- No invoicing or accounting engine — export to QuickBooks, Xero or Zoho instead.
