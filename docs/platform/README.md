# The staff dashboard

Everything Integr8 staff do (onboard, support, suspend, close a company; plans,
billing, flags, templates, releases) is a route under `/v1/platform` and a screen
in the web app's `/platform` dashboard, which wears the Integr8 Media look. The
staff desktop app has none of these screens: staff use it to work **inside** a
company through impersonation, mainly to build forms and set branding.

```
apps/api/src/routes/v1/platform   auth, companies, lifecycle, impersonation, audit, settings,
                                  templates, template-packages, support, staff, storage, funnel,
                                  health, ai, website-keys
apps/api/src/platform             onboarding, app builds, export, purge, admin-cli
apps/web/src/app/platform         companies, funnel, storage, plans, audit, flags, announcements,
                                  templates, releases, health, staff, downloads
```

## Signing in

A platform session is not a company session: its own table
(`platform_sessions`), token type (`platform`) and limits. Staff accounts live in
`platform_users` (scrypt password and an always-required six-digit authenticator
code, its secret sealed with `PLATFORM_SECRET_KEY`; rotating that key makes every
second factor unreadable). Access tokens last 5 minutes, sessions at most 8
hours; lockout after 5 failures. A wrong password, a wrong code and an unknown
address get the same answer. A platform token cannot reach a company route at
all.

