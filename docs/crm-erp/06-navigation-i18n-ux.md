# 06 — Navigation, languages and screens

## Navigation

`packages/core/src/navigation.ts` has a `crm` group, placed between Work and
Operations, a `sales` group after it (S1) and a `finance` group after that (B1), and an `accounting` group after finance (A1), then an `hr` group (H1). Manufacturing's sections (M1) join the `inventory` group after purchase orders. Assets (E3) are a section of the existing `operations` group. A section can name a `feature`; `visibleNavigation(app,
permissions, features)` shows it only when the company has the module and the
seat holds the section's permission. Callers that pass no flags show no gated
section.

| Section key      | Group        | Permission           | Feature         | Web route               | Desktop route            | Phase |
| ---------------- | ------------ | -------------------- | --------------- | ----------------------- | ------------------------ | ----- |
| `crm`            | `crm`        | `crm.read`           | `crm`           | `/crm`                  | `#/crm`                  | F1    |
| `leads`          | `crm`        | `crm.read`           | `crm`           | `/crm/leads`            | `#/crm/leads`            | C1    |
| `opportunities`  | `crm`        | `crm.read`           | `crm`           | `/crm/opportunities`    | `#/crm/opportunities`    | C3    |
| `activities`     | `crm`        | `crm.read`           | `crm`           | `/crm/activities`       | `#/crm/activities`       | C3    |
| `inventory`      | `inventory`  | `inventory.read`     | `inventory`     | `/inventory`            | `#/inventory`            | E1    |
| `items`          | `inventory`  | `inventory.read`     | `inventory`     | `/inventory/items`      | `#/inventory/items`      | E1    |
| `stockLocations` | `inventory`  | `inventory.read`     | `inventory`     | `/inventory/locations`  | `#/inventory/locations`  | E1    |
| `suppliers`      | `inventory`  | `purchasing.read`    | `purchasing`    | `/purchasing/suppliers` | `#/purchasing/suppliers` | E2    |
| `purchaseOrders` | `inventory`  | `purchasing.read`    | `purchasing`    | `/purchasing/orders`    | `#/purchasing/orders`    | E2    |
| `quotes`         | `sales`      | `sales.read`         | `sales`         | `/sales/quotes`         | `#/sales/quotes`         | S1    |
| `salesOrders`    | `sales`      | `sales.read`         | `sales`         | `/sales/orders`         | `#/sales/orders`         | S1    |
| `invoices`       | `finance`    | `finance.read`       | `finance`       | `/finance/invoices`     | `#/finance/invoices`     | B1    |
| `payments`       | `finance`    | `finance.read`       | `finance`       | `/finance/payments`     | `#/finance/payments`     | B1    |
| `assets`         | `operations` | `asset.read`         | `assets`        | `/assets`               | `#/assets`               | E3    |
| `ledger`         | `accounting` | `ledger.read`        | `ledger`        | `/ledger`               | `#/ledger`               | A1    |
| `journals`       | `accounting` | `ledger.read`        | `ledger`        | `/ledger/journals`      | `#/ledger/journals`      | A1    |
| `ledgerReports`  | `accounting` | `ledger.read`        | `ledger`        | `/ledger/reports`       | `#/ledger/reports`       | A1    |
| `boms`           | `inventory`  | `manufacturing.read` | `manufacturing` | `/manufacturing/boms`   | `#/manufacturing/boms`   | M1    |
| `assemblyOrders` | `inventory`  | `manufacturing.read` | `manufacturing` | `/manufacturing/orders` | `#/manufacturing/orders` | M1    |
| `materialPlans`  | `inventory`  | `manufacturing.read` | `manufacturing` | `/manufacturing/plans`  | `#/manufacturing/plans`  | M1    |
| `employees`      | `hr`         | `hr.read`            | `hr`            | `/hr/employees`         | `#/hr/employees`         | H1    |
| `expenseClaims`  | `hr`         | `expense.approve`    | `hr`            | `/hr/claims`            | `#/hr/claims`            | H1    |
| `payRuns`        | `hr`         | `payroll.run`        | `payroll`       | `/hr/pay-runs`          | `#/hr/pay-runs`          | H1    |
| `payrollRules`   | `hr`         | `payroll.run`        | `payroll`       | `/hr/payroll-rules`     | `#/hr/payroll-rules`     | H1    |
| `myProfile`      | `hr`         | —                    | `hr`            | `/hr/me`                | `#/hr/me`                | H1    |
| `myExpenses`     | `hr`         | `expense.submit`     | `hr`            | `/hr/expenses`          | `#/hr/expenses`          | H1    |
| `myPayslips`     | `hr`         | —                    | `payroll`       | `/hr/payslips`          | `#/hr/payslips`          | H1    |

