import {
  BLOCK_COLOURS,
  type BlockType,
  blockSchema,
  DESIGN_LIMITS,
  DESIGN_SCHEMA_VERSION,
  designSchema,
  DOCUMENT_FONT_KEYS,
  type DocumentFontKey,
  headerFooterSlotSchema,
} from '@integr8/document-render';
import {
  AGGREGATE_OPERATORS,
  ARITHMETIC_OPERATORS,
  COMPARISON_OPERATORS,
  DATE_SHIFT_OPERATORS,
  DATE_STEP_UNITS,
  DEFINITION_SCHEMA_VERSION,
  DURATION_UNITS,
  type Expression,
  expressionSchema,
  FIELD_TYPES,
  type FieldType,
  fieldSchema,
  formDefinitionSchema,
  INFORMATION_STYLES,
  informationSchema,
  LIMITS,
  MAX_ROUND_PLACES,
  MAX_STATISTIC_OPERANDS,
  STATISTIC_OPERATORS,
  VERSION_2_EXPRESSION_KINDS,
} from '@integr8/form-engine';
import { DEFAULT_FILL_ROLES, FORM_PACKAGE_LIMITS } from '@integr8/form-package';
import { z } from 'zod';

/**
 * The format guide the AI reads before writing a form (`get_format_guide`).
 *
 * The lists in it — question types and their options, rule and calculation
 * kinds, PDF blocks and their options, fonts, colours, limits — are read from
 * the same schemas and registries Integr8 Plus validates with, and the prose
 * for each entry is a `Record` keyed by the registry's own type, so a new
 * question type or block kind fails the type check (and `guide.test.ts`)
 * until it is described here. The guide cannot drift silently from the
 * format it describes.
 */

export const GUIDE_SECTIONS = [
  'overview',
  'questions',
  'logic',
  'calculations',
  'repeating_sections',
  'information',
  'languages',
  'pdf_templates',
  'limits',
  'json_schema',
] as const;
export type GuideSection = (typeof GUIDE_SECTIONS)[number];

export const SECTION_TITLES: Readonly<Record<GuideSection, string>> = {
  overview: 'Overview and workflow',
  questions: 'Question types and every option',
  logic: 'Rules: shown when, required when, custom checks, cascading choices',
  calculations: 'Calculations and formulas',
  repeating_sections: 'Repeating sections',
  information: 'Information blocks and descriptions',
  languages: 'English and Arabic',
  pdf_templates: 'PDF templates: blocks, placeholders, header and footer, look, fonts, landscape',
  limits: 'Limits',
  json_schema: 'JSON Schemas of the form definition and the PDF design',
};

// ---------------------------------------------------------------------------
// Prose keyed by the registries' own types: a new entry is a type error here.
// ---------------------------------------------------------------------------

export const QUESTION_NOTES: Readonly<Record<FieldType, string>> = {
  text: 'One line of text: a name, a reference, a short note. Answer: a string.',
  long_text: 'Several lines: notes, findings, a reason. Answer: a string.',
  barcode:
    'A code scanned with the phone camera or typed: serial numbers, asset tags. Answer: a string.',
  number:
    'A whole number (integers only), optionally with a unit. Can be calculated. Answer: a JSON number.',
  decimal:
    'A number with a fixed number of decimal places (`decimalPlaces`, required). min/max/default are decimal TEXT, e.g. "12.5". Can be calculated. Answer: decimal text.',
  rating: 'A score from 1 to `scale` (3–10, required). Answer: a whole number.',
  date: 'A calendar date, YYYY-MM-DD. Can be calculated (schema version 2: a date moved by days/weeks/months). Answer: "2026-11-01".',
  time: 'A time of day, HH:MM (24 hours). Answer: "14:30".',
  datetime: 'A date and time, ISO 8601 in UTC, e.g. "2026-11-01T09:30:00.000Z". Answer: that text.',
  dropdown:
    'One choice from a list shown as a drop-down; good for long lists. `options` required. Answer: the option `value`.',
  radio:
    'One choice from a short list, all shown at once. `options` required. Answer: the option `value`.',
  multi_select:
    'Several choices from a list. `options` required. Rules test it with `includes`, never `compare`. Answer: an array of option values.',
  checkbox:
    'One tick box (true/false). `required: true` means "must be ticked". Answer: true or false.',
  yes_no:
    'Yes / No, optionally "Not applicable" (`allowNotApplicable`). Answer and rule value: "yes", "no" or "not_applicable" (compare it as text).',
  signature:
    'A signature drawn on the screen. A rule can only test whether it was given (`answered`).',
  photo:
    'One or more photos from the camera. A rule can only test whether any was given (`answered`).',
  file: 'One or more attached files; `acceptedTypes` limits the kinds. A rule can only test `answered`.',
  gps: "The phone's location, captured on site. A rule can only test `answered`.",
};

