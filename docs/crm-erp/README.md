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

| Phase | What it delivers                                                                       | Status           | Migrations | Commit                      |
| ----- | -------------------------------------------------------------------------------------- | ---------------- | ---------- | --------------------------- |
| F0    | Repository assessment, architecture, feature matrix, dependency audit, ADRs            | `DONE`           | —          | first commit on the branch  |
| F1    | CRM switch (feature flag), CRM permissions, navigation, EN/AR keys, first CRM tables   | `DONE`           | 0024       | second commit on the branch |
| C1    | Leads: list, filters, create, edit, detail, status changes, archive (web + desktop)    | `NOT STARTED`    | —          | —                           |
| C2    | Lead conversion to an existing or new customer, once only; CRM summary on the customer | `NOT STARTED`    | —          | —                           |
| C3    | Opportunities, pipeline and stages, activities and follow-ups, Customer 360, dashboard | `NOT STARTED`    | —          | —                           |
| E1    | Catalogue and immutable stock ledger (aligns with `plan/v1.1-inventory/P22`)           | `NOT STARTED`    | —          | —                           |
| E2    | Suppliers, purchasing, goods receipts, van stock, work-order materials (aligns P23)    | `NOT STARTED`    | —          | —                           |
| S1    | Quotes and sales orders, linked to work orders                                         | `NOT STARTED`    | —          | —                           |
| B1    | Company invoices, payments, credit notes, job costing (not Integr8's own billing)      | `NOT STARTED`    | —          | —                           |
| E3    | Assets and service history (aligns P24)                                                | `NOT STARTED`    | —          | —                           |
| A1    | General ledger                                                                         | `NOT AUTHORIZED` | —          | —                           |
| L     | Pilot release                                                                          | `NOT STARTED`    | —          | —                           |

### Specification coverage

Every numbered item in PLAN.md §4–§5, so none is forgotten.

| Spec item                                  | Phase(s)   | Status           | Notes                                                         |
| ------------------------------------------ | ---------- | ---------------- | ------------------------------------------------------------- |
| CRM-01 Leads                               | F1, C1, C2 | `IN PROGRESS`    |                                                               |
| CRM-02 Opportunities                       | C3         | `NOT STARTED`    |                                                               |
| CRM-03 Activities and tasks                | C3         | `NOT STARTED`    | In-app due list only; email reminders after email is set up   |
| CRM-04 Customer 360                        | C2, C3     | `NOT STARTED`    | Quotes, orders, invoices and assets tabs arrive with S1/B1/E3 |
| CRM-05 Quotes and pipeline analytics       | S1         | `NOT STARTED`    | Simple pipeline counts come with the C3 dashboard             |
| CRM-06 Campaigns and automations           | —          | `DEFERRED`       | P2; no marketing platform or bulk email                       |
| ERP-01 Products and services catalogue     | E1         | `NOT STARTED`    |                                                               |
| ERP-02 Locations and inventory ledger      | E1         | `NOT STARTED`    | Update `plan/v1.1-inventory/P22` when E1 starts               |
| ERP-03 Suppliers and purchasing            | E2         | `NOT STARTED`    | Update P23 when E2 starts                                     |
| ERP-04 Quotes → sales orders → work orders | S1         | `NOT STARTED`    |                                                               |
| ERP-05 Invoicing and payments              | B1         | `NOT STARTED`    | Internal ledger only; no e-invoicing or tax compliance claim  |
| ERP-06 Work-order materials and costing    | E2, B1     | `NOT STARTED`    | Mobile consumption only after a separate sync design          |
| ERP-07 Asset register                      | E3         | `NOT STARTED`    | Update P24 when E3 starts                                     |
| ERP-08 General ledger                      | A1         | `NOT AUTHORIZED` |                                                               |
| ERP-09 HR, expenses, payroll               | —          | `DEFERRED`       | No payroll without a country's legal review                   |
| ERP-10 Manufacturing                       | —          | `DEFERRED`       |                                                               |

### Follow-ups that must not be lost

Items the plan mentions that no phase above fully covers yet. Each gets a phase
or a decision before the pilot (phase L).

- [ ] Email reminders for overdue CRM follow-ups (worker job), once a real email channel is configured.
- [ ] Drag-and-drop on the pipeline board (C3 ships an accessible stage selector first).
- [ ] CSV export of leads and opportunities, with spreadsheet formula-injection protection.
- [ ] Custom roles or per-member permission overrides (deferred; see PLAN.md §8).
- [ ] Licence-policy check in CI (PLAN.md §10.3); no new dependencies so far.
- [ ] Self-hosting audit of production-required services (PLAN.md §10.4).
- [ ] API test of the module gate end to end (`feature_disabled`): needs the first CRM route, so it lands with C1.
- [ ] Update `plan/ROADMAP.md` and `plan/v1.1-inventory/P22–P24` when the ERP phases start.

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

## Documents

| File                                                               | Status                 |
| ------------------------------------------------------------------ | ---------------------- |
| [PLAN.md](./PLAN.md) — the master plan                             | Received               |
| [00-repository-assessment.md](./00-repository-assessment.md)       | F0                     |
| [01-architecture.md](./01-architecture.md)                         | F0                     |
| [02-feature-matrix.md](./02-feature-matrix.md)                     | F0                     |
| [dependencies.md](./dependencies.md)                               | F0                     |
| [decisions/](./decisions/) — ADR-0001 to ADR-0004                  | F0                     |
| [03-data-model.md](./03-data-model.md)                             | F1, updated each phase |
| 04-api-contracts.md                                                | From C1                |
| [05-permissions-and-security.md](./05-permissions-and-security.md) | F1, updated each phase |
| [06-navigation-i18n-ux.md](./06-navigation-i18n-ux.md)             | F1, updated each phase |
| 07-finance-and-inventory-invariants.md                             | From E1                |
| 08-operations-selfhosting.md                                       | Before L               |
| 09-testing-and-qa.md                                               | From C1                |
