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
