# P05 — Application shells

**Version:** v0.1 Foundation
**Status:** `NOT STARTED`
**Depends on:** P04

## Goal

All four applications boot, authenticate, call the API, and are ready to receive features.

## Scope

Navigation, state, design tokens, internationalisation plumbing and error reporting for
each app. No product features.

## Tasks

- [ ] **Web (Next.js)** — App Router, auth-guarded layouts, marketing shell and dashboard shell
- [ ] **Desktop** — React SPA with routing, building both to a browser bundle and to a Tauri v2 shell
- [ ] Tauri: keychain-backed token storage, updater plugin configured (keys generated, endpoint stubbed)
- [ ] **Mobile (Expo)** — navigation, SecureStore tokens, EAS project configured
- [ ] Shared design tokens (colour, spacing, type scale) as data, consumed by all three UIs
- [ ] Shared API client wiring: auth headers, refresh on 401, error surfacing
- [ ] **i18n framework in place from the first screen** — all user-facing strings through the translation layer, English only for now
- [ ] **RTL-safe layout from the first screen** — logical CSS properties (`inline-start`/`inline-end`), never hardcoded `left`/`right`; RN layout using `start`/`end`
- [ ] Locale-aware date, number and currency formatting helpers
- [ ] Sentry in all four apps with release and app-version tagging
- [ ] Loading, empty and error states as shared primitives, so no screen invents its own

## Exit criteria

- [ ] All four apps sign in against the real API and display the current user and company
- [ ] The desktop app runs identically as a browser page and as a Tauri window
- [ ] Forcing the app into RTL produces a correctly mirrored layout on every existing screen
- [ ] A thrown error in each app appears in Sentry, tagged with the correct app version
- [ ] `grep` for hardcoded user-facing strings returns nothing outside the translation files

## Notes

- The RTL and i18n tasks look premature and are not. Every screen built after this phase
  inherits them for free; every screen built before a retrofit has to be reworked by hand.
- Do not build a shared component library across web and React Native. Share tokens and
  logic; write the widgets twice.
