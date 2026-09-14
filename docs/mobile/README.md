# The mobile app's local data

The phone holds a mirror of the engineer's work and every screen renders from it (P11). Nothing
a screen shows waits on the network; the network only ever changes what is on the phone, and
the screens follow.

```
app/ (screens)          useLocalQuery → SQLite. No API calls: a lint rule refuses them.
        │
src/local/local-data    open · download · wipe — one instance, outside React
        │
src/local/*             migrations, snapshot, queries, search, eviction, wipe
        │
device.ts               expo-sqlite + SQLCipher, key in SecureStore
```

Sync (P12) replaces the one-way download. Everything else here stays.

---

## Screens read the phone, never the API

- `useLocalQuery(key, tables, query)` runs a query against SQLite and runs it again after any
  committed write to `tables`. While the first answer is on its way — milliseconds — the
  screen shows nothing rather than a spinner, because nothing is being fetched.
- `app/**` and `src/components/**` may not use `session().client`, `@tanstack/react-query` or
  the download module (`apps/mobile/eslint.config.js`). A screen that wants fresher data asks
  `localData.download()` to run and keeps showing what it has.
- The sync banner says how current the phone is — updating, updated at, offline since, or
  that sign-in is needed — and never covers the work underneath.

## The local schema

Shaped for the phone's reads, not copied from the server (`src/local/migrations.ts`):

| Table                    | Holds                                                                                                                         |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `work_orders`            | One row per job, carrying its customer's and site's names and address so the job list is one query. `data` is the API detail. |
| `customers`, `sites`     | As downloaded. A site's access notes are columns: they are the first thing on the job screen.                                 |
| `forms`, `form_versions` | Each form's live version, and any version a draft was started on.                                                             |
| `drafts`                 | **Unsent work.** Written by P13.                                                                                              |
| `files`                  | Downloaded files, and files waiting to upload (**unsent work**).                                                              |
| `search`                 | FTS5 over jobs and customers, kept by triggers.                                                                               |
| `meta`                   | Who the phone's data belongs to, and when it was last downloaded.                                                             |

Timestamps are UTC ISO 8601 text, so comparing the text compares the instants.

### Versions and upgrades

The database carries its version in `PRAGMA user_version`. On open, each newer migration
runs **in its own transaction with its version bump**: a migration that fails leaves the
database at the version before it, work intact, and the app says so rather than wiping. A
database newer than the app (a rolled-back release) is not opened.

**Every migration is tested against unsent work written at each earlier version**
(`migrations.test.ts`). Adding migration _n_ means adding `UNSENT_WORK_AT[n - 1]`: the test
refuses a migration list without it. Downloaded tables may be reshaped or rebuilt; `drafts`
and pending files are only ever added to.

## Encryption at rest

- **SQLCipher**, compiled in by the `expo-sqlite` config plugin (`useSQLCipher` in
  `app.json`). That needs a development or release build; Expo Go has plain SQLite.
- **The key** is 32 random bytes made on first launch and kept in SecureStore with
  `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: never in a backup, never on another phone. It is given
  to SQLCipher as a raw key, so opening costs no key derivation.
- **Outside development, a build without SQLCipher refuses to store anything.** Settings shows
  the cipher version, which is how a phone is checked.
- **One connection.** `expo-sqlite`'s exclusive transactions open a second connection that
  never receives the key, so transactions run on the one keyed connection behind a queue
  (`database.ts`).
- A key that does not open the file (the keychain entry lost) means the file is unreadable to
  anyone; it is deleted and the phone starts again. No other error deletes it.
- Downloaded files are not yet encrypted separately: they live in the app's private storage,
  which iOS Data Protection and Android's app sandbox protect, and a wipe deletes them. P14,
  which downloads attachments, revisits this.

## Keeping it current (until P12)

`downloadWork` (`src/local/download.ts`) fetches the person's open jobs (every state but
complete, reviewed and cancelled) and the jobs they closed in the retention window
(`GET /v1/work-orders?closedSince=`), each job's detail, its customers and its forms' live
versions, and writes them **in one transaction**. It runs on launch, on returning to the
foreground and when the connection comes back, and only when the phone is online and holds a
refresh token that has not expired — a phone open on its offline grant alone does not try,
because the attempt would end the session.

A job the server no longer lists is removed, unless unsent work points at it.

## What the phone keeps

| Kept                            | For                                               |
| ------------------------------- | ------------------------------------------------- |
| Open jobs                       | Always                                            |
| Closed jobs                     | 30 days after they close                          |
| Customers, sites, forms         | While a kept job needs them                       |
| Downloaded files                | Up to 500 MB, least recently opened removed first |
| Drafts, files waiting to upload | **Always**, and anything they point at            |

Eviction (`src/local/eviction.ts`) runs inside each download and when the app opens. It deletes
rows first and files from disk after the commit.

## Search

Each word typed matches the start of a word, over a job's reference, title, customer, site,
address and type, and a customer's name, account number, phone, email and address. Accents
and case are ignored and Arabic is split into words. What is typed is quoted before FTS5 sees
it, so `-`, `"`, `AND` or `title:` are words, not syntax.

## Signing out, and a lost phone

| The session ended because…                               | The phone                                                      |
| -------------------------------------------------------- | -------------------------------------------------------------- |
| The person signed out                                    | Is wiped. With unsent work on it, they are asked first.        |
| The server refused a refresh (revoked, membership ended) | Is wiped the moment the refusal arrives.                       |
| The refresh token expired on an unopened phone           | Keeps its work, encrypted, until somebody signs in.            |
| Somebody else signs in                                   | Is wiped before their work is downloaded or anything is shown. |

**Remote wipe** is revocation: `POST /v1/members/:userId/sessions/revoke` (or revoking one
session). The phone is wiped the next time it renews its session with the API. Access tokens
are checked by signature alone and last 15 minutes, so that is within 15 minutes of the
revocation once the phone has signal; it tries on launch, on returning to the foreground and
when the connection returns. A phone kept offline is not
wiped until then; see [offline access](../auth/offline-access.md) for why that is the honest
limit.

A wipe closes the database, deletes the key, deletes the database file and deletes the files
directory, attempting every step even if one fails and reporting failures to Sentry. Once the
key is gone, the database file is unreadable even if deleting it failed.

Only a refusal ends a session: a refresh answered 400, 401 or 403. A 502 or 503 is an outage,
and the session — and the phone's work — is kept (`packages/api-client/src/session.ts`).

## Testing it

The data layer runs on Node's built-in SQLite in `vitest` (`src/local/testing/node-driver.ts`):
real SQLite, with FTS5 and JSON functions, running the phone's migrations and queries.
SQLCipher, SecureStore, the file system and aeroplane mode need a phone:
[device checklist](device-checklist.md).
