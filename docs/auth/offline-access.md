# Offline access, and what it costs

P03 requires this decision to be written down rather than merely made:

> Decide the offline token lifetime with the security tradeoff written down: a
> longer window is friendlier to engineers and worse if a phone is stolen.

**The window is seven days**, configurable per environment via
`AUTH_OFFLINE_GRANT_TTL_SECONDS`, counted from the last time the phone reached the API.

---

## What the grant is

A signed token (an EdDSA JWT with `typ: offline`, the company `tid`, the `role`, the session
`sid` and the grant's own id `gid`) that the phone keeps in the OS keychain beside its other
tokens and checks **itself**, with no network. If it checks out, the app opens and shows the work
already downloaded.

It is not an API credential. It unlocks cached data on the device; it cannot fetch anything.
Reaching the API still needs an access token, which lasts fifteen minutes and can only be
obtained online.

## When it is issued

- **With every token pair for `clientApp: mobile`**: password sign-in (`/v1/auth/sign-in`),
  sign-in with an emailed code (`/v1/auth/magic-link/complete`), switching company, and every
  refresh (`/v1/auth/refresh`). It arrives as `offlineGrant` and `offlineGrantExpiresAt` beside
  the pair (an additive field: older clients ignore it).
- **Each new grant replaces the last** (`offline_grants`, revoked as `replaced`). A phone in use
  refreshes every fifteen minutes, so its grant always runs seven days from its last contact,
  not from when the person signed in.
- **Never past the session's own end** (`AUTH_SESSION_MAX_TTL_SECONDS`), as a refresh token never
  is.
- **Never to the desktop or web app**, which have no offline story in this product, and never to
  a session Integr8 staff hold as the company: a week-long credential with no benefit is a
  liability.

## What the phone does with it

On launch, and on coming back to the foreground, the phone decides
(`SessionManager.openDecision`, `packages/api-client/src/session.ts`):

| The phone holds…                                  | It…                                                            |
| ------------------------------------------------- | -------------------------------------------------------------- |
| A grant that checks out                           | Opens, with or without signal                                  |
| A lapsed grant (or none) and can reach the API    | Refreshes, which brings a new grant, and opens                 |
| A lapsed grant (or none) and cannot reach the API | Does **not** open: _Connect to carry on_ (`app/reconnect.tsx`) |
| A session the server refused, or one that expired | Goes to sign-in (refused: wiped first)                         |

**It never opens on its refresh token alone.** That lasts thirty days, and with no signal the
phone cannot tell whether the office revoked it this morning. The grant is the credential that
says how long a phone may work unseen, and it says seven days. Unsent work is kept, encrypted,
while the phone waits for a connection, and goes as soon as it has one.

## Exactly what the phone checks, and what it does not

`checkOfflineGrant` (`apps/mobile/src/lib/offline-grant.ts`, with
[`@noble/curves`](https://github.com/paulmillr/noble-curves) for Ed25519):

| Checked on the phone, with no network | How                                                                                                                                                                                                                       |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Our API signed it                     | Ed25519 signature against the public keys **built into the app** (`EXPO_PUBLIC_AUTH_VERIFICATION_KEYS`, the deployment's `AUTH_VERIFICATION_KEYS`). The algorithm is pinned to EdDSA; the header's `kid` only picks a key |
| It is an offline grant                | The claims parse with `offlineGrantClaimsSchema` from `@integr8/core`, `typ: offline`: an access token does not open the phone                                                                                            |
| It has not ended                      | Its own signed `exp` against the phone's clock, and the end the server sent with it                                                                                                                                       |
| The clock was not set back before it  | Its `iat` is no more than five minutes ahead of the phone's clock                                                                                                                                                         |

**Not checked on the phone, and why:**

- **Revocation.** That needs the server, and a phone with no signal has none. See "What it costs".
- **The phone's clock, within the grant's week.** Setting the clock back to a time between
  when the grant was issued and when it ends keeps it open. The phone has no other clock to trust;
  its lock screen is the barrier, and an attacker who can unlock the phone has the app anyway.
- **Issuer and audience.** Each deployment has its own keys (Stage 0, Part L), so a grant signed by
  the test box does not verify against production's keys at all.
- **That the grant belongs to the data on the phone.** The phone is wiped whenever somebody else
  signs in, before anything of theirs is shown.

**A build made without the keys** checks only the end the server sent with the grant, and says so to
Sentry once a run (`built_without_keys`). **A build with keys it cannot read** opens on no grant at
all, so the phone needs signal to open, and says so too (`invalid_keys`). A grant refused for any
other reason than its end (`unknown_key`, `bad_signature`, `too_early`) is reported the same way:
it means the build carries the wrong keys, a clock set back, or a grant that was edited.

The API checks grants with the same rules (`TokenService.verifyOfflineGrant`), and the mobile
unit tests check grants signed the way the API signs them.

## Why seven days

An engineer's working week is the unit they plan in. A shorter window means a
day comes when the app refuses to open in a plant room in a basement, with the
customer standing there, and the only fix is a signal the building does not
have. That is not an inconvenience; it is the job not getting done, and it is
the failure this product exists to prevent.

Three days would cover a long weekend and fail a week of site work. Thirty days
would be more comfortable and much harder to defend to a customer's security
team at P34. Seven days matches how the work is actually organised.

## What it costs

**A lost or stolen phone can be opened and read for up to seven days after it last reached
the API.** That is the honest statement. Everything below reduces it; nothing removes it.

- **The phone's own lock screen is the first barrier.** The grant is in the
  keychain, which needs the device unlocked. An attacker with an unlocked phone
  has the app anyway. The app also locks itself behind the phone's biometrics or passcode (P14).
- **The grant unlocks one company at one role.** It carries `tid` and `role`,
  so a stolen engineer's phone shows one company's jobs at an engineer's
  permissions. Not an admin's, and not anybody else's company.
- **Cached data only.** No new data can be fetched, no work can be submitted to
  the server, nothing can be changed for anybody else.
- **Revocation is immediate on our side and delayed on the device.** Revoking
  the session revokes its grant at once and refuses every refresh. The device
  stops, and is wiped, when it next has signal. A thief who keeps the phone in a
  Faraday bag never gets that signal, and there is no engineering answer to that
  — it is what "works offline" means. The grant then ends by itself within seven days.

## What follows from that

- **Report a lost phone immediately.** Revoking the session (`DELETE /v1/sessions/{id}`, or the
  person's sessions from the People screen) revokes the grant with it, so the next time that
  device has signal it is out. Revoking the grant alone (`revokeOfflineGrant`) lasts only until
  the phone's next refresh, which issues a new one. This is the single most effective control,
  and it depends on a person telling somebody.
- **The mobile app must encrypt its local database at rest** — P11's job, done with
  SQLCipher and a key in the keychain ([the mobile app's local data](../mobile/README.md)), and
  the reason this window is defensible rather than reckless.
- **One live grant per device.** Issuing a new one supersedes the last, so a
  re-registered phone does not leave a second usable credential behind it.
- **Grants are issued to the mobile app only.** The desktop and web apps have no
  offline story in this product, and a week-long credential with no benefit is
  a liability.

## Changing it

Lower it freely for a customer who asks: it is a per-environment configuration
value, and the only cost is more sign-ins.

Raising it should mean writing down why, here, with a date and a name. The
number is not the interesting part — what makes seven days defensible is
everything in the section above, and a longer window weakens each of them
proportionally.

## The keys in the app, and a rotation

The phone checks grants against the public keys it was built with:
`EXPO_PUBLIC_AUTH_VERIFICATION_KEYS`, an EAS environment variable per environment, holding
exactly the deployment's `AUTH_VERIFICATION_KEYS` (setup guide, Stage 8). They are public by
nature: they can check a token, never mint one. Because they are written into the JavaScript
bundle, an over-the-air update (`eas update`) carries new keys as well as a store build does.

Rotating the signing key therefore means:

1. Publish the new public key in `AUTH_VERIFICATION_KEYS`, beside the old one, and put the same
   two keys in `EXPO_PUBLIC_AUTH_VERIFICATION_KEYS`. Publish an update to every channel and build
   new apps.
2. Wait for that update to reach phones (a phone takes it on launch or on coming back to the app,
   and runs it from its next start).
3. Switch `AUTH_SIGNING_KEY` and `AUTH_SIGNING_KEY_ID`.
4. Keep the old public key published, on the server and in the apps, for at least seven more days,
   until every grant it signed has ended.

A phone still on the old bundle after step 3 gets grants it cannot check: it opens while it has
signal, and asks for a connection without. A rotation is a planned fortnight, not an afternoon.
`keys.ts` accepts a set of verification keys precisely so that step 4 is possible.

## Phones on an older build

A phone app built before the grant was sent (any build before the release that carries this page)
keeps opening on its refresh token for up to thirty days, because the check above is in the app.
The fix reaches it with the over-the-air update on its channel; no new install is needed.
