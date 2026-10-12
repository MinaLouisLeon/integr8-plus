# 04 — API contracts

CRM and ERP routes, as built. The OpenAPI document (`apps/api/openapi.json`,
emitted by `pnpm --filter @integr8/api openapi`) is the contract; the generated
client (`packages/api-client/src/generated/schema.ts`) follows it. This page says
what each route is for and what it promises beyond its schema.

Common to every CRM route:

- Signed in (`security: 'authenticated'`), a permission (see
  [05](./05-permissions-and-security.md)), and the `crm` module on
  (`feature: 'crm'`). In that order: a seat without the permission gets 403
  `forbidden` even when the module is off; a seat with it gets 403
  `feature_disabled` while the module is off.
- Errors use the platform shape `{ error: { code, message, details, requestId } }`.
- Money is a decimal **string** (`"1250.5"`), at most 16 digits before the point
  and 4 after. A JSON number is refused (422), so nothing rounds an amount
  through a float. Amounts come back without trailing zeros (`"99.9900"` →
  `"99.99"`).
- Lists are newest first, paged with an opaque `cursor` and `nextCursor`
  (keyset, never offset), `limit` 1–100 (default 50).
- Every change writes an audit entry; when Integr8 staff act as the company,
  the entry's metadata carries `impersonatedBy`.

## Leads (phase C1)

Source: `apps/api/src/routes/v1/crm.ts`. Tests:
`apps/api/src/routes/v1/crm-leads.integration.test.ts`.

| Method and path                | Permission        | What it does                                                   |
| ------------------------------ | ----------------- | -------------------------------------------------------------- |
| `GET /v1/crm/leads`            | `crm.read`        | List, filter and page leads                                    |
| `POST /v1/crm/leads`           | `crm.lead.manage` | Add a lead (`Idempotency-Key` honoured)                        |
| `GET /v1/crm/leads/{leadId}`   | `crm.read`        | One lead, with `can: { edit, convert }` for the seat           |
| `PATCH /v1/crm/leads/{leadId}` | `crm.lead.manage` | Change, assign, qualify, archive or restore, against a version |

### List filters

| Query             | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `q`               | Words in the name, company, email or phone (case-insensitive)  |
| `status`          | One or more statuses (repeat the parameter)                    |
| `source`          | One or more sources                                            |
| `assignedTo`      | A member's id, `me` (the caller) or `none` (unassigned)        |
| `includeArchived` | `true` to include archived leads; they are left out by default |
| `cursor`, `limit` | Paging                                                         |

### Rules the routes enforce

| Rule                                                                                    | Refusal                        |
| --------------------------------------------------------------------------------------- | ------------------------------ |
| `converted` is reached only by converting (C2), never by create or edit                 | 422 (schema)                   |
| A converted lead keeps its details; only notes, the assignee and archiving change       | 409 `lead_already_converted`   |
| Open statuses (`new`, `contacted`, `qualified`, `unqualified`) move freely between them | 422 `invalid_transition` other |
| The assignee must be an active member of the company                                    | 422 `assignee_not_member`      |
| An edit names the `expectedVersion` it read; a newer version wins                       | 409 `version_conflict`         |
| A value always has a currency: the company's (EGP by default) when none is given        | —                              |
| A lead in another company does not exist                                                | 404 `not_found`                |
| Unknown fields in an edit                                                               | 422 (strict schema)            |

Creating a lead never creates a customer (ADR-0002).

### Audit actions

`crm_lead.created`, `crm_lead.updated` (with the changed field names and the
new version), `crm_lead.status_changed` (from, to), `crm_lead.archived`,
`crm_lead.restored`. Resource type `crm_lead`.

## Converting a lead (phase C2)

Source: `apps/api/src/routes/v1/crm.ts`. Tests:
`apps/api/src/routes/v1/crm-conversion.integration.test.ts`. Decision:
[ADR-0002](./decisions/) — `customers` stays the only customer record.

| Method and path                       | Permission         | What it does                                                        |
| ------------------------------------- | ------------------ | ------------------------------------------------------------------- |
| `GET /v1/crm/leads/{leadId}/matches`  | `crm.lead.convert` | Up to ten existing customers that look like the lead, with reasons  |
| `POST /v1/crm/leads/{leadId}/convert` | `crm.lead.convert` | Convert, in one transaction; **`Idempotency-Key` required**         |
| `GET /v1/customers/{customerId}/crm`  | `crm.read`         | The customer's CRM summary: the leads that became it (C3 adds more) |

### Matches

Suggestions only; nothing is merged. A customer matches on the **email**
(trimmed, case-insensitive), the **phone** (digits only, at least seven), on
the customer itself or one of its current contacts, or on the **name** (the
lead's company or the lead's own name, case-insensitive).

### Convert request

```json
{
  "expectedVersion": 2,
  "customer": { "mode": "existing", "customerId": "UUID" },
  "contact": { "mode": "existing", "contactId": "UUID" }
}
```

- `customer`: `{ "mode": "existing", "customerId" }` or
  `{ "mode": "new", "name", "accountNumber?", "email?", "phone?" }`.
- `contact` (optional, default none): `{ "mode": "none" }`,
  `{ "mode": "existing", "contactId" }` (one of the chosen customer's current
  contacts), or `{ "mode": "new", "name", "jobTitle?", "email?", "phone?",
"isPrimary?" }`.
- Response 201: `{ lead, customerId, contactId, customerCreated, contactCreated }`.
- The plan's optional opportunity on conversion arrives with opportunities in C3.

### Convert rules

