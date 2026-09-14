# P07 — Form builder UI

**Version:** v0.2 Form Engine
**Status:** `IN PROGRESS`
**Depends on:** P06

## Goal

A company admin builds a working form on the desktop app, with conditional logic, without
a developer and without reading documentation.

## Scope

Desktop and browser only. This is the reason the desktop app exists.

## Tasks

- [x] Drag-and-drop canvas: add, reorder, duplicate and delete fields, sections and pages
- [x] Field palette grouped by purpose, not by data type
- [x] Field configuration panel driven by the type registry from P06
- [x] Conditional visibility builder: "show this when that answer is…", in plain language, no expression syntax
- [x] Validation rule builder with custom error messages
- [x] Live preview in two viewports side by side — desktop and phone
- [x] Test-fill mode writing to a sandbox that never touches real submissions
- [x] Draft and published states, with a visible diff between the draft and the live version
- [x] Publish flow: validate the whole definition, warn about breaking changes, create the immutable version
- [x] Version history with a changelog and read-only view of any past version
- [x] Clone a form; clone from the global template library
- [x] Form settings: which roles may fill it, and whether a signature is mandatory before a job can close
- [x] Autosave of the draft, with recovery after a crash

The setting for **which job types require a form** moved to P10, where job types are
created: there is nothing to choose from until then. The settings screen shows it disabled
with that reason, and P10's task list carries it.

## Exit criteria

- [ ] A non-developer builds a ten-field form with two conditional rules in under fifteen minutes, unaided, observed
- [x] Editing and republishing a form leaves every existing submission byte-identical
- [ ] The phone preview matches what the mobile app actually renders in P13
- [x] Publishing an invalid definition is impossible; the errors name the offending fields

## Notes

- The plain-language rule builder matters more than it looks. An expression box turns the
  builder back into a developer tool and destroys the product's premise.
- Watch the breaking-change warning carefully: removing a field that existing submissions
  answered is legal (old versions keep it) but the admin must understand what they lose in reporting.

---

## What remains

### The observed usability test

The first exit criterion needs a person who is not a developer, a stopwatch and somebody
watching. It cannot be claimed from code. Everything it depends on is built and walked
through end to end in a browser (below); what is missing is the observation itself, and
whatever it turns up.

### The phone preview against P13

The phone viewport renders the engine's `viewForm` in a single column, one page at a
time — the same derived view the mobile renderer will use. Whether it _matches_ what P13
renders can only be checked once P13 exists. P13 should keep the page-at-a-time flow, the
required marker, help under the label and errors under the control, or change this
preview in the same commit.

### CORS on the API

The API sends no CORS headers. The desktop app in a browser tab (`localhost:3002`) cannot
call the API (`localhost:3000`), and the Tauri webview's origin is not the API's either.
This predates P07 — P05's shells have the same problem — and the browser walkthrough below
used a local-only server that added the headers. It needs an allow-list per environment
(desktop dev server, `tauri://localhost`, the web app) in `apps/api` before anybody tries
the builder against a deployed API. Not fixed here because the right origins are a
deployment decision.

### Engine messages for schema-level problems

A property outside the schema's limits — a unit over 20 characters, say — is reported with
zod's own text ("Too big: expected string to have <=20 characters"). The builder's inputs
now enforce the limits it knows about, so an admin should not meet one, but
`compileDefinition`'s `invalid_structure` messages are developer English and belong in
P06's message catalogue before P30 lets AI generation produce definitions.

## Decisions taken during implementation

- **The draft is a row, not a copy in the browser.** `form_versions` holds at most one
  draft per form, with a `revision` counter; autosave is `PUT` on the revision last seen,
  and publish turns that same row into the version. A save race between two tabs is
  settled by a unique index and a savepoint, not by timestamps.
- **The check and the publish ask the server.** The builder compiles locally for instant
  feedback, but "Changes" and the publish dialog show the server's verdict on the saved
  draft, so what the admin reviews is what `publish` decides.
- **Settings are not versioned.** Who may fill a form and whether a signature is required
  change how the company uses the form, not what it asks, and take effect immediately.
- **Templates are a platform table, copied not referenced.** A company that starts from a
  template gets its own form with `source_template_key` recorded; changing the library
  never changes a company's form.
- **Answer keys follow the wording until something depends on them.** Otherwise every
  export would be headed `pick_one`, `short_answer_2`. Once a key is in a published version
  or read by a rule it is fixed, and a key an earlier version used is never reused.
- **Rules the builder cannot phrase are read-only.** An expression with no sentence form is
  shown as "written outside the builder" with a remove button — or, if it reads a deleted
  question, as broken — rather than approximated.
- **A test fill sends what a real client would.** The preview uses `toSubmission`, so an
  answer to a question that has since been hidden is dropped exactly as the phone will drop
  it, and the server's `answer_to_hidden_field` check stays meaningful.

## Found while building this

- **`invalidateQueries(['forms'])` refetched the open builder.** React Query matches keys
  by prefix, so publishing (which invalidates the list) also refetched the form, remounted
  the builder and lost the confirmation and the undo history. List invalidation is now
  `exact`.
- **"Show" opened nothing for a rule reading a deleted question.** The issue's first element
  was the deleted question. The builder now opens the element the issue's path points at —
  the question whose rule is broken — and names it: "In “Describe the fault”".
- **Playwright's one-step `dragTo` mis-reports dnd-kit drops.** A real pointer path (twenty
  intermediate moves) inserts before the hovered question as designed; a single jump lands
  one place later. Worth knowing before P08 writes browser tests for the canvas.
- **A new question could have reused an earlier version's key.** Keys were generated
  against the current definition only; a question removed in version 2 could have its key
  handed to an unrelated question in version 3, merging two meanings in every report.
  Generation now also avoids every key a published version removed.

## Verified so far

| Claim                                                         | How it was proven                                                                                                                                                                                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Republishing leaves existing submissions byte-identical       | API integration test: a submission's row read as raw JSON text before and after a breaking republish, compared as strings; the version row too                                                                                |
| An invalid definition cannot be published, and errors name it | API integration test: 422 `invalid_definition` with `definition.pages[0].sections[0].fields[2]` and the message; the form has no live version afterwards                                                                      |
| Breaking changes must be acknowledged                         | API integration test (409, then 200 with acknowledgement); in the browser, Publish stayed disabled until the box was ticked                                                                                                   |
| Autosave refuses a stale revision                             | API and database integration tests; in the browser, a second tab's edit showed the conflict banner and "Load their version" brought in the first tab's save                                                                   |
| Test fill stores nothing                                      | API integration test counts submissions before and after; in the browser, the server accepted a valid fill and refused an empty one naming "Appliance safe to use?"                                                           |
| Engineers see published forms only, read-only                 | API integration tests (list, detail, draft version 404, six builder routes 403); in the browser, no palette, handles, Publish, or editable inputs                                                                             |
| The panel cannot fall behind the registry                     | Desktop test fails if any property of any field type has no editor; i18n test fails if it has no label, or a type, purpose or comparison has no words                                                                         |
| Crash recovery works                                          | In the browser: saves blocked, edit made, tab closed without unload handling; reopening offered the change, restoring saved it and cleared the local copy                                                                     |
| Conditions, preview and publish work end to end               | Browser walkthrough against the API and PostgreSQL 17.10: built a form with a conditional question, previewed both viewports, published versions 1 and 2, viewed history and version 1 read-only, saved settings, checked RTL |
| Nothing else regressed                                        | Lint, typecheck, build and unit tests across the workspace; API integration 47/47; db integration 154/154; form-engine 433 tests at 99.27% statements                                                                         |
