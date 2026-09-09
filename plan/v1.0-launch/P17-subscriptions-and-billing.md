# P17 — Subscriptions and billing

**Version:** v1.0 Launch
**Status:** `NOT STARTED`
**Depends on:** P15

## Goal
A company can pay you, and what they pay for is enforced by the API.

## Scope
Plans, entitlements and Stripe. Build this only once the product is worth paying for.

## Tasks
- [ ] Plan definitions: seats, storage GB, form count, submissions per month, retention days, module access
- [ ] Entitlement service in the API; every limit enforced server-side, never in the client
- [ ] Stripe Checkout for self-serve subscription
- [ ] Stripe Customer Portal for card updates, invoices and cancellation
- [ ] Free trial with expiry; expiry converts the tenant to read-only, never deletes data
- [ ] Webhook handler with idempotent processing for payment and subscription events
- [ ] Seat-based billing with proration on add and remove
- [ ] Storage overage billing or hard block, configurable per plan
- [ ] Dunning: retry schedule, reminder emails, grace period, then read-only lock
- [ ] Annual pricing and discount codes
- [ ] Tax handling and compliant invoices; VAT number capture
- [ ] Per-company plan overrides for negotiated deals
- [ ] In-app upgrade prompt shown at the moment a limit is hit

## Exit criteria
- [ ] A company subscribes, is charged, and their entitlements apply immediately
- [ ] A duplicate Stripe webhook delivery produces no duplicate effect
- [ ] A failed payment moves the company through dunning to read-only without losing any data
- [ ] Exceeding a plan limit is blocked by the API even when the request bypasses the UI

## Notes
- Verify Stripe availability in your target countries before building. If a market needs a
  regional provider, the entitlement service must stay provider-agnostic.
- Read-only on non-payment, never deletion. A company that pays late is still a customer;
  a company whose data you deleted is a lawsuit.
