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
