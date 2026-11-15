# P42 — Desktop only: no web workspace, no web dashboard

**Status:** PROPOSED — waiting for the owner

## Goal

Companies and Integr8 staff work only in the desktop apps (and engineers in the
phone app). The web app stops being an office app and a staff dashboard: every
screen it has that the desktop does not moves into the desktop, and what is left
of `apps/web` is a small public site for the pages that must open in a plain
browser.

## Scope

**In:**

- The company desktop app gets every company screen that is web-only today.
- The staff desktop app gets the whole platform dashboard, and a way to move
  between the dashboard and working inside a company.
- `apps/web` is cut down to public pages only.
- Email links, asset-tag QR codes, the assistant's per-app switch and the shared
  menu model stop assuming a web workspace.
- Self-serve sign-up and Stripe card checkout are removed.
- Docs, the setup guide, the help library and `MEMORY.md` are updated to match.

**Out:**

- The phone app. Nothing it does depends on the web workspace, except the
  asset-tag link, which is covered below.
- Code signing and new installer platforms (P20).
- A company website built by Integr8 (`/v1/website` is unchanged).

### The owner's answers so far (2026-11-15)

| Question                                              | Answer                                                                                                                                  |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| What happens to pages that must open in a browser?    | Keep a small public site: marketing, pricing, contact, help, legal, `/download`, `/q`, `/d`, `/desktop-updates`.                        |
| How does a new person accept an invitation?           | Keep the web invitation page. Once the password is set, the page says it is set or updated and to carry on in the desktop or phone app. |
| What happens to self-serve sign-up and card checkout? | Remove both. Companies are onboarded by staff and invoiced by Integr8.                                                                  |
| How should the work proceed?                          | This plan first, then building it after approval.                                                                                       |

## Where things stand

The full comparison is in the conversation that started this phase. The parts
that matter here:

- **Menu model.** `packages/core/src/navigation.ts` marks six company sections
  `webOnly`: `getStarted`, `people`, `companySettings`, `websiteAccess`,
  `storage`, `billing`. Their web pages are `apps/web/src/app/(app)/get-started`,
  `settings/people` (with `/roles`), `settings/company`,
  `settings/website-access`, `storage` and `billing`, about 2,000 lines in all.
  The desktop maps them to `null` in `apps/desktop/src/lib/navigation.ts`.
- **Web-only company route.** `/a/[code]` opens a printed asset tag's QR code.
  `assetTagUrl` in `packages/core/src/assets.ts` builds it from `WEB_APP_URL`,
  and phone sync sends it (`apps/api/src/sync/pull.ts`).
- **Platform dashboard.** 12 sections under
  `apps/web/src/app/platform/(dashboard)`, about 5,800 lines. The company page
  alone is 2,142 lines plus `website-keys.tsx`. Shared pieces:
  `components/{platform-shell,platform-bits,tab-picker,ai-policy-editor,template-package,app-build-result}.tsx`
  and `lib/{platform-api,platform-session,platform-format,plans,release-lookup,people,ai-shares}.ts`.
  The Downloads list comes from a Next.js route, `app/api/platform/downloads`,
  which reads GitHub releases with `GITHUB_RELEASES_TOKEN`. That is not an API
  route.
- **Staff session on the web.** The refresh token is an httpOnly cookie, set and
  rotated by Next.js routes in `app/api/platform/auth/*`. The API already accepts
  the refresh token in the body (`POST /v1/platform/auth/refresh`), so a desktop
  client can call it directly. Lifetimes: access token 5 minutes, refresh token
  1 hour, platform session at most 8 hours (`packages/auth/src/config.ts`).
- **Staff desktop app today.** It signs in to the platform, picks a company,
  impersonates it as its owner (no `targetUserId`) and then forgets the platform
  token (`apps/desktop/src/lib/staff.ts`). It has no platform screens.
- **Web impersonation does not open the company.** The web's Impersonate button
  creates the grant, discards the tokens it gets back and only lists the grant
  (`ImpersonateButton` in `companies/[tenantId]/page.tsx`). Staff can work inside
  a company only from the desktop today.
