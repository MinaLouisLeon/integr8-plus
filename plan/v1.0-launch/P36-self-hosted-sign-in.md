# P36 — Self-hosted sign-in

**Version:** v1.0 Launch
**Status:** `NOT STARTED` — plan written 2026-10-30, waiting for approval to implement
**Depends on:** P03 (authentication), P15 (platform purge)

## Goal

Everything Integr8 Plus needs runs on our own server. Sign-in moves from Supabase's cloud to a
Supabase Auth container beside the API, and a person who forgets their password can get back in
with a 6-digit emailed code and set a new one.

## Scope

Agreed on 2026-10-30:

- **Self-host everything.** No Supabase cloud project. The database was already self-hosted
  (`deploy/compose.yml`); sign-in joins it.
- **Only Supabase Auth, not the full Supabase stack.** The product uses Supabase for identity
  only (passwords and sign-in codes). The other ~11 self-hosted Supabase services (gateway,
  REST, realtime, storage, Studio, …) are never used: clients never talk to Supabase directly.
- **Fresh start.** There are no users and no data on the server, so nothing is migrated.
- **Forgotten passwords:** a "sign in with an emailed code" flow on web, desktop and phone, and
  a "Change password" screen.
- **Email format:** a 6-digit code only. No links, so no deep-link setup in the desktop or phone
  apps.
- **Change password proof:** the current password, or a sign-in with an emailed code in the last
  15 minutes.
- **After a password change:** every other signed-in device is signed out, including phones'
  offline access.
- **Company purge:** deletes each person's sign-in account, unless they still belong to another
  company.
- **Server hardening** for sharing the VPS with MyRooms: ports bound to `127.0.0.1` only, and a
  memory cap per container.
- **Setup guide:** Stage 10 ("Moving the database to Supabase") is deleted and later stages are
  renumbered. The test box section is rewritten for Ubuntu 24.04 LTS with Arcane.
- **Railway is dropped** as a hosting option.
- **Password-changed email:** after a change, the address gets "your password was changed", in
  English or Arabic.
- **Database runbooks:** the Supabase setup runbook is deleted, and the backup and restore runbook
  is rewritten for the self-hosted database: nightly dumps with the existing script.

Out of scope: new backup tooling (point-in-time recovery, WAL archiving), two-factor sign-in for
company users, and changing the email address of an account.

## Where things stand (audit, 2026-10-30)

Every place the product touches identity:

| Flow                                                              | Uses Supabase Auth                     | Today                     |
| ----------------------------------------------------------------- | -------------------------------------- | ------------------------- |
| Company user signs in with a password (`/v1/auth/sign-in`)        | Yes: `POST /token` (password grant)    | Works                     |
| Invitation accepted (`/v1/invitations/accept`)                    | Yes: find user, create user (admin)    | Works                     |
| Self-serve sign-up verified (`/v1/signup/verify`, off by default) | Yes: find user, create user (admin)    | Works                     |
| Sign-in link (`/v1/auth/magic-link`, `/complete`)                 | Yes: `POST /magiclink`, `POST /verify` | **No screen uses it**     |
| Forgotten password                                                | —                                      | **No flow exists**        |
| Change password                                                   | —                                      | **No flow exists**        |
| Refresh, switch company, sign out, sessions, devices              | No: the API's own tokens               | Unaffected                |
| Impersonation, 7-day offline access                               | No: the API's own tokens               | Unaffected                |
| Integr8 staff sign-in (password + 6-digit authenticator code)     | No: scrypt hashes in our database      | Unaffected                |
| Company purge                                                     | No                                     | **Accounts left in Auth** |

Findings:

- **The sign-in link is half-built.** The API routes, the client method
  (`packages/api-client/src/session.ts`) and the button's text (`auth.magicLink` in
  `@integr8/i18n`) exist, but no screen shows the button, no page opens the link, and no email
  template was ever set up. The help article "Trouble signing in"
  (`apps/api/src/ai/help/articles.ts`) tells people to use it anyway.
- **Nobody could reset a password once self-hosted.** On Supabase's cloud, staff could reset one
  from Supabase's dashboard. Self-hosted, that dashboard is gone.
- **All identity calls go through one interface**, `IdentityProvider`
  (`packages/auth/src/identity-provider.ts`), with `SupabaseIdentityProvider` for real use and
  `FakeIdentityProvider` for tests. The switch is contained.
