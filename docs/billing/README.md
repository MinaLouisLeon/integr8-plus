# Subscriptions and billing

A company pays, and **what they pay for is enforced by the API** — not by a screen, not by a
client, and not by anything a crafted request can talk its way past (P17).

```
apps/web  (app)/billing            the plan, the limits, the usage, the invoices, and two buttons
        │  GET  /v1/billing/invoices   ← the invoices, read from the provider each time
        │  POST /v1/billing/checkout   → the provider's hosted page
        │  POST /v1/billing/portal     → the provider's card/cancel page
        │
apps/api  routes/v1/billing.ts     those three, plus the public webhook
        │  billing/provider.ts     BillingProvider: Stripe, or a recording fake
        │  billing/webhook.ts      what a verified delivery does
        │  billing/entitlements.ts the refusals: seats, submissions, storage
        │  billing/dunning.ts      trial expiry → reminders → read-only
        │
@integr8/db  migration 0017        subscriptions, billing_events,
                                   plan_allowances.seats/submissions/prices,
                                   tenants.read_only_since
```

---

## Nothing here is Stripe-shaped except the adapter

`BillingProvider` is an interface with two implementations, chosen in `composition.ts` by
`BILLING_PROVIDER` exactly as `PUSH_SENDER` and `GEOCODER` are: `StripeBillingProvider` talks
to Stripe's REST API, and `RecordingBillingProvider` keeps what would have been sent and hands
back links to `billing.invalid`. Production refuses to start on the fake.

Everything above the adapter says "a provider's customer" and "a provider's price". The columns
are `provider`, `provider_customer_id`, `provider_subscription_id`, `provider_price_monthly`;
`plan_allowances` maps our plans onto those price ids rather than the other way round. The plan
file asked for this in as many words — _if a market needs a regional provider, the entitlement
service must stay provider-agnostic_ — and the test of it is that a second adapter is a new file
and a config value, not a migration.

**There are no Stripe keys in this repository and none are needed to work on billing.** With
`BILLING_PROVIDER=recording` the whole flow runs, and the one part that genuinely cannot be
faked — signature verification — is implemented by hand and tested against real signatures in
`provider.test.ts`.

---

## The three limits, and the three that are not here

Enforced: **seats**, **submissions per month** and **storage**. Each is a number on
`plan_allowances`, read through one cache (`media/quota.ts`), and enforced at the moment the
thing is taken:

| Limit       | Refused at                                         | Error                          |
| ----------- | -------------------------------------------------- | ------------------------------ |
| Seats       | inviting somebody, **and** accepting an invitation | 409 `seat_limit_reached`       |
| Submissions | starting a submission, **and** submitting one      | 409 `submission_limit_reached` |
| Storage     | requesting an upload (P16)                         | 409 `storage_quota_exceeded`   |

Two places each, on purpose. An invitation sent last week can be accepted after the plan has
shrunk, so the check at acceptance is the one that is load-bearing; the check at invitation
exists so somebody is told _before_ they send an invitation that cannot be accepted. A draft
started in March can be submitted in April, so the same reasoning applies to submissions — and
the check at the start is what stops an engineer filling in twenty questions before being told.

A **correction** to a reopened submission is never counted and never refused. Counting it would
charge twice for one piece of work; refusing it would trap a correction the company has already
been asked to make.

Not enforced: **form count**, **module access** and **discount codes**. The first two are limits
against concepts the product does not have — there are no modules, and no plan sold so far talks
about a number of forms. Writing the enforcement anyway would mean inventing the concept in the
billing layer, which is where it would be worst. Tax, VAT capture and negotiated per-company
overrides are likewise not built: they are real requirements, and they belong with an accountant's
input rather than a guess.

---

## Read-only, never deletion

A company that stops paying keeps everything. What it loses is the ability to write.

