# P07 — Form builder UI

**Version:** v0.2 Form Engine
**Status:** `NOT STARTED`
**Depends on:** P06

## Goal
A company admin builds a working form on the desktop app, with conditional logic, without
a developer and without reading documentation.

## Scope
Desktop and browser only. This is the reason the desktop app exists.

## Tasks
- [ ] Drag-and-drop canvas: add, reorder, duplicate and delete fields, sections and pages
- [ ] Field palette grouped by purpose, not by data type
- [ ] Field configuration panel driven by the type registry from P06
- [ ] Conditional visibility builder: "show this when that answer is…", in plain language, no expression syntax
- [ ] Validation rule builder with custom error messages
- [ ] Live preview in two viewports side by side — desktop and phone
- [ ] Test-fill mode writing to a sandbox that never touches real submissions
- [ ] Draft and published states, with a visible diff between the draft and the live version
- [ ] Publish flow: validate the whole definition, warn about breaking changes, create the immutable version
- [ ] Version history with a changelog and read-only view of any past version
- [ ] Clone a form; clone from the global template library
- [ ] Form settings: which roles may fill it, which job types require it, whether a signature is mandatory before a job can close
- [ ] Autosave of the draft, with recovery after a crash

## Exit criteria
- [ ] A non-developer builds a ten-field form with two conditional rules in under fifteen minutes, unaided, observed
- [ ] Editing and republishing a form leaves every existing submission byte-identical
- [ ] The phone preview matches what the mobile app actually renders in P13
- [ ] Publishing an invalid definition is impossible; the errors name the offending fields

## Notes
- The plain-language rule builder matters more than it looks. An expression box turns the
  builder back into a developer tool and destroys the product's premise.
- Watch the breaking-change warning carefully: removing a field that existing submissions
  answered is legal (old versions keep it) but the admin must understand what they lose in reporting.