Web: `apps/web/src/lib/navigation.ts` (`NAV_PATHS`), menu in
`apps/web/src/components/workspace-shell.tsx`. Desktop:
`apps/desktop/src/lib/navigation.ts` (`NAV_ROUTES`, `desktopNavigation`), used
by the side menu and the dashboard cards.

## Screens

Shared screens live in `packages/operations-dom/src/crm/` and are mounted by
thin wrappers: `apps/web/src/app/(app)/crm/*` and
`apps/desktop/src/features/operations/screens.tsx` + `apps/desktop/src/App.tsx`.

| Screen                        | Component                                                 | Phase  | Notes                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRM overview (dashboard)      | `CrmOverviewScreen`                                       | F1, C3 | Says plainly when the module is off or the seat may not read the CRM; otherwise the dashboard: open pipeline and weighted forecast per currency ("a forecast, not revenue"), won and lost in 30 days, follow-ups overdue / today / mine, open opportunities by stage, leads by status                                                                                         |
| Leads                         | `LeadListScreen`                                          | C1     | Search, status, source and assignee filters (`me`, `none`), archived toggle, "show more" paging, new-lead dialog, right-click menu on desktop                                                                                                                                                                                                                                 |
| Lead                          | `LeadScreen`                                              | C1     | Details, edit form (sends only changed fields), quick status select, archive and restore, reload prompt on a version conflict, converted leads read-only with a link to the customer                                                                                                                                                                                          |
| Convert a lead                | `LeadConvertScreen`                                       | C2     | Three steps: choose the customer (suggestions with reasons, search, or new — nothing preselected), choose the contact, review in plain words; then convert once. One idempotency key per distinct request, so a retry replays                                                                                                                                                 |
| Customer → CRM section        | `CustomerCrmSection`                                      | C2     | On the existing customer screen, only when the company has the CRM and the seat holds `crm.read`; lists the leads that became the customer                                                                                                                                                                                                                                    |
| Opportunities                 | `OpportunityBoardScreen`                                  | C3     | Board (a column per open stage) or list (any status); search and owner filters; each card moves with a **stage select** (keyboard-first; drag-and-drop is a follow-up) and losing asks for a reason in a dialog; new-opportunity dialog with a customer search; right-click menu on desktop                                                                                   |
| Opportunity                   | `OpportunityScreen`                                       | C3     | Details, stage select, edit (chance typed as a percentage, sent as basis points), archive, history in words ("Moved from New to Qualified"), activity panel, reload prompt on a version conflict                                                                                                                                                                              |
| Follow-ups                    | `ActivitiesScreen`                                        | C3     | Tabs: overdue, today, upcoming, no date, done; "only mine"; mark done; links to each activity's records                                                                                                                                                                                                                                                                       |
| Activity panel                | `ActivityPanel`                                           | C3     | On a lead, an opportunity and a customer: newest first, add a call, email, meeting, note, follow-up or task                                                                                                                                                                                                                                                                   |
| Lead (additions)              | `LeadScreen`                                              | C3     | The lead's opportunities with "New opportunity", and its activity panel                                                                                                                                                                                                                                                                                                       |
| Customer → CRM (additions)    | `CustomerCrmSection`                                      | C3     | Opportunities, leads, "New opportunity", and the customer's activity panel                                                                                                                                                                                                                                                                                                    |
| Convert a lead (addition)     | `LeadConvertScreen`                                       | C3     | "Also open an opportunity", prefilled with the lead's company and carrying its estimate and currency                                                                                                                                                                                                                                                                          |
| Inventory overview            | `InventoryOverviewScreen`                                 | E1     | Items below their reorder level, the latest movements, "Move stock", and (manage) "Check the ledger"                                                                                                                                                                                                                                                                          |
| Items                         | `ItemListScreen`                                          | E1     | Search, kind and category filters, archived toggle, stock everywhere per item, new-item dialog                                                                                                                                                                                                                                                                                |
| Item                          | `ItemScreen`                                              | E1     | Details (costs only to seats that move stock), stock by location with reorder levels, movements, edit, archive, "Move stock"                                                                                                                                                                                                                                                  |
| Stock locations               | `LocationListScreen`                                      | E1     | Grouped warehouse / van / site; new warehouse or van with its engineer (site locations are made through the API for now)                                                                                                                                                                                                                                                      |
| Location                      | `LocationScreen`                                          | E1     | What it holds, who drives the van (reassign), stock counts, "Move stock", "Start a count", archive when empty                                                                                                                                                                                                                                                                 |
| Stock count                   | `StockCountScreen`                                        | E1     | Counted vs system per item, add items the location holds, post (confirm) or cancel                                                                                                                                                                                                                                                                                            |
| Move stock dialog             | `MoveStockDialog`                                         | E1     | Receipt (priced), issue, transfer, correction; reason required where the API requires it; one idempotency key per request                                                                                                                                                                                                                                                     |
| Inventory overview (addition) | `InventoryOverviewScreen`                                 | E2     | Cards for suppliers and purchase orders when the `purchasing` module is on and the seat may read it                                                                                                                                                                                                                                                                           |
| Suppliers                     | `SupplierListScreen`                                      | E2     | Search, inactive toggle, lead time, new-supplier dialog (`SupplierFields`, shared with the supplier screen)                                                                                                                                                                                                                                                                   |
| Supplier                      | `SupplierScreen`                                          | E2     | Details and address, edit in place, make inactive or active, latest orders with totals, "New order" with the supplier fixed                                                                                                                                                                                                                                                   |
| Purchase orders               | `OrderListScreen`                                         | E2     | Search by reference or supplier, status filter, totals (to those who may see prices), new-order dialog with the line editor (`LinesEditor`: item picker, description, quantity, unit price, tax typed as a percentage and sent as basis points)                                                                                                                               |
| Purchase order                | `OrderScreen`                                             | E2     | Reference and status, supplier link, expected date, delivery location, lines with received quantities and totals, edit the draft, approve (confirm), cancel (reason prompt), receipts with "Return to supplier", receive dialog (per line: arrived, unit cost), return dialog; one idempotency key per distinct request                                                       |
| Job (additions)               | `WorkOrderScreen` → `Parts`                               | E2     | Parts used with cost (to those who may see it), a refused use flagged with what was asked and what was there, record a part (engineer: from their van; office: any location), return, resolve (retry or cancel)                                                                                                                                                               |
| Inventory overview (addition) | `InventoryOverviewScreen`                                 | E2     | "Parts needing attention": refused uses across jobs, for those who move stock                                                                                                                                                                                                                                                                                                 |
| Phone: job                    | `JobParts`, `app/parts/[id]`                              | E2     | Parts used on the job with status (not sent yet / used / needs attention); "Use a part" picks from the van's stock offline, showing a forecast net of unsent uses, and records the use into the outbox                                                                                                                                                                        |
| Quotes                        | `QuoteListScreen`                                         | S1     | Search by reference, title or customer, status filter, paging; "New quote" picks a customer and lines (catalogue items or hand-written, quantity, unit, price, discount %, tax %)                                                                                                                                                                                             |
| Quote                         | `QuoteScreen`                                             | S1     | Lines and totals, issued-to snapshot, the customer's answer; edit lines and details while a draft; issue (owner/admin) hands over the customer link once with "Copy link"; record the answer; revise; withdraw; convert to an order; "Print or save as PDF" prints the `QuoteDocument` alone (the shells hide themselves)                                                     |
| Opportunity (addition)        | `OpportunityScreen`                                       | S1     | "New quote" for an open opportunity with a customer, when the company has sales and the seat manages it                                                                                                                                                                                                                                                                       |
| Sales orders                  | `SalesOrderListScreen`                                    | S1     | By status and text, "To order" flagged; "New sales order" drafts one without a quote                                                                                                                                                                                                                                                                                          |
| Sales order                   | `SalesOrderScreen`                                        | S1     | Lines with reserved and delivered quantities and "To order" badges; confirm at a location (reserving); re-run the reservation; cancel; edit a draft; link one of the customer's open jobs or create a job (site, job type, title); the jobs that deliver it with unlink                                                                                                       |
| Job (addition)                | `WorkOrderScreen`                                         | S1     | The sales orders the job delivers, linked                                                                                                                                                                                                                                                                                                                                     |
| Inventory (additions)         | `InventoryOverviewScreen`, `ItemScreen`, `LocationScreen` | S1     | "To order for confirmed sales orders" on the overview; reserved and available next to on-hand wherever a balance is shown                                                                                                                                                                                                                                                     |
| Customer's quote (public web) | `QuoteDocument` at `/q/[token]`                           | S1     | The issued quote as a document in the visitor's language, accept or decline with a name, print or save as PDF; the same message for every invalid link                                                                                                                                                                                                                        |
| Invoices                      | `InvoiceListScreen`                                       | B1     | Search by reference or customer, derived status filter, "Overdue only", paging; what each owes; "New invoice" (customer, due date, lines); a link to the invoice settings                                                                                                                                                                                                     |
| Invoice                       | `InvoiceScreen`                                           | B1     | Status and overdue badges, the source order or job, amounts (total, credited, paid, still owed), lines; edit lines and details while a draft; issue (owner/admin, optional due date); record a payment against it; credit (whole or by lines) with drafts to issue or discard; void with a reason; discard a draft; "Print or save as PDF" prints the `InvoiceDocument` alone |
| Payments                      | `PaymentListScreen`                                       | B1     | Search by reference or customer, "With money on account"; "Record payment" picks a customer                                                                                                                                                                                                                                                                                   |
| Payment                       | `PaymentScreen`                                           | B1     | Amount, put against invoices, on account; allocations with who and when, removed ones struck through, "Take back"; "Put against an invoice" offers the customer's owing invoices and fills in what either has                                                                                                                                                                 |
| Invoice settings              | `FinanceSettingsScreen`                                   | B1     | The issuer block, days to pay, labour cost and rate; says invoices are commercial records, not certified tax documents; read-only below owner/admin                                                                                                                                                                                                                           |
| Customer (addition)           | `CustomerScreen` → `CustomerAccountSection`               | B1     | Owed, on account and the balance per currency; invoices still owing; payments with money on account; "New invoice" and "Record payment"                                                                                                                                                                                                                                       |
| Job (addition)                | `WorkOrderScreen` → `JobFinancePanel`                     | B1     | The job's invoices; "Invoice this job" once complete; hours on site, and for those who see costs parts, labour, cost, invoiced and profit, with "parts only" said when no labour cost is set                                                                                                                                                                                  |
| Sales order (addition)        | `SalesOrderScreen`                                        | B1     | "Invoice this order" for a confirmed or delivered order: everything ordered or what has been delivered                                                                                                                                                                                                                                                                        |
| Assets                        | `AssetListScreen`                                         | E3     | Search by number, tag, serial, name or customer; status and warranty filters (`?warranty=expiring` opens it filtered); status, condition and warranty badges; tick assets and "Print tags"; "New asset" (pick a customer and site); "Warranty alerts" sets the window                                                                                                         |
| Asset                         | `AssetScreen`                                             | E3     | Details, the jobs it is on, the last condition; edit, move, change status, record a condition, new tag, attach a photo or document, "Print tag"; the timeline newest first in words — events, jobs, submissions with photo counts, parts fitted, files                                                                                                                        |
| Asset tag (print)             | `AssetTag`, `AssetTagSheet`                               | E3     | 63.5 × 38.1 mm labels, 21 to an A4 sheet: a QR code (level Q, quiet zone, one black path on white) of the tag link, the company, the number, the name and the code in groups of four to type                                                                                                                                                                                  |
| Scanned tag (web)             | `AssetTagOpener` at `/a/[code]`                           | E3     | Opens the asset the code names, replacing the tag page in history; says plainly when no asset has it. Signed out, the sign-in page returns here                                                                                                                                                                                                                               |
| Job (addition)                | `WorkOrderScreen` → `JobAssetsPanel`                      | E3     | The job's assets with badges, record a condition, unlink; link one of the site's assets; register one found here. The forms list adds "Fill forms for" an asset (the job's one asset is chosen)                                                                                                                                                                               |
| Site (addition)               | `SiteScreen` → `SiteAssetsSection`                        | E3     | The site's assets; "New asset" with the site fixed                                                                                                                                                                                                                                                                                                                            |
| Dashboard (addition)          | `WarrantyAlertsPanel`                                     | E3     | Warranties ending within the window, soonest first, with "See them all"                                                                                                                                                                                                                                                                                                       |
| Submission (addition)         | `SubmissionScreen`                                        | E3     | "For asset AS-000012 · Boiler"; while filled, which answers were carried over from the asset's last visit                                                                                                                                                                                                                                                                     |
| Form builder (addition)       | desktop config panel                                      | E3     | "Carry over from the asset's last visit" on every question that can carry (not evidence, calculated or read-only)                                                                                                                                                                                                                                                             |
| Imports (addition)            | `ImportsScreen`                                           | E3     | An "Assets" kind for those who manage assets                                                                                                                                                                                                                                                                                                                                  |
| Phone: home and job           | `app/home`, `JobAssets`                                   | E3     | "Scan a tag"; on a job: its assets, scan, link one of the site's, register one                                                                                                                                                                                                                                                                                                |
| Phone: asset                  | `app/assets/[id]`, `scan`, `new`                          | E3     | The whole history offline, files opened from the phone or fetched; record a condition; link to the job; fill the job's forms for this asset; scan reads a tag link, a typed code or a serial barcode                                                                                                                                                                          |

Routes: web `/sales/quotes`, `/sales/quotes/[id]`, `/sales/orders`,
`/sales/orders/[id]` and the public `/q/[token]`; desktop the first four under
`#/` (S1). Printing: the quote screen renders the `QuoteDocument` hidden on
screen and alone in print; the web and desktop shells carry `print:hidden`.

Routes: web `/finance/invoices`, `/finance/invoices/[id]`, `/finance/payments`,
`/finance/payments/[id]`, `/finance/settings`; desktop the same under `#/`
(B1). Printing works as for quotes: `InvoiceDocument` is hidden on screen and
alone in print, and a draft prints marked "not issued". References and amounts
are `dir="ltr"`, and amounts go through `formatAmount`, never a float.

Routes: web `/assets`, `/assets/[id]` and `/a/[code]` (the tag link, inside the
signed-in app); desktop `#/assets` and `#/assets/:assetId` (E3). The tag sheet
is hidden on screen and alone in print, like the quote and invoice documents.
Asset numbers, tag codes and serials are `dir="ltr"`. Warranty and install
dates are calendar dates and are formatted with `formatCalendarDate` (noon UTC
in UTC), so they read as the same day in every time zone. On the phone the
warranty alert is one local notification per asset and expiry date, folded
into one when more than three are due, and opens the asset.

Routes: web `/inventory`, `/inventory/items`, `/inventory/items/[id]`,
`/inventory/locations`, `/inventory/locations/[id]`, `/inventory/counts/[id]`,
`/purchasing/suppliers`, `/purchasing/suppliers/[id]`, `/purchasing/orders`,
`/purchasing/orders/[id]`; desktop the same under `#/`. Quantities are formatted by `formatQuantity`
(decimal string straight to `Intl.NumberFormat`, up to four places, then the
translated unit). SKUs, barcodes and quantities are `dir="ltr"`.

Routes: web `/crm/leads`, `/crm/leads/[id]`, `/crm/leads/[id]/convert`,
`/crm/opportunities`, `/crm/opportunities/[id]` and `/crm/activities`; desktop
the same under `#/`. Amounts are formatted by `formatAmount`
(`packages/operations-dom/src/crm/lead-parts.tsx`), which hands the decimal
string straight to `Intl.NumberFormat`, so no amount passes through a float.
Email and phone fields and values are `dir="ltr"` in both languages.

### The general ledger (A1)

Screens in `packages/operations-dom/src/ledger/`, the same on web and desktop:
the ledger's front page (set-up for owners and admins — start month, fiscal
year, chart language — then a hub with the unposted count by reason, the
opening balances and links to everything), the chart of accounts, journals
(list, editor with live totals and a balance indicator, detail with post,
discard, reverse and a link to the invoice or payment behind it), the
unposted list and one document (post as proposed, redated, with lines written
out, or at a typed rate with its source; set aside with a reason), months and
years (lock, unlock with a reason, close and reopen a year), reports and
settings. Every screen says it is a management ledger, not statutory
accounts; the profit and loss and balance sheet carry it as their heading.