/** What each property of a question means. Every property any question type has must be here. */
export const QUESTION_OPTION_NOTES: Readonly<Record<string, string>> = {
  id: 'The answer key: ^[a-z][a-z0-9_]{0,63}$, unique in the whole form (pages, sections, questions and Information blocks share one namespace). Never change it once data exists.',
  type: 'The question type.',
  label: 'The question as people read it: { "en": "...", "ar": "..." }.',
  help: 'A hint under the question, both languages.',
  required:
    'Must be answered before the form can be submitted. Not allowed on calculated questions.',
  readOnly: 'Shown but not editable; useful with `default`. Cannot carry over.',
  visibleWhen:
    'A condition (expression); the question is shown only while it is definitely true. Hidden answers are not submitted.',
  requiredWhen:
    'A condition; the question is required while it is definitely true (in addition to `required`).',
  rules:
    'Custom checks: [{ "id", "assert": <condition>, "message": {en, ar} }]; the answer is refused when `assert` is definitely false. At most 50.',
  carryOver:
    'Filled from the last submission of this form for the same asset (make, model, settings). Not on evidence questions, calculated or read-only questions.',
  default:
    "The starting answer, of the answer's own type (decimal text for decimal, YYYY-MM-DD for date, an option value for a choice, an array for multi_select). Not with `calculation`.",
  minLength: 'Fewest characters.',
  maxLength: 'Most characters.',
  pattern:
    'A regular expression the text must match: { "source": "^[A-Z]{2}[0-9]{4}$", "caseInsensitive"?: bool, "message"?: {en, ar} }. Keep it simple; it is checked for safety.',
  unit: 'Shown after the number, e.g. "mbar", "°C" (1–20 characters, not translated).',
  min: 'Smallest allowed value (a number for `number`, decimal text for `decimal`).',
  max: 'Largest allowed value (a number for `number`, decimal text for `decimal`).',
  decimalPlaces: 'Decimal places kept, 0–6 (required on `decimal`).',
  calculation:
    'An expression that works the answer out instead of a person typing it (see the calculations section). The question becomes read-only.',
  earliest:
    "Earliest allowed value, a fixed literal in the question's own format (date YYYY-MM-DD, time HH:MM, datetime ISO).",
  latest: "Latest allowed value, a fixed literal in the question's own format.",
  options:
    'The choices: [{ "value": "^[a-z0-9][a-z0-9_-]{0,63}$", "label": {en, ar} }], 1–1000, values unique. The value is stored; the label can change later.',
  dependsOn:
    'Cascading choices: { "field": "<another choice question>", "options": { "<this option value>": ["<parent value>", ...] } }. An option not listed is always offered; nothing is offered until the parent is answered.',
  minSelected: 'Fewest choices that must be ticked.',
  maxSelected: 'Most choices that may be ticked.',
  allowNotApplicable: 'Adds "Not applicable" (value "not_applicable").',
  scale: 'The highest score, 3–10 (required on `rating`).',
  minFiles: 'Fewest photos/files.',
  maxFiles: 'Most photos/files (1–50).',
  maxFileBytes: 'Largest file in bytes.',
  acceptedTypes: 'Media types allowed, e.g. ["application/pdf", "image/*"].',
  maxAccuracyMeters: 'Refuse a location less accurate than this many metres (decimal text).',
};

export const EXPRESSION_NOTES: Readonly<Record<Expression['kind'], string>> = {
  text: '{ "kind": "text", "value": "fail" } — a text literal (also how a choice, yes/no or text answer is compared).',
  number: '{ "kind": "number", "value": "12.5" } — a number literal, written as decimal TEXT.',
  boolean: '{ "kind": "boolean", "value": true }',
  date: '{ "kind": "date", "value": "2026-11-01" }',
  time: '{ "kind": "time", "value": "08:00" }',
  datetime: '{ "kind": "datetime", "value": "2026-11-01T08:00:00.000Z" }',
  answer:
    '{ "kind": "answer", "field": "<question id>" } — the current answer; unknown while unanswered or hidden.',
  today: '{ "kind": "today" } — the date the form is filled (a date).',
  now: '{ "kind": "now" } — the moment the form is filled (a datetime). Version 2.',
  answered:
    '{ "kind": "answered", "field": "<id>" } — true/false, never unknown: the one way to test "left blank", and the only test for photo, file, signature and location answers.',
  includes:
    '{ "kind": "includes", "field": "<multi_select id>", "option": "<value>" } — whether a multi-select answer includes that option.',
  not: '{ "kind": "not", "operand": <condition> }',
  all: '{ "kind": "all", "operands": [<condition>, ...] } — AND.',
  any: '{ "kind": "any", "operands": [<condition>, ...] } — OR.',
  compare: `{ "kind": "compare", "operator": one of ${COMPARISON_OPERATORS.join('/')}, "left": <expr>, "right": <expr> } — both sides of one kind (text, number, date, time, datetime, boolean); lt/le/gt/ge need numbers, dates or times. Comparing a choice answer to a text that is not one of its option values is a publish error (catches typos).`,
  arithmetic: `{ "kind": "arithmetic", "operator": one of ${ARITHMETIC_OPERATORS.join('/')}, "left": <number>, "right": <number> } — nest them for brackets: (a + b) × c is multiply(add(a, b), c).`,
  round: `{ "kind": "round", "operand": <number>, "places": 0–${String(MAX_ROUND_PLACES)} } — half away from zero. Version 2.`,
  percentage:
    '{ "kind": "percentage", "part": <number>, "whole": <number> } — part ÷ whole × 100. Version 2.',
  statistic: `{ "kind": "statistic", "operator": one of ${STATISTIC_OPERATORS.join('/')}, "operands": [<number>, ...] } — 1–${String(MAX_STATISTIC_OPERANDS)} numbers; the unknown ones are skipped. Version 2.`,
  difference: `{ "kind": "difference", "unit": one of ${DURATION_UNITS.join('/')}, "from": <date|time|datetime>, "to": <same kind> } — to minus from, a number. Two times cannot be apart by days. Version 2.`,
  shift_date: `{ "kind": "shift_date", "operator": one of ${DATE_SHIFT_OPERATORS.join('/')}, "unit": one of ${DATE_STEP_UNITS.join('/')}, "date": <date>, "amount": <number> } — a date moved; a month keeps the day where it can. Version 2.`,
  count:
    '{ "kind": "count", "section": "<repeating section id>" } — how many entries (a number, 0 while hidden).',
  aggregate: `{ "kind": "aggregate", "operator": one of ${AGGREGATE_OPERATORS.join('/')}, "section": "<repeating section id>", "field": "<number question in it>" } — across the entries.`,
  some: '{ "kind": "some", "section": "<repeating section id>", "condition": <condition read per entry> } — true when it holds for at least one entry.',
  every:
    '{ "kind": "every", "section": "<repeating section id>", "condition": <condition read per entry> } — true when it holds for every entry.',
};

