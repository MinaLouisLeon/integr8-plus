# Forms

Integr8 staff build each company's forms in the desktop app; the company's
people fill them on the web, the desktop and the phone. One pure engine,
`@integr8/form-engine`, evaluates a form everywhere (browser, desktop, the
phone's Hermes and the server) and must decide exactly the same in each.

```
forms ──< form_versions (draft → published, then immutable) ──< submissions ──< submission_values
                │ actions                                          │ events, links, action results
```

## A definition

A form is pages of sections of fields, as JSON checked by zod
(`definitionSchema`). Format 2 (`schemaVersion: 2`) adds Information blocks
(text in a section, never an answer), page and section descriptions, and date,
time and number calculations with brackets.

| Type                         | Answer                                                    | Configuration                                           |
| ---------------------------- | --------------------------------------------------------- | ------------------------------------------------------- |
| `text`, `long_text`          | string                                                    | `minLength`, `maxLength`, `pattern`, `default`          |
| `barcode`                    | string                                                    | `maxLength`                                             |
| `number`                     | safe integer                                              | `min`, `max`, `unit`, `default`, `calculation`          |
| `decimal`                    | decimal **text**, e.g. `"12.50"`                          | `decimalPlaces`, `min`, `max`, `unit`, `calculation`    |
| `rating`                     | integer 1…`scale`                                         | `scale` (3–10)                                          |
| `date`, `time`, `datetime`   | `YYYY-MM-DD`, `HH:MM`, ISO with offset                    | `earliest`, `latest`, `default`, `calculation` (date)   |
| `dropdown`, `radio`          | option value                                              | `options`, `default`                                    |
| `multi_select`               | option values                                             | `options`, `minSelected`, `maxSelected`                 |
| `checkbox`                   | boolean (`required` means ticked)                         | `default`                                               |
| `yes_no`                     | `yes` · `no` · `not_applicable`                           | `allowNotApplicable`                                    |
| `signature`, `photo`, `file` | file references                                           | `minFiles`, `maxFiles`, `maxFileBytes`, `acceptedTypes` |
| `gps`                        | `{ latitude, longitude, accuracyMeters }` as decimal text | `maxAccuracyMeters`                                     |

Every field also takes `label` and `help` (English and Arabic), `required`,
`readOnly`, `visibleWhen`, `requiredWhen` and `rules` (custom checks with the
builder's own message). Choices can depend on an earlier answer. A section can
**repeat** (entries, each with its own answers, rules inside and across entries,
minimum and maximum entries), and an answer can be prefilled from earlier
answers or carried over from an asset's last visit.

**Rules.** Expressions are three-valued: a rule that reads an unanswered
question is _unknown_, which neither shows a field nor fails a check. A hidden
field is absent: its answer is not kept and not checked. Everything is checked
again at publish (`prepareForPublish`), with errors worded for the builder.

**A phone older than a form's format** shows "Update the app" for that form
rather than filling it wrongly (`apps/api/src/sync/form-formats.ts`).

## Versions

Editing means a new draft and a new publish; one draft per form; versions are
numbered at publish. A published version is immutable **in the database** (a row
trigger refuses update and delete for every role with SQLSTATE `55000`, a
statement trigger refuses truncate, and the runtime role has no delete). A
submission binds to a published version at insert and never moves. A draft
started on an older version is carried forward with `migrateAnswers`, which
reports what did not fit (`field_removed`, `type_changed`, `option_removed`, …)
and keeps rejected values flagged rather than blanking them.

## The same everywhere

- **Lint.** The engine may not use `Date`, `Intl`, `Math.random`,
  `localeCompare`, `toLocale*`, `toFixed`, `eval`, Node built-ins, React or
  database clients, and has no ambient types.
- **The conformance corpus** (`src/conformance/cases.ts`): rounding at both
  signs, leap days and offsets, Arabic and emoji lengths, three-valued logic,
  every publish error. Node must reproduce `conformance/golden.jsonl`; CI runs the
  same corpus in Hermes, bundled with the phone's own Babel preset, on every
  pull request. `pnpm --filter @integr8/form-engine conformance:golden`
  regenerates it (read the diff).
- **A behaviour check** holds the web filler, the phone and the builder's
  preview to the same screens.

## The builder

Desktop app, staff only (`form.manage`, through impersonation), on the
`forms` section:

- Pages, sections and fields by drag and drop; conditions written as sentences
  and shown on the cards; required-only-when, dependent choices, formulas, answer
  keys.
- English and Arabic side by side, and a Translations tab; missing Arabic only
  warns at publish.
- Autosave names the revision it is based on (409 when another window saved
  first), with recovery.
- Preview, including the phone's look; "Check" lists what would stop a publish.
- **The template library.** Built-in templates (kept by `pnpm --filter
@integr8/db db:templates`) and staff-made ones (`form_templates.source =
'staff'`, managed on the dashboard's Templates page, pictures in a
  `platform-library` bucket). Staff only: staff acting as a company start a
  form from either; a company's own people never see the library.
- **Copying.** Staff copy a form to another company as a draft, optionally with
  its PDF templates and pictures, or save it to the library.
- **Files.** A form with its PDF templates and pictures travels as one
  `.integr8form` file ([package-format.md](./package-format.md)): exported from
  the published version or the draft, imported as a new draft (or as a library
  template; the library refuses a form that would not publish).
- PDF templates are designed beside the form ([documents/](../documents/README.md)).

## Submissions

```
draft ──submit──▶ submitted ──reopen (reason)──▶ reopened ──submit (reason)──▶ submitted
```

- Drafts live on the server, belong to their author, and autosave against a
  revision (409 `submission_changed` from a device that is behind). The phone
  keeps its own drafts and syncs them ([apps/mobile.md](../apps/mobile.md#sync)).
- Submitted answers cannot change; reopening and correcting need a reason; every
  submit, reopening and correction is kept with its answers in
  `submission_events`, which nobody can edit (triggers, select-only grants).
- **The server checks again** on submit with the same engine, against the
  version the submission is bound to. A submit can record where it happened
  (location with its accuracy and corrected time).
- **The name.** The submit step asks for a name, prefilled with the form's
  title, stored in `submissions.title` and shown in lists.
- On a job: a completed, reviewed or cancelled job refuses starting a form and
  submitting a draft (`submission_job_closed`); a phone's draft started before
  the job closed is accepted and marked `submittedAfterClose`. "Signature
  required before close" on a form makes the job's sign-off required.
- **Who sees what.** Filling needs `submission.fill` and the person's role in
  the form's fill roles; everyone sees their own; `submission.read_all` (owner,
  admin, dispatcher, viewer, and the roles the matrix gives it) sees everyone's;
  `submission.amend` reopens and corrects, and the author of a reopened
  submission may correct it. Drafts are their author's alone. Anything a caller
  may not see answers 404.
- **Reporting.** `submission_values` holds one row per answer (split by year),
  for lists, filters and CSV export; repeating entries report one row per entry.
  Files a submission names are indexed in `submission_file_uses`, so a file
  follows its submission's visibility. Photos open in a viewer.

## Form actions

A form version may carry **actions** (`form_versions.actions`, beside the
definition, so phones never read them): **expense claims** made from answers,
and **another form opened** for the same job.

```json
[
  {
    "id": "mileage",
    "kind": "expense_claim",
    "when": { "kind": "answered", "field": "km" },
    "category": "Mileage",
    "amount": { "field": "mileage_total" },
    "description": { "en": "Mileage, {{job.reference}}", "ar": "بدل انتقال، {{job.reference}}" }
  },
  {
    "id": "handover",
    "kind": "open_form",
    "form": "<form id>",
    "required": true,
    "when": {
      "kind": "compare",
      "operator": "eq",
      "left": { "kind": "answer", "field": "needs_handover" },
      "right": { "kind": "text", "value": "yes" }
    }
  }
]
```

- `when` is the engine's expression on the submitted answers; unknown does not
  hold. `amount` names a top-level number or calculation, rounded to piastres;
  nothing, zero or less makes no claim. `category` is matched by name, ignoring
  case, so a form travels between companies. At most 10 actions.
- Schema, form-only checks and the plan of a submit are in `@integr8/form-engine`
  (`actions.ts`); the company's checks (category exists, next form published, HR
  on) in `apps/api/src/forms/action-checks.ts`.
- The submit runs them in its own transaction, each in a savepoint; a claim that
  cannot be made never refuses the submission. A claim's `client_action_id` is a
  UUID v5 of submission + action, so it is made once. Outcomes are kept in
  `submission_action_results`; **Make it now** (`POST
/v1/submissions/{id}/actions/retry`) runs failed ones again.
- Claims wait for approval; the approver may set `approvedAmount` and a note.
  A follow-up form is a draft linked in `submission_links`, added to the job's
  forms, so a required one blocks completing the job.
- Routes: `PUT /v1/forms/{id}/draft/actions` (staff), `POST
/v1/forms/{id}/draft/check` (`actionIssues`), publish (422 `invalid_actions`,
  `form_action_needs_module`), submit (answers `formActions` and `nextForms`),
  `GET /v1/expenses/{id}/submission` for claim deciders.

**Not built yet:** the builder's Actions tab and the other screens, the phone's
next-form button, Forms for AI support, actions in `.integr8form` files, and
the demo seeder's trip form. The owner's decisions on how actions behave are
still open ([plan](../../plan/README.md)).

## Adding a field type

The type's zod schema and answer shape in the engine, its rules and publish
checks, conformance cases (regenerate the golden file), the web/desktop widget
in `form-renderer-dom` (through `form-input`), the phone's widget, the builder's
property panel, reporting in `submission_values`, and both languages.