A journal written by hand that its drafter tries to post shows who must post
it, or — when the owner allows self-approval — a required "I approve it
myself" box. Refusals from the API (`self_approval`, `period_locked`,
`unbalanced`, `waits_for_invoice`, `rate_required`, `year_not_ready` and the
rest) are shown in the reader's language, against the line they name when the
server names one. Reports print from the browser with the screen around them
hidden, and download as CSV written in the browser with `toCsv()` (a
byte-order mark so Arabic opens correctly; cells that would run as a formula
escaped). Amounts go through `formatAmount` and the decimal helpers in
`@integr8/core`, never a float; journal numbers, account codes and amounts are
`dir="ltr"`.

Routes: web `/ledger`, `/ledger/accounts`, `/ledger/journals`,
`/ledger/journals/new` (`?kind=opening` for the opening balances),
`/ledger/journals/[id]`, `/ledger/journals/[id]/edit`, `/ledger/unposted`,
`/ledger/unposted/[id]`, `/ledger/periods`, `/ledger/reports`,
`/ledger/settings`; desktop the same under `#/`.

### HR, expenses and payroll (H1)

Screens in `packages/operations-dom/src/hr/`, `expenses/` and `payroll/`, the
same on web and desktop. The people page offers the two new roles (HR manager
only to the owner) and shows grants as badges, with give and take back where
allowed. Employees: a list with search, status and department; a profile
with the ID, insurance and bank numbers as their last four and a Show button
per field (the full value kept only in that field's state, never cached);
the editor for a member or a standalone employee; ending and bringing back
employment; "My profile" for everyone; and, for `payroll.run`, a Pay section
with dated pay terms. Expenses: "My expenses", "Claims to approve" with the
waiting count, the claim form with receipts uploaded after the claim, a
claim's history and actions offered only when the server allows them, and
categories. Payroll: pay runs (prepare a month, edit lines inline while a
draft, recalculate, approve when somebody else prepared it, print payslips,
download the insurance report and bank file), payroll rules (start from the
2026 figures, edit bands, tiers and rates, owner confirms with a note) and
"My payslips". Payslips print one per page in English or Arabic (`lang` and
`dir` set) whatever the app's language. The accountant disclaimer is on every
payroll screen and payslip. The ledger settings gain the expense and payroll
posting switches.

On the phone (`apps/mobile/app/expenses/`): "My expenses" from the home
screen lists claims not yet fully sent (add a photo, or drop a refused one)
and recent claims when online; the claim form takes the date as Today,
Yesterday or typed, and receipts from the camera or library, all queued in
the outbox.

### Manufacturing (M1)

Screens in `packages/operations-dom/src/manufacturing/`: bills of materials
(list; an item's bill with components, costs when visible and the rolled-up
unit cost, versions and recent orders; the editor; retire), reachable from a
stock item's screen too; assembly orders (list with status and `AO-` search;
the new-order dialog for assembling or taking apart; the order with what it
needs against what is available, shortages marked "Short by …", a banner to
move a draft to the current bill, complete and cancel); and material planning
(run for a number of days; suggestions by level with build or buy, dates, a
"Late by N days" badge, lead time, supplier and what each rests on; choose
some and a location to draft orders, then follow the links). The item editor
gains a lead time.

