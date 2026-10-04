# Offline sync

Work done without signal arrives at the server intact, exactly once, in order — and the
engineer can see that it did (P12).

```
phone                                              server
─────                                              ──────
screen ─▶ record*()  ─┐                            POST /v1/sync/push   → applied once each, in order
          one txn:    │ outbox ──── push ────────▶   idempotency table (90 days) + per-record rules
          local copy  │                              conflict? both versions back
          + outbox    │ uploads ─── PUT /v1/media/:id, parts, complete
                      │                            GET  /v1/sync/pull   → changes since a cursor,
screens ◀─ SQLite ◀───┘ ◀────────── pull ─────────   this person's jobs only
                                                   POST /v1/sync/reports
```

The engine is `@integr8/offline` (`packages/offline/src/sync`). It has no React Native in it:
the phone gives it SQLite, files, `fetch`, the battery and the clock
(`apps/mobile/src/local/sync-device.ts`), and the integration suite gives it Node's.

---

## Recording a change

Screens never send anything. They call `recordTransition`, `recordChecklist`, `recordComment`,
`recordAccessChange`, `recordFormStarted`, `recordAnswers`, `recordSubmit`, `queueUpload` and,
for the working day (P14), `recordShiftStart`, `recordShiftEnd`, `recordPhoto`,
`recordPhotoRemoved` and `recordSignoff`,
each of which writes the change to the phone's copy of the record **and** to the outbox in one
SQLite transaction. The screen shows it at once; it cannot be lost between the two.

