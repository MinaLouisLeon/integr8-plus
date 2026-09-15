# The mobile app on a phone

The parts of P11, P12, P13 and P14 that only a phone can prove. Everything else is covered by
`packages/offline/src/**/*.test.ts` and `apps/mobile/src/**/*.test.ts` against real SQLite, and by
`apps/api/src/sync/sync.integration.test.ts` against the real API. Record the result of each step
in the phase's plan file under `plan/v0.3-field-loop/`.

## Setup

1. **A development build**, because SQLCipher and SecureStore are native code Expo Go does not
   have:

   ```sh
   cd apps/mobile
   eas build --profile development --platform android   # or ios; or `npx expo run:android`
   ```

   A physical phone is best: aeroplane mode on an emulator is not the same radio.

2. **An API the phone can reach.** `localhost` on a phone is the phone. Run the API on a
   machine on the same network and start Metro with its address:

   ```sh
   EXPO_PUBLIC_API_BASE_URL=http://192.168.1.20:3000 npx expo start --dev-client
   ```

3. **Data.** An engineer with at least one open job whose site has access notes and hazards,
   a job closed within the last 30 days, and a customer with more than one site.

## P11

### 1. Encrypted at rest

- [ ] Sign in as the engineer. Settings → On this phone shows **Encrypted (SQLCipher 4.…)**.
- [ ] Android: `adb exec-out run-as com.integr8.plus cat files/SQLite/integr8-local.db > local.db`,
      then `sqlite3 local.db .tables` fails with _file is not a database_.
- [ ] Search that file for a customer name (`grep -c "Riverside" local.db`): no match.

### 2. Every screen renders in aeroplane mode

With the jobs downloaded, turn on aeroplane mode, force-quit the app and open it again.

- [ ] The app opens straight to the job list (no sign-in, no spinner).
- [ ] The banner says there is no connection and when the work was downloaded.
- [ ] Open a job: **Getting in is the first thing on the screen**, hazards highlighted, gate
      code large and readable at arm's length.
- [ ] From the job, open its customer and its site; from the customer, open another site.
- [ ] Search for part of a customer name, an address and a job number: results appear.
- [ ] Settings shows the counts and last updated time.
- [ ] At no point does any screen show a loading spinner. (Signing in is the one screen that
      needs the network, and it is not reachable while signed in.)

### 3. Current when the signal returns

- [ ] Still in aeroplane mode, assign the engineer a new job from the web app.
- [ ] Turn aeroplane mode off: within a few seconds the banner says _Updating_, then the new
      job appears in the list without touching anything.
- [ ] Unassign it on the web; bring the app back to the foreground: it disappears.

### 4. An upgrade across two schema versions keeps unsent work

Needs a development build of P11 as it was committed (`git checkout 625ba9a`): local schema
version 3, with an **Add a test draft (development)** button in Settings. The current build is at
version 5, two versions later, and has no such button — its unsent work is a form started on a job.

- [ ] Install the P11 build, sign in and download.
- [ ] Settings → Add a test draft: Not yet sent shows **1**.
- [ ] Install the current build over it **without uninstalling**. Open it offline.
- [ ] Settings → Not yet sent shows **1**, search works, and Settings still shows encrypted.

### 5. Signing out leaves no readable company data

- [ ] With the probe draft from step 4 present, tap Sign out: the app warns that 1 unsent item
      will be deleted. Cancel: nothing happens. Sign out and delete.
- [ ] Android: `adb exec-out run-as com.integr8.plus ls files/SQLite files/integr8-files` —
      the database and the files directory are gone.
- [ ] The key is gone: sign in again as the same engineer, and Settings shows nothing from
      before until the download finishes.

### 6. Remote wipe

- [ ] Sign in and download. Put the phone in aeroplane mode.
- [ ] From the web app (owner), revoke the engineer's sessions.
- [ ] The phone still opens offline and shows its jobs — expected, see
      [offline access](../auth/offline-access.md).
- [ ] Turn aeroplane mode off and bring the app to the foreground. Once its access token has
      expired (up to 15 minutes after it was issued; background and foreground the app again if
      need be) it returns to sign-in, and the checks from step 5 pass.

## P12

Two phones (**A** and **B**) signed in as two engineers on the same job, and the web app open as a
dispatcher. The form on the job's type needs text answers, at least ten photos and two
signatures. Until P13 and P14 put forms and the camera on the phone, the steps that fill a form
or take photos are proven by the integration suite; record them here as _suite only_ and repeat
them on a phone once P14 lands.

### 1. A full job in aeroplane mode

- [ ] On **A**, open the job with signal: the badge beside Back says **Safe to leave**.
- [ ] Turn on aeroplane mode. Move the job on (on site, in progress), tick every checklist item,
      add a note, correct the gate code.
- [ ] The badge says **Not sent yet**; the card under the access notes counts the changes; the
      banner says _No connection. … items are waiting on this phone._