## Follow-ups before the pilot (F2; ADR-0012)

No menu entries were added; the new screens hang off the screens they
belong to:

- **Pipelines** (`/crm/pipelines`, `/crm/pipelines/:id`), from the
  opportunity board and the CRM overview, for `crm.pipeline.manage`: stages
  added, edited, reordered with up/down buttons that keep focus and announce
  the new position, archived with a chooser for where their open deals go.
- **Customer 360**: on the customer screen, tabs for the timeline, quotes,
  sales orders, invoices (with the balance), payments and activities, each
  with its module and permission; arrow keys move between tabs and reverse
  in Arabic. The timeline loads more on demand and filters by source.
- **Reports** (`/crm/reports`) from the CRM overview; **Parts used**
  (`/inventory/parts-usage`) from the inventory overview. Tables, no
  charts; amounts per currency.
- **CSV exports** beside the lead list, the board, the recent and per-item
  stock movements and parts usage, for the managers of each area; a note
  when the file stops at 50,000 rows.
- **Inventory**: a "Customer's stock" badge and the ours/customer choice on
  site locations; an item's gallery (main image first, datasheets open in a
  new tab); "Supplier prices" on the item and a price list on the supplier;
  "Reorder" from a location and from the purchase orders
  (`/inventory/locations/:id/reorder`); the van request queue
  (`/inventory/van-requests`) from the inventory overview.
