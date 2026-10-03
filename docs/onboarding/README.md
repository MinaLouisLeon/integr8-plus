# Signing up, and the first hour

A stranger finds the product, pays for it and is working inside it, with nobody at your end
involved (P18).

```
apps/web  /                        landing
        │  /features /pricing      what it does, and what it costs
        │  /help                   fifteen answers
        │  /sign-up                two fields, then an email
        │  /sign-up/verify         where the company is actually created
        │  /accept-invitation      where an invited engineer joins
        │  (app)/get-started       the five-step checklist and the sample data
        │  (app)/settings/people   invite, resend, change role, suspend, remove
        │  (app)/settings/company  logo, branding, timezone, currency, hours
        │  platform/funnel         where people give up, and landing to first form
        │
apps/api  routes/v1/signup.ts      POST /v1/signup, /verify, /resend, /step
        │  signup/service.ts       verify-then-provision, and the funnel steps
        │  routes/v1/settings.ts   company settings, and the public /v1/plans
        │  routes/v1/onboarding.ts the checklist, and the sample data
        │  routes/v1/members.ts    managing the people already here
        │  email/                  EmailSender, the messages, the links
        │
@integr8/db  migration 0018       signup_requests, signup_events,
                                   tenant_settings, is_demo
```

---

## Nothing is created until the address is proved

`POST /v1/signup` writes **one row** and sends **one email**. No company, no R2 bucket, no trial,
no identity at Supabase. All of that happens at `POST /v1/signup/verify`, and only then.

Two reasons, and the second is the one that actually decided it:

- A bot that never reads mail costs us a row. A bot that does read mail is a person with a
  mailbox, which is as far as free signup can reasonably be policed.
- **A company created for an address nobody owns cannot be cleaned up.** The person who later
  gets that address cannot close it, and we cannot delete it without deleting somebody's data.
  Not creating it is far easier than unpicking it.

A pending request expires after a day, and the `signup.expire` task ages out the rest. Nothing
was created, so nothing is lost.

### Every answer is the same

`POST /v1/signup` returns `202 {"accepted": true}` for an address that already has a company and
for one that does not — the same status, the same bytes. An endpoint that distinguishes them
enumerates your customers one guess at a time. The person who owns the address finds out in their
inbox, which is the only place it is safe to say.

The same applies to `/resend` and to verification: expired, spent and never-existed are one
error, `invalid_signup_token`.

---

## Trial first, card later — against the plan's own wording

P18's task list says _company → Stripe Checkout → provisioned tenant_. That is not what was
built, and the disagreement is deliberate.

P17 already provisions every company with a fourteen-day trial and no card. Following the
wording would mean creating tenants from inside a Stripe webhook retry path — and onboarding
**cannot be made idempotent**, because the deduplication table is tenant-scoped and a signup has
no tenant yet. A retried webhook would create a second company.

So the trial comes first and the billing screen P17 built takes the card whenever they choose.
The plan's wording lost to the code that already existed.

---

## `onboardCompany` without a super admin

The function has always taken `onboardedBy: PlatformUserId`, written it to `tenants.onboarded_by`,
and attributed the seeded job types and the audit entry to it. Self-serve has no platform user, so:

- `onboardedBy` is now **nullable**, and a null writes `actor_kind = 'system'` on the audit entry
  with a null actor — which is what the check constraint has always required and what is actually
  true. Borrowing a super admin's id would be a lie in the table people read to work out who did
  what.
- `ownerAccess` says how the owner gets in. `invitation` mints a token to email, which is the
  platform path where the owner is a stranger to whoever is onboarding them. `direct` makes them
  an active owner immediately, which is the self-serve path: they have just proved they own the
  address, and emailing somebody an invitation to a company they created themselves would be
  absurd.
- The **slug is derived** from the company name with a numeric suffix until one is free. Letting a
  self-serve caller choose it would mean two people racing for the same slug, and the unique index
  is the only protection onboarding has.

---

## The order inside verification

Claim first, then identity, then company, then mark it verified.

**The claim** is `signup.claim`: `pending` → `verifying` in one conditional update (migration
0020 added the status). It happens before anything is created, so a mail client that prefetches
links — or a person who double-clicks — makes one company, not two: the second finds no pending
row to claim and is told the link is spent. The first version of this flow checked `pending`,
provisioned, and only then ran the conditional update. Two verifies at once both passed the
check; with the fake identity provider both made a company, and with GoTrue the second was
refused as a duplicate address and left the request pending for ever, so an address that already
had an identity could never finish signing up.