- **The provider adds `/auth/v1` to every path.** Supabase's cloud serves Auth under that prefix;
  the standalone Auth container serves at `/`.

## Checked against Supabase Auth v2.197.0 (2026-10-30)

Read from the source of `supabase/auth` at tag `v2.197.0`, the newest stable release (published
2026-09-09; amd64 and arm64 images):

- **Every endpoint the product needs exists, at the root:** `POST /token?grant_type=password`,
  `POST /verify`, `GET /admin/users?filter=`, `POST /admin/users`, `PUT /admin/users/{id}`,
  `DELETE /admin/users/{id}`, `POST /admin/generate_link`.
- **`POST /admin/generate_link` creates a code without sending anything.** Its answer includes
  `email_otp` (the code) and `hashed_token`. So the API sends the code through its own email
  sender, in the person's language, and Auth needs no email settings at all.
- **Database:** Auth runs its own migrations at start-up, all inside one schema (`DB_NAMESPACE`,
  default `auth`). It needs a role that owns that schema. One migration grants `select` to a role
  named `postgres`, which the official `postgres` image has. No extensions are needed.
- **Admin access:** an HS256 token signed with `GOTRUE_JWT_SECRET`, with no key id and a `role`
  listed in `GOTRUE_JWT_ADMIN_ROLES`. We set that list to `service_role` and generate the key
  ourselves.
- **Rate limits:** Auth's per-IP limits apply only when `GOTRUE_RATE_LIMIT_HEADER` is set. Every
  request comes from the API container's one address, so it stays unset; the API already limits
  per IP and per address, and locks accounts.

## Design

### 1. The Auth container

- **Image:** `supabase/auth:v2.197.0`, pinned like everything else. Upgrades go through
  Dependabot or by hand, never `latest`.
- **Network:** no published port. Only the API reaches it, as `http://auth:9999`.
- **Settings** (in `deploy/compose.yml`, values from `deploy/.env`):

  | Setting                         | Value                                                     |
  | ------------------------------- | --------------------------------------------------------- |
  | `GOTRUE_API_HOST` / `PORT`      | `0.0.0.0` / `9999`                                        |
  | `API_EXTERNAL_URL`              | `http://auth:9999` (required; never shown to anyone)      |
  | `GOTRUE_DB_DRIVER`              | `postgres`                                                |
  | `GOTRUE_DB_DATABASE_URL`        | `postgres://supabase_auth_admin:…@postgres:5432/integr8`  |
  | `DB_NAMESPACE`                  | `auth`                                                    |
  | `GOTRUE_SITE_URL`               | the web app's address (`WEB_APP_URL`)                     |
  | `GOTRUE_JWT_SECRET`             | `SUPABASE_AUTH_JWT_SECRET`                                |
  | `GOTRUE_JWT_ADMIN_ROLES`        | `service_role`                                            |
  | `GOTRUE_DISABLE_SIGNUP`         | `true` (the API creates every user through the admin API) |
  | `GOTRUE_EXTERNAL_EMAIL_ENABLED` | `true`                                                    |
  | `GOTRUE_EXTERNAL_PHONE_ENABLED` | `false`                                                   |
  | `GOTRUE_MAILER_OTP_EXP`         | `900` (a code lasts 15 minutes)                           |
  | `GOTRUE_MAILER_OTP_LENGTH`      | `6`                                                       |
  | `GOTRUE_RATE_LIMIT_HEADER`      | unset (see above)                                         |
  | SMTP settings                   | none: Auth never sends email                              |

