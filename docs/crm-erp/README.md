# CRM and ERP — documentation and phase tracker

The CRM and ERP modules are built inside the existing apps, in phases, from
**[PLAN.md](./PLAN.md)** (the master plan, kept as received). This page is the
single place that says what has been built and what has not. Update it in the
same commit as the work it describes.

Status values: `DONE` (built, tested, pushed) · `IN PROGRESS` · `NOT STARTED` ·
`NOT AUTHORIZED` (needs an explicit go-ahead before any work) · `DEFERRED`.

## Phase tracker

Branch: `feat/crm-erp-foundation`, from `main` at `8db1c50` (version 0.1.4).
Agreed scope for this branch: **F0 → F1 → C1 → C2 → C3 (the CRM MVP), then stop
for review.** Nothing after C3 starts without a new instruction.

**State: the CRM MVP is complete (F0–C3 `DONE`, merged in PR #73).**

Second round — branch `feat/erp-inventory-purchasing`, from `main` at `479d3d7`.
Agreed scope: **E1 → E2, then stop for review.** S1 onwards wait for a new
instruction.

| Phase | What it delivers                                                                       | Status           | Migrations | Commit                                                                                             |
| ----- | -------------------------------------------------------------------------------------- | ---------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| F0    | Repository assessment, architecture, feature matrix, dependency audit, ADRs            | `DONE`           | —          | first commit on the branch                                                                         |
| F1    | CRM switch (feature flag), CRM permissions, navigation, EN/AR keys, first CRM tables   | `DONE`           | 0024       | second commit on the branch                                                                        |
| C1    | Leads: list, filters, create, edit, detail, status changes, archive (web + desktop)    | `DONE`           | —          | third commit on the branch                                                                         |
| C2    | Lead conversion to an existing or new customer, once only; CRM summary on the customer | `DONE`           | —          | fourth commit on the branch                                                                        |
| C3    | Opportunities, pipeline and stages, activities and follow-ups, Customer 360, dashboard | `DONE`           | 0025       | fifth commit on the branch                                                                         |
| E1    | Catalogue and immutable stock ledger (aligns with `plan/v1.1-inventory/P22`)           | `DONE`           | 0026       | second commit on the branch                                                                        |
| E2    | Suppliers, purchasing, goods receipts, van stock, work-order materials (aligns P23)    | `IN PROGRESS`    | 0027       | third commit: suppliers, purchase orders, receipts, returns (E2a); work-order materials next (E2b) |
| S1    | Quotes and sales orders, linked to work orders                                         | `NOT STARTED`    | —          | —                                                                                                  |
| B1    | Company invoices, payments, credit notes, job costing (not Integr8's own billing)      | `NOT STARTED`    | —          | —                                                                                                  |
| E3    | Assets and service history (aligns P24)                                                | `NOT STARTED`    | —          | —                                                                                                  |
| A1    | General ledger                                                                         | `NOT AUTHORIZED` | —          | —                                                                                                  |
| L     | Pilot release                                                                          | `NOT STARTED`    | —          | —                                                                                                  |

### Specification coverage

Every numbered item in PLAN.md §4–§5, so none is forgotten.

| Spec item                                  | Phase(s)   | Status           | Notes                                                                |
| ------------------------------------------ | ---------- | ---------------- | -------------------------------------------------------------------- |
| CRM-01 Leads                               | F1, C1, C2 | `DONE`           | Leads (C1) and conversion (C2)                                       |
| CRM-02 Opportunities                       | C3         | `DONE`           | Default pipeline; no pipeline editing screen yet                     |
| CRM-03 Activities and tasks                | C3         | `DONE`           | In-app due list only; email reminders after email is set up          |
| CRM-04 Customer 360                        | C2, C3     | `DONE` (MVP)     | Quotes, orders, invoices and assets tabs arrive with S1/B1/E3        |
| CRM-05 Quotes and pipeline analytics       | S1         | `NOT STARTED`    | C3 dashboard covers counts, totals and weighted forecast             |
| CRM-06 Campaigns and automations           | —          | `DEFERRED`       | P2; no marketing platform or bulk email                              |
| ERP-01 Products and services catalogue     | E1         | `DONE`           | Images and datasheets on items are a follow-up                       |
| ERP-02 Locations and inventory ledger      | E1         | `DONE`           | Serial and batch tracking deferred (P22 lists it; not in scope)      |
| ERP-03 Suppliers and purchasing            | E2         | `DONE`           | Supplier price lists and sending a PO to the supplier are follow-ups |
| ERP-04 Quotes → sales orders → work orders | S1         | `NOT STARTED`    |                                                                      |
| ERP-05 Invoicing and payments              | B1         | `NOT STARTED`    | Internal ledger only; no e-invoicing or tax compliance claim         |
| ERP-06 Work-order materials and costing    | E2, B1     | `NOT STARTED`    | Mobile consumption only after a separate sync design                 |
| ERP-07 Asset register                      | E3         | `NOT STARTED`    | Update P24 when E3 starts                                            |
| ERP-08 General ledger                      | A1         | `NOT AUTHORIZED` |                                                                      |
| ERP-09 HR, expenses, payroll               | —          | `DEFERRED`       | No payroll without a country's legal review                          |
| ERP-10 Manufacturing                       | —          | `DEFERRED`       |                                                                      |

### Follow-ups that must not be lost

Items the plan mentions that no phase above fully covers yet. Each gets a phase
or a decision before the pilot (phase L).

- [ ] Email reminders for overdue CRM follow-ups (worker job), once a real email channel is configured.
- [ ] Drag-and-drop on the pipeline board (C3 ships an accessible stage selector first).
- [ ] CSV export of leads and opportunities, with spreadsheet formula-injection protection.
- [ ] Custom roles or per-member permission overrides (deferred; see PLAN.md §8).
- [ ] Licence-policy check in CI (PLAN.md §10.3); no new dependencies so far.
- [ ] Self-hosting audit of production-required services (PLAN.md §10.4).
- [x] API test of the module gate end to end (`feature_disabled`): landed with C1 (`crm-leads.integration.test.ts`).
- [x] Optional opportunity created by lead conversion (PLAN.md §7.3): landed with C3.
- [ ] Show API refusals in the reader's language: shared screens show the server's English message for 4xx errors (existing behaviour across operations screens); map CRM codes to `errors.*` keys.
- [ ] A screen for editing pipelines and stages (add, rename, reorder, archive); C3 ships the default pipeline only.
- [ ] Customer 360 timeline mixing CRM activities with work-order and submission events as read-only entries (PLAN.md CRM-03); C3 shows them side by side.
- [x] `plan/v1.1-inventory/P22` and `P23` point at the accepted model (E1/E2); P24 when E3 starts.
- [ ] Site stock locations from the screens (the API takes `kind: 'site'` with a `siteId`; the list screen offers warehouses and vans only).
- [ ] Item images and attached datasheets (P22), using the existing media storage.
- [ ] Serial number and batch tracking (P22) — a scope decision before any schema.
- [ ] Supplier price lists and a "reorder" draft built from reorder levels (E2 ships one preferred supplier and part number per item).
- [ ] Sending a purchase order to the supplier (PDF or email) once an email channel is configured; E2 keeps the record only.
- [ ] Receiving by barcode scan on the phone (P23) with the rest of the mobile stock work.
- [ ] Movement history export (P22 "filterable and exportable"), with the CSV protections above.
- [ ] Update `plan/ROADMAP.md` when the round merges.

## Decisions taken with the product owner (2026-10-11)

| Question                         | Decision                                                                                                 |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| How far to go before review      | CRM MVP (F0, F1, C1, C2, C3), one commit per phase, then stop                                            |
| Dispatcher and viewer CRM access | Dispatcher: everything an admin has in CRM, including converting leads. Viewer: read CRM, change nothing |
| Engineer CRM access              | None (the plan's default)                                                                                |
| Who has the CRM switched on      | Nobody by default. A `crm` feature flag, off; Integr8 staff turn it on per company                       |
| Currency                         | A company default currency, used for new opportunities; each opportunity stores its own ISO 4217 code    |
| Default currency                 | EGP. Every existing company is moved to EGP, and new companies start in EGP                              |
| Delivery                         | Push after every phase; one pull request against `main` at the end of the MVP                            |

### Second round: inventory and purchasing (2026-10-11)

| Question                             | Decision                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How far before review                | E1 and E2, then stop                                                                                                                                    |
| Who manages inventory and purchasing | Owner, admin, dispatcher: catalogue, stock, vans, suppliers, purchase orders. Engineer: sees stock, records parts used on their own jobs. Viewer: reads |
| Purchase order approval              | A dispatcher drafts; an owner or admin approves before anything is received                                                                             |
| Cost of a part used on a job         | Weighted average cost of the item at that moment                                                                                                        |
| Parts used from the phone            | In E2, offline, through the outbox (ADR-0005)                                                                                                           |
| Not enough stock for a use           | Refused and flagged as a conflict for people to resolve; stock never goes negative                                                                      |
| Module switches                      | Two flags, both off: `inventory` (catalogue, stock, vans, parts on jobs) and `purchasing` (suppliers, purchase orders)                                  |
| Vans                                 | Stock locations a dispatcher creates and assigns to one engineer at a time (reassignable, audited)                                                      |
| Tax on purchase orders               | Optional tax rate per line, computed exactly; a record, not a tax-compliance claim                                                                      |
| Delivery                             | Same as the CRM: push after each phase, one pull request against `main` at the end                                                                      |

## Documents

| File                                                                               | Status                 |
| ---------------------------------------------------------------------------------- | ---------------------- |
| [PLAN.md](./PLAN.md) — the master plan                                             | Received               |
| [00-repository-assessment.md](./00-repository-assessment.md)                       | F0                     |
| [01-architecture.md](./01-architecture.md)                                         | F0                     |
| [02-feature-matrix.md](./02-feature-matrix.md)                                     | F0                     |
| [dependencies.md](./dependencies.md)                                               | F0                     |
| [decisions/](./decisions/) — ADR-0001 to ADR-0005                                  | F0, E2                 |
| [03-data-model.md](./03-data-model.md)                                             | F1, updated each phase |
| [04-api-contracts.md](./04-api-contracts.md)                                       | C1, updated each phase |
| [05-permissions-and-security.md](./05-permissions-and-security.md)                 | F1, updated each phase |
| [06-navigation-i18n-ux.md](./06-navigation-i18n-ux.md)                             | F1, updated each phase |
| [07-finance-and-inventory-invariants.md](./07-finance-and-inventory-invariants.md) | E1, updated each phase |
| 08-operations-selfhosting.md                                                       | Before L               |
| [09-testing-and-qa.md](./09-testing-and-qa.md)                                     | C1, updated each phase |
