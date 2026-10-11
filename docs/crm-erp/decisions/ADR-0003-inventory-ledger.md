# ADR-0003 — Stock is an append-only ledger

**Status:** Accepted for phase E1 (recorded at F0, 2026-10-11). Not built on this branch.

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
