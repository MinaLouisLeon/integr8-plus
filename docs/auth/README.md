# Sign-in, sessions and permissions

**Supabase Auth authenticates; the API authorises.** A self-hosted Supabase Auth
container (GoTrue) keeps company people's passwords and makes one-time sign-in
codes. As soon as it accepts a password or a code, the API takes over and issues
its own tokens. Sessions, rotation, revocation, impersonation and offline grants
are rows in our schema, where they can be queried, audited and revoked. Clients
never talk to Auth. Everything goes through `IdentityProvider`
(`packages/auth/src/identity-provider.ts`); the suites use
`FakeIdentityProvider`. Integr8 staff do not use Auth at all: their passwords and
authenticator secrets are in `platform_users`.

```
  web · desktop · phone ──▶ api ──▶ auth (http://auth:9999, no published port)
                             │         │
                             └──▶ postgres: public schema (ours) · auth schema (Auth's)
```

## Tokens

One algorithm throughout, **EdDSA over Ed25519**: the key built into the phone
can check a token but never make one.

| Token   | Lifetime (setting)                         | Shape                                     | Does                                                                      |
| ------- | ------------------------------------------ | ----------------------------------------- | ------------------------------------------------------------------------- |
| access  | 15 min (`AUTH_ACCESS_TOKEN_TTL_SECONDS`)   | Signed JWT with `tid` and `role`          | Sent on every request                                                     |
| refresh | 30 days (`AUTH_REFRESH_TOKEN_TTL_SECONDS`) | Opaque `i8r1.` + 256 bits, hashed at rest | Exchanged once for a new pair                                             |
| offline | 7 days (`AUTH_OFFLINE_GRANT_TTL_SECONDS`)  | Signed JWT, checked on the phone          | Opens the phone with no signal ([offline-access.md](./offline-access.md)) |

A session lasts at most 90 days (`AUTH_SESSION_MAX_TTL_SECONDS`). Every refresh
issues a new token and marks the old one spent; presenting a spent token revokes
the whole session (theft and a client racing itself look the same, and the safe
reading is theft). Every request also checks the session is still live (not
revoked, not past its maximum, the person still an active member), cached 30 s
per session, so signing out everywhere, Change password, suspending or removing
somebody stops a device within thirty seconds.

| Client  | Tokens live in                                                                                  |
| ------- | ----------------------------------------------------------------------------------------------- |
| web     | The refresh token in an httpOnly cookie set by a Next route handler; the access token in memory |
| desktop | The OS credential store, through a Rust command                                                 |
| phone   | Expo SecureStore                                                                                |

Never `localStorage`. `TokenStore` (`packages/core/src/token-store.ts`) is the
contract.

## Signing in

- **Password.** `POST /v1/auth/sign-in`. Lockout after 10 failures in an hour
  for 15 minutes (`AUTH_LOCKOUT_*`), unlocked by an admin or staff; per-address
  and per-network limits count failures only. The same answer is returned
  whatever went wrong.
- **Emailed code.** `POST /v1/auth/magic-link` then `/magic-link/complete`: a
  6-digit code, valid 15 minutes, and no link, so the desktop and phone need no
  deep links. Limits: one per address a minute, five an hour; the answer is the
  same whether or not the address exists, and the lookup happens after the
  answer has gone. Auth makes the code (`generate_link`, which sends nothing);
  the API emails it in English or Arabic.
- **No company yet.** At sign-in there is no tenant, so lockout, limits and
  "which companies is this person in" run as a third database role,
  `integr8_auth`, which reaches two tables and one view and nothing else.
- **Switching company** needs no new sign-in.
- **Accepting an invitation** happens only on the public site's
  `/accept-invitation`. A new address chooses its password there; an existing
  account needs none. Accepting makes the membership and **no session**: the page
  says the password is set and sends the person to their company's desktop or
  phone app (the answer names the company). Nobody may invite at a role above
  their own, and nobody is invited before the company's own desktop app exists
  (409 `company_app_not_built`, P42).
