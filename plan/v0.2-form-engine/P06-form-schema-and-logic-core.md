# P06 — Form schema and logic core

**Version:** v0.2 Form Engine
**Status:** `IN PROGRESS`
**Depends on:** P04

## Goal

One `packages/form-engine` with zero UI that defines what a form _is_ and decides what is
visible, what is required, what is calculated and what is valid — identically on a phone,
on a desktop, and on the server.

## Scope

The most correctness-critical code in the product, and the phase with the highest test
coverage requirement.

## Tasks

- [x] Form definition schema (zod): form → pages → sections → fields, with stable field ids
- [x] Field type registry: text, long text, number, decimal with unit, date, time, datetime, dropdown, multi-select, radio, checkbox, yes/no, rating, signature, photo, file, GPS, barcode
- [x] Per-field configuration: label, help text, default, required, read-only, min/max, pattern, decimal places, unit
- [x] Conditional visibility rules using a safe expression evaluator (JSONLogic or a small typed AST) — **never `eval`**
- [x] Validation engine producing field-keyed, translatable error codes
- [x] Form state machine: answers, touched fields, computed visibility, derived validity, completion progress
- [x] Versioning model: `form` → `form_version` (immutable once published) → `submission` binding to `form_version_id`
- [x] Submission value schema, and a migration path for drafts held against a superseded version
- [x] Extensive unit tests: visibility cascades, circular-reference rejection, validation edge cases, version binding
- [x] Property-based tests over generated form definitions

## Exit criteria

- [ ] The same definition and the same answers produce byte-identical validation results in Node and in a React Native runtime
- [x] A published version is provably immutable: an attempt to mutate it is rejected at the database level, not only in application code
- [x] A circular visibility rule is rejected at publish time with a clear message naming the fields involved
- [x] Test coverage on this package exceeds 90 percent, and the number is enforced in CI

## Notes

- This package must never import React, a database client, or anything platform-specific.
  If it can only run in one place, the design is wrong.
- Immutability of `form_version` is the single most important invariant in the product.
  Enforce it with a database trigger or a revoked update grant, not a code convention.

---

## What remains

### Byte-identical in a React Native runtime — proven in Hermes, not yet in the app

The corpus in `packages/form-engine/src/conformance/` runs in Node and inside **Hermes**,
and Hermes reproduces Node's output byte for byte: 11 cases, 39,314 bytes. CI does this on
every pull request (`form-engine-hermes` in `ci.yml`), and a one-character change to the
golden file makes it fail and point at the difference.

That is a genuine second JavaScript engine — its own regular expressions, number printing,
BigInt and string library — and the code it runs has been lowered by the mobile app's own
Babel preset. It is **not** the engine inside the app. The newest prebuilt Hermes runner
Facebook publishes is the `v0.13.0` release (its binary reports `0.12.0`); React Native 0.86
ships Hermes V1, which is newer and can run syntax 0.12 cannot even parse.

So the criterion stays unticked. Either of these closes it:

- **P13**, which already has to run the engine on a phone: run this same corpus inside the
  app on a device or emulator and compare with `golden.jsonl`. The runner is plain
  `runConformance()` and needs no changes.
- **Build the Hermes V1 CLI from source** at the tag React Native pins
  (`hermes-v250829098.0.17`, from `react-native/sdks/.hermesv1version`) and point
  `HERMES_BIN` at it. Roughly fifteen minutes of CMake in CI, and cacheable.

### The database proof in CI

The immutability suite passes against PostgreSQL 17.10. It runs in CI inside the `database`
job on every pull request, against a Postgres 16 service container — see P02.

## Decisions taken during implementation

- **A typed syntax tree, not JSONLogic.** Every node has one meaning and a type the compiler
  checks before publish. JSONLogic coerces loosely (`"1" == 1`), which is a rule that
  evaluates one way on a phone and another in a reviewer's head, and P07's plain-language
  builder needs a closed set of node kinds to turn back into a sentence.

- **Unknown is a value (Kleene logic), and only definitely-true shows an element.** It is
  the only reading under which "show _Reason_ when _Result_ is not _Pass_" does not appear on
  a blank form. `answered` is the one way to test for blank, and it is never unknown.

- **Hidden means absent**, for rules, validation and submission alike — while the typed
  value stays in state, so switching back restores it.

- **One evaluation pass in a compiled order.** The compiler topologically sorts pages,
  sections and fields, so no runtime iterates to a fixpoint that might converge differently.