export const BLOCK_NOTES: Readonly<Record<BlockType, string>> = {
  heading: 'A title line, levels 1–3, with placeholders.',
  text: 'A paragraph with placeholders ({{answer.<id>}}, {{field.<key>}}, …); size small/normal/large, bold.',
  field:
    'One answer with its label: layout inline ("Label: answer"), stacked (label above) or value_only.',
  checkbox:
    'One printed tick box for a checkbox, yes/no or choice question; `option` says which option ticks it (yes/no default "yes").',
  options:
    'Every option of a choice, yes/no or checkbox question, each with its box ticked or not, in 1–4 columns.',
  fields_table:
    'A two-column table of label | answer for the questions in `rows` (questions outside repeating sections).',
  repeat_table:
    "A repeating section as a table: one row per entry, `columns` naming the section's own questions (width in %), optional row numbers.",
  static_table: 'A fixed table typed into the template (`header` and `rows` of texts), no answers.',
  image:
    'A picture: the company logo ({ "kind": "logo" }), a picture file of the template ({ "kind": "file", "fileId": "<uuid>" }), or a photo/signature answer ({ "kind": "answer", "fieldId": "<id>" }). `width` in mm.',
  qr: "A QR code that opens the document's online page; `size` in mm.",
  information:
    "One of the form's Information blocks (`informationId`), printed as the form shows it, only when it is shown for these answers.",
  divider: 'A horizontal line in the brand colour.',
  spacer: 'Empty space, `height` in mm.',
  page_break: 'Starts a new page. Not inside a row.',
  row: 'Two or three columns side by side: { "columns": [{ "width": 1–12 (relative), "blocks": [...] }, ...] }. Columns hold any block except row and page_break.',
};

export const BLOCK_OPTION_NOTES: Readonly<Record<string, string>> = {
  type: 'The block kind.',
  id: 'Unique within the template: ^[a-z0-9][a-z0-9_-]{0,63}$ (e.g. "title", "result_row").',
  colour: `Text colour from the palette: ${BLOCK_COLOURS.join(', ')} ("brand" is the template's brand colour).`,
  shaded: 'A light brand-tinted background behind the block.',
  text: 'Localised text {en, ar}; placeholders allowed.',
  level: 'Heading level 1, 2 or 3 (default 2).',
  align:
    'start, center or end (default start); start is the left in English and the right in Arabic.',
  size: 'text: small/normal/large; qr: millimetres 15–80.',
  bold: 'Bold text.',
  fieldId: "The question's answer key (id).",
  label: "Overrides the question's own label; absent = the form's label.",
  layout: 'inline, stacked or value_only.',
  option: 'Which option ticks the box (choice option value, or yes/no/not_applicable).',
  columns:
    'options: 1–4 columns; repeat_table: [{ "fieldId", "header"?, "width"? (5–100 %) }], 1–8; row: [{ "width", "blocks" }], 2–3.',
  title: 'A caption above a table.',
  rows: 'fields_table: [{ "fieldId", "label"? }] (1–100); static_table: [[{en,ar}, ...], ...].',
  sectionId: "The repeating section's id.",
  numbered: 'Numbers each row 1, 2, 3.',
  header: 'static_table: the header cells [{en, ar}, ...].',
  source:
    'image: { "kind": "logo" } | { "kind": "file", "fileId": "<uuid>" } | { "kind": "answer", "fieldId": "<photo or signature id>" }.',
  width: 'image: millimetres 5–190 (default 40); each photo of an answer is this wide.',
  caption: 'A line under the picture or QR code.',
  informationId: "The Information block's id in the form.",
  height: 'spacer: millimetres 1–150 (default 5).',
};

export const FONT_NOTES: Readonly<Record<DocumentFontKey, string>> = {
  'noto-sans':
    'Noto Sans + Noto Sans Arabic — plain, the default, and every template before 1.3.0.',
  'noto-naskh': 'Noto Serif + Noto Naskh Arabic — a traditional serif look.',
  'integr8-display':
    "Inter + IBM Plex Sans Arabic for text, Unbounded + Alexandria for headings — the Integr8 Media website's display look.",
  'integr8-text':
    "Inter + IBM Plex Sans Arabic throughout — the Integr8 Media website's text look.",
};

/** The placeholders a template's texts may use, by scope. */
export const PLACEHOLDERS: readonly { placeholder: string; meaning: string }[] = [
  {
    placeholder: '{{answer.<question id>}}',
    meaning: 'That answer, formatted as the document shows it (empty when unanswered).',
  },
  {
    placeholder: '{{field.<document field key>}}',
    meaning: 'A document field\'s value (see "fields" below).',
  },
  { placeholder: '{{company.name}}', meaning: "The company's name." },
  { placeholder: '{{form.title}}', meaning: "The form's title." },
  { placeholder: '{{submission.date}}', meaning: 'When the form was submitted.' },
  { placeholder: '{{submission.submitted_by}}', meaning: 'Who submitted it.' },
  { placeholder: '{{document.date}}', meaning: 'The date the PDF is made.' },
  { placeholder: '{{work_order.reference}}', meaning: "The job's reference number." },
  { placeholder: '{{asset.reference}}', meaning: "The asset's reference." },
  {
    placeholder: '{{page.number}} / {{page.count}}',
    meaning: "Header and footer texts only: this page's number, and how many pages.",
  },
];

