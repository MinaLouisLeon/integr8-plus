# Apps built for each company

Every customer gets apps of their own. The desktop installers and the phone
apps a company's people install carry that company's name, icon and colours,
open on its sign-in screen (the phone opens on its website first), and refuse
anybody from another company. Integr8's own people use a separate desktop
build, the **staff** flavour, which shows only the staff sign-in and the
company picker. There is no staff login on the phone.

```
platform dashboard ──"Build apps" on──▶ GET /v1/build/companies (BUILD_TOKEN)
                                                 │
version release ──▶ build-company-apps.yml ──────┤ for each company:
       or by hand  (company = acme | all)        │   GET /v1/public/companies/acme/brand  → name, colours, icon
                                                 │   desktop: stamp.mjs + tauri build  (Windows, macOS, Linux)
                                                 │   mobile:  company.json + eas build --channel production-acme
                                                 ▼
                              release  company-acme-v0.2.0  (installers, Android app, Expo links)
                              STORE_SUBMIT=enabled → eas submit (Play internal track; App Store with ASC_APP_IDS)
```

## One codebase, three builds

| Build           | Who installs it      | Sign-in shown | Name and identifier                            |
| --------------- | -------------------- | ------------- | ---------------------------------------------- |
| staff desktop   | Integr8's own people | Staff only    | `Integr8 Plus Staff`, `com.integr8.plus.staff` |
| company desktop | the company's people | Company only  | the company's name, `com.integr8.plus.<slug>`  |
| company phone   | the company's people | Company only  | the company's name, `com.integr8.plus.<slug>`  |

The flavour is fixed at build time. The desktop reads `VITE_APP_FLAVOR` and
`VITE_COMPANY_SLUG` (inlined by Vite) and `apps/desktop/scripts/stamp.mjs`
writes the product name, identifier, window title, version, API origin and
updater feed into `tauri.conf.json` before `tauri build`. The phone reads
`apps/mobile/company.json` through `app.config.ts`. A development build with
nothing set shows both sign-in doors.

The company's sign-in sends its slug; the API answers `403 wrong_company` to
an account from any other company, so one company's app can never show
another's data even if somebody signs in with the wrong address.

## Setting a company up

1. Onboard the company from the platform dashboard, with its website.
2. Open the desktop **staff** app, sign in as staff, choose the company, and
   set its brand on **Company branding**: logo, a square app icon (at least
   512 × 512), accent colour, sidebar colour, default theme, website. The apps
   use the product's own icon when the company has none.
3. On the company's page in the platform dashboard, tick **Build apps for
   this company** and save. The company now appears in
   `GET /v1/build/companies`, and with `APP_BUILDS=github` its first build
   starts at once: the panel says "Build started on GitHub" with a link to
   the run. With `APP_BUILDS=off` (the default) it says to start the build by
   hand, below.
4. When its forms, job types, look and apps are ready, invite the owner: the
   company's page → **Invitations** → **Send invitation** (or **Copy a new
   link** to send it yourself). Onboarding does not email the owner unless you
   tick the box for it.

## Building

- **From the dashboard**: with `APP_BUILDS=github`, ticking **Build apps**
  starts the company's first build, and **Rebuild apps** on its page starts
  another (after its look changed, or for a version released before it was
  switched on). The API needs `GITHUB_BUILD_TOKEN`, a fine-grained GitHub
  token for this repository only with **Actions: read and write** (it can run
  any workflow there, so it is a secret), and `GITHUB_BUILD_REPOSITORY`; it
  refuses to start with `github` and either missing. `GITHUB_BUILD_REF`
  (default `main`) is the branch whose workflow and version are built.
- **One company, by hand**: Actions → _Build company apps_ → _Run workflow_. Enter
  the short name and leave the rest empty (version from `package.json`, API
  from `PUBLIC_API_URL`, platforms from the release variables). Type `all` to
  rebuild every company.
- **Every company, at a release**: merging a version bump into `main` runs the
  version release, which builds the staff desktop app, the API and web images,
  and then every company's apps at the same version. Set the `COMPANY_APPS`
  variable to `disabled` to stop that.

Each company's run produces one release tagged `company-<slug>-v<version>`
holding the Windows, macOS and Linux installers, the Android app, and links to
the builds on Expo. The desktop download links are those release assets;
rehost them wherever you like. The phone apps are also kept on Expo.

What a company run needs on GitHub (see `docs/contributing/branching.md`):
`PUBLIC_API_URL`, `EXPO_TOKEN`, `EAS_BUILDS=enabled`, and for `all` the
`BUILD_TOKEN` secret, the same value the API has in its environment.

