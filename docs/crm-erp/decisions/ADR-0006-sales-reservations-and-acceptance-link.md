# ADR-0006 — Reserving stock for confirmed orders, and the customer's acceptance link

**Status:** Accepted (S1 planning, 2026-10-11)

## Context

A confirmed sales order promises stock items to a customer, often days before
the job that fits them. Without a record of that promise, the same valve can be
sold twice or used on an unrelated job, and the shortfall is found on site.
Separately, the product owner wants customers to be able to accept a quote
themselves, without an account, while no email channel exists yet.

## Decision — reservations

- Confirming an order (owners and admins) reserves each stock-item line at one
  location the confirmer chooses. The reservation is `quantity_reserved` on the
  order line, not a ledger movement: on-hand stays the count of what is
  physically there (ADR-0003).
- A location's **reserved** quantity for an item is the sum of reserved
  quantities on lines of confirmed orders; **available** is on-hand less
  reserved, never shown below zero.
- When the location does not hold enough, the order still confirms: the line
  reserves what is there and the rest is flagged "to order", on the order and
  on the inventory overview. A dispatcher can re-run the reservation once goods
  arrive. Nothing goes negative.
- Using a part on a job linked to the order (ADR-0005) consumes the reservation
  for that item and location first, and counts towards the line's fulfilment.
  Using a part on any other job sees only what is available, so a reserved part
  is refused and flagged like a short van.
- Cancelling an order releases its reservations; fulfilling a line releases
  what it still held.

## Decision — acceptance link

- Issuing a quote mints a random 256-bit token; only its SHA-256 is stored.
  The link `/q/<token>` opens a public, read-only, printable view of the issued
  quote and lets the customer accept or reject it until the quote's expiry
  date. Accepting records the moment, the name typed and the caller's address;
  the office's own recording of an answer is kept the same way with
  `via = office`.
- Revising or cancelling a quote voids the token; re-issuing mints a new one.
  The office copies the link; the system sends no email in this round.
- The public route exposes nothing but the quote the token names: company
  name and logo, the customer's name, lines, totals, terms, expiry and status.

## Consequences

Reservations are a soft promise visible everywhere stock is shown, with the
ledger unchanged. A quote's acceptance is one audited fact whoever records it.
Tokens never appear in logs or the audit log; a leaked link is as good as a
copy of the quote, which is what it is.
