# P08 — Web renderer and submissions

**Version:** v0.2 Form Engine
**Status:** `NOT STARTED`
**Depends on:** P07

## Goal
A published form can be filled and submitted on desktop and web, stored correctly, and
found again.

## Scope
The React DOM renderer and the submission lifecycle. The React Native renderer is P13.

## Tasks
- [ ] React DOM renderer driven entirely by the P06 logic core — no form-specific code
- [ ] Widget for every field type in the registry, with keyboard and screen-reader support
- [ ] Signature capture on desktop (mouse, trackpad and touch)
- [ ] Progress indicator and section navigation for long forms
- [ ] Required-field blocking with a jump-to-error list
- [ ] Review screen before submit
- [ ] Draft autosave, server-side, resumable on another device
- [ ] Submission storage: JSONB plus generated columns for reportable fields, with indexes
- [ ] **Server-side revalidation of every submission against its bound form version** — the client validates for speed, the server validates for truth
- [ ] Submission list: search and filter by form, date, submitter, linked entity; CSV export
- [ ] Submission detail view rendering the answers against the version they were given
- [ ] Reopen and amend, with a full change history and no silent edits

## Exit criteria
- [ ] A submission crafted by hand that violates the form's rules is rejected by the API
- [ ] A submission made against version 1 still renders correctly after version 4 is published
- [ ] Filtering ten thousand seeded submissions by a reportable field returns in under 300ms
- [ ] Every field type in the registry has a working, accessible widget

## Notes
- Generated columns are how you get reporting performance without giving up the
  flexibility of JSONB. Decide which fields are "reportable" at publish time.
- Never trust a client-side validation pass. The renderer runs on machines you do not control.
