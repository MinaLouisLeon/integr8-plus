# P13b — Repeating groups

**Version:** v0.3 Field Loop
**Status:** `IN PROGRESS — built and verified off-device; awaiting the phone checklist`
**Depends on:** P13

## Goal

A form can ask the same questions once per thing found on site — every appliance, every
radiator, every defect — and an engineer can add, fill and remove those entries comfortably on
a phone.

## Scope

Split from P13, whose task list included "repeating group entry that is usable on a small
screen": the form engine has no repeating element, so there was nothing to render. This phase
adds one end to end.

## Tasks

- [x] A repeatable section in the definition schema: minimum and maximum entries, a title per entry
- [x] Answer shape: an array of entries under the section's id, each keyed by field id, with a stable entry id
- [x] Engine: visibility, calculation, validation and progress per entry; rules that read inside and across entries; `toSubmission` and `validateSubmission`
- [x] Publish-time checks and breaking-change detection for repeatable sections; `migrateAnswers` for entries
- [x] Conformance cases, and property tests generating repeatable sections
- [x] Builder: add a repeatable section, set its limits, preview it
- [x] Web renderer: add, remove and reorder entries accessibly
- [x] Mobile renderer: one entry at a time with a list of entries, sized for a small screen
- [x] Reporting: typed values per entry in `submission_values`, and a CSV export shape for entries
- [x] Media, prefill and sync with answers inside entries

## Exit criteria

- [ ] A form with a repeatable section built in the builder fills on the web and on a phone
- [x] A submission with several entries is revalidated by the server and reported per entry
- [x] Filling the same entries on the phone and the desktop stores identical answers

## Notes

- Decide the answer shape before anything else: it is stored for the life of the product, like
  field ids.

## Progress

Every task is built. Three choices were made before implementation:

- **The answer shape:** `[{ id, values }]` under the section's id.
- **Rules across entries:** count, sum/min/max, and any/every.
- **CSV:** numbered columns, one row per submission.

What is proven so far:

- **Ticked:** two exit criteria are proven against the real API and database.
- **Not ticked:** "built in the builder, fills on the web and on a phone" is proven in parts:
  - the engine accepts the builder's definitions;
  - the web renderer and the preview are tested in jsdom and server-rendered markup;
  - the phone is tested through its fill model on its real database.

  It closes when [P13b on a phone](../../docs/mobile/device-checklist.md#p13b) has been run.

The design is in [repeating groups](../../docs/form-engine/repeating-groups.md).

| Claim                                                                                 | How it was proven so far                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Still needs                                                                                                  |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| A form with a repeatable section built in the builder fills on the web and on a phone | **Builder model tests:** repeat on and off, limits, the title question, quantified and count conditions round-trip, aggregate calculations, and wording for every new issue and breaking change. **Web renderer tests:** add, answer inside an entry, remove with confirmation, reorder, per-entry errors, minimum entries on open, the submission view, axe clean. **Phone `fill-model.test.ts`:** a radiator survey on the phone's database opens with the entry it needs, adds and opens entries, reorders and totals, and the review opens the entry with the problem. It survives a kill, and the submit waits for a photo inside an entry. `expo export` bundles | Checklist 1 and 2 on a phone, and the builder with a person clicking (the desktop app has no DOM test setup) |
| A submission with several entries is revalidated by the server and reported per entry | **API:** each problem is named at `body.answers.radiators[r1].watts`: unknown keys, duplicate entries, limits, malformed answers, files inside entries; the stored total is the server's. **db `repeating-groups.integration.test.ts`:** one `submission_values` row per entry answer, naming entry and position; filters and search find answers in any entry; an entry row without its entry is refused. Migration 0014 is rolled down and up in every run                                                                                                                                                                                                           | —                                                                                                            |
| Filling the same entries on the phone and the desktop stores identical answers        | **API sync suite (P13 test, extended):** a repeatable section with a photo inside an entry and a total across entries is filled through the phone's outbox and through REST. The stored answers are equal apart from file ids, a filter on a room finds both, and the export numbers each radiator's columns. **A second sync test:** two devices each add a defect and change different defects offline, and both keep their work with no conflict                                                                                                                                                                                                                    | Checklist 3                                                                                                  |
| The engine decides the same thing everywhere                                          | **Conformance:** four new cases, byte for byte in Node and Hermes 0.12, and the golden lines written before P13b unchanged. **Properties:** generated forms with repeatable sections and rules across them, entries added, removed and reordered at random; the phone and the server agree on every error, key order is irrelevant, hidden entries give nothing, limits hold. Mutating an entry's scope fails the golden file                                                                                                                                                                                                                                          | —                                                                                                            |
| Nothing else regressed                                                                | Workspace lint, typecheck, unit tests and build (61 tasks). **Integration:** db 243; API 127 (one R2 suite skipped, awaiting credentials). **Unit:** form-engine 461, form-input 19, form-renderer-dom 50, desktop 53, mobile 16, API 108, offline 47, i18n 36                                                                                                                                                                                                                                                                                                                                                                                                         | —                                                                                                            |

## Decisions taken during implementation

- **A rule inside an entry reads its own entry first, then the rest of the form.** Reading
  another repeatable section needs a quantifier, even from inside an entry. The compiler
  refuses a direct read from outside as `inside_repeat`, so there is never a guess at which
  entry was meant.
- **Across no entries:**
  - `count` is 0 and never unknown;
  - `sum` is 0, and adds only the answers that are known;
  - `min` and `max` are unknown;
  - `every` is true and `some` is false.

  This is "all" and "any" as the engine already had them. A condition like "every appliance
  passed" is therefore true with no appliances, and the doc says to add a count.

- **Entry ids are the client's.** The engine takes an id with each `add_entry` and never
  makes one, so the same events give the same state on every device.
- **No entries is no answer.** Removing the last entry deletes the key, as clearing a
  selection does.
- **The dependency graph stays over elements.** An entry's field is worked out for every
  entry at the field's place in the order, so evaluation is still one pass.
- **Reporting adds `entry_id` and `entry_index` to `submission_values`**, rather than a new
  table. Filters, indexes and the repository query are unchanged, and a filter on a question
  asked per entry matches any entry.
- **Sync merges a section entry by entry.** Two engineers adding different appliances
  offline is normal, and is not a conflict. When it is one, it is raised on the section, so
  the phone's existing answer-conflict screen works unchanged.
- **One entry at a time on the phone**, with a list to choose from. On the web every entry
  is on the page, with keyboard reordering.
- **The title question can be a single choice**, shown by the option's words. A date or
  date-time is formatted for the language; yes/no and multi-select cannot name an entry.

## Deploying

- Migration `0014_repeating_groups`.
- A new app build is not needed: the phone's changes are JavaScript. It is published with
  the next over-the-air update (P14).

## Found while building this

- **The server check could not say where in the answers a problem was.** Error paths were
  `body.answers.<field>`. They now name the entry, and the web renderer follows them to the
  field.
- **Answers arriving from two devices were merged per top-level question.** A repeatable
  section would have been one question, so any two edits to it would have conflicted.
- **The desktop app has no DOM test setup.** Its UI tests render markup on the server, and
  the effect of each control is covered by model tests. Adding jsdom and Testing Library to
  apps/desktop would allow interaction tests.
- **A long-standing heading gap in the web renderer.** A form with one untitled page jumps
  from the form title (h2) to a section heading (h4), which the accessibility check flags.
  The new renderer test gives its page a title. The gap itself is still to fix.
