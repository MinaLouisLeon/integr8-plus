# Offline access, and what it costs

P03 requires this decision to be written down rather than merely made:

> Decide the offline token lifetime with the security tradeoff written down: a
> longer window is friendlier to engineers and worse if a phone is stolen.

**The window is seven days**, configurable per environment via
`AUTH_OFFLINE_GRANT_TTL_SECONDS`.

---

## What the grant is

A signed token the mobile app keeps in the OS keychain and verifies **itself**,
against a public key compiled into the app, with no network involved. If it
verifies and has not expired, the app opens and shows the work already
downloaded.

It is not an API credential. It unlocks cached data on the device; it cannot
fetch anything. Reaching the API still needs an access token, which lasts
fifteen minutes and can only be obtained online.

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

**A lost or stolen phone can be opened and read for up to seven days.** That is
the honest statement. Everything below reduces it; nothing removes it.

- **The phone's own lock screen is the first barrier.** The grant is in the
  keychain, which needs the device unlocked. An attacker with an unlocked phone
  has the app anyway.
- **The grant unlocks one company at one role.** It carries `tid` and `role`,
  so a stolen engineer's phone shows one company's jobs at an engineer's
  permissions. Not an admin's, and not anybody else's company.
- **Cached data only.** No new data can be fetched, no work can be submitted to
  the server, nothing can be changed for anybody else.
- **Revocation is immediate on our side and delayed on the device.** Revoking
  the grant marks it revoked at once and stops any new access token being
  issued. The device stops when it next has signal. A thief who keeps the phone
  in a Faraday bag never gets that signal, and there is no engineering answer to
  that — it is what "works offline" means.

## What follows from that

- **Report a lost phone immediately.** Revoking the session revokes the grant
  with it, so the next time that device has signal it is out. This is the single
  most effective control, and it depends on a person telling somebody.
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

## How a rotation interacts with this

An offline grant is verified against a key the app already has. Rotating the
signing key therefore means:

1. Publish the new public key in `AUTH_VERIFICATION_KEYS` and ship an app
   release containing it.
2. Wait for that release to reach devices.
3. Switch `AUTH_SIGNING_KEY` and `AUTH_SIGNING_KEY_ID`.
4. Keep the old public key published for at least seven more days, until every
   grant it signed has expired.

A rotation is a planned fortnight, not an afternoon. `keys.ts` accepts a set of
verification keys precisely so that step 4 is possible.
