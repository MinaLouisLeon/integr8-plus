# 06 — Navigation, languages and screens

## Navigation

`packages/core/src/navigation.ts` has a `crm` group, placed between Work and
Operations. A section can name a `feature`; `visibleNavigation(app,
permissions, features)` shows it only when the company has the module and the
seat holds the section's permission. Callers that pass no flags show no gated
section.

| Section key      | Group       | Permission        | Feature      | Web route               | Desktop route            | Phase |
| ---------------- | ----------- | ----------------- | ------------ | ----------------------- | ------------------------ | ----- |
| `crm`            | `crm`       | `crm.read`        | `crm`        | `/crm`                  | `#/crm`                  | F1    |
| `leads`          | `crm`       | `crm.read`        | `crm`        | `/crm/leads`            | `#/crm/leads`            | C1    |
| `opportunities`  | `crm`       | `crm.read`        | `crm`        | `/crm/opportunities`    | `#/crm/opportunities`    | C3    |
| `activities`     | `crm`       | `crm.read`        | `crm`        | `/crm/activities`       | `#/crm/activities`       | C3    |
| `inventory`      | `inventory` | `inventory.read`  | `inventory`  | `/inventory`            | `#/inventory`            | E1    |
| `items`          | `inventory` | `inventory.read`  | `inventory`  | `/inventory/items`      | `#/inventory/items`      | E1    |
| `stockLocations` | `inventory` | `inventory.read`  | `inventory`  | `/inventory/locations`  | `#/inventory/locations`  | E1    |
| `suppliers`      | `inventory` | `purchasing.read` | `purchasing` | `/purchasing/suppliers` | `#/purchasing/suppliers` | E2    |
| `purchaseOrders` | `inventory` | `purchasing.read` | `purchasing` | `/purchasing/orders`    | `#/purchasing/orders`    | E2    |

Web: `apps/web/src/lib/navigation.ts` (`NAV_PATHS`), menu in
`apps/web/src/components/workspace-shell.tsx`. Desktop:
`apps/desktop/src/lib/navigation.ts` (`NAV_ROUTES`, `desktopNavigation`), used
by the side menu and the dashboard cards.

## Screens

Shared screens live in `packages/operations-dom/src/crm/` and are mounted by
thin wrappers: `apps/web/src/app/(app)/crm/*` and
`apps/desktop/src/features/operations/screens.tsx` + `apps/desktop/src/App.tsx`.

