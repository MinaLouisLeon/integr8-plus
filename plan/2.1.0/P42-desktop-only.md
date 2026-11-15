# P42 — Desktop only: no web workspace, no web dashboard

**Status:** IN PROGRESS — built 2026-11-15 on branch `ccr-982c2137-h4as2m`; waiting for the owner's click-through on Windows (the last exit criterion)

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

**No company exists yet, and all data is test data that will be deleted, with
no backup** (owner, 2026-11-15). So nothing has to stay compatible: no printed
asset tags, no shipped installers, no customers' links, no stored rows to keep.
Removed `/v1` routes break no shipped build, and a new migration may drop tables
and values outright instead of expanding and contracting across two releases.

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
- **Open by tag code** (D5). The desktop gets the shared `AssetTagOpener` on the
  Assets screen: type or paste a tag code, or a scanned tag address, and the
  asset opens.
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
- **Platform session** (D2). Kept in memory only, never written to disk. Staff
  sign in with their password and authenticator code each time the app starts.
  The refresh token is rotated on every refresh, as the web did. The 8-hour
  session cap and the limited `test_companies` scope still apply. Closing the
  app ends the platform session (`/v1/platform/auth/sign-out` on close, where
  the window allows it).
- **Who to act as** (D3). "Work inside this company" acts as the owner, with no
  `targetUserId`, as today. Each person on the company page's people list also
  has "Act as this person", which sends `targetUserId`. Both ask for the reason
  (10 characters at least) and are audited as now.
- **Onboarding waits for the company's own app** (D6). There is no generic
  company app, so a company's people can work only once its branded desktop
  build exists. On the company page, **Invite the owner** and **Resend** are
  available only when the company's apps are switched on and a desktop release
  for its slug exists. Otherwise they say why, and link to the Apps panel's
  **Build apps** button. The API refuses an owner invitation for such a company
  too (`409 company_app_not_built`), so the rule holds outside the screen.
  Staff still work inside the company from the staff app meanwhile, to build its
  forms and set its branding before the build runs.
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
  `/accept-invitation`, and a new public `/a/[code]` page.
- **Asset tag page** (D5). The QR code keeps its address (`<site>/a/<code>`). The
  public page says "This is an asset tag for <company>. Scan it with your
  company's phone app", shows the code in large type for typing it in, and needs
  no sign-in. It reveals nothing about the asset beyond the company's public name
  and logo. The phone's scanner already reads the code from the address
  (`tagCodeOf`).
- **Invitation page.** After the password is set, the page shows "Your password
  is set" (or "updated" for an existing account), then "Carry on in your
  company's desktop or phone app", with that company's download links (which
  exist, by D6). It creates no session, as today.
- **Deleted:** `(app)/**`, `platform/**`, `/sign-in`, `/sign-up/**`,
  `app/api/auth/*`, `app/api/platform/*`, and the workspace, platform and session
  components and libraries listed above. The CSP and middleware are trimmed to
  match.
- **Compose and Caddy.** The `web` service and `app.integr8-media.com` stay; the
  service gets smaller. `WEB_APP_URL` keeps its name and now means "the public
  site".

### 5. API and email