**Identity before company.** A failure creating the identity leaves nothing; a failure creating
the company leaves an identity that can simply sign up again. The reverse order leaves an orphan
company that nobody can reach. An identity the address already has — a member of another
company, or an account left over from one — is found with `findByEmail` and used rather than
created: the person has just proved they own the address. The password they typed is not applied
to it, because following a signup link is not a password reset for a credential some other
company's sign-in may rest on; they sign in with the one they have, or with a magic link.

**Any failure between the claim and the mark** releases the claim (`verifying` → `pending`) and
records `signup.failed`, so the same link works once the provider is back. A process that dies in
between leaves a `verifying` row that nothing touches; the person starts again. The expiry sweep
deliberately leaves `verifying` alone, so a request being provisioned at the moment it expires
cannot be marked expired under the verify that is finishing it.

---

## The funnel

`signup_events` exists because **`audit_log` could not serve**: it is tenant-scoped, and every
interesting step here happens before a tenant exists. A signup abandoned at the second step has
no tenant to attribute it to, and those are exactly the rows worth having.

It carries **no personal data**. A step name, an optional plan, and an id tying the steps of one
attempt together. It answers _how many gave up here_, never _who_ — and there is a test asserting
that neither an address nor a company name appears in it.

**Counted two ways, and the dashboard says so.** From `signup.started` onwards each attempt has an
id and is counted once. The page steps before that have no id — nobody has identified themselves
and nothing should be invented — so those count visits. Presenting them as one series without
saying so would overstate the top of the funnel and make every drop below look worse than it is.

No third-party analytics. A hosted script on a public marketing site brings cookie-consent
obligations and sends visitor data off your infrastructure, for a question a table answers.

### Landing to first form, measured

P18's second exit criterion — _time from landing page to first submitted form_ — is measured by
the same route, as a **median over the companies created in the window**, with the count of
companies it was taken across. `PlatformInsightsRepository.timeToFirstSubmission` joins each
verified `signup_requests` row to its `signup.provisioned` event (falling back to
`signup.started` on the same request, since funnel writes are allowed to fail) and to the
company's earliest `submissions.submitted_at`, across every tenant on the owner connection.

**The clock starts when the company exists, not at the landing page**, and the dashboard says
so. The page views before that carry no id and cannot honestly be tied to a company; the first
moment that can is the signup request, and the moment the company came to exist is the one that
means "they are inside the product". A median rather than a mean, because the first dozen
companies will include one that signed up on a Friday and filled in a form on Monday.

The response carries company ids and seconds. The no-personal-data test covers it.

---

## Sample data, and why the label is on the row

`is_demo` is a column on `customers`, `sites` and `work_orders`, not a list of ids kept somewhere.

A list goes stale the moment somebody edits a demo customer into a real one — and then "remove the
sample data" deletes their work. Marked on the row, the label travels with it, and
`demo.claim(...)` clears the flag when a row becomes real. After that, removal leaves it alone,
which is correct behaviour rather than a special case.

Removal deletes jobs, then sites, then customers: the foreign keys are `on delete restrict`.

---

## The first-run checklist is computed, never stored

There is no `has_invited_someone` column. Every tick on `/get-started` is a count taken when the
page loads.

A stored flag drifts from the truth the first time somebody removes the only engineer they
invited, and then the checklist cheerfully says a step is done that is not. The cost is a handful
of cheap queries once a day per company; the benefit is a checklist nobody has to distrust.

---

## Pricing reads the same rows the API enforces

`GET /v1/plans` is public and returns `plan_allowances` — the same rows `assertSeatAvailable` and
`assertSubmissionAllowed` read. The pricing page renders those numbers and writes none of its own.

That is the exit criterion — _every plan limit shown on the pricing page matches what the
entitlement service enforces_ — and it is the only way to guarantee it. Numbers typed into
marketing copy are a second source of truth, and the two disagree the first time somebody edits a
plan from the dashboard.

A plan with no provider price is shown as "talk to us": hiding it would make the page lie about
what exists, and offering it would send somebody to a checkout that refuses them.

---

## What is honestly not finished

- **The help articles are not written from real support questions**, because there are no
  customers and therefore no support questions. They are written from how the product behaves,
  the help page says so at the top, and they are the first thing to replace once real questions
  exist.
- **The marketing copy is a first draft.** The positioning is not settled, and the words on the
  landing and features pages should be rewritten by whoever owns it.
- **The logo is a file like any other.** The company settings screen uploads it through the same
  three-step media flow a photo uses, and `PATCH /v1/settings` refuses anything that is not a
  stored image of that company's. It is not yet drawn on any document the product sends out,
  because no document the product sends out carries branding yet.
- **The thirty-minute number does not exist until a real company has produced it.** The
  measurement runs automatically; the test proves it measures, not that the target is met.
