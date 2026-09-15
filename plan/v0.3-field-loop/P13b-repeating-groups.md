# P13b — Repeating groups

**Version:** v0.3 Field Loop
**Status:** `NOT STARTED`
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

- [ ] A repeatable section in the definition schema: minimum and maximum entries, a title per entry
- [ ] Answer shape: an array of entries under the section's id, each keyed by field id, with a stable entry id
- [ ] Engine: visibility, calculation, validation and progress per entry; rules that read inside and across entries; `toSubmission` and `validateSubmission`
- [ ] Publish-time checks and breaking-change detection for repeatable sections; `migrateAnswers` for entries
- [ ] Conformance cases, and property tests generating repeatable sections
- [ ] Builder: add a repeatable section, set its limits, preview it
- [ ] Web renderer: add, remove and reorder entries accessibly
- [ ] Mobile renderer: one entry at a time with a list of entries, sized for a small screen
- [ ] Reporting: typed values per entry in `submission_values`, and a CSV export shape for entries
- [ ] Media, prefill and sync with answers inside entries

## Exit criteria

- [ ] A form with a repeatable section built in the builder fills on the web and on a phone
- [ ] A submission with several entries is revalidated by the server and reported per entry
- [ ] Filling the same entries on the phone and the desktop stores identical answers

## Notes

- Decide the answer shape before anything else: it is stored for the life of the product, like
  field ids.
