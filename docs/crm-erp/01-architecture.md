# 01 — Architecture

How the CRM (and later the ERP) fits into the existing modular monolith. No new
service, no new app, no new package for the CRM MVP: every layer gains a CRM
part next to what it already holds.

```text
 apps/web  (app)/crm/*            apps/desktop  #/crm/*
        \                               /
         \   @integr8/operations-dom   /      shared React screens
          \     src/crm/*  +  customer screen's CRM tab
           \                         /
            @integr8/api-client (generated)
                       |
            apps/api  /v1/crm/*  (defineRoute: permission + feature gate)
                       |
            @integr8/db  repositories: leads, pipelines, opportunities, activities
                       |
            PostgreSQL 16: crm_* tables, RLS per company, composite tenant FKs

 @integr8/core: CRM permissions, lead and opportunity state rules, navigation
 @integr8/i18n: crm.* and nav.* keys in English and Arabic
```

## Where each part lives

| Layer          | Location                                        | CRM addition                                                                                                               |
| -------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Domain rules   | `packages/core/src/crm.ts`                      | Lead statuses and transitions, opportunity outcomes, activity types, probability bounds                                    |
| Permissions    | `packages/core/src/permissions.ts`              | `crm.read`, `crm.lead.manage`, `crm.lead.convert`, `crm.opportunity.manage`, `crm.activity.manage` (exact set fixed in F1) |
| Navigation     | `packages/core/src/navigation.ts`               | A `crm` group; sections carry `feature: 'crm'`                                                                             |
| Schema         | `packages/db/migrations/0024+`, `src/schema.ts` | `crm_*` tables                                                                                                             |
| Repositories   | `packages/db/src/repositories/crm-*.ts`         | Registered on `TenantTransaction`                                                                                          |
| HTTP           | `apps/api/src/routes/v1/crm.ts`                 | `/v1/crm/*`, plus `/v1/customers/{id}/crm`                                                                                 |
| Feature gate   | `apps/api/src/http/features.ts` + `server.ts`   | `feature: 'crm'` on a route → 403 `feature_disabled` when off                                                              |
| Screens        | `packages/operations-dom/src/crm/`              | Lead list/detail/form, conversion wizard, opportunities, activities, dashboard                                             |
| Web routes     | `apps/web/src/app/(app)/crm/*`                  | Thin pages wrapping the shared screens                                                                                     |
| Desktop routes | `apps/desktop/src/App.tsx`                      | Hash routes wrapping the same screens                                                                                      |
| Translations   | `packages/i18n/src/messages/{en,ar}.ts`         | `crm.*`, `nav.group.crm`, `nav.section.crm*`                                                                               |

## Request path for a CRM call

1. Authenticate; re-check impersonation; company served; company writable for writes.
2. **Permission** (`assertHolds`) — e.g. `crm.lead.manage`.
3. **Feature** — the company's resolved `crm` flag must be on. Both checks are
   required: hiding the menu is not authorization.
4. Idempotency, then the handler, inside `withTenant` (RLS active).
5. Audit entry in the same transaction.

## What the CRM never does

- Create a second customer or contact registry: leads convert **into**
  `customers` / `customer_contacts` (ADR-0002).
- Touch Integr8's own subscription billing (`/v1/billing/*`), now or in the ERP
  phases (ADR-0004).
- Change the phone app, `packages/offline` or the sync protocol.
- Use JavaScript numbers for money: amounts are `numeric` in Postgres and
  decimal strings in the API.