- **Sales**: "Deliver" on a confirmed order, its deliveries, and a printable
  delivery note (`/sales/orders/:orderId/deliveries/:deliveryId`) with a
  signature area and no prices.
- **Jobs**: "Bought for this job" in the parts section.
- **Payroll and manufacturing**: why approving is blocked, the HR key
  notice, the payslip's company block, shortages per item, drafted
  references linked, old bill versions (`/manufacturing/boms/versions/:id`).
- **The phone**: Home gains "My van" (offline: picture, on hand, reserved,
  available), "Receive goods" (scan against an approved order, online) and
  "My payslips" (online); "Refill my van" from My van (online only, with a
  "needs a connection" screen and nothing queued); "Bought from a merchant"
  on the job and the parts picker (offline, with a receipt photo).
- **Refusals** everywhere read from the error catalogue, in the reader's
  language; the server's English is never shown.

## Product gaps before the pilot (G1; ADR-0013)

Menu entries (`packages/core/src/navigation.ts`), in both apps:

| Entry         | Group     | Shown to                         | Route                     |
| ------------- | --------- | -------------------------------- | ------------------------- |
| Pipelines     | CRM       | `crm.pipeline.manage`            | `/crm/pipelines`          |
| Reports       | CRM       | `crm.read`                       | `/crm/reports`            |
| Parts used    | Inventory | `inventory.read`                 | `/inventory/parts-usage`  |
| Van requests  | Inventory | `inventory.move`                 | `/inventory/van-requests` |
| Serial lookup | Inventory | `inventory.read`                 | `/inventory/lots`         |
| Reorder       | Inventory | `purchasing.manage` (purchasing) | `/purchasing/reorder`     |

