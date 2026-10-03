# The working day on the phone

An engineer runs their whole day from the phone (P14): clocking in, travelling, arriving,
working, photographing, getting the customer's signature, completing, clocking out. Every one
of those is recorded on the phone first. It shows at once, and the sync engine sends it when
there is signal ([offline sync](../sync/README.md)), with the moment it happened.

```
apps/mobile
  app/home.tsx                 Today: the clock, the next job and its one step forward, then the day's jobs
  app/jobs/[id].tsx            one job, in the order it is worked
  app/jobs/complete/[id].tsx   what completing still needs, the sign-off, Complete
  src/lib/today.ts             which job is next; which steps are the engineer's       ← unit tested
  src/lib/navigation.ts        directions links for each maps app                      ← unit tested
  src/local/job-actions.ts     clock, steps, photos, sign-off, opening files — all local
  src/local/push.ts            registering for notifications, and opening their job
  src/local/resume.ts          the screen to return to after a force close              ← unit tested
  src/components/app-lock.tsx  biometrics, or the phone's passcode
        │
@integr8/core                  jobTimes, shiftDurationMs, completionMissing — the same on every screen and the server
@integr8/offline               shifts, photos, sign-off, attachments: outbox mutations and local queries
```

---

## Today

The home screen opens with the day:

1. **The clock.** Clocked in or not, since when and for how long, and the button to change it.
   Clocking out while a job is still travelling, on site or in progress asks first.
2. **The next job.** A job the engineer is travelling to or working on always comes first,
   whatever its date, because it is where they are. Otherwise it is the first of today's
   jobs they can start. It shows the address, due time, hazards, "On site since 09:12 · 25
   min", the one step forward, **Directions** and **Open job**.
3. The day's jobs by when they are due, as in P11.

A **shift** is one clock-in and clock-out: the "day clock" model chosen before implementation.
Time on each job is not clocked separately. It comes from the job's own history (set off,
arrive, start, wait for parts, finish), so the engineer taps each thing once.

## A job, in the order it is worked

How to get in comes first, then what to do:

1. access notes, hazards first;
2. whether it is safe to leave (P12);
3. the title, state and address;
4. **the steps**: the one step forward as the main button (**Start travel**, **Arrived**,
   **Start work**, **Complete job**), then **Directions** and the other steps the engineer may
   take (**Stop travelling**, **Waiting for parts**);
5. instructions;
6. forms;
7. photos;
8. checklist, ticked on the phone;
9. files;
10. time on this job;
11. then the customer, site, contact, due window, description, sign-off, crew, notes and earlier
    jobs.

**Only the engineer's own transitions are offered.** `jobSteps` filters the core state machine
to `work_order.progress`, so dispatching, rescheduling and reviewing never appear on a phone.

**Prompts driven by the job type:**

- Setting off or arriving while not clocked in offers to clock in.
- **Start work** on a job type that asks for before photos offers the camera first. It never
  blocks: a photo can be forgotten, and completing is where it is enforced.

**Directions** try Google Maps, then Apple Maps (iOS) or any `geo:` app (Android), then the
web. Coordinates are used when the site has them, and the address when it does not.

**Files** of open jobs (site plans, manuals) are downloaded after each sync, up to 25 MB each
and 20 per run. A larger one is fetched when opened with signal. They open in whatever the
phone opens them with (`expo-sharing`), and the least recently opened go first when the
storage budget is reached.

## Time

Everything times itself from `jobTimes` and `shiftDurationMs` in `@integr8/core`: the phone,
the office's job screen and the timesheet.

| Stretch           | From                                    | To                |
| ----------------- | --------------------------------------- | ----------------- |
| Travel            | `travelling`                            | the next change   |
| On site           | `on_site` (arriving, until work starts) | the next change   |
| Working           | `in_progress`                           | the next change   |
| Waiting for parts | `awaiting_parts`                        | the next change   |
| Shift             | clock in                                | clock out, or now |

