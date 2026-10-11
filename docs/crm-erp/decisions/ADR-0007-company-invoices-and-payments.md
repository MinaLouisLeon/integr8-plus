# ADR-0007 — Company invoices, payment receipts and job cost

**Status:** Accepted (B1 planning, 2026-10-11)

## Context

A company that has delivered an order or a job needs to bill its customer and
record what was paid, and the office wants to know what a job cost against
what it earned. ADR-0004 fixed that this is the company's own commercial
ledger, apart from Integr8's subscription billing, with no payment gateway and
no compliance claim. This record fixes the shape of that ledger.

## Decision — documents

- An **invoice** is drafted from a sales order (its lines, or what has been
  delivered), from a completed job (the parts used and one labour line) or
  blank, keeps its source, and is numbered `INV-000001` onwards per company
  when issued. Issuing copies the customer (billing snapshot) and the
  company's issuer block onto it and freezes its lines (a trigger refuses any
  change, as for quotes and orders). Totals are computed in SQL from the
  lines; discount and tax are basis points per line.
- An issued invoice is never edited. A **credit note** (`CN-000001`…) is a
  separate issued document against one invoice, whole or partial, never more
  than the invoice's remaining balance. An invoice with nothing allocated to
  it may be **voided** with a reason; it keeps its number and its lines.
- Routes live under `/v1/finance/*` and tables under `erp_*` (the path in
  ADR-0004 named `/v1/erp/*`; the module-name prefix is the repository's
  convention, and the separation from `/v1/billing/*` is what matters).

## Decision — money received

- A **payment receipt** is immutable: date, amount, currency, method (`cash`,
  `bank_transfer`, `other`), reference and the customer it came from. It is
  **allocated** to the customer's issued invoices in one or more amounts that
  never exceed the receipt's unallocated remainder or the invoice's balance.
  What is not allocated stays on the customer's account for later. A wrong
  allocation is removed, not edited; a wrong receipt is reversed by a
  negative-free "refund" receipt in a later phase, not deleted.
- An invoice's **balance** is `total − allocations − credit notes`, and its
  status is derived from the facts (`issued`, `partially_paid`, `paid`,
  `credited`, `void`), never set by hand.

## Decision — job cost

- A company may set one hourly **labour cost** in its settings. A job's cost is
  the posted parts net of returns at their cost when posted (E2) plus the
  job's time on site (from its state changes) at that rate. Without a rate the
  figure is parts only and is labelled so. Profit is the job's invoiced net
  less its cost, shown to seats that see costs.

## Decision — who

- Dispatchers draft invoices and credit notes (`finance.manage`); owners and
  admins issue, void, credit, record receipts and allocate (`finance.issue`);
  viewers read (`finance.read`) without costs; engineers hold none. Everything
  needs the `finance` module, off by default.

## Consequences

Every figure the company shows a customer is a frozen document, and every
balance is derived from documents and receipts that never change. Nothing
here is a tax or e-invoicing claim: the issuer block is whatever the company
types, and the printed document says it is a commercial record.