Reorder lists are per location, so the menu's Reorder opens a small page
asking which location, the same choice the purchase orders offer.

- **Company roles** (web, `/settings/people/roles`, from a card on People):
  the list with base, holders and an archived filter; the owner creates and
  changes roles with a checklist grouped by area against the base, an
  "adds / takes away" summary, and a warning that holders are signed out.
  Each People row has a picker with built-in and company roles; a refusal
  for a permission the giver lacks names it. Company role names show on the
  dashboard, the crew picker and the employee editor. Desktop has no people
  screen, so none.
- **Serial numbers and batches**: the item shows how it is tracked and its
  lots per location (expiry, an "Expired" badge), with "Track by serial
  number / batch" for `inventory.manage`. Every form that moves a tracked
  item asks for its lots: codes arriving (a row per serial, a paste or scan
  box that splits lines, batch expiry, a running total), a picker leaving
  (earliest expiry first, changeable; an expired batch needs a tick and a
  reason). Counts list each lot, with "Add a code". The serial lookup finds a
  code and its trace links to the job and the asset; the asset's history
  shows fitted serials; the delivery note lists serials and batches; the
  job's parts show their lots.
- **The phone**: the parts picker shows a tracked item's van lots with what
  is probably left; a serial item needs each serial ticked or scanned (a scan
  selects it when it is in the van); a batch proposes the earliest unexpired
  one or "any batch"; an expired batch needs a confirm and a note; all
  offline. The van screen shows lots.
