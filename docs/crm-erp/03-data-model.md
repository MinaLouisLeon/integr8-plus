# 03 — Data model

CRM and ERP tables, as built. Each section names the migration that created it.
Every table here is tenant-scoped: `tenant_id` with a foreign key to `tenants`,
row-level security keyed on `app_current_tenant_id()`, `tenant_id` inside every
foreign key to another tenant table, and an entry in `TENANT_SCOPED` in
`packages/db/src/schema.ts`. The schema-invariant suite fails if any of these is
missing.

## 0024 — CRM foundation (phase F1)

### Changes to existing tables

| Change                                                            | Why                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `feature_flags` row `crm` (`default_enabled = false`)             | The CRM module switch; Integr8 staff turn it on per company |
| `tenant_settings.currency` default `GBP` → `EGP`; every row → EGP | Product decision 2026-10-11; the CRM's default currency     |

The down migration restores the GBP default for new companies but leaves
existing companies on EGP, because their previous value was not recorded.

### `crm_leads`

A prospect that is not a customer yet. Converts once into a `customers` row
(ADR-0002). Archived (`archived_at`), never deleted: the runtime role has no
`delete` grant.

| Column                                                  | Notes                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `display_name`                                          | Required, 1–200 characters                                                      |
| `company_name`, `email`, `phone`                        | Optional; bounded lengths                                                       |
| `source`                                                | `manual`, `referral`, `web`, `import`, `other` (= `LEAD_SOURCES`)               |
| `status`                                                | `new`, `contacted`, `qualified`, `unqualified`, `converted` (= `LEAD_STATUSES`) |
| `assigned_to`                                           | A member: `(tenant_id, assigned_to) → tenant_users (tenant_id, user_id)`        |
| `estimated_value`, `currency_code`                      | `numeric(20,4)` ≥ 0, ISO 4217; a value needs a currency                         |
| `notes`, `unqualified_reason`                           | Free text, bounded                                                              |
| `converted_customer_id`, `converted_contact_id`         | `→ customers`, `→ customer_contacts` of **that** customer (composite keys)      |
| `converted_at`, `converted_by`                          | Set together with the customer; `status = 'converted'` exactly when they are    |
| `version`                                               | Optimistic concurrency; starts at 1                                             |
| `created_by`, `created_at`, `updated_at`, `archived_at` | As elsewhere; `updated_at` by trigger                                           |
| `email_normalized`, `phone_digits`, `search`            | Generated; for suggesting an existing customer and for search                   |

**Rules enforced by the database:**

- `crm_leads_converted_pairing`: converted ⇔ customer and time are set.
- `crm_leads_conversion_final` (trigger): a converted lead's status and
  conversion columns never change. Notes and archiving still can.
- Cross-company conversion is impossible: the customer and contact keys include
  `tenant_id`.

**Indexes:** status and date; assignee and status; normalized email and phone
digits (partial); converted customer (partial); GIN on `search`.

**Tests:** `packages/db/src/testing/crm-foundation.integration.test.ts`, plus the
schema-invariant suite (vocabulary, RLS, tenant keys) and the migration suite
(up, down, up).

### Repository (phase C1)

`CrmLeadsRepository` (`packages/db/src/repositories/crm-leads.ts`), reached as
`tx.crmLeads` inside `withTenant`. Every query filters on the tenant as well as
relying on RLS. `update` takes the expected `version` and returns
`'version_conflict'` instead of overwriting a newer row. `list` orders by
`created_at` truncated to milliseconds, then `id`, so the keyset cursor (which
carries a JavaScript date) never skips or repeats rows created in the same
millisecond. Phase C1 added no migration.

### Conversion (phase C2)

No migration: 0024 already holds the conversion columns, the pairing checks and
the trigger that makes a conversion final. The repository adds:

- `findForUpdate(id)` — `select … for update`, so two conversions of one lead
  run one after the other inside their transactions.
- `markConverted(id, expectedVersion, …)` — one statement that checks the
  version and that the lead is not converted yet, and writes the conversion.