What a phone build needs on Expo, set once per EAS environment (`production`,
and `preview` for the test box), which each profile in `apps/mobile/eas.json`
names: `EXPO_PUBLIC_SENTRY_DSN` (crash reports), `EXPO_PUBLIC_AUTH_VERIFICATION_KEYS`
(the deployment's `AUTH_VERIFICATION_KEYS`, for the offline grant) and the file
`GOOGLE_SERVICES_JSON` (Android notifications), plus, per company, its Android
app in the Firebase project and the FCM key under Credentials. GitHub passes
none of them: EAS applies them on its own build machines. A company missing
from `google-services.json` is built without notifications rather than not at
all (`docs/mobile/job-execution.md`, push notifications). The setup guide has
the steps (Stage 0, parts I and J; Stage 8, part A).

## Store submission

Off until the `STORE_SUBMIT` variable is `enabled`. Then each company's phone
build is submitted after it finishes:

- **Google Play**: to the internal track as a draft, with the service account
  JSON in the `GOOGLE_SERVICE_ACCOUNT_KEY` secret. The app record (package
  `com.integr8.plus.<slug with - as _>`), its listing, privacy policy, data
  safety form and content rating are created once per company in the Play
  Console. Google's first upload of a new app may have to be done by hand from
  the release's `.aab`; later versions go through.
- **App Store**: with an App Store Connect API key (`ASC_API_KEY` .p8
  contents, `ASC_KEY_ID`, `ASC_ISSUER_ID`) and each company's App Store Connect
  app id in the `ASC_APP_IDS` variable, `{"acme":"1234567890"}`. Apple's
  guideline 4.2.6 rejects template apps submitted by the service provider;
  the sanctioned routes under one Integr8 account are Custom Apps through
  Apple Business Manager or unlisted distribution. The pipeline is the same
  for all of them.

Expo's free plan has a monthly build quota and one build at a time; several
companies on every release need a paid plan.

## Updates

Desktop apps update themselves. Each build asks its own feed, stamped in by
`stamp.mjs`: `https://app.integr8-media.com/desktop-updates/<slug>/…` for a
company (`/staff/…` for the staff app; the base is the `DESKTOP_UPDATES_URL`
repository variable). The web app answers with the `latest.json` of that app's
newest release, `company-<slug>-v<version>`, so a company is never offered the
staff build or another company's. When one is waiting, the app shows a strip
under its top bar; **Install now** downloads it, checks its signature against
the public key the app carries, and installs it (on Windows the app closes and
the installer opens the new version; on macOS and Linux it starts on the next
launch). This needs the `TAURI_SIGNING_PRIVATE_KEY` secret when the release is
built and `GITHUB_RELEASES_REPOSITORY` on the web server; it does not need any
operating-system certificate. Apps installed before this feed existed asked a
placeholder address and must be reinstalled once.

Phone apps receive over-the-air updates on their own channel,
`production-<slug>`.

## Installing an unsigned desktop app

Until the operating-system code-signing secrets exist (setup guide, Stage 6,
"Code signing, when you buy certificates"), the installers are not
code-signed. They work, but each system warns
the first time. Tell the company's people what they will see:

- **Windows**: "Windows protected your PC" (SmartScreen). Click **More info**,
  then **Run anyway**. On Windows 11 with **Smart App Control** switched on,
  an unsigned app may be blocked outright, with no way past it; that person
  needs a signed build, or to switch Smart App Control off in Windows
  Security (a decision for whoever looks after that PC). Company-managed PCs may block unsigned
  installers by policy; their IT department has to allow it.
- **macOS**: the first open is refused ("cannot be opened because Apple cannot
  check it for malicious software", or "Not Opened"). Open **System Settings →
  Privacy & Security**, scroll to Security, and click **Open Anyway** beside
  the app's name, then confirm. Right-click → Open no longer gets past this on
  recent macOS. This is needed once per install.
- **Linux**: no warning; make the `.AppImage` executable, or install the `.deb`.

Use the Windows `-setup.exe` (rather than the `.msi`) unless an IT department
asks for an MSI: it updates in place and reopens the app afterwards.
Updates themselves raise no warning: they are checked against the app's own
key, not the operating system's.

## Changing a company's look later

Set it again from the desktop staff app. The web dashboard and the already
installed apps repaint on their next load from `/v1/me`; the installers and
store listings carry the old icon until the next build.
