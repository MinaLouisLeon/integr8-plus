# The phone's offline grant

**The window is seven days** (`AUTH_OFFLINE_GRANT_TTL_SECONDS`), counted from the
last time the phone reached the API. A longer window is friendlier to engineers
and worse if a phone is stolen; seven days was the decision.

## What it is

A signed EdDSA JWT (`typ: offline`, the company `tid`, `role`, session `sid`, grant
id `gid`) the phone keeps in SecureStore and checks itself with no network. It
unlocks the data already on the phone; it cannot fetch anything. Reaching the
API still needs a fifteen-minute access token, obtainable only online.

- Issued with every token pair for `clientApp: mobile`: password sign-in, an
  emailed code, switching company, every refresh. Each replaces the last
  (`offline_grants`), so a phone in use always has seven days from its last
  contact. Never past the session's own end.
- **Never** issued to the web or desktop apps (they do not work offline) or to a
  session staff hold as the company.

## What the phone does

On launch and on returning to the app (`SessionManager.openDecision`,
`packages/api-client/src/session.ts`):

| The phone holds…                                 | It…                                                   |
| ------------------------------------------------ | ----------------------------------------------------- |
| A grant that checks out                          | Opens, with or without signal                         |
| A lapsed grant or none, and can reach the API    | Refreshes (which brings a new grant) and opens        |
| A lapsed grant or none, and cannot reach the API | Shows _Connect to carry on_ and keeps the unsent work |
| A session the server refused, or expired         | Goes to sign-in (refused: wiped first)                |

It never opens on its thirty-day refresh token alone: with no signal it cannot
tell whether the office revoked it this morning.

## What is checked on the phone, and what is not

`checkOfflineGrant` (`apps/mobile/src/lib/offline-grant.ts`, Ed25519 with
`@noble/curves`, since Hermes has no WebCrypto):

- **Our API signed it**: against the public keys built into the app
  (`EXPO_PUBLIC_AUTH_VERIFICATION_KEYS`, the deployment's `AUTH_VERIFICATION_KEYS`),
  algorithm pinned to EdDSA.
- **It is an offline grant**: `offlineGrantClaimsSchema`; an access token does
  not open the phone.
- **It has not ended**: its signed `exp`, and the end sent with it.
- **The clock was not set back before it**: `iat` at most five minutes ahead.

Not checked: **revocation** (needs the server), **the clock within the week**
(setting it back inside the grant's week keeps it open; the phone's lock screen
is the barrier), **issuer** (each deployment has its own keys, so another
deployment's grant fails the signature), and **that the grant matches the data**
(the phone is wiped whenever somebody else signs in). A build made without the
keys checks only the end sent with the grant.

## What it costs

A phone revoked while offline keeps opening, showing what is already on it,
until its grant ends: at most seven days after it last reached the API. Once it
has signal it refreshes, the refusal arrives and it is wiped. That is the honest
limit of working offline; a shorter window is a one-line setting.
