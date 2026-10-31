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
round, B1 (company invoices, payments and job profitability), in PR #76. The
fifth round, E3 (assets, tags and service history), in PR #77. The sixth
round, A1 (the general ledger), in PR #78. The seventh round, H1 (HR, staff
expenses and Egyptian payroll) and M1 (bills of materials, assembly and
planning), authorized by the product owner on 2026-10-12, went to `main` in PR #79. The eighth round, F2 (follow-ups before the
pilot), authorized on 2026-10-12, went to `main` in PR #80. The ninth round, G1 (product gaps before the
pilot), authorized on 2026-10-12, went to `main` in PR #81, released as
version 1.1.0. Phase L and the open follow-ups move to version 2
(`version2.md` at the repository root).**

Seventh round — branch `feat/hr-payroll-manufacturing`, from `main` at
`64f9025`. Agreed scope: **H1 then M1, one pull request, then stop for
review.**

Sixth round — branch `feat/general-ledger`, from `main` at `ba59995`.
Agreed scope: **A1 only, then stop for review.**

Fifth round — branch `feat/assets-service-history`, from `main` at
`255bc8e`. Agreed scope: **E3 only, then stop for review.**

Fourth round — branch `feat/finance-invoices-payments`, from `main` at
`1886f34`. Agreed scope: **B1 only, then stop for review.**

Third round — branch `feat/sales-quotes-orders`, from `main` at `6819a57`.
Agreed scope: **S1 only, then stop for review.**

Second round — branch `feat/erp-inventory-purchasing`, from `main` at `479d3d7`.
Agreed scope: **E1 → E2, then stop for review.** S1 onwards wait for a new
instruction.

