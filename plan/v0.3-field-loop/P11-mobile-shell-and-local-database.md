# P11 — Mobile shell and local database

**Version:** v0.3 Field Loop
**Status:** `IN PROGRESS — built and verified off-device; awaiting the phone checklist`
**Depends on:** P05, P10

## Goal

The mobile app holds a local mirror of the engineer's work and renders entirely from it,
never waiting on the network.

## Scope

Local persistence and the read path. Synchronisation is P12.

## Tasks

- [x] SQLite on device (`expo-sqlite` or `op-sqlite`) with a migration mechanism of its own
- [x] Local schema mirroring the server tables the engineer needs — jobs, customers, sites, forms, drafts, files
- [x] Local repository layer; screens read from SQLite only and never call the API directly
- [x] Reactive queries so the UI updates when local data changes
- [x] Local database versioning and a safe upgrade path for an app updated after weeks offline
- [x] Encrypted storage for the local database
- [x] Wipe-on-signout, and remote wipe when a device is revoked
- [x] Storage budget: how much history is kept on device, and what is evicted first
- [x] Local full-text search over jobs and customers

## Exit criteria

- [ ] Every screen renders with the network disabled and the device in aeroplane mode
- [ ] No screen shows a network spinner for data that exists locally
- [ ] Upgrading the app across two local schema versions preserves all unsent work
- [ ] Signing out leaves no readable company data on the device

## Notes

- The local schema does not have to match the server schema. Optimise it for the phone's
  read patterns — the sync layer in P12 is the translator.
- Decide the eviction policy now. An engineer with three years of history will otherwise
  fill their phone.

---

## Progress

Everything in the task list is built, and everything that can run off a phone is verified:
the data layer against real SQLite, the download against the real API, and both app bundles
build. **No exit criterion is ticked**, because each one is about the phone — aeroplane mode,
an installed upgrade, SQLCipher, the keychain — and this machine has no Android SDK, emulator
or iOS toolchain. They close when the [device checklist](../../docs/mobile/device-checklist.md)
has been run on a development build. The design is in
[docs/mobile](../../docs/mobile/README.md).

| Claim                                            | How it was proven so far                                                                                                                                                                                                                                                                                                                                                                 | Still needs                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Every screen renders offline                     | Screens never call the API: a lint rule refuses `session().client`, React Query and the download module in `app/**` and `src/components/**` (a probe file fails it). Every screen reads through `useLocalQuery`. The job, customer, site, search and storage queries run against real SQLite in tests                                                                                    | Checklist 2 in aeroplane mode     |
| No network spinner for local data                | The only spinners left are the sign-in button and a busy sign-out button. A screen waiting on SQLite renders nothing; the launch screen no longer shows one                                                                                                                                                                                                                              | Checklist 2                       |
| An upgrade across two schema versions keeps work | For each earlier version, unsent work is written with that version's columns and the database upgraded to the newest: drafts, pending uploads and what they point at survive, and search finds rows downloaded before search existed. A migration that deletes drafts fails both tests. A failing migration rolls back to the version before it; a newer database is refused, not opened | Checklist 4 on an installed build |
| Signing out leaves nothing readable              | The wipe closes the database, deletes the key, then the file and the files directory, every step attempted even after a failure (tested). Against the real API, revoking the engineer's sessions made the phone's next renewal end the session as `rejected`, which wipes. SQLCipher and the keychain are native and untested here                                                       | Checklists 1, 5 and 6             |
| The download matches the real API                | Signed in as an engineer against the dev API and PostgreSQL: the scheduled job, its access notes, customer, site and contact, and the form's live definition landed in SQLite; search found the customer and the job number; a second download changed nothing                                                                                                                           | —                                 |
| Nothing else regressed                           | Workspace lint, typecheck, unit tests and build; db work-order integration 17, API work-order integration 14, api-client 33, mobile 38; `expo export` for iOS and Android                                                                                                                                                                                                                | —                                 |

## Decisions taken during implementation

- **`expo-sqlite` over SQLCipher**, chosen before implementation. Its config plugin compiles
  SQLCipher and FTS5 in; that needs a development build, which P11 needs anyway.
- **The key is random and lives in the keychain** (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`), not
  derived from a password or the session: the phone must open in a basement with no signal,
  and a key tied to a token would be lost with it.
- **A one-way "download my work" stands in for sync**, chosen before implementation. It writes
  one snapshot in one transaction; P12 replaces it and keeps the schema, queries and screens.
- **Retention: open jobs, closed jobs for 30 days, files up to 500 MB (least recently opened
  first), unsent work never** — chosen before implementation.
- **The API gained `closedSince`** on `GET /v1/work-orders`, so a phone can ask for exactly the
  history it keeps instead of paging through three years.
- **An expired refresh token keeps the phone's work; a sign-out or a refusal wipes it.** Expiry
  is nobody's decision about the phone, and wiping on it would destroy a week offline's unsent
  work. Somebody else signing in wipes it first.
- **Three migrations, not one.** Search (2) and the file budget's last-opened time (3) were
  built as their own versions, so the upgrade path is exercised from the first release rather
  than first tested when it is needed.
- **Settings shows the SQLCipher version,** because a development build may run without it and
  the checklist needs a way to tell.
- **Remote wipe is revocation, and takes up to 15 minutes once the phone has signal**: access
  tokens are verified by signature, so a revoked phone is refused at its next renewal.

## Found while building this

- **A 502 would have wiped a phone.** The session manager (P05) signed out on any failed
  refresh. Harmless while signing out only cleared tokens; with sign-out now wiping unsent
  work, a load balancer restart would have destroyed it. Only 400, 401 and 403 end a session
  now; tested for 429, 502 and 503.
- **A phone on its offline grant would have ended its own session.** Any API call with an
  expired refresh token clears the stored session, grant included, before sending anything.
  Background downloads now check `canReachApi()` first.
- **`expo-sqlite`'s exclusive transactions cannot work on an encrypted database.** They open a
  second native connection that never receives `PRAGMA key`. Transactions run on the one keyed
  connection behind a JavaScript queue instead.
- **`ACTIVE_WORK_ORDER_STATES` leaves out `scheduled`** — it means "an engineer is out on the
  job". Downloading by it would have left tomorrow's jobs off the phone; the download test
  caught it, and the phone asks for every state that is not closed.
- **A lint override would have silently dropped the right-to-left rule.** ESLint replaces a
  rule's options when a later config sets it, so the mobile screens' `no-restricted-syntax`
  would have removed P05's `textAlign` checks there. `@integr8/eslint-config` now exports the
  selectors so an app can extend them.
