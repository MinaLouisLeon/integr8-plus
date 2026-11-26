# The apps

| App            | Stack                                        | For                                                                      | Sign-in tokens live in                                     |
| -------------- | -------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------- |
| `apps/desktop` | Vite + React in Tauri v2                     | A company's office (its own branded build), or Integr8 staff (staff app) | The OS credential store (company); memory only (staff, D2) |
| `apps/mobile`  | Expo + React Native + Expo Router, SQLCipher | A company's engineers (branded build), offline                           | SecureStore                                                |
| `apps/web`     | Next.js App Router                           | The public site only: nobody signs in there (P42)                        | None                                                       |

The desktop and phone apps use the same API client and `SessionManager`
(`@integr8/api-client`), translations (`@integr8/i18n`) and design tokens
(`@integr8/tokens`), and refresh through one latch, so several panels opening on
an expired token cause one refresh. Tokens are never kept in `localStorage`.

The phone is described on its own page, [mobile.md](./mobile.md), because it
works differently: its screens read a local database, never the API.

## The desktop app: the office, and the staff app (P42)

Since P42 there is no web workspace and no web dashboard: a company's office
works in its own desktop app, and Integr8 staff in the staff desktop app. One
codebase, three builds (`VITE_APP_FLAVOR`, `apps/desktop/src/lib/env.ts`):

| Build         | Who                                        | Opens on                         | Sign-in                                                        |
| ------------- | ------------------------------------------ | -------------------------------- | -------------------------------------------------------------- |
| `company`     | One company's people (`VITE_COMPANY_SLUG`) | The company's dashboard          | Email and password, or an emailed code; that company only      |
| `staff`       | Integr8 staff                              | The staff dashboard, `/platform` | Platform password and authenticator code, every time it starts |
| `development` | Developers                                 | The company dashboard            | Both, as tabs                                                  |

**The company menu.** `packages/core/src/navigation.ts` lists every section once,
with the permission that reveals it and the module it needs;
`visibleNavigation(…)` gives one seat its groups, and
`apps/desktop/src/lib/navigation.ts` maps each section to a hash route (every
section has one). Everything is drawn by the desktop or the shared screens
(`@integr8/operations-dom`, `@integr8/form-renderer-dom`): work orders, the
schedule board, submissions, CRM, sales, finance, ledger, inventory, purchasing,
manufacturing, HR, contracts, documents, e-invoicing, and under Company: Get
started, People (invitations, roles, suspending, assistant switches and shares),
Company roles, Company settings (with the assistant's desktop and phone
switches), Website access, Storage and Billing (read-only: plan, limits, usage;
Integr8 invoices every company). Forms, Company branding and the e-invoicing
switch are worked on by staff acting as the company.

**The staff app.** After signing in staff land on the dashboard
(`apps/desktop/src/features/platform/`): companies and onboarding, a company's
page, storage, plans, audit, flags, announcements, templates, releases, health,
staff and downloads ([platform/](../platform/README.md)). **Work inside this
company** (as the company) or **Act as this person** (as one of its people, D3)
opens an audited impersonation grant; the window switches to the company's
workspace, and **Back to the dashboard** on the banner ends the grant and the
company session and returns to the company's page. The platform session is kept
in memory only (`features/platform/session.ts`, D2): closing the app ends it,
and a company session found in the credential store at start-up of the staff
build is ended rather than let in without the staff sign-in. The dashboard and
the staff sign-in are loaded lazily behind the build's flavour, so a company's
build carries none of them (`pnpm --filter @integr8/desktop
check:company-bundle`, run in CI); the company frame reaches the staff session
only through `lib/staff-bridge.ts`.

**What the shell adds.** The same bundle runs in a browser tab during
development; `isTauri()` (`apps/desktop/src/lib/platform.ts`) is the one place
the two paths differ.

| Concern            | Desktop app                                                                                                                   |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Sign-in tokens     | Company sessions in the OS credential store (Keychain, Credential Manager, Secret Service); the staff session in memory only  |
| Branding           | Built in: the company's name, icon and identifier (`com.integr8.plus.<slug>`); the staff app wears the Integr8 Media look     |
| Updates            | Updates itself from the public site's `/desktop-updates`; a too-old build is told to update                                   |
| Opening files      | The OS's default program (`tauri-plugin-opener`, passed to shared screens as `openLink`)                                      |
| Right-click        | Its own menu: row actions on jobs, customers, sites, job types, timesheets, submissions and forms; Cut, Copy, Paste in fields |
| Speaking to the AI | The OS's dictation (Windows and macOS; none on Linux)                                                                         |
| ETA signing        | Prepares, submits, and the signing queue that checks each request before a hardware token signs (no signer driver ships yet)  |
| Offline            | No (only the phone app works offline)                                                                                         |

