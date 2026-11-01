# The self-hosted Supabase Auth (P36)

Integr8 Plus runs everything on its own server, sign-in included. Passwords and
one-time sign-in codes live in a **Supabase Auth** container (GoTrue) beside the
API, in the same compose stack. There is no Supabase cloud project, and none of
Supabase's other services (gateway, REST, realtime, storage, Studio) is used:
clients never talk to Supabase at all, only to the API.

```
  web · desktop · phone ──▶ api ──▶ auth (http://auth:9999, no published port)
                             │         │
                             └──▶ postgres: public schema (ours) · auth schema (Auth's)
```

## What it does, and what it does not

| Auth container                        | The API                                                 |
| ------------------------------------- | ------------------------------------------------------- |
| Stores passwords (bcrypt)             | Decides who may sign in to which company                |
| Checks a password (`POST /token`)     | Lockout, per-address and per-network limits             |
| Makes a 6-digit code, sends nothing   | Emails the code, in English or Arabic                   |
| Checks a code (`POST /verify`)        | Issues its own tokens, sessions, offline grants         |
| Creates, changes and deletes accounts | Change password's proof, signing out every other device |

Auth holds no sessions that matter here: as soon as it accepts a password or a
code, the API takes over (see [the README](./README.md)). Integr8 staff on the
platform dashboard do not use it at all; their passwords and authenticator
secrets are in our own tables.

## The container

`supabase/auth:v2.197.0`, pinned. Upgrades come through Dependabot
(`.github/dependabot.yml`, `docker-compose` ecosystem) or by hand, never
`latest`. Configured in `deploy/compose.yml`:

| Setting                         | Value                                                       |
| ------------------------------- | ----------------------------------------------------------- |
| `GOTRUE_API_HOST` / port        | `0.0.0.0` / `9999` (no port published on the host)          |
| `API_EXTERNAL_URL`              | `http://auth:9999` (required by Auth; never shown)          |
| `GOTRUE_DB_DATABASE_URL`        | `postgres://supabase_auth_admin:…@postgres:5432/integr8`    |
| `DB_NAMESPACE`                  | `auth`                                                      |
| `GOTRUE_SITE_URL`               | `WEB_APP_URL`                                               |
| `GOTRUE_JWT_SECRET`             | `SUPABASE_AUTH_JWT_SECRET`                                  |
| `GOTRUE_JWT_ADMIN_ROLES`        | `service_role`                                              |
| `GOTRUE_DISABLE_SIGNUP`         | `true`: the API creates every account through the admin API |
| `GOTRUE_EXTERNAL_EMAIL_ENABLED` | `true`; phone sign-in is off                                |
| `GOTRUE_MAILER_OTP_EXP`         | `900`: a code lasts 15 minutes                              |
| `GOTRUE_MAILER_OTP_LENGTH`      | `6`                                                         |
| `GOTRUE_RATE_LIMIT_HEADER`      | unset (see below)                                           |
| Mail settings                   | none: Auth never sends email                                |

