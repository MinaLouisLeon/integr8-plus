# P05 — Application shells

**Version:** v0.1 Foundation
**Status:** `IN PROGRESS`
**Depends on:** P04

## Goal

All four applications boot, authenticate, call the API, and are ready to receive features.

## Scope

Navigation, state, design tokens, internationalisation plumbing and error reporting for
each app. No product features.

## Tasks

- [x] **Web (Next.js)** — App Router, auth-guarded layouts, marketing shell and dashboard shell
- [x] **Desktop** — React SPA with routing, building both to a browser bundle and to a Tauri v2 shell
- [x] Tauri: keychain-backed token storage, updater plugin configured (keys generated, endpoint stubbed)
- [ ] **Mobile (Expo)** — navigation, SecureStore tokens, EAS project configured
- [x] Shared design tokens (colour, spacing, type scale) as data, consumed by all three UIs
- [x] Shared API client wiring: auth headers, refresh on 401, error surfacing
- [x] **i18n framework in place from the first screen** — all user-facing strings through the translation layer, English only for now
- [x] **RTL-safe layout from the first screen** — logical CSS properties (`inline-start`/`inline-end`), never hardcoded `left`/`right`; RN layout using `start`/`end`
- [x] Locale-aware date, number and currency formatting helpers
- [x] Sentry in all four apps with release and app-version tagging
- [x] Loading, empty and error states as shared primitives, so no screen invents its own

## Exit criteria

- [ ] All four apps sign in against the real API and display the current user and company
- [ ] The desktop app runs identically as a browser page and as a Tauri window
- [ ] Forcing the app into RTL produces a correctly mirrored layout on every existing screen
- [ ] A thrown error in each app appears in Sentry, tagged with the correct app version
- [x] `grep` for hardcoded user-facing strings returns nothing outside the translation files

## Notes

- The RTL and i18n tasks look premature and are not. Every screen built after this phase
  inherits them for free; every screen built before a retrofit has to be reworked by hand.
- Do not build a shared component library across web and React Native. Share tokens and
  logic; write the widgets twice.

---

## What remains

The last exit criterion is met and verifiable: the grep in
[`docs/ui/README.md`](../../docs/ui/README.md) returns exactly two lines, both error
boundaries that render when the React tree itself has thrown and no provider is mounted.
Every other string in all four apps goes through `@integr8/i18n`.

The other four need things this machine does not have.

### 1. A Supabase project — the same blocker as P02, P03 and P04

"All four apps sign in against the real API" cannot happen until there is a database
behind the API. Everything above it is built and the chain is complete in code: cookie or
keychain → refresh → generated client → tenant-scoped API. Finish
[`docs/database/runbook-supabase-setup.md`](../../docs/database/runbook-supabase-setup.md)
and this becomes a five-minute check across four apps.

**This is now four phases deep.** P02, P03, P04 and P05 all have unticked criteria whose
only blocker is that runbook.

### 2. Sentry DSNs

Each app reads its DSN from the environment and reports nothing without one — which is
correct for a laptop and wrong for production, and the API refuses to start in production
without it. Create the projects, set the DSNs, and throw a deliberate error in each: the
API already has `POST /health/probe-error` outside production for exactly this.

### 3. An EAS project

`eas.json` has all three build profiles. The `projectId` in `app.json` is a placeholder,
because a real one is bound to your Expo account. Run `eas init` in `apps/mobile`, and the
task closes. Local development needs none of this — Metro bundles and Expo Go runs it
today.

### 4. Two things that need a person to look at a screen

- **The Tauri window.** The bundle and the Rust binary both build; nobody has opened the
  window. `pnpm --filter @integr8/desktop tauri:dev` — see the note about paths with
  spaces below.
- **The right-to-left pass.** The mechanism is built and lint-enforced, but "correctly
  mirrored" is a judgement about pixels. Tick "Preview right-to-left" in the preference
  bar and read each screen.

### A local wrinkle worth knowing

This repository lives at a path containing a space, and the installed Rust toolchain is
the GNU one. `windres` truncates the path at the space, so the Tauri resource step fails.
Either install the MSVC toolchain or point Cargo elsewhere:

```bash
CARGO_TARGET_DIR=/c/integr8-rust-target pnpm --filter @integr8/desktop tauri:build
```

That is how the binary in this phase was compiled. It is a local environment issue, not a
repository one, so nothing machine-specific was committed.

## Decisions taken during implementation

- **Tokens are data, and only the DOM apps see CSS.** `@integr8/tokens` is plain
  TypeScript, because React Native cannot use CSS. A build step turns it into a stylesheet
  of custom properties mapped into Tailwind v4's theme, so `bg-surface` is a real utility
  on web and desktop while the mobile app reads `colours.light.surface` directly. One
  definition, three renderers.

- **One i18n library, not the best one per platform.** next-intl is a nicer fit for the
  Next.js App Router specifically, and choosing it would have meant two message formats
  and two ways to write the same string — in a phase whose entire value is that every
  later screen inherits this for free. i18next runs in all three.

- **Messages are TypeScript, not JSON.** `t('auth.signIn')` autocompletes and
  `t('auth.signin')` is a compile error. That is most of what makes the "no hardcoded
  strings" criterion enforceable: a developer who cannot remember a key is shown the list
  rather than tempted to type the sentence.

- **Arabic is declared now, untranslated.** Selecting it gives English words in a mirrored
  layout, which is exactly the check that a screen was built with logical properties. The
  copy is P32; the ability to test the layout is worth nothing later and everything now.

