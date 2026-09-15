# P14 — Job execution on mobile

**Version:** v0.3 Field Loop
**Status:** `IN PROGRESS — built and verified off-device; awaiting a real day on a phone`
**Depends on:** P13

## Goal

An engineer runs their entire working day from the phone, from opening the app to
closing the last job.

## Scope

The screens and flows an engineer actually touches. This phase completes the core loop
the whole product is built around.

## Tasks

- [x] Today view: next job, the day's list, travel status — the screen that opens ninety percent of the time
- [x] Job detail: site access notes first, then instructions, forms, checklist and attachments
- [x] One-tap navigation handing the address to the phone's maps app
- [x] Clock in and out; travel start and stop, recorded against the job
- [x] Status transitions from the job screen, respecting the server state machine
- [x] Before and after photo prompts driven by the job type
- [x] Customer signature on completion, with name, role and timestamp
- [x] Completion flow blocking on unsubmitted required forms, explaining exactly what is missing
- [x] Push notifications for new assignments, schedule changes and urgent callouts
- [x] Biometric or PIN app lock for fast re-entry
- [x] Crash reporting with an offline buffer, uploaded when signal returns
- [x] Over-the-air update channel via EAS Update

## Exit criteria

- [ ] A real engineer completes a real day of work using only the phone, observed, with notes taken
- [x] Every completed job arrives on the server with its forms, photos, signature and times intact
- [ ] Reopening the app after a forced close returns to exactly where the engineer was
- [ ] A push notification for a new assignment arrives within thirty seconds

## Notes

- Watch a real engineer use this before declaring it done. Every field service product
  that failed was designed by someone who never stood in a plant room holding a phone.
- The completion block on missing forms is the most-hit error in the product. Its wording
  is worth iterating on.

## Progress

Every task is built. Four choices were made before implementation:

- a day clock, with job time taken from the job's own history;
- Expo's push service;
- biometrics with the phone's passcode as the fallback;
- photos as tagged job attachments.

