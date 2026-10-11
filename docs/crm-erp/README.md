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

**State: the CRM MVP (F0–C3) merged in PR #73, the inventory and purchasing
round (E1, E2) in PR #74, and the sales round (S1) in PR #75. The fourth
round, B1 (company invoices, payments and job profitability), is built on
`feat/finance-invoices-payments` and waits for review; E3 onwards wait for a
new instruction.**

Fourth round — branch `feat/finance-invoices-payments`, from `main` at
`1886f34`. Agreed scope: **B1 only, then stop for review.**

Third round — branch `feat/sales-quotes-orders`, from `main` at `6819a57`.
Agreed scope: **S1 only, then stop for review.**

Second round — branch `feat/erp-inventory-purchasing`, from `main` at `479d3d7`.
Agreed scope: **E1 → E2, then stop for review.** S1 onwards wait for a new
instruction.

| Phase | What it delivers                                                                                                              | Status           | Migrations | Commit                                                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| F0    | Repository assessment, architecture, feature matrix, dependency audit, ADRs                                                   | `DONE`           | —          | first commit on the branch                                                                                                                           |
| F1    | CRM switch (feature flag), CRM permissions, navigation, EN/AR keys, first CRM tables                                          | `DONE`           | 0024       | second commit on the branch                                                                                                                          |
| C1    | Leads: list, filters, create, edit, detail, status changes, archive (web + desktop)                                           | `DONE`           | —          | third commit on the branch                                                                                                                           |
| C2    | Lead conversion to an existing or new customer, once only; CRM summary on the customer                                        | `DONE`           | —          | fourth commit on the branch                                                                                                                          |
| C3    | Opportunities, pipeline and stages, activities and follow-ups, Customer 360, dashboard                                        | `DONE`           | 0025       | fifth commit on the branch                                                                                                                           |
| E1    | Catalogue and immutable stock ledger (aligns with `plan/v1.1-inventory/P22`)                                                  | `DONE`           | 0026       | second commit on the branch                                                                                                                          |
| E2    | Suppliers, purchasing, goods receipts, van stock, work-order materials (aligns P23)                                           | `DONE`           | 0027, 0028 | third commit: suppliers, purchase orders, receipts, returns (E2a); fourth: parts used on jobs, web, desktop and phone (E2b)                          |
| S1    | Quotes, sales orders with reservations, jobs linked or created from an order, the customer's acceptance link, printable quote | `DONE`           | 0029       | third round: decisions (S0); quotes (S1a); orders, reservations, delivery by jobs (S1b); customer link and printable quote (S1c)                     |
| B1    | Company invoices, payments, credit notes, job costing (not Integr8's own billing)                                             | `DONE`           | 0030       | fourth round: decisions (B0); invoices and credit notes (B1a); payments, the customer's account, job cost (B1b); screens and printable invoice (B1c) |
| E3    | Assets and service history (aligns P24)                                                                                       | `NOT STARTED`    | —          | —                                                                                                                                                    |
| A1    | General ledger                                                                                                                | `NOT AUTHORIZED` | —          | —                                                                                                                                                    |
| L     | Pilot release                                                                                                                 | `NOT STARTED`    | —          | —                                                                                                                                                    |

### Specification coverage

Every numbered item in PLAN.md §4–§5, so none is forgotten.

| Spec item                                  | Phase(s)   | Status           | Notes                                                                                                                                                                                           |
| ------------------------------------------ | ---------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRM-01 Leads                               | F1, C1, C2 | `DONE`           | Leads (C1) and conversion (C2)                                                                                                                                                                  |
| CRM-02 Opportunities                       | C3         | `DONE`           | Default pipeline; no pipeline editing screen yet                                                                                                                                                |
| CRM-03 Activities and tasks                | C3         | `DONE`           | In-app due list only; email reminders after email is set up                                                                                                                                     |
| CRM-04 Customer 360                        | C2, C3     | `DONE` (MVP)     | Quotes and orders are reached from the customer's name on each document; a customer-side list, the customer's account is on the customer screen (B1); an assets tab is a follow-up (E3)         |
| CRM-05 Quotes and pipeline analytics       | S1         | `DONE` (quotes)  | Quotes with revisions and the customer link (S1); analytics beyond the C3 dashboard (conversion rates, cycle time) are a follow-up                                                              |
| CRM-06 Campaigns and automations           | —          | `DEFERRED`       | P2; no marketing platform or bulk email                                                                                                                                                         |
| ERP-01 Products and services catalogue     | E1         | `DONE`           | Images and datasheets on items are a follow-up                                                                                                                                                  |
| ERP-02 Locations and inventory ledger      | E1         | `DONE`           | Serial and batch tracking deferred (P22 lists it; not in scope)                                                                                                                                 |
| ERP-03 Suppliers and purchasing            | E2         | `DONE`           | Supplier price lists and sending a PO to the supplier are follow-ups                                                                                                                            |
| ERP-04 Quotes → sales orders → work orders | S1         | `DONE`           | One order per quote; reservations on confirmation (ADR-0006); jobs created or linked explicitly; delivery by parts and completion                                                               |
| ERP-05 Invoicing and payments              | B1         | `DONE`           | Invoices, credit notes, receipts allocated to invoices with the rest on account, printable invoice. Internal record only; no e-invoicing or tax compliance claim; no customer link or email yet |
| ERP-06 Work-order materials and costing    | E2, B1     | `DONE`           | Parts and their cost on the job (E2); labour at the company's hourly cost, invoiced net and profit per job (B1); parts only, and said so, when no labour cost is set                            |
| ERP-07 Asset register                      | E3         | `NOT STARTED`    | Update P24 when E3 starts                                                                                                                                                                       |
| ERP-08 General ledger                      | A1         | `NOT AUTHORIZED` |                                                                                                                                                                                                 |
| ERP-09 HR, expenses, payroll               | —          | `DEFERRED`       | No payroll without a country's legal review                                                                                                                                                     |
| ERP-10 Manufacturing                       | —          | `DEFERRED`       |                                                                                                                                                                                                 |

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
- [ ] Van replenishment requests from the phone and warehouse picks (P23); E2 ships transfers from the desktop and web only.
- [ ] Parts usage reporting by engineer, customer and job type (P23); E2 keeps the data (`erp_work_order_materials`) and shows it per job.
- [ ] Non-stock parts bought at a merchant from the phone (P23); E2 records services and non-stock items from the web and desktop, and stock items from the phone.
- [ ] Sending the quote's link (and the printed quote) to the customer by email once an email channel exists; S1 has the office copy the link.
- [ ] A server-rendered PDF with embedded fonts for archiving and attachments; S1 prints through the browser (no new dependency, per the decision).
- [ ] Quotes and orders listed on the customer screen (Customer 360); S1 reaches them from the sales lists filtered by customer and from each document.
- [ ] The phone shows reservations only through the server's refusal of a part (conflict with what was available); showing reserved and available in the van's offline stock is a follow-up.
- [ ] Pipeline analytics beyond the dashboard (quote conversion rate, time to accept) — CRM-05's analytics half.
- [ ] Order lines fulfilled by hand (a delivery with no job) and partial deliveries of a stock line without a job; S1 delivers only through linked jobs.
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

### Third round: quotes and sales orders (2026-10-11)

| Question                          | Decision                                                                                                                                                                               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How far before review             | S1 only, then stop                                                                                                                                                                     |
| Who works with quotes and orders  | Dispatchers draft and revise quotes and orders and record a customer's answer; only owners and admins issue a quote and confirm an order. Engineers and viewers read                   |
| Module switch                     | A new `sales` flag, off by default, independent of `crm`, `inventory` and `purchasing`                                                                                                 |
| Recording acceptance              | Both: the office records it (phone, email, on site), and the customer can accept or reject through a signed link, recorded with time and address                                       |
| How the link reaches the customer | Issuing mints a link valid until the quote's expiry date; the office copies and sends it. No system email until an email channel exists. Re-issuing invalidates the old link           |
| Printable quote                   | A print-ready page in the app and on the customer link, in English or Arabic, saved as PDF through the browser. No server-side PDF and no new dependency                               |
| Jobs from an order                | A dispatcher creates a job from the order (lines, job type, site) or links an existing one; zero or many jobs per order; nothing is created automatically                              |
| Stock for a confirmed order       | Reserved on confirmation, per stock line at a chosen location, shown as reserved and available next to on-hand; using the part on a linked job consumes the reservation (ADR-0006)     |
| Not enough to reserve             | The order still confirms; each line reserves what is there and the shortfall is flagged "to order" on the order and the inventory overview. Nothing goes negative                      |
| Pricing                           | A line starts at the item's sale price (editable), with an optional discount % and tax rate in basis points per line; subtotal, discount, tax and total computed exactly on the server |
| Delivery                          | Same as before: one branch, push after each slice, one pull request against `main` at the end                                                                                          |

### Fourth round: company invoices, payments and job profitability (2026-10-11)

| Question                     | Decision                                                                                                                                                                                                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| How far before review        | B1 only, then stop; E3 waits for a new instruction                                                                                                                                                                                                                          |
| Who works with invoices      | Dispatchers draft invoices and credit notes; only owners and admins issue them, record payments, allocate, void and credit. Viewers read; engineers see nothing of finance                                                                                                  |
| Where invoices come from     | From a sales order (its lines, or what was delivered), from a completed job (parts used and a labour line), or blank; the source is kept on the invoice                                                                                                                     |
| Payments                     | A payment is an immutable receipt (date, amount, method cash / bank transfer / other, reference) allocated to one or more of the customer's invoices, never beyond the receipt or the invoice balance; any remainder stays on the customer's account                        |
| Correcting an issued invoice | Never edited. A credit note — a separate numbered document, whole or partial — reduces the balance; an invoice with nothing allocated to it may be voided with a reason and keeps its number                                                                                |
| Labour cost                  | One optional hourly labour cost per company in its settings; job cost = parts used + hours on site × that rate; without a rate the job shows parts only and says labour is not costed                                                                                       |
| Issuer identity and tax      | Company settings hold the issuer block (legal name, address, tax registration number, payment instructions, footer); the invoice prints it with per-line tax rates and exact totals. A fixed note says this is a commercial record, not a certified tax document (ADR-0004) |
| Module switch                | A new `finance` flag, off by default, independent of `sales`; a Finance group with Invoices and Payments; job cost on the job and balance on the customer when it is on                                                                                                     |
| Printing and sending         | A print-ready invoice in the app, PDF through the browser, English or Arabic. No customer link and no email in B1                                                                                                                                                           |
| Delivery                     | Same as before: one branch `feat/finance-invoices-payments`, push after each slice, one pull request against `main` at the end                                                                                                                                              |

## Documents

| File                                                                               | Status                 |
| ---------------------------------------------------------------------------------- | ---------------------- |
| [PLAN.md](./PLAN.md) — the master plan                                             | Received               |
| [00-repository-assessment.md](./00-repository-assessment.md)                       | F0                     |
| [01-architecture.md](./01-architecture.md)                                         | F0                     |
| [02-feature-matrix.md](./02-feature-matrix.md)                                     | F0                     |
| [dependencies.md](./dependencies.md)                                               | F0                     |
| [decisions/](./decisions/) — ADR-0001 to ADR-0007                                  | F0, E2, S1, B1         |
| [03-data-model.md](./03-data-model.md)                                             | F1, updated each phase |
| [04-api-contracts.md](./04-api-contracts.md)                                       | C1, updated each phase |
| [05-permissions-and-security.md](./05-permissions-and-security.md)                 | F1, updated each phase |
| [06-navigation-i18n-ux.md](./06-navigation-i18n-ux.md)                             | F1, updated each phase |
| [07-finance-and-inventory-invariants.md](./07-finance-and-inventory-invariants.md) | E1, updated each phase |
| 08-operations-selfhosting.md                                                       | Before L               |
| [09-testing-and-qa.md](./09-testing-and-qa.md)                                     | C1, updated each phase |
