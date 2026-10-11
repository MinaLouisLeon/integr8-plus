# ADR-0001 — CRM and ERP inside the existing modular monolith

**Status:** Accepted (F0, 2026-10-11)

## Context

PLAN.md §2 asks for native modules, not a new service or an imported ERP, and
proposes new packages (`crm`, `crm-dom`, `erp`, `erp-dom`) "only when
justified". The repository already has one API, one database, one generated
client, and a package of shared web/desktop screens (`@integr8/operations-dom`)
that supplies the API client, routing, permissions and right-click menus to
every screen through `OperationsContext`, and owns the customer screen the CRM
must extend.

## Decision

- No new service, app or database.
- **No new packages for the CRM MVP.** Pure CRM rules (statuses, transitions,
  bounds) go in `packages/core/src/crm.ts`, beside `work-orders.ts`. CRM screens
  go in `packages/operations-dom/src/crm/`, reusing its UI kit and context.
- Revisit at the ERP phases: a separate `erp-dom` package is justified only if
  the ERP screens grow large enough that building `operations-dom` becomes slow,
  or need dependencies the operations screens should not carry.

## Consequences

One place for shared screens, no duplicated UI kit, and the customer page gains
its CRM tab without crossing a package boundary. `operations-dom` grows; its
folder layout (`src/crm/`) keeps the CRM separable later.
