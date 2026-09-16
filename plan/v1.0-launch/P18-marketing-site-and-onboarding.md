# P18 — Marketing site and self-serve onboarding

**Version:** v1.0 Launch
**Status:** `IN PROGRESS — stage A done: the email sender and the invitation path. Stages B–D not started`
**Depends on:** P17

## Goal

A stranger finds the product, understands it, pays, and is working inside it — with no
involvement from you.

## Scope

The Next.js public surface and the signup-to-productive path.

## Tasks

- [ ] Landing page stating what the product does for whom, in their words
- [ ] Features and pricing pages, with the plan limits stated honestly
- [ ] Signup flow: account → company → Stripe Checkout → provisioned tenant → owner invited
- [ ] Guided first-run: create a job type, clone a starter form, invite an engineer, download the apps
- [ ] Starter form template library visible during onboarding
- [ ] Demo company data, clearly labelled, removable in one click
- [ ] Company settings: branding and logo, working hours, timezone, currency, locale, job types
- [x] User management: invite, deactivate, change role, resend invite
- [~] Billing portal surfacing plan, invoices, seats and current usage
- [ ] Help centre with the first fifteen articles, written from real support questions
- [ ] Analytics on the signup funnel, so you can see where people drop out

Only two of these are touched so far, and only one is finished:

- **User management** is complete. Invite, resend, change role, suspend and remove all exist as
  routes, each refusing to leave a company without an owner. The permissions and the repository
  methods had been sitting there since P07 with nothing joining them.
- **The billing portal** is partly done and was mostly done by P17. The company's `/billing`
  screen shows the plan, the subscription's state, all three limits and the usage against them.
  **Invoices are not surfaced** — they are one click away on the provider's hosted portal, which
  is not the same as being on the screen. No web screen for it is missing; a list of invoices
  read from the provider is.

## Prerequisites the plan did not name

Two things blocked everything on the list above, and neither was a task on it. Both are built.

- **There was no email sender anywhere in this repository.** Not a missing adapter — nothing.
  Supabase's magic-link template was the only way any mail could leave, and it carries Supabase's
  words rather than ours. Self-serve signup, invite delivery, resend and P17's dunning reminders
  all depended on it.
- **`/accept-invitation` did not exist.** The API has minted links to that URL since P15 — from
  onboarding and from the platform's resend button — and the page was a 404. The platform
  dashboard renders a copy-to-clipboard button for a link that went nowhere.

Put together: **every invitation this product had ever created was undeliverable, and pointed at
a page that did not exist.** P18 could not begin without fixing both, so stage A did.

## Stages

- [x] **A — foundation.** `EmailSender` behind an interface; the accept-invitation page;
      invitations that are actually sent; the four member-management routes; P17's dunning reminders
      emailed as well as posted.
- [ ] **B — self-serve signup.** Verify the address, then provision: company, bucket and trial are
      created when the link is clicked and not before. Needs `onboardCompany` reworked to run without
      a platform user behind it, and funnel events with somewhere to live.
- [ ] **C — marketing.** Landing, features, and a pricing page that reads the real
      `plan_allowances` so it cannot disagree with what the API enforces.
- [ ] **D — first run, settings, demo data, templates, help centre.**

## Exit criteria

- [ ] A test user signs up, pays and completes a job in the mobile app, with no manual step from you
- [ ] Time from landing page to first submitted form is under thirty minutes, measured
- [ ] Every plan limit shown on the pricing page matches what the entitlement service enforces
- [ ] The funnel is instrumented and drop-off is visible per step

None are met yet, and none can be until stage B exists — there is still no way for a stranger to
create a company. The third is the one with a design consequence: the pricing page has to read
`plan_allowances` rather than repeat it in copy, or the two disagree the first time somebody
edits a plan from the dashboard.

## Notes

- The guided first run matters more than the landing page. Companies churn in week one
  because nothing happened, not because the marketing was weak.
- Starter templates are your fastest onboarding lever. Ship at least six real ones for
  your target trade.

## Decisions taken before building

- **An email sender behind an interface, switched off.** `EmailSender` with a Resend adapter and a
  recording fake, chosen by `EMAIL_SENDER` exactly as `BILLING_PROVIDER` and `PUSH_SENDER` are. No
  keys in the repository; production refuses the fake, and refuses to start without `WEB_APP_URL`
  because every link in every message points there.
- **Trial first, card later — not the order this plan's task list says.** The task reads
  "company → Stripe Checkout → provisioned tenant", but P17 already provisions every company with
  a fourteen-day trial and no card. Following the wording would mean creating tenants from inside
  a Stripe webhook retry path, which cannot be made idempotent with the current tenant-scoped
  dedupe table. The plan's wording loses to the code that exists.
- **Verify the address, then provision.** Signup creates nothing — no company, no bucket, no
  trial — until the verification link is clicked. A throwaway address still gets through; a bot
  that never reads mail does not, and nothing is provisioned for an address nobody owns.
- **The funnel is our own table, read by the P15 dashboard.** Pre-tenant steps have nowhere else
  to live: `audit_log` is tenant-scoped and cannot record a signup that has not created a tenant
  yet. No third-party script on a public marketing site, so no consent banner and no visitor data
  leaving the infrastructure.

## Found while building this

- **"Signed out everywhere" does not end an access token.** A tenant access token is a stateless
  JWT lasting fifteen minutes, and the request pipeline re-reads the database only for platform
  sessions and impersonation grants. Revoking somebody's sessions kills their refresh — they
  cannot sign in or renew — but the token already in their hand keeps working. So a suspended or
  removed person has up to fifteen minutes of full access. The route descriptions claimed
  otherwise until this was checked; they now say what is true, and the window is documented at the
  top of `members.ts`. **Closing it needs a per-request membership check, which is a cost on every
  request and a decision to take deliberately** — not one to slip into a stage of P18. For
  "remove the engineer dismissed this morning", fifteen minutes may not be acceptable.
- **Tenant creation is structurally platform-only.** `onboardCompany` takes an `onboardedBy:
PlatformUserId`, writes it to `tenants.onboarded_by`, and attributes the seeded job types and
  the audit entry to it. Self-serve signup has no platform user, so this is a signature and an
  attribution change rather than just a new route. Stage B's first job.
- **Onboarding is not idempotent and cannot easily be made so.** The dedupe table is tenant-scoped
  and a signup has no tenant yet. Today only the slug's unique index protects it — and in a
  self-serve flow the slug is chosen by the user, so a double submission needs explicit design.
- **Three copies of the accept-invitation URL had already appeared** across two platform routes
  and the implied web page. Collapsed into `email/links.ts`. A link built in three places is a
  link that is wrong in two of them eventually.
- **Only three form templates exist**, against this plan's stated minimum of six. They live in
  code (`packages/form-engine/src/templates/index.ts`) and are seeded into a global, tenant-less
  table, so adding more is content rather than engineering. The clone routes also require an
  authenticated tenant session, so showing the library _during_ onboarding needs a pre-tenant
  route.
- **Company settings are greenfield.** Of the six named in the task list, only job types exist.
  There is no settings table, no settings route, and no per-company timezone, currency or locale —
  locale today is a per-user browser cookie.