- **The RTL rule is lint, not review.** `@integr8/eslint-config` rejects `ml-*`, `pr-*`,
  `text-left`, `border-l`, `rounded-r`, `left-*` and their mirrors, and — because React
  Native differs from CSS here — `textAlign: 'left'` as well. RN does not accept `start`
  for text; its direction-following value is `auto`, and that difference is exactly the
  kind of thing that would otherwise be discovered by a customer.

- **Writing that rule found a real bug in itself.** The first version built its regex in
  an ordinary template literal, where `\s` is just `s`. The pattern therefore only matched
  a class at the very start of a string: `className="flex ml-4"` passed. `String.raw`
  fixes it, and the probe that caught it is recorded below.

- **The web app does not use `SessionManager`, and that is deliberate.** Desktop and
  mobile have real credential stores and keep their refresh token on the device. A browser
  has neither, and the two places a page could put one are the two places an XSS bug can
  read it. So on the web the refresh token never reaches JavaScript at all: it lives in an
  httpOnly cookie set by a Next route handler, and the access token is a variable that
  lasts as long as the tab. A reload costs one request.

- **One refresh, however many callers.** Six panels opening at once with an expired token
  must produce one refresh — not six that each rotate the token and invalidate the others.
  All three clients latch on an in-flight promise set before the first `await`.

- **The offline grant survives a refresh.** The refresh endpoint returns an access and a
  refresh token and says nothing about the grant, which was issued separately and outlives
  both. Dropping it would silently disable offline working on the next refresh — a bug
  only somebody who then lost signal would ever see.

- **One bundle for the desktop app, not two builds.** Everything Tauri-specific is behind
  a runtime check in one file, so the browser path is exercised every time anybody runs
  `pnpm dev`. That is what keeps "identical in both" true rather than aspirational.

- **A hash router on the desktop.** The Tauri window loads the bundle from a custom
  protocol where path-based routing needs the shell to cooperate. A hash route behaves the
  same in both homes.

- **Real OS keychain, not Stronghold.** Tauri's official secret plugin is an encrypted
  vault the app manages. A thirty-line Rust command over the `keyring` crate gives the
  actual Keychain, Credential Manager and Secret Service — which is what the phase asks
  for, and what a security questionnaire will ask about at P34.

- **The Tauri crate builds `rlib` only.** The template also emits `staticlib` and `cdylib`
  for its iOS and Android targets, which this product never produces — the mobile app is
  Expo. Dropping them is not only tidiness: linking a `cdylib` this size with MinGW fails
  outright with "export ordinal too large".

- **The mobile app follows Expo's pinned versions, not npm's latest.** Picking
  `react-native@0.87.1` broke the bundler: `@expo/metro-config` requires
  `react-native/rn-get-polyfills`, which that version removed. `expo install --check` is
  the source of truth for this app, and it disagrees with the other two apps' React
  version — which is fine, because they are separate bundles.

- **`SecureStore.AFTER_FIRST_UNLOCK`.** The session is needed the moment the app opens,
  including after a restart. This is the strictest setting that still lets an engineer
  open the app in a van at six in the morning.

- **Dates are spelled out, never numeric.** `03/04/2026` is the third of April in most of
  the world and the fourth of March in the United States. A job sheet is not the place to
  discover that.

- **`formatCurrency` takes the currency as a required argument.** A default is how an
  amount in one currency gets rendered with another's symbol, and the number looks
  perfectly reasonable either way.

- **Each app maps API error codes to its own copy.** The server's message is written for a
  developer reading a log, is not translated, and for a failed sign-in is the same
  sentence whatever went wrong. The `code` is the contract; the words are the app's.

- **Two literal strings survive, both in error boundaries.** They render when the React
  tree itself has thrown, so no provider is mounted and `t()` cannot be reached. They are
  the documented exception, and the grep that proves there are only two is in
  `docs/ui/README.md`.

## Verified so far

| Claim                                          | How it was proven                                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace builds and passes                    | `pnpm build`, `lint`, `typecheck`, `test`, `format:check` — all green across 13 packages; 336 unit tests                                  |
| The Next.js app builds                         | Seven routes compiled, including the three auth route handlers that hold the refresh cookie                                               |
| The desktop app builds twice from one source   | A 470 kB browser bundle from Vite, and a Tauri binary from `cargo build`                                                                  |
| The mobile app bundles                         | `expo export` produced 5.1 MB of Hermes bytecode for Android from 1,934 modules                                                           |
| The RTL lint rule is not decorative            | Probes confirmed `ml-4`, `pr-2`, `border-l`, `rounded-l`, `text-right`, `border-r-2` and `textAlign: 'left'` are each rejected            |
| …and that it works mid-string                  | `className="flex items-center ml-4"` is caught; the logical equivalents (`ms-4 pe-2 text-start rounded-s-md`) are not                     |
| No hardcoded user-facing strings               | The documented grep returns two lines, both error boundaries that cannot reach a provider                                                 |
| Tokens are consistent across themes            | 14 tests, including that light and dark define exactly the same token set — a token missing from one is a screen rendering `undefined`    |
| Translation behaves for an untranslated locale | Selecting `ar` yields English words rather than raw keys, which is what makes the RTL preview usable                                      |
| One refresh under concurrency                  | Six simultaneous requests with an expired token produce exactly one call to `/v1/auth/refresh`                                            |
| A dead refresh signs the person out            | Revoked and expired refresh tokens each clear the store and report a reason, rather than retrying a credential that will never work again |
| The offline grant is not lost on refresh       | Asserted explicitly, because losing it would only show up to somebody who had already lost signal                                         |
| Against the real API and Sentry                | **Not yet run.** Four exit criteria need a Supabase project, Sentry DSNs, an EAS project, and a person looking at a window                |