- `customerMatches(lead)` — customers sharing the lead's normalised email,
  phone digits (on the customer or a current contact) or name. Customers have
  no normalised columns, so this compares expressions; fine at today's sizes,
  and an expression index is the follow-up if it is ever slow.
- `convertedInto(customerId)` — for the customer's CRM summary.

## 0025 — pipeline, opportunities and activities (phase C3)

### `crm_pipelines` and `crm_pipeline_stages`

A company's sales pipeline. The default one is made the first time the
company's CRM asks for it (`CrmPipelinesRepository.ensureDefault`), not by the
migration, so new and existing companies get it the same way; a unique index on
the default makes two first requests at once leave one.

| Stage key     | Outcome | Usual chance |
| ------------- | ------- | ------------ |
| `new`         | open    | 10 %         |
| `qualified`   | open    | 25 %         |
| `proposal`    | open    | 50 %         |
| `negotiation` | open    | 75 %         |
| `won`         | won     | 100 %        |
| `lost`        | lost    | 0 %          |

Keys are stable and never reused (unique per pipeline, `^[a-z][a-z0-9_]{0,39}$`);
screens translate the built-in ones (`crm.stage.<key>`). Stages are archived,
not deleted. Chances are whole **basis points** (0–10000), never fractions.
There is no screen for editing pipelines yet (follow-up).

### `crm_opportunities`

| Rule                                                                  | Enforced by                                         |
| --------------------------------------------------------------------- | --------------------------------------------------- |
| For a customer, a lead, or both — never neither                       | `crm_opportunities_has_party`                       |
| Customer, lead, owner and stage are this company's                    | composite tenant foreign keys                       |
| The stage is in the opportunity's own pipeline                        | FK on `(tenant_id, pipeline_id, stage_id)`          |
| `status` is always the stage's outcome                                | trigger `crm_opportunities_check_stage`             |
| Closed exactly when not open; a lost reason only when lost            | `closed_pairing`, `lost_reason` checks              |
| `amount` is `numeric(20,4)`, not negative; `currency_code` always set | checks; read as a decimal string                    |
| `expected_close_date` is a calendar `date`                            | read as `YYYY-MM-DD` text, so no time zone moves it |
| Archived, never deleted; edits name the `version` they read           | no delete grant; `version` column                   |

### `crm_opportunity_events`

Append-only (the runtime role has `select, insert` only): `created`,
`stage_changed`, `won`, `lost`, `reopened`, with from/to stage and status, the
reason for a loss, who and when. Written in the same transaction as the move.

### `crm_activities` and the link tables

`kind` is `call`, `email`, `meeting`, `note`, `follow_up` or `task`; `status` is
`open`, `done` or `cancelled`, and done exactly when `completed_at` and
`completed_by` are set. Links go through `crm_activity_leads`,
`crm_activity_customers` and `crm_activity_opportunities`, each with
same-company foreign keys at both ends, rather than a free-form related id. The
API requires at least one link. Links are written once (no update or delete
grant).

### Repositories

`tx.crmPipelines`, `tx.crmOpportunities` (create, update, `move` with its
history entry, `attachCustomerForLead` for conversion, list, events),
`tx.crmActivities` (create with links, update, list in "due" or "recent" order
with millisecond keyset cursors, counts for the dashboard) and `tx.crmReports`
(the dashboard: sums in SQL as `numeric`, one total per currency, weighted by
`probability_bp / 10000`). "Today" and "overdue" are computed in the company's
time zone (`tenant_settings.timezone`).

### Company data export

All CRM tables (0024 and 0025) are in `EXPORTED_TABLES`
(`packages/db/src/repositories/tenant-data-export.ts`): a company's prospects,
deals and follow-ups are its own data. `crm_leads` was missing from the export
after F1; C3 added it with the rest.

## 0026 — the catalogue and the stock ledger (phase E1)

Two module switches in `feature_flags`, both `default_enabled = false`:
`inventory` and `purchasing`.

### `erp_item_categories` and `erp_items`

