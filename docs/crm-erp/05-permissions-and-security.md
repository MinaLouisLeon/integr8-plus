# 05 — Permissions and security

## Two independent checks on every CRM route

1. **Permission** — the seat's role must hold it (`assertHolds`, as for every route).
2. **Module** — the company must have `crm` switched on. Declared on the route
   as `feature: 'crm'` and enforced in `apps/api/src/server.ts` (step 6b) by
   `assertFeatureEnabled` in `apps/api/src/http/features.ts`. Refusal: 403
   `feature_disabled`.

Hiding a menu entry is never the control. The menu hides CRM entries for the
same two reasons (`visibleNavigation(app, permissions, features)`), but the API
refuses regardless.

The company's resolved flags are cached for 30 seconds per API process. Changing
a company's flag from the platform dashboard clears that company's entry, and
changing a flag's default clears every entry, in the process that made the
change; other processes catch up within 30 seconds.

## CRM permissions (phase F1)

| Permission               | Owner | Admin | Dispatcher | Engineer | Viewer |
| ------------------------ | :---: | :---: | :--------: | :------: | :----: |
| `crm.read`               |   ✓   |   ✓   |     ✓      |    —     |   ✓    |
| `crm.lead.manage`        |   ✓   |   ✓   |     ✓      |    —     |   —    |
| `crm.lead.convert`       |   ✓   |   ✓   |     ✓      |    —     |   —    |
| `crm.opportunity.manage` |   ✓   |   ✓   |     ✓      |    —     |   —    |
| `crm.activity.manage`    |   ✓   |   ✓   |     ✓      |    —     |   —    |

Decided with the product owner on 2026-10-11: dispatchers have full CRM rights
including conversion; viewers read and change nothing; engineers have no CRM
access (they still read customers for their jobs, through `customer.read`).
`customer.read` alone never reveals CRM data such as deal values.

None of these is staff-only. Integr8 staff acting as a company (impersonation)
hold whatever the seat holds; CRM audit entries record the staff member in
`metadata.impersonatedBy` (from phase C1; `crmAudit` in
`apps/api/src/routes/v1/crm.ts`).

Tests: `packages/core/src/crm.test.ts` pins the table above;
`packages/core/src/permissions.test.ts` keeps every role's grants explicit.

## Rules beyond the role (phase C1)

- An assignee must be an active member of the same company (422
  `assignee_not_member`); a lead cannot be handed to someone outside it.
- Edits carry `expectedVersion`, so two people editing the same lead cannot
  silently overwrite each other (409 `version_conflict`).
- A lead in another company answers 404, by id and by search, exactly as one
  that does not exist.
- The detail response says what the seat may do (`can.edit`, `can.convert`);
  screens use it to hide actions, and the API refuses them anyway.

## Converting (phase C2)

- `crm.lead.convert` to see suggested customers and to convert; the lead screen
  shows the action only when `can.convert` is true (the permission, and the
  lead open and not archived).
- Creating a customer during conversion also checks `customer.manage`, so the
  CRM can never become a back door for adding customers.
- A customer id from another company answers 404 `customer_not_found`, as one
  that does not exist; the response says nothing more about it.
- The customer's CRM summary (`/v1/customers/{id}/crm`) needs `crm.read` and the
  module, while the customer itself needs only `customer.read`: engineers read
  customers for their jobs and never see CRM data through them.

## Opportunities and activities (phase C3)

- Reading the pipeline, opportunities, activities and the dashboard needs
  `crm.read` (viewers included); changing any of them needs
  `crm.opportunity.manage` or `crm.activity.manage` (owners, admins and
  dispatchers). Engineers see none of it.
- Every id in a request — customer, lead, stage, owner, linked record — is
  checked to be this company's before anything is written, and the database's
  composite foreign keys refuse it anyway. Another company's stage is
  `invalid_transition`; another company's record is a 404, as one that does not
  exist.
- An opportunity's history and an activity's links cannot be changed or
  deleted by the application role.
- Detail responses carry `can` flags; screens hide what the seat may not do,
  and the API refuses it regardless.

## Inventory and purchasing (phases E1 and E2)

| Permission           | Owner | Admin | Dispatcher | Engineer | Viewer |
| -------------------- | :---: | :---: | :--------: | :------: | :----: |
| `inventory.read`     |   ✓   |   ✓   |     ✓      |    ✓     |   ✓    |
| `inventory.manage`   |   ✓   |   ✓   |     ✓      |    —     |   —    |
| `inventory.move`     |   ✓   |   ✓   |     ✓      |    —     |   —    |
| `inventory.consume`  |   ✓   |   ✓   |     ✓      |    ✓     |   —    |
| `purchasing.read`    |   ✓   |   ✓   |     ✓      |    —     |   ✓    |
| `purchasing.manage`  |   ✓   |   ✓   |     ✓      |    —     |   —    |
| `purchasing.approve` |   ✓   |   ✓   |     —      |    —     |   —    |

