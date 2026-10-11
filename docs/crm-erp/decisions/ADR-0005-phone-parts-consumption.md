# ADR-0005 — Parts used on the phone, offline, without negative stock

**Status:** Accepted (E2 planning, 2026-10-11); implemented in E2 (migration 0028, `apps/api/src/routes/v1/materials.ts`, `work_order.material` sync mutation, `van_stock` on the phone)

## Context

The product owner chose to let engineers record parts used from the phone app
in E2, and chose that stock must never go negative: when the van does not hold
enough, the use is refused and flagged, not posted. Phones are often offline,
so a use is recorded on the phone first and reaches the server later, possibly
after another engineer's use of the same van stock, or after a dispatcher has
moved stock.

## Decision

- The phone records a use as an outbox action with an id the phone generates
  (`clientActionId`), carried to the server unchanged on every retry. The
  server posts it once: the consumption movement's `source_key` is
  `phone:<clientActionId>`, unique per company.
- The server decides at posting time, under the balance row's lock (ADR-0003).
  If the van holds enough, the use posts and the phone shows it as done. If it
  does not, nothing posts; the server records the attempt as a **conflict**
  (`erp_work_order_materials.status = 'conflict'`) with the quantity asked for
  and the quantity available, and the phone shows it as "needs attention".
- A conflict is resolved by people, never by retrying blindly: a dispatcher
  corrects the van (an audited count or transfer) and retries it, or the
  engineer changes the quantity, or it is cancelled. Each resolution is one
  audited request.
- The server checks, for every use, that the engineer is assigned to the job
  and that the location is the van assigned to them (or, for dispatchers, any
  location).
- Uses made in a different order on two phones are two ledger entries, not a
  merge: whichever reaches the server while stock remains posts; the other
  becomes a conflict if stock has run out.

## Consequences

Stock on the server is always a true count of what was posted. The phone's
own view of van stock is a forecast (server balance minus its own unsent uses)
and says so. A conflict is visible on the phone, on the job, and in a
dispatcher list until resolved.
