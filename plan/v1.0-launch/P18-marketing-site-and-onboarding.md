# P18 — Marketing site and self-serve onboarding

**Version:** v1.0 Launch
**Status:** `IN PROGRESS — everything built and tested; the copy is a first draft and one exit criterion needs a real run`
**Depends on:** P17

## Goal

A stranger finds the product, understands it, pays, and is working inside it — with no
involvement from you.

## Scope

The Next.js public surface and the signup-to-productive path.

## Tasks

- [x] Landing page stating what the product does for whom, in their words
- [x] Features and pricing pages, with the plan limits stated honestly
- [x] Signup flow: account → company → Stripe Checkout → provisioned tenant → owner invited
- [x] Guided first-run: create a job type, clone a starter form, invite an engineer, download the apps
- [x] Starter form template library visible during onboarding
- [x] Demo company data, clearly labelled, removable in one click
- [~] Company settings: branding and logo, working hours, timezone, currency, locale, job types
- [x] User management: invite, deactivate, change role, resend invite
- [~] Billing portal surfacing plan, invoices, seats and current usage
- [x] Help centre with the first fifteen articles, written from real support questions
- [x] Analytics on the signup funnel, so you can see where people drop out

Three of these need their marks explained, because a tick that means something different from
what the line says is worse than no tick at all.

- **The signup flow does not follow the order written above.** The task says "company → Stripe
  Checkout → provisioned tenant"; what was built is trial first, card later. P17 already gives
  every company a fourteen-day trial, and provisioning from inside a Stripe webhook retry path
  cannot be made idempotent — the dedupe table is tenant-scoped and a signup has no tenant. The
  plan's wording lost to the code that already existed. "Owner invited" is also wrong for
  self-serve: the owner is made directly, because they have just proved they own the address and
  emailing somebody an invitation to a company they created themselves would be absurd.
- **Company settings is `[~]`: there is no logo upload.** The column and the foreign key exist and
  point at the media ledger, so a logo is metered and purged like any other file. No screen sets
  it. Everything else on that line — working hours, timezone, currency, locale, job types — is
  done.
- **The help centre is `[x]` but not written from real support questions**, because there are no
  customers and therefore no support questions. Fifteen articles exist, written from how the
  product actually behaves, and **the help page says so at the top** rather than implying a
  provenance they do not have. They are the first thing to rewrite once real questions exist.
- **The billing portal stays `[~]`**, unchanged from stage A: plan, subscription state, all three
  limits and the usage against them are on the screen; invoices are one click away on the
  provider's hosted portal, which is not the same as being surfaced.

## Prerequisites the plan did not name

Two things blocked everything on the list above, and neither was a task on it.

- **There was no email sender anywhere in this repository.** Not a missing adapter — nothing.
- **`/accept-invitation` did not exist**, despite the API minting links to it since P15.

Put together: **every invitation this product had ever created was undeliverable, and pointed at
a page that did not exist.** Both were fixed first.

## Stages

- [x] **A — foundation.** `EmailSender` behind an interface; the accept-invitation page;
      invitations that are actually sent; the four member-management routes; P17's dunning
      reminders emailed as well as posted.
- [x] **B — self-serve signup.** Verify-then-provision, `onboardCompany` reworked to run with no
      platform user behind it, the funnel table and its dashboard screen.
- [x] **C — marketing.** Landing, features, and a pricing page that reads the real
      `plan_allowances`.
- [x] **D — first run, settings, demo data, templates, help centre.**

## Exit criteria

- [~] A test user signs up, pays and completes a job in the mobile app, with no manual step from you
- [ ] Time from landing page to first submitted form is under thirty minutes, measured
- [x] Every plan limit shown on the pricing page matches what the entitlement service enforces
- [x] The funnel is instrumented and drop-off is visible per step

**The first is met except for "pays".** `signup.integration.test.ts` proves a stranger signs up,
verifies, gets a company with job types, storage, a trial and an active owner, and can sign in —
with no manual step. Paying cannot be proven without a Stripe account; P17 proves everything up
to the provider's own hosted page.