Decided with the product owner on 2026-10-11: dispatchers run stock and draft
purchases; only owners and admins approve a purchase; engineers see stock and
record parts used on their own jobs from the van assigned to them; viewers
read. Costs are shown only to seats holding `inventory.move`. Every route also
needs the company's `inventory` (or `purchasing`) module.

Two security-definer functions back the ledger: `erp_stock_apply_movement`
(the balance trigger) and `erp_stock_lock_balance`, which refuses a company
other than the transaction's own. A third, `assign_purchase_order_reference`
(0027), numbers purchase orders from a per-company counter the runtime role
cannot read or write directly. All pin `search_path` and are listed in
`SECURITY_DEFINER_FUNCTIONS`; the schema-invariant suite checks both facts.

Purchasing (E2): prices are shown to seats holding `purchasing.manage` or
`inventory.move`; viewers read orders without them. Approval is a separate
permission so that a dispatcher's own draft needs an owner or admin before
goods are received against it; the trigger `erp_purchase_order_lines_guard`
makes the approved lines immutable whatever the role.

## Sales (phase S1)

| Permission     | Owner | Admin | Dispatcher | Engineer | Viewer |
| -------------- | :---: | :---: | :--------: | :------: | :----: |
| `sales.read`   |   ✓   |   ✓   |     ✓      |    —     |   ✓    |
| `sales.manage` |   ✓   |   ✓   |     ✓      |    —     |   —    |
| `sales.issue`  |   ✓   |   ✓   |     —      |    —     |   —    |

Decided with the product owner on 2026-10-11: dispatchers draft and revise
quotes and orders, record a customer's answer, and link or create the jobs
that deliver an order; only owners and admins issue a quote and confirm an
order (which reserves stock) or cancel a confirmed one. Engineers see the
orders their jobs deliver on the job itself and nothing else of sales; viewers
read without internal notes. Every route also needs the company's `sales`
module, which is independent of `crm`, `inventory` and `purchasing`.

The customer's link (ADR-0006): issuing mints 32 random bytes (base64url);
only the SHA-256 is stored, globally unique while live. The public routes
resolve the hash to a company on the platform connection and then read on the
company's own connection, expose the quote and the company's name and logo
and nothing else, answer 404 alike for a spent, revised, withdrawn or unknown
link, and record the customer's answer as audit actor kind `system`
(`customer-link`) with the caller's address, never as a member. Tokens never
appear in the audit log or in server logs; the API returns one only in the
`issue` response.

A fourth security-definer function, `assign_sales_reference` (0029), numbers
quotes and orders from per-company counters the runtime role cannot write;
listed in `SECURITY_DEFINER_FUNCTIONS` and checked by the invariant suite. The
triggers `crm_quote_lines_guard` and `erp_sales_order_lines_guard` make issued
and confirmed lines immutable whatever the role.

## Finance (phase B1)

| Permission       | Owner | Admin | Dispatcher | Engineer | Viewer |
| ---------------- | :---: | :---: | :--------: | :------: | :----: |
| `finance.read`   |   ✓   |   ✓   |     ✓      |    —     |   ✓    |
| `finance.manage` |   ✓   |   ✓   |     ✓      |    —     |   —    |
| `finance.issue`  |   ✓   |   ✓   |     —      |    —     |   —    |

Decided with the product owner on 2026-10-11: dispatchers draft invoices and
credit notes (blank, from an order or from a completed job) and discard
drafts; only owners and admins issue or void an invoice, issue a credit note,
record a payment, allocate or take back an allocation, and change the invoice
settings. Engineers see nothing of finance. Viewers read without internal
notes. Every route also needs the company's `finance` module, independent of
`sales`, `inventory` and `purchasing`.

Job cost and profit (`GET /v1/finance/work-orders/{id}/costs`) and the labour
cost per hour in the settings are shown only to seats that issue finance, move
stock or manage purchasing, the same seats that see part costs elsewhere.
Everyone else gets nulls.

What the database enforces whatever the role: an issued or void invoice and an
issued credit note never change (`erp_invoices_guard`,
`erp_credit_notes_guard`, and the line guards); a receipt is never updated or
deleted (the runtime role has `select, insert` only); an allocation is removed
by stamping it, never deleted; no allocation exceeds what the receipt has left
or the invoice owes, and none crosses customers or currencies
(`erp_payment_allocations_guard`, security definer, locking both rows); no
credit note exceeds what the invoice owes. Two more security-definer functions
come with 0030, `assign_finance_reference` and `erp_payment_allocations_guard`,
both listed in `SECURITY_DEFINER_FUNCTIONS`. Purging a company still works with
issued documents. Deletes are allowed only while `purge_tenant` runs, and the
runtime role cannot fake that marker (`integr8_purging`).

The invoice is a commercial record. The issuer block is printed as the company
typed it, and the settings screen says so; Integr8 makes no tax, e-invoicing
or compliance claim.

## Database

See [03-data-model.md](./03-data-model.md): row-level security on every CRM
table, no delete grant on leads, composite tenant keys on every reference, and
the conversion rule enforced by a trigger.
