# Repeating groups

A form can ask the same questions once per thing found on site — every appliance, every
radiator, every defect — and an engineer adds, fills, reorders and removes those entries on
a phone or at a desk (P13b). A repeatable section is a section with `repeat`. Everything else
about it — rules, validation, versions, reporting, files, prefill and sync — follows from
one decision: the shape its answers are stored in.

---

## The answer shape

This is stored for the life of the product, like field ids.

```jsonc
{
  "address": "4 Mill Lane",
  "appliances": [
    {
      "id": "0192f3a4-7c1e-7d2a-9b4f-3e8a1c2d5f60",
      "values": { "make": "Worcester", "flue_ok": "yes" },
    },
    { "id": "0192f3a5-1a2b-7c3d-8e4f-5a6b7c8d9e0f", "values": { "make": "Baxi" } },
  ],
}
```

The shape, `{ id, values }`, was chosen before implementation.

- **The section's id is the key.** The fields of a repeatable section are never top-level
  answers, and a top-level key named like one is refused as `unknown_field`.
- **Each entry has an id of its own**, made by whoever adds the entry (a UUID in every
  client), matching `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. The engine never makes one up, so
  the same events give the same answers on every device. The id is how an entry is told
  apart from its neighbours when one is removed, moved, or edited on another device, and
  how a report tells entries apart.
- **`values` holds the entry's answers**, keyed by field id, each shaped exactly as that
  field's answer anywhere else. Keeping them under `values` means a field id can never
  collide with the entry's own keys, and leaves room for entry metadata later.
- **Order is the list's order**: the order the person put them in.
- **No entries is no answer.** The key is absent, like an empty selection.

## A repeatable section

```jsonc
{
  "id": "appliances",
  "title": { "en": "Appliances" },
  "repeat": {
    "minEntries": 1, // optional; fewer cannot be submitted
    "maxEntries": 10, // 1–100
    "entryLabel": { "en": "Appliance" }, // "Appliance 1", "Appliance 2"
    "titleField": "make", // optional: "Appliance 2 · Worcester"
  },
  "fields": [/* … */],
}
```

Sections do not nest, so neither do entries.

**Publishing refuses:**

| Code             | When                                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_repeat` | no questions to repeat, `minEntries` above `maxEntries`, or a `titleField` that is not a text, number, date or time question of the section |
| `inside_repeat`  | a rule reads a question asked per entry from outside that section's entries                                                                 |
| `not_repeatable` | `count`, `aggregate`, `some` or `every` names a section that does not repeat                                                                |
| `not_in_section` | `aggregate` names a field that is not one of that section's questions                                                                       |

## Rules inside and across entries

**Inside an entry**, a rule on a field of a repeatable section reads that entry's answers,
and anything outside the section. "Show _Flue safe_ when _Kind_ is _gas_" works per
appliance. It can also read another repeatable section, but only across its entries.

**Across entries**, four rule parts read a section's entries from anywhere, chosen before
implementation:

| Expression                                               | Gives                                               | With no entries, or the section hidden |
| -------------------------------------------------------- | --------------------------------------------------- | -------------------------------------- |
| `{ kind: 'count', section }`                             | how many entries there are; never unknown           | 0                                      |
| `{ kind: 'aggregate', operator: 'sum', section, field }` | the total of the known answers to a number question | 0                                      |
| `… operator: 'min' \| 'max'`                             | the least or greatest known answer                  | unknown                                |
| `{ kind: 'some', section, condition }`                   | whether the condition holds for at least one entry  | false                                  |
| `{ kind: 'every', section, condition }`                  | whether it holds for every entry                    | true                                   |

`some` and `every` are "any" and "all" over the entries, with the engine's three-valued
logic: `every` is unknown while an entry's answer is unknown and none is definitely false.
`condition` is evaluated inside each entry in turn. "Show _Remedial works_ when any
appliance failed":

```jsonc
{
  "kind": "some",
  "section": "appliances",
  "condition": {
    "kind": "compare",
    "operator": "eq",
    "left": { "kind": "answer", "field": "result" },
    "right": { "kind": "text", "value": "fail" },
  },
}
```

A condition like "Certify every appliance passed" is also shown when there are no
appliances; say "and there is at least one" with `count` if that matters.