- [ ] Force-quit the app and open it again, still offline: everything above is still shown.
- [ ] _(P14)_ Fill the form with ten photos and two signatures and submit it; complete the job.
- [ ] Turn aeroplane mode off. Without touching anything the banner goes _Sending your
      changes…_ → _Uploading files, 1 of 12…_ → _Everything is sent._, and the badge turns **Safe to leave**.
- [ ] On the web: the job is in the state A left it, every checklist item ticked, the note and
      the gate code there, _(P14)_ the submission with ten photos and two signatures that open.

### 2. Killed mid-upload

- [ ] _(P14)_ Offline, attach a video over 20 MB. Reconnect; while the banner says _Uploading_,
      force-quit the app.
- [ ] Open it again: the upload continues from where it stopped (Sync → Uploads shows the bytes
      sent not starting from zero), and the job arrives once.
- [ ] On the web: one copy of every photo and the video, one note, one event per move.

### 3. Two phones, offline, same job

- [ ] Both phones offline. On **A** set the gate code to _1111_; on **B** set it to _2222_ and add
      parking notes.
- [ ] Bring **A** online: it sends. Bring **B** online: the banner says **Needs your attention**
      and the badge on the job says so too.
- [ ] Sync screen → the change reads _Changed the access notes for …_. Open it: both gate codes
      are shown, the parking notes are not asked about (nobody else changed them).
- [ ] Choose **Mine** for the gate code and **Send my choices**. The banner returns to
      _Everything is sent._; the web shows _2222_ and the parking notes.
- [ ] On a dispatched job, offline on **A**, mark it _Travelling_; on the web, move it back to
      scheduled. Bring **A** online: the conflict names who moved it. **Keep theirs**: the phone
      shows _Scheduled_.

### 4. Background and battery

- [ ] Offline, add a note, then put the app in the background and turn aeroplane mode off. Leave
      the phone locked for 30 minutes. The note is on the web without opening the app. (The OS
      decides when background tasks run; on iOS it can be longer. Record how long it took.)
- [ ] _(P14)_ Below 15% battery, not charging, with photos waiting: the banner says _Files will
      upload when the battery is charged, or tap Sync now._ **Sync now** sends them anyway.

### 5. Safe to leave, at a glance

- [ ] Hand the phone to someone who has not seen the app, on a job with one unsent note. Ask
      _"can the engineer leave?"_ They answer _no_ from the job screen within five seconds.
- [ ] Same job after syncing: they answer _yes_.

## P13

A job whose type needs a published form with every field type (text, long text, barcode,
number, decimal with a unit, rating, date, time, date-time, dropdown, radio, multi-select,
checkbox, yes/no, signature, photos with a limit of ten, a PDF file, GPS), a question shown only
for one answer, a calculated number, and at least twenty questions over three pages. The same
form open in the desktop builder's phone preview.

### 1. It looks like the phone preview

- [ ] Open the form on the phone and in the builder's phone preview side by side: the same
      pages in the same order, the same sections and questions, one page at a time.
- [ ] Answer the question that shows another: it appears at once; change the answer back: it
      goes, and its typed value is not on the review screen.
- [ ] The calculated number updates as its inputs change and cannot be edited.
- [ ] Switch the phone to Arabic: labels, rows and buttons mirror.

### 2. Every widget, with gloves on

Wear work gloves (or a touchscreen glove) for this section.

- [ ] Every tick box, option row, yes/no and rating button can be hit first time.
- [ ] Number and decimal fields open a numeric keyboard; an Arabic keyboard's digits are kept.
- [ ] Date, time and date-time open the phone's pickers; the review shows what was picked.
- [ ] Dropdown opens a sheet of rows.
- [ ] **Scan** reads a QR code and a Code 128 barcode from an appliance plate into the field.
- [ ] Text question: tap the keyboard's microphone and dictate a sentence, with signal and in
      aeroplane mode. Record which phones dictate offline.
- [ ] Signature: sign with a finger and with a stylus; the page does not scroll while signing.
      **Undo** removes the last stroke. **Type my name instead** works with a screen reader on.
- [ ] GPS: **Use my current location** fills coordinates with accuracy; deny permission and the
      coordinates can be typed.

### 3. Photos are made smaller before they wait

- [ ] Take a photo with the camera. In Sync → Uploads it waits at under 1 MB (a straight camera
      photo is 3–6 MB); the thumbnail shows in the question at once.
- [ ] The photo is the right way up in portrait and in landscape.
- [ ] Choose three photos from the library at once; with a limit of ten and eight already
      taken, the phone says only two fit.
- [ ] Remove a photo before syncing: it leaves Sync → Uploads.

### 4. Twenty questions in aeroplane mode, killed half-way

- [ ] Aeroplane mode on. Start the form, answer page one and half of page two.
- [ ] Force-quit the app mid-way through typing an answer. Reopen, open the form: everything
      except at most the last few characters typed is there.