// ---------------------------------------------------------------------------
// Reading the schemas
// ---------------------------------------------------------------------------

interface ObjectLike {
  shape: Record<string, z.ZodType>;
}

const optional = (schema: z.ZodType): boolean => schema.safeParse(undefined).success;

/** The properties of each question type, from `fieldSchema`. */
export function questionShapes(): { type: FieldType; required: string[]; optional: string[] }[] {
  return (fieldSchema.options as unknown as ObjectLike[]).map((option) => {
    const shape = option.shape;
    const keys = Object.keys(shape).filter((key) => key !== 'type');
    return {
      type: (shape.type as z.ZodLiteral<FieldType>).value,
      required: keys.filter((key) => !optional(shape[key]!)),
      optional: keys.filter((key) => optional(shape[key]!)),
    };
  });
}

/** The properties of each block kind, from `blockSchema`. */
export function blockShapes(): { type: BlockType; required: string[]; optional: string[] }[] {
  return (blockSchema.options as unknown as ObjectLike[]).map((option) => {
    const shape = option.shape;
    const keys = Object.keys(shape).filter((key) => key !== 'type');
    return {
      type: (shape.type as z.ZodLiteral<BlockType>).value,
      required: keys.filter((key) => !optional(shape[key]!)),
      optional: keys.filter((key) => optional(shape[key]!)),
    };
  });
}

/** Every expression kind the schema accepts. */
export function expressionKinds(): Expression['kind'][] {
  const union = (expressionSchema as unknown as { unwrap(): { options: ObjectLike[] } }).unwrap();
  return union.options.map(
    (option) => (option.shape.kind as z.ZodLiteral<Expression['kind']>).value,
  );
}

/** Every header/footer place kind the schema accepts. */
export function slotKinds(): string[] {
  return (headerFooterSlotSchema.options as unknown as ObjectLike[]).map(
    (option) => (option.shape.kind as z.ZodLiteral<string>).value,
  );
}

const list = (items: readonly string[]) => items.map((item) => `\`${item}\``).join(', ');

// ---------------------------------------------------------------------------
// The sections
// ---------------------------------------------------------------------------

function overview(): string {
  return `# Integr8 forms — overview and workflow

You are building a **form** for Integr8 Plus, a field-service platform used in Egypt in **English and Arabic**. Engineers fill forms on a phone (offline), the office on the web or desktop. A form may have **PDF templates** that print a submission as a certificate or report. Your output is one \`.integr8form\` file that Integr8 staff import into a company (as a new draft) or into the shared library.

## Workflow

1. Read the sections you need: \`questions\`, \`logic\`, \`calculations\`, \`repeating_sections\`, \`information\`, \`languages\`, \`pdf_templates\`, \`limits\`. Look at real examples with \`list_examples\` / \`get_example\` before writing from scratch.
2. Write the **form definition** (JSON). Validate it with \`check_form\` and fix every problem; repeat until it says the form would publish.
3. Optionally write **PDF templates** (JSON designs) that print the form's answers. Validate them with \`check_package\` (form + templates + picture files).
4. Look at a template with \`preview_pdf\`: it prints the design with sample answers in the machine's Chrome/Edge and shows you the page images. Fix what looks wrong.
5. Save with \`save_package\`. It writes \`<output folder>/<title>.integr8form\` and reports the same check again. To change an existing file, \`open_package\` it, edit, and \`save_package\` (with \`overwrite: true\` to replace it).

## The form definition at a glance

\`\`\`json
{
  "schemaVersion": 1,
  "title": { "en": "Boiler service", "ar": "صيانة الغلاية" },
  "pages": [
    {
      "id": "inspection",
      "title": { "en": "Inspection", "ar": "الفحص" },
      "sections": [
        {
          "id": "appliance",
          "title": { "en": "Appliance", "ar": "الجهاز" },
          "fields": [
            { "id": "serial_number", "type": "barcode", "label": { "en": "Serial number", "ar": "الرقم التسلسلي" }, "required": true },
            { "id": "result", "type": "radio", "label": { "en": "Result", "ar": "النتيجة" }, "required": true,
              "options": [ { "value": "pass", "label": { "en": "Pass", "ar": "ناجح" } }, { "value": "fail", "label": { "en": "Fail", "ar": "راسب" } } ] }
          ]
        }
      ]
    }
  ]
}
\`\`\`

- A form has 1–${String(LIMITS.pages)} **pages**; a page has an \`id\`, optional \`title\`, \`description\` and \`visibleWhen\`, and 1+ **sections**; a section has an \`id\`, optional \`title\`, \`description\`, \`visibleWhen\`, \`repeat\`, and \`fields\`: its **questions** and **Information blocks** in reading order. Sections do not nest.
- Every object is **strict**: an unknown property is an error. Ids are \`^[a-z][a-z0-9_]{0,63}$\` and unique across the whole form.
- \`schemaVersion\` is the lowest format that has everything the form uses: **2** when it has Information blocks, page/section descriptions, or version-2 calculations (\`now\`, \`round\`, \`percentage\`, \`statistic\`, \`difference\`, \`shift_date\`, a calculated date); otherwise **1**. The tools set it for you when saving; \`check_form\` reports \`schema_version_too_low\` if you wrote it by hand too low. Phones older than 1.3.0 are asked to update before opening a version 2 form, so prefer version 1 features when they do the job. This engine reads versions ${String(DEFINITION_SCHEMA_VERSION)} and below.
- Settings outside the definition (\`save_package\` → \`settings\`): \`fillRoles\` — who may fill the form (default ${list(DEFAULT_FILL_ROLES)}; also \`hr_manager\`, \`inventory_manager\`), and \`signatureRequired\` — whether a job using it needs a signature before closing (default false).
- A file never holds answers, customers, jobs, company branding or people. It is checked strictly when imported; anything \`check_package\` reports would be refused or would block publishing.

## Good forms

- Ask what an engineer can answer on site, in the order they work. Group questions into sections by place or task; use pages for big steps.
- Prefer choices (\`radio\` for 2–5 options, \`dropdown\` for more) over free text where the answer is one of a known set: they print and report better.
- Use \`required\` for what the job cannot close without; \`requiredWhen\` for "explain why when Fail"; \`visibleWhen\` to hide follow-ups.
- Give every text in English and Arabic (see \`languages\`). Keep labels short; put guidance in \`help\` or an Information block.
- Units belong in \`unit\`, not in the label.
`;
}