**Start order:** `postgres` → `bootstrap` (creates Auth's role and schema) →
`migrate` and `auth` (Auth migrates its own schema at start-up) → `api` and
`worker` (wait for `auth` to answer `GET /health`) → `web`.

**Rate limits.** Auth's own per-IP limits only work when
`GOTRUE_RATE_LIMIT_HEADER` names a header carrying the client's address. Every
request reaches Auth from the API container's one address, so it is left unset
and the API does the limiting: per network, per address and the account
lockout.

**Memory.** Capped at 256 MB; it uses 30–50 MB.

## The database

Auth's tables live in the **same `integr8` database, in the `auth` schema**,
owned by the role `supabase_auth_admin` (Supabase's own name for it), whose
`search_path` is `auth`. `pnpm --filter @integr8/db db bootstrap` creates the
role and the schema when `SUPABASE_AUTH_DB_PASSWORD` is set; the compose stack
runs it on every start. It is idempotent, and resets the password to the env
file's on each run.

- **No collision.** Every schema-invariant and isolation check in
  `packages/db` looks only at `public`. `integr8_app` and `integr8_auth` hold no
  privilege on `auth`.
- **One backup covers both.** `deploy/vps/backup-postgres.sh` dumps the whole
  database, `auth` included
  ([the runbook](../database/runbook-backup-and-restore.md)).
- One of Auth's migrations grants `select` to a role named `postgres`, which
  the official `postgres` image has. No extensions are needed.

## Secrets

`pnpm --filter @integr8/auth keygen` prints three, after the signing keys:

| Variable                    | What                                                                                             | Who reads it         |
| --------------------------- | ------------------------------------------------------------------------------------------------ | -------------------- |
| `SUPABASE_AUTH_JWT_SECRET`  | 48 random bytes, base64url                                                                       | the `auth` container |
| `SUPABASE_SERVICE_ROLE_KEY` | HS256 token signed with the secret: `{ role: service_role, iss: integr8 }`, ten years, no key id | the API and worker   |
| `SUPABASE_AUTH_DB_PASSWORD` | 32 random bytes, base64url (it sits inside a connection string)                                  | `bootstrap`, `auth`  |

The API also reads `SUPABASE_AUTH_URL`, which compose sets to
`http://auth:9999`. The old `SUPABASE_URL` — a cloud project's address, to which
the API used to add `/auth/v1` — is no longer read, and **the API refuses to
start while it is set**, naming the new variable. `SUPABASE_SERVICE_ROLE_KEY`
kept its name.

The service role key can do anything to every account. It never leaves the
server, and no client ever sees it.

### Rotating the secret

Nothing is signed out by a rotation: Auth's own tokens are never kept, and the
API's tokens are signed with a different key.

1. Run `keygen` and take the new `SUPABASE_AUTH_JWT_SECRET` and
   `SUPABASE_SERVICE_ROLE_KEY` (they belong together: the key is signed with the
   secret).
2. Put both in `deploy/.env`.
3. `docker compose up -d auth api worker`. Until all three have restarted, the
   API's admin calls fail (codes and new accounts); password sign-in keeps
   working.

To rotate the database password, change `SUPABASE_AUTH_DB_PASSWORD` and run
`docker compose up -d bootstrap auth`: bootstrap sets the role's new password,
then Auth reconnects with it.

## Signing in with an emailed code

The way back in for somebody who has forgotten their password, on web, desktop
and phone. The email carries a **6-digit code and no link**, so there is
nothing for the desktop or phone app to open and no deep-link set-up.

1. The person types their address and chooses **Email me a sign-in code**.
   The app calls `POST /v1/auth/magic-link` (the old sign-in-link route, reused
   so nothing inside `/v1` changes) with the language it is showing.
2. The API counts the request against its limits — one code per address per
   minute, five per hour, plus the per-network limit — the same way whether or
   not the address has an account, and answers `202`. A refusal is `429` for
   any address.
3. After the answer has gone, so that its timing says nothing, the API looks
   the address up. No account, a locked one or one with no company: nothing is
   sent. Otherwise it asks Auth for a code (`POST /admin/generate_link`, type
   `magiclink`, which creates no user and sends nothing) and emails it through
   `EMAIL_SENDER`, in English or Arabic.
4. The person enters the code; the app calls `POST /v1/auth/magic-link/complete`
   with it as `token`. The API checks it with Auth (`POST /verify`), then signs
   in exactly as for a password. A wrong code counts towards the account lockout
   like a wrong password. The session is recorded as `signed_in_with =
email_code`.

With the recording email sender (staging) the code is written to the API log,
as the invitation link is; with a real sender it never is.

## Change password

Under the account menu on web, desktop and phone; `POST /v1/me/password`.

- **Proof:** the current password, **or** a session that began with an emailed
  code in the last 15 minutes (`AUTH_FRESH_SIGN_IN_SECONDS`). The screen leaves
  the current-password field out in that window. Switching company carries how
  and when the person signed in to the new session, so the window does not
  restart.
- Without either, the answer is `403 auth.current_password_required`. A wrong
  current password is `403 auth.current_password_wrong` — not `401`, which every
  client reads as an expired token — and counts towards the lockout.
- The new password must pass the product's rules
  (`packages/auth/src/password-policy.ts`).
- Auth stores it (`PUT /admin/users/{id}`). Then **every other session the
  person has, in every company, is signed out**, offline access on phones
  included (`revoked_reason = password_changed`). The device that made the
  change stays signed in. Their access tokens stop being accepted within 30
  seconds, not when they lapse: every request checks that its session is still
  live (`docs/auth/README.md`, "Ending a session ends its access token").
- An audit entry is written, and the address is emailed "your password was
  changed", with the time, in English or Arabic. A failed send is logged and
  does not undo the change.

Not while impersonating: a super admin acting as somebody cannot change their
password.

## Deleting accounts when a company is purged

When a company is purged (`apps/api/src/platform/purge.ts`), the ids of everyone
who was ever a member are read first and written to `identity_deletions`. After
the company's rows are gone, each id that has no membership left in any company
is deleted from Auth (`DELETE /admin/users/{id}`); one that belongs elsewhere
keeps its account. A failed delete stays pending and is tried again on every
purge run; a `404` counts as done.

Removing a member from a company does **not** delete their account: they may be
invited back, or belong to another company.

## Tests

- **Unit** (`pnpm --filter @integr8/auth test`): the provider's paths against
  the base address, the service role key's header, claims and signature.
  `apps/api`: the configuration errors (old variable, missing secrets) and the
  two emails.
- **Integration** (a disposable Postgres, the fake provider): code sign-in end
  to end, the limits, change password with each proof and each refusal, other
  sessions and offline grants signed out, purge deleting only orphaned
  accounts.
- **Against the real Auth** (`pnpm --filter @integr8/auth test:auth-server`):
  CI's database job starts `supabase/auth:v2.197.0` with the same settings and
  runs create, find, sign in, code, verify, set password and delete against it.
  This proves the container's configuration, not only our side.
