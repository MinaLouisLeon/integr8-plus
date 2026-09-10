# Authentication

Supabase Auth holds credentials and sends magic links. Everything after a
credential is accepted belongs to this service.

| Document                                  | When you need it                               |
| ----------------------------------------- | ---------------------------------------------- |
| [offline-access.md](./offline-access.md)  | The seven-day window and what it costs         |
| [`docs/database/`](../database/README.md) | How tenant isolation works underneath all this |

---

## Why we are the session authority

The locked decision is "Supabase Auth, tenant claims in the JWT". P03 then asks
for five things Supabase's own sessions cannot provide:

- switching companies without signing in again,
- per-device session listing and remote revocation,
- impersonation with a reason, a time limit and an audit entry written first,
- a multi-day offline grant a phone can verify with no network,
- lockout with an admin unlock.

So the division is: **Supabase authenticates, we authorise.** A client signs in
with Supabase, hands us the result, and we issue our own tokens carrying
`tenant_id` and `role`. Sessions, rotation, revocation and impersonation are
rows in our schema, where they can be queried, audited and revoked.

## Three token types, one key

One algorithm throughout: **EdDSA over Ed25519**. Asymmetric, so the key
embedded in the mobile app can verify a token but never mint one; small and
fast, so verifying an offline grant on app launch on a cheap phone is
unremarkable.

| Token       | Lifetime | Shape                        | What it does                                    |
| ----------- | -------- | ---------------------------- | ----------------------------------------------- |
| **access**  | 15 min   | Signed JWT                   | Sent on every request; carries `tid` and `role` |
| **refresh** | 30 days  | Opaque, hashed at rest       | Exchanged for a new pair; single-use            |
| **offline** | 7 days   | Signed JWT, verified locally | Lets the mobile app open with no network        |

Refresh tokens are deliberately **not** JWTs. One that announced which company
it unlocked would tell an attacker what they had found before they spent it. It
is 256 random bits behind a `i8r1.` prefix — greppable, so a secret scanner can
be taught to recognise one in a commit or a support ticket — and only its
SHA-256 hash is stored.

## Rotation, and how theft is detected

Every refresh issues a new token and marks the old one spent, naming its
replacement. Presenting a spent token is unambiguous: the legitimate holder
moved on to the replacement, so whoever is holding this one is not them.

The whole session is then revoked — which logs the real person out too. That is
the right outcome. If the token really was stolen, they need to know.

The claim is made with `where used_at is null`, so two simultaneous refreshes
have exactly one winner and the loser is treated as reuse. A client racing
itself is indistinguishable from a thief racing the client, and the safe reading
is the second one.

## Roles

Five roles, one matrix, in `packages/core/src/permissions.ts`. Every role lists
every permission it holds in full — no inheritance, because widening `admin`
should not silently widen everything built on top of it.

A test fails the build if a permission is added without deciding it for all five
roles. That is the point of having a matrix at all: the alternative is a
`role === 'admin'` check in three hundred files, where a missing one looks
exactly like code nobody wrote.

Two rules live outside the matrix because they are relationships rather than
capabilities:

- **Nobody invites somebody at a role above their own.** Without it,
  `member.invite` is `member.promote_self`.
- **A super admin holds no membership in any company.** Enforced by a trigger
  in migration 0001, so P03's exit criterion confirms an invariant rather than a
  habit.

## Impersonation

The ordering is the whole design:

1. Write the audit entry.
2. Create a grant carrying a non-null foreign key to that entry.
3. Mint a token.

There is no sequence in which the grant exists and the entry does not, because
the insert would fail. `audit_log` then rejects updates and deletes for every
role including the schema owner, so the entry cannot be removed afterwards
either.

Every request made under an impersonation token re-checks the grant rather than
trusting the token's expiry — fifteen minutes of a super admin inside a
customer's account after they asked you to stop is fifteen minutes too many.

## Where the tokens live on each client

| Client  | Storage                                              |
| ------- | ---------------------------------------------------- |
| desktop | Tauri's OS keychain plugin (Keychain / DPAPI)        |
| mobile  | Expo SecureStore (Keychain / EncryptedSharedPrefs)   |
| web     | An httpOnly cookie set by the API; never JS-readable |

**Never `localStorage`, on any client.** Any script on the page can read it,
which turns one XSS bug into every customer's data.

The `TokenStore` interface and the refresh-timing helpers are in
`packages/core/src/token-store.ts`. P05 implements them per client against a
contract that already has tests.

## Sign-in has no tenant

At the moment a sign-in arrives there is no company, and for an unknown address
there cannot be one. Lockout, rate limiting and "which companies does this
person belong to" therefore run over a third database role, `integr8_auth`,
which reaches two tables and one view and nothing else.

That role exists so the tenant runtime role never needs a cross-tenant
privilege. The schema-invariant suite fails the build if it gains one.

## Setting up

```bash
cp packages/auth/.env.example packages/auth/.env
pnpm --filter @integr8/auth keygen        # prints the three key variables
```

Then follow [the database runbook](../database/runbook-supabase-setup.md),
which creates both `integr8_app` and `integr8_auth`.

```bash
pnpm test                  # unit: keys, tokens, secrets, password policy, matrix
pnpm test:integration      # needs a disposable Postgres
```
