# Integr8 Plus — CRM + ERP Implementation Master Plan for Claude Code

> **Status:** Implementation specification / instructions to coding agent, NOT a claim that the features have already been implemented.  
> **Prepared:** 2026-10-11  
> **Repository:** https://github.com/MinaLouisLeon/integr8-plus  
> **Source baseline:** `main`, version `0.1.4`, and user-provided `project-report(1).md` dated 2026-10-11.  
> **Business constraints:** Commercial multi-tenant SaaS, solo developer, idea-validation stage, **no required paid software licenses or subscriptions**, retain English/Arabic RTL, preserve existing apps and field operations.

> **Tracking:** this is the plan as received on 2026-10-11, kept verbatim except for the `Status:` line under each phase in §12. What has actually been built, phase by phase, with migrations, commits and decisions, is in **[README.md → Phase tracker](./README.md#phase-tracker)**. Update both when a phase changes state.

---

## 0. INSTRUCTIONS TO CLAUDE CODE — READ FIRST

You are implementing **new native CRM and ERP business modules inside the existing Integr8 Plus monorepo**. Do not scaffold a new application or import an entire third-party ERP/CRM system. **This document is a roadmap, not permission to implement all phases at once.**

### Mandatory operating procedure

1. Read this document and the **actual current repository** before changing code. Start with `AGENTS.md`, `README.md`, `CONTRIBUTING.md`, root `package.json`, workspace packages, existing `plan/` documents, and the relevant modules identified below. The baseline may have moved; current source code wins. Report discrepancies rather than forcing this plan onto changed code.
2. Confirm `git status`, `git branch --show-current`, the target branch, and any uncommitted user changes. Do **not** delete or overwrite user work. If working tree is clean, branch from current `main` (after ensuring it is up to date) using e.g. `feat/crm-erp-foundation`. If dirty or branch state is ambiguous, preserve work and explain the safe branch strategy before modifying files.
3. Before phase implementation, write an architecture impact inventory in `docs/crm-erp/00-repository-assessment.md`, with actual paths, patterns, existing migrations, API shapes, permission tests, i18n format, worker API, and any clashes with planned modules.
4. Make a **small, reviewable PR per vertical slice**, not a single massive change. Prioritize Foundation + CRM MVP first. Do not start accounting, payroll, manufacturing, or advanced automation until explicitly authorized.
5. Before installing **every** new package, inspect its published package metadata, license file and important transitive licenses. Record package/version/license/source/reason in `docs/crm-erp/dependencies.md`. Disallow paid plugins, feature-gated enterprise imports, paid hosted prerequisites, GPL/AGPL/SSPL/network-copyleft packages without explicit legal approval. Prefer existing packages and a small amount of native code.
6. Use **existing code conventions**: strict TS, pnpm, Turborepo, `zod` route declarations, OpenAPI generated client, Kysely repositories, SQL migrations, PostgreSQL tenant RLS, shared i18n, design tokens, operation screens, current tests, CI, and current app routing styles.
7. All new tables with tenant-owned data require tenant-scoped access controls and constraints. Add `tenant_id`, compound tenant foreign keys where references permit, RLS policies, runtime grants, audit coverage, and cross-tenant denial tests. **Do not assume the service's privileged owner pool is safe for tenant CRUD.**
8. Keep persisted financial values exact: **never JavaScript floats for money or quantities**. Use PostgreSQL `numeric` and a tested decimal library when calculations truly require one. Define currency, tax rounding, conversion and precision policies before posting financial records.
9. All external-facing strings, navigation labels, validation and errors require matching **English and Arabic** translations; support RTL and keyboard/accessibility. New routes must support deep-linking/back navigation on web and desktop. Do not reintroduce a debug RTL toggle.
10. Add regression tests and migration up/down/re-up validation. Run repo lint, typecheck, unit/integration tests, OpenAPI drift check, translations parity, and build. Report commands, results and any not runnable with specific reasons. Do not claim checks passed without running them.
11. **Stop after each PR / milestone** and summarize files changed, database changes, API contracts, manual test steps, license impact, known risks, and the next proposed slice. Never push or deploy without the user's authorization.
12. Where this plan says **proposal**, inspect and adapt to actual naming and constraints; avoid duplicate concepts and breaking changes. Ask only truly blocking questions (jurisdiction, finance go-live, scope conflicts) at the point they become relevant; otherwise use the conservative default documented here.

### Definition of success

A company user can capture a lead, qualify it, turn it into a customer/opportunity, issue a quotation, convert it to an order and work order, allocate/consume inventory, issue an invoice and record a payment **without duplicating customer identities** or bypassing tenant permissions. This is the eventual end state; the MVP delivers the shorter lead→opportunity→customer segment.

### Priority convention

- **MVP / P0:** foundation, lead management, opportunities, activities, Customer 360, simple pipeline reporting.
- **P1:** catalog, inventory and supplier foundation; quotations, sales orders, purchasing, stock consumption, simple customer invoices, payments, job costs.
- **P2:** assets/maintenance, advanced reports, accounting general ledger, multi-currency/accounting periods, more workflows and portals.
- **Deferred:** country-specific payroll, manufacturing/MRP, complex tax localization, consolidation, sophisticated campaigns, enterprise integrations, full mobile ERP.

---

## 1. Verified baseline and architectural constraints

### 1.1 What exists today

The supplied report documents four apps: `apps/api` (Fastify 5 + Node 22, worker), `apps/web` (Next.js 16 / React 19), `apps/desktop` (Tauri 2 / Vite / React), `apps/mobile` (Expo 57 / React Native / SQLite). Workspace: pnpm 10 + Turborepo. Database: PostgreSQL 16 / Kysely 0.28 / `pg`; API contract is Zod → OpenAPI 3.0.3 → `packages/api-client` with `openapi-fetch`. Cross-platform translations are handled by `packages/i18n`, with English and Arabic/RTL. Shared `packages/operations-dom` already supplies customer/site/work-order screens. Tests use Vitest, fast-check, integration harness, with current CI.

The report enumerates **158 `/v1` endpoints**, **23 paired SQL migrations**, **13 shared packages** and **five tenant roles**: `owner`, `admin`, `dispatcher`, `engineer`, `viewer`. Staff have audited impersonation; `form.manage`, `job_type.manage`, `branding.manage` are staff-only overlays. Existing tenants, customers, customer contacts, sites, work orders, submissions, files/media, jobs/timesheets, billing and plan entitlements must be retained.

GitHub inspection independently confirmed, on `main`: `package.json` version `0.1.4`; `packages/core/src/permissions.ts` uses a complete per-role permission matrix plus `STAFF_ONLY_PERMISSIONS`; `packages/core/src/navigation.ts` exposes shared `NAV_SECTIONS`, `NAV_GROUPS`, `visibleNavigation`; `packages/db/migrations/0010_customers_sites_work_orders.up.sql` creates `customers`, `customer_contacts`, `sites`, `work_orders` with tenant-aware constraints; `plan/v1.1-inventory/P22-item-catalogue-and-stock-ledger.md` is explicitly **NOT STARTED** and specifies an immutable stock-movement ledger. Existing roadmap P23/P24 addresses van stock/consumption and assets.

**Do not confuse** existing `/v1/billing/*` (Integr8 subscription billing) with the new **tenant-facing accounts receivable and invoicing** system. Keep separate namespaces, services and storage. Existing `customers` is the canonical CRM account/customer; do not create a parallel CRM account registry.

### 1.2 Inspect before implementation — source paths

| Existing path                                                    | What to verify / reuse                                                                          |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/api/src/routes/v1/`                                        | `defineRoute`, auth modes, errors, pagination, idempotency, versioning and OpenAPI registration |
| `packages/db/src/schema.ts`                                      | Kysely schema and type mapping patterns                                                         |
| `packages/db/src/repositories/customers.ts`                      | tenant transaction context, repo API, optimistic handling, audit conventions                    |
| `packages/db/migrations/0010_customers_sites_work_orders.up.sql` | canonical customer, site, work order links and immutable historical concerns                    |
| `packages/db/migrations/0002_row_level_security.up.sql`          | policy/grants patterns and runtime DB role                                                      |
| `packages/core/src/permissions.ts`                               | role matrix, staff overlay, ability checks and permission tests                                 |
| `packages/core/src/navigation.ts`                                | route keys, cross-app navigation model, icon mappings                                           |
| `packages/operations-dom/src/screens/`                           | reusable table/screen patterns and CRM Customer 360 extension point                             |
| `packages/i18n/`                                                 | translation catalog layout and parity tests                                                     |
| `packages/api-client/`                                           | code generation and refresh/auth flows                                                          |
| `apps/api/src/jobs/`                                             | existing Postgres lease queue; extend rather than replace                                       |
| `plan/v1.1-inventory/`                                           | honor P22/P23/P24 constraints; update roadmap instead of duplicating it                         |
| `apps/web/src/app/(app)/`                                        | route/layout conventions; side navigation and back navigation                                   |
| `apps/desktop/src/`                                              | React Router routes, native staff/company flavors, custom context menu patterns                 |
| `apps/mobile/` + `packages/offline/`                             | offline schema/outbox/sync rules; do NOT casually change these                                  |
| `deploy/`                                                        | Docker, postgres, Caddy, backups and local substitutes                                          |

### 1.3 Existing data-model decisions to preserve

- `customers` is the canonical organization/account record (name, account number, tags, statuses, addresses); `customer_contacts` belongs to a customer; `sites` belongs to a customer; `work_orders` relate customers and sites.
- Do not rename existing tables, override established IDs, or alter historical job/submission semantics. Add adjunct tables and optional links with backward-compatible migrations.
- Existing `tenants` and `tenant_users` are tenancy/membership; do not introduce another auth stack or second user identity service.
- Form definition versions remain immutable after publishing; CRM and ERP may **link** to forms and submissions but must not mutate versions.
- Audit log is append-only; new business events should be auditable with actors, effective tenant, creation/source and relevant lifecycle transitions.
- API users operate through the normal tenant DB role and transaction-scoped RLS. Staff impersonation must continue to record the acting staff member and the reason.

---

## 2. Target architecture: modular monolith, not microservices

```text
                   WEB / DESKTOP / (focused) MOBILE
                              |
                   @integr8/api-client
                              |
                  Fastify API, /v1 modules
  +--------------------+-----------------------------+
  | crm               | erp                         |
  | leads             | catalog                     |
  | opportunities     | stock ledger / warehouses   |
  | activities        | suppliers / purchasing      |
  | quotes            | orders / invoices / payments|
  +--------------------+-----------------------------+
      | shared customer, site, work-order identities |
      | company permissions, tenant RLS, audit, jobs |
                       PostgreSQL 16
```

**Proposed additive workspace layout (only create when justified):**

```text
packages/
  crm/                 # pure TS: state machine, math-free domain rules, schemas if appropriate
  crm-dom/             # reusable desktop + web React screens
  erp/                 # inventory, ordering, invoice domain rules
  erp-dom/             # reusable desktop + web React screens
  finance/             # P2 only: journal posting, balance validation (pure domain)
# Keep SQL models/repos in packages/db; auth/permissions/nav in packages/core;
# HTTP routes + jobs in apps/api; generated REST client in packages/api-client.
```

Avoid an oversized one-package-per-entity arrangement. Add a package only if genuine reuse or isolation warrants it. Keep customer and work-order detail screens in `operations-dom` while composing CRM/ERP tabs or components from the new packages to avoid duplicate pages.

### 2.1 Module feature flags and product gating

Introduce tenant feature/module capabilities for `crm`, `erp_catalog`, `erp_inventory`, `erp_sales`, `erp_purchasing`, `erp_invoicing`, later `erp_accounting`. Reuse the platform's existing `feature_flags` / `tenant_feature_flags` and plan-allowance conventions rather than invent another flag engine. Distinguish `feature enabled by platform` from `user has permission`. Both are required for protected API operations; hidden navigation alone is not authorization. Existing customers/sites/work-orders remain accessible when CRM is disabled.

### 2.2 Navigation and app scopes

Proposed web sections: `CRM` (Overview, Leads, Opportunities, Activities, Customers), `Sales` (Catalog, Quotes, Orders), `Inventory` (Items, Warehouses, Movements, Stock Count), `Purchasing` (Suppliers, POs, Receipts), `Finance` (Customer Invoices, Payments, later GL), `Operations` (existing). Desktop/company flavor should share the relevant CRM/ERP screens. **Platform staff desktop** retains current impersonation isolation and must not silently receive financial privileges. Mobile engineers get assigned work-order parts and asset access only in P1/P2; accountancy UI is deliberately not included.

### 2.3 API/versioning/design rules

- Keep route prefix `/v1` and `defineRoute` + Zod schemas; use conventional resource endpoints with typed query filters and cursor/offset conventions matched to existing API.
- New endpoints must declare permissions/feature gates, request/response types, pagination limits, stable domain errors, audit events and idempotency for creation/posting actions.
- Domain writes occur in DB transactions. For state transitions, use compare-and-swap/status guards or locked rows as appropriate.
- All returned entities include stable IDs and `created_at` / `updated_at` per existing conventions; do not leak unauthorized private data via search/autocomplete.
- Expand the generated OpenAPI document and regenerated client in the same PR; never manually edit generated client output as source of truth.
- Respect existing CSRF/CORS/session/request-ID/suspension handling; do not create a parallel Fastify server.

---

## 3. Domain map and aggregate ownership

**Identity map:**

```text
Tenant
 ├─ TenantUsers (roles, agents, sales reps, engineers)
 ├─ CRM Leads ──qualified/conversion──> Customers (EXISTING)
 │  └─ Lead activities and optional Opportunity links
 ├─ Customers (EXISTING)
 │  ├─ CustomerContacts (EXISTING)
 │  ├─ Sites (EXISTING)
 │  ├─ Opportunities ──> Quotes ──> SalesOrders
 │  ├─ Customer Invoices ──> Payment Allocations
 │  └─ WorkOrders (EXISTING) <── SalesOrder fulfillment links
 ├─ Products/Services ──> QuoteLines / SalesOrderLines / InvoiceLines
 ├─ Suppliers ──> PurchaseOrders ──> GoodsReceipts
 ├─ Warehouses/Van/Locations ──> Immutable StockMovements
 ├─ WorkOrderMaterialConsumptions ──> StockMovements
 └─ (P2) Accounts ──> Posted Journals / JournalLines
```

### 3.1 Ownership/invariants

- One tenant-owned record never references a record belonging to another tenant. Use `(tenant_id, id)` composite unique keys and composite foreign keys where appropriate.
- No duplicate `customers`/`customer_contacts`. CRM adds metadata and sidecar records as needed. Lead conversion either links an existing customer or creates exactly one customer within a transaction; link lead to customer and prevent duplicate conversion.
- Quotation is a commercial proposal; sales order is a confirmed commitment; work order is the physical execution; invoice is a receivable. Never use one entity as all four.
- Store point-in-time price, customer billing snapshot, currency, tax rate/amount, discount and product description on document lines. Later changes to catalog or customer do not rewrite issued documents.
- Business document numbers are **per tenant + document type + optional fiscal sequence**, atomically allocated at issue/confirmation, not at draft creation. Avoid collisions across concurrent requests.
- Documents that affect accounts/stock should be corrected with reversal/credit/adjustment rather than destructive edits.
- A user may have multiple tenants; ownership and actor fields must refer to verified session identity and actual tenant, not an arbitrary request body.

---

## 4. CRM specification

### CRM-01 Leads — MVP

**Function:** intake, qualification, owner assignment, source attribution, conversion, deduplication review.

Fields: ID, `tenant_id`, `display_name`, `company_name?`, `email?`, `phone?`, `source` (`manual`, `referral`, `web`, `import`, `other`), `status` (`new`, `contacted`, `qualified`, `unqualified`, `converted`), `assigned_to?` (tenant member), `estimated_value?`, `currency?`, `notes?`, `lost_reason?`, `converted_customer_id?`, `converted_contact_id?`, `converted_at?`, audit timestamps, `created_by`, optional `version` for optimistic concurrency.

Rules: at least one reachable identity/name; normalize email and phone for candidate matching but do not silently merge; status transition validation; converted lead is not converted again; conversion is idempotent, transactional and audited; no automatic customer creation for just saving a lead. For existing customer conversion, optionally create a contact with duplicate protection and explicit user choice.

UI: `/crm/leads`, `/crm/leads/new`, `/crm/leads/[id]` in web; analogous desktop routes. Table filtering by owner, status, source and created date; create/edit form; timeline; `Convert` wizard choose existing/new customer, optional opportunity; safe delete via archive, not hard-delete.

Acceptance: duplicate-conversion race produces one customer; cross-tenant linked customer is rejected; translated statuses; viewer cannot mutate; detailed audit event.

### CRM-02 Opportunities — MVP

Fields: ID, tenant, customer (nullable until linked to lead; _must have valid lead or customer_), lead (optional), title, owner, pipeline, stage, amount `numeric(20,4)` (estimate not booked revenue), `currency_code` ISO-4217, estimated_close_date, probability basis points (0–10000), status (`open`, `won`, `lost`), lost_reason, source, description, `version`, timestamps.

Support a minimal tenant-owned pipeline and ordered stages, with seeded defaults; immutable/soft-retired stage identifiers to protect existing opportunities. Required stages must include stable “won” and “lost” semantics, but display names translate. Stage changes are logged with actor/timestamp/old-new values. `won` does not automatically create an invoice or work order. Forecast is an estimate, not recognized revenue.

UI: `/crm/opportunities`, pipeline board, filters, compact detail, activities, customer link, summary cards; keyboard accessible, usable on desktop and Arabic RTL. Drag/drop optional; first implementation can update stage using an accessible select. Server rejects unauthorized transitions.

### CRM-03 Activities and tasks — MVP

Support call, email, meeting, note, follow-up, task; link to **exactly one or more supported CRM records** via explicit join tables (`crm_activity_leads`, `crm_activity_customers`, `crm_activity_opportunities`) instead of unrestricted polymorphic IDs. Fields owner, due_at, completed_at, summary, detail, outcomes, status, created_by, timestamps. Provide per-customer unified timeline with existing work-order/submission events shown as sourced read-only entries. Avoid mass duplicating existing job tasks; CRM follow-ups remain separate from job checklists.

MVP reminder: in-app due list; scheduled worker reminder can be added after email delivery is configured. No requirement to connect paid calendars/email providers.

### CRM-04 Customer 360 — MVP

Extend existing customer detail rather than fork: Overview, Contacts, Sites, CRM Activities, Opportunities, Quotes (P1), Sales Orders (P1), Work Orders (existing), Invoices/Payments (P1), Assets (P2). Make each tab permission-aware and module-aware. Aggregate endpoints should paginate independently and avoid one giant unreadably slow join. Preserve customer read behavior with CRM disabled.

### CRM-05 Quotes and pipeline analytics — P1

Create quote draft, line items, pricing, customer and address snapshots, explicit currency, discount, tax and totals, approval (optional simple tenant configuration), issue, PDF, acceptance/rejection, expiry, revision, convert to sales order. Quote statuses `draft`, `issued`, `accepted`, `rejected`, `expired`, `superseded`. Issued quote line prices are immutable. Revisions create new versions linked to prior quote; never mutate the issued version. Analytics: leads by source/status, weighted pipeline (display-only), conversion rate, won/lost counts, overdue follow-ups; ensure tenant/filter scope and time zones.

### CRM-06 Campaigns and automations — P2/deferred

Optional lightweight segmentation and configurable task reminders after the MVP is validated. Do **not** integrate a marketing automation platform, bulk email sending, purchased campaign addons, or campaign analytics in P0. Respect consent/opt-out rules before later outbound marketing.

---

## 5. ERP specification

### ERP-01 Products and services catalog — P1

Tables: `erp_items` with `kind` (`stock_item`, `non_stock_item`, `service`), unique tenant SKU, name, description, category, barcode, unit of measure, inventory tracking mode, optional preferred supplier, default unit cost, default sale price, default tax category, archival flag; `erp_item_categories`, `erp_units` (prefer standard seeded units), optional `erp_item_prices` for future price lists. **Unit prices are suggestions** and may be overridden by authorized users during quote creation; issued document lines always snapshot them.

No unit or currency conversion without a defined conversion rule. Distinguish physical tracked stock vs consumed services. Add item image using existing media linkage and storage rules.

### ERP-02 Locations and immutable inventory ledger — P1

Reuse and extend repository `plan/v1.1-inventory/P22-item-catalogue-and-stock-ledger.md` and P23/P24. Proposed tables: `erp_stock_locations` (`warehouse`, `van`, `site`, optionally `virtual`); `erp_stock_movements` (tenant, item, location, signed quantity `numeric`, movement type, reference kind + validated FK linking tables, source document, actor, timestamp, idempotency key, reversal-of); `erp_stock_transfers` and lines; `erp_stock_counts` and count lines; optional `erp_stock_lots` / `erp_serial_units` when scope approved.

**CRITICAL:** do not persist a mutable stock quantity as the source of truth. The ledger is append-only, with signed movements; transfers produce a balanced pair in one transaction. Correct mistakes through compensating movements. Balances come from aggregation or transactionally maintained **rebuildable projection** whose consistency can be checked by replay. Define negative-stock policy (default **disallow**). Use a single locking/serialization strategy when issuing stock (e.g. per tenant-item-location advisory lock or locked projection row) and test concurrent transactions; simple `SUM` read-then-write without locks is not safe. Unique idempotency/document-line constraints prevent replay double-posting. Show per-location available/on-hand/reserved separately if reservation is implemented; do not label on-hand as available when reservations exist.

P1 functional scope: receive, issue, transfer, return, adjustment (reason and approval), count variance approval, reorder threshold. Only add batches/serial tracking if customer pilot needs them; if implemented, every applicable movement must preserve matching lot/serial identity.

### ERP-03 Suppliers and purchasing — P1

Supplier directory **distinct from customer directory** for now; don't introduce generalized parties/accounting models prematurely. Fields legal/trading name, primary contact, email, phone, tax reference optional, payment terms, currency, lead time, address, status. Purchase orders: draft → approved → partially_received → received → cancelled, with supplier snapshot, line prices, currency, expected date, discount/tax, actor approvals. Goods receipts consume quantities against open PO lines, in transactions, posting to stock ledger. Allow partial receipts; enforce `received <= ordered` unless separately approved over-receipt policy (default disallow). Returns to supplier use reversing movements and audit trail. Supplier invoices and AP remain P2.

### ERP-04 Quotes → Sales orders → Work orders — P1

Sales order statuses `draft`, `confirmed`, `partially_fulfilled`, `fulfilled`, `cancelled`; include quote reference, billing/shipping/service site, customer snapshot, line snapshots, currency, tax and discounts, revision timestamps. Ensure no double-conversion from quote using unique source reference/idempotency. A sales order can link to **zero or many existing `work_orders`** through an explicit tenant-scoped join table; preserve work-order independent creation and lifecycle. Services may generate work orders only through an authorized explicit command and valid job type/site mapping. Stock items may reserve/fulfill from inventory; do not automatically deduct on creation. Fulfillment for services means actual signed-off delivery (define policy with the domain owner before automation).

### ERP-05 Invoicing and payments — P1 (basic, non-statutory pilot)

Tenant-facing invoice types `invoice`, `credit_note` (or separate tables if repo conventions warrant); `draft`, `issued`, `partially_paid`, `paid`, `void`/`credited` with strictly defined transitions. Invoice fields: tenant, invoice number, customer, billing snapshot, currency, issue/due dates, source sales order or work order, line snapshots, tax summary, exact totals, terms, issued_by, timestamps. Record payments as tenant-owned immutable receipts with payment date, amount, currency, method (`cash`, `bank_transfer`, `manual_other`), reference and allocations to invoices. Partial allocations allowed, but cannot allocate more than available receipt or invoice outstanding. A credit note is a separate issued document referencing the original. Issued invoices are immutable; do not delete or edit settled invoices. Track status from financial facts when possible.

**Regulatory guardrail:** no automatic claims of Egyptian e-invoice/e-receipt, VAT compliance, legal invoice numbering, or recognized accounting standards. Configure legal issuer identity, currency, tax handling, rounding, document types and mandatory fields with customer/jurisdiction before a legally operative deployment. P1 is an internal commercial ledger, not an official compliance certification. ERP invoice payment capture is **manual recording**, not a paid online gateway integration.

### ERP-06 Work-order material consumption and costing — P1

Create `erp_work_order_materials` / consumption links with item, source stock location/van, quantity, unit cost **at consumption time**, ledger posting reference, return/reversal, actor/timestamps. Engineer consumption requests may originate from mobile offline outbox **only as a separately designed, conflict-safe P1 follow-on**: client sends immutable action ID, server enforces assignment, stock lock, idempotency, and conflict reporting, cannot permit negative stock by offline double-consumption. First release permits online web/desktop consumption to keep scope controlled. Job cost = consumed materials + labor/time entries with explicit per-tenant labor rate rules + authorized expenses (later). A completed field job must not silently issue accounting journal postings until finance is implemented. Reports clearly label approximate costs if labor rates missing.

### ERP-07 Asset register/service history — P2 (integrate existing P24)

Tenant-scoped asset ID, item/product, serial, site, customer, install/warranty dates, status, service plan, work-order links, inspected form submissions, parts consumption and maintenance chronology. Assets belong to the tenant and may reference customer/site composite key. Support relocation with audited event, no untracked reassignment. Optional preventive-maintenance schedule later; do not build full CMMS alongside MVP.

### ERP-08 General ledger/accounting — P2 gated by pilot requirements

Scope only after chart of accounts, country/fiscal rules and accounting policy are defined. `erp_accounts`, `erp_fiscal_periods`, `erp_journals`, `erp_journal_lines`, `erp_posting_rules`, plus receivable/payable mapping if in use. Double-entry invariant: for each posted journal/currency, total debits exactly equal credits (based on configured precision); posted journal and lines immutable; corrections through reversal; period locking prevents posting backdated entries; account/company scope enforced. Use `numeric` amounts and decimal rules. Proposed transaction: lock document and fiscal period → validate posting rule and balances → insert journal header + lines atomically → mark source posted with unique source-doc/idempotency → append audit event. Use trial balance, GL detail, AR aging before issuing financial statements. Multi-currency requires explicit exchange-rate source/date/rounding and balancing per functional currency; avoid until clearly needed.

### ERP-09 HR, expense management and payroll — P2/deferred

Your existing `tenant_users`, shifts, and timesheets provide identities and operational time. Do not create duplicate login/employee accounts. An optional HR profile references `tenant_users`; staff expense claims may be future scope. **Do not ship payroll** before legal/tax/benefit rules are reviewed for a selected country.

### ERP-10 Manufacturing and complex supply chain — deferred

BOM, MRP, production routing, landed costs, supplier AP automation, multicompany consolidation and advanced BI only after demand justifies their ongoing maintenance burden.

---

## 6. Proposed database design — migration groups

**Names below are proposals, not existing schema.** Inspect last applied migration; allocate the next migration number _after 0023_, never reuse IDs. For each migration add `.up.sql`, `.down.sql`, Kysely schema declaration, repositories, indexes, tenant grants/RLS, invariants and integration tests. Include `set_updated_at()` only where existing repository uses it. Use actual existing UUID/user FK patterns; do not guess `tenant_users` primary key structure.

### 6.1 CRM MVP migrations

**Migration CRM-A (lead/activities):**

| Table                        | Important columns and constraints                                                                                                                                                                 | Indexes                                                                                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `crm_leads`                  | `id`, `tenant_id`, identity/contact info, status, source, assigned_to, `converted_customer_id`, `converted_at`, `created_by`, `version`, timestamps, archived_at; tenant-scoped FK for conversion | `(tenant_id,status,created_at)`, `(tenant_id,assigned_to,status)`, normalized email/phone candidate search |
| `crm_pipelines`              | tenant, name, `is_default`, active                                                                                                                                                                | unique tenant/default; tenant/name                                                                         |
| `crm_pipeline_stages`        | tenant, pipeline, stable key, label, order, probability, terminal type, archived                                                                                                                  | unique tenant/pipeline/key and order constraints                                                           |
| `crm_opportunities`          | tenant, lead/customer optional, title, stage, owner, amount/currency, forecast close, outcome, version                                                                                            | tenant/owner/stage, tenant/customer, close date                                                            |
| `crm_opportunity_events`     | tenant, opportunity, prior/new stage/status, actor, occurred_at                                                                                                                                   | tenant/opportunity/time                                                                                    |
| `crm_activities`             | tenant, type, title, due/completed, assigned_to, created_by, status, notes                                                                                                                        | tenant/assignee/due, tenant/status                                                                         |
| `crm_activity_leads`         | `(tenant_id,activity_id,lead_id)`                                                                                                                                                                 | composite tenant FKs                                                                                       |
| `crm_activity_customers`     | `(tenant_id,activity_id,customer_id)`                                                                                                                                                             | composite tenant FKs                                                                                       |
| `crm_activity_opportunities` | `(tenant_id,activity_id,opportunity_id)`                                                                                                                                                          | composite tenant FKs                                                                                       |

Check optional relationships: if an opportunity has customer null, require an existing lead or forbid detached records; explicitly enforce in application/schema. Ensure no cross-tenant lead→customer or activity joins. Consider local normalized search columns/indexes instead of external hosted search service.

### 6.2 ERP foundation migrations

| Group           | Proposed tables                                                                                                                     | Key invariant                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Items           | `erp_items`, `erp_categories`, `erp_units`                                                                                          | tenant SKU uniqueness, archived items still resolvable in history  |
| Locations       | `erp_stock_locations`                                                                                                               | tenant item/location references, warehouse/van ownership policy    |
| Stock           | `erp_stock_movements`, `erp_stock_transfers`, `erp_stock_transfer_lines`, `erp_stock_counts`, `erp_stock_count_lines`               | append-only ledger, atomic balanced transfers, idempotent postings |
| Suppliers       | `erp_suppliers`, `erp_supplier_contacts` (if needed)                                                                                | tenant identity/soft archive                                       |
| Purchasing      | `erp_purchase_orders`, `erp_purchase_order_lines`, `erp_goods_receipts`, `erp_goods_receipt_lines`                                  | partial receipt and stock movement reference uniqueness            |
| Selling         | `crm_quotes`, `crm_quote_lines`, `erp_sales_orders`, `erp_sales_order_lines`, `erp_sales_order_work_orders`                         | immutable issued document snapshot and source idempotency          |
| AR              | `erp_invoices`, `erp_invoice_lines`, `erp_payment_receipts`, `erp_payment_allocations`, `erp_credit_notes` (or typed invoice model) | payment allocation and issued-document immutability                |
| Field costing   | `erp_work_order_materials`, optional `erp_labor_rate_rules`                                                                         | trace consumption to existing work order and stock ledger          |
| Assets (later)  | `erp_assets`, `erp_asset_events`, `erp_asset_work_orders`                                                                           | tenant-scoped serial/location/service history                      |
| Finance (later) | `erp_accounts`, `erp_fiscal_periods`, `erp_journals`, `erp_journal_lines`, `erp_posting_rules`                                      | balanced, immutable postings and period locks                      |

### 6.3 SQL example — shape only, not paste blindly

```sql
-- EXAMPLE ONLY. Align tenant/users FK, RLS, grants and timestamps with live repo.
create table crm_leads (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete restrict,
  display_name text not null check (length(trim(display_name)) > 0),
  company_name text,
  email text,
  phone text,
  source text not null default 'manual',
  status text not null default 'new'
    check (status in ('new','contacted','qualified','unqualified','converted')),
  assigned_to uuid,
  converted_customer_id uuid,
  converted_at timestamptz,
  version integer not null default 1 check (version > 0),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (tenant_id,id),
  foreign key (tenant_id,converted_customer_id)
    references customers(tenant_id,id) on delete restrict,
  check ((status='converted') = (converted_customer_id is not null))
);
create index crm_leads_tenant_status_idx on crm_leads(tenant_id,status,created_at desc);
-- ALSO REQUIRED: user reference validation, RLS policy, role grants,
-- tenant transaction tests, updated_at trigger, audit integration.
```

**Important constraints to implement through triggers/repositories as needed:**

- On-hand calculation always reconcilable to immutable movement replay.
- Posted stock movements and issued commercial/financial documents are append-only/immutable (privileged maintenance exception only through audited operational procedures).
- Totals: `subtotal + tax + shipping/fees - discounts = total` under explicit decimal and rounding rules; do not trust request totals.
- All source conversions, goods receipts, payment allocations, and postings are protected by database uniqueness/idempotency and transactions.
- Use DB checks for nonnegative quantities where applicable and consistency of dates/status/tenant FKs.
- For flexible source relations, prefer explicit reference junction tables or carefully validated source types rather than weak strings with no FK integrity.
- Time-based filtering is timezone-safe (`timestamptz`) and documents have tenant-configured local display/issue dates.

### 6.4 Data migration and rollback

No destructive backfill. Existing customers require no CRM cloning. Add schema first, make UI opt-in behind module flags, backfill/derive only with explicit scripts, and keep old paths running. Down migrations must refuse destructive drop when irreversible customer data exists **or** document an approved backup/export recovery procedure; CI can test clean-schema rollbacks, but production rollback after real data creation is not automatically safe. Test migration fresh DB and upgraded snapshot. Include `EXPLAIN`/indexes for large tenant query patterns.

---

## 7. Detailed API contract specification

Proposed route names; inspect repository's existing naming, response wrapper and error codes before implementing. Unless noted, **every** route is tenant-authenticated and requires tenant feature gate + permission. Validate all route params, search filters, payloads and responses with Zod. All collection GETs support bounded pagination and safe sorting; no unbounded list endpoints.

### 7.1 CRM API — MVP

| Method | Route                                               | Action                                                                                     | Permission                                           |
| ------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| GET    | `/v1/crm/leads`                                     | list/search/filter                                                                         | `crm.lead.read`                                      |
| POST   | `/v1/crm/leads`                                     | create lead; idempotency optional or required per conventions                              | `crm.lead.manage`                                    |
| GET    | `/v1/crm/leads/{leadId}`                            | lead + sourced activity summary                                                            | `crm.lead.read`                                      |
| PATCH  | `/v1/crm/leads/{leadId}`                            | edit, status updates, archive policy                                                       | `crm.lead.manage`                                    |
| POST   | `/v1/crm/leads/{leadId}/convert`                    | transactional convert to existing/new customer, optional opportunity; required idempotency | `crm.lead.convert`                                   |
| GET    | `/v1/crm/pipelines`                                 | pipeline + stage definitions                                                               | `crm.opportunity.read`                               |
| GET    | `/v1/crm/opportunities`                             | filtered list/board                                                                        | `crm.opportunity.read`                               |
| POST   | `/v1/crm/opportunities`                             | create                                                                                     | `crm.opportunity.manage`                             |
| GET    | `/v1/crm/opportunities/{opportunityId}`             | detail/history                                                                             | `crm.opportunity.read`                               |
| PATCH  | `/v1/crm/opportunities/{opportunityId}`             | edit with version/ETag precondition                                                        | `crm.opportunity.manage`                             |
| POST   | `/v1/crm/opportunities/{opportunityId}/transitions` | change stage/won/lost with validations                                                     | `crm.opportunity.manage`                             |
| GET    | `/v1/crm/activities`                                | due/tasks/activity list                                                                    | `crm.activity.read`                                  |
| POST   | `/v1/crm/activities`                                | create linked activity                                                                     | `crm.activity.manage`                                |
| PATCH  | `/v1/crm/activities/{activityId}`                   | edit/complete                                                                              | `crm.activity.manage`                                |
| GET    | `/v1/crm/dashboard`                                 | tenant-safe aggregates                                                                     | `crm.report.read`                                    |
| GET    | `/v1/customers/{customerId}/crm`                    | CRM roll-up for existing customer                                                          | `customer.read` **and** relevant CRM read privileges |

Don't expose confidential opportunity prices to users who only have customer read permission. `customer.read` alone must not authorize full CRM detail. Prefer separate filtered subqueries/endpoint responses to accommodate permissions.

### 7.2 CRM/ERP API — P1

| Method     | Route family                                        | Behavior                                      |
| ---------- | --------------------------------------------------- | --------------------------------------------- |
| CRUD-style | `/v1/erp/items`, `/v1/erp/items/{itemId}`           | catalog, archive and lookup                   |
| CRUD-style | `/v1/erp/stock/locations`, `/v1/erp/stock/balances` | location control, computed balance and search |
| POST       | `/v1/erp/stock/adjustments`                         | approved movement with reason and idempotency |
| POST       | `/v1/erp/stock/transfers`                           | atomic double movement transfer               |
| GET        | `/v1/erp/stock/movements`                           | immutable history                             |
| CRUD-style | `/v1/erp/suppliers`, `/v1/erp/purchase-orders`      | supplier + purchasing docs                    |
| POST       | `/v1/erp/purchase-orders/{id}/approve`              | controlled transition                         |
| POST       | `/v1/erp/purchase-orders/{id}/receive`              | partial receipt → immutable stock movements   |
| CRUD-style | `/v1/crm/quotes`, `/v1/crm/quotes/{id}`             | drafts/revisions/detail                       |
| POST       | `/v1/crm/quotes/{id}/issue`                         | snapshot/finalize/number                      |
| POST       | `/v1/crm/quotes/{id}/accept`                        | acceptance event                              |
| POST       | `/v1/crm/quotes/{id}/convert`                       | sales-order conversion exactly once           |
| CRUD-style | `/v1/erp/sales-orders`, `/v1/erp/sales-orders/{id}` | sales orders and lifecycle                    |
| POST       | `/v1/erp/sales-orders/{id}/work-orders`             | explicit link/create work order               |
| GET/POST   | `/v1/erp/invoices`                                  | list and draft invoice                        |
| GET/PATCH  | `/v1/erp/invoices/{id}`                             | detail/edit draft only                        |
| POST       | `/v1/erp/invoices/{id}/issue`                       | numbered immutable invoice                    |
| POST       | `/v1/erp/invoices/{id}/credit`                      | separate corrective credit note               |
| GET/POST   | `/v1/erp/payments`                                  | receipt list and capture                      |
| POST       | `/v1/erp/payments/{id}/allocations`                 | allocate to invoices with balance checks      |
| POST       | `/v1/erp/work-orders/{workOrderId}/materials`       | parts consumption, stock transaction          |
| GET        | `/v1/erp/work-orders/{workOrderId}/costs`           | materials + permitted labor estimate          |

For API design, document concrete Zod request/response payloads, validation and error codes alongside each implementation; compile generated OpenAPI and client before merging. Avoid accepting arbitrary `tenant_id`, `created_by`, `issued_by`, `stock_balance` or final totals from request bodies.

### 7.3 API example — lead conversion

```json
{
  "customer": { "mode": "existing", "customerId": "UUID" },
  "createOpportunity": true,
  "opportunity": { "title": "Annual maintenance contract", "currencyCode": "EGP" },
  "expectedVersion": 2
}
```

Alternative: `customer: { "mode": "new", "name": "...", "contact": { ... } }`. Validate tagged union. A successful response returns `leadId`, `customerId`, optional `contactId`, optional `opportunityId`, status and audit identifier. Same idempotency key with same payload returns original result; same key different payload yields conflict. Cross-tenant customer input must return access-safe not-found/denied response. Avoid leaking a customer’s existence from another tenant.

### 7.4 Standard error types

Use existing HTTP error format and request IDs. New stable logical codes: `CRM_LEAD_ALREADY_CONVERTED`, `CRM_INVALID_TRANSITION`, `CRM_VERSION_CONFLICT`, `ERP_INSUFFICIENT_STOCK`, `ERP_STOCK_CONFLICT`, `ERP_DOCUMENT_IMMUTABLE`, `ERP_INVALID_RECEIPT_QUANTITY`, `ERP_PAYMENT_OVERALLOCATED`, `ERP_CURRENCY_MISMATCH`, `ERP_PERIOD_CLOSED`, `ERP_POSTING_UNBALANCED`, `FEATURE_DISABLED`, `PERMISSION_DENIED`. Translate client messages via existing i18n map; never show raw DB constraint errors to users.

---

## 8. Authorization matrix

Do not assume `owner` gets unrestricted power or that `admin` must be able to post accounting entries. Define new fine-grained permission keys in `packages/core/src/permissions.ts`; update **all five roles explicitly** and the permission completeness tests. Proposed **default** grants (adjust after reviewing current role semantics):

| Permission family                   |                      Owner |               Admin |          Dispatcher |          Engineer |             Viewer |
| ----------------------------------- | -------------------------: | ------------------: | ------------------: | ----------------: | -----------------: |
| CRM read                            |                          Y |                   Y |                   Y |                 N | optional read-only |
| CRM leads/activities edit           |                          Y |                   Y |                   Y |                 N |                  N |
| CRM opportunity edit / lead convert |                          Y |                   Y |        configurable |                 N |                  N |
| CRM quote issue / approve           |                          Y |        configurable |                   N |                 N |                  N |
| ERP catalog read                    |                          Y |                   Y |                   Y |           limited |           optional |
| ERP catalog edit                    |                          Y |                   Y |                   N |                 N |                  N |
| ERP inventory read                  |                          Y |                   Y |                   Y |     assigned-only |           optional |
| ERP movement/adjustment             |                          Y |                   Y | limited consumption | assigned-job only |                  N |
| ERP purchasing approve              |                          Y |        configurable |                   N |                 N |                  N |
| ERP invoice read                    |                          Y |        configurable |                   N |                 N |                  N |
| ERP invoice issue / payment manage  |                          Y | explicit grant only |                   N |                 N |                  N |
| ERP GL post/period close (P2)       | explicit role/grant policy |        N by default |                   N |                 N |                  N |

`viewer` should not automatically gain sensitive prices merely because it reads work orders; financial access is distinct. New permissions must use the existing `Seat`/impersonation protections; only current three staff-only permissions remain staff-only unless product design explicitly requires a new restriction. API gates are enforced server-side independently of UI.

**Longer term:** custom roles or per-member overrides are a separate RBAC migration and shouldn't block MVP. If current role schema doesn't allow granular financial grants, use conservative owner-only permission defaults for P1 until a tested capability model exists; don't grant billing/accounting by fiat.

---

## 9. UX, page map, desktop, mobile and i18n

### 9.1 Route map (proposed)

```text
/apps/web/(app)
  /crm
    /dashboard
    /leads
    /leads/new
    /leads/[id]
    /opportunities
    /opportunities/[id]
    /activities
  /customers/[id]          # EXISTING: integrate CRM tabs without replacing
  /sales
    /catalog
    /quotes
    /quotes/[id]
    /orders
    /orders/[id]
  /inventory
    /items
    /locations
    /movements
    /transfers
    /stock-counts
  /purchasing
    /suppliers
    /orders
    /orders/[id]
  /finance
    /invoices
    /invoices/[id]
    /payments
  /work-orders/[id]        # EXISTING: add materials and costing tabs
```

Actual Next.js route group and desktop route names must match their current conventions; `apps/web/src/app/(app)` is an existing route group. No platform staff admin area should be repurposed for tenant CRM/ERP.

### 9.2 Shared screen requirements

List screens: server-side pagination/filter/sort, search debounce, empty/permission/error/loading states, accessible keyboard operations, export CSV where already supported, saved filters later. Detail screens: breadcrumb and visible back button, source record links, change timeline, audit attribution, explicit actions and confirmation for destructive/financial changes. Forms: Zod validated, field-level errors, native focus behavior, duplicate submit protection, safe unsaved-changes navigation. Monetary fields use locale-aware display but canonical decimal parsing/storage, ISO currency explicitly visible. Internationalized date display must not alter stored UTC semantics. Responsive UI for tablet/desktop; dark mode and brand token compatibility; no hard-coded `left`/`right` CSS that breaks RTL.

Desktop: share React view packages with web while using desktop's React Router adapters, typed API client and secure session storage. Context menus must show only relevant actions to permitted users (existing pattern); never offer invoice posting in a generic row context menu without an explicit permission check and confirmation. Keep staff/company app flavors and branded builds unchanged.

Mobile: initially **no CRM/finance screens**. When adding inventory to engineers, scope reads to assigned jobs/van and use the existing offline repository/outbox and sync conflict model; no direct ad-hoc network writes bypassing sync. Deploy inventory sync in a distinct, carefully audited phase; keep existing forms and sync healthy.

### 9.3 Translation key proposal

```text
nav.group.crm
nav.group.sales
nav.group.inventory
nav.group.purchasing
nav.group.finance
crm.lead.status.*
crm.opportunity.stage.*
crm.activity.type.*
erp.item.kind.*
erp.stock.movement.*
erp.document.status.*
erp.invoice.paymentStatus.*
errors.CRM_*
errors.ERP_*
```

Use the **actual catalog key pattern** in `packages/i18n`; proposal keys may be adjusted. English and Arabic parity test is mandatory for every PR. Icons/arrows and right-click menus must mirror in RTL; numerals and currencies should use existing Intl utilities.

---

## 10. Free software and infrastructure policy — hard requirement

### 10.1 Mandatory rule

**No feature may require a paid library license, premium feature, SaaS subscription, or closed-service API to function in development or core self-hosted production.** Development must run without external accounts using current local/recording service adapters. Production can optionally use metered integrations, but equivalent free/self-hosted core workflows must remain functional. Distinguish **zero license fees** from hosting, domains, backups, bandwidth, email delivery, app-store memberships, SMS, payment processor fees, and transaction charges: the latter are real-world costs, not free software licenses.

### 10.2 Approved-first candidates (check exact package release before install)

| Need               | Use/consider                                                                       | License / notes                                                                                            |
| ------------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Runtime / API / UI | Existing Fastify, Next.js, React, Tauri, Expo, Zod, TanStack Query                 | Reuse exact existing versions                                                                              |
| Database           | Existing PostgreSQL + Kysely + `pg`                                                | Reuse; no paid ORM                                                                                         |
| Queues             | Existing PostgreSQL worker                                                         | **Do not install hosted queues / Redis just for CRM**                                                      |
| Forms              | Existing form engine + Zod; use `react-hook-form` only if its fit/license verified | Prefer reuse; no paid form builder                                                                         |
| Tables             | `@tanstack/react-table`                                                            | MIT, free for commercial use                                                                               |
| Charts             | `recharts`                                                                         | MIT, optional; could use lightweight existing SVG                                                          |
| Decimal            | `decimal.js`                                                                       | MIT; use for decimal computations                                                                          |
| PDF                | `@react-pdf/renderer`                                                              | Check exact MIT license and fonts; alternative server HTML/PDF only if dependency fits                     |
| CSV                | Existing import/export code                                                        | Prefer built-in                                                                                            |
| XLSX               | `xlsx` / SheetJS **Community Edition** only                                        | Apache 2.0; required attribution; do not import SheetJS Pro                                                |
| Heavy grid         | `ag-grid-community` only if genuinely needed                                       | MIT; **never `ag-grid-enterprise`**                                                                        |
| Dates              | Existing Intl, optional `date-fns`                                                 | Verify exact package; avoid needless dependencies                                                          |
| Storage            | Existing `local` mode; optional R2 via existing interface                          | No paid dependency; real remote usage may be metered                                                       |
| Maps               | Existing Leaflet/OpenStreetMap                                                     | Public OSM tile servers not unlimited/free for bulk production use; follow their policy or self-host tiles |
| Auth               | Existing Supabase Auth (GoTrue) HTTP integration                                   | Self-hosted option must be production-tested; no parallel auth service                                     |
| Monitoring         | Existing logging; optional existing Sentry SDKs                                    | Hosted tier/quotas may cost; no mandatory SaaS to run                                                      |
| Emails             | Existing local/recording adapter; optional SMTP/self-hosted                        | Real email deliverability/infra can cost                                                                   |
| Billing            | Existing recording Stripe adapter for SaaS plans                                   | Payment processors charge transaction fees, not essential for CRM/ERP MVP                                  |

**Avoid** ERPNext/Odoo as a runtime dependency; AG Grid Enterprise, SheetJS Pro, proprietary reporting designers, paid analytics, SaaS workflow engines, commercial UI kits, hosted message queues, usage-billed AI APIs and required paid connectors. For licenses with copyleft or network/source-availability obligations, flag explicitly for human legal review rather than silently adding them.

### 10.3 CI licensing controls

- Generate/maintain a dependency attribution manifest for shipped web/desktop/mobile/server packages.
- Add a license-policy check with a free tool or small script (only if license-compatible and maintained). Fail CI on unknown/new prohibited license; allow manual reviewed exceptions documented with source and rationale.
- Check transitive license files and bundled fonts/assets, not only direct npm packages.
- Never include enterprise submodule imports in bundles, even when local trial is allowed.
- Record support/licensing URLs for major dependencies. Re-evaluate on upgrades.

### 10.4 External-service blockers to investigate

The report says development/tests run with recording/local adapters, **but production startup currently requires real services**. Include a targeted audit: for auth, mail, object storage, geocoding, push and error collection, identify production validation that forces vendor setup. Only change such requirements via a tested optional/self-hosted adapter with safe defaults; don't weaken security, email verification or recovery simply to pass startup. Operational self-hosted GoTrue requires a real, configured SMTP channel for emails if using magic links. Keep SaaS subscription billing separate from tenant invoices.

### 10.5 License provenance references

- TanStack Table MIT: https://github.com/TanStack/table/blob/main/LICENSE
- AG Grid Community MIT: https://www.ag-grid.com/eula/community/ ; Enterprise requires commercial license.
- SheetJS Community Apache-2.0 and attribution: https://docs.sheetjs.com/docs/miscellany/license/
- Verify Recharts, `decimal.js`, and PDF renderer **at implementation time** from the relevant pinned upstream license; a suggestion in this document is not a blanket approval.

---

## 11. Quality/security/performance engineering

### 11.1 Required tests by vertical slice

1. **Schema/migration:** fresh migration, upgrade migration, down/up in empty test DB, tenant FK constraints, RLS read/write denial, grants and user role separation.
2. **Business invariant:** lead conversion twice (same key and concurrent keys), cannot link cross-tenant record, opportunity status/permission transition, quote issue locks snapshot, duplicate conversion denied, stock replay, transfer balance, zero/negative stock, concurrent inventory issues, goods receipt idempotency, invoice payment over-allocation, credit note controls, GL balance/reversal/period closure (when implemented).
3. **API:** positive and negative routes, malformed payload, plan/feature disabled, authenticated but insufficient permission, cross-tenant records, expired or suspended sessions, request-id stable errors, OpenAPI schema checks.
4. **UI:** English and Arabic screen rendering, RTL layout, keyboard/tab order, accessible labels, unavailable actions hidden and API blocked, 404/permission handling, empty lists, back links, navigation from customer/work order, decimal and local date handling.
5. **Regression:** existing jobs, forms, staff impersonation, offline mobile sync, SaaS billing and branded desktop/mobile builds unaffected.
6. **Performance:** paginated lead search, opportunity board, customer 360 segmented queries, stock balances at 100k+ ledger rows, N+1 prevention, partial indexes on tenant/date/status, bounded reporting queries.

### 11.2 Baseline performance expectations (targets, not already measured)

- CRM list pagination/filter under 500ms p95 on representative seeded development data, excluding network latency; define and measure dataset.
- 100k inventory movements per representative tenant, balance query under ~300ms at warm-cache database benchmark **if feasible and measured** (existing P22 goal).
- No unbounded `GET` collection; page max 100 or existing repo standard.
- Worker jobs must be retry-safe and idempotent; no email/doc issue/stock move double effects on retry.

### 11.3 Security checklist

- [ ] Tenant RLS enabled for every tenant-owned table and tested against ordinary runtime credentials.
- [ ] Tenant-aware FKs across leads, opportunities, quote lines, stock and invoice relationships.
- [ ] Authorization on every API read/write independent of navigation visibility.
- [ ] Financial visibility separate from generic customer/site visibility.
- [ ] All audit events associate actual user + acting impersonating staff where relevant.
- [ ] No financial document mutation after issuing/posting; reversible audit-preserving corrections.
- [ ] Rate-limit, validate, sanitize all inputs, including CSV imports and notes; ensure spreadsheet formula-injection protection in exports.
- [ ] Signed media/download links and tenant file ownership enforced.
- [ ] Idempotency prevents duplicates across retries/concurrency.
- [ ] Encrypt/manage secrets using existing conventions; no secrets in source/logs.
- [ ] Currency/tax quantities exact and consistent; never trust client-submitted totals.
- [ ] Test role and feature-flag changes cannot bypass protection on old generated clients.

---

## 12. Delivery phases and exact PR tasks

### Phase F0 — Repository audit & architecture decision record (NO FEATURE CODE)

**Status:** `DONE` — see the [phase tracker](./README.md#phase-tracker).

- [ ] Inspect and document repository state, git status and target branch.
- [ ] Read all baseline paths from §1.2, current inventory plans P22/P23/P24, report and CI workflows.
- [ ] Produce `docs/crm-erp/00-repository-assessment.md` and `01-architecture.md` with actual data flow, proposed package ownership, changed schemas and explicit contradictions.
- [ ] Produce `docs/crm-erp/02-feature-matrix.md` with existing/reuse/new/deferred statuses and an MVP scope lock.
- [ ] Produce `docs/crm-erp/dependencies.md` with license audit, listing NO unauthorized paid packages.
- [ ] Confirm whether product will remain manually onboarded by Integr8 for pilot (default YES), and whether tenant admins can build their own CRM configurations (default only basic pipelines; no unreviewed staff-only permission changes).
- **Done when:** technical design reviewed against current repo, migration sequencing identified, no regressions introduced.

### Phase F1 — CRM shared foundation

**Status:** `DONE` — pipeline tables moved to C3, where they are first used (see README.md) — see the [phase tracker](./README.md#phase-tracker).

- [ ] Add `crm` tenant module flag / plan gate using existing flags and entitlements.
- [ ] Add CRM permissions explicitly to all five roles and tests; default conservatively.
- [ ] Extend shared navigation & web/desktop route map and icons, respecting module enablement (ensure nav helper API compatibility).
- [ ] Add English/Arabic keys and parity tests.
- [ ] First CRM migrations (leads + basic pipeline) with paired down files, RLS/grants and Kysely schema.
- [ ] Add `packages/crm` pure domain validation only if it demonstrably improves reuse.
- **Done when:** admin can enter an empty gated CRM section; all unauthorized/API access fails safely; original navigation and apps still work.

### Phase C1 — Lead vertical slice

**Status:** `NOT STARTED` — see the [phase tracker](./README.md#phase-tracker).

- [ ] Repository with tenant-safe list/create/get/update/archive; status transition validation.
- [ ] Fastify typed CRUD routes; OpenAPI and generated client.
- [ ] Shared UI lead table, filters, create/edit, detail; web + desktop navigation; bilingual RTL.
- [ ] Tests: cross-tenant, permission, input errors, pagination, audit, i18n.
- **Done when:** tenant admin creates/assigns/qualifies leads end to end in web/desktop.

### Phase C2 — Lead conversion + customers

**Status:** `NOT STARTED` — see the [phase tracker](./README.md#phase-tracker).

- [ ] Conversion service transaction, existing customer match/new customer path, optional contact creation, idempotency, optimistic version guard.
- [ ] Conversion UI wizard with preview and explicit choice.
- [ ] Link resulting `customers` record to the lead; customer screen shows CRM summary without breaking existing operations.
- [ ] Tests: duplicate conversion race, replays, cross-tenant IDs, actor audit, customer existing data unaffected.
- **Done when:** lead converts once into canonical existing/new customer.

### Phase C3 — Opportunities and activities

**Status:** `NOT STARTED` — see the [phase tracker](./README.md#phase-tracker).

- [ ] Pipeline/stages migration, opportunity CRUD/transitions/events, activity CRUD/due lists and join references.
- [ ] Pipeline board/list, detail pages, activity timeline, Customer 360 tabs, small dashboard.
- [ ] Reports use tenant-safe queries and clarify forecast ≠ revenue.
- [ ] Tests: stage transitions, tenant relationship invariants, sorting/pagination, RTL, permission.
- **MVP EXIT:** trial company completes Lead → Opportunity → Customer → follow-up, with no paid services required.

### Phase E1 — Catalog + stock ledger (align P22)

**Status:** `NOT STARTED` — see the [phase tracker](./README.md#phase-tracker).

- [ ] Update `plan/v1.1-inventory/P22...` with accepted ERP model and dependencies; preserve ledger invariant.
- [ ] Item categories, unit catalog, items/products/services, stock locations and ledger migrations.
- [ ] Stock receipt/issue/transfer/adjustment service with transaction locks, no negative stock, idempotency.
- [ ] Balances, counts, history, warehouse UI and optional item images using existing storage.
- [ ] Replay reconciliation utility and concurrent issue tests.
- **Done when:** correct per-location balances survive retries and 100k+ movements test.

### Phase E2 — Purchasing and van/field integration (align P23)

**Status:** `NOT STARTED` — see the [phase tracker](./README.md#phase-tracker).

- [ ] Supplier directory, PO lines and approvals, goods receipt and partial receipt.
- [ ] Receipts post inventory movements exactly once; returns/adjustments audited.
- [ ] Work-order materials model; online consumption in web/desktop first.
- [ ] Only after explicit approval: add engineer/mobile outbox consumption with conflict-safe sync.
- **Done when:** parts are received, transferred to a van, and consumed on a work order without stock drift.

### Phase S1 — Quotes and sales orders

**Status:** `NOT STARTED` — see the [phase tracker](./README.md#phase-tracker).

- [ ] Exact decimals/currency policy documented and tested; quote draft/issue/revision/accept/reject.
- [ ] Line snapshots, server totals and tenant document counters; basic PDF printable format with local fonts.
- [ ] Atomic conversion to sales order; link sales orders to existing/new work orders explicitly.
- [ ] UI flow and translated lifecycle errors.
- **Done when:** opportunity → quote → approved order → linked work order has clean audit trail and no duplicate conversion.

### Phase B1 — Tenant invoices, payments, job profitability

**Status:** `NOT STARTED` — see the [phase tracker](./README.md#phase-tracker).

- [ ] Distinguish from SaaS subscription billing at code/model/UI level.
- [ ] Invoice issue/immutable lines, partial payment receipt allocations, credit notes, PDF.
- [ ] Job costing for consumed parts and optionally configured labor rates; reports label missing costs.
- [ ] Document regulatory/non-statutory status; no e-invoicing claim.
- **Done when:** invoice balance accurately derives from payments/credits and can be corrected without editing historical document.

### Phase E3 — Assets and service history (align P24)

**Status:** `NOT STARTED` — see the [phase tracker](./README.md#phase-tracker).

- [ ] Asset master data, customer/site links, serial identity, install/warranty and service event timeline.
- [ ] Work order/forms/parts history joins and movement audit.
- **Done when:** field tech and office can trace service history of a serial-numbered asset within tenant and proper permissions.

### Phase A1 — General ledger (ONLY AFTER AUTHORIZATION)

**Status:** `NOT AUTHORIZED` — see the [phase tracker](./README.md#phase-tracker).

- [ ] Agree fiscal year, chart structure, countries, tax and posting rules with user.
- [ ] Design and test double-entry journals, posting source references, period locks, reversals.
- [ ] Trial balance, account activity, AR reconciliation and manual journals with segregation of duties.
- **Done when:** formal balancing/reversal tests and policy review approve use; avoid prematurely calling accounting legally compliant.

### Phase L — Pilot release

**Status:** `NOT STARTED` — see the [phase tracker](./README.md#phase-tracker).

- [ ] Sample tenant configuration for a field-service company with demo dataset (no sensitive production data).
- [ ] Migration upgrade rehearsal, backup/restore drills, load/security/RTL tests.
- [ ] Validate onboarding flow, feedback instrumentation using existing app logs (not paid analytics), tenant export/deletion compatibility and manual support procedures.
- [ ] Pilot with real customers before expanding feature surface.

---

## 13. Manual QA journeys (must pass before marking feature ready)

1. Tenant A owner creates a lead, assigns it to dispatcher, logs a follow-up and converts it to an existing customer; no duplicate created; customer work orders still visible.
2. Tenant A owner converts another lead to a _new_ customer/contact; replay same idempotency key returns same customer; new key cannot create a second customer.
3. Tenant B user tries to retrieve Tenant A lead/opportunity/customer via known ID and via autocomplete: no data exposed.
4. Viewer can open only permitted screens; cannot access mutation endpoints via direct REST calls.
5. Switch app to Arabic: side navigation, lead status, opportunity board, forms, breadcrumbs and detail views all translate and mirror correctly.
6. On desktop, switching tenant/staff impersonation cannot show cached prior tenant CRM/ERP data; current audit flow remains visible.
7. Create 10 units of an item, transfer 3 warehouse→van, consume 2 on a job, return 1; reconcile balances from ledger; double-send all actions with same idempotency keys and see no double effects.
8. Concurrent consumption from the same 1-unit balance: one succeeds, one fails without negative stock.
9. Receive 4 of 10 PO units, then 6; order closes correctly and no double receipt on worker/API retry.
10. Create quote and issue it; changing item catalog price afterward does not alter issued quote; convert once to sales order.
11. Create customer invoice, record partial receipt, over-allocation attempt fails, credit adjustment leaves correct balance; issued invoice history untouched.
12. Existing engineer offline forms, required work-order submissions and synchronization still complete exactly as before.
13. Disable CRM or ERP feature flag: hidden navigation AND API access blocked; existing customer/job operations still work.
14. Run database migration/up/down against clean test fixture, then upgrade realistic pre-CRM fixture with current reports unchanged.

---

## 14. Nonfunctional documentation deliverables

Maintain these paths alongside implementation:

```text
docs/crm-erp/
  00-repository-assessment.md
  01-architecture.md
  02-feature-matrix.md
  03-data-model.md
  04-api-contracts.md
  05-permissions-and-security.md
  06-navigation-i18n-ux.md
  07-finance-and-inventory-invariants.md
  08-operations-selfhosting.md
  09-testing-and-qa.md
  dependencies.md
  decisions/ADR-0001-modular-monolith.md
  decisions/ADR-0002-canonical-customer.md
  decisions/ADR-0003-inventory-ledger.md
  decisions/ADR-0004-commercial-vs-platform-billing.md
```

Each file should reference **actual code**, not invent implementation details. Track phase status with planned / implementing / tested / done, migration numbers, PR link and owner, and note incomplete features honestly.

---

## 15. Ready-to-paste Claude Code execution prompt

> Paste this prompt to Claude Code **together with this Markdown file**. It should begin only with F0, not implement the entire roadmap automatically.

```text
You are the senior software architect and implementation engineer for my existing
commercial multi-tenant SaaS, Integr8 Plus.

Repository: https://github.com/MinaLouisLeon/integr8-plus
Specification: INTEGR8_CRM_ERP_IMPLEMENTATION_PLAN.md
Source report: project-report(1).md (if present in workspace)

Read the specification in full, then study actual current repository source.
Do not assume the report is newer than the checked-out source.

Core requirements:
- Preserve all existing field operations, customers/sites/jobs, form engine,
  offline sync, staff/company app isolation, RLS, API contracts and translations.
- Native modular monolith using existing Fastify + PostgreSQL/Kysely +
  Next.js + Tauri + Expo + pnpm/Turborepo conventions.
- Only free and commercial-use-compatible open-source libraries; no paid
  subscriptions/features are required for the core application.
- Reuse the canonical customers table; do not create duplicate CRM accounts.
- Explicit tenant-safe SQL migrations and composite FKs, RLS, RBAC, audit,
  OpenAPI schema generation, client regeneration, EN/AR parity and RTL.
- Do not confuse Integr8's SaaS subscription billing with tenant invoices.
- Never use JS floats for financial math or maintain mutable stock as source
  of truth; use immutable transactions/ledgers and idempotency.
- No blanket codebase rewrite or microservices.

YOUR FIRST TASK IS ONLY PHASE F0:
1) Audit the repo and compare it to the specification.
2) Write the specified docs/crm-erp architecture/feature/dependency files.
3) Produce a prioritized PR-by-PR technical execution plan with precise
   repository paths, migrations, route schemas and tests, noting any differences.
