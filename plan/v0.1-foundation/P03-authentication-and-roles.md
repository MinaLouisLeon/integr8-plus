# P03 — Authentication and roles

**Version:** v0.1 Foundation
**Status:** `IN PROGRESS`
**Depends on:** P02

## Goal

A person signs in once and the system knows which company they belong to, what they may
do, and — separately — whether they are you.

## Scope

Two identity spaces: tenant users and platform (super admin) users. They never mix.

## Tasks

- [x] Supabase Auth wired for email/password and magic link
- [x] Custom JWT claims carrying `tenant_id` and `role`, populated on sign-in and on tenant switch
- [x] Roles: Company Owner, Admin, Dispatcher, Engineer, Viewer — with a permission matrix in code, not scattered `if` statements
- [ ] `platform_users` table and a separate sign-in path for super admin
- [x] Impersonation: time-limited token, mandatory reason, audit entry written before access is granted
- [x] Invite flow: admin invites by email with role preset; invite expires; acceptance binds the user to the tenant
- [ ] Refresh-token rotation; tokens stored in the OS keychain on desktop and SecureStore on mobile — never in local storage
- [x] Offline authentication: a signed token valid for a configurable number of days so the mobile app opens without signal
- [x] Password policy, rate-limited attempts, lockout with admin unlock
- [x] Session listing and remote revocation

## Exit criteria

- [ ] A user's JWT cannot be edited to reach another tenant — verified by a test that tries
- [ ] Impersonation writes an audit entry that cannot be deleted through the application
- [ ] A super admin has no membership row inside any tenant, verified by a test
- [ ] The mobile app opens and shows cached work after seven days with no network

## Notes

- Do not use per-tenant Supabase Auth instances. One identity system, one login, or
  super-admin impersonation becomes unworkable.
- Decide the offline token lifetime with the security tradeoff written down: a longer
  window is friendlier to engineers and worse if a phone is stolen.

---

## What remains, and why

Three things, and they are different kinds of unfinished.

### 1. The super-admin sign-in path — not built

`platform_users` exists (P02) and impersonation is built on top of it, but **nothing
authenticates a platform user in the first place**. `ImpersonationService.start` takes a
`platformUserId` and verifies it is active; it does not establish that the caller _is_
that person.

This was left rather than rushed. A platform session has no `tenant_id`, and every token
this system issues carries one — so it needs either a fourth token type or a deliberate
widening of the claim schema, and that is a design decision rather than an afternoon's
typing. It should be settled together with the super-admin dashboard's actual shape in
**P15**, and P03 cannot close until it is.

Until then, impersonation is reachable only from code that has already established who is
calling — which is no API surface at all, because P04 has not built one yet.

### 2. Client token storage — deferred to P05, deliberately

The OS keychain and SecureStore adapters need app shells that do not exist yet. What
exists instead is the contract they will implement — `TokenStore` in
`packages/core/src/token-store.ts`, with an in-memory implementation and the
refresh-timing helpers, all tested — so P05 is wiring rather than designing.

The fourth exit criterion ("the mobile app opens after seven days with no network")
depends on the same shells and is ticked in P05.

### 3. Everything else — written, not yet run against Postgres

The same position P02 is in. Three integration suites exist, type-check and lint; none
has executed, because no Supabase project exists.

Do these in order:

1. **Finish the P02 runbook** —
   [`docs/database/runbook-supabase-setup.md`](../../docs/database/runbook-supabase-setup.md).
   Step 3 now creates two roles.
2. **Generate signing keys** — `pnpm --filter @integr8/auth keygen`, then fill in
   `packages/auth/.env`.
3. **Run both suites** — `pnpm --filter @integr8/db test:integration`, then
   `pnpm --filter @integr8/auth test:integration`. Between them they cover the first
   three exit criteria.
4. **Add `TEST_DATABASE_URL_AUTH` to CI** — step 8 of the runbook.

## Decisions taken during implementation

- **This service is the session authority; Supabase authenticates.** The locked decision
  is "Supabase Auth, tenant claims in the JWT". P03 then asks for five things an opaque
  third-party session cannot provide: tenant switching, per-device revocation,
  impersonation with a reason and a time limit, a multi-day offline grant, and lockout
  with an admin unlock. So Supabase holds credentials and sends magic links, and every
  token the API trusts is one this service minted. The alternative — a Supabase custom
  access token hook — would still have needed separately minted tokens for impersonation
  and offline access, ending at three token systems instead of one.

- **EdDSA over Ed25519, one key, three token types.** The mobile app verifies an offline
  grant itself, on launch, on a cheap phone, with no network: a 32-byte public key makes
  that unremarkable. Asymmetric so the key embedded in the app can check a token and never
  mint one. Verification accepts a _set_ of keys, because rotating one with a seven-day
  offline grant in circulation takes at least seven days.

- **Refresh tokens are opaque, not JWTs.** A refresh token that announced which company it
  unlocked would tell an attacker what they had found before they spent it. They are 256
  random bits behind a greppable `i8r1.` prefix — so a secret scanner can be taught to
  recognise one in a commit or a support ticket — stored only as a SHA-256 hash. SHA-256
  rather than argon2 because there is nothing to guess; what is wanted is a hash that
  indexes.