**The second is unmeasured, not unmet.** The funnel records the steps it would be measured from,
but nobody has walked the path with a stopwatch. It needs a person, not a test.

**The third is structural rather than asserted.** The pricing page renders `GET /v1/plans`, which
returns the same `plan_allowances` rows the entitlement service reads. It cannot disagree, because
there is only one source.

**The fourth** is `signup_events`, the `/v1/platform/funnel` route and the dashboard screen, with
tests covering both that the pre-tenant steps are recorded and that no personal data reaches the
table.

## Notes

- The guided first run matters more than the landing page. Companies churn in week one
  because nothing happened, not because the marketing was weak.
- Starter templates are your fastest onboarding lever. Ship at least six real ones for
  your target trade.

## Decisions taken before building

- **An email sender behind an interface, switched off.** Resend adapter, recording fake, chosen by
  `EMAIL_SENDER`. Production refuses the fake and refuses to start without `WEB_APP_URL`.
- **Trial first, card later**, against this plan's own task wording. See above.
- **Verify the address, then provision.** Signup creates nothing until the link is followed.
- **The funnel is our own table**, read by the P15 dashboard. No third-party script on a public
  site, so no consent banner and no visitor data leaving the infrastructure.

## Decisions taken while building

- **`signup_events` carries no personal data, and a test enforces it.** It answers "how many gave
  up here", never "who". The funnel screen counts page steps as visits and everything from
  `signup.started` as attempts, and says so on the screen, because presenting the two as one
  series would overstate the top and exaggerate every drop below it.
- **`is_demo` is a column on the row, not a list of ids.** A list goes stale the moment somebody
  edits a demo customer into something real, and then "remove sample data" deletes their work.
- **The first-run checklist is computed, never stored.** A stored flag says "you have invited
  somebody" long after that person was removed.
- **The slug is derived from the company name.** Letting a self-serve caller choose it means two
  people racing for the same one, and the unique index is the only protection onboarding has.
- **Every signup answer is identical** whether or not the address already has a company.

## What is deliberately not here

- **A logo upload screen.** The column, the foreign key and the metering all exist.
- **Real support questions.** There are no customers.
- **Final marketing copy.** The positioning is not settled, and the words on the landing and
  features pages are a first draft to be rewritten by whoever owns it.
- **A content pipeline.** Fifteen articles live in a TypeScript module. Building a CMS for them
  would be the tail wagging the dog; moving them later is a find-and-replace.

## Found while building this

- **"Signed out everywhere" does not end an access token.** A tenant access token is a stateless
  JWT lasting fifteen minutes, and the pipeline re-reads the database only for platform sessions
  and impersonation grants. A suspended or removed person keeps full access for up to fifteen
  minutes. The route descriptions claimed otherwise until this was checked; they now say what is
  true, the window is documented at the top of `members.ts`, it is stated on the people screen,
  and a help article covers it. **Closing it needs a per-request membership check — a cost on
  every request and a decision to take deliberately.**
- **The schema invariants suite caught a cross-tenant foreign key.** `tenant_settings.logo_media_id`
  pointed at `files (id)` alone, which would have let a company set its logo to another company's
  file. It carries `(tenant_id, logo_media_id)` now. The suite was right and the migration was
  wrong.
- **A test that pins an exact list of templates fails for the crime of adding a template.** The
  forms suite asserted three keys in order; it asserts the set of shipped templates now.
- **`onboardCompany` needed a signature change, not a new route.** It took a `PlatformUserId`,
  wrote it to the tenant row, and attributed the seeded job types and the audit entry to it.
  Self-serve has no platform user, so `actor_kind = 'system'` with a null actor — which is what
  the check constraint has required since 0001 and what is actually true.
- **Onboarding still cannot be made idempotent**, which is why the slug is derived and
  `markVerified` is conditional on the request still being pending. A mail client that prefetches
  links would otherwise create two companies from one signup.
- **Three field types were wrong in the new templates**, caught by the compiler: `checkbox` is a
  single boolean rather than a multiple choice, `photo` takes `maxFiles`, and there is no
  `integer` type. The engine's schema is strict enough that a bad template cannot ship.
