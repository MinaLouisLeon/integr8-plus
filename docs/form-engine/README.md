# The form engine

`@integr8/form-engine` defines what a form _is_ and decides, for any set of answers,
what is visible, what is required, what is calculated and what is valid. It has no UI,
does no I/O and imports nothing platform-specific, so the phone, the desktop app and the
server run **the same function** over **the same compiled form** and get **the same bytes**.

```
compileDefinition(json)  ──▶  CompiledForm  ──▶  createFormState / transition / viewForm
        │                          │
   publish-time checks        validateSubmission  (on the server, for truth)
```

| Where it runs       | What it uses it for                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| P07 builder         | `compileDefinition` to refuse an invalid publish, naming the fields; the authoring layer — see [the builder](builder.md) |
| P08 web, P13 mobile | `createFormState`, `transition`, `viewForm`, `toSubmission`                                                              |
| API (P08)           | `validateSubmission` — the client validates for speed, the server for truth                                              |
| Drafts (P12)        | `migrateAnswers` when a newer version is published under a draft                                                         |

---

## A definition

Pages of sections of fields, stored verbatim in `form_versions.definition`.

```jsonc
{
  "schemaVersion": 1,
  "title": { "en": "Boiler service", "ar": "صيانة الغلاية" },
  "pages": [
    {
      "id": "inspection",
      "sections": [
        {
          "id": "outcome",
          "fields": [
            {
              "id": "result",
              "type": "radio",
              "label": { "en": "Result" },
              "required": true,
              "options": [
                { "value": "pass", "label": { "en": "Pass" } },
                { "value": "fail", "label": { "en": "Fail" } },
              ],
            },
            {
              "id": "reason",
              "type": "long_text",
              "label": { "en": "Reason" },
              "required": true,
              "visibleWhen": {
                "kind": "compare",
                "operator": "eq",
                "left": { "kind": "answer", "field": "result" },
                "right": { "kind": "text", "value": "fail" },
              },
            },
          ],
        },
      ],
    },
  ],
}
```

- **Ids are stable.** An answer is stored under its field's id for the life of the
  product. Renaming a label changes nothing else. Pages, sections and fields share one
  namespace: `^[a-z][a-z0-9_]{0,63}$`, which is a valid JSON key, Postgres column name and
  CSV header at once.
- **Strict.** An unknown property is refused, not ignored.
- **Bounded.** 50 pages, 1,000 fields, rules of at most 500 nodes and 32 levels. A
  definition is customer input evaluated on a cheap phone and a shared server.

## Field types

| Type                | Answer                                                    | In a rule  | Configuration                                                   |
| ------------------- | --------------------------------------------------------- | ---------- | --------------------------------------------------------------- |
| `text`              | string                                                    | text       | `minLength`, `maxLength`, `pattern`, `default`                  |
| `long_text`         | string                                                    | text       | `minLength`, `maxLength`, `default`                             |
| `barcode`           | string                                                    | text       | `maxLength`                                                     |
| `number`            | safe integer                                              | number     | `min`, `max`, `unit`, `default`, `calculation`                  |
| `decimal`           | decimal **text**, e.g. `"12.50"`                          | number     | `decimalPlaces`, `min`, `max`, `unit`, `default`, `calculation` |
| `rating`            | integer 1…`scale`                                         | number     | `scale` (3–10)                                                  |
| `date`              | `YYYY-MM-DD`                                              | date       | `earliest`, `latest`, `default`                                 |
| `time`              | `HH:MM`                                                   | time       | `earliest`, `latest`, `default`                                 |
| `datetime`          | `YYYY-MM-DDTHH:MM[:SS]` **with offset**                   | datetime   | `earliest`, `latest`, `default`                                 |
| `dropdown`, `radio` | option value                                              | text       | `options`, `default`                                            |
| `multi_select`      | option values                                             | `includes` | `options`, `minSelected`, `maxSelected`, `default`              |
| `checkbox`          | boolean                                                   | boolean    | `default`. `required` means **ticked**.                         |
| `yes_no`            | `yes` · `no` · `not_applicable`                           | text       | `allowNotApplicable`, `default`                                 |
| `signature`         | media reference                                           | `answered` |                                                                 |
| `photo`, `file`     | media references                                          | `answered` | `minFiles`, `maxFiles`, `maxFileBytes`, `acceptedTypes` (file)  |
| `gps`               | `{ latitude, longitude, accuracyMeters }` as decimal text | `answered` | `maxAccuracyMeters`                                             |

