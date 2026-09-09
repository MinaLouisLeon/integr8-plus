# P06 — Form schema and logic core

**Version:** v0.2 Form Engine
**Status:** `NOT STARTED`
**Depends on:** P04

## Goal
One `packages/form-engine` with zero UI that defines what a form *is* and decides what is
visible, what is required, what is calculated and what is valid — identically on a phone,
on a desktop, and on the server.

## Scope
The most correctness-critical code in the product, and the phase with the highest test
coverage requirement.

## Tasks
- [ ] Form definition schema (zod): form → pages → sections → fields, with stable field ids
- [ ] Field type registry: text, long text, number, decimal with unit, date, time, datetime, dropdown, multi-select, radio, checkbox, yes/no, rating, signature, photo, file, GPS, barcode
- [ ] Per-field configuration: label, help text, default, required, read-only, min/max, pattern, decimal places, unit
- [ ] Conditional visibility rules using a safe expression evaluator (JSONLogic or a small typed AST) — **never `eval`**
- [ ] Validation engine producing field-keyed, translatable error codes
- [ ] Form state machine: answers, touched fields, computed visibility, derived validity, completion progress
- [ ] Versioning model: `form` → `form_version` (immutable once published) → `submission` binding to `form_version_id`
- [ ] Submission value schema, and a migration path for drafts held against a superseded version
- [ ] Extensive unit tests: visibility cascades, circular-reference rejection, validation edge cases, version binding
- [ ] Property-based tests over generated form definitions

## Exit criteria
- [ ] The same definition and the same answers produce byte-identical validation results in Node and in a React Native runtime
- [ ] A published version is provably immutable: an attempt to mutate it is rejected at the database level, not only in application code
- [ ] A circular visibility rule is rejected at publish time with a clear message naming the fields involved
- [ ] Test coverage on this package exceeds 90 percent, and the number is enforced in CI

## Notes
- This package must never import React, a database client, or anything platform-specific.
  If it can only run in one place, the design is wrong.
- Immutability of `form_version` is the single most important invariant in the product.
  Enforce it with a database trigger or a revoked update grant, not a code convention.