| Phase | What it delivers                                                                                                                                                                                                                                               | Status        | Migrations | Commit                                                                                                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F0    | Repository assessment, architecture, feature matrix, dependency audit, ADRs                                                                                                                                                                                    | `DONE`        | —          | first commit on the branch                                                                                                                                                 |
| F1    | CRM switch (feature flag), CRM permissions, navigation, EN/AR keys, first CRM tables                                                                                                                                                                           | `DONE`        | 0024       | second commit on the branch                                                                                                                                                |
| C1    | Leads: list, filters, create, edit, detail, status changes, archive (web + desktop)                                                                                                                                                                            | `DONE`        | —          | third commit on the branch                                                                                                                                                 |
| C2    | Lead conversion to an existing or new customer, once only; CRM summary on the customer                                                                                                                                                                         | `DONE`        | —          | fourth commit on the branch                                                                                                                                                |
| C3    | Opportunities, pipeline and stages, activities and follow-ups, Customer 360, dashboard                                                                                                                                                                         | `DONE`        | 0025       | fifth commit on the branch                                                                                                                                                 |
| E1    | Catalogue and immutable stock ledger (aligns with `plan/v1.1-inventory/P22`)                                                                                                                                                                                   | `DONE`        | 0026       | second commit on the branch                                                                                                                                                |
| E2    | Suppliers, purchasing, goods receipts, van stock, work-order materials (aligns P23)                                                                                                                                                                            | `DONE`        | 0027, 0028 | third commit: suppliers, purchase orders, receipts, returns (E2a); fourth: parts used on jobs, web, desktop and phone (E2b)                                                |
| S1    | Quotes, sales orders with reservations, jobs linked or created from an order, the customer's acceptance link, printable quote                                                                                                                                  | `DONE`        | 0029       | third round: decisions (S0); quotes (S1a); orders, reservations, delivery by jobs (S1b); customer link and printable quote (S1c)                                           |
| B1    | Company invoices, payments, credit notes, job costing (not Integr8's own billing)                                                                                                                                                                              | `DONE`        | 0030       | fourth round: decisions (B0); invoices and credit notes (B1a); payments, the customer's account, job cost (B1b); screens and printable invoice (B1c)                       |
| E3    | Assets and service history (aligns P24)                                                                                                                                                                                                                        | `DONE`        | 0031, 0032 | fifth round: decisions (E0b); register and timeline (E3a); tags, scanning and assets on the phone (E3b); warranty alerts, carry-over from the last visit, CSV import (E3c) |
| A1    | General ledger: chart, periods and locks, balanced immutable journals, automatic postings from sales and stock, reports, year-end close                                                                                                                        | `DONE`        | 0033–0035  | sixth round: decisions (A0); chart, months and journals (A1a); automatic postings and the unposted list (A1b); reports, year-end close and the screens (A1c)               |
| H1    | HR profiles and roles, staff expense claims, Egyptian payroll (ERP-09)                                                                                                                                                                                         | `DONE`        | 0036–0038  | seventh round: roles, grants and profiles (H1a); expense claims, phone included (H1b); payroll rule sets, pay runs, payslips and files (H1c)                               |
| M1    | Bills of materials, assembly and disassembly, material planning (ERP-10)                                                                                                                                                                                       | `DONE`        | 0039       | seventh round: bills, assembly and disassembly (M1a); planning drafting orders (M1b)                                                                                       |
| F2    | Follow-ups before the pilot: error codes in both languages, CI licence check, self-hosting audit, seventh-round follow-ups, pipelines, Customer 360, analytics and exports, site stock, item media, price lists and reorder, hand deliveries, phone stock work | `DONE`        | 0040       | eighth round, branch `feat/follow-ups` from `main` at `98739a2` (ADR-0012)                                                                                                 |
| G1    | Product gaps before the pilot: custom roles, serial and batch tracking, drag-and-drop on the board, menu entries, amount history                                                                                                                               | `DONE`        | 0041–0043  | ninth round, branch `feat/product-gaps` from `main` at `720b2a7` (ADR-0013)                                                                                                |
| L     | Pilot release                                                                                                                                                                                                                                                  | `NOT STARTED` | —          | —                                                                                                                                                                          |

### Specification coverage

Every numbered item in PLAN.md §4–§5, so none is forgotten.

| Spec item                                  | Phase(s)   | Status     | Notes                                                                                                                                                                                                                                                        |
| ------------------------------------------ | ---------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CRM-01 Leads                               | F1, C1, C2 | `DONE`     | Leads (C1) and conversion (C2)                                                                                                                                                                                                                               |
| CRM-02 Opportunities                       | C3         | `DONE`     | Pipelines and stages edited by owners and admins (F2)                                                                                                                                                                                                        |
| CRM-03 Activities and tasks                | C3         | `DONE`     | In-app due list only; email reminders after email is set up                                                                                                                                                                                                  |
| CRM-04 Customer 360                        | C2, C3     | `DONE`     | Documents tabs and a combined timeline on the customer screen (F2); the customer's account (B1)                                                                                                                                                              |
| CRM-05 Quotes and pipeline analytics       | S1         | `DONE`     | Quotes with revisions and the customer link (S1); quote conversion, win rate, cycle time and value by stage (F2)                                                                                                                                             |
| CRM-06 Campaigns and automations           | —          | `DEFERRED` | P2; no marketing platform or bulk email                                                                                                                                                                                                                      |
| ERP-01 Products and services catalogue     | E1         | `DONE`     | Images (one main, kept on the phone) and datasheets on items (F2)                                                                                                                                                                                            |
| ERP-02 Locations and inventory ledger      | E1         | `DONE`     | Serial numbers and batches with expiry, through every movement and on the phone (G1)                                                                                                                                                                         |
| ERP-03 Suppliers and purchasing            | E2         | `DONE`     | Price lists with breaks and reorder drafts (F2); sending a PO to the supplier waits for email                                                                                                                                                                |
| ERP-04 Quotes → sales orders → work orders | S1         | `DONE`     | One order per quote; reservations on confirmation (ADR-0006); jobs created or linked explicitly; delivery by parts and completion                                                                                                                            |
| ERP-05 Invoicing and payments              | B1         | `DONE`     | Invoices, credit notes, receipts allocated to invoices with the rest on account, printable invoice. Internal record only; no e-invoicing or tax compliance claim; no customer link or email yet                                                              |
| ERP-06 Work-order materials and costing    | E2, B1     | `DONE`     | Parts and their cost on the job (E2); labour at the company's hourly cost, invoiced net and profit per job (B1); parts only, and said so, when no labour cost is set                                                                                         |
| ERP-07 Asset register                      | E3         | `DONE`     | All eight P24 features; the P24 exit check on real equipment and label stock is a manual check before the pilot (09)                                                                                                                                         |
| ERP-08 General ledger                      | A1         | `DONE`     | Management ledger in the company currency: chart, months locked by hand, immutable journals with a second approver, sales and stock posted automatically or from the unposted list, reports, year-end close; no tax or statutory compliance claim (ADR-0009) |
| ERP-09 HR, expenses, payroll               | H1         | `DONE`     | Authorized 2026-10-12 with Egyptian payroll as rule sets each company confirms; no legal review by Integr8 (ADR-0010)                                                                                                                                        |
| ERP-10 Manufacturing                       | M1         | `DONE`     | Bills of materials, assembly, planning (ADR-0011); routing and work centres deferred                                                                                                                                                                         |

### Follow-ups that must not be lost

Items the plan mentions that no phase above fully covers yet. Each gets a phase
or a decision before the pilot (phase L).

- [ ] Email reminders for overdue CRM follow-ups (worker job), once a real email channel is configured.
- [x] Drag-and-drop on the pipeline board (C3 ships an accessible stage selector first). Done in G1 (ADR-0013).
- [x] CSV export of leads and opportunities, with spreadsheet formula-injection protection. Done in F2 (ADR-0012).
- [x] Custom roles or per-member permission overrides (deferred; see PLAN.md §8). Done in G1 as company roles on a base role (ADR-0013).
- [x] Licence-policy check in CI (PLAN.md §10.3); no new dependencies so far. Done in F2 (ADR-0012).
- [x] Self-hosting audit of production-required services (PLAN.md §10.4). Done in F2 (ADR-0012).
- [x] API test of the module gate end to end (`feature_disabled`): landed with C1 (`crm-leads.integration.test.ts`).
- [x] Optional opportunity created by lead conversion (PLAN.md §7.3): landed with C3.
- [x] Show API refusals in the reader's language: shared screens show the server's English message for 4xx errors (existing behaviour across operations screens); map CRM codes to `errors.*` keys. Done in F2 (ADR-0012).
- [x] A screen for editing pipelines and stages (add, rename, reorder, archive); C3 ships the default pipeline only. Done in F2 (ADR-0012).
- [x] Customer 360 timeline mixing CRM activities with work-order and submission events as read-only entries (PLAN.md CRM-03); C3 shows them side by side. Done in F2 (ADR-0012).
- [x] `plan/v1.1-inventory/P22` and `P23` point at the accepted model (E1/E2); P24 when E3 starts.
- [x] Site stock locations from the screens (the API takes `kind: 'site'` with a `siteId`; the list screen offers warehouses and vans only). Done in F2 (ADR-0012).
- [x] Item images and attached datasheets (P22), using the existing media storage. Done in F2 (ADR-0012).
- [x] Serial number and batch tracking (P22) — a scope decision before any schema. Done in G1 (ADR-0013).
- [x] Supplier price lists and a "reorder" draft built from reorder levels (E2 ships one preferred supplier and part number per item). Done in F2 (ADR-0012).
- [ ] Sending a purchase order to the supplier (PDF or email) once an email channel is configured; E2 keeps the record only.
- [x] Receiving by barcode scan on the phone (P23) with the rest of the mobile stock work. Done in F2 (ADR-0012).
- [x] Van replenishment requests from the phone and warehouse picks (P23); E2 ships transfers from the desktop and web only. Done in F2 (ADR-0012).
- [x] Parts usage reporting by engineer, customer and job type (P23); E2 keeps the data (`erp_work_order_materials`) and shows it per job. Done in F2 (ADR-0012).
- [x] Non-stock parts bought at a merchant from the phone (P23); E2 records services and non-stock items from the web and desktop, and stock items from the phone. Done in F2 (ADR-0012).
- [ ] Sending the quote's link (and the printed quote) to the customer by email once an email channel exists; S1 has the office copy the link.
- [ ] A server-rendered PDF with embedded fonts for archiving and attachments; S1 prints through the browser (no new dependency, per the decision).
- [x] Quotes and orders listed on the customer screen (Customer 360); S1 reaches them from the sales lists filtered by customer and from each document. Done in F2 (ADR-0012).
- [x] The phone shows reservations only through the server's refusal of a part (conflict with what was available); showing reserved and available in the van's offline stock is a follow-up. Done in F2 (ADR-0012).
- [x] Pipeline analytics beyond the dashboard (quote conversion rate, time to accept) — CRM-05's analytics half. Done in F2 (ADR-0012).
- [x] Order lines fulfilled by hand (a delivery with no job) and partial deliveries of a stock line without a job; S1 delivers only through linked jobs. Done in F2 (ADR-0012).
- [x] Movement history export (P22 "filterable and exportable"), with the CSV protections above. Done in F2 (ADR-0012).
- [ ] Update `plan/ROADMAP.md` when the round merges.
- [x] Menu entries for the F2 screens (pipelines, reports, parts used, van requests, reorder); today they are reached from links on the screens they belong to. Done in G1 (ADR-0013).
- [ ] Lots on the location screen and on a sales order's delivery list; choosing which batch comes back on a return from a job; a link from a lot's receipt to its purchase order in the trace (G1).
- [ ] Try the phone's G1 lot picking on a device: scan a serial from the van offline, fit it, reconnect, and find it on the asset.
- [ ] Try the phone's F2 screens on a device: My van offline, refill, merchant parts with a receipt in aeroplane mode, receiving by scan (the scanner closes after each code, so a barcode is never counted twice).
- [x] Amount history on opportunities, if value by stage should use the amount a deal had at each month end rather than today's. Done in G1 (ADR-0013).

### Found in the pre-production audit (2026-10-31)

- [x] Purchase orders took any `currencyCode`, and a receipt folded the price into the item's
      company-currency average cost and the ledger unconverted. Another currency is now refused
      (422 `purchase_currency_not_company`), on the order and on a receipt against an older one.
- [x] `PATCH /v1/settings` changed the company currency at any time, while the ledger reads it
      live. It is now fixed once the company holds a money record (409 `currency_in_use`; the
      list is in `07-finance-and-inventory-invariants.md`). A company that must move currency
      needs a deliberate conversion, which does not exist yet.
- [x] A pay run used the latest confirmed rule set in force, skipping a newer one still waiting
      for the owner and taking last year's figures in January. It now uses the latest set in
      force or nothing: 422 `rules_not_confirmed` while it waits, `rules_from_another_year`
      when it starts in an earlier year (ADR-0010, 2026-10-31 addendum).
- [x] Parts could be recorded on any job, closed, cancelled or invoiced; a job invoices once,
      so a part added after its invoice was never billed. The office's screens now refuse
      completed, reviewed, cancelled and invoiced jobs (409 `work_order_closed`,
      `work_order_invoiced`; returns stay allowed). The phone's part recorded before the job
      closed is accepted, posted and marked `recordedAfterClose` (migration 0062); on an
      invoiced job the job shows "Parts not yet billed", the invoice list filters for them
      (`partsNotBilled=true`) and drafting from the job again bills just those parts. A
      cancelled job takes no part from anyone, refused by the database.

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

### Fifth round: assets, tags and service history (2026-10-11)

| Question              | Decision                                                                                                                                                                                                                                               |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| How far before review | E3 only, then stop; L waits for a new instruction                                                                                                                                                                                                      |
| What E3 holds         | Everything on the P24 page: the register, printable tags, scanning on the phone offline, the service timeline, condition and status, warranty alerts, prefill from the last visit, CSV import                                                          |
| Who works with assets | A new `assets` module switch. Owners, admins and dispatchers create, edit, move, retire, tag and import. Engineers read the assets of their job sites and may register one, record its condition and link it to their job from the phone. Viewers read |
| Identity and jobs     | `AS-000001` onwards per company; an optional manufacturer serial unique within the company; an optional catalogue item; a job names zero or more of its site's assets, and a submission or part may name the one it concerns (ADR-0008)                |
| Tags                  | A QR code holding a web link to the asset; opening it needs a signed-in seat of the company. Printed from the app as one label or a sheet. The phone scans in the app and opens the asset from its own copy. No NFC                                    |
| Offline               | Assets of the sites on the phone, with their full history: events, jobs, submissions with answers, parts and full-size photos                                                                                                                          |
| Warranty alerts       | In the app only: a dashboard list for a company-set window, badges on the asset and its jobs, and a local notification on the engineer's phone. No email                                                                                               |
| Prefill               | Only fields the form marks "carry over from the asset's last submission", never photos, signatures or files; the screen shows which answers came from last time                                                                                        |
| Delivery              | Same as before: one branch `feat/assets-service-history`, push after each slice, one pull request against `main` at the end                                                                                                                            |

### Sixth round: the general ledger (2026-10-12)

| Question                | Decision                                                                                                                                                                                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authorization and scope | A1 authorized; A1 only, then stop. L waits for a new instruction                                                                                                                                                                                                                                                                |
| Country and tax         | Egypt-oriented default chart in the company currency (EGP by default), editable; invoice tax posts to "VAT payable (output)"; no ETA, tax or statutory compliance claim                                                                                                                                                         |
| Fiscal year and locks   | The company chooses the start month (default January); monthly periods; owners and admins lock a month by hand; only the owner unlocks, with a reason, audited                                                                                                                                                                  |
| Automatic postings      | Sales (invoices, credit notes, voids, payments) and stock (receipts, returns, parts used, adjustments, counts) post automatically; each can be switched off                                                                                                                                                                     |
| With a switch off       | Documents wait in an "unposted" list with their proposed journal; an owner or admin reviews, may change accounts or date, posts one or many, or marks one "won't post". Sales and stock switch separately                                                                                                                       |
| Who                     | Read: owners, admins, viewers. Owners and admins set up, edit the chart, lock months, post the unposted list and draft manual journals; a manual journal is posted by someone other than its drafter unless the owner allows self-approval (recorded on the journal). Unlocking: owner only. Dispatchers and engineers: nothing |
| Starting point          | A ledger start date (first of a month); older documents never post; balances brought forward as an opening journal, receivables pre-filled from open invoices                                                                                                                                                                   |
| Currency                | Company currency only; a document in another currency waits for a typed exchange rate, recorded on the journal with its source; no rate feed or revaluation                                                                                                                                                                     |
| Reports and closing     | Trial balance, account activity, receivables reconciliation with aging, a profit and loss and a balance sheet (management reports, not statutory accounts), year-end close into retained earnings; printable and CSV                                                                                                            |
| Delivery                | Same as before: one branch `feat/general-ledger`, push after each slice (A1a chart, periods, journals; A1b automatic postings and the unposted list; A1c reports, close and screens), one pull request against `main` at the end                                                                                                |

### Seventh round: HR, payroll and manufacturing (2026-10-12)

| Question             | Decision                                                                                                                                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope                | ERP-09 (H1) then ERP-10 (M1), one pull request, then stop                                                                                                                                                                      |
| Payroll              | Full Egyptian payroll, figures as dated rule sets seeded with the 2026 values and confirmed by the owner before use; no legal review by Integr8, said on every payslip                                                         |
| HR profile           | Job details, dates, national ID, insurance number, bank account, emergency contact, pay terms; pay and ID data for the owner and HR managers only; each person sees their own                                                  |
| Who is an employee   | Members, plus employees without a login who take no seat                                                                                                                                                                       |
| Sensitive fields     | National ID, insurance number and bank account encrypted at rest with a new `HR_DATA_KEY`; last four in clear; reveals audited                                                                                                 |
| Expense claims       | Any member, from the phone offline too, with receipts; approved by someone else (owner, admin, HR manager); paid back or through payroll; posted to the ledger                                                                 |
| Pay run              | Monthly: salary, allowances, overtime from approved timesheets, bonuses and deductions, unpaid leave, claims; tax, insurance, Martyrs' Fund; approved by a second person; payslips, insurance report, bank CSV, ledger journal |
| Roles and grants     | New roles `hr_manager` and `inventory_manager`, and the same as grants on top of any role; HR given only by the owner, inventory by the owner or an admin                                                                      |
| Modules              | Three switches, off by default: `hr`, `payroll` (needs `hr`), `manufacturing` (needs `inventory`)                                                                                                                              |
| Ledger               | Claims, payments, pay runs and assemblies post automatically with a switch per area, or wait in the unposted list; new posting accounts added to existing charts                                                               |
| Manufacturing        | Versioned bills of materials, assembly and disassembly at rolled-up cost, and on-demand planning (MRP) that drafts assembly and purchase orders for the usual approval; no routing or work centres                             |
| Manufacturing access | Owners, admins and inventory managers; viewers read                                                                                                                                                                            |
| Delivery             | Branch `feat/hr-payroll-manufacturing`, slices pushed as done (H1a, H1b, H1c, M1a, M1b), one pull request against `main`, then stop                                                                                            |

### Eighth round: follow-ups before the pilot (2026-10-12)

| Question        | Decision                                                                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Scope           | All CRM and sales follow-ups, all inventory and field follow-ups, the CI licence check and self-hosting audit, and the seventh round's follow-ups; email and server-rendered PDFs stay out |
| Error text      | Every API error code in English and Arabic on web, desktop and the phone, with a test failing on a missing one                                                                             |
| Pipelines       | Owners and admins edit several pipelines and their stages; archiving a stage with open deals moves them to a chosen stage                                                                  |
| Customer 360    | Quotes, orders, invoices and the account on the customer, and one timeline of activities, job events, submissions and documents                                                            |
| Analytics       | Quote conversion and time to accept; win rate and cycle time; value by stage at month ends; parts usage                                                                                    |
| Exports         | Leads and opportunities by CRM managers, movements by those who move stock; audited; formula cells escaped                                                                                 |
| Site stock      | Chosen per site location: ours (counted and valued) or the customer's (a record only)                                                                                                      |
| Item media      | Images (one main) and datasheets for everyone who sees the item; main image offline on the phone, datasheets online                                                                        |
| Price lists     | Per supplier and item, dated, with quantity breaks, in the supplier's currency; used on new purchase order lines and planning drafts                                                       |
| Reorder         | Below the reorder level back up to it, net of orders, per supplier, as draft purchase orders                                                                                               |
| Hand deliveries | Sales managers deliver from a chosen location, partly or fully, with a printable delivery note                                                                                             |
| Van refills     | Engineer request, store pick at a warehouse, transfer to the van; online only                                                                                                              |
| Merchant parts  | On the job with the price and a receipt photo, offline too; nothing enters stock                                                                                                           |
| Scan to receive | Store staff on the phone, online, scanning against an approved purchase order                                                                                                              |
| Licences        | Permissive only; others fail CI, with a reviewed exceptions file                                                                                                                           |
| Delivery        | Branch `feat/follow-ups`, slices F2a platform, F2b CRM and sales, F2c inventory and field; one pull request to `main`, then stop                                                           |

### Ninth round: product gaps before the pilot (2026-10-12)

| Question       | Decision                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Scope          | Drag-and-drop on the board, custom roles, serial and batch tracking, menu entries for the F2 screens, amount history on opportunities |
| Custom roles   | Named roles built on a base role, adding or removing permissions; one role per member; owner fixed                                    |
| Role admins    | The owner creates roles; owners and admins assign them, never above their own rank                                                    |
| Tracking       | Per item: none, serial or batch (with optional expiry), through every movement                                                        |
| Batch choice   | Earliest expiry proposed, the person may change it; expired needs a reason                                                            |
| Phone          | Offline, picked or scanned from the van's serials and batches; a clash becomes a conflict for the office                              |
| Existing stock | An item becomes tracked only with no stock, or through a count recording each serial or batch                                         |
| Serial trace   | A serial lookup with its whole path, and the serial shown on the asset it was fitted to                                               |
| Drag-and-drop  | Open stages move at once with undo; won or lost opens the confirm step; `@dnd-kit` (already used by the desktop)                      |
| Amount history | Recorded from this release; earlier months use today's amount                                                                         |
| Delivery       | Branch `feat/product-gaps`: roles, then tracking, then board, menus and amounts; one pull request to `main`, then stop                |

## Documents

| File                                                                               | Status                         |
| ---------------------------------------------------------------------------------- | ------------------------------ |
| [PLAN.md](./PLAN.md) — the master plan                                             | Received                       |
| [00-repository-assessment.md](./00-repository-assessment.md)                       | F0                             |
| [01-architecture.md](./01-architecture.md)                                         | F0                             |
| [02-feature-matrix.md](./02-feature-matrix.md)                                     | F0                             |
| [dependencies.md](./dependencies.md)                                               | F0                             |
| [decisions/](./decisions/) — ADR-0001 to ADR-0011                                  | F0, E2, S1, B1, E3, A1, H1, M1 |
| [03-data-model.md](./03-data-model.md)                                             | F1, updated each phase         |
| [04-api-contracts.md](./04-api-contracts.md)                                       | C1, updated each phase         |
| [05-permissions-and-security.md](./05-permissions-and-security.md)                 | F1, updated each phase         |
| [06-navigation-i18n-ux.md](./06-navigation-i18n-ux.md)                             | F1, updated each phase         |
| [07-finance-and-inventory-invariants.md](./07-finance-and-inventory-invariants.md) | E1, updated each phase         |
| 08-operations-selfhosting.md                                                       | Before L                       |
| [09-testing-and-qa.md](./09-testing-and-qa.md)                                     | C1, updated each phase         |