Every field also takes `label`, `help`, `required`, `readOnly`, `visibleWhen` and
`rules` (custom rules with the admin's own message).

Three choices that look fussy and are not:

- **Decimals are text.** `0.1 + 0.2` is `0.30000000000000004` in JavaScript. Decimal
  arithmetic is exact (`BigInt` units at a scale) and rounds **half away from zero**,
  which is what a person with a calculator expects.
- **Datetimes must carry an offset.** `14:05` is a different instant on the phone in
  Cairo and the server in Frankfurt.
- **Length is counted in Unicode code points**, not the UTF-16 units JavaScript stores, so
  most emoji count once rather than twice. It is not quite "characters a person sees":
  👍🏽 is a thumb and a skin tone, two code points, and a letter with a separate combining
  mark counts twice. Counting visible characters exactly needs `Intl.Segmenter`, which
  some Hermes builds do not have — and a length that differed between the phone and the
  server would be worse than one that is slightly generous about what a character is.

## Rules

A rule is a typed syntax tree, never a string of code. Nothing in this package calls
`eval` or `new Function`, and the lint config makes that an error.

| Kind                                               | Produces                                          |
| -------------------------------------------------- | ------------------------------------------------- |
| `text` `number` `boolean` `date` `time` `datetime` | a literal                                         |
| `answer` `field`                                   | that field's value, or **unknown**                |
| `today`                                            | the date the caller supplied — never a clock read |
| `answered` `field`                                 | true or false, never unknown                      |
| `includes` `field` `option`                        | multi-select membership                           |
| `not` · `all` · `any`                              | logic                                             |
| `compare` `eq ne lt le gt ge`                      | boolean                                           |
| `arithmetic` `add subtract multiply divide`        | number                                            |

### Unknown is a value

A rule reading an unanswered field gets **unknown**, and unknown propagates (Kleene
logic): `unknown and false` is false, `unknown or true` is true, everything else with an
unknown in it is unknown.

**An element is shown only when its condition is definitely true.** That is the only
reading under which "show _Reason_ when _Result_ is not _Pass_" does not appear the
moment a blank form opens. To act on a blank answer, say so with `answered`.

### Hidden means absent

The answer to a hidden field does not exist for any other rule, for validation or for
submission — even if the person typed it before the field disappeared. Change _Fail_ to
_Pass_ and everything that depended on _Reason_ reacts as if it were never filled. The
typed value stays in state, so switching back restores it; it is never sent.

### Checked at publish

`compileDefinition` refuses, with the path and the ids involved:

- a structure that does not match the schema, or an unknown property
- a duplicate id
- a rule on a field that does not exist, or on a section as if it were a field
- a type mismatch (`number` compared with `text`, ordering a yes/no, arithmetic on dates)
- an option that does not exist — `"result" has no option "fial"`
- a literal that does not parse
- a field configuration at odds with itself, including a default its own rules reject
- a pattern outside the safe subset (below)
- **a circular dependency**, through visibility, calculations or containment:

```
Circular rule: section "failure" is shown depending on field "reason", and field
"reason" is inside section "failure". None of these can be worked out until another one is.
```

Custom validation rules may read each other freely: they change no values, so they
cannot take part in a cycle.

## Patterns

A regular expression written by a customer can hang the server that revalidates every
submission, and can mean different things in V8 and Hermes. So patterns are parsed
against a small grammar before a form can be published:

- literals, `.`, `^`, `$`, `\d \D \w \W \s \S`, escaped punctuation
- character classes with ranges and negation, groups, `(?:…)`, `|`
- greedy `? * + {n} {n,} {n,m}`, with repetitions capped at 100

Refused: backreferences, lookaround, named groups, `\b`, `\u`, `\p`, lazy quantifiers, and
**any repeated group that itself contains a repetition or an alternative** — the shape
behind almost every catastrophic backtracking pattern. What survives also has a cost
budget (two open-ended repetitions, not three), and a pattern is never run against a value
longer than 256 characters. Matching is whole-value.

## Filling a form

```ts
let state = createFormState(form, draftAnswers); // defaults fill gaps, never overwrite
const step = transition(form, state, { type: 'answer', field: 'result', value: 'fail' }, context);
if (!step.accepted) explain(step.reason); // 'read_only', 'calculated', 'wrong_shape', …
state = step.state;
const view = viewForm(form, state, { today: '2026-09-13' });
```

State holds only what the person did — answers, touched fields, whether a submit was
tried. Visibility, calculated values, errors and progress are **derived** every time, so
nothing derived can go stale. `shownErrors` holds errors on fields the person has left, or
all of them once a submit has been attempted.

Errors are **codes** with string parameters. The words live in `@integr8/i18n` under
`form.errors`, and a test there fails if the engine gains a code with no message.

## Versions and immutability

```
forms ──< form_versions (draft → published, then immutable) ──< submissions
```

Migration `0006` makes a published version immutable **in the database**, three ways,
each sufficient alone:

1. A row trigger refuses `UPDATE` and `DELETE` of a published version — for every role,
   the schema owner included — with SQLSTATE `55000`.
2. A statement trigger refuses `TRUNCATE`, which row triggers cannot see.
3. The runtime role holds no `DELETE` on `forms` or `form_versions` at all.

Editing a form means a new draft and a new publish. One draft per form at a time; version
numbers are assigned at publish, 1 upwards. A submission binds to a **published** version
at insert — a trigger refuses a draft — and can never be moved to another version.

`src/testing/form-versions.integration.test.ts` proves this with raw SQL as the owner and
as the runtime role. With the trigger removed from the migration, 14 of its tests fail.

The database does not judge whether a definition is valid; it cannot run TypeScript. The
publishing service calls `prepareForPublish` first.

### Drafts against a superseded version

`migrateAnswers(from, to, answers)` carries what still fits and says what did not:
`field_removed`, `type_changed`, `now_calculated`, `option_removed`; multi-selects keep
their surviving options (`trimmed`); values the new rules reject are kept and flagged
(`nowInvalid`) rather than silently blanked.

## Proving it behaves the same everywhere

### The determinism rules, as lint

The package's ESLint config refuses `Date`, `Intl`, `Math.random`, `localeCompare`,
`toLocale*`, `toFixed`, `eval`, `new Function`, `process`, Node built-ins, React, React
Native and database clients. Its `tsconfig.json` has no ambient types, so `Buffer` or
`window` is a compile error.

### The conformance corpus

`src/conformance/cases.ts` holds scenarios chosen for where engines are most likely to
disagree: rounding at both signs, leap days and UTC offsets, Arabic and emoji lengths,
case-insensitive patterns, three-valued logic, the wording of every publish error. The
runner records the engine's decision after every step as canonical JSON (sorted keys,
integers only) into `conformance/golden.jsonl`.

