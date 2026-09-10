# P20 — Packaging, signing and release

**Version:** v1.0 Launch
**Status:** `NOT STARTED`
**Depends on:** P19

## Goal

Customers can install the desktop app and the mobile app through normal channels, and you
can ship updates to them safely.

## Scope

Code signing, store submission and release channels. **Start the certificate work early
— it is slow and gated by third parties.**

## Tasks

- [ ] Apple Developer account, certificates and notarisation for the macOS Tauri build
- [ ] Windows code-signing certificate (organisation validation takes weeks; budget for it)
- [ ] Tauri updater: signing keys generated and stored securely, update endpoint hosted, rollback path tested
- [ ] Linux packaging if in scope, otherwise explicitly out of scope
- [ ] EAS Build configured for iOS and Android production builds
- [ ] App Store and Play Store listings: screenshots, descriptions, privacy declarations
- [ ] **Demo account with seeded data for App Store review** — a reviewer who cannot sign in rejects the build
- [ ] Background location justification, or its removal, before submission
- [ ] EAS Update channels for JavaScript-only fixes
- [ ] Release channels: internal, beta, stable, for both desktop and mobile
- [ ] `min_supported_client` enforcement wired end to end, with a tested update prompt
- [ ] Release checklist and changelog process

## Exit criteria

- [ ] A signed desktop build installs on a clean Mac and a clean Windows machine without warnings
- [ ] The desktop app updates itself from the previous version, and a rollback has been tested
- [ ] Both mobile apps are approved and installable from their stores
- [ ] An out-of-date client receives the update prompt and can complete the update

## Notes

- Windows organisation-validation certificates commonly take two to four weeks. Start the
  application during v0.3, not here.
- Over-the-air updates cover JavaScript only. A native module change still needs a store
  release — plan native changes into release trains.