4) Identify blockers and assumptions, flag licenses requiring approval.
5) Do NOT install packages or implement F1/C1 or any ERP feature in this step.
6) Show me the outcome and ask for approval before implementing the first PR.

For subsequent explicitly approved phase implementation:
- Create a safe feature branch from main, preserve uncommitted work.
- Implement one end-to-end slice with tests and translations.
- Run and report typecheck/lint/unit/integration/OpenAPI/build outcomes.
- Give a file-by-file summary and manual QA instructions.
- Stop at PR boundary and wait for my next instruction.
```

---

## 16. Open decisions and safe defaults

| Question                        | Default until clarified                                                      | When it becomes blocking        |
| ------------------------------- | ---------------------------------------------------------------------------- | ------------------------------- |
| First ideal customer            | Field-service SMEs                                                           | Product positioning/pilot       |
| User self-onboarding            | Keep current manual Integr8-led onboarding                                   | Public launch                   |
| CRM contact/account master      | Existing `customers`/`customer_contacts`                                     | Immediately; never duplicate    |
| CRM pipelines                   | One configurable pipeline/tenant, limited stages                             | C3                              |
| First currency                  | Allow ISO `EGP` default per tenant, store explicit currency on each document | Before quote/invoice            |
| Tax legislation                 | Configurable amounts but **no legal compliance claim**                       | Before invoice pilot            |
| Inventory negative stock        | Disallowed                                                                   | E1                              |
| Stock valuation                 | Document costing assumption; do not claim IFRS/GAAP compliance               | Job costing and accounting      |
| Customer invoice payments       | Manually recorded cash/bank receipts                                         | B1                              |
| Full custom RBAC                | Defer; owner-only high-risk finance by default                               | Additional admin finance users  |
| Offline stock posting           | Defer until sync/conflict/idempotency designed                               | E2 mobile                       |
| Native per-company branded apps | Reuse existing build system                                                  | All phases                      |
| Finance / payroll go-live       | Not authorized by this plan                                                  | A1 or country-specific features |

---

## 17. Source provenance and limits

**User-provided source:** `project-report(1).md`, Integr8 Plus project report, dated 2026-10-11, describing the repository's architecture, modules, endpoints, migrations, roadmap and dependencies.  
**Current code inspected for plan drafting:** `package.json`, `packages/core/src/permissions.ts`, `packages/core/src/navigation.ts`, `packages/db/migrations/0010_customers_sites_work_orders.up.sql`, `plan/v1.1-inventory/P22-item-catalogue-and-stock-ledger.md`, root/tree listing on GitHub `main` as accessed on 2026-10-11.  
**External license references:** official TanStack Table, AG Grid Community, and SheetJS Community license pages linked in §10.5.  
**Proposals not claimed to exist:** every `crm_*`/`erp_*` table, new CRM/ERP packages, routes, pages, controls, and milestones in this document.  
**Not performed during document creation:** repository test run, full security/code audit, production license compliance audit, schema deployment, migrations, or feature implementation. Claude Code must verify the current checkout and make changes incrementally.

**Final constraint:** Optimize for one developer, one modular monolith, a believable first paid customer, and **zero mandatory software license or subscription charges**. Make every new feature independently testable, opt-in per tenant, and safe to deploy without breaking existing field operations.
