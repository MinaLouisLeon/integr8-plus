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

## Quotes and sales orders (ADR-0006)

| Rule                                                                                                                                                            | Where                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Line and document totals are derived in SQL, never typed; discount and tax are basis points per line; gross, discount, net and tax round once to four places    | `LINE_MATH`, `documentTotals` in `sales-quotes.ts`; `addDecimals` (BigInt) for net + tax; `crm_quote_lines_discount_range`, `_tax_range`                       |
| References are `QT-000001` / `SO-000001` onwards per company, never reused, quotes and orders apart                                                             | `assign_sales_reference('quote' / 'sales_order')` locks the company's counter row                                                                              |
| An issued quote's lines and customer never change; a revision is a new draft under the same reference                                                           | trigger `crm_quote_lines_guard` (`crm_quote_lines_frozen`); `revise` clears the snapshot and the token                                                         |
| One answer per quote; an answered quote's link is spent; a revised or cancelled quote's link dies                                                               | `crm_quotes_answered_pairing`; `access_token_hash` set null on answer, revision and cancel; `crm_quotes_token_unique`                                          |
| A quote is converted exactly once, and only when accepted                                                                                                       | `lockQuote` + 409 `quote_not_accepted` / `quote_converted`; `erp_sales_orders_quote_unique`; `crm_quotes_converted_pairing` requires an answer                 |
| A confirmed order's lines never change; only what is reserved and delivered moves                                                                               | trigger `erp_sales_order_lines_guard` (`erp_sales_order_lines_frozen`)                                                                                         |
| A reservation is a promise on the line, not a movement: on-hand is never touched by confirming, reserving, cancelling or fulfilling                             | `quantity_reserved` on `erp_sales_order_lines`; no ledger write in `reserve` / `release`                                                                       |
| No location promises more than it holds: each line holds `min(due, held − reserved by every other line there)`, never below zero, under the balance lock        | `reserve` in `sales-orders.ts` (`erp_stock_lock_balance`, then one SQL update per line)                                                                        |
| Available = on hand − reserved, never shown below zero; a part used on a job sees only what is available to it (its own orders' reservations are its own)       | `availability` in `inventory.ts`; `availableForJob` in `sales-fulfilment.ts`; `recordUse` refuses beyond it as a `conflict` with `availableQuantity`           |
| A part used on a linked job delivers the order's lines for the item, oldest link first, and releases the reservation it fulfils; never more than the line asked | `consume` (per line: `take = min(remaining, quantity − fulfilled)`, `reserved = min(reserved, quantity − fulfilled)`); `erp_sales_order_lines_fulfilled_range` |
| A linked job completing delivers every line that is not stock; the order's status follows its lines; a fulfilled order holds nothing                            | `deliverOnCompletion`, `fulfilNonStockLines`, `refreshStatus` (then `release`); `erp_sales_orders_fulfilled_pairing`                                           |
| Cancelling releases everything the order held; a shortfall is `quantity − reserved − fulfilled`, flagged "to order" on the order and the inventory overview     | `cancel` → `release`; `shortLines`; `GET /v1/sales/to-order`                                                                                                   |
| The customer's token is never stored, logged or shown twice; only its SHA-256 is kept                                                                           | `mintToken` / `hashToken` in `sales-quotes.ts`; the `issue` response is the only place it appears                                                              |
