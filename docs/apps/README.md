# The apps

| App            | Stack                                        | For                                                  | Sign-in tokens live in             |
| -------------- | -------------------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| `apps/web`     | Next.js App Router                           | Every company's office, the public site, staff       | An httpOnly cookie (refresh token) |
| `apps/desktop` | Vite + React in Tauri v2                     | A company's office (branded build), or Integr8 staff | The OS credential store            |
| `apps/mobile`  | Expo + React Native + Expo Router, SQLCipher | A company's engineers (branded build), offline       | SecureStore                        |

All three use the same API client and `SessionManager` (`@integr8/api-client`),
translations (`@integr8/i18n`) and design tokens (`@integr8/tokens`), and refresh
through one latch, so several panels opening on an expired token cause one
refresh. Tokens are never kept in `localStorage` on any client.

The phone is described on its own page, [mobile.md](./mobile.md), because it
works differently: its screens read a local database, never the API.

## The web app and the desktop app

Both are for a company's office, and both talk only to the `/v1` API; the
split between them is all in the menu model and the shells.

**One menu, two maps.** `packages/core/src/navigation.ts` lists every section
once. A section marked `desktopOnly` or `webOnly` appears in one app only;
`visibleNavigation(app, …)` drops it in the other, and each app maps the rest to
its own routes (`apps/web/src/lib/navigation.ts` `NAV_PATHS`, Next.js paths;
`apps/desktop/src/lib/navigation.ts` `NAV_ROUTES`, hash routes, `null` for the
web's screens). Every other section, from work orders and submissions to CRM,
sales, finance, ledger, inventory, purchasing, manufacturing, HR, contracts,
documents and e-invoicing, is in both, drawn by the same shared screens
(`@integr8/operations-dom`, `@integr8/form-renderer-dom`).

| Only in the desktop app                     | Section key        | Permission                                    |
| ------------------------------------------- | ------------------ | --------------------------------------------- |
| The schedule board (drag-and-drop dispatch) | `schedule`         | `work_order.read_all`                         |
| The form builder and PDF template designer  | `forms`            | `form.read`; editing is `form.manage` (staff) |
| Company branding                            | `branding`         | `branding.manage` (staff)                     |
| The e-invoicing switch                      | `eInvoicingSwitch` | `eta.switch` (staff)                          |
| Company roles (making and editing roles)    | `companyRoles`     | `member.update_role`                          |

| Only in the web app                                    | Section key       | Permission              |
| ------------------------------------------------------ | ----------------- | ----------------------- |
| Get started (the new company's checklist)              | `getStarted`      | —                       |
| People: invitations, giving roles, suspending          | `people`          | `member.read`           |
| Company settings (timezone, working days, currency, …) | `companySettings` | `tenant.update`         |
| Website access (the company website's keys)            | `websiteAccess`   | `website.access.manage` |
| Storage use                                            | `storage`         | `storage.read`          |
| Billing                                                | `billing`         | `billing.read`          |

Also only on the web, outside the company menu: the public site (home, features,
pricing, help, legal, `/download`), sign-up and accepting an invitation, the
customer's quote link (`/q`) and shared-document page (`/d`), the desktop update
feed (`/desktop-updates`) and the whole **platform dashboard** (`/platform`:
companies, plans, flags, templates, releases, staff, downloads and the rest; see
[platform/](../platform/README.md)). The staff desktop app has no
platform screens: a staff member signs in with their platform account, picks a
company and works inside it through an audited impersonation grant
(`apps/desktop/src/lib/staff.ts`), mainly to build forms and set branding.

**What the desktop shell adds.** The same bundle runs in a browser tab during
development; `isTauri()` (`apps/desktop/src/lib/platform.ts`) is the one place
the two paths differ.

| Concern            | Web app                                    | Desktop app                                                                                                                       |
| ------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in tokens     | httpOnly cookie held by the Next.js server | The OS credential store (Keychain, Credential Manager, Secret Service) through a Rust command                                     |
| Who it is for      | Every company, at `app.integr8-media.com`  | `staff` flavour (Integr8 Plus Staff) or `company` flavour: one branded build per company (`VITE_APP_FLAVOR`, `VITE_COMPANY_SLUG`) |
| Branding           | The company's, after sign-in               | Built in: the company's name, icon and identifier (`com.integr8.plus.<slug>`)                                                     |
| Updates            | Deployed with the server                   | Updates itself from `app.integr8-media.com/desktop-updates`; a too-old build is told to update                                    |
| Opening files      | A new tab, opened at the click             | The OS's default program (`tauri-plugin-opener`, passed to shared screens as `openLink`)                                          |
| Right-click        | The browser's menu                         | Its own menu: row actions on jobs, customers, sites, job types, timesheets, submissions and forms; Cut, Copy, Paste in fields     |
| Speaking to the AI | The browser's speech recognition           | The OS's dictation (Windows and macOS; none on Linux)                                                                             |
| ETA signing        | Prepares and submits                       | Also the signing queue that checks each request before a hardware token signs (no signer driver ships yet)                        |
| Offline            | No                                         | No (only the phone app works offline)                                                                                             |

Either app may show the same section to a person with the same permissions;
plan limits and permissions are enforced by the API, so the split above is
about where a screen is drawn, never about what a person may do.

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
physical forms. Web and desktop have "Preview right-to-left" in the preference
bar; the phone follows the device language and needs a restart.

**Tokens.** `@integr8/tokens` is data, not CSS. Web and desktop import the
generated `@integr8/tokens/theme.css` (CSS custom properties mapped into
Tailwind v4, so `bg-surface` is a utility; regenerate with `pnpm --filter
@integr8/tokens css`); the phone imports the TypeScript. Screens name semantic
tokens (`surface`, `danger`, `textMuted`), never raw colours. The public pages,
`/download` and the staff dashboard wear the Integr8 Media website's look and
fonts (self-hosted in `packages/tokens`); a company's workspace wears the
company's branding (logo, icon, accent and menu colours, theme).

**Dates and times.** The platform's own controls: `<input type="date">`, `time`
and `datetime-local` on web and desktop, opened by a click anywhere on the box
(`openPickersOnClick`), and `@react-native-community/datetimepicker` on the
phone. A theme sets `color-scheme` so pickers match. Never a typed date.

## Running them

```bash
pnpm --filter @integr8/api dev             # the API first: everything calls it
pnpm --filter @integr8/web dev             # http://localhost:3001
pnpm --filter @integr8/desktop dev         # http://localhost:3002, as a browser page
pnpm --filter @integr8/desktop tauri:dev   # the same bundle, as a native window (needs Rust)
pnpm --filter @integr8/mobile dev          # Metro; press i or a
```

A desktop build with no `VITE_APP_FLAVOR` is a development build. On Windows, a
path containing a space breaks the GNU Rust toolchain's `windres`: use the MSVC
toolchain or set `CARGO_TARGET_DIR` to a path without one. The updater's
private key (`src-tauri/updater.key`) is git-ignored and belongs in a secret
store; whoever holds it can ship an update every installed copy accepts.