- **Workspace links in emails** (D1). Billing, qualifications, contracts, work
  order, deadlines and people emails carry no link. Each names the screen in both
  languages ("Open **Contracts** in your company's desktop app"; a job email also
  gives the job's number). `billingUrl`, `qualificationsUrl`, `contractsUrl`,
  `workOrderUrl`, `deadlinesUrl`, `peopleUrl` and `verifySignupUrl` are deleted
  from `email/links.ts`; `acceptInvitationUrl` stays.
- **`admin-cli` messages.** Staff are told to open the staff desktop app. A
  company person is told to sign in to their company's app.
- **Sign-up and Stripe** (D4). Delete the `/v1/signup/*` routes and the sign-up
  emails, the Stripe adapter with its checkout, card portal and webhook routes,
  dunning's card path, the funnel (routes, `apps/api/src/routes/v1/platform/funnel.ts`,
  the dashboard's Funnel section), `PUBLIC_SIGNUP`, and the Stripe settings.
  `BILLING_PROVIDER` keeps only `none`, plus the `recording` stand-in for tests,
  and can then be removed as a setting. Migration **0020** drops what only
  sign-up and Stripe use: `signup_requests` and `signup_events` (with its year
  partitions, also removed from `ensure_year_partitions()`), plus any
  Stripe-only billing columns found while building. The schema-invariant,
  export and purge suites are updated on purpose. The release notes say these
  routes left `/v1`.
- **Assistant channel.** `'web'` is removed from `AI_CHANNELS`. The company's
  per-app switch keeps `desktop` and `mobile`, and migration 0020 drops
  `tenant_settings.ai_web_enabled`, since no stored row needs keeping. A request with no
  recorded app is treated as `desktop`. `x-client-app: web` stays a valid
  header, for the public site's calls (`/q`, `/d`, invitations, `/download`).
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

All answered by the owner on 2026-11-15, one by one.

| #   | Question                                                                                                                                     | Answer                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Emails that link to a workspace page (a job, contracts ending, deadlines, certificates expiring, billing, people): what do they link to now? | **No link.** The email names the screen to open in the company's app.                                                                          |
| D2  | Where is the staff app's platform session kept?                                                                                              | **In memory only.** Staff sign in (password + authenticator) each time the app starts; up to 8 hours while it stays open.                      |
| D3  | When staff work inside a company, whom do they act as?                                                                                       | **The owner by default**, plus "Act as this person" on the company page's people list.                                                         |
| D4  | Remove the sign-up and Stripe code from the API too?                                                                                         | **Delete it all**: routes, emails, Stripe adapter, funnel and its dashboard section, settings, and their tables (migration 0020).              |
| D5  | What does a printed asset tag's QR code hold?                                                                                                | **The public page's address** (`<site>/a/<code>`): a page saying to scan it with the company's phone app. The desktop gets "Open by tag code". |
| D6  | Where do a company's people work before its branded desktop app exists?                                                                      | **Nowhere yet: a branded build is required** before the owner is invited. No generic company app.                                              |

## Tasks, in commit order

1. `feat(db)`: migration 0020 — drop `signup_requests`, `signup_events` and its
   partitions, Stripe-only billing columns and `tenant_settings.ai_web_enabled`;
   update the invariant, export and purge suites.
2. `feat(core)`: remove `webOnly` and `NavApp` web, make billing read-only in
   the menu, drop `funnel` (D4), remove `'web'` from `AI_CHANNELS`.
3. `feat(api)`: add `GET /v1/platform/downloads`; emails without workspace links
   (D1); `admin-cli` messages; refuse an owner invitation before the company's
   desktop build exists (D6, `company_app_not_built`); regenerate the OpenAPI
   file and the client.
4. `feat(api)`: remove sign-up, Stripe and the funnel (D4), with their config,
   tests and `.env.example` lines.
5. `feat(desktop)`: the company screens (get started, people, company settings,
   website access, storage, read-only billing); fold assistant settings into
   them; "Open by tag code" on Assets (D5); pass the extra routes to the shared
   screens.
6. `feat(desktop)`: the staff platform session in memory (D2) and shell, with
   the dashboard, company switching and "Act as this person" (D3).
7. `feat(desktop)`: the platform screens, one commit per group (companies and
   company page; plans, flags, announcements, templates; audit, storage,
   releases, health, staff, downloads), plus the bundle test that keeps them
   out of company builds; the company page's invitation gate (D6).
8. `feat(web)`: cut down to the public site; the invitation page's "password set,
   carry on in the app" step; the public `/a/[code]` page (D5).
9. `chore(deploy)`: compose, Caddyfile, `deploy/.env.example`, the CSP.
10. `docs`: the docs pages, the help library (both languages), the setup guide
    (Markdown and HTML), `MEMORY.md`, `plan/README.md`, and the root README
    front page.

## Exit criteria

- [x] `packages/core` has no `webOnly` and no `'web'` `NavApp`. Every section in
      `NAV_SECTIONS` has a non-null route in the desktop's `NAV_ROUTES`, checked
      by a test.
- [x] A company owner can do in the company desktop app everything they could
      do on the web: invite and suspend people and give them roles, change
      company settings and the assistant switches, manage website keys, see
      storage and the plan. Each screen has a test.
- [x] A staff member can do every platform dashboard action in the staff desktop
      app, then work inside a company and come back, with the grant ended and
      audited.
- [x] `apps/web` builds with only the public routes listed in Design §4. A route
      list test fails if a workspace or platform route comes back.
- [x] A company desktop build's bundle contains no platform screen code (bundle
      test).
