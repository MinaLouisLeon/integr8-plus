# Running the business

Everything a super admin does — onboard a company, support one, suspend one, close one — is a
route under `/v1/platform` and a screen in the dashboard (P15). Nothing here needs a terminal,
a psql session or the Cloudflare console, which is the whole point: any manual step becomes the
bottleneck the moment there are ten customers.

```
apps/api/src/routes/v1/platform
  auth.ts           sign in, refresh, sign out, who am I
  companies.ts      the directory, one company, onboarding, suspend, reactivate, plan
  lifecycle.ts      export, schedule a deletion, cancel it
  impersonation.ts  act as a user, stop, and every time anybody did
  audit.ts          the platform audit log, and the one way to write to it
  settings.ts       feature flags, announcements
  templates.ts      the global form template library
  support.ts        recent failures, unlock, unstick sync, releases in the field
        │
apps/api/src/platform
  onboarding.ts     company + job types + owner invitation + bucket, in one action
  export.ts         everything a company has, as one gzipped JSON file
  purge.ts          bucket first, then rows — see below
        │
@integr8/auth       PlatformSessionService: password, then a six-digit code
@integr8/db         platform_sessions, platform_audit_log, feature_flags, announcements,
                    tenant_exports, tenant_deletions, purge_tenant()
```

---

## Signing in

A platform session is **not** a tenant session, all the way down: a different table, a
different token type, a different lifetime.

|                   | Customer      | Super admin                                  |
| ----------------- | ------------- | -------------------------------------------- |
| Credentials       | Supabase Auth | `platform_users`, scrypt, beside the account |
| Second factor     | —             | Always. Six digits, RFC 6238                 |
| Token `typ`       | `access`      | `platform`                                   |
| Carries a company | `tid`, always | Nothing. There is no company                 |
| Access token      | 15 minutes    | 5 minutes                                    |
| Session ceiling   | 90 days       | 8 hours                                      |

The third token type was the alternative to letting `tid` be null on an access token. A
nullable `tid` would have meant every handler in the system asking whether the company it was
about to act for was really there. A separate type means a platform token cannot reach a tenant
handler at all: `verifyAccessToken` rejects it on `typ` before the claims are read.

Both factors are always checked, even when the password is wrong and even when the account is
not set up, so the time an answer takes does not say which half failed. A wrong password, a
wrong code and an unknown address are the same sentence. A locked account is the one case that
says more, because waiting is the fix and the person needs to know that.

The TOTP secret is encrypted at rest with `PLATFORM_SECRET_KEY` (AES-256-GCM). A stolen
database backup yields nothing without the key; a stolen key yields nothing without the backup.
**Rotating that key makes every enrolled second factor unreadable** and every super admin has
to enrol again — plan it.

---

## Onboarding a company

One call, `POST /v1/platform/companies`, and a company is usable:

1. the company row, with its plan and seat count;
2. **roles** — nothing to do. Roles are a fixed set in `@integr8/core`, not rows;
3. job types, because a company with none cannot raise a job and an empty list is the first
   thing that makes a new customer think the product is broken;
4. the owner's invitation — the only way in. We never set a password for somebody else;
5. the R2 bucket, so their first upload does not fail.

The first four are one transaction. The bucket is not, because a call to Cloudflare cannot join
a database transaction, so it happens last and a failure there leaves a company that is complete
except for storage. That is recoverable and already handled: the media maintenance sweep
provisions any company whose bucket is missing, and the response says what happened rather than
pretending.

### Inviting the owner when the company is ready

Onboarding creates the owner's invitation but **does not email it unless asked**
(`sendInvitation: true`, the "Email the owner's invitation now" box). Integr8 sets a company up
first — its forms, job types and look — and the owner should arrive to a company that is ready,
not to an empty one. The link is returned either way, to copy if wanted.

The company's page lists every invitation nobody has accepted, with its expiry, and offers two
actions, both through `POST /v1/platform/companies/:tenantId/invitations/:invitationId/resend`:

| Action              | Body                     | Does                                                              |
| ------------------- | ------------------------ | ----------------------------------------------------------------- |
| **Send invitation** | `{}`                     | A fresh seven-day invitation, emailed from Integr8 through Resend |
| **Copy a new link** | `{ "sendEmail": false }` | The same fresh invitation, nothing sent; the link is copied       |

Both withdraw the previous invitation, so an old link that went astray stops working, and both
work on an invitation that already expired while the company was being set up.

---

## Suspending

**Every request is refused, reads included** — 423, with the reason the customer is shown.