- **Ticked:** the exit criterion "arrives intact" is proven against the real API.
- **Not ticked:** the other three need a phone, and a real engineer's day. They close when
  [P14 on a phone](../../docs/mobile/device-checklist.md#p14) has been run.

The design is in [the working day on the phone](../../docs/mobile/job-execution.md).

| Claim                                                                | How it was proven so far                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Still needs                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| A real engineer completes a real day using only the phone            | Every step of the day is on the phone: Today, the steps, directions, photos, checklist, forms, files, completion, sign-off, clocking out. The app bundles for Android (`expo export`, Hermes). The rules it shows (next job, the engineer's own steps, directions links, what completing needs, time) are unit tested                                                                                                                                                            | Checklist 1, observed, with notes |
| Completed jobs arrive with forms, photos, signature and times intact | API sync suite, "a working day on the phone": a phone downloads a job and its site plan, clocks in, travels, arrives, works, takes before and after photos, fills the required form and records a sign-off. It completes offline, then syncs minutes later. The server has the job complete, the form submitted, the photos by stage, the sign-off, and every transition within 100 ms of when the phone recorded it. Removing `happenedAt` from the push handler fails the test | Checklist 2                       |
| Completion is refused, and says exactly what is missing              | Database: completion is refused without photos or sign-off, as the runtime role. API: `completion_blocked` with one detail per missing thing. Phone: `localCompletion` counts unsent work, and completion waits in the outbox for it. The office screens list each detail in words                                                                                                                                                                                               | Checklist 1                       |
| Reopening after a force close returns to where the engineer was      | `resume.test.ts`: the saved screen, with the form's page, survives the launch screen passing through (removing that guard fails the test), and is forgotten by going home or after 12 hours. Answers were already on disk (P13)                                                                                                                                                                                                                                                  | Checklist 3 with a real kill      |
| A push for a new assignment arrives within 30 s                      | API suite: an urgent assignment queues a notification in the change's transaction. The worker sends it to the person added, on the `urgent` channel, not to the dispatcher. An uninstalled app's token is disabled from its ticket, and unregistering and signing out stop it. The worker polls every 2 s                                                                                                                                                                        | Checklist 4, timed on a phone     |
| Timesheets add up the way the phone does                             | `timesheets.test.ts`: a crew's job counts for everyone on it, and a job under way when the week starts counts from the week's start. API: crews and truncation are returned. Every total comes from `jobTimes` and `shiftDurationMs`                                                                                                                                                                                                                                             | —                                 |
| Nothing else regressed                                               | Workspace lint, typecheck, unit tests and build (61 tasks). Integration: db 239, API 124 (one R2 suite skipped, awaiting credentials). Unit: core 69, offline 47, operations-dom 13, mobile 15, api-client 33, i18n 36, API 105                                                                                                                                                                                                                                                  | —                                 |

## Decisions taken during implementation

- **Time on a job is its history, not a second clock.** Travel, on site, working and waiting
  come from `jobTimes` in `@integr8/core`, on the phone, the office's job screen and the timesheet.
- **Offline changes keep the phone's time, within bounds.** Migration 0013 sets
  `integr8.happened_at` per transaction. `work_order_happened_at` clamps it between the job's
  previous change and now, and to at most 31 days back. Each event also keeps `recorded_at`.
- **Photos and sign-off are enforced by the database**, like required forms. The job type sets
  the counts, and a job copies them when it is created.
- **Every missing thing is a detail.** `completion_blocked` replaces `required_forms_missing`, and
  the sync conflict `incomplete` replaces `forms_missing`, so clients word each one themselves.
- **Starting work prompts for before photos but never blocks.** Completion is where they are
  enforced.
- **Only the engineer's own transitions show on the phone** (`work_order.progress`).
- **Unregistering a push device is a POST with a body**, not a DELETE: DELETE bodies are not in
  the contract, and a token does not belong in a URL.
- **Notification text has no times**, because the company has no time zone yet.
- **An OTA update applies at the next cold start**, never mid-form. Runtime version is
  `fingerprint`.
- **The app lock covers the screens and does not unmount them**, so a form underneath is kept.
- **A crew shares a job's time on the timesheet**, whoever tapped each step.
- **Files open through the system share sheet** (`expo-sharing`). It grants the reading app
  access on Android, which a `file://` link cannot.

## Deploying

- Migration `0013_job_execution`.
- **API.** Set `PUSH_SENDER=expo`; production refuses to start without it. Set
  `EXPO_ACCESS_TOKEN` only if enhanced push security is on, and only in the deployment's secrets.
- **EAS project.** Replace the zero project id in `apps/mobile/app.json`, in both
  `extra.eas.projectId` and `updates.url`. Upload FCM V1 and APNs credentials with
  `eas credentials`.
- **A new development build.** `expo-notifications`, `expo-local-authentication`, `expo-updates`,
  `expo-device` and `expo-sharing` are native. Face ID's reason is in `app.json`.

## Found while building this

- **A DELETE route's body was silently dropped from the contract.** OpenAPI generation leaves out
  DELETE bodies, so the generated client could not send the token. The route is now
  `POST /v1/me/push-device/unregister`.
- **The client's error type had no `params`**, though the error model does. `ApiErrorDetail` now
  has them, and the office screen reads `needed` without a cast.
- **A first timesheet credited a crew's job only to whoever tapped each step**, and lost the part
  of a job under way before the window. Both were found reviewing the office screen. The route
  now returns each job's whole history, the change before the window and the crew.
- **The append-only history refuses the down migration's cleanup.** Undoing 0013 has to delete
  `signed_off` events. The down migration turns the no-delete trigger off around that one
  statement, and the rolled-down-and-up test run exercises it.
- **The API tests' job runner assumed one company per queue.** The test database is shared, and
  the new push jobs from other suites' companies stopped it early. It now drains the queue and
  handles only its own company's jobs.
- **The phone's job screen had no way to move a job on.** P12 recorded transitions only from
  tests.
