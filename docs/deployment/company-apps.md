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
   `GET /v1/build/companies`.

## Building

- **One company, now**: Actions → _Build company apps_ → _Run workflow_. Enter
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

Desktop installers ask their own updater feed, `<updater base>/<slug>/…`, so
a company is never offered the staff build or another company's. Phone apps
receive over-the-air updates on their own channel, `production-<slug>`.

## Changing a company's look later

Set it again from the desktop staff app. The web dashboard and the already
installed apps repaint on their next load from `/v1/me`; the installers and
store listings carry the old icon until the next build.
