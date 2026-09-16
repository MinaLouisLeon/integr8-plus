# P17 — Subscriptions and billing

**Version:** v1.0 Launch
**Status:** `IN PROGRESS — built and verified against the recording provider; Stripe itself awaits keys`
**Depends on:** P15

## Goal

A company can pay you, and what they pay for is enforced by the API.

## Scope

Plans, entitlements and Stripe. Build this only once the product is worth paying for.

## Tasks

- [x] Plan definitions: seats, storage GB, submissions per month, retention days, list price, provider price ids
- [x] Entitlement service in the API; every limit enforced server-side, never in the client
- [x] Stripe Checkout for self-serve subscription — behind a provider interface, switched off by default
- [x] Stripe Customer Portal for card updates, invoices and cancellation
- [x] Free trial with expiry; expiry converts the tenant to read-only, never deletes data
- [x] Webhook handler with idempotent processing for payment and subscription events
- [x] Seat-based billing: the quantity sent to the provider is the active member count
- [x] Storage overage billing or hard block, configurable per plan _(P16; unchanged)_
- [x] Dunning: grace period, in-app reminders on a cadence, then read-only lock
- [ ] Form count and module access limits — **not built**; see _What is deliberately not here_
- [ ] Annual pricing and discount codes — yearly prices are held and can be bought; discount codes are not built
- [ ] Tax handling and compliant invoices; VAT number capture — **not built**
- [ ] Per-company plan overrides for negotiated deals — **not built**
- [ ] Proration on seat removal — the quantity is sent at checkout, not on every membership change
- [ ] In-app upgrade prompt shown at the moment a limit is hit — the refusal carries the numbers, but no prompt is rendered

## Exit criteria

- [x] A company subscribes, is charged, and their entitlements apply immediately
- [x] A duplicate Stripe webhook delivery produces no duplicate effect
- [x] A failed payment moves the company through dunning to read-only without losing any data
- [x] Exceeding a plan limit is blocked by the API even when the request bypasses the UI

All four are proven by `apps/api/src/billing/billing.integration.test.ts`, against a real
database and through the HTTP layer. "Is charged" is proven as far as it can be without a Stripe
account: the checkout is created with the price and quantity we hold, and the subscription
becomes real when the provider's webhook says so.

## Notes

- Verify Stripe availability in your target countries before building. If a market needs a
  regional provider, the entitlement service must stay provider-agnostic.
- Read-only on non-payment, never deletion. A company that pays late is still a customer;
  a company whose data you deleted is a lawsuit.

## Decisions

- **Stripe is behind an interface and switched off.** `BillingProvider` has a Stripe adapter and
  a recording fake, chosen by `BILLING_PROVIDER` exactly as `PUSH_SENDER` is. No keys are in this
  repository and none are needed to work on billing. Production refuses to start on the fake: a
  deployment that meant to charge cards and quietly did not is worse than one that will not boot.
- **Read-only means reads work and writes are refused — except paying.** `POST /v1/billing/checkout`
  and `POST /v1/billing/portal` stay live, because a company that cannot reach the checkout cannot
  stop being read-only. Signing out and sync diagnostics stay live too.
- **Enforced by HTTP method, not by permission.** Permissions have no read/write classification,
  and a new one added without being classified would default to allowed. A method cannot be
  forgotten, and an omitted route flag refuses a write — the safe direction.
- **Reminders are in-app only, and it is said out loud.** There is no email sender anywhere in
  this system. Reminders are announcement banners through the P15 channel, which means somebody
  who never opens the app is never told before their writes stop. That sentence is in
  `dunning.ts`, on the customer's billing screen and in `docs/billing/README.md`.
- **Three limits, because three have a meaning.** Seats, storage and submissions per month. Each
  is checked in the two places the thing is actually taken, never once at the door.
- **Webhook idempotency is a unique constraint, not care.** `billing_events (provider,
provider_event_id)`. The request-level idempotency table cannot serve: it is tenant-scoped, and
  a webhook arrives before the company is known.

## What is deliberately not here

- **Form count and module access limits.** Both are limits against concepts the product does not
  have — there are no modules, and no plan sold so far names a number of forms. Building the
  enforcement would mean inventing the concept in the billing layer, which is the worst place for
  it to be invented.
- **Tax, VAT capture and compliant invoices.** Real requirements, and ones that want an
  accountant's input rather than a guess. Invoices are the provider's hosted pages today.
- **Discount codes and negotiated per-company overrides.** The allowance is per plan. An override
  is a second source of truth for what a company is allowed, and the first one has to be solid.
- **Proration on seat removal.** The seat quantity is sent when a checkout is created.
  `setQuantity` exists on the interface and nothing calls it on every membership change yet.
- **An email sender.** Named here because everything above it depends on the same missing piece.

## Found while building this

- **The Kysely query builder is not reachable outside `@integr8/db`, on purpose.** A loose
  `setReadOnly` helper that took a `PlatformDataSource` did not compile; it became a repository
  method, which is the shape the boundary was asking for.
- **`CachedRule` is a narrowed copy of `PlanAllowance`, and the compiler enforces it.** Adding
  seats and submissions to the allowance meant adding them to the cache, and the build said so
  before anything read a stale `undefined`.
- **A `provider_subscription_id` belongs to exactly one company** — the unique constraint says
  so — which broke the integration suite on its second run, because the test database is not
  emptied between runs and the fixed id was still held by the previous run's company. The ids are
  generated per run now. The constraint is right; the test was wrong.
- **A plan with zero submissions is refused by the database**, so the limit test has to make a
  real submission and cap the plan at one. That check (`submissions_per_month > 0`) is worth
  keeping: a plan nobody can submit anything on is not a plan.
- **The checkout answers 503 when no return address is configured** rather than inventing one,
  which is how the integration harness found out it needed `BILLING_RETURN_URL`.
- **A correction is not a new submission.** Counting a reopened submission against the monthly
  limit would charge twice for one piece of work — and refusing one would trap a correction the
  company has already been asked to make, which is the one thing a limit must never do.