function questions(): string {
  const shapes = questionShapes();
  const rows = FIELD_TYPES.map((description) => {
    const shape = shapes.find((entry) => entry.type === description.type);
    const own = (shape?.required ?? []).filter((key) => !['id', 'label'].includes(key));
    return `| \`${description.type}\` | ${description.purpose} | ${description.valueType} | ${description.calculable ? 'yes' : 'no'} | ${own.length === 0 ? '—' : list(own)} | ${QUESTION_NOTES[description.type]} |`;
  });
  const perType = shapes.map(
    (shape) =>
      `- \`${shape.type}\`: required ${list(shape.required)}; optional ${list(shape.optional)}.`,
  );
  const allKeys = [...new Set(shapes.flatMap((shape) => [...shape.required, ...shape.optional]))];
  return `# Question types (${String(FIELD_TYPES.length)})

| type | purpose | value in rules | calculable | must also have | notes |
| --- | --- | --- | --- | --- | --- |
${rows.join('\n')}

## Every property, per type

${perType.join('\n')}

## What each property means

${allKeys.map((key) => `- \`${key}\`: ${QUESTION_OPTION_NOTES[key] ?? '(see the JSON Schema)'}`).join('\n')}

## Configuration checks

- \`min\` ≤ \`max\`, \`minLength\` ≤ \`maxLength\`, \`minSelected\` ≤ \`maxSelected\`, \`minFiles\` ≤ \`maxFiles\`; a \`default\` must itself be a valid answer.
- A calculated question cannot be \`required\`, have \`requiredWhen\`, a \`default\` or \`carryOver\`.
- Option values are unique per question and never change once used; change the label instead.
`;
}

function logic(): string {
  return `# Rules

Rules are **expressions**: small JSON trees, never code strings. A condition must produce true or false. Three-valued: while an answer it reads is missing, a condition is *unknown*, and unknown counts as **not shown** for \`visibleWhen\` and **not required** for \`requiredWhen\`. Use \`answered\` to test "left blank" explicitly.

## Where conditions go

- \`visibleWhen\` on a page, section, question or Information block: shown only while true. Answers to hidden questions are dropped on submit.
- \`requiredWhen\` on a question: required while true (on top of \`required\`).
- \`rules\` on a question: \`[{ "id": "temp_range", "assert": <condition>, "message": { "en": "...", "ar": "..." } }]\` — the answer is refused while \`assert\` is definitely false.
- \`dependsOn\` on a dropdown/radio/multi_select: cascading choices from another choice question (see \`questions\`).

## Example: "Reason for failure" shown and required when Result is Fail

\`\`\`json
{
  "id": "failure_reason", "type": "long_text",
  "label": { "en": "Reason for failure", "ar": "سبب الرسوب" },
  "visibleWhen": { "kind": "compare", "operator": "eq", "left": { "kind": "answer", "field": "result" }, "right": { "kind": "text", "value": "fail" } },
  "requiredWhen": { "kind": "compare", "operator": "eq", "left": { "kind": "answer", "field": "result" }, "right": { "kind": "text", "value": "fail" } }
}
\`\`\`

## Value kinds in rules

Each question contributes a value kind (the "value in rules" column in \`questions\`): text (text, long_text, barcode, dropdown, radio, yes_no), number (number, decimal, rating), date, time, datetime, boolean (checkbox), options (multi_select — use \`includes\`), opaque (signature, photo, file, gps — only \`answered\`). \`compare\` needs both sides of the same kind; a choice is compared with a \`text\` literal holding an option **value** (a typo is a publish error, \`unknown_option\`); yes/no with "yes", "no" or "not_applicable".

## Every expression kind (${String(expressionKinds().length)})

${expressionKinds()
  .map(
    (kind) =>
      `- \`${kind}\`${VERSION_2_EXPRESSION_KINDS.has(kind) ? ' (version 2)' : ''}: ${EXPRESSION_NOTES[kind]}`,
  )
  .join('\n')}

## Common mistakes the checker reports

- \`unknown_field\`: an expression names an id that is not a question (or names a section where a question is needed).
- \`type_mismatch\`: comparing a number with text, a condition that is not true/false, a calculation of the wrong kind.
- \`circular_dependency\`: a question's visibility or calculation depends on itself through others.
- \`inside_repeat\` / \`not_in_section\`: reading a repeating section's question from outside it without \`count\`/\`aggregate\`/\`some\`/\`every\`.
`;
}