- **Email links into the web workspace.** `apps/api/src/email/links.ts`:
  accept invitation (kept), verify sign-up (removed), billing, qualifications,
  contracts, work order, deadlines, people. They are used by dunning, the
  maintenance tasks, qualification expiry and invitations. `admin-cli` prints
  the web sign-in addresses for staff and company passwords.
- **Assistant per-app switch.** `AI_CHANNELS = ['web','desktop','mobile']`
  (`packages/core/src/ai.ts`). The API falls back to `'web'` for a request with
  no recorded app (`apps/api/src/ai/policy.ts`).
- **Help library.** `packages/i18n/src/help/articles.ts` describes the web app,
  in English and Arabic.

## Design

### 1. The menu model (`@integr8/core`)

- Drop `webOnly` and the `NavApp = 'web'` branch. `getStarted`, `people`,
  `companySettings`, `websiteAccess`, `storage` and `billing` become ordinary
  sections the desktop draws.
- `companyRoles` stays a desktop section, now beside People. People links to it
  instead of hosting a Roles sub-page.
- `billing` becomes read-only: the plan, its limits and "invoiced by Integr8".
- `PLATFORM_NAV_SECTIONS` stays as the staff app's menu. `funnel` is dropped
  with sign-up (decision D4).

### 2. The company desktop app

Each web-only screen is rewritten as a desktop route, with no changes to the API
it calls:

| Screen                                                                          | Desktop route              | Comes from                                                             |
| ------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------- |
| Get started                                                                     | `/get-started`             | `(app)/get-started`. The forms step says Integr8 builds them, as today |
| People (invite, give roles, suspend, assistant shares)                          | `/settings/people`         | `(app)/settings/people`, `lib/people.ts`                               |
| Company settings (timezone, working days, currency, assistant per-app switches) | `/settings/company`        | `(app)/settings/company`                                               |
| Website access                                                                  | `/settings/website-access` | `(app)/settings/website-access`                                        |
| Storage use                                                                     | `/storage`                 | `(app)/storage`                                                        |
| Billing (read-only)                                                             | `/billing`                 | `(app)/billing`, minus checkout and the card portal                    |

- **Assistant settings.** `/settings/assistant` now duplicates what moves into
  People and Company settings. Fold it into those two pages and remove the
  separate screen and its dashboard card, so there is one place for each
  switch.
- **Shared screens.** The desktop passes `people`, `companySettings`, `billing`,
  `submissions` and `forms` to `OperationsConfig.routes`, so the assistant's
  answers link to them.
- **Menu.** "Change password" and "Sign out" stay where they are.
- **The screens live in `apps/desktop`**, not in a shared package, since there is
  no second app to share them with.

### 3. The staff desktop app

- **One app, two places.** After signing in, staff land on the platform
  dashboard, with the full `/platform` menu redrawn in the desktop shell and the
  Integr8 Media look. "Work inside this company", on a company's page or in the
  company list, starts an impersonation grant. The window then switches to that
  company's workspace, with the impersonation banner and a **Back to the
  dashboard** button. That button ends the grant and returns to the company's
  page.
- **Platform session.** The platform refresh token is kept as decided in D2 and
  rotated on every refresh, as the web did. The 8-hour session cap and the
  limited `test_companies` scope still apply.
- **Who to act as.** As decided in D3. Either way the grant's reason (10
  characters at least) and audit entries are unchanged.
- **Screens moved.** Companies (list and onboarding), the company page with all
  its panels (plan, invitations, apps and builds, tabs, assistant, website keys,
  assistant shares, billing, people with unlock, activity, impersonations,
  errors, sync reset, suspend/export/close), storage, plans, audit, flags,
  announcements, templates (with `.integr8form` library import/export), releases,
  health, staff, downloads.
- **Downloads.** A new API route, `GET /v1/platform/downloads` (platform session,
  full scope), takes over the Next.js route's job. It uses the same GitHub
  releases lookup, moved from `apps/web/src/lib/release-lookup.ts` into the API.
  This needs the OpenAPI file and the client regenerated.
- **Kept out of company builds.** The platform screens load through a dynamic
  import behind the build-time `APP_FLAVOR === 'staff'` constant (and the
  development build). A company's installer then carries no staff code, and a
  test checks this against the built bundle.
