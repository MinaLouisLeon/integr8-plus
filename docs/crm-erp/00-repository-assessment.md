# 00 — Repository assessment

Phase F0. What the repository actually is today, checked against PLAN.md, so
the CRM and ERP work follows the code rather than the plan's assumptions.

- **Branch:** `feat/crm-erp-foundation`, created from `main` at `8db1c50`
  (pull request #72 merged). Working tree clean.
- **Version:** `0.1.4` (root `package.json`).
- **Read for this assessment:** every path in PLAN.md §1.2, plus the files
  named below.

## 1. Baseline confirmed

Everything PLAN.md §1.1 states about the baseline holds on `main`:

| Claim in PLAN.md                                        | Checked in                                                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 4 apps, 13 shared packages, pnpm + Turborepo            | `apps/`, `packages/`, `pnpm-workspace.yaml`, `turbo.json`                                            |
| 158 `/v1` endpoints, OpenAPI 3.0.3, generated client    | `apps/api/openapi.json`, `packages/api-client/src/generated/schema.ts`                               |
| 23 paired migrations, last is `0023_staff_management`   | `packages/db/migrations/`                                                                            |
| 5 roles, full per-role matrix, 3 staff-only permissions | `packages/core/src/roles.ts`, `packages/core/src/permissions.ts`                                     |
| Shared navigation model                                 | `packages/core/src/navigation.ts` (`NAV_SECTIONS`, `NAV_GROUPS`, `visibleNavigation`)                |
| Canonical `customers`, `customer_contacts`, `sites`     | `packages/db/migrations/0010_customers_sites_work_orders.up.sql`                                     |
| Inventory P22 not started, ledger specified             | `plan/v1.1-inventory/P22-item-catalogue-and-stock-ledger.md` (`NOT STARTED`)                         |
| No CRM or ERP code                                      | No `crm`/`erp` identifiers in `packages/core/src/permissions.ts` or anywhere in `apps/`, `packages/` |

## 2. Patterns the CRM must follow

### Database (`packages/db`)

- **Migrations:** `NNNN_name.up.sql` + `.down.sql`, applied by
  `packages/db/src/migrator`. The next number is **0024**.
- **Tenant tables:** `id uuid primary key default gen_random_uuid()`,
  `tenant_id uuid not null references tenants (id) on delete restrict`, a
  `unique (tenant_id, id)` constraint, and **composite foreign keys**
  `(tenant_id, x_id) references x (tenant_id, id)` between tenant tables.
- **Members:** referenced by `(tenant_id, user_id) references tenant_users
(tenant_id, user_id)` (see `work_order_assignments`). `created_by` columns
  on `customers` are a bare `uuid` with no foreign key.
- **Row-level security:** policy
  `for all to integr8_app using (tenant_id = app_current_tenant_id()) with
check (tenant_id = app_current_tenant_id())`, plus explicit grants to
  `integr8_app` (0002, 0010). The GUC `app.tenant_id` is set per transaction.
- **Timestamps:** `created_at`/`updated_at timestamptz`, and the
  `set_updated_at()` trigger on update.
- **Search:** generated `tsvector` columns with a GIN index (`customers.search`).
- **Enforced by tests** (`packages/db/src/testing/schema-invariants.integration.test.ts`):
  every public table has RLS; every tenant table has a non-null `tenant_id` with
  a foreign key to `tenants` and a tenant policy; every foreign key between two
  tenant tables includes `tenant_id`; the database's tables are exactly the
  ones `packages/db/src/schema.ts` declares.
- **Repositories:** extend `TenantScopedRepository`; registered in
  `buildTenantTransaction()` in `packages/db/src/connection.ts`; reached only
  through `withTenant(tenantId, (tx) => …)`. `TenantGuardPlugin` refuses a
  query without the tenant predicate.
- **Migration tests:** `migrations.integration.test.ts` applies every
  migration, rolls all back, and applies them again.

### API (`apps/api`)

- **Routes:** one `defineRoute({...})` per endpoint in
  `apps/api/src/routes/v1/*.ts`, collected in `apps/api/src/routes/index.ts`.
  Each declares `security`, `permission`, zod `params`/`query`/`body`, every
  response, and `idempotent`. OpenAPI is generated from the same objects
  (`pnpm --filter @integr8/api openapi`), and the client from that file
  (`pnpm --filter @integr8/api-client generate`). A test fails on drift.
- **Request pipeline** (`apps/api/src/server.ts`): authentication →
  impersonation re-check → company served (suspension) → company writable
  (read-only after non-payment) → permission (`assertHolds`) → per-company rate
  limit → idempotency → handler.
- **Errors:** `{ error: { code, message, details?, requestId } }`. Codes are
  **lower snake case** (`account_number_taken`, `staff_manager_only`).
- **Idempotency:** routes marked `idempotent: true` store and replay the
  response for a repeated `Idempotency-Key`; the same key with a different body
  is a 409. A request **without** a key runs undeduplicated.
- **Pagination:** keyset cursors (`cursor` in, `nextCursor` out), `limit`
  bounded per route (customers: 1–200, default 50).
- **Audit:** `tx.auditLog.append({ actorKind, actorId, actorLabel, action,
resourceType, resourceId, requestId, ipAddress, userAgent, metadata })`,
  action names dotted past tense (`customer.created`).
- **Feature flags:** `feature_flags` + `tenant_feature_flags` (0015). The
  platform declares flags and sets them per company; `/v1/me` returns the
  company's resolved flags as `features`. **No route checks a flag today:**
  flags are only advisory to the apps.
- **Background work:** Postgres queue (`tx.jobs.enqueue`), worker in
  `apps/api/src/jobs/`.

### Shared core (`packages/core`)

- Permissions: `PERMISSIONS` list, `MATRIX` with every role spelled out (no
  inheritance), `holds(seat, permission)` applying the staff-only overlay.
  `packages/core/src/permissions.test.ts` checks the matrix.
- State machines live here as data (`work-orders.ts`), and the database
  enforces the same transitions; a schema-invariants test compares them.

### Screens (`packages/operations-dom`, `apps/web`, `apps/desktop`)

- Customer, site, work-order, job-type, import and timesheet screens are shared
  React components in `@integr8/operations-dom`. Each app supplies an
  `OperationsConfig` through `OperationsContext`: the API client, `navigate`,
  route `paths`, locale, and (desktop only) a right-click `rowActions` handler.
- The package's `ui.tsx` is the shared kit: `Field`, `Dialog`, `Loading`,
  `Failure`, `InlineError`, `BackLink`, `DashboardBackLink`, `useRowMenu`,
  button and input classes, all with logical (RTL-safe) properties.
- Web: `apps/web/src/app/(app)/<route>/page.tsx` wraps a shared screen in
  `OperationsScreens`; the side menu comes from `visibleNavigation('web', permissions)`.
- Desktop: `SIGNED_IN_ROUTES` in `apps/desktop/src/App.tsx`, hash routes,
  `apps/desktop/src/features/operations/screens.tsx` supplies the config.

### Languages (`packages/i18n`)

- `src/messages/en.ts` and `ar.ts`, nested objects per area (`nav.group.*`,
  `nav.section.*`, `operations.customers.*`, `errors.*`). A parity test fails
  if a key exists in one catalogue and not the other; Arabic plurals use all
  six forms.

## 3. Differences from PLAN.md, and what this branch does about them

| #   | PLAN.md says                                                      | The repository                                                                                                       | Resolution                                                                                                                                          |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Error codes like `CRM_LEAD_ALREADY_CONVERTED`, `FEATURE_DISABLED` | Codes are lower snake case                                                                                           | Use the repository style: `lead_already_converted`, `feature_disabled`, `version_conflict`, `invalid_transition`                                    |
| 2   | New `packages/crm` and `packages/crm-dom`                         | `operations-dom` already carries client, routing, permissions, row menus and the customer screen the CRM must extend | No new packages. Pure CRM rules in `packages/core/src/crm.ts` (like `work-orders.ts`); CRM screens in `packages/operations-dom/src/crm/` (ADR-0001) |
| 3   | Gate protected API operations on the module flag                  | Flags exist but no route enforces one                                                                                | Add `feature` to `defineRoute`, checked server-side after the permission, with a short cache; 403 `feature_disabled`                                |
| 4   | Navigation hidden when the module is off                          | `visibleNavigation` filters by permission and app only                                                               | Optional `feature` on `NavSection` and an optional `features` argument, so existing callers are unchanged                                           |
| 5   | Default currency EGP per company                                  | `tenant_settings.currency` exists (owner-editable), **defaults to GBP**                                              | Migration 0024 sets the default to EGP and moves every company to EGP (product owner's decision)                                                    |
| 6   | Page size max 100                                                 | Routes set their own bounds (customers allow 200)                                                                    | CRM lists: 1–100, default 50, keyset cursors                                                                                                        |
| 7   | Idempotency required on conversion                                | A missing key runs without dedupe                                                                                    | The convert route refuses a request without `Idempotency-Key`; a unique constraint makes a second conversion impossible regardless                  |
| 8   | `version` for optimistic concurrency                              | No table uses one today                                                                                              | CRM tables carry `version integer`; updates send `expectedVersion`; a mismatch is 409 `version_conflict`                                            |
| 9   | Audit records the acting staff member                             | Tenant audit rows record the seat's user; impersonation is on the principal                                          | CRM audit entries add `impersonatedBy` to `metadata` when staff act                                                                                 |
| 10  | Viewer CRM read is "optional"                                     | —                                                                                                                    | Product decision: viewers read the CRM; dispatchers have full CRM rights including conversion                                                       |

## 4. Risks and clashes

- **Old clients and new permissions.** `/v1/me` will list `crm.*` permissions.
  The apps check permissions by name (`me.permissions.includes('customer.manage')`),
  so an older desktop or phone build simply ignores names it does not know.
- **Feature-flag latency.** A cached flag means switching CRM off takes effect
  within the cache lifetime (seconds) on other API instances; the process that
  handled the change clears its cache at once, as suspension does.
- **Platform company page.** Declaring the `crm` flag in a migration makes it
  appear on the platform's Flags page and each company page with no new UI.
- **Mobile.** The CRM MVP adds no phone screens and does not touch
  `packages/offline` or the sync protocol. Engineers hold no CRM permission.
- **Currency change.** Moving every company to EGP changes what the existing
  Company settings page shows. Nothing else reads `tenant_settings.currency`
  for money today (Integr8's own billing uses its plan prices).
