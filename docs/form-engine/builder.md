# The form builder

The desktop app's form builder (P07) is where a company admin turns "the boiler service
sheet" into a form an engineer can fill in. It is built on three layers, and each one
refuses the kind of mistake it is best placed to catch.

```
apps/desktop/src/features/forms     what the admin sees and does
        │  every edit is an engine authoring operation
@integr8/form-engine  authoring/    pure edits, conditions as sentences, diffs
        │  PUT draft · POST check · POST publish · POST test-submission
apps/api  routes/v1/forms.ts        the only way to a published version
        │
@integr8/db  forms, form_versions   immutable once published, enforced by triggers
```

---

## The rules that shape it

- **A draft may be invalid; a published version may not.** Autosave stores whatever the
  builder has, because a half-built form is what a draft is. Publish compiles the whole
  definition and refuses anything that does not compile, with a 422 whose details name
  every offending field. There is no other route to a published version.
- **Nobody publishes what they did not see.** Every save and every publish names the draft
  revision it is based on. A second tab that saves on a stale revision gets 409
  `draft_conflict`; a publish of a draft that changed since it was reviewed gets 409
  `draft_changed`.
- **Breaking changes are acknowledged, not discovered.** Removing a question that
  submissions answered is legal — earlier versions keep it — but publishing it without
  `acknowledgeBreakingChanges: true` is refused with 409 `breaking_changes_unacknowledged`.
  The builder explains each one by what it costs: a gap in reports, or work for anybody
  with an unfinished draft.
- **A test fill is not a submission.** `POST /v1/forms/:id/draft/test-submission` runs the
  exact validation a real submission gets against the saved draft and writes nothing.

## API

| Route                                      | Who          | What                                                    |
| ------------------------------------------ | ------------ | ------------------------------------------------------- |
| `GET /v1/forms`                            | everyone     | Forms; drafts and unpublished forms only for builders   |
| `POST /v1/forms`                           | owner, admin | A new form with an empty draft (idempotent)             |
| `GET /v1/forms/:id`                        | everyone     | The form, its live version, and its draft for builders  |
| `PATCH /v1/forms/:id`                      | owner, admin | Title, who may fill it, whether a signature is required |
| `POST /v1/forms/:id/clone`                 | owner, admin | A copy with no history (idempotent)                     |
| `PUT /v1/forms/:id/draft`                  | owner, admin | Autosave on `expectedRevision`                          |
| `POST /v1/forms/:id/draft/check`           | owner, admin | Every issue, and the diff against the live version      |
| `POST /v1/forms/:id/draft/publish`         | owner, admin | The new immutable version, with change note and summary |
| `POST /v1/forms/:id/draft/test-submission` | owner, admin | The server's verdict on a test fill; `stored: false`    |
| `GET /v1/forms/:id/versions[/:versionId]`  | everyone     | Published history, and any one version read-only        |
| `GET /v1/form-templates[/:key]`            | everyone     | The global template library                             |
| `POST /v1/form-templates/:key/clone`       | owner, admin | A new form from a template (idempotent)                 |
| `GET /v1/forms/copy-targets`               | staff only   | Other companies a form can be copied to (1.3.0)         |
| `POST /v1/forms/:id/copy-to-company`       | staff only   | The form in another company as a draft (1.3.0)          |
| `POST /v1/forms/:id/library-template`      | staff only   | The form saved as a staff-made library template (1.3.0) |

| Route                                      | Who          | What                                                       |
| ------------------------------------------ | ------------ | ---------------------------------------------------------- |
| `GET /v1/forms`                            | everyone     | Forms; drafts and unpublished forms only for builders      |
| `POST /v1/forms`                           | owner, admin | A new form with an empty draft (idempotent)                |
| `GET /v1/forms/:id`                        | everyone     | The form, its live version, and its draft for builders     |
| `PATCH /v1/forms/:id`                      | owner, admin | Title, who may fill it, whether a signature is required    |
| `POST /v1/forms/:id/clone`                 | owner, admin | A copy with no history (idempotent)                        |
| `PUT /v1/forms/:id/draft`                  | owner, admin | Autosave on `expectedRevision`                             |
| `POST /v1/forms/:id/draft/check`           | owner, admin | Every issue, the diff, and warnings (texts with no Arabic) |
| `POST /v1/forms/:id/draft/publish`         | owner, admin | The new immutable version, with change note and summary    |
| `POST /v1/forms/:id/draft/test-submission` | owner, admin | The server's verdict on a test fill; `stored: false`       |
| `GET /v1/forms/:id/versions[/:versionId]`  | everyone     | Published history, and any one version read-only           |
| `GET /v1/form-templates[/:key]`            | everyone     | The global template library                                |
| `POST /v1/form-templates/:key/clone`       | owner, admin | A new form from a template (idempotent)                    |