**Hidden means absent**, as everywhere. A hidden repeatable section has no entries for
anything to read, and a question hidden in one entry has no answer in that entry.

**Order.** The dependency graph is over elements, not entries. A field of a repeatable
section is worked out once per entry at its place in the order; reading across entries
depends on the section and on each field read. One pass still suffices, and a calculation
that adds up itself (`sum` of its own field) is refused as circular.

## Filling

```ts
let state = createFormState(form, answers, { newEntryId: () => crypto.randomUUID() });
state = transition(form, state, { type: 'add_entry', section: 'appliances', entry: id }).state;
state = transition(form, state, {
  type: 'answer',
  field: 'make',
  value: 'Worcester',
  entry: id,
}).state;
state = transition(form, state, {
  type: 'move_entry',
  section: 'appliances',
  entry: id,
  index: 0,
}).state;
state = transition(form, state, { type: 'remove_entry', section: 'appliances', entry: id }).state;
```

- **`newEntryId`**: a section with `minEntries` and no answer opens with that many entries,
  each with the section's defaults.
- **Refusals:**
  - `entry_needed`: the field is asked per entry and no entry was given;
  - `unknown_entry`;
  - `invalid_entry_id`: a malformed or reused id;
  - `too_many_entries`: at `maxEntries`;
  - `not_repeatable`.
- **`touched`** keys an entry's field as `touchKey(field, entry)`. Removing an entry forgets
  what was touched in it.
- **`viewForm`** adds `entries`: each section's `EntryEvaluation { id, visible, values }`.
  A visible section with entries also has its effective entries in `values`, calculated
  answers included.
- **Progress** counts each entry's questions once per entry. A section still short of the
  entries it needs is one more thing to do.
- **`toSubmission`** sends each entry's visible typed answers, without calculated ones.

`@integr8/form-input` gives both renderers the same words:

- `entryTitle`: "Appliance 2", and the title answer;
- `canAddEntry`;
- `removingLeavesTooFew`;
- `entryErrors` and `sectionErrors`;
- `firstPerField`: one problem per question per entry.

## Validation

`validateForm` checks a repeatable section where it sits:

1. `too_few_entries` / `too_many_entries` on the section, with `minimum` / `maximum`;
2. then each entry's questions in turn.

Each error carries `entry`, the entry's id.

`validateSubmission` also refuses:

- a key inside an entry that is not one of the section's questions (`unknown_field`);
- an answer to a question hidden in that entry (`answer_to_hidden_field`);
- a calculated one (`answer_to_calculated_field`).

These issues carry `entry` and `section`. A list that is not `{ id, values }` entries is
`invalid` on the section, and two entries with one id are `duplicate_entry`.

The API names each problem's place in the body, e.g.
`body.answers.appliances[0192f3a4-…].make`. Files named inside entries are checked against
the ledger like any other.

## Versions

- **`migrateAnswers`** moves each entry by id, field by field, with the usual rules. What
  each entry lost is reported with its `entry`.
- **`entries_changed`**: the reason a field is dropped when it moved into or out of a
  repeatable section, or its section started or stopped repeating. One answer and a list of
  entries do not map onto each other.
- **`nowInvalid`** includes a section holding more entries than it now allows.
- **Breaking changes.** `diffDefinitions` calls moving a question into or out of a
  repeatable section breaking (`entries_changed`, affecting reporting). Raising
  `minEntries` or lowering `maxEntries` is `constraint_tightened` on the section, with
  `detail` naming which.

## Reporting

`reportableFields` marks each field of a repeatable section with it:

```jsonc
{ "field": "make", "type": "text", "multiple": false, "section": "appliances" }
```

Other fields have no `section` key, so versions published before P13b read the same.
Migration 0014 reports each entry's answers in rows of their own:

- `submission_values.entry_id`: the entry's id; null for answers outside entries;
- `submission_values.entry_index`: its position when submitted, from 0; 0 outside entries;
- the primary key becomes `(tenant_id, submission_id, field_id, entry_index, ordinal)`;
- a check refuses an entry row without its entry.

A filter on a question asked per entry — `filter=make:eq:Worcester` — finds a submission
whichever entry answered it. Full-text search already reads every string in the answers.

**The CSV export** keeps one row per submission, as chosen before implementation. A
repeatable section's questions get numbered columns, one set per entry, up to the most
entries any exported submission has:

```
…,appliances[1].make,appliances[1].flue_ok,appliances[2].make,appliances[2].flue_ok,…
```

Brackets cannot appear in a field id, so these headers never collide with a real question.

## Files, prefill and sync

- **Files.**
  - `mediaReferences` finds files inside entries, with their `entry`.
  - The phone's upload waiting (`mediaIdsIn`) already looked inside any value, so a submit
    waits for a photo in an entry like any other.
- **Prefill** from the same form at the same site carries entries: every appliance with its
  make and model, keeping their ids.
  - Evidence and calculated or read-only answers stay behind, per entry.
  - An entry left with nothing is not carried.
- **Sync.** Answers changed on two devices are merged key by key as before (P12), except a
  repeatable section, which is merged entry by entry and answer by answer (`mergeAnswers`).
  - Two phones adding different appliances, or changing different appliances, both keep
    their work.
  - It is a conflict only when one entry's answer changed both ways, or an entry removed on
    one side was changed on the other. The conflict is raised on the section's key, and the
    engineer chooses the whole list.
  - An order changed only on one side wins; entries added on the phone keep their place.

## On a screen

- **Phone** (`apps/mobile/src/forms/entries.tsx`):
  - A repeatable section is a list of its entries: "Radiator 2 · Hall", with a badge when
    one needs attention, and **Add Radiator** while more are allowed.
  - Adding an entry, or tapping one, opens it on its own. Only its questions show, with
    **Previous**, **Next**, **Move up**, **Move down** and **Remove**. Removing an entry
    with answers asks first.
  - A problem in the review opens its entry and scrolls to the question.
  - The open entry is part of the route, so a force-closed app reopens on it (P14).
- **Web and desktop** (`packages/form-renderer-dom/src/entries.tsx`):
  - Each entry is a titled group with **Add**, **Remove** and move up and down. Removing an
    entry with answers asks first, and removing is unavailable below the minimum.
  - A live region announces every addition, move and removal. Focus goes to a new entry's
    first question, or to whichever entry took a removed one's place.
  - The problem list reads "Go to “Make” in Appliance 2". A refusal from the server, whose
    detail paths name the entry, goes there too.
  - A submission shows each entry under its title, and a correction says what was removed.
- **The builder** (`apps/desktop/src/features/forms`):
  - "Add a repeatable section" on the canvas, and "Repeats · up to 20" on the section.
  - The section panel has a **Repeat this section** toggle, what one entry is called, the
    fewest and most entries, and the question that names each entry (a short answer,
    number, date, time or single choice).
  - A condition on a question asked per entry, set from outside its section, says "in any
    entry" or "in every entry". "Number of Appliances" can be compared with a whole number.
  - Calculations can total, take the smallest or largest across a section, or count its
    entries.
  - Publish-time problems and breaking changes are worded for an admin. The preview fills
    entries with the web renderer's own list.

## Tests

- **Conformance.** The corpus has four entry cases, reproduced byte for byte in Hermes:
  - appliances filled one by one, with rules inside and across entries, every refusal, and
    what the server refuses;
  - entries that are not entries;
  - every publish-time error;
  - migrating entries.
- **Unit and property tests** (`packages/form-engine`):
  - `entries.test.ts` covers one behaviour at a time.
  - `entries.properties.test.ts` generates forms with repeatable sections and rules across
    them, and adds, removes and reorders entries at random. It checks the phone and the
    server agree on every error, storage order does not matter, hidden entries give nothing,
    and limits hold.
- `packages/form-input`: entry titles in another language's digits, one problem per
  question per entry, and prefilling entries.
- `packages/db/src/testing/repeating-groups.integration.test.ts`: rows per entry, filters
  and search inside entries, and the entry check.
- `apps/api`:
  - revalidation with each problem's path;
  - files inside entries;
  - the stored total;
  - the entry-by-entry merge (`merge.test.ts`);
  - in the sync suite, the same form with a repeatable section filled on the phone and on
    the desktop, storing identical answers, with the filter and the numbered export.
- `apps/mobile/src/forms/fill-model.test.ts`: a radiator survey on the phone's real
  database. It opens with the entry it needs, adds and opens a second, reorders and totals,
  and the review opens the entry with the problem. It survives a kill, and the submit waits
  for a photo inside an entry.