- **Files.** Template and form package upload uses `<input type="file">`, which
  works in the Tauri webview. Download uses the existing desktop `saveFile`. The
  build-run link on the Apps panel opens through `openLink`.

### 4. What stays of `apps/web` (the public site)

- **Kept:** `/`, `/features`, `/pricing`, `/contact`, `/help`, `/legal/*`,
  `/download`, `/q/[token]`, `/d/[code]`, `/desktop-updates/*`,
  `/accept-invitation`, and a new public `/a/[code]` page (decision D5).
- **Invitation page.** After the password is set, the page shows "Your password
  is set" (or "updated" for an existing account), then "Carry on in your
  company's desktop or phone app", with the download links for that company.
  It creates no session, as today.
- **Deleted:** `(app)/**`, `platform/**`, `/sign-in`, `/sign-up/**`,
  `app/api/auth/*`, `app/api/platform/*`, and the workspace, platform and session
  components and libraries listed above. The CSP and middleware are trimmed to
  match.
- **Compose and Caddy.** The `web` service and `app.integr8-media.com` stay; the
  service gets smaller. `WEB_APP_URL` keeps its name and now means "the public
  site".

### 5. API and email

- **Workspace links in emails** (billing, qualifications, contracts, work order,
  deadlines, people): as decided in D1.
- **`admin-cli` messages.** Staff are told to open the staff desktop app. A
  company person is told to sign in to their company's app.
- **Sign-up and Stripe** (D4). Recommended: delete the `/v1/signup/*` routes, the
  verify link, the Stripe adapter and its checkout and portal routes, the
  funnel's sign-up steps, and `BILLING_PROVIDER=stripe`. `none` becomes the only
  provider, keeping the `recording` stand-in for tests. Only the web app ever
  called these routes, so no shipped desktop or phone build breaks. The release
  notes still say they were removed from `/v1`.
- **Assistant channel.** The API keeps accepting `'web'`, because old sessions
  and recorded rows carry it. Screens stop showing a "web" switch. A request
  with no recorded app is treated as `desktop`.
- **CORS.** The default `API_CORS_ORIGINS` keeps the Tauri origins. The web
  origin stays only for the public pages that call the API (`/q`, `/d`,
  `/accept-invitation`, `/download`). `config.ts`'s check still applies.

### 6. Docs and help

- **Docs:** `docs/apps/README.md` (one office app), `docs/platform/README.md`
  (the staff desktop app), `docs/auth/README.md` (platform session on the
  desktop) and `docs/architecture.md`.
- **Help library:** every article that says "web app" is rewritten in English and
  Arabic.
- **Setup guide** (Markdown and HTML together, `pnpm guide:check`): staff sign in
  through the staff desktop app; `WEB_APP_URL` now means the public site; Stripe
  settings are removed; a Stage 11 part for this release.
- **Owner's published copies:** the short setup checklist artifact
  (`KrY8XQBYC5ehzjG7DU4khX`) needs the same step changes.
- **`MEMORY.md` and `plan/README.md`.**

## Decisions for the owner