- **The tenant id travels inside the refresh and invitation tokens.** The row that says
  which company a token belongs to is itself behind RLS, which needs the company known
  before the lookup. Carrying it in the token resolves that and weakens nothing: the
  tenant id is not a secret, and the random half still is.

- **A spent refresh token is treated as theft, and ends the session.** The legitimate
  holder has moved on to the replacement, so whoever presents the old one is not them. The
  real person is logged out too — which is correct: if it was stolen, they need to know.
  The claim uses `where used_at is null`, so two racing refreshes have one winner and the
  loser is treated the same way; a client racing itself is indistinguishable from a thief
  racing the client.

- **A third database role, `integr8_auth`.** Sign-in asks two questions with no tenant to
  scope by — is this address locked out, and which companies does this identity belong to.
  Answering them over the tenant runtime role would give every tenant request a
  cross-tenant read, undoing what P02 spent its phase establishing. Instead there is a
  role that reaches `login_attempts`, `account_locks` and one narrow view, and nothing
  else — asserted at startup and again by the schema-invariant suite.

- **`auth_memberships` is the only view in the schema, and it is allow-listed.** A view
  without `security_invoker` reads past every RLS policy beneath it, which makes it the
  easiest way to hand out a cross-tenant read by accident. This one exposes four columns —
  identity, company, role, status — and the invariant suite fails the build if any other
  view appears.

- **Composite foreign keys throughout.** `references sessions (id)` would let a refresh
  token in one company name a session in another; both are valid uuids and nothing would
  object. Every foreign key between two tenant-scoped tables carries `tenant_id`, turning
  that from a leak RLS must catch into a constraint violation.

- **Impersonation's ordering is a foreign key, not a convention.**
  `impersonation_grants.audit_log_id` is non-null and references `audit_log`. There is no
  sequence in which a grant exists and its audit entry does not, because the insert would
  fail — and `audit_log` rejects updates and deletes for every role including the owner.
  Every request under an impersonation token re-checks the grant rather than trusting the
  token's expiry, so ending a session is immediate rather than up to fifteen minutes late.

- **The permission matrix repeats itself on purpose.** Every role lists every permission
  it holds in full, with no inheritance: widening `admin` should not silently widen
  everything spread from it, in a diff that shows one line in an unrelated role. A test
  fails the build if a permission is added without deciding it for all five roles.

- **Nobody may invite somebody at a role above their own.** Not a permission — a
  relationship, so it lives in the service rather than in the matrix. Without it,
  `member.invite` is `member.promote_self`.

- **Password policy is length, not composition.** Composition rules reliably produce
  `Password1!` and reliably block `correct horse battery staple`. NIST dropped them in
  SP 800-63B; this follows. What is checked instead is length, a short list of weak
  _bases_ (so `password`, `password1` and `password1234` are one entry), and whether the
  password is built out of the address it protects.

- **Two rate limits, because they catch different attacks.** Per-address lockout stops
  somebody guessing one person's password. It does nothing against one common password
  tried across ten thousand addresses, where no single address ever fails twice — which is
  the attack that actually succeeds. The per-IP limit is what sees that.

- **Sign-in returns one company plus the list.** Making it a two-step flow would need a
  token in between whose only purpose is to say "I proved a password but have not chosen a
  company yet" — a fourth token type for one screen. Instead it signs the person into their
  only company (or the one they asked for) and returns every membership, so the client can
  render a switcher with no second round trip.

- **Switching companies revokes the old session.** One device, one live session: it is
  what makes "sign out" and "revoke this device" mean something definite.

- **The offline window is seven days**, with the tradeoff written up in
  [`docs/auth/offline-access.md`](../../docs/auth/offline-access.md) as this phase's notes
  require. Short version: it matches the working week an engineer plans in, the grant
  unlocks cached data for one company at one role, and revocation takes effect only when
  the device next has signal — which is the irreducible cost of working in a basement.

## Verified so far

| Claim                                           | How it was proven                                                                                                                                        |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace still builds and passes               | `pnpm build`, `lint`, `typecheck`, `test`, `format:check` — all green across 9 packages                                                                  |
| Tokens cannot be forged                         | 16 unit tests: edited payload, foreign signing key, unknown `kid`, missing `kid`, and an HS256 token forged using the published public key as the secret |
| A staging token cannot open production          | Issuer and audience are verified even when the signing key is identical                                                                                  |
| An offline grant is not an access token         | Each is rejected where the other is expected, so the fifteen-minute lifetime is not decorative                                                           |
| A key rotation keeps working                    | A two-key set verifies tokens signed by either; the pre-rotation deployment refuses the new one                                                          |
| Verification keys cannot carry private material | Refused at load, because those keys ship inside a mobile binary                                                                                          |
| The permission matrix is complete               | A test enumerates every role × permission pair and fails if one was never decided                                                                        |
| The password policy is not theatre              | 20 unit tests: passphrases accepted, `Password1!`-shaped rejected, addresses caught even when punctuation is stripped                                    |
| Secrets are shaped as claimed                   | 256 bits of entropy, prefix enforced, a token of the wrong kind rejected, hashes matching the database's check constraint                                |
| Against a live database                         | **Not yet run.** Three integration suites are written and type-checked; see "What remains" above                                                         |