Every publish is written to the audit log as `form.published`, with the version number and
how many breaking changes were acknowledged.

Form settings — who may fill a form and whether a signature is mandatory — take effect at
once and are not versioned: they describe how the company uses the form, not what it asks.
Which job types require a form arrives with job types in P10.

"Signature required before close" is enforced when a job completes (migration 0060): a job
with any submission of the form — draft, submitted or reopened — cannot be completed until the
customer's sign-off (a signature, or the reason nobody could sign) is recorded, whatever its
job type says. The database refuses it for every client; the job screen on the web, desktop
and phone lists it with the other missing things as "signature missing". The setting is read
from the form at that moment, not from the version filled, so changing it applies to jobs
still open and never to jobs already completed.

## The template library

`form_templates` is a platform table: it belongs to no company, the runtime role may only
read it, and a company copies a template rather than using it. The library is whatever
`@integr8/form-engine/templates` ships, loaded with:

```sh
pnpm --filter @integr8/db db:templates
```

It is an upsert — removing a template from the code does not remove it from the database,
because companies may already have started from it. Run it after migrations in every
environment; it is product content, not seed data. In a deployment nobody has to: the compose
`migrate` service runs it (`node node_modules/@integr8/db/dist/seed/templates-cli.js`, as the
owner) straight after `db up`, on every start of the stack.

It only ever writes `form_templates`, by key. A company's form made from a template is its own
copy from the start (`forms.source_template_key` records where it came from, and its versions
hold their own definition), so loading a changed library again never changes a company's form,
draft or published; `form-builder.integration.test.ts` checks exactly that, and that loading
twice changes nothing.

### Staff-made templates (1.3.0)

Since 1.3.0 the library holds two kinds of template side by side (`form_templates.source`,
migration 0069):

- **Built in** (`builtin`): shipped in the code and kept equal to it by `db:templates`. Read-only
  everywhere else: the dashboard and the platform routes refuse to change one
  (`form_template_builtin`), and a key the code ships can never be taken by a staff template.
- **Staff-made** (`staff`): saved from a company's form by Integr8 staff (see "Copying a form"
  below), with that form's PDF templates. `db:templates` never touches one: its upsert only ever
  updates a built-in row, so a staff template survives every deploy even if the code later ships
  the same key. Staff rename and re-describe it (English and Arabic), replace it with the newer
  published version of the form it came from, and retire or bring it back on the dashboard's
  **Templates** page (`docs/platform/README.md`).

A retired template leaves the companies' picker (`GET /v1/form-templates` and its clone route
answer as if it were not there) and stays on the dashboard. Forms already made from it are
copies and never change. Nothing is ever deleted.

The picker shows both kinds; a staff-made one is marked "Made by Integr8", and one that carries
PDF templates says so. Starting from it (`POST /v1/form-templates/:key/clone`) also creates a
copy of each of its PDF templates for the new form, with every picture copied into the
company's own storage — unless `includeDocumentTemplates: false` — and the response says how
many (`documentTemplatesCopied`). The pictures count against the company's allowance, and a
company past a blocking allowance is refused with `storage_quota_exceeded`. How the library
keeps those PDF templates is in `docs/documents/RUNBOOK.md` ("Copying templates").

## Copying a form

Three ways, all copies — never a link back to the original:

1. **Make a copy** (forms list, any builder): a new form in the same company, a draft of the
   latest published version (or of the draft). Unchanged since P07.
