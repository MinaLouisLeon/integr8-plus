# The mobile app on a phone

The parts of P11 and P12 that only a phone can prove. Everything else is covered by
`packages/offline/src/**/*.test.ts` against real SQLite and by
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

Needs a build of the app at local schema version 1. Until P13 writes forms, development builds
have an **Add a test draft (development)** button in Settings. (From P12 it adds a form the
server has never seen; the next sync sends it and the server refuses it, which is expected.)

- [ ] Install a build whose `MIGRATIONS` list stops at version 1 (check out `migrations.ts`
      with versions 2 to 4 removed), sign in and download.
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
