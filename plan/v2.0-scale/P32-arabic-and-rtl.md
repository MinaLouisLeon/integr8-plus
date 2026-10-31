# P32 — Arabic and full RTL

**Version:** v2.0 Scale and Enterprise
**Status:** `IN PROGRESS` — most of the translation and the RTL plumbing shipped with the modules (October 2026 review); the QA pass, typography decisions and the native-speaker sign-off remain
**Depends on:** P05

## Goal

The product is fully usable in Arabic, right to left, on all three clients.

## Scope

Translation and the RTL quality pass. **The plumbing was built in P05** — if that was
done properly this phase is translation and polish, not rework.

## Tasks

- [ ] Full Arabic translation of every user-facing string (every catalogue key has Arabic; push notifications and reminder emails since 2026-10-31, see Notes; the invitation, signup and a few platform emails are still English)
- [ ] Arabic typography: font selection, line height, and numeral form (Arabic-Indic or Western) decided per locale
- [ ] RTL QA pass across every screen on web, desktop and mobile
- [ ] Mirrored icons, gestures, transitions and directional affordances
- [ ] Locale-aware date, number and currency formatting verified
- [x] Multi-language form labels, rendered by the filler's locale
- [ ] Per-user language preference, independent of company default
- [ ] Mixed-direction content handled correctly — an English part number inside an Arabic sentence
- [ ] PDF reports generated correctly in Arabic
- [x] Translation workflow so new strings do not ship untranslated (the i18n parity test fails a build with a key missing in either language)

## Exit criteria

- [ ] Every screen renders correctly in Arabic with no clipped, mirrored-wrong or untranslated text
- [ ] A form built in English and filled in Arabic stores identical structured answers
- [ ] An Arabic PDF report renders correctly, including mixed-direction content
- [ ] A native Arabic speaker reviews the product and signs off

## Notes

- If P05's RTL plumbing was skipped, this phase becomes several times larger and touches
  every screen ever built. That is why P05 lists it as a non-negotiable exit criterion.

## Notifications in the reader's language — 2026-10-31

No language is stored per person (that is the unticked per-user preference above); each app
picks one per device. So:

- **Push notifications** are written in the phone's language. The phone sends it when it
  registers (`PUT /v1/me/push-device`, optional `locale`, sent on every launch), it is kept in
  `push_devices.locale` (migration 0066), and job, visit, deadline and certificate notifications
  are written in it. A phone that has not said (one older than this release) gets English, as
  before, until it next registers with a language.
- **Reminder emails** (deadlines, contract renewals, certificate expiry, payment reminders) go to
  people, not devices, so they use the company's language setting (`tenant_settings.locale`).
  The payment reminder's banner is posted in both languages, and each app shows its own.
- The texts are in the catalogues under `notifications`, so the parity test covers them. The API
  reads them through `@integr8/i18n/core` (`apps/api/src/notifications/words.ts`).
- Proven by the `job-execution` integration suite (an Arabic phone and an older one in one
  change; re-registering with and without a language), the billing suite (an Arabic company's
  reminder email and both-language banner), and `notifications/words.test.ts` (each email in
  Arabic, English unchanged).