function calculations(): string {
  return `# Calculations

A \`number\` or \`decimal\` question (and, in version 2, a \`date\` question) may have a \`calculation\`: an expression the form works out instead of a person typing it. It recalculates as answers change, on the phone too, offline. The result must be of the question's kind (number for number/decimal, date for date); a decimal result is rounded to the question's \`decimalPlaces\`.

Numbers are exact decimals, never floating point. Literals are text: \`{ "kind": "number", "value": "1.5" }\`.

## Number formulas

- Arithmetic: ${list(ARITHMETIC_OPERATORS)}; nest nodes for brackets and order.
- \`round\` to 0–${String(MAX_ROUND_PLACES)} places, \`percentage\` (part ÷ whole × 100), \`statistic\` ${list(STATISTIC_OPERATORS)} of up to ${String(MAX_STATISTIC_OPERANDS)} numbers (unknown ones skipped) — version 2.
- Across a repeating section: \`count\`, \`aggregate\` ${list(AGGREGATE_OPERATORS)} of a number question in it.

\`\`\`json
{ "id": "average_temp", "type": "decimal", "decimalPlaces": 1, "unit": "°C",
  "label": { "en": "Average temperature", "ar": "متوسط درجة الحرارة" },
  "calculation": { "kind": "statistic", "operator": "average", "operands": [
    { "kind": "answer", "field": "temp_1" }, { "kind": "answer", "field": "temp_2" }, { "kind": "answer", "field": "temp_3" } ] } }
\`\`\`

\`\`\`json
{ "id": "total_cost", "type": "decimal", "decimalPlaces": 2, "unit": "EGP",
  "label": { "en": "Total", "ar": "الإجمالي" },
  "calculation": { "kind": "round", "places": 2, "operand": { "kind": "arithmetic", "operator": "multiply",
    "left": { "kind": "arithmetic", "operator": "add", "left": { "kind": "answer", "field": "parts_cost" }, "right": { "kind": "answer", "field": "labour_cost" } },
    "right": { "kind": "number", "value": "1.14" } } } }
\`\`\`

## Date and time formulas (version 2)

- \`difference\` in ${list(DURATION_UNITS)} between two dates, two times or two datetimes → a number (times: minutes or hours only).
- \`shift_date\` ${list(DATE_SHIFT_OPERATORS)} a number of ${list(DATE_STEP_UNITS)} to a date → a date. Put it on a \`date\` question.
- \`today\` (a date) and \`now\` (a datetime) are supplied by the device filling the form.

\`\`\`json
{ "id": "next_service", "type": "date", "label": { "en": "Next service due", "ar": "موعد الصيانة القادمة" },
  "calculation": { "kind": "shift_date", "operator": "add", "unit": "months", "date": { "kind": "answer", "field": "serviced_on" }, "amount": { "kind": "number", "value": "12" } } }
\`\`\`

\`\`\`json
{ "id": "hours_on_site", "type": "decimal", "decimalPlaces": 2, "unit": "h", "label": { "en": "Hours on site", "ar": "ساعات العمل بالموقع" },
  "calculation": { "kind": "difference", "unit": "hours", "from": { "kind": "answer", "field": "arrived" }, "to": { "kind": "answer", "field": "left_site" } } }
\`\`\`

A calculation may also be used in a condition (e.g. \`compare\` a \`difference\` with a number).
`;
}

function repeating(): string {
  return `# Repeating sections

A section with \`repeat\` asks its questions once per thing found on site — every appliance, every radiator, every defect.

\`\`\`json
{ "id": "appliances", "title": { "en": "Appliances", "ar": "الأجهزة" },
  "repeat": { "minEntries": 1, "maxEntries": 20, "entryLabel": { "en": "Appliance", "ar": "جهاز" }, "titleField": "make" },
  "fields": [
    { "id": "make", "type": "text", "label": { "en": "Make", "ar": "الماركة" }, "required": true },
    { "id": "flue_ok", "type": "yes_no", "label": { "en": "Flue OK?", "ar": "هل المدخنة سليمة؟" } }
  ] }
\`\`\`

- \`maxEntries\` 1–${String(LIMITS.entriesPerSection)} (required), \`minEntries\` optional, \`entryLabel\` names one entry ("Appliance 1"), \`titleField\` (a text-like question of the section) names each entry in lists.
- Its questions are answered **per entry**. A rule inside the section reads that entry's answers and anything outside the section. From outside, read the entries only through \`count\`, \`aggregate\` (sum/min/max of a number question), \`some\` and \`every\`:

\`\`\`json
{ "kind": "some", "section": "appliances", "condition": { "kind": "compare", "operator": "eq", "left": { "kind": "answer", "field": "flue_ok" }, "right": { "kind": "text", "value": "no" } } }
\`\`\`

- Sections do not nest, so neither do entries. \`dependsOn\` between choices works only within the same entry.
- In a PDF template a repeating section prints with a \`repeat_table\` block; its questions cannot be used by single-answer blocks.
`;
}