| Screen                        | Component                 | Phase  | Notes                                                                                                                                                                                                                                                                                                                   |
| ----------------------------- | ------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CRM overview (dashboard)      | `CrmOverviewScreen`       | F1, C3 | Says plainly when the module is off or the seat may not read the CRM; otherwise the dashboard: open pipeline and weighted forecast per currency ("a forecast, not revenue"), won and lost in 30 days, follow-ups overdue / today / mine, open opportunities by stage, leads by status                                   |
| Leads                         | `LeadListScreen`          | C1     | Search, status, source and assignee filters (`me`, `none`), archived toggle, "show more" paging, new-lead dialog, right-click menu on desktop                                                                                                                                                                           |
| Lead                          | `LeadScreen`              | C1     | Details, edit form (sends only changed fields), quick status select, archive and restore, reload prompt on a version conflict, converted leads read-only with a link to the customer                                                                                                                                    |
| Convert a lead                | `LeadConvertScreen`       | C2     | Three steps: choose the customer (suggestions with reasons, search, or new — nothing preselected), choose the contact, review in plain words; then convert once. One idempotency key per distinct request, so a retry replays                                                                                           |
| Customer → CRM section        | `CustomerCrmSection`      | C2     | On the existing customer screen, only when the company has the CRM and the seat holds `crm.read`; lists the leads that became the customer                                                                                                                                                                              |
| Opportunities                 | `OpportunityBoardScreen`  | C3     | Board (a column per open stage) or list (any status); search and owner filters; each card moves with a **stage select** (keyboard-first; drag-and-drop is a follow-up) and losing asks for a reason in a dialog; new-opportunity dialog with a customer search; right-click menu on desktop                             |
| Opportunity                   | `OpportunityScreen`       | C3     | Details, stage select, edit (chance typed as a percentage, sent as basis points), archive, history in words ("Moved from New to Qualified"), activity panel, reload prompt on a version conflict                                                                                                                        |
| Follow-ups                    | `ActivitiesScreen`        | C3     | Tabs: overdue, today, upcoming, no date, done; "only mine"; mark done; links to each activity's records                                                                                                                                                                                                                 |
| Activity panel                | `ActivityPanel`           | C3     | On a lead, an opportunity and a customer: newest first, add a call, email, meeting, note, follow-up or task                                                                                                                                                                                                             |
| Lead (additions)              | `LeadScreen`              | C3     | The lead's opportunities with "New opportunity", and its activity panel                                                                                                                                                                                                                                                 |
| Customer → CRM (additions)    | `CustomerCrmSection`      | C3     | Opportunities, leads, "New opportunity", and the customer's activity panel                                                                                                                                                                                                                                              |
| Convert a lead (addition)     | `LeadConvertScreen`       | C3     | "Also open an opportunity", prefilled with the lead's company and carrying its estimate and currency                                                                                                                                                                                                                    |
| Inventory overview            | `InventoryOverviewScreen` | E1     | Items below their reorder level, the latest movements, "Move stock", and (manage) "Check the ledger"                                                                                                                                                                                                                    |
| Items                         | `ItemListScreen`          | E1     | Search, kind and category filters, archived toggle, stock everywhere per item, new-item dialog                                                                                                                                                                                                                          |
| Item                          | `ItemScreen`              | E1     | Details (costs only to seats that move stock), stock by location with reorder levels, movements, edit, archive, "Move stock"                                                                                                                                                                                            |
| Stock locations               | `LocationListScreen`      | E1     | Grouped warehouse / van / site; new warehouse or van with its engineer (site locations are made through the API for now)                                                                                                                                                                                                |
| Location                      | `LocationScreen`          | E1     | What it holds, who drives the van (reassign), stock counts, "Move stock", "Start a count", archive when empty                                                                                                                                                                                                           |
| Stock count                   | `StockCountScreen`        | E1     | Counted vs system per item, add items the location holds, post (confirm) or cancel                                                                                                                                                                                                                                      |
| Move stock dialog             | `MoveStockDialog`         | E1     | Receipt (priced), issue, transfer, correction; reason required where the API requires it; one idempotency key per request                                                                                                                                                                                               |
| Inventory overview (addition) | `InventoryOverviewScreen` | E2     | Cards for suppliers and purchase orders when the `purchasing` module is on and the seat may read it                                                                                                                                                                                                                     |
| Suppliers                     | `SupplierListScreen`      | E2     | Search, inactive toggle, lead time, new-supplier dialog (`SupplierFields`, shared with the supplier screen)                                                                                                                                                                                                             |
| Supplier                      | `SupplierScreen`          | E2     | Details and address, edit in place, make inactive or active, latest orders with totals, "New order" with the supplier fixed                                                                                                                                                                                             |
| Purchase orders               | `OrderListScreen`         | E2     | Search by reference or supplier, status filter, totals (to those who may see prices), new-order dialog with the line editor (`LinesEditor`: item picker, description, quantity, unit price, tax typed as a percentage and sent as basis points)                                                                         |
| Purchase order                | `OrderScreen`             | E2     | Reference and status, supplier link, expected date, delivery location, lines with received quantities and totals, edit the draft, approve (confirm), cancel (reason prompt), receipts with "Return to supplier", receive dialog (per line: arrived, unit cost), return dialog; one idempotency key per distinct request |

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

## Translation keys

English and Arabic, same keys (the parity test fails otherwise):

- `nav.group.crm`, `nav.section.crm`, `nav.hint.crm`, `nav.section.leads`, `nav.hint.leads`
- `crm.overview.*`
- `crm.leads.*` (C1), `crm.status.*`, `crm.source.*`
- `crm.convert.*`, `crm.customer.*` (C2)
- `inventory.*` (`overview`, `kind`, `unit`, `locationKind`, `movement`, `items`, `locations`, `move`, `counts`), `nav.group.inventory`, `nav.section|hint.inventory|items|stockLocations` (E1)
- `purchasing.*` (`status`, `supplierStatus`, `suppliers`, `orders`, `receive`, `returns`), `nav.section|hint.suppliers|purchaseOrders` (E2). `purchasing.suppliers.leadTime` is plural (English `_one`/`_other`, Arabic six forms).
- `crm.stage.*`, `crm.opportunityStatus.*`, `crm.opportunityEvent.*`, `crm.opportunities.*`, `crm.activityKind.*`, `crm.activities.*`, `crm.dashboard.*`, `nav.section|hint.opportunities|activities` (C3). Counts use i18next plurals: English `_one`/`_other`, Arabic all six forms.
- `errors.featureDisabled` — the web maps API code `feature_disabled` to it
  (`apps/web/src/lib/errors.ts`).

Layouts use logical properties only (`ps-`, `text-start`), enforced by lint, so
every CRM screen mirrors in Arabic.