| Rule                                                                                         | Refusal                                                 |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| The request carries an `Idempotency-Key`                                                     | 400 `idempotency_key_required`                          |
| The same key and body again returns the first response (`idempotent-replay: true`)           | —                                                       |
| The same key with a different body                                                           | 409 `idempotency_key_reused`                            |
| A lead converts once, whatever the key; concurrent conversions serialise on a row lock       | 409 `lead_already_converted`                            |
| The lead is still at `expectedVersion`                                                       | 409 `version_conflict`                                  |
| The lead is open (`new`, `contacted`, `qualified`) and not archived                          | 422 `lead_not_convertible`                              |
| An existing customer is in this company (another company's id reads as missing)              | 404 `customer_not_found`                                |
| An existing customer is not closed                                                           | 422 `customer_closed`                                   |
| A kept contact belongs to the chosen customer                                                | 422 `contact_not_found`                                 |
| A new contact does not repeat an existing contact's email or phone on that customer          | 409 `duplicate_contact` (`details[0].params.contactId`) |
| A new customer's account number is free                                                      | 422 `account_number_taken`                              |
| Creating a customer also needs `customer.manage` (every role with `crm.lead.convert` has it) | 403 `forbidden`                                         |

Linking an existing customer never changes the customer's own details. Any
refusal rolls the whole conversion back: no customer, contact or lead change
survives a failed request.

### Audit actions

`crm_lead.converted` (customer, contact, whether each was created, the status
converted from) on the lead, and `customer.created` (with `fromLead`) when a
customer was created. Both carry `impersonatedBy` when Integr8 staff acted.

### Required idempotency

`idempotent: 'required'` on a route (`apps/api/src/http/routes.ts`) makes the
server refuse a request without the header before running it, and marks the
header `required` in OpenAPI. Converting is the first route to use it.

## Opportunities and the pipeline (phase C3)

Source: `apps/api/src/routes/v1/crm-opportunities.ts`. Tests:
`apps/api/src/routes/v1/crm-pipeline.integration.test.ts`.

| Method and path                               | Permission               | What it does                                                                                              |
| --------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `GET /v1/crm/pipelines`                       | `crm.read`               | Pipelines and stages, the default first (made on first use)                                               |
| `GET /v1/crm/opportunities`                   | `crm.read`               | `q`, `status`, `stageId`, `ownerId` (id, `me`, `none`), `customerId`, `leadId`, `includeArchived`, cursor |
| `POST /v1/crm/opportunities`                  | `crm.opportunity.manage` | Open one (`Idempotency-Key` honoured)                                                                     |
| `GET /v1/crm/opportunities/{id}`              | `crm.read`               | The opportunity, its history (newest first), its pipeline's stages, `can.edit`                            |
| `PATCH /v1/crm/opportunities/{id}`            | `crm.opportunity.manage` | Details, owner, amount, chance, archive — not the stage                                                   |
| `POST /v1/crm/opportunities/{id}/transitions` | `crm.opportunity.manage` | Move to another stage: forward, back, won, lost, reopened                                                 |

| Rule                                                                              | Refusal                                    |
| --------------------------------------------------------------------------------- | ------------------------------------------ |
| For a customer or a lead (a lead that became a customer brings its customer)      | 422 `party_required`                       |
| Customer and lead are this company's                                              | 404 `customer_not_found`, `lead_not_found` |
| A new opportunity starts at an open stage (default: the default pipeline's first) | 422 `stage_not_found`, `stage_not_open`    |
| Owner is an active member                                                         | 422 `assignee_not_member`                  |
| A move goes to another live stage of its own pipeline                             | 422 `invalid_transition`                   |
| Losing needs a reason                                                             | 422 `lost_reason_required`                 |
| An archived opportunity is restored before it moves                               | 422 `opportunity_archived`                 |
| Edits and moves name `expectedVersion`                                            | 409 `version_conflict`                     |
| Amounts are decimal strings; chances whole basis points                           | 422 (schema)                               |

A move sets the status to the stage's outcome and the chance to the stage's
usual one, sets or clears `closedAt`, and records the move. Winning creates no
invoice and no job. Audit actions: `crm_opportunity.created`, `.updated`,
`.stage_changed`, `.won`, `.lost`, `.reopened`.

Converting a lead (C2) now also takes an optional
`opportunity: { title, amount?, currencyCode?, expectedCloseDate? }`, opened at
the first stage for the new or linked customer and the lead, owned by the lead's
assignee (needs `crm.opportunity.manage`); the response carries `opportunityId`.
Opportunities already open for the lead get its customer.

## Activities and the dashboard (phase C3)

Source: `apps/api/src/routes/v1/crm-activities.ts`.

| Method and path                 | Permission            | What it does                                                                                                                                                                                        |
| ------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/crm/activities`        | `crm.read`            | `status`, `assignedTo` (id, `me`, `none`), `due` (`overdue`, `today`, `upcoming`, `none`, in the company's time zone), `leadId`, `customerId`, `opportunityId`, `order` (`due` or `recent`), cursor |
| `POST /v1/crm/activities`       | `crm.activity.manage` | Log one or set a follow-up, linked to ≤ 10 each of leads, customers, opportunities (`Idempotency-Key` honoured)                                                                                     |
| `PATCH /v1/crm/activities/{id}` | `crm.activity.manage` | Change, complete (`done` records who and when), reopen or cancel                                                                                                                                    |
| `GET /v1/crm/dashboard`         | `crm.read`            | Leads by status; open pipeline by stage and per currency, weighted by chance; won and lost in 30 days; follow-ups overdue, due today and mine                                                       |

Refusals: 422 `link_required` (no link), 404 `link_not_found` (a link that is
not this company's), 422 `assignee_not_member`, 409 `version_conflict`. Notes
are written done. Audit actions: `crm_activity.created`, `.updated`, `.done`,
`.open`, `.cancelled`.

`GET /v1/customers/{customerId}/crm` (C2) now also returns the customer's
newest 20 opportunities and activities and `can.manageOpportunities` /
`can.manageActivities`; the list routes filter by `customerId` for more.

## Inventory (phase E1)

Source: `apps/api/src/routes/v1/inventory.ts` (catalogue, locations) and
`inventory-stock.ts` (movements, balances, counts). Tests:
`apps/api/src/routes/v1/inventory.integration.test.ts`. Every route needs the
`inventory` module; quantities are decimal strings.

| Method and path                                              | Permission                            | What it does                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------ | ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET/POST /v1/inventory/categories`, `PATCH …/{id}`          | `inventory.read` / `inventory.manage` | Item categories                                                                                                                                                                                                                                                                                                                                     |
| `GET /v1/inventory/items`                                    | `inventory.read`                      | `q`, `kind`, `categoryId`, `includeArchived`, alphabetical cursor; each item with `onHand` everywhere                                                                                                                                                                                                                                               |
| `POST /v1/inventory/items`                                   | `inventory.manage`                    | Add (`Idempotency-Key` honoured); 409 `sku_taken`, `barcode_taken`                                                                                                                                                                                                                                                                                  |
| `GET /v1/inventory/items/{id}`                               | `inventory.read`                      | The item, its stock by location with reorder levels, `onHand`, `can`                                                                                                                                                                                                                                                                                |
| `PATCH /v1/inventory/items/{id}`                             | `inventory.manage`                    | Change or archive; `expectedVersion`; 409 `item_has_stock` when a stock item that holds stock would change kind                                                                                                                                                                                                                                     |
| `PUT /v1/inventory/items/{id}/reorder-levels`                | `inventory.manage`                    | Replace the item's levels; stock items only                                                                                                                                                                                                                                                                                                         |
| `GET /v1/inventory/lookup?barcode=`                          | `inventory.read`                      | The item with this barcode                                                                                                                                                                                                                                                                                                                          |
| `GET/POST /v1/inventory/locations`, `GET/PATCH …/{id}`       | `inventory.read` / `inventory.manage` | Warehouses, vans (one per member: 409 `member_has_van`; 422 `assignee_not_member`, `not_a_van`), sites; archive only when empty (409 `location_not_empty`)                                                                                                                                                                                          |
| `GET /v1/inventory/movements`                                | `inventory.read`                      | The ledger, newest first; `itemId`, `locationId`, `kind`                                                                                                                                                                                                                                                                                            |
| `POST /v1/inventory/movements`                               | `inventory.move`                      | **`Idempotency-Key` required.** `type`: `receipt` (optional `unitCost`, folds into the average), `issue` (reason required), `transfer` (`fromLocationId`, `toLocationId`; both halves together), `adjustment` (`direction`, reason required). 409 `insufficient_stock`, 422 `not_stock_item`, `same_location`, `item_archived`, `location_archived` |
| `GET /v1/inventory/balances`                                 | `inventory.read`                      | How much is where; `belowMinimum=true` for what is under its reorder level                                                                                                                                                                                                                                                                          |
| `GET /v1/inventory/reconcile`                                | `inventory.manage`                    | Replays the ledger; `discrepancies` is empty when every balance is right                                                                                                                                                                                                                                                                            |
| `GET/POST /v1/inventory/counts`, `GET …/{id}`                | `inventory.read` / `inventory.move`   | Stock counts                                                                                                                                                                                                                                                                                                                                        |
| `PUT …/{id}/lines`, `POST …/{id}/post`, `POST …/{id}/cancel` | `inventory.move`                      | Record, post or cancel a draft count; 409 `count_not_draft`                                                                                                                                                                                                                                                                                         |

Costs (`defaultUnitCost`, `averageUnitCost`, a movement's `unitCost`) are null
in every body to a seat without `inventory.move`.

## Purchasing (phase E2, first half)

Source: `apps/api/src/routes/v1/purchasing.ts`. Tests:
`apps/api/src/routes/v1/purchasing.integration.test.ts`. Every route needs the
`purchasing` module. Prices are decimal strings in the order's currency; a
line's `taxRateBp` is a rate in basis points.

| Method and path                             | Permission           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/purchasing/suppliers`              | `purchasing.read`    | `q`, `status` (active only by default), alphabetical cursor                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /v1/purchasing/suppliers`             | `purchasing.manage`  | Add (`Idempotency-Key` honoured); 409 `supplier_name_taken`                                                                                                                                                                                                                                                                                                                                                                                   |
| `GET /v1/purchasing/suppliers/{id}`         | `purchasing.read`    | The supplier, its 20 latest orders, `can.manage`                                                                                                                                                                                                                                                                                                                                                                                              |
| `PATCH /v1/purchasing/suppliers/{id}`       | `purchasing.manage`  | Change, make inactive or active; `expectedVersion`                                                                                                                                                                                                                                                                                                                                                                                            |
| `PATCH /v1/inventory/items/{id}` (addition) | `inventory.manage`   | `preferredSupplierId`, `supplierPartNumber`; 404 `supplier_not_found`                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /v1/purchasing/orders`                 | `purchasing.read`    | `q` (reference such as `PO-000123` or `123`, or supplier words), `status`, `supplierId`, newest first; each with `totals` (null to seats without prices)                                                                                                                                                                                                                                                                                      |
| `POST /v1/purchasing/orders`                | `purchasing.manage`  | Draft with `lines` (`itemId`, optional `description`, `quantityOrdered`, `unitPrice`, `taxRateBp`); company currency unless `currencyCode`; 404 `supplier_not_found`, `item_not_found`, `location_not_found`; 422 `supplier_inactive`                                                                                                                                                                                                         |
| `GET /v1/purchasing/orders/{id}`            | `purchasing.read`    | The order, lines, receipts and `can` (`edit`, `approve`, `cancel`, `receive`)                                                                                                                                                                                                                                                                                                                                                                 |
| `PATCH /v1/purchasing/orders/{id}`          | `purchasing.manage`  | Change a draft; `lines` replaces every line; `expectedVersion`; 409 `order_not_draft`                                                                                                                                                                                                                                                                                                                                                         |
| `POST /v1/purchasing/orders/{id}/approve`   | `purchasing.approve` | Draft → approved, recording who and when; 409 `order_not_draft`; 422 `order_empty`                                                                                                                                                                                                                                                                                                                                                            |
| `POST /v1/purchasing/orders/{id}/cancel`    | `purchasing.manage`  | Any open status → cancelled with an optional `reason`; what was received stays; 409 `order_closed`                                                                                                                                                                                                                                                                                                                                            |
| `POST /v1/purchasing/orders/{id}/receipts`  | `purchasing.manage`  | **`Idempotency-Key` required.** `lines` (`orderLineId`, `quantity`, optional `unitCost`, else the order price), `locationId` (else the order's delivery location; 422 `location_required`), `supplierNote`, `notes`. Stock items go into the ledger and the average cost; status becomes `partially_received` or `received`. 409 `order_not_receivable`, `version_conflict`; 422 `over_received`, `line_repeated`; 404 `order_line_not_found` |
| `POST /v1/purchasing/receipts/{id}/returns` | `purchasing.manage`  | **`Idempotency-Key` required.** `reason`, `lines` (`receiptLineId`, `quantity`): posts `return_to_supplier` reversals, frees the order line, status falls back; 409 `insufficient_stock` when the goods are no longer there; 422 `over_returned`                                                                                                                                                                                              |

Prices and costs (`unitPrice`, `subtotal`, `tax`, `totals`, a receipt line's
`unitCost`) are null in every body to a seat holding neither
`purchasing.manage` nor `inventory.move`. Audit actions: `supplier.created`,
`supplier.updated`, `purchase_order.created`, `.updated`, `.approved`,
`.cancelled`, `.received`, `.returned`.

## Parts used on jobs (phase E2, second half)

Source: `apps/api/src/routes/v1/materials.ts` (the rules, shared with the
phone's sync) and `work-order-materials.ts` (the routes). Tests:
`apps/api/src/routes/v1/materials.integration.test.ts`. Every route needs the
`inventory` module. Every route answers with the job detail, which now carries
`materials`, `materialsCost` (null to seats without `inventory.move` or
`purchasing.manage`), `van` (the caller's) and `can.recordParts`.

| Method and path                                            | Permission          | What it does                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/work-orders/{id}/materials`                      | `inventory.consume` | **`Idempotency-Key` required.** `itemId`, `quantity`, optional `note`, `locationId` (a dispatcher must name it: 422 `location_required`; an engineer's is their van: 422 `no_van`, 403 when another is named). Posts under the balance lock or records a `conflict`; services and non-stock items never touch stock. The caller must work the job (crew or office). |
| `POST /v1/work-orders/{id}/materials/{materialId}/resolve` | `inventory.consume` | `{action: 'cancel'}` by the recorder or someone with `inventory.move`; `{action: 'retry', quantity?, locationId?}` by `inventory.move` only, posting if the stock is now there and staying a conflict if not. 409 `not_a_conflict`                                                                                                                                  |
| `POST /v1/work-orders/{id}/materials/{materialId}/return`  | `inventory.consume` | **`Idempotency-Key` required.** `quantity`, optional `reason`: a `consumption_return` reversing the use; 422 `over_returned`; 409 `not_posted`                                                                                                                                                                                                                      |
| `GET /v1/inventory/materials/conflicts`                    | `inventory.move`    | Every refused use across jobs, newest first, each with its job                                                                                                                                                                                                                                                                                                      |
| `POST /v1/sync/push` — `work_order.material`               | `inventory.consume` | The phone's change: `payload.materialId` (the client action id), `itemId`, `quantity`, `note`. Applied once; `alreadyApplied` when the action was seen before. A short van is still `applied` — the use is on record as a conflict — never a sync `conflict`, so the job's later changes are not held up                                                            |
| `GET /v1/sync/pull` — `vanStock`                           | `customer.read`     | On the first page: the caller's van and what it holds, or `{location: null, items: []}`; null on later pages                                                                                                                                                                                                                                                        |

Audit actions: `work_order.part_used`, `.part_conflict`, `.part_retried`,
`.part_cancelled`, `.part_returned`.

## Quotes (phase S1)

Source: `apps/api/src/routes/v1/sales-quotes.ts`. Tests:
`apps/api/src/routes/v1/sales-quotes.integration.test.ts`. Every route needs
the `sales` module. Prices are decimal strings in the quote's currency;
`discountBp` and `taxRateBp` are basis points per line; every total comes from
the server. Every body carries `can` so the screens show only what the seat
may do.

| Method and path                      | Permission     | What it does                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------ | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/sales/quotes`               | `sales.read`   | `q` (reference such as `QT-000123` or `123`, or words of the title or customer), `status`, `customerId`, `opportunityId`, newest first; each with `totals` and `expired`                                                                                                                                                                                   |
| `POST /v1/sales/quotes`              | `sales.manage` | Draft with `lines` (`itemId` or `description`, `quantity`, `unit`, `unitPrice`, `discountBp`, `taxRateBp`; defaults from the item); company currency unless `currencyCode`; 404 `customer_not_found`, `item_not_found`; 422 `site_not_customers`, `contact_not_customers`, `opportunity_not_customers`, `description_required`. `Idempotency-Key` honoured |
| `GET /v1/sales/quotes/{id}`          | `sales.read`   | The quote, lines, `issuedTo` snapshot, `answer`, `hasLink`, `convertedOrderId`, `can` (`edit`, `issue`, `revise`, `answer`, `convert`, `cancel`); `internalNotes` null without `sales.manage`                                                                                                                                                              |
| `PATCH /v1/sales/quotes/{id}`        | `sales.manage` | Change a draft; `lines` replaces every line; `expectedVersion`; 409 `quote_not_draft`                                                                                                                                                                                                                                                                      |
| `POST /v1/sales/quotes/{id}/issue`   | `sales.issue`  | Draft → issued: freezes the customer and lines, records who and when, mints the customer's link; answers with `acceptToken` and `acceptUrl` **once** (the token is never stored or shown again). 409 `quote_not_draft`; 422 `quote_empty`                                                                                                                  |
| `POST /v1/sales/quotes/{id}/answer`  | `sales.manage` | The office records the customer's answer: `status` (`accepted`/`rejected`), `name`, `reason`; spends the link; accepting wins the quote's opportunity. 409 `quote_not_issued`, `quote_expired`                                                                                                                                                             |
| `POST /v1/sales/quotes/{id}/revise`  | `sales.manage` | A new draft revision under the same reference (`QT-000123-R2`); the old link dies. Allowed for issued, expired or rejected; 409 `quote_not_revisable`                                                                                                                                                                                                      |
| `POST /v1/sales/quotes/{id}/cancel`  | `sales.manage` | Withdraw a draft, issued or rejected quote with an optional `reason`; 409 `quote_closed` for accepted, converted or cancelled                                                                                                                                                                                                                              |
| `POST /v1/sales/quotes/{id}/convert` | `sales.manage` | Makes the sales order from an accepted quote, once (see below); 409 `quote_not_accepted`, `quote_converted`                                                                                                                                                                                                                                                |

Audit actions: `quote.created`, `.updated`, `.issued`, `.accepted`, `.rejected`,
`.revised`, `.cancelled`, `.converted`, and `crm_opportunity.won_by_quote`.

## Sales orders (phase S1; ADR-0006)

Source: `apps/api/src/routes/v1/sales-orders.ts`; the hooks the job and parts
routes call are in `sales-fulfilment.ts`. Tests:
`apps/api/src/routes/v1/sales-orders.integration.test.ts`.

| Method and path                                                            | Permission        | What it does                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/sales/orders`                                                     | `sales.read`      | `q` (reference `SO-000123` or words), `status`, `customerId`; each with `totals`, `quote` and `toOrder` (a stock line is short)                                                                                                                                                                                            |
| `POST /v1/sales/orders`                                                    | `sales.manage`    | Draft without a quote, same line rules as a quote. `Idempotency-Key` honoured                                                                                                                                                                                                                                              |
| `GET /v1/sales/orders/{id}`                                                | `sales.read`      | The order, lines with `quantityReserved`, `quantityFulfilled`, `shortfall`, `reserveLocation`, `stock`; `workOrders` (job summaries, oldest link first); `can` (`edit`, `confirm`, `reserve`, `cancel`, `linkJobs`, `createJobs`)                                                                                          |
| `PATCH /v1/sales/orders/{id}`                                              | `sales.manage`    | Change a draft; `lines` replaces every line; 409 `order_not_draft`                                                                                                                                                                                                                                                         |
| `POST /v1/sales/orders/{id}/confirm`                                       | `sales.issue`     | Draft → confirmed: freezes the customer and lines, reserves each stock line at `reserveLocationId` (what is there is held, the rest is the line's `shortfall`); 422 `order_empty`, `location_required` (stock lines without a location), `location_archived`; 404 `location_not_found`; 409 `order_not_draft`              |
| `POST /v1/sales/orders/{id}/reserve`                                       | `sales.manage`    | Re-runs the reservation, at `reserveLocationId` or the order's own, after goods arrived or to hold elsewhere; 409 `order_not_open`                                                                                                                                                                                         |
| `POST /v1/sales/orders/{id}/cancel`                                        | `sales.manage`    | A draft by whoever manages sales; a confirmed order by `sales.issue` (403 otherwise); releases every reservation; 409 `order_closed`                                                                                                                                                                                       |
| `POST /v1/sales/orders/{id}/work-orders`                                   | `sales.manage`    | `{workOrderId}` links one of the customer's jobs (422 `work_order_not_customers`), or `{create: {...}}` makes one the way `POST /v1/work-orders` does (needs `work_order.manage`; the order's site unless `siteId`; the order's title unless `title`; 422 `site_required`). 409 `order_closed`. `Idempotency-Key` honoured |
| `DELETE /v1/sales/orders/{id}/work-orders/{workOrderId}`                   | `sales.manage`    | Unlinks; what the job already delivered stays delivered; 404 when not linked                                                                                                                                                                                                                                               |
| `GET /v1/sales/to-order`                                                   | `sales.read`      | Every stock line of an open order with a shortfall: what to buy                                                                                                                                                                                                                                                            |
| `GET /v1/inventory/balances`, `/items/{id}`, `/locations/{id}` (additions) | `inventory.read`  | Every balance row and the item's totals now carry `reserved` (promised to open orders) and `available` (on hand less reserved, never below zero)                                                                                                                                                                           |
| `GET /v1/work-orders/{id}` (addition)                                      | `work_order.read` | `salesOrders`: the orders this job delivers (empty without the sales module or `sales.read`)                                                                                                                                                                                                                               |

What the job routes and the phone's sync do with orders (`sales-fulfilment.ts`):
a part used on any job sees only what is **available** at the location — held
less what other orders reserved there — and is refused as a `conflict` beyond
it, with `availableQuantity` saying what was free; a part used on a job linked
to an order counts towards that order's lines for the item (oldest link first)
and releases the reservation it fulfils; a linked job completing (through
`POST /v1/work-orders/{id}/transitions` or the phone's `work_order.transition`)
delivers every line that is not stock. The order's status follows its lines:
`partially_fulfilled`, then `fulfilled`, which releases anything still held.

Audit actions: `sales_order.created`, `.updated`, `.confirmed`, `.reserved`
(with each short line), `.cancelled`, `.job_linked`, `.job_unlinked`,
`.delivered`, `.job_completed`.

## The customer's link (phase S1; ADR-0006)

Source: `apps/api/src/routes/v1/sales-public.ts`. Tests:
`apps/api/src/routes/v1/sales-public.integration.test.ts`. Public: no session;
the token in the path is the capability. The hash of the token is resolved to
its company on the platform connection, then the quote is read on that
company's own connection. The server's per-address rate limit applies as to
every route.

| Method and path                         | What it does                                                                                                                                                                                                                                                                                 |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/public/quotes/{token}`         | The issued quote: company (`name`, `logoPath`, `brandColour`), the customer as named on the quote, lines, totals, introduction, terms, `validUntil`, `expired`, `answer`, `canAnswer`. No ids, no people, no internal notes. `no-store`. 404 for a spent, revised, withdrawn or unknown link |
| `POST /v1/public/quotes/{token}/answer` | `status` (`accepted`/`rejected`), `name` (required), `reason`: records the answer with `via = link` and the caller's address, spends the link, wins the opportunity (actor: the issuer), audited as actor kind `system` with label `customer-link`. 409 `quote_expired`, `quote_not_issued`  |

The web page `/q/[token]` (`apps/web/src/app/q/[token]/page.tsx`) renders the
same `QuoteDocument` the office prints, with the accept and decline form and a
"Print or save as PDF" button that calls the browser's own print.

## Invoices and credit notes (phase B1; ADR-0007)

Source: `apps/api/src/routes/v1/finance-invoices.ts`. Tests:
`apps/api/src/routes/v1/finance-invoices.integration.test.ts`. Every route
needs the `finance` module. A company's own invoices to its customers, not
Integr8's billing (`/v1/billing/*`); the operation ids say `CustomerInvoice` to
keep them apart. Amounts are decimal strings; every total and balance comes
from the server; `status` is derived (`draft`, `issued`, `partially_paid`,
`paid`, `credited`, `void`) and `overdue` means issued, owing and past due.
Every body carries `can`.

| Method and path                                   | Permission       | What it does                                                                                                                                                                                                                                                                              |
| ------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/finance/settings`                        | `finance.read`   | The issuer block, `defaultDueDays`, `labourHourlyRate`, `labourHourlyCost` (null to seats that may not see costs), `companyName`, `version`, `can.edit`                                                                                                                                   |
| `PUT /v1/finance/settings`                        | `finance.issue`  | Saves them; `expectedVersion` (0 the first time); 409 `version_conflict`. Printed as typed: no tax or e-invoicing claim                                                                                                                                                                   |
| `GET /v1/finance/invoices`                        | `finance.read`   | `q` (reference `INV-000123` or `123`, or words of the customer's name), `status` (derived, repeatable), `customerId`, `salesOrderId`, `workOrderId`, `overdue`; newest first, paged; each with `amounts` (`total`, `allocated`, `credited`, `balance`) and `source`                       |
| `POST /v1/finance/invoices`                       | `finance.manage` | A blank draft for a customer, with optional `lines`, `dueDate`, site, contact, notes; company currency unless `currencyCode`                                                                                                                                                              |
| `POST /v1/finance/invoices/from-order`            | `finance.manage` | `{salesOrderId, basis}`: `ordered` bills what the order holds, `delivered` what its jobs delivered; either way only what no other invoice (drafts included, voids not) already bills. 409 `order_not_billable` (draft or cancelled); 422 `nothing_to_invoice`. `Idempotency-Key` honoured |
| `POST /v1/finance/invoices/from-job`              | `finance.manage` | `{workOrderId}`: one line per part used (net of returns, at the item's sale price) and one labour line for the time on site at the labour rate. 409 `job_not_complete`, `job_already_invoiced` (with the invoice's id in `details`); 422 `nothing_to_invoice`. `Idempotency-Key` honoured |
| `GET /v1/finance/invoices/{id}`                   | `finance.read`   | The invoice (`billedTo` and `issuer` once issued), lines (with `salesOrderLineId` or `workOrderMaterialId`), `creditNotes`, `payments`, `can` (`edit`, `discard`, `issue`, `void`, `credit`, `recordPayment`); `internalNotes` null without `finance.manage`                              |
| `PATCH /v1/finance/invoices/{id}`                 | `finance.manage` | Change a draft; `lines` replaces every line; 409 `invoice_not_draft`; 422 `over_invoiced` (more than the order holds or the job used, across every invoice), `line_not_from_source`, `customer_fixed`                                                                                     |
| `POST /v1/finance/invoices/{id}/discard`          | `finance.manage` | Deletes a draft (204); it had no number, so none is lost                                                                                                                                                                                                                                  |
| `POST /v1/finance/invoices/{id}/issue`            | `finance.issue`  | Draft → issued: numbers it, sets the issue date to the company's today and the due date (the body's, the draft's, or today plus `defaultDueDays`), copies the customer and the issuer. 422 `invoice_empty`, `due_before_issue`; 409 `invoice_not_draft`                                   |
| `POST /v1/finance/invoices/{id}/void`             | `finance.issue`  | With a `reason`, while nothing is paid or credited; the number stays used. 409 `invoice_not_issued`, `invoice_settled`                                                                                                                                                                    |
| `POST /v1/finance/invoices/{id}/credit-notes`     | `finance.manage` | A draft credit note with a `reason`: `whole: true` for everything still owed, or `lines` (each may name the invoice line). 409 `invoice_not_issued`; 422 `line_not_from_invoice`                                                                                                          |
| `GET /v1/finance/credit-notes`, `/{id}`           | `finance.read`   | Credit notes, and one with its lines, totals and the invoice it reduces                                                                                                                                                                                                                   |
| `PATCH /v1/finance/credit-notes/{id}`, `/discard` | `finance.manage` | Change or discard a draft; 409 `credit_note_not_draft`                                                                                                                                                                                                                                    |
| `POST /v1/finance/credit-notes/{id}/issue`        | `finance.issue`  | Numbers it and reduces the invoice's balance; 422 `credit_over_balance`, `credit_note_empty`                                                                                                                                                                                              |

Audit actions: `finance_settings.updated`, `invoice.created`, `.updated`,
`.discarded`, `.issued`, `.voided`, `credit_note.created`, `.updated`,
`.discarded`, `.issued`.

## Payments, the customer's account and job cost (phase B1; ADR-0007)

Source: `apps/api/src/routes/v1/finance-payments.ts`. Tests:
`apps/api/src/routes/v1/finance-payments.integration.test.ts`. Payments are
recorded by hand; there is no payment gateway.

| Method and path                                                    | Permission      | What it does                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/finance/payments`                                         | `finance.read`  | `q` (reference `RC-000123`, the bank reference, or customer words), `customerId`, `unallocated=true`; newest first; each with `allocated` and `unallocated`                                                                                                                                |
| `POST /v1/finance/payments`                                        | `finance.issue` | Records money received: `customerId`, `receivedOn` (not in the future: 422 `received_in_future`), `amount`, `method`, `paymentReference`, `notes`, and `allocations` made in the same transaction. `Idempotency-Key` **required**                                                          |
| `GET /v1/finance/payments/{id}`                                    | `finance.read`  | The payment, every allocation (removed ones included), the customer's issued invoices in its currency that still owe, `can` (`allocate`, `removeAllocation`)                                                                                                                               |
| `POST /v1/finance/payments/{id}/allocations`                       | `finance.issue` | `{invoiceId, amount}`: never more than the payment has left (422 `over_receipt`) or the invoice owes (422 `over_invoice`); same customer and currency (422 `allocation_mismatch`); issued invoices only (409 `invoice_not_issued`)                                                         |
| `POST /v1/finance/payments/{id}/allocations/{allocationId}/remove` | `finance.issue` | Takes an allocation back; the money returns to the customer's account and the invoice owes it again; kept on record as removed. 409 `allocation_removed`                                                                                                                                   |
| `GET /v1/finance/customers/{id}/account`                           | `finance.read`  | Per currency: `owed`, `unallocated`, `net`; the invoices still owing and the payments with money on account                                                                                                                                                                                |
| `GET /v1/finance/work-orders/{id}/costs`                           | `finance.read`  | Hours on site and working, parts at their cost (net of returns), labour at the hourly cost when set (`labour.costed`), the net of the job's issued invoices less credit notes, and the profit. Costs and profit are null unless the seat issues finance, moves stock or manages purchasing |

Audit actions: `payment.recorded`, `payment.allocated`,
`payment.allocation_removed`.

## Assets (phase E3; ADR-0008)

Source: `apps/api/src/routes/v1/assets.ts`. Tests:
`apps/api/src/routes/v1/assets.integration.test.ts`. Every route needs the
`assets` feature (403 `feature_disabled` otherwise). An engineer reads only the
assets of sites they have a job at; anything else answers 404. Whoever reads an
asset reads its whole history.

| Method and path                                | Permission     | What it does                                                                                                                                                                                                                                                                         |
| ---------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v1/assets`                               | `asset.read`   | `q` (number `AS-000123`, tag code, serial, name, customer), `customerId`, `siteId`, `status` (repeatable), `warranty=expiring\|expired` (inside the company's window, or ended), cursor paging; each with `warranty` state and `tagLink`                                             |
| `POST /v1/assets`                              | `asset.record` | Registers: `siteId` (`asset.manage`) or `workOrderId` (an engineer's own job, at its site), `name`, `make`, `model`, `serialNumber` (409 `serial_taken`), `itemId`, `locationNote`, `installDate`, `warrantyExpiresOn`, `notes`, `condition`. Numbered and tagged. `Idempotency-Key` |
| `GET /v1/assets/by-tag/{code}`                 | `asset.read`   | The asset a tag code names, typed in groups or not; 404 for a reissued or unknown tag                                                                                                                                                                                                |
| `GET /v1/assets/{id}`                          | `asset.read`   | The asset, the jobs it is linked to, and `can` (`edit`, `record`, `attach`)                                                                                                                                                                                                          |
| `GET /v1/assets/{id}/timeline`                 | `asset.read`   | Newest first: events, linked jobs, submissions (with photos), parts fitted and files — its own, and those of jobs whose only asset it is                                                                                                                                             |
| `PATCH /v1/assets/{id}`                        | `asset.manage` | Edits details with `expectedVersion` (409 `version_conflict`); records the changed fields                                                                                                                                                                                            |
| `POST /v1/assets/{id}/relocate`                | `asset.manage` | Moves it to another site (of any customer); 422 `same_site`                                                                                                                                                                                                                          |
| `POST /v1/assets/{id}/status`                  | `asset.manage` | `active`, `out_of_service` or `retired`, with a note; 422 `same_status`                                                                                                                                                                                                              |
| `POST /v1/assets/{id}/condition`               | `asset.record` | Records `good`, `fair`, `poor` or `unusable`, with a note and the job; 409 `asset_retired`                                                                                                                                                                                           |
| `POST /v1/assets/{id}/tag`                     | `asset.manage` | Issues a new tag; the old label stops opening it                                                                                                                                                                                                                                     |
| `GET /v1/work-orders/{id}/assets`              | `asset.read`   | The job's assets, the other assets at its site, and `can` (`link`, `unlink`, `register`)                                                                                                                                                                                             |
| `POST /v1/work-orders/{id}/assets`             | `asset.record` | Links an asset at the job's site that is not retired (409 `asset_not_at_site`, `asset_retired`); an engineer on their own job                                                                                                                                                        |
| `DELETE /v1/work-orders/{id}/assets/{assetId}` | `asset.manage` | Unlinks; what was recorded stays on the asset                                                                                                                                                                                                                                        |
| `GET` / `PUT /v1/assets/settings`              | read / manage  | `warrantyAlertDays` (0–365, default 60) with `expectedVersion`                                                                                                                                                                                                                       |

Additions elsewhere:

- `POST /v1/customers/.../attachments` and the job and site attachment routes accept an `{ assetId }` owner (`asset.record`).
- `POST /v1/submissions` takes `assetId` (`asset.record`; one of the job's assets: 409 `asset_not_on_work_order`, `asset_retired`). Questions the form marks `carryOver` start from that asset's last submission of the same form; the answer's `carriedOver` (`{ fromSubmissionId, fields }`) and `asset` say which and for what, on every later read too.
- `POST /v1/imports` with `kind: assets` needs the module and `asset.manage` as well as `import.run`; columns in `GET /v1/imports/columns/assets`.
- The sync pull carries `assetSiteIds` and `assets`: every asset at the sites of the pulled jobs with its whole timeline and `carryOver` (per form: the version, the fields and the answers a form started for it would carry). The push takes `asset.register`, `asset.condition` and `asset.link`, idempotently, and `submission.start` may name `assetId` and `carriedOver`; an asset the server no longer allows on the job is dropped from the start rather than refusing the form.

Audit actions: `asset.registered`, `asset.updated`, `asset.relocated`,
`asset.status_changed`, `asset.condition_recorded`, `asset.tag_reissued`,
`asset.linked`, `asset.unlinked`, `asset_settings.updated`.

## The general ledger (phase A1; ADR-0009)

Sources: `apps/api/src/routes/v1/ledger.ts`, `ledger-postings.ts` and
`ledger-reports.ts`. Tests: `ledger.integration.test.ts`,
`ledger-postings.integration.test.ts`, `ledger-reports.integration.test.ts`
beside them. Every route needs the `ledger` feature (403 `feature_disabled`).
Everything except reading the overview and setting up answers 409
`ledger_not_set_up` until the ledger is set up. Every rule the database checks
at posting is checked first, so a refusal comes with words: 422
`before_start`, `unbalanced`, `invalid_lines`; 409 `period_locked`,
`account_archived`, `self_approval`.

| Method and path                            | Permission      | What it does                                                                                                                                                                                                                                    |
| ------------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /v1/ledger`                           | `ledger.read`   | Whether it is set up, the settings, the company currency and today, whether the start is `fixed`, the opening journal, what this seat may do, and `unposted` (`total`, `byReason`)                                                              |
| `POST /v1/ledger/setup`                    | `ledger.manage` | `startDate` (first of a month), `fiscalStartMonth`, `language` of the default chart. Once (409 `already_set_up`); queues for review what was recorded since the start. `Idempotency-Key`                                                        |
| `PUT /v1/ledger/settings`                  | `ledger.manage` | `expectedVersion`; the start and fiscal year only while nothing is posted (409 `settings_fixed`); automatic posting for sales and for stock; posting accounts (422 `account_not_usable`); self-approval only by the owner (403)                 |
| `GET` / `POST /v1/ledger/accounts`         | read / manage   | The chart (`archived=true` includes archived accounts); a new account (409 `code_taken`)                                                                                                                                                        |
| `PATCH /v1/ledger/accounts/{id}`           | `ledger.manage` | Code, name, type, archived, with `expectedVersion`; 409 `type_fixed` once posted to, `posting_account` for an account an automatic posting uses                                                                                                 |
| `GET /v1/ledger/periods`                   | `ledger.read`   | The months of the fiscal year holding `date`, locked or open, and their history                                                                                                                                                                 |
| `POST /v1/ledger/periods/{month}/lock`     | `ledger.manage` | Locks a month                                                                                                                                                                                                                                   |
| `POST /v1/ledger/periods/{month}/unlock`   | `ledger.unlock` | Unlocks it with a `reason`; 409 `year_closed` in a closed fiscal year                                                                                                                                                                           |
| `GET /v1/ledger/journals`                  | `ledger.read`   | Newest first: `status`, `kind`, `from`, `to`, `accountId`, `q` (a `JV-` number or words in the memo), cursor paging                                                                                                                             |
| `GET /v1/ledger/journals/{id}`             | `ledger.read`   | The journal, its lines with accounts and customers, totals, the rate it was posted at, and `can` (`edit`, `post`, `discard`, `reverse`)                                                                                                         |
| `POST /v1/ledger/journals`                 | `ledger.post`   | A draft: `kind` `manual` or `opening` (once, dated on the start: 409 `opening_exists`, 422 `opening_date`), `entryDate`, `memo`, `lines`. `Idempotency-Key`                                                                                     |
| `PUT` / `DELETE /v1/ledger/journals/{id}`  | `ledger.post`   | Rewrites a draft (its writer becomes the drafter) or discards it; 409 `not_draft`                                                                                                                                                               |
| `POST /v1/ledger/journals/{id}/post`       | `ledger.post`   | Posts a draft written by hand: someone other than its drafter, or the drafter with `selfApprove` when the owner allows it                                                                                                                       |
| `POST /v1/ledger/journals/{id}/reverse`    | `ledger.post`   | Posts its mirror on `entryDate` (default today), on or after the original; once (409 `already_reversed`); not a reversal or a closing journal. `Idempotency-Key`                                                                                |
| `GET /v1/ledger/opening-receivables`       | `ledger.post`   | What each customer owed at the start, in the company currency, to start the opening journal from                                                                                                                                                |
| `GET /v1/ledger/postings`                  | `ledger.read`   | The unposted list, oldest first: `status` (default `pending`), `kind`, `reason`, cursor paging, and the counts by reason                                                                                                                        |
| `GET /v1/ledger/postings/{id}`             | `ledger.read`   | A captured document, the journal it would post, the invoice it follows, and `can` (`post`, `skip`)                                                                                                                                              |
| `POST /v1/ledger/postings/{id}/post`       | `ledger.post`   | As proposed, on another `entryDate`, or with `lines` written out; another currency needs `rate` and `rateSource` (422 `rate_required`) and is converted line by line; 409 `waits_for_invoice`, `cost_unknown`, `not_pending`. `Idempotency-Key` |
| `POST /v1/ledger/postings/post-all`        | `ledger.post`   | The given `ids`, or everything waiting of the given kinds, up to 500: posted as proposed or left waiting with the reason; other currencies and stock without a cost are left for review                                                         |
| `POST /v1/ledger/postings/{id}/skip`       | `ledger.post`   | Sets it aside with a `reason`; an invoice set aside takes its waiting credit notes and void with it                                                                                                                                             |
| `GET /v1/ledger/reports/trial-balance`     | `ledger.read`   | Each account's net at `date` on the debit or credit side, the totals, and `leftOut` (drafts and waiting documents not counted)                                                                                                                  |
| `GET /v1/ledger/reports/account-activity`  | `ledger.read`   | One account's lines from `from` to `to` with the opening, running and closing balance on its normal side; up to 5,000 lines (`truncated`)                                                                                                       |
| `GET /v1/ledger/reports/receivables`       | `ledger.read`   | Receivables at `date` per customer against what invoices, credit notes and payments say, and the difference; open invoices today by how late (current, 1–30, 31–60, 61–90, over 90 days) and payments not yet allocated                         |
| `GET /v1/ledger/reports/profit-and-loss`   | `ledger.read`   | Income and expenses from `from` to `to`, closing journals left out; a management report                                                                                                                                                         |
| `GET /v1/ledger/reports/balance-sheet`     | `ledger.read`   | Assets, liabilities and equity at `date`, earnings not yet closed shown in equity, and whether it balances; a management report                                                                                                                 |
| `GET /v1/ledger/years`                     | `ledger.read`   | The fiscal years since the start, newest first: open or closed, months locked, the close in force and earlier reopenings, and `can` (`close`, `reopen`)                                                                                         |
| `POST /v1/ledger/years/{yearStart}/close`  | `ledger.manage` | Once the year has ended (409 `year_not_ended`) with nothing in draft or waiting in it (409 `year_not_ready`): posts the closing journal on its last day and locks every month; 409 `year_closed`, `nothing_to_close`. `Idempotency-Key`         |
| `POST /v1/ledger/years/{yearStart}/reopen` | `ledger.unlock` | With a `reason`: reverses the closing journal; the months stay locked (409 `year_open` when not closed). `Idempotency-Key`                                                                                                                      |

CSV and printing are the screens': the reports are JSON, written to CSV in the
browser with `toCsv()` (a byte-order mark, and cells a spreadsheet would run
as formulas escaped).

Audit actions: `ledger.set_up`, `ledger.settings_updated`,
`ledger.account_created`, `ledger.account_updated`, `ledger.period_locked`,
`ledger.period_unlocked`, `ledger.journal_drafted`, `ledger.journal_updated`,
`ledger.journal_discarded`, `ledger.journal_posted`, `ledger.journal_reversed`,
`ledger.posting_posted`, `ledger.postings_posted`, `ledger.posting_skipped`,
`ledger.year_closed`, `ledger.year_reopened`.
