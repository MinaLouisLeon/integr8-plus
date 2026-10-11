# ADR-0004 — A company's invoices are not Integr8's billing

**Status:** Accepted (F0, 2026-10-11)

## Context

`/v1/billing/*`, `subscriptions` and `billing_events` are how **Integr8** charges
a company for the product (Stripe or invoiced). Phase B1 adds invoices that a
**company** sends to **its own customers**.

## Decision

- Separate namespaces (`/v1/erp/invoices`, `/v1/erp/payments`), tables (`erp_*`),
  permissions, screens and translation keys. Nothing shared with the platform
  billing code or its provider adapter.
- Company invoices are an internal commercial ledger: payments are recorded by
  hand (cash, bank transfer, other). No payment gateway, and no claim of
  e-invoicing, VAT or legal numbering compliance until a jurisdiction is chosen
  and reviewed.

## Consequences

A billing change for Integr8 can never alter a company's receivables, and the
reverse. The CRM MVP touches neither.