```bash
pnpm --filter @integr8/form-engine test                 # Node must reproduce the golden file
pnpm --filter @integr8/form-engine conformance:golden   # regenerate — then read the diff
HERMES_BIN=/path/to/hermes pnpm --filter @integr8/form-engine conformance:hermes
```

The Hermes run bundles the corpus with esbuild, lowers it with **the mobile app's own
Babel preset** (`babel-preset-expo`, resolved through `apps/mobile`), inlines the Babel
helpers, and runs it in Hermes. CI does this on every pull request, with the Hermes
download pinned by SHA-256.

**What that proves, exactly.** The newest prebuilt Hermes command-line runner is the
`v0.13.0` release, whose binary reports `0.12.0`. React Native 0.86 ships Hermes V1, which
is newer. So the CI run is a genuine second engine — different regular expressions,
number printing, BigInt and string library from V8 — reproducing Node's output byte for
byte. It is not the exact engine in the phone. That last step belongs to P13: the same
corpus, run inside the app on a device.

Local Hermes: download `hermes-cli-windows.tar.gz` or `hermes-cli-darwin.tar.gz` from the
same release and point `HERMES_BIN` at the `hermes` binary.

### Property-based tests

`src/properties.test.ts` generates random forms — pages, sections, types, conditions,
calculations — and random sequences of answers, and checks for every one: it compiles;
it decides the same after a JSON round trip and whatever the answer key order; nothing
hidden has a value or an error; the server accepts what the phone submits and agrees on
every error; progress is coherent; answering twice equals answering once. Two further
properties inject cycles and check they are always refused, naming the fields.

### Coverage

`pnpm test` runs with coverage, and the build fails below 90 percent on lines, statements,
functions or branches. At the time of writing it is 99.4 / 99.4 / 99.4 / 96.2.

## Adding a field type

1. Add its schema to `fieldSchema` and its row to `FIELD_TYPES` in `field-types.ts`.
2. Handle it in `answerSchemaFor`, `isAnswered`, `validateAnswer`, `toRuleValue` and, if
   it has configuration that can contradict itself, `fieldConfigIssues`. The compiler's
   exhaustive switches make each of these a type error until done.
3. Add a message to `@integr8/i18n` for any new error code; its test will insist.
4. Add a conformance case, regenerate the golden file, and read the diff.
