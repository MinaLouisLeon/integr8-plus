# ADR-0002 — `customers` is the only customer record

**Status:** Accepted (F0, 2026-10-11)

## Context

The product already has `customers`, `customer_contacts` and `sites` (0010),
which work orders, submissions, imports and the phone app all point at. A CRM
commonly brings its own "accounts" and "contacts".

## Decision

- The CRM has no account or contact table. A **lead** is a prospect that is not
  yet a customer; converting it either links an **existing** customer or creates
  **exactly one** new customer (and optionally one contact) through the
  customers repository, in one transaction.
- A lead converts once: `crm_leads` records the customer it became, and a
  database constraint plus an idempotency key make a second conversion
  impossible, including under concurrent requests.
- Opportunities and activities reference `customers` with composite tenant
  foreign keys. Customer screens show CRM data in a tab; with the CRM switched
  off they behave exactly as before.

## Consequences

No duplicate customer identities and no sync between two registries. Matching a
lead to an existing customer is a choice the user makes in the conversion
screen; the system suggests candidates but never merges silently.