**A session limited to test companies.** `POST /v1/platform/auth/sign-in` with
`scope: "test_companies"` (the developer MCP server's terminal login; the
dashboard never asks for it) ends 8 hours after sign-in whatever happens, may
call only routes listing `test_companies` in `platformScopes` (me, sign-out, the
companies list of test companies, one company's page, impersonation, a test
company's outbox and audit lines; pinned by `session-scope.test.ts`), is refused
for any company that is not a test company, starts impersonation only with a
reason beginning `Developer MCP:`, and gets 403 `session_scope` elsewhere,
audited as `platform.session_scope_refused`. New platform routes are closed to it
unless they list the scope.

## Staff

The **Staff** page lists everyone who can sign in; only a **staff manager** (an
account made with the terminal command) changes it: add somebody (a generated
password and authenticator secret shown once), give new credentials, remove
(deactivated, not deleted; sessions and impersonations end). Terminal accounts
are never changed from the dashboard.

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env run --rm api \
  node dist/platform/admin-cli.js create|remove|list|user-password|hr-reseal …
```

Only staff managers manage website keys. Reserve the company slug `staff`.

## Onboarding a company

`POST /v1/platform/companies` makes a usable company in one action: the company
(plan, optional seat count that replaces the plan's, modules, tabs, which apps
show the assistant, test or not), starter job types, the owner's invitation
(emailed only when "Email the owner's invitation now" is ticked, so Integr8 can
set the company up first), and its R2 bucket. The first parts are one
transaction; the bucket comes last and, if it fails, the media maintenance
provisions it later. New companies start on `Africa/Cairo`, Sunday to Thursday,
and are stored as invoiced. The company page can resend or copy a fresh
invitation link (the old one stops working).

Also on the company page: modules and tabs, branding is set from the desktop app
(staff, acting as the company), the document link pattern, "Show the company name
beside the logo", website keys, the AI policy and members' shares, seats,
plan, suspension, export and closing, and **Build apps for this company**
([deployment/](../deployment/README.md#company-apps)).

## Test companies

A company is a test company from creation or never: `tenants.is_test` is written
by the insert and a trigger refuses any change. The demo seeder and `db:volume`
always make test companies; the onboarding form has a **Test company** switch.

| Area            | For a test company                                                                           |
| --------------- | -------------------------------------------------------------------------------------------- |
| Dashboard       | A **Test** badge; the list filters all, real or test (`?test=`)                              |
| Billing         | Left out of billing, lapsed trials, dunning and storage overage                              |
| Totals          | Left out of the sign-up funnel (still in the storage cost projection: Cloudflare bills it)   |
| Email and push  | Never sent: kept in `test_outbox` for 7 days (`GET /v1/platform/companies/{id}/test-outbox`) |
| Company apps    | Refused (409 `test_company_no_apps`)                                                         |
| Everything else | Unchanged: limits, modules, export, close and purge work as for any company                  |

`GET /v1/platform/companies/{id}/test-audit` reads a test company's audit log, so
the developer tool can read back what a call changed.

## Plans and billing

`plan_allowances` (dashboard → Plans): one row per plan (trial, starter,
standard, enterprise) with storage, seats, submissions a month, overage policy,
warning threshold, retention, price and the assistant policy. Three limits are
enforced by the API at the moment something is taken:

| Limit       | Refused when                                             | Error                          |
| ----------- | -------------------------------------------------------- | ------------------------------ |
| Seats       | inviting, accepting an invitation, re-activating someone | 409 `seat_limit_reached`       |
| Submissions | starting and submitting (a correction never counts)      | 409 `submission_limit_reached` |
| Storage     | requesting an upload, on a `block` plan                  | 409 `storage_quota_exceeded`   |

`BILLING_PROVIDER=none` is the production setting: Integr8 invoices every company
itself, every company reads as invoiced, card routes refuse (409
`billing_invoiced`), dunning does nothing, and staff set the plan. `stripe` keeps
self-serve checkout, the card portal, invoices read from Stripe and dunning
(grace, then read-only; never deletion). A Paymob adapter may come later. The
company's Billing page (web) shows its plan and how to reach Integr8.

## Support

Impersonation (full access as a chosen person, a reason of at least ten
characters, audited in the company's and the platform's logs before the grant
exists, re-checked on every request, a banner in every app); recent failures;
unlocking accounts; unsticking a phone's sync; releases in the field (which app
versions are in use); announcements (banners in every app, including the phone);
health (scheduled task runs, the heartbeat).

## Suspending

Every request from the company is refused, reads included: 423 with the reason
shown to its people. Checked after authentication and cached 30 seconds per
process.

## Closing a company

```
export ──▶ schedule (suspends now) ──▶ 7 days, cancel any time ──▶ purge
```

- **Export first, enforced by the database** (`tenant_deletions.export_id` not
  null): the same export a company asking for its data gets, one gzipped JSON
  file kept in a platform bucket. `EXPORTED_TABLES` and `NOT_EXPORTED_TABLES`
  (`packages/db/src/repositories/tenant-data-export.ts`) decide every company
  table, with a reason for each left out; `WITHHELD_COLUMNS` keeps sealed values
  and secrets out. A new table in neither list fails to compile.
- **`purge_tenant()`** (security definer) refuses anything not scheduled and due,
  then empties every table whose `tenant_id` references `tenants` with triggers
  and foreign keys suspended. Safe only while no other table points into that
  set; `tenant-purge.integration.test.ts` checks it. The bucket is emptied
  first, then the rows; Auth accounts belonging to no other company go too. The
  platform audit log, exports and deletions keep their rows.
- One company that cannot be purged does not hold up the others.

Moving a company to another server is a separate staff command
([database/](../database/README.md#moving-a-company-between-servers)).

## The audit logs

`audit_log` (each company's, readable by its owners and admins) and
`platform_audit_log` (Integr8's, outliving companies) are append-only for every
role, the schema owner included, and both are split by year.

## The template library

Built-in form templates are code (`pnpm --filter @integr8/db db:templates`
syncs them); staff-made ones are saved from a company's form or imported from a
`.integr8form` file on the **Templates** page, with their PDF templates and
pictures. See [form-engine/](../form-engine/README.md#the-builder).

## Downloads

**Downloads** (`/platform/downloads`) lists the staff desktop app and Integr8
Forms for AI from the GitHub releases (`GITHUB_RELEASES_TOKEN`, the repository
is private). The public `/download` page lists companies' apps only.
