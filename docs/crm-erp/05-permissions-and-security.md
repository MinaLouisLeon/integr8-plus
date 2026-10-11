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

## Database

See [03-data-model.md](./03-data-model.md): row-level security on every CRM
table, no delete grant on leads, composite tenant keys on every reference, and
the conversion rule enforced by a trigger.
