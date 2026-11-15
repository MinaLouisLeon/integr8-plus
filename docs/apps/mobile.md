# The phone app

`apps/mobile`: Expo, React Native and Expo Router, built once per company. It is
for engineers in the field and is **offline first**: every screen reads the
phone's own encrypted database, and the network only changes what is on the
phone. The data layer and the sync engine are `@integr8/offline`, which holds no
React Native, so the API's integration suite runs the phone's own engine against
the real server.

```
app/ (screens)          useLocalQuery → SQLite. No API calls: a lint rule refuses them.
        │
src/local/local-data    open · sync · wipe — one instance, outside React
        │
@integr8/offline        migrations, queries, search, eviction, wipe, the sync engine
        │
src/local/device.ts     expo-sqlite + SQLCipher, key in SecureStore
src/local/sync-device   files, fetch, network and battery for the engine
```

## What an engineer does on it

| Screen (`apps/mobile/app/`)                                      | What                                                                                                                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `home`                                                           | Announcements, the clock (clock in/out), the next job, today's jobs, the sync banner                                                                  |
| `jobs/[id]`, `jobs/complete`                                     | A job worked in order: travel, on site, working, waiting for parts; checklist, notes, before/after photos, parts, the customer's sign-off, completing |
| `forms/[id]`                                                     | Filling a form, with autosave, photos (made smaller first), signatures, voice, repeating entries                                                      |
| `customers/[id]`, `sites/[id]`, `sites/access`                   | Customer and site details; correcting access notes                                                                                                    |
| `assets/*`                                                       | Scan a tag, register an asset, record its condition, link it to a job                                                                                 |
| `parts/[id]`, `purchases/[id]`, `receive/*`, `van`               | Parts used on a job, buying on a job, receiving deliveries, the van's stock                                                                           |
| `expenses/*`                                                     | Expense claims with receipts                                                                                                                          |
| `payslips`, `qualifications`, `documents`                        | The person's payslips, skills and certificates, shared documents                                                                                      |
| `assistant/*`                                                    | The AI assistant, when on for this seat in the phone app                                                                                              |
| `sync`, `conflicts/[id]`                                         | What is waiting, uploads, changes that need a decision                                                                                                |
| `settings`, `change-password`, `reconnect`, `welcome`, `sign-in` | Account, the cipher check, offline-grant lapse, the company's first screen                                                                            |

Which buttons appear follows the company's modules, the seat's permissions and
the tabs Integr8 switched off (`PHONE_SCREEN_SECTIONS` in `@integr8/core`).

## The local database