Enforcement is by **HTTP method**, at step 5c of the request pipeline — every `POST`, `PUT`,
`PATCH` and `DELETE` is refused with **402** unless its route declares `allowedWhenReadOnly`.
Not by permission: permissions have no read/write classification, and a new permission added
without being classified would default to _allowed_. A method cannot be forgotten, and the
failure direction of an omitted flag is a refused write, which is the safe one.

Four routes declare the flag, and the list is meant to stay about this short:

- `POST /v1/billing/checkout` and `POST /v1/billing/portal` — **a company that has not paid
  must be able to pay.** A read-only company that cannot reach the checkout is a company that
  cannot stop being read-only.
- `GET /v1/billing/invoices` — a read, so the method already lets it through; it declares the
  flag anyway because somebody in arrears needs their invoices more than anybody else does, and
  the intent should survive the route ever changing shape.
- `POST /v1/auth/sign-out` — refusing somebody the ability to sign out is pure spite.
- `POST /v1/sync/report` — a diagnostic report, not the company's data.

One consequence is worth stating plainly: **sync push is refused while a company is read-only.**
Phones keep pulling, because that is a `GET`; work queued on a device stays on the device until
the bill is paid. That is what read-only means, and it is better than the alternative of
silently accepting work into an account nobody is paying for.

---

## Invoices are read, never copied

`GET /v1/billing/invoices` asks the provider for the customer's last twenty-four invoices — two
years of monthly billing — and hands back the number, status, amount, period and the provider's
own hosted and PDF links. The billing page lists them, with money and dates formatted through
`@integr8/i18n` so `£49.00` and `1 October 2026` follow the reader's locale and the currency
symbol is always the invoice's own.

They are **not mirrored into a table**. An invoice is the provider's document: it is paid,
voided or refunded over there, by events this system does not act on, and a copy here would be
the one that was wrong the moment it mattered. Reading it on each visit costs one request to
the provider from a page a company opens a few times a year.

A company with no provider customer — on its trial, never subscribed — gets an empty list, not
an error. The recording fake keeps an in-memory list that tests seed with `issueInvoice`, which is
deterministic by construction so a test can name exact values.

What stays on the provider's hosted portal is **the card and cancellation**: those are writes
against the provider's records, and a form in this app that took a card number would undo the
reason the portal exists.

---

## The webhook, and why it is safe to leave open

`POST /v1/billing/webhook` is `security: 'public'` — the caller is somebody else's server with
no token of ours. Four things stand in for one:

1. **The raw bytes are verified**, not a re-serialised copy. Fastify has no raw-body support, so
   a content-type parser keeps the original string for routes that declare `rawBody`.
2. **The timestamp is checked**, both directions, with Stripe's own five-minute tolerance — so a
   delivery captured off the wire cannot be replayed later.
3. **The signature comparison is constant-time**, and several `v1=` signatures are accepted so a
   secret can be rotated without dropping deliveries.
4. **The event id is stored under a unique constraint.** `billing_events (provider,
provider_event_id)` is the entire idempotency mechanism: a duplicate loses the insert and
   returns having done nothing. The request-level `idempotency_keys` table cannot serve here —
   it is scoped to a company, and a webhook arrives before we know which company it is about.

Retries are normal, not exceptional. Stripe retries for days, so the duplicate path is the
common one rather than the unlucky one — which is why it is a database constraint and not care.

The route answers **200 to anything it has verified**, including events it does not act on. A
provider that receives an error retries for days, and retrying will not make us understand an
event we have no handler for. It answers **400 only when the signature fails**, and says nothing
more than that: the detail goes to our logs, never to whoever sent it.

### How a company is identified

Identity never comes from the payload. A delivery is matched to a company in two ways, in order
of trust:

1. **The customer id we stored** when that company first paid. A stored mapping always wins.
2. **The reference our own checkout call attached.** On `checkout.session.completed` it is
   `client_reference_id`; on the subscription and invoice events it is the `tenant_id` metadata
   that `createCheckout` sets with `subscription_data[metadata]`, which Stripe copies onto the
   subscription and from there onto every invoice. `translate` reads it back as `tenantHint`.