| #   | Question                                                                                                                                     | Options                                                                                                                                                                                                                                                            | Recommended                                                                                                                          |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Emails that link to a workspace page (a job, contracts ending, deadlines, certificates expiring, billing, people): what do they link to now? | (a) No link: the email names the screen ("open Contracts in your company's app"). (b) A public "Open this in your app" page on the site, with download links. (c) A deep link that opens the installed app (`integr8-<slug>://`), registered in every build.       | **(a)**. It is simple and cannot break. (c) needs URL-scheme registration per branded build and fails when the app is not installed. |
| D2  | Where is the staff app's platform session kept?                                                                                              | (a) In memory only: staff sign in (password + authenticator) each time the app starts, and the session lasts up to 8 hours while it stays open. (b) The refresh token in the OS credential store, like company sessions, surviving restarts within the 8-hour cap. | **(a)**. A platform token reaches every company, and signing in once per working day is a small price.                               |
| D3  | When staff work inside a company, whom do they act as?                                                                                       | (a) Always the owner, as the desktop does today. (b) The owner by default, with "as this person" on the company page's people list for support cases.                                                                                                              | **(b)**. It keeps today's desktop flow and the web's ability to see what a particular person sees.                                   |
| D4  | Remove the sign-up and Stripe code from the API too, or only from the screens?                                                               | (a) Delete the routes, the Stripe adapter, the sign-up funnel and the Funnel section. (b) Keep the API code switched off, for a later self-serve offer.                                                                                                            | **(a)**. Nothing else calls it, and dead code with secrets attached is a risk. Paymob, if it comes, would be a new adapter anyway.   |
| D5  | Where does a printed asset tag's QR code lead?                                                                                               | (a) A public `/a/[code]` page that says "scan this with your company's phone app" (the phone's scanner reads the code from the address). (b) Print only the code, not an address.                                                                                  | **(a)**. Tags already printed keep working.                                                                                          |
| D6  | A company whose own desktop app has not been built yet (just onboarded, or builds switched off): where do its people work?                   | (a) A generic **Integr8 Plus** company app on `/download` that signs in to any company by email (today's development build with only the company door). (b) Every company must have its own build before its owner is invited.                                     | **(a)**. Onboarding no longer waits on a build run, and the branded app replaces it later.                                           |

## Tasks, in commit order

1. `feat(core)`: remove `webOnly` and `NavApp` web, make billing read-only in
   the menu, drop `funnel` (D4), give the assistant channel a desktop default.
2. `feat(api)`: add `GET /v1/platform/downloads`; email links per D1;
   `admin-cli` messages; asset-tag address per D5; regenerate the OpenAPI file
   and the client.
3. `feat(api)`: remove sign-up and Stripe (D4), with their config, tests and
   `.env.example` lines.
4. `feat(desktop)`: the company screens (get started, people, company settings,
   website access, storage, read-only billing); fold assistant settings into
   them; pass the extra routes to the shared screens.
5. `feat(desktop)`: the staff platform session (D2) and shell, with the
   dashboard and company switching (D3).
6. `feat(desktop)`: the platform screens, one commit per group (companies and
   company page; plans, flags, announcements, templates; audit, storage,
   releases, health, staff, downloads), plus the bundle test that keeps them
   out of company builds.
7. `feat(desktop)`: the generic company build (D6) and its release workflow
   entry.
8. `feat(web)`: cut down to the public site; the invitation page's "password set,
   carry on in the app" step; the public `/a/[code]` page.
9. `chore(deploy)`: compose, Caddyfile, `deploy/.env.example`, the CSP.
10. `docs`: the docs pages, the help library (both languages), the setup guide
    (Markdown and HTML), `MEMORY.md`, `plan/README.md`, and the root README
    front page.

## Exit criteria

- [ ] `packages/core` has no `webOnly` and no `'web'` `NavApp`. Every section in
      `NAV_SECTIONS` has a non-null route in the desktop's `NAV_ROUTES`, checked
      by a test.
- [ ] A company owner can do in the company desktop app everything they could
      do on the web: invite and suspend people and give them roles, change
      company settings and the assistant switches, manage website keys, see
      storage and the plan. Each screen has a test.
- [ ] A staff member can do every platform dashboard action in the staff desktop
      app, then work inside a company and come back, with the grant ended and
      audited.
- [ ] `apps/web` builds with only the public routes listed in Design §4. A route
      list test fails if a workspace or platform route comes back.
- [ ] A company desktop build's bundle contains no platform screen code (bundle
      test).
- [ ] The invitation page sets a password and shows the "carry on in the app"
      step for a new and for an existing account.
- [ ] No email or CLI message links to a web workspace page (test over
      `email/links.ts` callers).
- [ ] With D4 (a): no `/v1/signup` or Stripe route in `openapi.json`, and the API
      starts with `BILLING_PROVIDER` unset.
- [ ] `pnpm lint`, `typecheck`, `test`, `format:check`, `guide:check` and
      `pins:check` pass. The integration suites pass against a disposable
      Postgres.
- [ ] The owner clicks through the staff and company desktop apps on Windows
      (real Tauri build) and signs a new person in through an invitation.
