# P32 — Arabic and full RTL

**Version:** v2.0 Scale and Enterprise
**Status:** `NOT STARTED`
**Depends on:** P05

## Goal
The product is fully usable in Arabic, right to left, on all three clients.

## Scope
Translation and the RTL quality pass. **The plumbing was built in P05** — if that was
done properly this phase is translation and polish, not rework.

## Tasks
- [ ] Full Arabic translation of every user-facing string
- [ ] Arabic typography: font selection, line height, and numeral form (Arabic-Indic or Western) decided per locale
- [ ] RTL QA pass across every screen on web, desktop and mobile
- [ ] Mirrored icons, gestures, transitions and directional affordances
- [ ] Locale-aware date, number and currency formatting verified
- [ ] Multi-language form labels, rendered by the filler's locale
- [ ] Per-user language preference, independent of company default
- [ ] Mixed-direction content handled correctly — an English part number inside an Arabic sentence
- [ ] PDF reports generated correctly in Arabic
- [ ] Translation workflow so new strings do not ship untranslated

## Exit criteria
- [ ] Every screen renders correctly in Arabic with no clipped, mirrored-wrong or untranslated text
- [ ] A form built in English and filled in Arabic stores identical structured answers
- [ ] An Arabic PDF report renders correctly, including mixed-direction content
- [ ] A native Arabic speaker reviews the product and signs off

## Notes
- If P05's RTL plumbing was skipped, this phase becomes several times larger and touches
  every screen ever built. That is why P05 lists it as a non-negotiable exit criterion.
