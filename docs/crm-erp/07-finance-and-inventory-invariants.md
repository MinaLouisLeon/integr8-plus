# 07 — Inventory and purchasing invariants

The rules stock and purchasing keep, whatever the API or a screen does. Each
names where it is enforced. Built in E1 and E2; finance (B1, A1) adds to this
page when it starts.

## Quantities and money

| Rule                                                                                                       | Where                                              |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Quantities are `numeric(20,4)` and travel as decimal strings (`"2.5"`); never JavaScript numbers           | schema, zod `decimalQuantitySchema`, UI formatting |
| Money is `numeric(20,4)` decimal strings in the company currency; tax rates are basis points (1400 = 14 %) | schema, zod, SQL arithmetic                        |
| Totals, tax and averages are computed in SQL `numeric` and rounded half-up to 4 places once, at the end    | repositories                                       |

## Stock

| Rule                                                                                               | Where                                                                       |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| The ledger (`erp_stock_movements`) is append-only; corrections are compensating movements          | grants (no update/delete), trigger                                          |
| Balances are a projection of the ledger, written only by the ledger's trigger                      | no grant on `erp_stock_balances` for the app role; trigger                  |
| Stock never goes negative at any location                                                          | `check (on_hand >= 0)` on the balance, under the row lock the trigger takes |
| A transfer moves stock out of one place and into another in one transaction, with one `posting_id` | inventory service                                                           |
| A posting happens once per `source_key` (receipt line, transfer key, phone action id)              | unique index                                                                |
| Only `stock_item` items have stock; services and non-stock items never appear in the ledger        | trigger                                                                     |
| Replaying the ledger reproduces every balance exactly                                              | `reconcile`, tested over 100 000 movements                                  |
| A stock count posts its variances as `count_adjustment` movements naming who posted it             | count service, audit log                                                    |

## Cost

| Rule                                                                                                                                              | Where                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Each stock item has one **weighted average unit cost** for the company (all locations)                                                            | `erp_items.average_unit_cost`                              |
| Only a goods receipt changes it: `new = (on_hand × old + received × unit_cost) ÷ (on_hand + received)`, computed in SQL under the item's row lock | receipt service                                            |
| A part used on a job records the average at that moment as its unit cost; later receipts never change it                                          | `erp_work_order_materials.unit_cost`, movement `unit_cost` |
| Costs are shown to seats that move stock or purchase (owner, admin, dispatcher), not to engineers or viewers                                      | API bodies                                                 |
| Purchasing is in the company currency only in E2; multi-currency purchasing waits for a conversion rule (PLAN §5 ERP-01)                          | API validation                                             |

## Purchasing

| Rule                                                                                                                  | Where                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `draft → approved → partially_received → received`, or `cancelled` from any open status; what was received stays      | `purchasing.ts`, `erp_purchase_orders_status_known`, `_approved_pairing`, `_cancelled_pairing`                                  |
| Only owners and admins approve; approving is audited with who and when; an empty draft is not approved                | `purchasing.approve`, `approved_by/at`, audit `purchase_order.approved`                                                         |
| An approved order's lines never change; only what was received moves                                                  | trigger `erp_purchase_order_lines_guard` (`erp_purchase_order_lines_frozen`)                                                    |
| Goods are received only against an approved order, never more than ordered on a line                                  | 409 `order_not_receivable`; `erp_purchase_order_lines_received_range` (422 `over_received`)                                     |
| Each stock-item receipt line posts one `receipt` movement, once, at the price received, folding into the average cost | `source_key = receipt-line:<id>`; `applyReceiptCost` under the item's row lock                                                  |
| Returns to a supplier are `return_to_supplier` movements reversing the receipt movement, never more than received     | `reversal_of`; `erp_goods_receipt_lines_returned_range` (422 `over_returned`); 409 `insufficient_stock` when the goods are gone |
| References are `PO-000001` onwards per company, never reused, never shared by two drafts                              | `assign_purchase_order_reference()` locks the company's counter row                                                             |
| Line, tax and order totals are derived, never typed; tax is a rate in basis points per line                           | SQL in `orderLines` / `orderTotals`, `erp_purchase_order_lines_tax_range`                                                       |

## Parts used on jobs

| Rule                                                                                                                                                                      | Where                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| An engineer records parts only on jobs they are assigned to, from the van assigned to them; the office names any location                                                 | `requireWork`, `sourceLocation` in `materials.ts` (422 `no_van`, 403 another van, 422 `location_required`)                                    |
| A use posts a `consumption` movement once per action, or becomes a conflict when stock is short — never negative stock                                                    | `recordUse` under `lockBalance`; `source_key = phone:<client action id>`; `erp_work_order_materials_client_action_unique`; 0026 balance check |
| A conflict is resolved by people: the office retries (after correcting the van, or with another quantity or place) or anyone involved cancels; a retry may conflict again | `resolveUse`; audit `work_order.part_retried`, `part_cancelled`                                                                               |
| Returning an unused part posts a `consumption_return` against the use, never more than was used                                                                           | `returnUse`; `reversal_of`; `erp_work_order_materials_returned_range` (422 `over_returned`)                                                   |
| Non-stock items and services can be recorded on a job without touching stock                                                                                              | `recordUse`: `location_id` null, cost = the item's default cost, no movement                                                                  |
| A job's parts cost is the sum of posted uses net of returns at the cost when posted, summed in SQL                                                                        | `costForJob`; shown only to seats with `inventory.move` or `purchasing.manage`                                                                |
| The phone's van stock is a forecast — the server's count less the phone's own unsent uses — and says so                                                                   | `van_stock` table on the phone, `vanStock()` in `@integr8/offline`; `vanStock` on the first pull page                                         |