- **The board**: cards drag between open stages (mouse after 8 px, touch
  after a 250 ms press, keyboard by a handle with arrows following the
  screen, so mirrored in Arabic) and move at once with Undo. Won and Lost are
  drop zones below the board for those who manage opportunities; dropping
  there opens the confirm (a reason for lost); the stage selector stays.
  Announcements are translated.
- **Value by stage** marks cells counting deals at the amount they had when
  the history began, with a note giving the day in the company's time zone.

## Translation keys

English and Arabic, same keys (the parity test fails otherwise):

- `nav.group.crm`, `nav.section.crm`, `nav.hint.crm`, `nav.section.leads`, `nav.hint.leads`
- `crm.overview.*`
- `crm.leads.*` (C1), `crm.status.*`, `crm.source.*`
- `crm.convert.*`, `crm.customer.*` (C2)
- `inventory.*` (`overview`, `kind`, `unit`, `locationKind`, `movement`, `items`, `locations`, `move`, `counts`), `nav.group.inventory`, `nav.section|hint.inventory|items|stockLocations` (E1)
- `purchasing.*` (`status`, `supplierStatus`, `suppliers`, `orders`, `receive`, `returns`), `nav.section|hint.suppliers|purchaseOrders` (E2).
- `inventory.parts.*`, `mobile.parts.*`, `mobile.change.partUsed` (E2, parts used on jobs). `purchasing.suppliers.leadTime` is plural (English `_one`/`_other`, Arabic six forms).
- `crm.stage.*`, `crm.opportunityStatus.*`, `crm.opportunityEvent.*`, `crm.opportunities.*`, `crm.activityKind.*`, `crm.activities.*`, `crm.dashboard.*`, `nav.section|hint.opportunities|activities` (C3). Counts use i18next plurals: English `_one`/`_other`, Arabic all six forms.
- `sales.*` (`status`, `orderStatus`, `quotes`, `orders`, `public`, `expired`), `nav.group.sales`, `nav.section|hint.quotes|salesOrders`, `inventory.items.reservedLine`, `inventory.overview.toOrder*` (S1).
- `finance.*` (`status`, `method`, `amounts`, `invoices`, `credit`, `document`, `payments`, `account`, `job`, `settings`), `nav.group.finance`, `nav.section|hint.invoices|payments` (B1).
- `assets.*` (`tags`, `status`, `condition`, `warranty`, `fields`, `events`, `entries`, `settings`, `alerts`; `photoCount` and `alerts.window` plural), `nav.section|hint.assets`, `mobile.assets.*` (`warrantySummary` plural), `mobile.change.assetRegistered|assetCondition|assetLinked`, `mobile.fill.start.carried`, `submissions.detail.forAsset|carriedOver`, `operations.workOrder.fillForAsset|noAsset`, `operations.imports.kinds.assets`, `forms.config.property.carryOver` (E3).
- `ledger.*` (`accountType`, `role`, `kind`, `source`, `reason`, `reasonHelp`, `aging`, `journalStatus`, `postingStatus`, `yearStatus`, `errors`, `home`, `setup`, `accounts`, `journals`, `lines`, `editor`, `journal`, `unposted`, `periods`, `reports`, `settings`), `nav.group.accounting`, `nav.section|hint.ledger|journals|ledgerReports` (A1).
- `hr.*`, `workspace.grant.*`, `workspace.role.hr_manager|inventory_manager`, `expenses.*`, `payroll.*`, `mobile.expenses.*`, `nav.group.hr`, `nav.section|hint.employees|myProfile|myExpenses|expenseClaims|payRuns|payrollRules|myPayslips`, ledger roles and sources for expenses, payroll and assembly (H1).
- `manufacturing.*`, `inventory.movement.assembly_consumption|assembly_output`, `nav.section|hint.boms|assemblyOrders|materialPlans` (M1).
- `apiErrors.*` — one message per API error code (`API_ERROR_CODES`);
  `crm.pipelines.*`, `crm.customer360.*`, `analytics.*`, new keys in
  `inventory`, `purchasing`, `sales`, `payroll`, `manufacturing`, and
  `mobile.*` for the van, refills, merchant parts, receiving, payslips and
  the phone's own refusals (F2).
- `errors.featureDisabled` — the web maps API code `feature_disabled` to it
  (`apps/web/src/lib/errors.ts`).

Layouts use logical properties only (`ps-`, `text-start`), enforced by lint, so
every CRM screen mirrors in Arabic.