The alternative was read-only, and it lost. A suspension is a commercial event, not a
maintenance window, and "you can still see your jobs but not finish them" is a state nobody
standing in a plant room can act on. One clear answer beats half-working software.

The check is after authentication — until then there is no company to check — and the status is
cached for 30 seconds per process. That cache is why the exit criterion says _within one
minute_ rather than _immediately_; the alternative is a `tenants` read on every request for a
state that changes a handful of times a year. The dashboard clears its own cache entry when it
suspends somebody, so whoever pressed the button sees the effect at once.

---

## Impersonation

A super admin gets **full access as that user** — anything the user can do. A read-only mode
would mean reproducing half of every reported problem, which is no use to the person who
reported it.

What makes that acceptable is the other half of the same decision:

- the audit entry is written **before** the grant exists, and the grant carries a non-null
  foreign key to it. There is no ordering of those writes that produces a session with no
  entry;
- the grant is re-checked on **every** request, so ending it takes effect now rather than
  whenever the access token happens to lapse;
- the token says who is really behind it, in a claim all three apps read to paint a banner. The
  plan is blunt about why: _support engineers who forget they are impersonating cause the worst
  incidents_;
- a reason of at least ten characters, enforced by a check constraint rather than by a form.

Both audit logs get an entry: the company's, which they can read, and the platform's, which
outlives them.

---

## Closing a company

Export, wait, then purge. Four options were considered and this one is the only one that makes
the single irreversible act in the system reversible for a week.

```
export  ──▶  schedule  ──▶  (7 days)  ──▶  purge
             suspends               cancel any time until here
             immediately
```

- **The export comes first, and the database enforces it.** `tenant_deletions.export_id` is not
  null, so a schedule without a finished export cannot be written. It is the same export a
  customer asking for their data would be given — there is no "deletion export" that quietly
  holds less.
- **The archive lives in a platform bucket, not the company's.** The purge destroys the
  company's bucket, so an export kept there would be deleted by the act it exists to justify —
  while `tenant_exports`, which has no foreign key to `tenants` precisely so it outlives the
  company, went on saying the archive was ready.
- **The company is suspended when the deletion is scheduled**, not when it runs: a company on
  its way out should not be accruing data somebody then has to decide what to do with.
- **Cancelling until the purge runs undoes everything.** It leaves the company suspended rather
  than active, because whoever called the deletion off decides separately whether to start
  serving them again.
- **`purge_tenant()` refuses anything not scheduled and due**, so even the schema owner cannot
  remove a company early. It works out its own delete order, because nearly every tenant table
  is `on delete restrict`, and it lifts the append-only guards on `audit_log`,
  `submission_events` and `work_order_events` for the length of the purge — a company's history
  goes only when the company does. `platform_audit_log` is deliberately not on that list.

**Bucket first, then rows.** The two stores cannot be emptied atomically, so the order is the
decision:

- bucket first, rows second — a crash in between leaves rows pointing at objects that are gone.
  Recoverable, visible, and the purge simply runs again.
- rows first, bucket second — a crash in between leaves a bucket nobody has a record of: a
  customer's data sitting in Cloudflare with nothing left to say whose it was or that it should
  go.

The second is the one that ends up in a regulator's letter.

---

## The audit log

`platform_audit_log` is append-only in the database, for every role including the schema owner:
three statement-level triggers refuse update, delete and truncate. There is no arrangement of
application code that can lose an entry, which is what makes it worth reading in an
investigation.

It has **no foreign key to `tenants`** and keeps `tenant_slug` beside `tenant_id`, so the record
of a company outlives the company. Searching is by keyset rather than offset, so paging through
a log that is being written to cannot repeat or skip an entry.

---

## What the apps are told

`GET /v1/me` carries three things from the platform, so no client needs a poll of its own:

- `features` — this company's flags, resolved against the platform default. Like `permissions`,
  it is what to show, not what is allowed;
- `announcements` — banners, by language tag, with `dismissible`;
- and a suspension is not a field here at all: a suspended company's `/v1/me` is a 423.

---

## What is deliberately not here

- **Desktop and web versions in the release view.** Only `sync_reports.app_version` records a
  client's version, and only the phone writes it. Desktop and web send `x-client-version` on
  every request and nothing writes it down. The fix is to record it, not to guess it here.
- **"API calls" per company.** There is no request-level counter and no honest way to derive
  one. The per-company activity view counts audited actions instead, which is what people mean
  when they ask how busy a customer is.
- **Clearing one device's sync queue.** The queue lives on the device. What the server can do is
  forget the change log so every device bootstraps again, which fixes the failure people
  actually report. Nothing queued on a device is lost: the outbox is untouched.