- [ ] Let the battery run to zero (or hold power to force a shutdown) with the form open after
      answering another question. Charge, reopen: that answer is there.
- [ ] Finish the form with ten photos and two signatures. **Review answers** with one required
      question empty: the list names it and tapping it opens its page, scrolled to it.
- [ ] Answer it, review, **Submit**. The phone asks for location (allow), shows _Recording where
      you are…_, then returns to the job, which says the form is submitted but not sent.
- [ ] Aeroplane mode off: the uploads go, then the form. On the web, the submission has every
      answer, ten photos, two signatures, and its history shows where it was submitted from.
- [ ] Repeat in a room with no GPS fix, tapping **Submit without it**: the web says it was
      submitted without a location.

### 5. Phone and desktop store the same answers

- [ ] Fill the same form on the desktop with the same answers (same date, time, choices, digits).
      Export both submissions as CSV from the web: every column except the files and the
      submitted time matches.

### 6. Earlier answers, and the engine on the phone

- [ ] On a second job at the same site, start the form: the phone offers the earlier answers.
      Accept: text and choices are filled, photos, signatures and location are not, and the form
      says how many answers came from which job.
- [ ] Settings → **Check the form engine** on a release build: _All … cases give the same results
      as the server._

## P14

A **release-like development build** from an EAS project with push credentials, per
[setting it up](job-execution.md#setting-it-up), and an API with `PUSH_SENDER=expo`. The phone
needs a screen lock. The data:

- a job type needing two before photos, one after photo, a customer sign-off and one required
  form;
- three of today's jobs of that type for the engineer, one urgent, at sites with coordinates;
- a dispatcher signed in on the web.

### 1. A real day, on the phone only

This is the phase's first exit criterion. An engineer does a real day's work while someone
watches and takes notes: what they looked for and could not find, what they tapped twice, and
every time they reached for paper or rang the office. Put the notes in the plan file.

- [ ] Open the app: Today shows _Not clocked in_ and the first job. Tap **Start travel**: the
      phone offers to clock in. Accept: the clock starts counting.
- [ ] **Directions** opens the maps app with turn-by-turn directions to the site, not a search.
      Try it with Google Maps uninstalled on Android and on iOS.
- [ ] **Arrived**, then **Start work**: the phone asks for the two before photos. Take them.
      The job's Photos section shows _Before: 2 of 2_.
- [ ] The job screen reads, top to bottom: access notes, the steps, instructions, forms, photos,
      checklist, files. Open the site plan in aeroplane mode: it opens from the phone.
- [ ] Tick the checklist, fill the form, then **Complete job** with nothing else done. The
      screen says exactly what is missing: the after photo and the sign-off.
- [ ] Take the after photo there. The customer signs with a finger, and their name and role are
      typed. **Complete job** becomes available: complete.
- [ ] Do the second job in aeroplane mode throughout, including **Nobody can sign** with a
      reason. Turn signal on at the end of the day.
- [ ] **Clock out**. On the web, Timesheets shows the day: the shift, and travel, on site and
      working for each job, matching what the engineer remembers.

### 2. Everything arrives intact

- [ ] On the web, each completed job has its forms, before and after photos, and the sign-off
      (name, role, time, signature image, or the reason nobody signed).
- [ ] Its times are the phone's: for the aeroplane-mode job, the history says _recorded on the
      phone at …, synced at …_, and the job's time section matches what happened, not when
      signal returned.

### 3. Back exactly where they were

- [ ] Open the third job's form, go to page two, and force-quit the app from the switcher.
      Reopen: after unlocking, the form is open on page two, and **Back** leads to the job,
      then to Today.
- [ ] On the completion screen, force-quit and reopen: the completion screen is open.
- [ ] Leave the app in the background for more than five minutes: it asks for a fingerprint or
      face. Cancel the biometric prompt and use the phone's passcode instead: it opens. Under
      five minutes, it does not ask.

### 4. A new assignment within thirty seconds

- [ ] With the app in the background and the phone locked, the dispatcher assigns the engineer
      to a new job. Time from **Save** to the notification on the lock screen: under 30 s.
      Record the time taken, on Wi-Fi and on mobile data.
- [ ] Tap the notification: the app opens that job, downloaded.
- [ ] Mark a job urgent: the _Urgent callouts_ channel sounds. On Android, both channels are in
      the app's notification settings.
- [ ] Sign out: a new assignment for that engineer sends nothing to the phone.

### 5. Crashes and updates

- [ ] In aeroplane mode, trigger a test crash from a development menu, or a build with a
      crashing screen. Reopen with signal: the crash reaches Sentry with `update_id`.
- [ ] Publish a visible text change with `eas update --channel <the build's channel>`. Open the
      app, close it fully and reopen: the change shows. Settings shows the update id.