2. **Copy to another company** (form builder header, Integr8 staff only; decision 1A). Pick the
   company, optionally rename the copy, choose whether its PDF templates go too, and give a
   reason. The form's latest published version — or its draft, if it was never published —
   arrives in the other company as a **new form with an unpublished draft**. What travels: the
   definition exactly as it is (answer keys, both languages, rules, calculations), who may fill
   it, and whether a signature is required. What never travels: job type links, submissions,
   answers, documents, or anything about customers. With PDF templates, every template that is
   not archived is copied and each picture is copied into the other company's bucket under a new
   id, tied to its new template and counted in that company's storage (a blocking allowance
   refuses the whole copy). The copied templates are checked against the copied definition when
   the form is published there, like any other.
3. **Save as library template** (form builder header, Integr8 staff only; decision 1B). A key, a
   name and description in English and Arabic, a category, and whether to carry the PDF
   templates. The form must be published: the library takes the latest published version.

Copy to another company and Save as library template are **staff routes on the company
session**: the staff desktop app reaches a company's forms only through the audited
impersonation grant, and drops its platform sign-in once the company is open
(`apps/desktop/src/lib/staff.ts`), so a platform route could not be called from the form screen.
Both require `form.manage` (staff-only) and the impersonation claim, and carrying PDF templates
also requires `document.design`. Every copy is audited three times: `form.copied_to_company` in
the source company, `form.copied_in` (actor: the staff member, `platform_user`) in the target,
and `form.copied_to_company` in the platform audit log with the grant id. Saving to the library
writes `form.saved_to_library` in the company and `form_template.saved_from_form` in the
platform log; renaming, replacing and retiring write `form_template.renamed`, `.refreshed`,
`.retired` and `.restored`.