Shaped for the phone's reads, not copied from the server
(`packages/offline/src/migrations.ts`): `work_orders` (with customer and site
names, so the job list is one query), `customers`, `sites`, `forms`,
`form_versions`, `submissions`, `outbox` (every change not yet applied), `uploads`
(files not yet confirmed), `sync_runs`, `files`, `search` (FTS5 over jobs and
customers) and `meta` (whose data it is, announcements, permissions, the
person's own shifts, van stock, expense categories and qualifications).

- **Upgrades.** `PRAGMA user_version`; each migration runs in its own transaction
  with its version bump. A failed one leaves the database as it was; a database
  newer than the app is not opened. Every migration is tested against unsent
  work written at each earlier version (`UNSENT_WORK_AT`): unsent work is only
  ever added to or moved, never dropped.
- **Encryption.** SQLCipher (needs a development or release build; Expo Go has
  plain SQLite). The key is 32 random bytes kept in SecureStore with
  `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: never in a backup or on another phone.
  Outside development a build without SQLCipher refuses to store anything;
  Settings shows the cipher version. Downloaded files sit in the app's private
  storage, not separately encrypted.
- **What is kept.** Open jobs always; closed jobs for 30 days; customers, sites
  and forms while a kept job needs them; downloaded files up to 500 MB (least
  recently opened go first); unsent work always, and anything it points at.
- **Search.** Each typed word matches the start of a word over jobs and
  customers; accents and case ignored, Arabic split into words, typed text
  quoted so it is never FTS syntax.

## Sync

**Recording.** Screens never send anything. They call `record…` functions that
write the phone's copy **and** the outbox in one SQLite transaction. Each change
has a UUIDv7 made on the phone. Kinds: `work_order.transition`, `.checklist`,
`.comment`, `.photo`, `.photo_remove`, `.signoff`, `.visit_done`, `.material`,
`.purchase`, `.purchase_receipt`; `site.access`; `submission.start`, `.answers`,
`.submit`; `shift.start`, `.end`; `expense.submit`, `.receipt`;
`asset.register`, `.condition`, `.link`. Unsent autosaves fold into one;
completing a job waits for its forms', photos' and sign-off's changes.

**Pushing** (`POST /v1/sync/push`, up to 50 changes). Each change id is claimed
in the idempotency table and its outcome stored in the same transaction, kept
`SYNC_REPLAY_DAYS` (90): a resend changes nothing. Changes apply in the order
made; a change not applied holds back later ones to the same record. Outcomes:
`applied`, `conflict` (both versions), `rejected`, `retry`. Backoff from 5 s to
30 minutes; after 10 server failures a change stops and is shown.

**Conflicts: the server wins, the engineer decides.** Merged when nobody's work
is lost (a checklist box, a different question, a job still in the state the
engineer saw); otherwise parked: `state_changed`, `access_changed`,
`answers_changed`, `already_submitted`, `incomplete`. The engineer keeps
theirs, makes it again, or chooses per note or question; a resolved change is
re-sent under a new id in its original place.

**Pulling** (`GET /v1/sync/pull?cursor=`). Only the jobs the person is assigned
to (open, or closed within the phone's window), with their customers, sites,
forms' live versions and the person's submissions, plus jobs they were taken
off. The cursor is a transaction id read from `sync_touches` up to the oldest
running transaction, so a slow transaction is never skipped. Pages of 25; the
cursor is saved after the last. No cursor, or one older than the pruned log
(`SYNC_LOG_RETENTION_DAYS`, 45), returns everything and the phone removes the
rest.

**Files** go separately, so a video never holds up a completed job: `PUT
/v1/media/:id` with a phone-made id; up to 8 MiB in one signed PUT, larger in
8 MiB parts that resume after a kill. Uploads pause below 15% battery unless
charging or **Sync now**. A file that will never arrive fails the changes that
need it, which then show under _Needs your attention_.

**Clocks.** The phone's clock is used for "how long ago", never for order. The
server corrects each change's `recordedAt` by the batch's `sentAt`, and the
database clamps a job change's time to after its previous change, no later than
now and at most 31 days back.

**When it runs.** On launch, on returning to the app, when the connection
returns, on **Sync now**, and in the background about every 15 minutes when the
OS allows. Runs never overlap. Every run is reported to `POST /v1/sync/reports`.

**Seeing it.** A banner (sending, uploading 3 of 12, all sent, waiting, needs
attention), a _Safe to leave_ / _Not sent yet_ / _Needs your attention_ badge on
each job, and the Sync screen.

**Jobs closed meanwhile.** A form the phone started before the office closed the
job is accepted, marked `submittedAfterClose` with a history entry; one started
after is refused. A part recorded before the job closed is accepted and marked
`recordedAfterClose`.

## Signing in, out, and a lost phone

The phone opens with no signal only on its **offline grant**, a signed token
checked on the phone that lasts seven days from its last contact with the API
([offline-access.md](../auth/offline-access.md)). A lapsed grant with no signal
shows _Connect to carry on_ and keeps the unsent work.

| The session ended because…                      | The phone                                          |
| ----------------------------------------------- | -------------------------------------------------- |
| The person signed out                           | Is wiped (asked first when unsent work is on it)   |
| The server refused a refresh (revoked, removed) | Is wiped when the refusal arrives                  |
| The refresh token expired on an unopened phone  | Keeps its work, encrypted, until somebody signs in |
| Somebody else signs in                          | Is wiped before anything of theirs is shown        |

Remote wipe is revoking the session (`POST /v1/members/:userId/sessions/revoke`):
the phone is wiped the next time it reaches the API. A wipe deletes the key
first, so the database is unreadable even if deleting the file fails. Only a
400, 401 or 403 on refresh ends a session; a 502 or 503 is an outage.

The app locks on start and after five minutes in the background, and opens with
fingerprint, face or the phone's own passcode; the lock covers the screens, so
a half-filled form stays underneath.

## Notifications, crashes, updates

- **Push.** The phone registers its Expo token for its session (`PUT
/v1/me/push-device`). A trigger on `work_order_events` queues
  `push.work_order_event`: assigned, rescheduled, dispatched, cancelled, made
  urgent (channels `jobs` and `urgent`); the person who made the change is not
  told. Certificate and deadline warnings come from the worker. Text follows the
  phone's language.
- **Crashes.** Sentry stores events on disk and sends them at the next launch
  with signal, tagged with build, update id and channel; needs
  `EXPO_PUBLIC_SENTRY_DSN`.
- **Over-the-air updates.** `expo-updates` with EAS Update; runtime version
  `fingerprint`, so an update reaches only binaries with the same native code.
  Build settings (`EXPO_PUBLIC_API_BASE_URL`, `EXPO_PUBLIC_APP_ENV`,
  `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_AUTH_VERIFICATION_KEYS`) are written into
  the bundle.
- **Forms newer than the app.** A phone too old for a form's format shows
  "Update the app" for that form (`apps/api/src/sync/form-formats.ts`).

## A company's own build

Each company gets its own app: its name, icon, colours, website on the welcome
screen, and a sign-in that accepts only its people. CI writes the git-ignored
`apps/mobile/company.json` from `GET /v1/public/companies/{slug}/brand` and the
icon to `apps/mobile/company/icon.png`; `app.config.ts` derives the identifiers
from the slug (`com.integr8.plus.<slug>` on iOS, hyphens become underscores on
Android, a leading digit gets a `c`). One Expo account and project (EAS slug
always `integr8-plus`) and one Firebase project with an Android app per company
serve every company; the update channel is `production-<slug>`. The version
comes from the root `package.json`. How builds are started:
[deployment/](../deployment/README.md#company-apps).

## Testing it

The data layer runs on Node's built-in SQLite in Vitest
(`packages/offline/src/testing/node-driver.ts`). The API's sync suite
(`apps/api/src/sync/sync.integration.test.ts`) runs the phone's engine against
the real API through a network that can drop requests, answer 503 or kill an
upload. SQLCipher, SecureStore, files, the lock and aeroplane mode need a real
phone.