- [x] The invitation page sets a password and shows the "carry on in the app"
      step for a new and for an existing account.
- [x] No email or CLI message links to a web workspace page (test over
      `email/links.ts` callers).
- [x] No `/v1/signup`, funnel or Stripe route in `openapi.json`; the API starts
      with no billing or sign-up setting; migration 0020 goes down and up again
      in the test setup.
- [x] The staff app keeps no platform token on disk (test over the credential
      store calls), and "Act as this person" creates a grant naming that person.
- [x] An owner invitation for a company with no desktop release is refused with
      `company_app_not_built`, by the API and on the company page.
- [x] A scanned tag address opens the public asset-tag page without sign-in and
      shows nothing beyond the company's public name and logo; the desktop opens
      an asset by its tag code.
- [x] `pnpm lint`, `typecheck`, `test`, `format:check`, `guide:check` and
      `pins:check` pass. The integration suites pass against a disposable
      Postgres.
- [ ] The owner clicks through the staff and company desktop apps on Windows
      (real Tauri build) and signs a new person in through an invitation.

## Implementation notes (2026-11-15)

Where the build differs from, or goes beyond, the design above:

- **`@integr8/releases`** (new package): the GitHub release lookup moved out of
  `apps/web` so the public site's update feed and the API (`APP_RELEASES`, the
  staff downloads, the invitation gate) share one implementation.
- **More of billing went than planned.** Besides sign-up, Stripe and the funnel,
  0020 drops `billing_events`, the card provider's subscription columns
  (provider and its ids, interval, periods, dunning fields), `plan_allowances`'
  provider price ids and `tenants.billing_mode`; dunning and the trial-expiry job
  are gone. Every company starts `active` on its plan. The general read-only
  switch (`tenants.read_only_*`) stays, though nothing sets it now.
- **The gate covers company-side invitations too**: `POST /v1/members/invitations`
  and its resend refuse `company_app_not_built`, so staff acting as a company
  cannot invite its owner from People before the app exists. The company detail
  reports `companyApp` (`ready`, `apps_off`, `not_built`, `unavailable`).
- **Staff session safety**: the staff build ends a company session it finds in
  the credential store at start-up when no staff session is held, so a restart
  cannot skip the staff sign-in. The company frame reaches the staff session only
  through `apps/desktop/src/lib/staff-bridge.ts`.
- **Assistant settings** moved from the desktop's own screen into People
  (switches and shares) and Company settings (desktop and phone switches); the
  separate screen is gone.
- **The asset tag** (D5): `GET /v1/public/asset-tags/:code` names the company for
  the public `/a/<code>` page; the desktop opens an asset from a tag code or a
  pasted tag address at `#/assets/tag/<code>`, and the Assets search finds a tag
  code.
- **Accepting an invitation** returns the company (`company: { name, slug }`), so
  the page links to `/download?company=<slug>`.
- **Test companies** get no app builds, so their people can sign in only with the
  development desktop build; the developer MCP server needs no sign-in, and the
  setup guide's test box steps use the development build.
- **Checked here**: the database and API integration suites against a local
  Postgres 16 (migration 0020 rolled down and up), and the staff flow end to end
  in a browser against a running API (sign in, onboard, the invitation gate, work
  inside a company, People, Billing, back to the dashboard, downloads). Not
  checked: a real Tauri build on Windows or macOS, and a real GitHub release
  lookup (`APP_RELEASES=github`).