An item is a `stock_item` (counted, in the ledger), a `non_stock_item` (bought
or used, never counted) or a `service`. SKU and barcode are unique per company
(case-insensitive SKU). Units are the fixed list `UNITS` in `@integr8/core`.
Costs and prices are `numeric(20,4)`; `average_unit_cost` is the company's
weighted average for the item, written only by a priced receipt
(`applyReceiptCost`, under the item's row lock). Items are archived, never
deleted. Edits name their `version`.

### `erp_stock_locations`

`warehouse`, `van` or `site`. A van has at most one engineer and an engineer at
most one live van (unique index); a site location names one of the company's
customer sites. Archived, not deleted, and only when empty (API rule).

### `erp_stock_movements` — the ledger (ADR-0003)

| Column / rule    | Meaning                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `posting_id`     | Movements written together: a transfer's two halves, a count's variances                                                                                                                                                 |
| `kind`           | One of `MOVEMENT_KINDS`; the sign of `quantity` must match (`erp_stock_movements_quantity_signed`)                                                                                                                       |
| `quantity`       | Signed `numeric(20,4)`, never zero                                                                                                                                                                                       |
| `unit_cost`      | The cost of one unit when it moved; shown only to seats with `inventory.move`                                                                                                                                            |
| `source_key`     | Unique per company: `manual:<idempotency key>`, `count:<count>:<item>`, later `receipt-line:<id>`, `phone:<action id>`                                                                                                   |
| `reversal_of`    | The movement this one corrects                                                                                                                                                                                           |
| Append-only      | `select, insert` grants only; trigger `erp_stock_movements_no_delete` refuses update and delete for every role. `purge_tenant()` (0015, replaced here) lifts it for a due company deletion, as it does for the audit log |
| Stock items only | The balance trigger refuses a movement of a service or non-stock item                                                                                                                                                    |

### `erp_stock_balances` — the projection

One row per company, item and location. The runtime role may only `select` it.
`erp_stock_apply_movement()` (security definer, pinned `search_path`) runs
after every insert into the ledger: it updates the balance row (inserting it on
the item's first movement there), which takes the row lock, so concurrent
movements of one item at one place apply one after the other.
`check (on_hand >= 0)` refuses the one that would go below zero, and the
movement rolls back with it. (An `insert … on conflict do update` would not do:
Postgres checks the constraint on the row it would insert before it finds the
conflict.) `erp_stock_lock_balance(tenant, item, location)` (security definer)
locks and reads a balance for the caller's own company, for a count or a use
that must read a stable figure before posting. `reconcile()` replays the ledger
and lists every balance that disagrees — tested over 100 000 movements.

### `erp_reorder_levels`, `erp_stock_counts`, `erp_stock_count_lines`

A reorder level is a minimum per item and location. A count is a draft until
posted: posting locks each line's balance, records it as `expected_quantity`,
and posts the difference as a `count_adjustment` naming who posted it; a count
is posted once (`not_draft` afterwards) or cancelled.

### Company data export

Every inventory table but `erp_stock_balances` (derived from the exported
ledger) is in `EXPORTED_TABLES`.

## 0027 — suppliers, purchase orders and goods receipts (phase E2, first half)

### `erp_suppliers`

Name unique per company (case-insensitive), contact, email, phone, tax
reference, payment terms, lead time, address, `active` or `inactive`, notes,
`version`. Never deleted: an inactive supplier stays on every order it
supplied. `erp_items` gains `preferred_supplier_id` (tenant composite FK) and
`supplier_part_number`.

### `erp_purchase_orders` and `erp_purchase_order_lines`

| Column / rule   | Meaning                                                                                                                                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `reference`     | `PO-000001` onwards per company, assigned by the trigger `assign_purchase_order_reference()` (security definer) from `erp_purchase_order_counters`, which locks the company's counter row so two drafts never share a number                     |
| `supplier_name` | A snapshot at the time of the order; the supplier may be renamed later                                                                                                                                                                           |
| `status`        | `draft → approved → partially_received → received`, or `cancelled` from any open status; `erp_purchase_orders_approved_pairing` and `_cancelled_pairing` keep `approved_by/at` and `cancelled_by/at` together with the status                    |
| `currency_code` | The company currency when drafted; one currency per order                                                                                                                                                                                        |
| Lines           | `position` unique per order, item (tenant FK), `description` (defaults to the item name), `quantity_ordered > 0`, `quantity_received` between 0 and ordered (`erp_purchase_order_lines_received_range`), `unit_price ≥ 0`, `tax_rate_bp` 0–10000 |
| Lines frozen    | Trigger `erp_purchase_order_lines_guard`: once the order is not a draft, no line is inserted, deleted or changed except `quantity_received` (error names constraint `erp_purchase_order_lines_frozen`)                                           |
| Totals          | Derived in SQL (`orderLines`, `orderTotals`): `subtotal = round(quantity × price, 4)`, `tax = round(subtotal × bp / 10000, 4)`; never typed, never floats                                                                                        |

### `erp_goods_receipts` and `erp_goods_receipt_lines`

A receipt names the order, the location the goods went into, the supplier's
delivery note, who received it and when. Each receipt line names an order
line, `quantity > 0`, the `unit_cost` received at, and `returned_quantity`
between 0 and `quantity` (`erp_goods_receipt_lines_returned_range`). Receipts
are `select, insert` only; receipt lines may also be updated (returns). A
stock item's receipt line posts one `receipt` movement with
`source_key = receipt-line:<id>`; a return posts a `return_to_supplier`
movement with `reversal_of` the receipt movement and
`source_key = return:<idempotency key>:<receipt line>`. Services and non-stock
items are recorded as received without touching the ledger.

### Company data export

`erp_suppliers`, `erp_purchase_orders`, `erp_purchase_order_lines`,
`erp_goods_receipts` and `erp_goods_receipt_lines` are in `EXPORTED_TABLES`;
the counter table is derived and not exported.

## 0028 — parts used on jobs (phase E2, second half; ADR-0005)

### `erp_work_order_materials`

| Column / rule                             | Meaning                                                                                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `work_order_id`, `item_id`, `location_id` | Tenant composite FKs to the job, the item and the van or store it came from; `location_id` is null for a service or non-stock item, which is recorded without touching stock                                                                     |
| `quantity`, `returned_quantity`           | `numeric(20,4)`; `quantity > 0`, `0 ≤ returned ≤ quantity` (`erp_work_order_materials_returned_range`)                                                                                                                                           |
| `unit_cost`                               | The item's average cost at the moment the use posted (the default cost for a non-stock item); null while a use is a conflict                                                                                                                     |
| `status`                                  | `posted`, `conflict` or `cancelled` (`erp_work_order_materials_status_known`); a conflict carries `available_quantity` — what the location held (`_conflict_shape`); cancelling records who and when (`_cancelled_pairing`)                      |
| `client_action_id`                        | The phone's own id for the action, unique per company (partial unique index): the same action arriving again, under any change id, finds the first record                                                                                        |
| `occurred_at`                             | When the engineer did it, by the phone's clock as the server reads it; `recorded_at` is when the server wrote it                                                                                                                                 |
| Ledger                                    | A posted stock-item use is one `consumption` movement, `source_key = phone:<client action id>` or `material:<id>`; a return is a `consumption_return` with `reversal_of` the use's movement and `source_key = material-return:<idempotency key>` |
| Sync                                      | `erp_work_order_materials_touch_sync` marks the job changed (0011), so the next pull brings the use and its status to the phone                                                                                                                  |

Grants: `select, insert, update` (a use is cancelled or returned, never deleted).
In `EXPORTED_TABLES`.

## 0029 — quotes and sales orders (phase S1; ADR-0006)

Adds the `sales` feature flag. Money and quantities are `numeric(20,4)`; a discount or tax rate is a whole number of basis points (`0..10000`). Every total is computed in SQL from the lines (`LINE_MATH` in `sales-quotes.ts`: gross, discount, net and tax rounded half-up to four places once per line) and never stored or typed.

### `sales_document_counters`

| Column / rule              | Meaning                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `(tenant_id, kind)`        | One counter per company per document kind (`quote`, `sales_order`), so quotes and orders are numbered apart                                                                                                         |
| `assign_sales_reference()` | Security-definer `before insert` trigger (`tg_argv[0]` names the kind) that locks the company's counter row and hands out `QT-000001` / `SO-000001` onwards, never reused; the runtime role may only read the table |

### `crm_quotes`

| Column / rule                                                                                                                   | Meaning                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reference`, `revision`                                                                                                         | `QT-000123`, and `-R2` onwards when revised; unique per company                                                                                                                                                   |
| `customer_id`, `site_id`, `contact_id`, `opportunity_id`                                                                        | Tenant composite FKs; site, contact and opportunity must belong to the customer (checked by the route)                                                                                                            |
| `status`                                                                                                                        | `draft`, `issued`, `accepted`, `rejected`, `converted`, `cancelled` (`crm_quotes_status_known`; vocabulary checked against `@integr8/core` by the invariant suite)                                                |
| `title`, `currency_code`, `valid_until`, `introduction`, `terms`, `internal_notes`                                              | The document; `internal_notes` is never sent to the customer and is null in bodies to seats without `sales.manage`                                                                                                |
| `customer_name`, `customer_address` (jsonb), `contact_*`                                                                        | The customer as the issued quote names them, copied on issue and cleared on revision                                                                                                                              |
| `issued_by/at`, `answered_at/by/via/name/from`, `rejection_reason`, `converted_order_id/at`, `cancelled_by/at`, `cancel_reason` | Bookkeeping, each pair kept consistent with the status by `crm_quotes_issued_pairing`, `_answered_pairing`, `_converted_pairing`, `_cancelled_pairing` (a quote cannot be converted without having been accepted) |
| `access_token_hash`                                                                                                             | SHA-256 of the customer's link token; the token itself is never stored. Globally unique while live (`crm_quotes_token_unique`, partial), null once answered, revised or cancelled                                 |
| `version`                                                                                                                       | Optimistic concurrency; every write bumps it                                                                                                                                                                      |

### `crm_quote_lines`

| Column / rule                                                                         | Meaning                                                                                            |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `quote_id`, `position`                                                                | Unique per quote; lines are rewritten as a set while a draft                                       |
| `item_id`                                                                             | Optional catalogue item (tenant FK); a line without one is written by hand and needs a description |
| `description`, `quantity > 0`, `unit`, `unit_price ≥ 0`, `discount_bp`, `tax_rate_bp` | What is offered; defaults from the item's name, unit and sale price                                |
| Trigger `crm_quote_lines_guard`                                                       | Lines insert, update or delete only while the quote is a draft (`crm_quote_lines_frozen`)          |

### `erp_sales_orders` and `erp_sales_order_lines`

| Column / rule                                                         | Meaning                                                                                                                                                                                                                       |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reference`                                                           | `SO-000123`, from the `sales_order` counter                                                                                                                                                                                   |
| `quote_id`                                                            | The quote this came from, if any; **one order per quote, ever** (`erp_sales_orders_quote_unique`); `crm_quotes.converted_order_id` points back (FK added after the table)                                                     |
| `status`                                                              | `draft`, `confirmed`, `partially_fulfilled`, `fulfilled`, `cancelled` (`erp_sales_orders_status_known`)                                                                                                                       |
| `reserve_location_id`                                                 | Where stock lines were held when confirmed or last re-reserved                                                                                                                                                                |
| `customer_name`, `customer_address`                                   | Copied when confirmed (`erp_sales_orders_confirmed_pairing`)                                                                                                                                                                  |
| `confirmed_by/at`, `fulfilled_at`, `cancelled_by/at`, `cancel_reason` | Pairings `_confirmed_pairing`, `_fulfilled_pairing`, `_cancelled_pairing`                                                                                                                                                     |
| Line `quantity_reserved`                                              | Held for the line while the order is open; `0 ≤ reserved ≤ quantity`, and a reservation names a location (`erp_sales_order_lines_reserved_range`, `_reserved_placed`). A soft promise: on-hand is untouched (ADR-0003, -0006) |
| Line `quantity_fulfilled`                                             | Delivered: parts used on linked jobs for stock items; the linked job completing for everything else; `≤ quantity` (`_fulfilled_range`)                                                                                        |
| Trigger `erp_sales_order_lines_guard`                                 | Once the order is not a draft, only `quantity_reserved`, `reserve_location_id` and `quantity_fulfilled` may change (`erp_sales_order_lines_frozen`)                                                                           |
| Index `erp_sales_order_lines_reserved`                                | `(item_id, reserve_location_id) where quantity_reserved > 0`: read for every balance shown                                                                                                                                    |

### `erp_sales_order_work_orders`

The jobs that deliver an order: `(tenant_id, order_id, work_order_id)` primary key, `linked_by/at`. Zero or many per order, linked or created on purpose; nothing links on its own. Deleted with the order; a job cannot be deleted while linked.

### Repositories

`SalesQuotesRepository` (`tx.salesQuotes`): create, find, lock, list (reference or words of the title and customer), lines and totals, `updateDraft`, `issue` (snapshot + token hash), `revise`, `answer`, `markConverted`, `cancel`. `SalesOrdersRepository` (`tx.salesOrders`): the same for orders plus `confirm`, `reserve` (releases, then holds per stock line what is due or what the location has left after every other reservation there, under `erp_stock_lock_balance`), `release`, `reservedElsewhere`, `reservations`, `consume`, `fulfilNonStockLines`, `refreshStatus`, `shortLines`, and the work-order links. `PublicQuotesLookup` (platform connection) finds the company and quote a token hash names. Shared helpers: `toLine`, `documentTotals`, `addDecimals` (BigInt, four places, no float).

### Company data export

All six tables are in `EXPORTED_TABLES`. Grants: `select, insert, update` on quotes and orders (never deleted), `select, insert, update, delete` on lines (rewritten while a draft), `select, insert, delete` on the job links, `select` on the counters.

## 0030 — invoices, credit notes and payments (phase B1; ADR-0007)

Adds the `finance` feature flag. Money is `numeric(20,4)`; every total is computed in SQL from the lines (the same `LINE_MATH` as quotes, and `erp_line_total()` for the guards), never stored or typed. An invoice's status is stored as `draft`, `issued` or `void`; what the screens show (`partially_paid`, `paid`, `credited`) is derived from the payments allocated and the issued credit notes (`invoiceStatus()` in `@integr8/core`). Balance = total − active allocations − issued credit notes (`erp_invoice_balance()`).

### `erp_finance_settings`

One row per company (`tenant_id` primary key): `legal_name`, `address`, `tax_reference`, `payment_instructions`, `footer` (the issuer block, printed as typed), `default_due_days` (`0..365`, default 30), and the optional `labour_hourly_cost` (job profitability) and `labour_hourly_rate` (the labour line of an invoice made from a job), both `≥ 0`. `version` for optimistic concurrency; the first save is `expectedVersion: 0`.

### `finance_document_counters` and `assign_finance_reference()`

One counter per company per kind (`invoice`, `credit_note`, `payment`). The security-definer trigger numbers an invoice or credit note **when it is issued** (a draft has no number, so a discarded draft leaves no gap) and a receipt when it is recorded: `INV-000001`, `CN-000001`, `RC-000001` onwards, never reused. A number, once given, never changes (`finance_reference_fixed`). The runtime role may only read the counters.

### `erp_invoices` and `erp_invoice_lines`

| Column / rule                                                       | Meaning                                                                                                                                                                 |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `customer_id`, `site_id`, `contact_id`                              | Tenant composite FKs; site and contact must belong to the customer (checked by the route)                                                                               |
| `sales_order_id`, `work_order_id`                                   | The order or job it bills, if any; never both (`erp_invoices_one_source`)                                                                                               |
| `status`                                                            | `draft`, `issued`, `void` (`erp_invoices_status_known`, checked against `@integr8/core` by the invariant suite)                                                         |
| `issue_date`, `due_date`                                            | In the company's calendar; due never before issue (`erp_invoices_dates_ordered`)                                                                                        |
| `customer_name`, `customer_address`, `contact_name/email`, `issuer` | Copied when issued: the customer as billed and the company's settings as the issuer block (`erp_invoices_issued_pairing`)                                               |
| `voided_by/at`, `void_reason`                                       | `erp_invoices_void_pairing`                                                                                                                                             |
| Trigger `erp_invoices_guard`                                        | An issued or void invoice never changes except to be voided (`erp_invoices_frozen`); voiding is refused once anything is paid or credited (`erp_invoices_void_settled`) |
| Line `sales_order_line_id`, `work_order_material_id`                | The order line or the part used that a line bills; the routes refuse to bill more than was ordered, delivered or used, across every invoice that is not void            |
| Trigger `erp_invoice_lines_guard`                                   | Lines change only while the invoice is a draft (`erp_invoice_lines_frozen`)                                                                                             |

### `erp_credit_notes` and `erp_credit_note_lines`

A credit note reduces one issued invoice: `status` `draft` or `issued`, a `reason`, lines that may name the invoice line they credit (`invoice_line_id`). Guard `erp_credit_notes_guard`: frozen once issued (`erp_credit_notes_frozen`), only against an issued invoice (`erp_credit_notes_invoice_not_open`), never empty (`_empty`), never more than the invoice still owes (`_over_balance`, checked under a lock of the invoice). Lines change only while a draft (`erp_credit_note_lines_guard`).

### `erp_payment_receipts` and `erp_payment_allocations`

| Column / rule                                   | Meaning                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Receipt `received_on`, `amount > 0`, `method`   | Money received, recorded by hand: `cash`, `bank_transfer`, `other` (`erp_payment_receipts_method_known`); `payment_reference` is the bank's; the runtime role may only insert and read receipts — a receipt is never edited or deleted                                                                                     |
| Allocation `receipt_id`, `invoice_id`, `amount` | Part of a receipt put against one invoice of the same customer and currency                                                                                                                                                                                                                                                |
| `removed_by/at`                                 | A wrong allocation is removed, not edited or deleted (`erp_payment_allocations_removed_pairing`); its money returns to the customer's account                                                                                                                                                                              |
| Trigger `erp_payment_allocations_guard`         | Security definer; locks the receipt and the invoice, then refuses an allocation that is not to an issued invoice (`_invoice_not_open`), to another customer or currency (`_mismatch`), over what the receipt has left (`_over_receipt`) or the invoice owes (`_over_invoice`); only `removed_by/at` may change (`_frozen`) |

What a receipt has not allocated stays **on the customer's account**; `customerAccount()` sums, per currency, what issued invoices owe and what receipts have left.

### Purge

`integr8_purging(tenant)` is true only while `purge_tenant` runs for that company and the session is not the runtime role. The S1 line guards and every B1 guard allow deletes only then, so a company with issued documents can still be purged and the app role cannot fake the marker. (This also fixes a latent S1 bug: its line guards blocked purging a company with confirmed orders.)

### Repositories

`FinanceInvoicesRepository` (`tx.financeInvoices`): settings, create, find, lock, list (reference, customer words, derived status, overdue, order or job), lines and totals, amounts, `updateDraft`, `discardDraft`, `issue`, `voidInvoice`, what an order's lines and a job's parts already bill, `lockSource` (an advisory lock per order or job, so two drafts never bill the same thing), and the same for credit notes. `FinancePaymentsRepository` (`tx.financePayments`): `recordReceipt`, find, list, amounts, `allocate`, `removeAllocation`, allocations by receipt or invoice, `customerAccount`.

### Company data export

All seven company tables are in `EXPORTED_TABLES`. Grants: `select, insert, update` on settings; `select, insert, update, delete` on invoices, credit notes and their lines (drafts are discarded; the guards refuse anything else); `select, insert` on receipts; `select, insert, update` on allocations; `select` on the counters.
