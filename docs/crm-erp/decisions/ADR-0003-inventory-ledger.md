# ADR-0003 — Stock is an append-only ledger

**Status:** Accepted (F0, 2026-10-11); implemented in E1 on `feat/erp-inventory-purchasing`.

## Context

PLAN.md §5 ERP-02 and `plan/v1.1-inventory/P22` both require stock to be
reconstructible and correct under concurrency and retries.

## Decision

- Stock movements are immutable rows with a signed `numeric` quantity, a type,
  a source reference, an actor and an idempotency key. Corrections are
  compensating movements, never edits or deletes.
- On-hand is derived from the ledger, or from a projection that can be rebuilt
  from it and checked by replay.
- Negative stock is refused by default. Issues take a per company/item/location
  lock so two concurrent issues cannot both pass a read-then-write check.
- Transfers write both movements in one transaction.

## Consequences

E1 updates P22 with this model rather than writing a second plan. Phone-side
consumption (E2) needs its own conflict-safe sync design before it is built.

## How E1 enforces it (2026-10-11)

- `erp_stock_movements` is the ledger. The runtime role may only `select` and
  `insert` it; a trigger refuses any update.
- `erp_stock_balances` (one row per company, item and location) is the
  projection. Nothing in the application writes it: an `after insert` trigger
  on the ledger adds each movement's quantity with
  `insert … on conflict do update`, which takes the balance row's lock, so two
  concurrent issues of the same item from the same place run one after the
  other. A `check (on_hand >= 0)` on the balance refuses the second one if it
  would go negative, and the whole movement rolls back with it.
- A transfer is two movements (out and in) with one `posting_id`, inserted in
  one statement batch inside one transaction.
- Each movement has a `source_key` that is unique per company (for example
  `receipt-line:<id>`, `transfer:<idempotency key>`, `phone:<action id>`), so a
  retried posting fails the unique index instead of counting twice.
- The trigger function is `security definer` (owned by the schema owner, fixed
  `search_path`), which is how it writes a table the runtime role cannot.
- `reconcile()` in the stock repository rebuilds every balance from the ledger
  and reports any difference.