The second way exists because **Stripe does not order deliveries.** For a first purchase,
`customer.subscription.created` and `invoice.paid` usually arrive _before_ the checkout event,
and until the checkout event arrived there was no customer id on file to match them by. They
were recorded as unmatched, answered 200 — so never retried — and the company stayed on `trial`
with a paid subscription's ids, for the trial sweep to turn read-only a fortnight later.

The hint is accepted only when no customer is on file for the delivery, only when it is shaped
like one of our ids, only when it names a company we have, and only when that company has no
_other_ customer on file — our checkout reuses a company's customer id, so a second customer
carrying our reference is not something we produced. A payload naming a company we do not have,
or failing any of those, is recorded and dropped.

The checkout event also carries the price our checkout asked for (`metadata[price_id]`) and
whether the first charge was taken (`payment_status`). When it is the first thing heard about a
subscription it puts the company on that plan and status; when the subscription's own events got
there first — the usual order — it adds only the ids, because those events have already said
more than a checkout can, and a checkout that completed an hour ago must not undo a `past_due`
that arrived since.

---

## Dunning: what happens, and who is never told

From the first failed charge:

1. the webhook writes `past_due_since` and `grace_ends_at`, a fortnight later
   (`BILLING_GRACE_DAYS`);
2. the nightly run posts a reminder every three days;
3. when the grace runs out it sets `read_only_since`, and keeps reminding.

A trial that ends unpaid joins at step 1 with the same fortnight, because "your trial is over"
and "your payment failed" need the same ending and one path is easier to trust than two.

Like the metering sweep, this is not a cron job and not a queue: the worker runs it on its
maintenance timer and claims its turn in `scheduled_task_runs`, so several workers produce one
run a night. `reminders_sent` holds a _position in the cadence_ rather than a count of posts, so
a worker that was down for three days sends the reminder due today instead of three at once.

> **Reminders go two places, since P18: a banner and an email.**
>
> P17 shipped with in-app reminders only, because no email sender existed anywhere in this system —
> which meant a company whose owner never opened the app was never told before their writes
> stopped. P18 built `EmailSender`, and `dunning.ts` now emails the owners and admins on the same
> cadence as the banner. Owners and admins rather than everybody: they are who holds
> `billing.read`, and an engineer cannot update a card.
>
> The email is allowed to fail. A reminder that bounced must not stop the account moving through
> dunning, and must not make the worker retry the run for every other company.

Nothing in the dunning run deletes anything. The worst it does is refuse writes.

---

## Configuration

| Variable                | Default       | What it does                                                  |
| ----------------------- | ------------- | ------------------------------------------------------------- |
| `BILLING_PROVIDER`      | `recording`   | `stripe` or `recording`. Production refuses `recording`.      |
| `STRIPE_SECRET_KEY`     | —             | Required when `stripe`. A secret; `.env` only.                |
| `STRIPE_WEBHOOK_SECRET` | —             | Required when `stripe`. What stops anybody who knows the URL. |
| `BILLING_RETURN_URL`    | `WEB_APP_URL` | Where the hosted pages send the browser back.                 |
| `BILLING_TRIAL_DAYS`    | `14`          | Every company gets a subscription row and a trial on day one. |
| `BILLING_GRACE_DAYS`    | `14`          | From a failed payment to read-only.                           |

A missing Stripe key is **not** a silent fallback to the fake. A deployment that meant to charge
cards and quietly did not is worse than one that refuses to start.

---

## What the platform sees

`/platform/plans` edits every number on a plan — seats, submissions, storage, retention, list
price and the provider's price ids — and a change takes effect within a minute everywhere. A
plan with no provider price cannot be bought, and the checkout says so rather than sending
somebody to a page that fails.

`/platform/companies/:id` shows the subscription: status, interval, renewal, where the dunning
clock stands, how many reminders have gone out, and the provider's own customer and subscription
ids so the next question can be answered with one paste into their dashboard. It is read-only —
a dashboard that could quietly mark a company as paid would be the first place anybody looked
after a discrepancy.