function information(): string {
  const shape = (informationSchema as unknown as ObjectLike).shape;
  return `# Information blocks and descriptions (version 2)

## Information block

Text that is not a question — "Isolate the supply before opening the casing" — placed among a section's questions in \`fields\`, where it should appear:

\`\`\`json
{ "id": "isolate_first", "type": "information", "style": "warning",
  "heading": { "en": "Safety first", "ar": "السلامة أولاً" },
  "body": { "en": "Isolate the supply before opening the casing.", "ar": "افصل مصدر التغذية قبل فتح الغلاف." } }
\`\`\`

- Properties: ${list(Object.keys(shape))}. \`body\` is required; \`style\` is one of ${list(INFORMATION_STYLES)} (default plain).
- Plain text only: line breaks are kept; nothing is HTML or Markdown.
- It follows \`visibleWhen\` like a question, never has an answer, and shares the id namespace with questions.
- It prints on a PDF only where a template places an \`information\` block naming it.

## Descriptions

A page or a section may have \`description\`: a line or two under its title, \`{ "en": "...", "ar": "..." }\`.

Both need \`schemaVersion: 2\`; phones older than 1.3.0 are asked to update before opening such a form.
`;
}

function languages(): string {
  return `# English and Arabic

Every text is a localised object: \`{ "en": "Serial number", "ar": "الرقم التسلسلي" }\`. **Always write both.** Companies work in both languages; a text with no Arabic (or no English) is a \`translation_missing\` warning — it does not block, but staff must fix it before the form is useful in that language.

- Texts that are localised: form \`title\`; page and section \`title\` and \`description\`; question \`label\` and \`help\`; option \`label\`; rule \`message\`; pattern \`message\`; \`entryLabel\`; Information \`heading\` and \`body\`; every text in a PDF template (headings, text blocks, labels, table headers and cells, captions, header/footer texts, document field labels).
- Not localised: ids, option values, \`unit\`, numbers, dates.
- Write natural Modern Standard Arabic as used in Egyptian business documents, not a word-for-word translation. Keep technical terms people use on site (e.g. "PH", model codes) as they are.
- The Arabic form is shown right-to-left automatically; never add direction marks or HTML.
- In a PDF template, \`page.language\` (\`en\`, \`ar\` or null = the company's language) chooses which text prints; a template meant for both should have both texts everywhere.
`;
}

function pdfTemplates(): string {
  const shapes = blockShapes();
  const keys = [...new Set(shapes.flatMap((shape) => [...shape.required, ...shape.optional]))];
  return `# PDF templates

A PDF template prints one submission of the form as a document (a certificate, a report). It is a **design**: page settings, a style, optional document fields, and a column of **blocks** on A4 pages (portrait or landscape). It names the form's questions by id, never by label. Design format version: **${String(DESIGN_SCHEMA_VERSION)}**.

\`\`\`json
{
  "schemaVersion": 2,
  "page": {
    "size": "A4", "orientation": "portrait",
    "margins": { "top": 28, "end": 15, "bottom": 20, "start": 15 },
    "background": null, "firstPage": null, "language": null, "fontSize": 10,
    "header": { "start": { "kind": "logo", "height": 11 }, "center": { "kind": "text", "text": { "en": "Job {{work_order.reference}}", "ar": "أمر العمل {{work_order.reference}}" }, "bold": true }, "end": { "kind": "page" }, "notOnFirstPage": false },
    "footer": { "start": { "kind": "text", "text": { "en": "{{company.name}}", "ar": "{{company.name}}" }, "bold": false }, "center": null, "end": { "kind": "page" }, "notOnFirstPage": false }
  },
  "style": { "brandColour": "company", "font": "integr8-text", "tableLines": "light", "stripedRows": true, "headerShading": true },
  "fields": [],
  "blocks": [
    { "type": "heading", "id": "title", "text": { "en": "Service certificate", "ar": "شهادة صيانة" }, "level": 1 },
    { "type": "field", "id": "serial", "fieldId": "serial_number", "layout": "inline" },
    { "type": "options", "id": "result", "fieldId": "result", "columns": 2 },
    { "type": "image", "id": "signature", "source": { "kind": "answer", "fieldId": "customer_signature" }, "width": 60 }
  ]
}
\`\`\`

## Page (\`page\`)

- \`size\`: always "A4". \`orientation\`: "portrait" (210 × 297 mm) or "landscape" (297 × 210 mm) — landscape suits wide repeat tables; a landscape background picture should be 3508 × 2480 px (portrait 2480 × 3508).
- \`margins\`: \`top\`, \`end\`, \`bottom\`, \`start\` in mm, 0–60 each (start/end mirror in Arabic). Leave room for the header (top ≥ ~25 mm with a logo header).
- \`background\`: \`{ "fileId": "<uuid>" }\` or null — a picture drawn edge to edge behind every page (a letterhead). \`firstPage\`: null when the first page is like the others, or \`{ "background": { "fileId" } | null, "topMargin": mm | null }\` for a different first page.
- \`language\`: "en", "ar" or null (the company's language). \`fontSize\`: base points 7–16 (default 10).
- \`header\` (or null) and \`footer\`: three places each, \`start\`, \`center\`, \`end\` (mirrored in Arabic), each null or one of ${list(slotKinds())}:
  - \`{ "kind": "logo", "height": 4–40 mm }\` — the company's logo (from the importing company's branding).
  - \`{ "kind": "text", "text": {en, ar}, "bold": bool }\` — with placeholders, including \`{{page.number}}\` and \`{{page.count}}\`.
  - \`{ "kind": "page" }\` — "Page 2 of 5" in the document's language.
  - \`notOnFirstPage\`: leave it off the first page (a cover or letterhead).

## Style (\`style\`)

- \`brandColour\`: "company" (the company's accent colour at printing), a "#rrggbb" of its own, or null for black. Used for headings, table header rows and dividers.
- \`font\`: one of ${list(DOCUMENT_FONT_KEYS)}:
${DOCUMENT_FONT_KEYS.map((key) => `  - \`${key}\`: ${FONT_NOTES[key]}`).join('\n')}
- \`tableLines\`: none / light / strong; \`stripedRows\`: bool; \`headerShading\`: bool.

## Blocks (${String(shapes.length)})

${shapes
  .map(
    (shape) =>
      `- \`${shape.type}\`: ${BLOCK_NOTES[shape.type]} Required: ${shape.required.length === 0 ? '—' : list(shape.required)}; optional: ${shape.optional.length === 0 ? '—' : list(shape.optional)}.`,
  )
  .join('\n')}