- **Decimals are exact text, with half-away-from-zero rounding.** `BigInt` units at a scale,
  written without `BigInt` literals or `**` so no bundler lowers them differently.

- **No `Date`, no `Intl`.** Dates, times and offsets are parsed by hand into integers;
  "today" is an input. Property tests compare the calendar arithmetic with `Date.UTC` over
  thousands of random dates, because the test is allowed a `Date` and the engine is not.
  All of this is a lint error in the package, not a convention.

- **Datetimes must carry an offset.** Otherwise one piece of text names different instants
  on the phone and the server.

- **Length counts code points, not visible characters.** Counting what a person sees needs
  `Intl.Segmenter`, absent from some Hermes builds, so a skin-toned emoji counts as two.
  Documented rather than hidden, because a length that differed between phone and server
  would be worse.

- **Patterns are a parsed subset with a cost budget.** A customer's regular expression can
  hang the shared API and can mean different things in V8 and Hermes. Nested repetition,
  lookaround, backreferences and lazy quantifiers are refused at publish, open-ended
  repetitions are budgeted, and a pattern never runs on more than 256 characters. A
  20,000-case fuzz checks the parser never accepts a pattern the regex engine rejects.

- **Custom rules cannot form cycles.** They change no values, so they are left out of the
  dependency graph; visibility, calculations and containment are in it.

- **Immutability is three independent controls.** A row trigger refusing `UPDATE` and
  `DELETE` of a published version for every role, a statement trigger refusing `TRUNCATE`,
  and no `DELETE` grant for the runtime role. Refusals use SQLSTATE `55000`, so they are
  never mistaken for a permission problem.

- **A submission binds only to a published version, and never moves.** A trigger refuses a
  draft; a composite foreign key refuses another company's version.

- **The database stores definitions; it does not judge them.** It cannot run TypeScript.
  The publishing service calls `prepareForPublish` first, and `schemaVersion` is kept in a
  column checked against the document.

- **`submissions` is deliberately minimal.** P06 needed the binding invariant; P08 adds
  drafts, reportable generated columns and amendment history to the same table.

- **The Hermes run uses the mobile app's own Babel preset**, resolved through
  `apps/mobile`'s `expo` dependency, so it follows the app if the preset changes.

## Found while building this

- **Two prototype bugs.** `constructor` is a legal field id and also a property of every
  object: `id in answers` skipped its default, and `answers[id]` made an unanswered field
  look answered during migration. Both now go through `ownAnswer`, with tests.
- **`TENANT_SCOPED_TABLES` now catches omissions at compile time.** Adding the three new
  tables to `Database` without registering them failed the build and named all three — the
  exact gap that had left seven P03 and P04 tables unguarded, fixed earlier the same day.
- **A local Postgres on Windows defaults to WIN1252.** The migration's box-drawing
  characters would not encode. Supabase is UTF-8, and a bilingual product needs UTF-8 for
  Arabic data regardless; the local test database was recreated as UTF-8 and the SQL
  comment made ASCII.

## Verified so far

| Claim                                            | How it was proven                                                                                                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The engine behaves as specified                  | 333 unit, property and conformance tests                                                                                                                                                 |
| Coverage exceeds 90 percent and is enforced      | 99.4% statements, 96.2% branches, 99.4% functions, 99.5% lines; raising the branch threshold to 99 makes `pnpm test` exit 1                                                              |
| Circular rules are refused, naming the fields    | Unit tests for self, two-field, calculation, mixed three-field, section and page cycles; two properties inject cycles into generated forms; disabling back-edge detection fails 10 tests |
| Generated forms exercise real behaviour          | Of 300 generated scenarios: hidden fields in 270, cascade-hidden in 227, calculated values in 76, invalid in 219, valid in 81                                                            |
| Node and Hermes agree byte for byte              | 11 cases, 39,314 bytes; a one-character change to the golden file fails with the case and column                                                                                         |
| The engine cannot reach a platform               | Lint rejects `Date`, `Intl`, `Math.random`, `localeCompare`, `node:*`, React and `@integr8/db` — each probed                                                                             |
| Published versions are immutable in the database | 24 integration tests on PostgreSQL 17.10, as owner and as runtime role; with the trigger removed from the migration, 14 fail                                                             |
| Submissions bind to published versions only      | A draft refused, rebinding refused even as owner, another company's version refused                                                                                                      |
| Nothing else regressed                           | db 135/135, auth 55/55, api 27/27 integration; i18n checks every engine error code has a message                                                                                         |