Plan limits and permissions are enforced by the API, never by a screen.

## The public site (`apps/web`)

What must open in a plain browser, for people who have no app: home, contact,
help, legal, `/download` (a company's installers and phone
app), accepting an invitation (`/accept-invitation`: the person
sets a password, is told it is set, and is sent to the company's apps), and the
desktop apps' update feed (`/desktop-updates`). It serves no company's
documents, quote links or asset-tag pages: those open on the company's own
website (see [documents](../documents/README.md)). It has no features or pricing
pages: the product is presented, with no prices, on the Integr8 Media website
(`integr8-media.com/integr8-plus`), which the home page links to. Nothing on it
signs anybody in,
and its client sends no token (`apps/web/src/lib/api-client.ts`). The route list
is pinned by `apps/web/src/app/public-routes.test.ts`. The release lookup it
shares with the API is `@integr8/releases`.

## The phone, in one table

The phone has a fixed home screen rather than the office's menu. Its buttons
follow the same tab switches as web and desktop (`PHONE_SCREEN_SECTIONS` in
`@integr8/core` maps them): jobs, forms (`fill`), customers, assets, expenses
(`myExpenses`), van stock (`vanRequests`), receiving (`purchaseOrders`),
documents, payslips (`myPayslips`), qualifications and the assistant. It has no
dispatch, CRM, sales, finance, ledger, manufacturing, settings, people or form
building: those are office work. Details in [mobile.md](./mobile.md).

## Rules every screen follows

**Strings.** Every user-facing string goes through `@integr8/i18n`, in both
`packages/i18n/src/messages/en.ts` and `ar.ts` (TypeScript, so a wrong key is a
compile error). A parity test checks keys, placeholders and Arabic's six plural
forms. Keys name the meaning, not the words; never build a sentence from
fragments (use `{{name}}` and plural keys). The API's error messages are for
developers and never shown: each app maps the error `code` to its own text. The
only literal strings allowed are the two last-resort error boundaries
(`apps/web/src/app/global-error.tsx`, `apps/desktop/src/main.tsx`).

**Right to left.** Logical directions only: `ms-`/`pe-`/`start-`/`text-start`/
`border-s`, never `ml-`/`left-`/`text-left`; `paddingStart` and `textAlign:
'auto'` on React Native (which does not accept `start`). ESLint rejects the
physical forms. The desktop app switches language from its menu; the phone
follows the device language and needs a restart.

**Tokens.** `@integr8/tokens` is data, not CSS. The public site and the desktop app
import the generated `@integr8/tokens/theme.css` (CSS custom properties mapped into
Tailwind v4, so `bg-surface` is a utility; regenerate with `pnpm --filter
@integr8/tokens css`); the phone imports the TypeScript. Screens name semantic
tokens (`surface`, `danger`, `textMuted`), never raw colours. The public site
and the staff app's frame wear the Integr8 Media website's look and fonts
(self-hosted in `packages/tokens`); a company's workspace wears the company's
branding (logo, icon, accent and menu colours, theme).

**Dates and times.** The platform's own controls: `<input type="date">`, `time`
and `datetime-local` on web and desktop, opened by a click anywhere on the box
(`openPickersOnClick`), and `@react-native-community/datetimepicker` on the
phone. A theme sets `color-scheme` so pickers match. Never a typed date.

## Running them

```bash
pnpm --filter @integr8/api dev             # the API first: everything calls it
pnpm --filter @integr8/web dev             # the public site, http://localhost:3001
pnpm --filter @integr8/desktop dev         # http://localhost:3002, as a browser page (VITE_APP_FLAVOR=staff for the staff app)
pnpm --filter @integr8/desktop tauri:dev   # the same bundle, as a native window (needs Rust)
pnpm --filter @integr8/mobile dev          # Metro; press i or a
```

A desktop build with no `VITE_APP_FLAVOR` is a development build. On Windows, a
path containing a space breaks the GNU Rust toolchain's `windres`: use the MSVC
toolchain or set `CARGO_TARGET_DIR` to a path without one. The updater's
private key (`src-tauri/updater.key`) is git-ignored and belongs in a secret
store; whoever holds it can ship an update every installed copy accepts.