### Block properties

${keys.map((key) => `- \`${key}\`: ${BLOCK_OPTION_NOTES[key] ?? '(see the JSON Schema)'}`).join('\n')}

### Which questions a block may show

- \`field\`, \`fields_table\` rows, \`{{answer.<id>}}\`: any question **outside** repeating sections.
- \`checkbox\`, \`options\`: checkbox, yes/no or a choice question (with a real option value).
- \`image\` with an answer source: a photo or signature question.
- \`repeat_table\`: a repeating section, columns of that section's own questions.
- \`information\`: an Information block of the form.
A block naming a missing question, a question in the wrong place or of the wrong kind is a problem (\`unknown_field\`, \`outside_section\`, \`wrong_field_type\`, \`unknown_option\`, \`not_repeating\`).

## Placeholders in texts

${PLACEHOLDERS.map((entry) => `- \`${entry.placeholder}\`: ${entry.meaning}`).join('\n')}

An unknown placeholder prints as written; a missing answer prints nothing.

## Document fields (\`fields\`)

Up to ${String(DESIGN_LIMITS.fields)} values the document carries and the register searches: \`{ "key": "certificate", "label": {en, ar}, "source": ..., "lookup": "none" | "key" | "confirm" }\`, where \`source\` is \`{ "kind": "typed", "required": bool, "maxLength": 1–500 }\` (typed by the person making the PDF, e.g. a certificate number), \`{ "kind": "answer", "fieldId": "<id>" }\`, or \`{ "kind": "submission", "value": "form_title" | "submitted_date" | "submitted_by" | "work_order_reference" | "asset_reference" | "document_date" }\`. Print one with \`{{field.<key>}}\`. \`lookup\` lets the company's website find the document by it (at most one "key" and one "confirm").

## Pictures

A picture a template uses (background or image block) is a PNG, JPEG or WebP file in the package, named by a lowercase UUID \`fileId\`. Get ids from \`new_picture_ids\`, use them in the design, and pass the same ids with the files' paths to \`check_package\`, \`preview_pdf\` and \`save_package\`. Every picture must be used by a template; the company logo is never a file (\`{ "kind": "logo" }\`).
`;
}

function limits(): string {
  const package_ = FORM_PACKAGE_LIMITS;
  return `# Limits

## Form

- Pages ${String(LIMITS.pages)}; sections per page ${String(LIMITS.sectionsPerPage)}; items per section ${String(LIMITS.fieldsPerSection)}; questions in total ${String(LIMITS.fieldsTotal)}.
- An expression: at most ${String(LIMITS.expressionNodes)} nodes and ${String(LIMITS.expressionDepth)} levels deep.
- Entries per repeating section: ${String(LIMITS.entriesPerSection)}. Options per choice: 1,000. Rules per question: 50.

## PDF template

- Blocks ${String(DESIGN_LIMITS.blocks)} (rows' blocks included); document fields ${String(DESIGN_LIMITS.fields)}; row columns ${String(DESIGN_LIMITS.rowColumns)}; table rows ${String(DESIGN_LIMITS.tableRows)}; table columns ${String(DESIGN_LIMITS.tableColumns)}; characters per text ${String(DESIGN_LIMITS.textLength)}; header/footer text 500.

## The .integr8form file

- File ${String(package_.fileBytes / 1024 / 1024)} MB; everything unpacked ${String(package_.totalBytes / 1024 / 1024)} MB; form.json ${String(package_.formBytes / 1024 / 1024)} MB; one template ${String(package_.templateBytes / 1024 / 1024)} MB.
- PDF templates ${String(package_.templates)}; pictures ${String(package_.files)}, each at most ${String(package_.imageBytes / 1024 / 1024)} MB and ${String(package_.imageSide)} px a side, PNG/JPEG/WebP only (no SVG, GIF, HEIC).
`;
}

function jsonSchema(): string {
  const form = z.toJSONSchema(formDefinitionSchema, { io: 'input', unrepresentable: 'any' });
  const design = z.toJSONSchema(designSchema, { io: 'input', unrepresentable: 'any' });
  return `# JSON Schemas

Generated from the schemas Integr8 Plus validates with. The checker (\`check_form\`, \`check_package\`) is the authority: it also checks references, types in rules and the rest the schemas cannot say.

## Form definition

\`\`\`json
${JSON.stringify(form)}
\`\`\`

## PDF template design

\`\`\`json
${JSON.stringify(design)}
\`\`\`
`;
}

const BUILDERS: Readonly<Record<GuideSection, () => string>> = {
  overview,
  questions,
  logic,
  calculations,
  repeating_sections: repeating,
  information,
  languages,
  pdf_templates: pdfTemplates,
  limits,
  json_schema: jsonSchema,
};

/** One section of the guide, as Markdown. */
export function guideSection(section: GuideSection): string {
  return BUILDERS[section]();
}

/** The table of contents shown with the overview. */
export function guideContents(): string {
  return `## Sections (call get_format_guide with "section")\n\n${GUIDE_SECTIONS.map((section) => `- \`${section}\`: ${SECTION_TITLES[section]}`).join('\n')}\n`;
}
