# MEMORY.md

The project's working memory: where things stand, what was decided and why,
and what is still open. Newest first inside each section. Update it at the end
of any piece of work that changes one of these facts; `CLAUDE.md` is the how-to,
this is the state.

_Last updated: 27 October 2026._

## Current state

- **Version** 1.2.1 (root `package.json`, the only source of truth; a release
  bumps it). `README.md` and `PROJECT_INDEX.md` still say 1.1.2 and "migrations
  reach 0049": both are stale.
- **Migrations** run to `0054_local_identities`.
- **Modules shipped**: field work (customers, sites, work orders, visits and the
  schedule, timesheets), forms and submissions, PDF documents, CRM, sales,
  finance, general ledger, inventory, purchasing, assets, HR, expenses,
  Egyptian payroll, manufacturing, company roles, serial/batch tracking,
  qualifications (0052), contracts + maintenance plans + deadlines (0053), the
  AI assistant (help library or a model), ETA e-invoicing (test-only, not
  certified), company website data API.
- **Branches**: the documented flow is feature → `dev` → `staging` → `main`
  (`.github/workflows/branch-policy.yml`), but on GitHub only `main` exists
  today and recent pull requests (#125–#127) were merged straight into `main`.
  The branch-policy check flags that; it does not block it.

## The deployment

- One Oracle Cloud Always Free ARM machine, `/opt/integr8`, running
  `deploy/compose.yml` behind Caddy, settings in `deploy/.env`.
- Domain `integr8-media.com`: web `app.integr8-media.com`, API
  `api.integr8-media.com`. R2 for files, Resend for mail, Stripe test mode.
- **Sign-in**: the owner has only used the staff login so far and has no
  Supabase project. Plan: `IDENTITY_PROVIDER=local` (Stage 12 part Q of the
  repo guide).
- The owner's own published copy of the setup guide (a claude.ai artifact,
  older 1.1.0 edition with its own part letters):
  https://claude.ai/artifact/HCVbJdp3u9YJT28cCaRw29. It has Stage 15 (demo
  company) and Stage 12 part **M** (sign-in without Supabase); the repo's
  guide calls the same part **Q**. Keep both in step when the procedure
  changes.

## Decisions

- **Built-in sign-in (`IDENTITY_PROVIDER=local`)**, October 2026. The
  `IdentityProvider` interface was already the only place sign-in touched a
  credential store, so `LocalIdentityProvider` replaces Supabase there and
  nothing after it changes. Passwords are scrypt hashes (the format super
  admins already use), in `identities`, reachable only by `integr8_auth`;
  unknown addresses cost the same work as wrong passwords. Default stays
  `supabase` so existing deployments do not change. `admin-cli user-password`
  reuses an existing member's user id, which is how a server moves off
  Supabase without anyone losing their companies.
- **The demo seeder goes through the API**, in-process with Fastify's
  `inject`, as the company's own people (plus a staff impersonation for
  staff-only setup). Direct inserts were rejected: they skip numbering, stock,
  ledger postings and audit, and produce data the screens cannot show. It
  refuses staging/production without `--confirm-production`.

## Recent work (branch `ccr-a47a4d02-8y2u6x`, not yet merged)

1. `feat(api): demo company seeder`: `apps/api/src/demo/` and
   `pnpm --filter @integr8/api demo-company`. One company, nine people (one per
   role, three engineers), every module on, 26 work orders in every state,
   stock, purchasing, manufacturing, assets/contracts/maintenance, forms and
   reports, CRM, sales, HR/payroll, invoices/payments, ETA setup, ledger
   journals. Full run about 30 s on a local database. Setup guide Stage 15.
2. `feat(auth): built-in sign-in without Supabase`: migration 0054,
   `packages/auth/src/local-identity-provider.ts`,
   `packages/db/src/repositories/identities.ts`, `IDENTITY_PROVIDER` in
   `apps/api/src/config.ts`, `admin-cli user-password`. Tested locally end to
   end: seeded logins, invitation acceptance, wrong-password refusal, moving an
   existing member. Guide: Stage 3 step and Stage 12 part Q.

## Open items

- **Magic-link sign-in** works in the API for both providers, but no web,
  desktop or phone screen asks for a link yet; everybody signs in with a
  password. There is also no "forgot password" screen: with
  `IDENTITY_PROVIDER=local`, staff reset a person's password with
  `admin-cli user-password`.
- **The demo seeder with Supabase** was never run against a real Supabase
  project (only the local provider and the test fake).
- **Removing a demo company** is the normal close flow (suspend, export, close,
  purged after seven days); there is no one-step delete.
- `README.md` and `PROJECT_INDEX.md` version and migration counts are stale.
- E-invoicing is test-only: nothing has been sent to the real ETA, and the
  desktop app cannot sign until a token driver is added.