| Change                 | Sent as                                        | Base (what it was made against)           |
| ---------------------- | ---------------------------------------------- | ----------------------------------------- |
| Move a job on          | `work_order.transition`                        | the state the engineer saw                |
| Tick a checklist item  | `work_order.checklist`                         | —                                         |
| Add a note             | `work_order.comment`                           | — (the note's id is chosen on the phone)  |
| Correct access notes   | `site.access`                                  | the values the engineer saw               |
| Start a form           | `submission.start`                             | — (the form's id is chosen on the phone)  |
| Autosave / submit      | `submission.answers` / `submission.submit`     | the answers the server last confirmed     |
| Photo, signature, file | the upload queue                               | — (the file's id is chosen on the phone)  |
| Clock in / out         | `shift.start` / `shift.end`                    | — (the shift's id is chosen on the phone) |
| Before / after photo   | `work_order.photo` / `work_order.photo_remove` | — (waits for its file)                    |
| Customer sign-off      | `work_order.signoff`                           | — (waits for the signature's file)        |

Every change has a **UUIDv7** id made on the phone. Autosaves of a form that have not been sent
are folded into one — never into a change the engine has already handed to the network, which it
marks (`sent_at`) in the same transaction that chooses the batch, since the server may have
applied that id already (P13); a submit replaces an unsent autosave. Completing a job waits for its forms',
photos' and sign-off's changes; submitting a form waits for the files it names. A transition carries
when the phone recorded it, and the server keeps that time within bounds
([the working day](../mobile/job-execution.md#time)).

## Sending: once, in order

`POST /v1/sync/push` takes up to 50 changes.

- **Once.** Each change's id is claimed in the P04 idempotency table before anything is
  written, and the outcome is stored **in the same transaction** as the change, kept for
  `SYNC_REPLAY_DAYS` (90). A resend gets the stored outcome and changes nothing. A server that
  dies mid-change leaves a claim that lapses in two minutes. Notes, forms and files also carry
  their own ids, so a resend after the replay window still finds them.
- **In order.** The phone sends changes in the order they were made; the server applies them in
  that order and, when one is not applied, holds back later changes to the same record
  (`retry: blocked`). On the phone a change goes only when everything before it for the same
  record is done.
- **Outcomes.** `applied` (or already true on the server), `conflict` (both versions), `rejected`
  (would not succeed if sent again), `retry` (try later; `retryAfterSeconds`).
- **A batch the server cannot read** (400, 413, 422 — say, a note longer than the server
  allows) is sent again one change at a time; the one it still cannot read is refused
  (`unreadable_change`) and shown to the engineer, and everything else goes.
- **Backoff.** 5 s, 10 s, 20 s… up to 30 minutes, or what the server asks. No connection is not
  an attempt. After 10 server-side failures a change stops and is shown to the engineer.

## Conflicts: the server wins, the engineer decides

A change made against a version the server no longer holds is merged when that loses nobody's
work, and otherwise parked as a conflict. Nothing is resolved by whose clock is later.

| Record       | Merged automatically when                                                                                 | Otherwise                                                                                                            |
| ------------ | --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Job state    | the job is still in the state the engineer saw (other edits don't matter), or already where they moved it | `state_changed`: who moved it, to what, why; "move it again" if the state machine allows                             |
| Checklist    | always — a box is ticked or not                                                                           | —                                                                                                                    |
| Access notes | nobody else changed the same note                                                                         | `access_changed`: each disputed note, theirs and mine                                                                |
| Form answers | nobody else changed the same question                                                                     | `answers_changed`: each disputed question; other answers are kept                                                    |
| Submitting   | —                                                                                                         | `already_submitted` from elsewhere; `incomplete` when completing without the forms, photos or sign-off the job needs |

When the server merges a form's answers without a conflict, the merged answers come back with
the `applied` result and replace the phone's copy — and any autosave still waiting — except for
questions the engineer has changed here since, so the next autosave cannot undo the other
device's work; an open fill screen takes them on the same way. A submit the server refuses, or
the engineer drops, makes the form a draft again on the phone, with the engineer's answers kept
as that draft; the refresh that follows fetches the job's forms as the server has them.

The phone shows the server's version of a record with a change in conflict or refused, and lists
that change on the Sync screen. The engineer keeps theirs (`discardChange`), makes theirs again
(`retryChange`, from the job's real state), or chooses per note or question
(`resolveAccessConflict`, `resolveAnswersConflict`). A resolved change is re-sent under a new
id, in its original place in the order.

A repeatable section's entries are merged entry by entry and answer by answer, and conflict
only when the same entry's answer was changed both ways, or an entry removed on one side was
changed on the other (P13b, [repeating groups](../form-engine/repeating-groups.md#files-prefill-and-sync)).

## Pulling: this person's work, nothing skipped

`GET /v1/sync/pull?cursor=` returns the jobs the person is on — open, or closed within the phone's
retention window — that changed since the cursor, each with its customer and sites, its forms'
live versions and the person's submissions, plus jobs they were taken off.

- **Scope.** Only jobs with an active assignment for the caller; a change to a job's site,
  customer or forms counts as a change to the job. Nothing about other people's jobs, including
  their ids, is returned.
- **The cursor is a transaction id.** Triggers log every change in `sync_touches` with its
  transaction id. A pull reads up to `pg_snapshot_xmin(pg_current_snapshot())` — the oldest
  transaction still running — and returns that as the next cursor, so a slow transaction that
  commits after a faster, later one is caught next time instead of skipped. The integration suite
  holds a transaction open across a pull to prove it.
- **Pages** of 25 jobs share the first page's horizon. The cursor is saved only after the last
  page, so an interrupted pull starts again safely.
- **Reset.** No cursor, or one older than the pruned log (`SYNC_LOG_RETENTION_DAYS`, 45), returns
  everything in scope; the phone removes what was not in it.
- The engineer's pending changes are applied again on top of whatever arrives.

## Files

Kept apart from changes, so a large video never holds up a completed job.

- Files are kept by a path relative to the files directory: iOS moves the app's container when
  the app is updated.
- `PUT /v1/media/:mediaId` with an id chosen on the phone starts the upload, or says where it
  stands: a fresh link, `stored`, or which way it goes. Repeating it is harmless.
- Up to 8 MiB: one signed PUT. Larger: 8 MiB **parts** (`POST …/parts` for links,
  `GET …/parts` for what arrived). The phone records each part as it lands; after a kill it asks
  which parts storage holds and sends the rest.
- An unconfirmed upload is kept for 7 days; the sweeper aborts parts older than 8 days.
- A file that will never arrive — gone from the phone, refused by the server, or failed ten
  times — is `failed`, and every change waiting for it fails with it (`upload_failed`), so the
  submit, photo or sign-off that names it is listed under _Needs your attention_ to try again
  (which tries the file again too) or discard, instead of reading _Not sent yet_ for ever.
  Trying the file again from the Uploads list puts those changes back to waiting for it.
- Uploads pause below 15% battery unless charging or the engineer taps **Sync now**. Mobile
  data is used for everything.

## Clocks

The phone's clock is used for how long ago something happened and when to try again — never
for order. Pull and push answers carry `serverTime`; the phone measures the offset at the
middle of the request, keeps it, and uses corrected time for the retention window and "last
synced". A change carries `recordedAt` and the batch `sentAt`, both by the phone's clock; the
server takes their difference from when it received the batch, so "the day this form was filled"
is judged against when it was filled, even days later and whatever the phone's clock says. A
submit location's `capturedAt` is corrected the same way.

## When it runs

On launch, returning to the foreground, regaining a connection, **Sync now**, and in the
background (`expo-background-task`, about every 15 minutes, when the OS allows). Runs never
overlap; a trigger during a run becomes one more run straight after.

## Seeing it

- **Banner** on the job list and settings: sending, uploading 3 of 12, everything sent,
  waiting (with or without connection), needs attention.
- **Job screen**: a _Safe to leave_ / _Not sent yet_ / _Needs your attention_ badge beside the
  back button, and a card under the access notes saying what is still on the phone.
  Safe to leave means every change applied, every file confirmed, nothing to decide.
- **Sync screen**: last synced, what is waiting, uploads with progress, and each change that
  needs attention, described as it was made ("Ticked “Isolate supply” on WO-000042").

## Reports

Every run is recorded on the phone (`sync_runs`) and sent to `POST /v1/sync/reports`: trigger,
outcome, duration, changes sent / in conflict / refused / retried, jobs received, files and
bytes uploaded, queue depth, network type and clock offset. Stored once per report id in
`sync_reports`. The phone corrects the start time by its measured offset; a start time that is
still implausible (in the future, or over 31 days old) is replaced by when the report arrived.

## Tests

`apps/api/src/sync/sync.integration.test.ts` runs the phone's engine on Node's SQLite against the
real API and database, through a network (`apps/api/src/testing/phone.ts`) that can be switched
off, lose a request before or after the server sees it, answer 503, or kill the app mid-upload.
The device checklist covers what only a phone can: [P12 on a phone](../mobile/device-checklist.md#p12).
