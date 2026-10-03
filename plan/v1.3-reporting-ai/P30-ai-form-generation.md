# P30 — AI form generation

**Version:** v1.3 Reporting, Comms and AI
**Status:** `NOT STARTED`
**Depends on:** P07

## Goal

An admin describes the form they need in a sentence and gets a working draft to edit.

## Scope

The clearest differentiator in the product, and cheap to build because the form schema
already exists as structured data.

## Tasks

- [ ] Generate a complete form definition from a natural-language prompt
- [ ] Output validated against the P06 zod schema before it ever reaches the builder
- [ ] Generated forms always land as an editable draft, never auto-published
- [ ] Trade-specific prompting primed with the company's existing forms and job types
- [ ] Field suggestions while building — propose the next field from what already exists
- [ ] Improve an existing form: suggest missing validation, unclear labels, absent conditional logic
- [ ] Cost controls: per-tenant quota, model choice, caching of similar prompts
- [ ] Graceful degradation when generation fails or returns something invalid
- [ ] Clear labelling that the draft was AI-generated and needs review

## Exit criteria

- [ ] "Quarterly HVAC inspection checklist" produces a usable draft an admin edits rather than discards
- [ ] A malformed generation never reaches the builder or the database
- [ ] Generation cost per form is measured and bounded per tenant

## Notes

- Consider pulling this forward if onboarding proves to be the churn point. It turns a
  two-hour setup task into two minutes, which is worth more during v1.0 than in v1.3.
- Never auto-publish. A generated form that goes straight to engineers is a liability.