Screenshots, in English and Arabic: `docs/screenshots/1.3.0/forms/` (the two dialogs) and
`docs/screenshots/1.3.0/platform/` (the dashboard's Templates page).

## In the desktop app

`apps/desktop/src/features/forms`:

| Path                                  | Responsibility                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------- |
| `model/editor.ts`                     | The editing reducer: definition, selection, bounded undo and redo                  |
| `model/catalog.ts`                    | Palette groups and property editors, read from the engine's type registry          |
| `model/calculation.ts`                | Calculations as a left-to-right chain, and back                                    |
| `model/recovery.ts`                   | The local copy that survives a crash, and what to offer on reopening               |
| `model/rename.ts`                     | A new question's answer key following its wording, until something depends on it   |
| `model/issues.ts`                     | Which element to open for a compile issue                                          |
| `use-draft-sync.ts`                   | Autosave, retry, conflict detection                                                |
| `model/sentences.ts`                  | A question's rules read out as sentences for its card on the canvas                |
| `components/canvas.tsx`               | Palette and drag-and-drop canvas (dnd-kit), with keyboard and button moves         |
| `components/config-panel.tsx`         | Everything about the selected question, section or page                            |
| `components/condition-builder.tsx`    | "Show this when…", "Required when…" and custom checks, as sentences                |
| `components/form-renderer.tsx`        | The preview's desktop view: `viewForm` rendered, every page at once                |
| `components/phone-preview.tsx`        | The preview's phone, drawn the way the phone app draws the form                    |
| `components/bilingual-text-input.tsx` | One text typed in English and Arabic side by side; every text in the panel uses it |
| `components/translations-panel.tsx`   | The Translations tab: every text of the draft, English beside Arabic               |
| `components/changes-panel.tsx`        | The server's check, the diff, and the publish dialog                               |

### Conditions as sentences

The builder never shows an expression. A condition is a list of clauses — a question, a
comparison named in words, an answer chosen the way the question itself is answered — joined
by "all of" or "any of", and `toExpression` / `fromExpression` in the engine turn that into
the typed syntax tree and back. An expression the builder cannot phrase (written by hand,
or later by AI generation) is shown read-only with a way to remove it, never rewritten into
something it did not say.

### Conditions on the cards

Every question card on the canvas reads its rules out — "Shown when Result is Fail",
"Required when Hazards includes Gas", "Choices depend on Area" — and has a "Show when…"
button that opens the same condition editor in a dialog, so a condition is found and changed
without opening the panel. A rule the builder cannot phrase is named as "a rule written
outside the builder". The sentences come from `model/sentences.ts`, over the engine's
`fromExpression`, using the same words as the dropdowns.

### Required only when, and dependent choices

The panel's "When it must be answered" group holds a "Required only when…" rule built with
the condition editor; it is greyed out while the fixed "Must be answered" toggle is on, since
the two are exclusive. On a dropdown, pick-one or pick-several question, "Depends on" lists
the choice questions in scope, then, per option, a row of the parent's options that reveal
it (nothing ticked means always offered). The preview draws the required mark and the offered
options from the engine's view, as the phone and the web renderer do.

### Information blocks and descriptions (1.3.0)

The palette's "Text and guidance" group adds an **Information** block where a question
would go (drag or click). Its panel edits an optional heading, the paragraph (plain text;
line breaks kept), the style — plain, tip, or warning in amber — and "Shown when", with the
same condition editor as a question; the card shows its heading or first words and its
rule as a sentence. Pages and sections have a **Description** box under their title. All of
these are plain `LocalizedText`, so whatever walks a form's texts (translations, the check
before publishing) finds them. An Information block has no answer: it is not in
submissions, reports or exports, and it prints on a PDF only where a template places it
(the PDF designer's "Information from the form" block). See
[the engine](README.md#descriptions-and-information-blocks-format-2).

### Formulas (1.3.0)

A calculated number, decimal or date question is worked out from a **formula**, typed in
the panel:

```
([Hours] + [Travel]) * [Rate]
round(percent([Passed], [Tested]), 1)
add_months([Serviced on], 12)                ← a date question
hours([Start], [Finish])                      ← 22:00 to 06:00 is 8
minutes([Arrived], now)
sum([Radiators], [Output]) / count([Radiators])
```

- Questions are `[their wording]` in the language being edited, or `[their_key]` when two
  share a wording. Typing `[` lists the questions the formula may read where it sits;
  typing a name lists the functions; Enter, Tab or a click takes one.
- `+ - * /` (also `× ÷ −`), multiplication before addition, brackets; Arabic-Indic digits
  and the Arabic comma are read too. Functions are named in English in both languages, as
  in a spreadsheet, and listed with their meaning in the panel's language under
  "Functions": `round`, `percent`, `min`, `max`, `average`, `days`, `hours`, `minutes`,
  `add_days`/`weeks`/`months`, `subtract_days`/`weeks`/`months`, `count`, `sum`, `today`,
  `now`. Dates and times in quotes: `"2026-01-31"`, `"08:30"`.
- Every keystroke is checked: the formula's own reading names the first problem (an
  unknown question, a wrong number of values, a date where a number goes, a result of the
  wrong kind), then the engine compiles the form with it (a calculation that comes back to
  its own question). Only a formula that works is saved into the draft; the text is kept as
  typed until it does.
- The box is left to right in both languages. An Arabic name in brackets still shows as
  `[الضغط] * 2`, its brackets the right way round: browsers pair brackets by the Unicode
  bidirectional algorithm's bracket rule, which gives a pair holding Arabic the direction of
  what comes before it (checked in Chromium, with and without invisible isolation marks
  around each name — the two look the same, so no marks are added to what is typed).

**Why a typed formula, not boxes.** The step-by-step editor could only say left-to-right
chains. Brackets and functions nest, and a nested tree of dropdowns is unreadable; one line
of text is what every office already reads in a spreadsheet, and the suggestions and the
live check make it hard to get wrong. A calculation made with the old editor opens printed
with the brackets that keep its left-to-right meaning (`[Hours] + [Travel] * [Rate]` as
written then is `([Hours] + [Travel]) * [Rate]`), and the stored tree is unchanged.
`apps/desktop/src/features/forms/model/formula.ts` is the language; its tests prove every
printed formula reads back into the same tree.

Screenshots, in English and Arabic: [an Information block and descriptions on the web
filler](../screenshots/1.3.0/form-builder/information-block-en.png) ([Arabic](../screenshots/1.3.0/form-builder/information-block-ar.png)),
[its settings](../screenshots/1.3.0/form-builder/information-settings-en.png) ([Arabic](../screenshots/1.3.0/form-builder/information-settings-ar.png)),
[the formula editor](../screenshots/1.3.0/form-builder/formula-editor-en.png) ([Arabic](../screenshots/1.3.0/form-builder/formula-editor-ar.png))
and [a calculated date](../screenshots/1.3.0/form-builder/formula-editor-date-en.png) ([Arabic](../screenshots/1.3.0/form-builder/formula-editor-date-ar.png)).

### Answer keys

A question's id is the key its answers are stored under, forever. A new question starts
keyed by its kind (`pick_one`) because it has no wording yet; when the admin finishes typing
the wording, the key is re-derived from it (`appliance_safe_to_use`) — but only while no
published version has used the key and no rule reads it, and never onto a key an earlier
version used for something else. After that it is fixed, and renaming the question changes
its label only.

### Autosave and recovery

Every edit is written to `localStorage` under the company and form, then sent about 800 ms
after the last change. A failed save retries with backoff and shows "Not saved yet"; a
conflict stops and offers to load the other version. On opening a form, a local copy that
never reached the server is offered back — with a warning if somebody has saved since. The
copy is removed as soon as the server has the same definition.

### Two languages side by side

A form carries its own words (`LocalizedText`, `{ en, ar }`), and each engineer fills it in
the language their phone is set to; a text with only one language shows that one to
everybody. So every text in the settings panel — a page's or section's title, a question's
wording and help, each option, a custom check's message, a format's message, what one entry
of a repeating section is called — has an English box and an Arabic box side by side,
whatever language the builder itself is in (owner's decision, 1.3.0). The Arabic box is
right-to-left and is outlined in amber, with "No Arabic yet", while the English has words
and it has none. Emptying both boxes removes an optional text (help) and leaves a required
one empty, which the compiler then names as a problem. A question's answer key follows its
**English** wording (Arabic gives no Latin letters to make a key from).

`BilingualTextInput` is the one component for this; a new kind of text (a description, an
information block) uses it too. A question's unit (`bar`, `W`) is a plain string in the
definition, not a `LocalizedText`, so it stays one box: making it bilingual would change the
format every phone reads.

The settings panel in English and in Arabic (1.3.0):
[English](../screenshots/1.3.0/form-builder/settings-panel-en.png),
[Arabic](../screenshots/1.3.0/form-builder/settings-panel-ar.png).

### The Translations tab

One table of every text in the draft, grouped by page and section, with what each text is
("Question", "Help text", "Option · fail", "Check message · check_1") and whose it is, and
English and Arabic columns edited in place. Each change is an ordinary edit of the draft, so
it autosaves and Undo takes it back. "Only texts with no Arabic" narrows the table to those;
a row stays while it is being filled in and is marked "Done", so it does not vanish at the
first letter. "Show" opens the item in Build.

The texts come from `collectTexts` in `@integr8/form-engine` (`authoring/translations.ts`),
which walks the definition **by its schema** and stops at every `localizedTextSchema`: a text
added to the format later appears here, and in the check below, without a list to update.

Screenshots: [English](../screenshots/1.3.0/form-builder/translations-en.png),
[Arabic](../screenshots/1.3.0/form-builder/translations-ar.png),
[only texts with no Arabic](../screenshots/1.3.0/form-builder/translations-missing-en.png).

### Texts with no Arabic in the publish check

`POST /draft/check` returns `warnings`, one `missing_translation` per text with no Arabic
(`missingTranslations(definition, 'ar')`, the same walk). The Changes tab and the publish
dialog say "12 texts have no Arabic" with a button to the Translations tab, filtered. It is a
warning only: publishing is never refused for it, because an English-only company is a
normal customer. A server from before 1.3.0 sends no `warnings`, and the builder then says
nothing.

### The phone in Preview

The phone beside the desktop view is drawn the way the phone app draws a form
(`apps/mobile/src/forms`): the header with the form's title and the progress bar, one page at
a time with "Page 2 of 4", sections as cards, a large label with the red required mark, help
under it, a red edge and bold red errors under the control, choices as whole-width rows,
yes/no and ratings as big segments, every control at least 56 points tall, a repeating
section as a list of its entries opened one at a time, and Review jumping to the first
problem. It uses the phone's system font and type sizes, and the company's brand colour and
theme computed the way the phone computes them (`colourVariables` and `brandAccentVariables`
from `@integr8/tokens`, the values the phone's `useTheme` reads); a company on "system"
follows the desktop's own theme. The camera, signature pad, location and native date pickers
are stood in for, as before ("Simulate").

What form format 2 added is drawn as the phone draws it (`apps/mobile/src/forms/information.tsx`):
descriptions under page and section titles, Information blocks plain or boxed with a coloured
edge (tip in the brand colour, warning in amber), and a calculated date written as the phone
writes dates. For a form that uses any of it, **Open as an app older than 1.3.0** under the
phone shows what such an app shows instead of the form: the phone's "Update the app" screen.
The preview's `now` is the clock, as on the phone.

Screenshots, after Review on an empty form, in a teal company colour:
[English](../screenshots/1.3.0/form-builder/phone-preview-en.png),
[Arabic](../screenshots/1.3.0/form-builder/phone-preview-ar.png).

### Behaviour check

Three renderers draw a form from one engine: the builder's preview (desktop view and phone),
the web filler (`@integr8/form-renderer-dom`, also used by the desktop app) and the phone app.
An automated check holds all of them to the same thing at every step:

- **Forms:** the six library forms, plus `EVERYTHING_FORM` — every question type and every
  kind of rule: "Show when" on a question, a section and a page, "Required only when",
  options that depend on another answer, custom checks and a format with their own
  messages, calculations (one summing a repeating section), and a repeating section with a
  minimum, a title question, a check inside an entry and checks across its entries (count,
  every). It is written in form format 2 and also has a description on a page and on a
  section, Information blocks of each style (one with "Show when", one inside the repeating
  section's entries) and one calculation of each new family: days between dates, a date
  moved by months, rounding, a percentage and an average (a calculation reading `now` is left
  out: the clock differs between renderers).
- **Steps:** opened; Review pressed on an empty form; first options and plain values,
  before and after Review; last options and values the rules refuse; two entries added,
  before and after Review; and five steps of the every-type form that trigger one rule each.
  In English and in Arabic.
- **What is compared:** every page shown (its description), every section shown (title and
  description; for a repeating section its entries' titles and its own problems), every
  question shown, page after page and entry after entry — its words, its help, whether it has
  the required mark, every error message in the words shown and, for a calculated question,
  the answer as shown — and every Information block shown (heading, text, style); or that the
  review screen shows when nothing is wrong.

The expectation is written from the engine's view by `expectedScreen`
(`@integr8/form-input/behaviour`, with the forms and steps). Each renderer's test reads its
own screen through the same markers (`data-page`, `data-section`, `data-question`,
`data-information` with `data-style`, `data-part`; `testID`s on the phone) with `readScreen`,
and compares:

| Test                                                                    | Renderer                                                                                    |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/desktop/src/features/forms/components/preview.behaviour.test.tsx` | The preview's phone, pressed through like a phone; its desktop view                         |
| `packages/form-renderer-dom/src/behaviour.test.tsx`                     | The web filler, page by page through its navigation                                         |
| `apps/mobile/src/forms/behaviour.test.tsx`                              | The phone app's own screens (`FormFiller`, `FieldBlock`, entries, widgets) with `FillModel` |

The phone's components are real; React Native itself is replaced in that test by a small
stand-in that draws its components as DOM (`apps/mobile/src/testing/react-native.tsx`), and
the device parts (camera, files, location, signature pad, media storage) by empty ones.

What it cannot see: how anything looks — pixels, fonts, spacing, colours — the native pickers,
the camera and signature pad, option lists inside a closed dropdown, and typing into a control
(each renderer's own widget tests cover input). The answers are given to each renderer the way
it opens a saved form (the phone from its stored row, the web from a draft), then Review is
pressed on screen. The look of the preview's phone was matched to the phone app by reading
its styles, not by comparing screenshots.

When it was first run it found two differences, both fixed: the phone showed no required mark
on a required tick box, and the preview's desktop view ignored a format's own error message.

### Adding a property to a field type

Add it to the type's schema in `@integr8/form-engine`, then:

1. give it an editor in `editorFor` (`model/catalog.ts`) — `catalog.test.ts` fails until you do;
2. give it a label under `forms.config.property` in `@integr8/i18n` — `form-builder.test.ts`
   fails until you do.

## Running it locally

The builder needs the API, a migrated database with templates loaded, and a user who is an
owner or admin. See [the database README](../database/README.md) and the root README's
"Everyday commands" for the first two.

The desktop app and the API run on different origins (`localhost:3002` and `:3000`). The
API allows the local origins in development and `API_CORS_ORIGINS` elsewhere (added in P08).
