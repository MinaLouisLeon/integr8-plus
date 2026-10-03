# P12 — Offline sync engine

**Version:** v0.3 Field Loop
**Status:** `IN PROGRESS — built and verified off-device; awaiting the phone checklist`
**Depends on:** P11

## Goal

Work done without signal arrives at the server intact, exactly once, in order — and the
engineer can see that it did.

## Scope

The hardest phase in the plan. Give it the time it needs; every shortcut here becomes a
data-loss incident later.

## Tasks

- [x] Outbox table: every mutation recorded as a durable, ordered, retryable record
- [x] Client-generated UUIDv7 idempotency key on every mutation, deduped by the server table from P04
- [x] Delta pull with a change cursor, **scoped to this engineer's assignments only** — never a whole tenant
- [x] Push loop with exponential backoff, retry limits, and a permanent-failure state that surfaces to the user
- [x] Per-entity version numbers; server is the authority
- [x] Conflict detection and a resolution screen showing both versions in human terms
- [x] Attachment queue, separate from the mutation queue: chunked, resumable, surviving app kill
- [x] Sync status UI: items pending, last successful sync, current activity, manual force-sync
- [x] Background sync respecting battery and network type
- [x] Clock-skew handling — device time cannot be trusted for ordering
- [x] Instrumentation: sync duration, queue depth, failure rate, reported to the server
- [x] Test harness that simulates flaky networks, mid-upload kills, and clock skew

## Exit criteria

- [ ] A full job completed in aeroplane mode — answers, ten photos, two signatures — arrives complete after reconnection
- [ ] Killing the app during upload and reopening it resumes without duplicating or losing anything
- [ ] The same job edited on two devices offline produces a resolvable conflict, never silent data loss
- [x] Replaying the entire outbox twice produces identical server state
- [ ] An engineer can tell at a glance whether it is safe to leave site

## Notes

- Attachments are the number one sync failure source. Keep their queue separate from the
  mutation queue so a stuck 40MB video never blocks a completed job from arriving.
- Submissions are append-only, so they rarely conflict. Job assignment and status are
  where conflicts actually happen — design the resolution screen around those.

---

## Progress

Every task is built. Each exit criterion is proven end to end off a device: the phone's own
sync engine and SQLite, against the real API and PostgreSQL, over a network the tests break on
purpose (`apps/api/src/sync/sync.integration.test.ts`). **Only the replay criterion is
ticked**: it is about the server, and the suite proves it. The others are about a phone in a
plant room: aeroplane mode, a killed app, the OS's background scheduler. They close when [P12 on a phone](../../docs/mobile/device-checklist.md#p12) has been
run; the steps that need a form or the camera on the phone wait for P13 and P14. The design is in
[docs/sync](../../docs/sync/README.md).

| Claim                                                   | How it was proven so far                                                                                                                                                                                                                                                                                 | Still needs                           |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| A full job in aeroplane mode arrives complete           | Offline: the job moved to complete, every checklist item, a note, access notes, a form with answers, ten photos and two signatures. Not safe to leave until one sync after reconnecting; then the server holds every change, twelve confirmed files and the submission, and the phone says safe to leave | Checklist 1 (P14 for form and photos) |
| A killed upload resumes, duplicating nothing            | A 20 MB multipart upload loses its second part and the push loses its reply; the app is killed and reopened on the same database. It asks which parts arrived, sends the rest, and the server has one file, one note, one event per move                                                                 | Checklist 2 (P14)                     |
| Two devices offline give a resolvable conflict          | Access notes changed on both: only the disputed note is asked about, the choice is sent, nothing lost. A job moved on elsewhere: keep theirs leaves the phone showing theirs. A job cancelled at the office is never completed. Answers changed on both merge, asking only about the shared question     | Checklist 3                           |
| Replaying the outbox twice gives identical server state | Every change, including a submit and a completion, reset to pending and sent twice more: the job, submissions and event count are identical. Disabling idempotency fails the test. A reused change id with different content is refused                                                                  | —                                     |
| Safe to leave at a glance                               | `jobSyncState` is false while any change, upload or unsent form for the job remains; the badge beside Back and the card under the access notes read from it. Tested against the server in the aeroplane-mode and taken-off-the-job scenarios                                                             | Checklist 5 with a person             |
| Clocks, flaky networks, battery                         | A form filled two days before sending is judged by the day it was filled; a phone three hours out syncs and reports its offset; 503s back off and send when due; low battery holds uploads until forced; a change the server cannot read is refused alone while the rest go                              | Checklist 4 for the OS scheduler      |
| The change log skips nothing                            | A pull while a slower transaction is still open catches that transaction's job on the next pull; using `xmax` instead of `xmin` for the horizon fails the test. Pruning leaves a mark, and an older cursor starts again                                                                                  | —                                     |
| Outbox rules                                            | Order per record, holding back behind a retry or a failure, backoff, offline not counted as an attempt, autosaves folded, answers based on the confirmed start, a submit waiting for its files (unit tests; removing the file wait or the answers rule fails them)                                       | —                                     |
| Nothing else regressed                                  | Workspace lint, typecheck, unit tests and build (57 tasks); db integration 231, API integration 119 (sync 14, media-local 16); offline 36, API unit 105, mobile 4; `expo export` bundles without `node:sqlite`                                                                                           | —                                     |

