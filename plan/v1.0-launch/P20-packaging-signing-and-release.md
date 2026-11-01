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

## Progress

- **Release images (2026-10-31).** The version release calls `publish-images.yml` after the
  release is published, so every release has `integr8-api:vX.Y.Z` and `integr8-web:vX.Y.Z`
  (amd64 + arm64), and `latest` names the newest release only. Production pins
  `API_IMAGE`/`WEB_IMAGE` to a release tag; `:main` and `:staging` are unreleased and for the
  test box. A tag created with `github.token` never started the `v*` trigger, which is why no
  release image existed before; "Publish images" can be run by hand with a tag for a release
  that already exists (v1.2.2).
- **Desktop auto-update (2026-10-31).** Release builds (staff and company) set
  `createUpdaterArtifacts` when `TAURI_SIGNING_PRIVATE_KEY` exists, so Tauri signs each
  bundle; `collect-bundles.mjs` names the assets so GitHub keeps them and writes each
  platform's part of the manifest, and `updater-manifest.mjs` attaches `latest.json` to
  the release. The web app serves it at `/desktop-updates/<staff|slug>/{{target}}/{{arch}}/{{current_version}}`
  (`apps/web/src/lib/desktop-updates.ts`), from the newest `v*` / `company-<slug>-v*`
  release, cached five minutes; `GITHUB_RELEASES_TOKEN` makes it pass downloads through
  if the repository becomes private. The app asks on start and every six hours and shows
  an "Install now" strip (`apps/desktop/src/components/update-banner.tsx`): Tauri 2 never
  checked by itself, and the v1 `dialog` setting did nothing, so no installed app had
  ever been offered an update. Nightlies keep the placeholder feed. Still to do: a real
  update from one release to the next on Windows, macOS and Linux, and a rollback test.
- **Optional OS code signing (2026-10-31).** Both desktop workflows sign Windows
  installers with a .pfx certificate (`WINDOWS_CERTIFICATE`) or Azure Artifact Signing
  (`AZURE_*`), and sign and notarise macOS builds (`APPLE_CERTIFICATE`,
  `APPLE_SIGNING_IDENTITY`, notarised with the `ASC_*` key or `APPLE_ID`), each only when
  all of its secrets exist; otherwise unsigned as before. No certificate has been
  bought: the exit criterion "installs without warnings" waits for them. Install notes
  for unsigned builds are in `docs/deployment/company-apps.md`.