- **Change password** (`POST /v1/me/password`, desktop and phone) needs the
  current password, or a session that began with an emailed code in the last 15
  minutes, and signs out every other device. Passwords must not contain the
  address's local part (`password-policy.ts`).
- **Staff** sign in to the platform with their own password and an authenticator
  code (`/v1/platform/auth/sign-in`, lockout after 5 failures), in the staff
  desktop app, which holds the session in memory only and asks again each time
  it starts (P42, D2).

## Roles and permissions

Eight built-in roles (`packages/core/src/roles.ts`), ranked: `owner`, `admin`,
`hr_manager`, `inventory_manager`, `accountant`, `dispatcher`, `engineer`,
`viewer`. Companies may add their own roles on top (`tenant_roles`, the desktop's
Company roles tab).

The matrix is `packages/core/src/permissions.ts`: 82 permissions, every role
listing every permission it holds in full (no inheritance). The same decisions
are a table, `packages/core/src/permissions.table.md`, one `yes`/`no` per role
and a **Staff only** column; `permissions.test.ts` fails when the two disagree.
A new permission is decided for every role in both places.

`STAFF_ONLY_PERMISSIONS` (forms, job types, branding, document design, the ETA
switch, …) are never held by a company's own people, owner included: staff do
that work as the company through impersonation. Two rules are relationships,
not permissions: nobody invites above their own role, and a super admin holds no
membership in any company (a trigger enforces it). Only the owner changes,
re-activates or removes somebody with HR access; an admin may suspend them.

## Impersonation

The order is the design: write the audit entry, create a grant with a non-null
foreign key to it, then mint a token. The grant cannot exist without its entry,
and `audit_log` refuses updates and deletes for every role. Every request under
an impersonation token re-checks the grant, not just the token's expiry; grants
last at most an hour (`AUTH_IMPERSONATION_TTL_SECONDS`). A grant is reused only
for the same purpose, so each purpose reaches the log. Staff sessions limited to
test companies may impersonate test companies only
([platform/](../platform/README.md#test-companies)).

## The Auth container

`supabase/auth:v2.197.0`, pinned, in `deploy/compose.yml` with no published
port and a 256 MB cap. Its tables are in the same database, schema `auth`, owned
by `supabase_auth_admin`; none of our roles holds anything there, and one
backup covers both. Sign-up through Auth is disabled (the API creates every
account through the admin API) and Auth sends no mail. Its own rate limits are
off because every request comes from the API's one address; the API limits.

| Secret                      | What                                                                | Read by             |
| --------------------------- | ------------------------------------------------------------------- | ------------------- |
| `SUPABASE_AUTH_JWT_SECRET`  | 48 random bytes                                                     | `auth`              |
| `SUPABASE_SERVICE_ROLE_KEY` | HS256 token signed with that secret; can do anything to any account | `api`, `worker`     |
| `SUPABASE_AUTH_DB_PASSWORD` | The `supabase_auth_admin` password                                  | `bootstrap`, `auth` |

`pnpm --filter @integr8/auth keygen` prints them after the API's signing keys
(`AUTH_SIGNING_KEY`, `AUTH_VERIFICATION_KEYS`). The API reads
`SUPABASE_AUTH_URL` (`http://auth:9999`) and refuses to start while the old
`SUPABASE_URL` is set. Rotating the JWT secret signs nobody out: put the new
secret and key in `deploy/.env` and restart `auth`, `api` and `worker`. Load
keygen's output line by line (`while IFS= read -r l; do export "$l"; done`), not
with `source`, which strips the quotes from the signing key's JSON.

When a company is purged, its people's Auth accounts that belong to no other
company are deleted. `node dist/platform/admin-cli.js user-password <email>`
(in the API container) gives somebody a new password in Auth, prints it once and
signs out their devices. A company moved with `transfer` keeps its people's
password hashes ([database/](../database/README.md#moving-a-company-between-servers)).