- **Start order:** `postgres` → `bootstrap` (creates Auth's role and schema) → `migrate` and
  `auth` (Auth migrates its own schema) → `api` and `worker` (wait for `auth` to be healthy,
  `GET /health`) → `web`.

### 2. The database

- **Same database, own schema.** Auth's tables live in `integr8`, in the `auth` schema, owned by a
  new role `supabase_auth_admin` (Supabase's own name for it). This is how Supabase's cloud lays
  it out too.
- **No collision.** Every schema-invariant and isolation check in `packages/db` looks only at the
  `public` schema. `integr8_app` and `integr8_auth` get no grant on `auth`.
- **One dump covers both.** `deploy/vps/backup-postgres.sh` dumps the whole `integr8` database,
  so Auth's tables are included without change.
- **`bootstrap` creates the role** when `SUPABASE_AUTH_DB_PASSWORD` is set: login, password from
  the variable, `search_path = auth`, owner of schema `auth`. Idempotent, like the other two
  roles. Optional in the migrator, so CI's database job and local setups without Auth keep
  working; required by `deploy/compose.yml` (`${SUPABASE_AUTH_DB_PASSWORD:?…}`).
- **Migration `0054`** adds to `sessions`:
  - `signed_in_with`: `password`, `email_code`, `invitation`, `signup` or `impersonation`
  - `authenticated_at`: when the person last proved who they are

  Switching company copies both to the new session, so the 15-minute rule (part 6) follows the
  person rather than the session. Existing rows: `password` and `created_at`.

### 3. Configuration and secrets

- **`SUPABASE_URL` becomes `SUPABASE_AUTH_URL`:** the Auth API's own base address
  (`http://auth:9999`). The provider joins paths to it as given and no longer adds `/auth/v1`.
  The old name, if still set, stops the API at start-up with a message naming the new one.
- **`SUPABASE_SERVICE_ROLE_KEY` keeps its name.**
- **`pnpm --filter @integr8/auth keygen` also prints:**
  - `SUPABASE_AUTH_JWT_SECRET`: 48 random bytes, base64url
  - `SUPABASE_SERVICE_ROLE_KEY`: an HS256 token signed with that secret,
    `{ role: 'service_role', iss: 'integr8', iat, exp: iat + 10 years }`
  - `SUPABASE_AUTH_DB_PASSWORD`: 32 random bytes, base64url (it goes inside a connection
    string, so no `+`, `/` or `=`)
- **Templates:** `deploy/.env.example`, `apps/api/.env.example` and `packages/auth/.env.example`
  describe the three variables and drop the Supabase project ones.

### 4. Compose hardening

- **Private ports:** `127.0.0.1:${API_PORT:-3000}:3000` and `127.0.0.1:${WEB_PORT:-3001}:3001`.
  Docker-published ports bypass Ubuntu's firewall; MyRooms already binds this way. Caddy proxies
  to `localhost` and the test box's tunnel uses the host network, so both still reach them.
- **Memory caps** (`mem_limit`), as starting values to tune from `docker stats`:

  | Container             | Cap    | Why                             |
  | --------------------- | ------ | ------------------------------- |
  | `postgres`            | 1 GB   | Shared buffers plus connections |
  | `api`                 | 768 MB |                                 |
  | `worker`              | 1.5 GB | Chromium printing PDFs          |
  | `web`                 | 768 MB |                                 |
  | `auth`                | 256 MB | A Go service; uses ~30–50 MB    |
  | `bootstrap`/`migrate` | 512 MB | Run once and exit               |

### 5. Sign in with an emailed code

- **No new routes.** The unused sign-in-link routes are reused, so nothing breaks inside `/v1`:
  - `POST /v1/auth/magic-link` — `redirectTo` becomes optional and is ignored. Answers the same
    whether or not the address has an account.
  - `POST /v1/auth/magic-link/complete` — takes `email` and the 6-digit `token`, as it already
    does.
- **Requesting a code:**
  1. The API looks the address up (`findByEmail`). No account: nothing is sent, same answer.
  2. Account: `POST /admin/generate_link` with `type: magiclink` gives the code.
  3. The API emails it with its own sender (`EMAIL_SENDER`, Resend in production), in the
     person's language, English or Arabic.
- **Completing:** `POST /verify` with `type: magiclink`, the address and the code. Then the
  normal sign-in continues: membership, company choice, session with
  `signed_in_with = email_code`.
- **Limits** (the API's own limiter):
  - requesting: one code per address per minute, five per hour, plus the per-IP limit
  - a wrong code counts towards the account lockout like a wrong password
- **`IdentityProvider` gains `createSignInCode(email)`.** `sendMagicLink` is removed.
  `verifyMagicLink` becomes `verifySignInCode`. The fake supports all of it for the suites.
- **Screens** (web, desktop, phone): on the sign-in screen, "Email me a sign-in code"; then a
  6-digit box with "Send a new code" and the same message for every failure. Text in
  `@integr8/i18n`, English and Arabic; logical directions only.
- **The email:** new English and Arabic templates beside the invitation emails: the code, that it
  lasts 15 minutes, and "if you did not ask for this, ignore this email".

### 6. Change password

- **New route** `POST /v1/me/password`, authenticated, idempotent:
  - body: `newPassword`, and `currentPassword` unless the session qualifies as fresh
  - **proof:** the current password (checked with `POST /token`), **or** a session with
    `signed_in_with = email_code` and `authenticated_at` in the last 15 minutes
  - the product's password rules (`packages/auth/src/password-policy.ts`)
  - `PUT /admin/users/{id}` with the new password
  - every other session of that person, in every company, is revoked with
    `revoked_reason = 'password_changed'` (the value already exists), and their offline grants
    with them; the session that made the change stays
  - an audit entry; failures count towards the lockout
  - an email to the address: "your password was changed", with the time, and "if this was not
    you, ask whoever administers your company for help". English or Arabic, through the same
    sender as the sign-in code. A failed send is logged and does not undo the change.
- **`IdentityProvider` gains `setPassword(userId, password)`.**
- **Screens:** "Change password" under the account menu on web, desktop and phone. After a code
  sign-in, the screen opens with the "current password" field hidden for 15 minutes.
- **The help article** "Trouble signing in" is rewritten for the code and Change password.

### 7. Deleting sign-in accounts on purge

- When a company is purged (`apps/api/src/platform/purge.ts`), the user ids of its members are
  collected first. After the purge, each id that has no membership left in any company is
  deleted from Auth (`DELETE /admin/users/{id}`).
- **Retried, not lost.** A failed delete is retried on the next purge run; a `404` counts as
  done.
- **`IdentityProvider` gains `deleteIdentity(userId)`.**
- Removing a member from a company does **not** delete their account: they may be invited back
  or belong elsewhere.

### 8. Setup guide (Markdown and HTML together)

- **Stage 0:** remove part E (the Supabase project) and the second Supabase project in the test
  box part; add running `keygen` for the three Auth secrets.
- **Stage 3:** the env file gets the three Auth variables.
- **Stage 4:** `docker compose ps` shows `auth` healthy.
- **Stage 9:** remove "Supabase Pro" and its SMTP step.
- **Stage 10 deleted.** Stages 11–14 become 10–13, and every "Stage N" reference in the guide
  and in other docs is updated.
- **Test box** (now Stage 10), rewritten for the home machine as it is now:
  - Ubuntu 24.04 LTS, with SSH, Docker and Docker Compose, Arcane, and Webmin and Samba (left
    as they are; no conflict)
  - the stack is created and updated as a **stack in Arcane**, from `deploy/compose.yml` and the
    env file, on the `:staging` images
  - the Cloudflare Tunnel connector stays: no router ports opened, HTTPS at Cloudflare
- **Updating to a new version** (Stage 12, which becomes Stage 11): a new part for this release:
  secrets, migration 0054, the Auth container, new desktop and phone builds for the new screens,
  and rolling back.
- `pnpm guide:check` passes; the stated release follows `package.json`.

### 9. Other docs and removals

- **Railway dropped:** delete `deploy/railway/`; remove it from `docs/deployment/README.md`,
  the README and anything else that links to it.
- **`docs/auth/`:** the README and a new page on the self-hosted Auth (what it is, its settings,
  secrets, how the code and Change password work, how to rotate the secret).
- **`plan/README.md`:** the locked decisions become "Self-hosted Postgres" and "Self-hosted
  Supabase Auth (identity only)".
- **`docs/database/runbook-supabase-setup.md` deleted**, and every link to it fixed (CI comments,
  `CONTRIBUTING.md`, `docs/database/README.md`, the composition error message and others).
- **`docs/database/runbook-backup-and-restore.md` rewritten** for the self-hosted database:
  - what `deploy/vps/backup-postgres.sh` dumps (the whole `integr8` database, so Auth's `auth`
    schema too), where the files go and how many are kept
  - scheduling it nightly with `cron`, and checking that last night's file exists
  - restoring one file into a running stack, and rehearsing a restore once
  - the honest limit: the files sit on the same disk as the database, so they protect against a
    bad migration or a deleted company, not against losing the machine; copying them off the
    machine is named as the next step
  - the recovery targets table updated to match (up to 24 hours of data lost; the Supabase
    point-in-time rows removed)
- **README** architecture and "How the hard parts work"; **`AGENTS.md`**; **`MEMORY.md`**.
- **OpenAPI and client** regenerated and committed (`pnpm --filter @integr8/api openapi`,
  `pnpm --filter @integr8/api-client generate`).

### 10. Testing

- **Unit:** the provider's paths and base URL; the service key (header, claims, signature);
  config errors (old variable name, missing secrets); code request limits; the 15-minute rule.
- **Integration** (`apps/api`, `packages/auth`, with the fake provider): code sign-in end to end;
  change password with each kind of proof and each refusal; other sessions and offline grants
  revoked; purge deletes only accounts with no company left.
- **Against the real Auth in CI:** add `supabase/auth:v2.197.0` as a service container to the
  database job, beside Postgres, and run a small suite of the provider against it: create, find,
  sign in, code, verify, set password, delete. This proves the container's settings, not just
  our side.
- **On the test box:** a full run: deploy, create a company, invite someone, sign in with a code,
  change the password, see other devices signed out.

## Confirmed with the plan (2026-10-30)

1. **Email on password change:** yes, in English or Arabic (part 6).
2. **Database runbooks:** delete the Supabase setup runbook; rewrite the backup and restore
   runbook for the self-hosted database with nightly dumps from the existing script (part 9).

## Tasks

- [ ] Compose: `auth` container, start order, health check, private ports, memory caps
- [ ] Migrator `bootstrap`: optional `supabase_auth_admin` role and `auth` schema
- [ ] Migration 0054: `sessions.signed_in_with` and `authenticated_at`; switch-company copies them
- [ ] Provider: base URL without `/auth/v1`; `createSignInCode`, `verifySignInCode`,
      `setPassword`, `deleteIdentity`; the fake to match
- [ ] Config: `SUPABASE_AUTH_URL`, error for the old name; `keygen` prints the three secrets
- [ ] Sign-in code: request and complete, limits, lockout, English and Arabic email
- [ ] Change password: route, both proofs, password rules, revoke other sessions and offline
      grants, audit, password-changed email in English and Arabic
- [ ] Purge: delete accounts with no company left, with retry
- [ ] Web, desktop and phone: code sign-in and Change password screens; strings in English and
      Arabic
- [ ] Help article rewritten
- [ ] OpenAPI and client regenerated
- [ ] CI: Auth service container and the provider suite against it
- [ ] Setup guide (Markdown and HTML): stages 0, 3, 4, 9; Stage 10 deleted and renumbered; test
      box on Ubuntu with Arcane; release part
- [ ] Railway removed; `docs/auth/`, `docs/deployment/`, `plan/README.md`, README, `AGENTS.md`,
      `MEMORY.md`, env templates
- [ ] Supabase setup runbook deleted and its links fixed; backup and restore runbook rewritten for
      the self-hosted database

## Exit criteria

- [ ] A fresh `docker compose up` on an empty machine brings `auth` up healthy with no manual SQL
- [ ] A company user signs in with a password, and an invitee accepts an invitation, against the
      self-hosted Auth
- [ ] A person who forgot their password gets a code by email, signs in with it on web, desktop
      and phone, and sets a new password
- [ ] Changing a password signs out every other device, including a phone's offline access, and
      emails the address
- [ ] Requesting a code answers the same for a known and an unknown address
- [ ] Purging a company deletes the sign-in accounts of people with no other company, and only
      those
- [ ] Nothing in the API, apps, compose files or docs still needs a Supabase cloud project
- [ ] Ports 3000 and 3001 are not reachable from outside the machine

## Branch and commits

- **Branch:** `feat/self-hosted-auth`, on top of `docs/agent-guides-and-version-sync`.
- **Commits by layer:** `feat(db)`, `feat(auth)`, `feat(api)`, `feat(web)`, `feat(desktop)`,
  `feat(mobile)`, `ci`, `docs`, as in P26 and P27.
- **What cannot be checked on the development PC:** it has no Docker or Postgres. Typecheck,
  lint, unit tests, `pnpm guide:check` and the OpenAPI drift check run there; the database and
  Auth suites run in CI; the full flow is checked on the test box.

## Notes

- Integr8 Plus and MyRooms will share one VPS (Ampere A1, 4 cores, 24 GB). MyRooms runs its own
  full Supabase stack, which also includes Auth v2.197.0. The two products keep **separate** Auth
  containers anyway: one shared Auth would mix two products' users.
- Rolling back to a version before this phase needs a Supabase cloud project again. With no users
  yet, fix forward instead.
- A shipped desktop or phone build without the new screens keeps working: nothing inside `/v1`
  changes shape.
