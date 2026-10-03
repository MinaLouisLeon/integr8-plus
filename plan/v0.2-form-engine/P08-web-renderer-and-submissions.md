# P08 — Web renderer and submissions

**Version:** v0.2 Form Engine
**Status:** `COMPLETED — 2026-09-14`
**Depends on:** P07

## Goal

A published form can be filled and submitted on desktop and web, stored correctly, and
found again.

## Scope

The React DOM renderer and the submission lifecycle. The React Native renderer is P13.

## Tasks

- [x] React DOM renderer driven entirely by the P06 logic core — no form-specific code
- [x] Widget for every field type in the registry, with keyboard and screen-reader support
- [x] Signature capture on desktop (mouse, trackpad and touch)
- [x] Progress indicator and section navigation for long forms
- [x] Required-field blocking with a jump-to-error list
- [x] Review screen before submit
- [x] Draft autosave, server-side, resumable on another device
- [x] Submission storage: JSONB plus typed, indexed values for reportable fields
- [x] **Server-side revalidation of every submission against its bound form version** — the client validates for speed, the server validates for truth
- [x] Submission list: search and filter by form, date, submitter and reportable answers; CSV export
- [x] Submission detail view rendering the answers against the version they were given
- [x] Reopen and amend, with a full change history and no silent edits

**Filtering by linked entity** moved to P10, where customers, sites and jobs are created:
until then there is nothing to link a submission to. P10's task list carries it.

**"Generated columns for reportable fields"** became a typed side table. Postgres cannot
add generated columns per company per form without running DDL at publish on a shared
table. Which fields are reportable is still decided at publish, as the notes ask, and the
one generated column is the full-text search vector. See _Decisions_.

## Exit criteria

- [x] A submission crafted by hand that violates the form's rules is rejected by the API
- [x] A submission made against version 1 still renders correctly after version 4 is published
- [x] Filtering ten thousand seeded submissions by a reportable field returns in under 300ms
- [x] Every field type in the registry has a working, accessible widget

## Notes

- Generated columns are how you get reporting performance without giving up the
  flexibility of JSONB. Decide which fields are "reportable" at publish time.
- Never trust a client-side validation pass. The renderer runs on machines you do not control.

---

## Verified

| Claim                                             | How it was proven                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A hand-crafted invalid submission is rejected     | API integration tests send, bypassing any client: a missing required answer, a hidden question answered, an unknown question, a calculated value, a wrong shape, a broken limit, an unoffered choice, a photo never uploaded, a photo described differently, a false "today". Each is 422 naming the question; nothing is stored                                                                            |
| Version 1 still renders after version 4           | API integration test publishes versions 2–4 (removing a question, adding a required one) and reads the version 1 submission: it comes back with version 1's definition, which still accepts its answers; `AnswerView` renders from that definition alone                                                                                                                                                    |
| Ten thousand submissions filter in under 300 ms   | 10,000 per company in two companies, seeded through the production triggers; a choice, a number range, a date, two fields, a rare value and a page deep in the results each take 5–45 ms (median of five, through the repository)                                                                                                                                                                           |
| Every field type has a working, accessible widget | For each registry type: found by its accessible name, answered as a person would (keyboard for rating, typed signature, file upload, geolocation), the engine's answer checked, axe-core clean before and after; the test fails if a type has no case; unlinking labels fails ten tests                                                                                                                     |
| No silent edits, for every role                   | Database tests change submitted answers as the owner and the runtime role (refused), write history as the runtime role (refused), rewrite history as the owner (refused); removing the rule from the migration fails the test                                                                                                                                                                               |
| The whole flow works in a real browser            | Web app against the API and PostgreSQL 17.10: an engineer filled a two-page form (condition, calculation, out-of-range warning, photo upload, device location, drawn signature), reviewed and submitted; the owner filtered by an answer, exported CSV and reopened; the engineer corrected with a reason; the history marked the changed answer; a draft started on the web was resumed in the desktop app |
| Nothing else regressed                            | Workspace lint, typecheck, unit tests and build; db integration 180, API integration 78, form engine 439 (99.28% statements), Hermes conformance byte for byte                                                                                                                                                                                                                                              |

Accessibility is verified by automated checks (axe-core, which cannot judge colour
contrast in jsdom — the design tokens carry that) and by keyboard-only tests. A pass with a
real screen reader before the first customer is worth doing and is not claimed here.

## Decisions taken during implementation

- **A typed side table rather than generated columns.** `submission_values` holds one row
  per reportable answer in the column its type names, with an index per type leading with
  company, form and question. It is written by the database trigger, not the API, so it
  cannot disagree with the answers whatever wrote them.
- **The lifecycle is enforced in the database.** A trigger refuses any transition that is
  not draft→submitted, submitted→reopened or reopened→submitted, refuses a reopening or
  correction without a reason, and refuses any change to submitted answers. History is
  written by a security-definer trigger into a table the runtime role can only read.
- **Media behind an interface from the start.** The API hands out signed upload and
  download links and confirms what storage holds; the local-disk adapter signs its own
  links so the flow is R2's. P09 replaces the adapter.
- **CORS is an allow-list.** Found as a gap in P07. Local origins are allowed in
  development; production refuses to start without `API_CORS_ORIGINS`, or with local media.
- **The screens are shared too.** Fill, list and detail screens are in
  `@integr8/form-renderer-dom/screens`; each app supplies its client, routing and download.
  P01 now records the DOM-to-DOM exception to its rule about widgets.
- **Drafts are private.** Nobody but its author lists or opens a draft, whatever their
  role; a submitted form is visible to its author and to `submission.read_all`.
- **The server's "today" bound.** Rules about today are judged on the filler's date, which
  the server accepts only within a day of its own.

## Found while building this

- **The engine dropped a malformed answer silently.** `validateSubmission` treated a
  number sent for a decimal as no answer, so an optional question's bad value vanished and
  the submission was judged valid. It is now refused as `invalid`. The golden corpus was
  unchanged and Hermes still reproduces it.
- **The renderer lost an answer when a widget answered and touched in one tick.** Events
  built on the state the render saw, so the second overwrote the first. Found by the
  signature test; events now build on the latest state.
- **A media link was fetched in a loop.** The hook depended on an object re-created every
  render.
- **The rank-monotone permissions test ended, as P03 said it would.** A viewer reads every
  submission; an engineer, who outranks a viewer, reads only their own.
- **Seeding the performance test takes about two minutes** — 20,000 submissions through
  the triggers. That is the integration job's cost; each real submit pays about 6 ms.
- **`next dev` writes `AGENTS.md` and `CLAUDE.md` into `apps/web`.** They were not
  committed; whether to commit or ignore them is a repository decision.
- **Downloads in the Tauri window go through the webview.** CSV export works in the
  browser; a native save dialog on desktop is a refinement for later.
