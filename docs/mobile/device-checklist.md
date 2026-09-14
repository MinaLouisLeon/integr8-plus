# P11 on a phone

The parts of P11 that only a phone can prove. Everything else is covered by
`apps/mobile/src/local/*.test.ts` against real SQLite. Record the result of each step in
`plan/v0.3-field-loop/P11-mobile-shell-and-local-database.md`.

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

## Checks

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

Needs a build of the app at local schema version 1. Until P13 writes drafts from a form,
development builds have an **Add a test draft (development)** button in Settings.

- [ ] Install a build whose `MIGRATIONS` list stops at version 1 (check out `migrations.ts`
      with versions 2 and 3 removed), sign in and download.
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