## Decisions taken during implementation

- **The server wins, and the engineer decides**, chosen before implementation. Nothing is
  resolved by whose clock is later. A change is merged when that loses nobody's work (a
  different note, a different question, a job still in the state the engineer saw) and
  otherwise parked with both versions for the engineer.
- **Everything syncs over mobile data; uploads pause below 15% battery unless charging or
  forced**, chosen before implementation.
- **The engine is a package, `@integr8/offline`,** with P11's local layer moved into it. It has
  no React Native: the phone passes in SQLite, files, fetch, network and battery. That is what
  lets the API's integration suite run the phone's real engine rather than a model of it.
- **The pull cursor is a PostgreSQL transaction id**, not a timestamp. Triggers log each change
  with its transaction id, and a pull reads up to the oldest running transaction, so a slow
  transaction committing after a faster one is never skipped. A timestamp is taken when the
  transaction starts, not when it commits, and would have skipped it.
- **Idempotency is P04's table, completed in the change's own transaction**, kept 90 days.
  Notes, forms and files also take their ids from the phone, so a resend after that still finds
  them.
- **Transitions conflict on state, not revision.** Someone ticking a checklist item must not
  turn an engineer's "on site" into a conflict.
- **A form's answers are based on what the server last confirmed**, read when the change is
  sent rather than when it was made, so a start and its answers can be queued offline together.
  Unsent autosaves fold into one.
- **Completing a job waits for that job's form changes; submitting waits for its files.** Order
  across the two queues is explicit rather than hoped for.
- **Files over 8 MiB go in 8 MiB parts**, resumable for seven days. The sweeper and R2's
  lifecycle rule abort after eight.
- **Background sync is `expo-background-task`** at the OS's minimum of 15 minutes. It is a
  backstop: launch, foreground, reconnect and Sync now do the real work.
- **Unsent work from P11 moves, it is not dropped.** Local migration 4 turns drafts into forms
  the engine queues, and pending files into uploads; tested with work written at versions 1–3.

## Deploying

- Migration `0011_offline_sync`: the change log, sync reports, multipart intents.
- `pnpm --filter @integr8/api storage provision --all` once per environment, so existing buckets
  get the eight-day multipart rule. Until then a bucket keeps its one-day rule, which would
  abort an upload a phone resumes the next day.
- The worker now also prunes the change log (`SYNC_LOG_RETENTION_DAYS`, 45).

## Found while building this

- **One unreadable change would have stopped every change behind it, for good.** A batch the
  server refused as a whole (400, 413 or 422, say a note over the length limit) failed the run,
  and the next run sent the same batch. Such a batch is now sent one change at a time and only
  the unreadable one is refused. Disabling that fails the test.
- **Keep theirs left the phone showing mine.** The phone's copy of the job still had the
  discarded change applied, and a delta pull does not resend a job that did not change on the
  server. Discarded, conflicting and refused changes now ask for their job to be fetched again,
  and pulled data is overlaid only with changes still pending.
- **The runtime role could not renew an upload.** `upload_intents` had no update grant, so a
  resumed upload failed with `permission denied`. The role may now update `expires_at` only.
- **P09's one-hour abort and one-day lifecycle rule would have destroyed resumable uploads**
  from a phone that went back offline. Both are now eight days, after the seven-day resume
  window.
- **Completing a job could reach the server before its forms,** which would have answered
  `forms_missing` for work that was on its way. Completion now waits for them.
- **Phones share the pre-authentication rate limit by IP address** (300 a minute). The sync
  suite's simulated phones went over it from one address. Engineers behind one site's NAT, or a
  carrier's shared address, could do the same in production. Not changed here; worth revisiting
  in P19 with real traffic.