**Times are the phone's, within bounds.** A change sent hours after it was made is stamped
with when the phone recorded it (`occurred_at`) and when the server learned of it
(`recorded_at`). The database clamps `occurred_at` to after the job's previous state change,
no later than now and at most 31 days back (`work_order_happened_at`, migration 0013). A wrong
phone clock can shorten a stretch but can never reorder a job's history. The office sees
"recorded on the phone at 09:12, synced at 11:40" wherever the two differ.

**The timesheet** (`GET /v1/timesheets`, the office's Timesheets screen) returns raw facts and
the client adds them up:

- each person's shifts;
- the jobs they worked, with each job's whole history in the window;
- the change before the window, so a job already under way is counted from the window's start;
- the crew.

A crew shares a job: its time counts for everyone on the crew, whoever tapped each step.

## Photos and the customer's sign-off

A **job type** says how many before photos and after photos a job needs (0–20), and whether
the customer signs off. A job copies them when it is created.

- **Photos** are job attachments tagged `before` or `after`, the choice made before
  implementation. A photo is shrunk when taken (P13's sizes), queued for upload and shown on
  the job at once. It is added to the job by its own outbox record once the file has arrived,
  so a slow upload holds up nothing but the completion that needs it. Pressing and holding
  removes one. If it never left the phone it is simply dropped.
- **The sign-off** is a drawn or typed signature with the signer's name, optional role and the
  time. When nobody can sign, the reason is recorded instead. A later sign-off replaces an
  earlier one until the job is complete. The history gets a `signed_off` event.

## Completing

**Complete job** opens the completion screen. It lists what is still missing, each with the way
to do it right there:

- the required forms not yet submitted;
- the photos still to take;
- the sign-off pad.

**Complete job** stays unavailable until nothing is missing. The phone decides with
`completionMissing` from `@integr8/core`, counting what was done on the phone but not yet sent.

The database refuses a completion that is missing anything, whoever sends it. The API answers
409 `completion_blocked` with one detail per missing thing:

- `required_form_missing` (`params.formId`);
- `photos_missing` (`params.needed`);
- `signoff_missing`.

The web and desktop list each one in the office's language. Offline, completing waits in the
outbox for the job's forms, photos and sign-off to be sent first. If the server still refuses
(a form was reopened in the office meanwhile), the Sync screen shows an `incomplete` conflict
that lists what is missing, opens the job, and sends again once it is fixed.

## Push notifications

The phone registers its Expo push token for its session (`PUT /v1/me/push-device`). Signing
out, or the session being revoked, stops notifications to it. So does
`POST /v1/me/push-device/unregister`.

**When a notification goes out.** A trigger on `work_order_events` queues
`push.work_order_event` in the same transaction as the change, and the worker sends it:

| Change                     | Who                       | Channel                       |
| -------------------------- | ------------------------- | ----------------------------- |
| Assigned to an open job    | the person added          | `jobs`, or `urgent` if urgent |
| Rescheduled                | the crew                  | `jobs`, or `urgent` if urgent |
| Dispatched                 | the crew                  | `jobs`, or `urgent` if urgent |
| Cancelled                  | the crew, with the reason | `jobs`                        |
| Priority changed to urgent | the crew                  | `urgent`                      |

- The person who made the change is never told about it.
- Notification text carries the job's reference and site, never a time: the company has no
  time zone yet.
- Expo's receipts are checked 15 minutes later (`push.receipts`). A token Expo reports as no
  longer registered is disabled, so an uninstalled app is not tried again.

**On the phone:**

- A notification that arrives starts a sync.
- Tapping one syncs for up to five seconds, then opens its job, so a brand-new job is there to
  open.
- Android has two channels the engineer can tune in the system settings: **Job changes**, and
  **Urgent callouts**, which sound and show over other apps.

**Thirty seconds.** The worker polls every `WORKER_IDLE_POLL_MS` (2 s by default), and Expo
usually hands a message to FCM or APNs within a second or two. The exit criterion is measured on
a phone ([checklist](device-checklist.md#p14)).

### Setting it up

1. **An EAS project.** Run `eas init` in `apps/mobile`. Put the project id in `app.json` as
   `extra.eas.projectId` and in the `updates.url`, replacing the zero UUID. The phone does not
   register for push while the id is the placeholder.
2. **Android (FCM).** Create a Firebase project and add an Android app `com.integr8.plus`.
   Upload its FCM V1 service account key with `eas credentials` (Android → Push Notifications).
   `google-services.json` is not needed for Expo push.
3. **iOS (APNs).** `eas credentials` creates the push key when the first build is made, with an
   Apple Developer account.
4. **The API.** Set `PUSH_SENDER=expo`. Production refuses to start without it. If the EAS
   project has enhanced push security on, also set `EXPO_ACCESS_TOKEN`, a secret held only by
   the API and worker, like the R2 keys. Neither goes in a commit.
5. A new development build: `expo-notifications` is native.

## The app lock

The app locks when it starts and after five minutes in the background. It opens with
fingerprint or face, and falls back to the phone's own passcode, PIN or pattern, the choice
made before implementation. There is no separate app PIN to forget.

- The lock covers the screens rather than replacing them, so a half-filled form is still there
  underneath.
- A phone with no screen lock at all cannot be locked this way, and Settings says so.
- Not being signed in means nothing to lock.

iOS asks for Face ID with the reason in `app.json` (`expo-local-authentication`).

## Crashes with no signal

Sentry's native SDKs write each event to disk before sending, and send what is stored at the
next launch with a connection. `maxCacheItems: 100` keeps a week's worth. Every event is tagged
with the build (`release`), the over-the-air update it was running (`update_id`) and its channel.

## Over-the-air updates

`expo-updates` with EAS Update: a fix to a screen reaches phones without a store release.

- **Runtime version** is `fingerprint`: an update only reaches binaries with the same native
  code. Adding a native module needs a new build, and EAS works that out.
- **Channels** are `development`, `staging` (the preview profile) and `production`, set per build
  profile in `eas.json`. Publish with `eas update --channel staging --message "…"`.
- **When it applies.** The phone checks on launch and each time it comes back to the
  foreground. It downloads in the background and runs the new update from the next cold start,
  never under an engineer's fingers mid-form. The launch never waits for the check
  (`fallbackToCacheTimeout: 0`), so no signal means the last update runs.
- Settings shows the version, update and channel the phone is on.

## Back where they were

The app remembers the screen on show, with its route parameters, in the phone's encrypted
database (`meta.resume_route`). On launch after a force close, it opens the job list and then
that screen on top, so **Back** still leads home. The same job, the same form, the same page
(`?page=`): answers were already on disk (P13). A saved screen older than 12 hours is
forgotten, and so is everything else when the phone is wiped. The app lock covers the restored
screen until it is unlocked.

## Tests

- `packages/core/src/job-execution.test.ts`: what completing needs, and time from a history.
- `packages/offline/src/execution.test.ts`:
  - the shift outbox order;
  - times from the phone's own changes;
  - completion waiting for photos and the sign-off;
  - removing an unsent photo;
  - downloading attachments;
  - an unsent shift surviving a pull.
- `packages/db/src/testing/job-execution.integration.test.ts`:
  - the offline timestamp bounds;
  - completion refused without photos or sign-off;
  - one open shift each;
  - push tokens moving between people and never used on a revoked session.
- `apps/api/src/routes/v1/job-execution.integration.test.ts`:
  - `completion_blocked`, the sign-off route and shifts through sync;
  - a delayed change keeping its time;
  - timesheets with crews;
  - notifications to the right people, stopped by unregistering and by signing out.
- `apps/api/src/sync/sync.integration.test.ts`: "a working day on the phone". A full day is sent
  through sync late, and arrives with its photos, sign-off and the phone's times.
- `apps/mobile/src/lib/today.test.ts`, `src/local/resume.test.ts`: the next job, the
  engineer's steps, directions links, and the screen to return to.
- `packages/operations-dom`: the completion section, `completion_blocked`, job type settings and
  timesheet totals.
- On a phone: [the device checklist](device-checklist.md#p14).
