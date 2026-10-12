# ADR-0013 — Product gaps before the pilot

**Status:** Accepted (ninth round planning, 2026-10-12)

## Context

After the eighth round (ADR-0012) the follow-ups list held a few product
gaps with no phase: custom roles, serial and batch tracking, drag-and-drop on
the pipeline board, menu entries for the eighth round's screens, and amount
history on opportunities. The product owner chose to close them before the
pilot (phase L); email and server-rendered PDFs still wait.

## Decision — custom roles (G1a)

- **Custom roles built on a base role.** The owner creates named roles that
  start from a built-in role (admin, dispatcher, engineer, viewer, HR
  manager, inventory manager) and add or remove permissions. A member has one
  role, built-in or custom. Owner stays a fixed role that nobody else holds.
- **Who.** The owner creates, changes and archives custom roles; owners and
  admins assign them, never above their own rank. A custom role ranks as its
  base role. The existing per-member grants keep working on top.
- **Limits.** A custom role never holds platform permissions or the owner's
  own (transferring ownership, billing, deleting the company); every change
  to a role and every assignment is audited; a role in use cannot be
  archived.

## Decision — serial and batch tracking (G1b)

- **Per item:** `none`, `serial` or `batch`. A serial item carries one number
  per unit; a batch item a batch code with an optional expiry date. Receipts,
  transfers, counts, parts used, deliveries, returns, van refills and
  assembly name the serials or batches they move; stock by serial and batch
  is shown per location.
- **Batch choice:** the earliest expiry is proposed; the person may choose
  another. An expired batch is warned about and needs a reason.
- **The phone:** works offline from the van's serials and batches; the
  engineer picks or scans one. When the server finds it already gone, the
  use becomes a conflict for the office, as stock shortfalls do today.
- **Switching an item to tracked:** only while it holds nothing anywhere, or
  through a stock count that records each serial or batch for what is on
  hand. Nothing untracked is left behind.
- **Tracing:** a serial lookup shows where a unit is and its whole path
  (received on which purchase order, moved, fitted on which job for which
  customer); an asset a serialised part was fitted to shows that serial.

## Decision — board, menus and amounts (G1c)

- **Drag-and-drop on the board** with `@dnd-kit` (MIT; already used by the
  desktop form builder): between open stages it moves at once, with undo;
  dropping on won or lost opens today's confirm step (a lost reason
  required). The keyboard stage selector stays; works by touch and right to
  left.
- **Menu entries** for pipelines, reports, parts used, van requests and
  reorder.
- **Amount history:** every change of an opportunity's amount or currency is
  recorded from this release; value by stage uses the amount a deal had at
  each month end, and today's amount for months before this release (the
  report says so).

## Decision — delivery

One branch, slices pushed as done (G1a roles, G1b tracking, G1c board, menus
and amounts), one pull request to `main`, then stop.

## Consequences

Every permission check reads the member's effective permissions, now from a
custom role as well as a built-in one. Tracked items add a dimension to the
stock ledger's balances; untracked items are unchanged.
