# The `.integr8form` file

One form, its PDF templates and their pictures in a single file, so a form can move between
companies and between Integr8 Plus servers (form builder decision 14) and so the forms AI tool
can write one for staff to import (decision 15). This page is the format's specification: a
person or a tool that follows it produces a file Integr8 Plus accepts.

The code is `@integr8/form-package` (`packages/form-package`): `packFormPackage` writes a file,
`unpackFormPackage` reads and checks one, `checkFormPackage` says whether its form would publish
and its templates would save. Anything that writes these files should use `packFormPackage`
rather than zipping by hand; it refuses what `unpackFormPackage` would refuse.

What a file **never** holds: submissions, answers, customers, sites, jobs, job type links,
company branding, people, or any id of the company it came from. The only ids in a file are the
form's own answer keys, its PDF blocks' ids and its pictures' ids.

## Layout

A `.integr8form` file is a ZIP (plain ZIP 2.0: no ZIP64, no encryption, entries stored or
deflated, UTF-8 names) holding exactly these entries:

```
manifest.json                 what the file is and what is in it
form.json                     the form definition and its settings
templates/1.json              the first PDF template (if any)
templates/2.json              …numbered from 1, no gaps, no leading zeros, at most 50
files/<uuid>.png              a picture a template uses (.png, .jpg or .webp)
```

Folder entries `templates/` and `files/` are allowed (some ZIP tools add them) and ignored.
Nothing else may be in the file: another name, a second copy of a name (in any letter case), an
absolute path, `..`, `.` or an empty part, a backslash, a drive letter or a control character
is refused. Every template and picture must be listed in the manifest, and everything the
manifest lists must be there.

The media type is `application/vnd.integr8.form+zip`; the extension is `.integr8form`.

## `manifest.json`

Every object is **strict**: a key not described here is refused (a newer file says so with
`formatVersion` instead, see Versioning).

```json
{
  "format": "integr8form",
  "formatVersion": 1,
  "createdBy": { "app": "integr8-plus", "version": "1.3.0" },
  "createdAt": "2026-11-01T09:30:00.000Z",
  "form": {
    "title": { "en": "Boiler service", "ar": "صيانة الغلاية" },
    "schemaVersion": 1,
    "source": "published",
    "versionNumber": 3
  },
  "templates": [{ "path": "templates/1.json", "name": "Service report" }],
  "files": [
    {
      "id": "0b5f3c2e-8f4d-4a1b-9c3e-2d7f6a5b4c3d",
      "path": "files/0b5f3c2e-8f4d-4a1b-9c3e-2d7f6a5b4c3d.png",
      "contentType": "image/png",
      "bytes": 78,
      "sha256": "…64 lower-case hex digits…"
    }
  ]
}
```

| Field                  | Rule                                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `format`               | Always `"integr8form"`.                                                                                   |
| `formatVersion`        | `1`. See Versioning.                                                                                      |
| `createdBy.app`        | `"integr8-plus"` (exported from Integr8 Plus) or `"integr8-forms-ai"` (written by the forms AI tool).     |
| `createdBy.version`    | The writer's version, `MAJOR.MINOR.PATCH` with an optional `-suffix`.                                     |
| `createdAt`            | ISO 8601 date and time with a zone (`Z` or `+02:00`).                                                     |
| `form.title`           | The form's title in at least one language (`{ "en": …, "ar": … }`); the same as the definition's `title`. |
| `form.schemaVersion`   | The form format of the definition in `form.json`; must equal its `schemaVersion`.                         |
| `form.source`          | `"published"` (a published version was exported) or `"draft"` (a draft, or anything the AI tool wrote).   |
| `form.versionNumber`   | Optional; the published version's number when `source` is `"published"`.                                  |
| `templates[i].path`    | Exactly `templates/<i+1>.json`, in order.                                                                 |
| `templates[i].name`    | 1–120 characters; the same as the `name` inside that entry.                                               |
| `files[i].id`          | A UUID in lower case, the id the templates' designs use for the picture (`fileId`). Each id once.         |
| `files[i].path`        | Exactly `files/<id>.<ext>`, the extension `png`, `jpg` or `webp` matching `contentType`.                  |
| `files[i].contentType` | `image/png`, `image/jpeg` or `image/webp`.                                                                |
| `files[i].bytes`       | The picture's exact length in bytes.                                                                      |
| `files[i].sha256`      | The SHA-256 of the picture's bytes, lower-case hexadecimal.                                               |

## `form.json`

```json
{
  "definition": { "schemaVersion": 1, "title": { "en": "…", "ar": "…" }, "pages": [ … ] },
  "settings": { "fillRoles": ["owner", "admin", "dispatcher", "engineer", "viewer"], "signatureRequired": false }
}
```

- **`definition`** is a form definition exactly as the form builder stores it
  (`@integr8/form-engine`: `FormDefinition` in `packages/form-engine/src/definition.ts`, the
  question types in `field-types.ts`, Information blocks in `information.ts`, rules and
  calculations in `expression.ts`). In short: `schemaVersion` (1 or 2), `title`, and `pages`;
  a page has an `id`, an optional `title` and `description`, an optional `visibleWhen` and its
  `sections`; a section has an `id`, optional `title`, `description`, `visibleWhen` and
  `repeat`, and `fields` — its questions and Information blocks in reading order. Ids (answer
  keys) are `^[a-z][a-z0-9_]{0,63}$` and unique in the form; texts are
  `{ "<language>": "<text>" }` with `en` and `ar`. The 18 question types are `text`,
  `long_text`, `barcode`, `number`, `decimal`, `rating`, `date`, `time`, `datetime`,
  `dropdown`, `radio`, `multi_select`, `checkbox`, `yes_no`, `signature`, `photo`, `file`,
  `gps`. The six library forms in `packages/form-engine/src/templates/` are complete examples.
- **`schemaVersion`** is the lowest format that has everything the definition uses: 2 when it
  has Information blocks, page or section descriptions, or the 1.3.0 calculations (dates, times,
  brackets); otherwise 1. `packFormPackage` sets it, as the API does when a draft is saved; a
  hand-written file must get it right (`checkFormPackage` reports `schema_version_too_low`).
- **Reading a file only needs a draft**: `definition` must be a JSON object with a whole-number
  `schemaVersion` the engine reads. A half-built form imports as a draft. **Publishing needs the
  whole form to compile**; `checkFormPackage` runs that compile and lists every problem.
- **`settings`** are what a form has outside its versions, the same ones Copy to another company
  copies: `fillRoles`, the roles that may fill the form (at least one, each once, from `owner`,
  `admin`, `hr_manager`, `inventory_manager`, `dispatcher`, `engineer`, `viewer`), and
  `signatureRequired`, whether a job using the form needs a signature before it can close.
  `packFormPackage` defaults them to the database's defaults: every role but `hr_manager` and
  `inventory_manager`, no signature.

## `templates/<n>.json`

```json
{ "name": "Service report", "design": { "schemaVersion": 2, "page": { … }, "style": { … }, "fields": [], "blocks": [ … ] } }
```

- **`name`**: 1–120 characters, the same as the manifest's.
- **`design`**: a PDF template design as the PDF designer stores it (`@integr8/document-render`:
  `designSchema` in `packages/document-render/src/design.ts`, header and footer places in
  `look.ts`). Blocks are `heading`, `text`, `field`, `checkbox`, `options`, `fields_table`,
  `repeat_table`, `static_table`, `image`, `qr`, `information`, `divider`, `spacer`,
  `page_break` and `row` (two or three columns of the others). A design names the form's
  questions by answer key (`fieldId`), repeating sections by `sectionId`, Information blocks by
  `informationId`, and `{{answer.<key>}}` placeholders in texts. The current design format is
  **2**; a version 1 design is accepted and upgraded on reading, printing exactly as before.
- **Pictures**: a design uses a picture by its id, `{ "fileId": "<uuid>" }`, as a page
  background (`page.background`, `page.firstPage.background`) or an image block
  (`"source": { "kind": "file", "fileId": "<uuid>" }`). Every id a design names anywhere
  (`fileId` keys) must be one of the manifest's files, and every file must be used by at least
  one template. Two templates may share a picture; on import each gets its own copy under a new
  id. The company logo is not a file: it is `{ "kind": "logo" }` and comes from the importing
  company's branding.

A template is checked against the form exactly as the API checks one when it is saved: every
question it names exists, outside a repeating section unless it is a column of that section's
table, and is of a kind the block can show (a picture block shows a photo or signature answer,
check boxes a checkbox, yes/no or choice question with a real option, and so on).

## `files/<id>.<ext>`

The pictures, byte for byte. A picture must be a real PNG, JPEG or WebP: its first bytes must say
so, they must agree with its extension and content type, and its width and height must be
readable, non-zero and at most 10,000 pixels each. SVG, GIF, HEIC and anything else are refused,
as is a PNG named `.jpg`.

## Limits

| What                          | Limit                           |
| ----------------------------- | ------------------------------- |
| The file                      | 50 MB                           |
| Everything inflated, together | 150 MB                          |
| Entries (folders included)    | 260                             |
| `manifest.json`               | 256 KB                          |
| `form.json`                   | 4 MB                            |
| One `templates/<n>.json`      | 2 MB                            |
| One picture                   | 25 MB, at most 10,000 px a side |
| PDF templates / pictures      | 50 / 200                        |
| JSON nesting                  | 200 levels                      |

Sizes are checked from what each entry declares before anything is inflated, and inflating
stops the moment an entry passes its declared size, so a ZIP bomb is refused cheaply. The form
engine's own limits (pages, sections, questions, rule complexity) and the designer's (300 blocks,
20 document fields, 4,000 characters a text) apply on top, as everywhere else.

## Errors

Reading a file refuses the first thing wrong with a `FormPackageError`: a stable `code`, a
`message` for a person, and `problems`, each `{ entry, path, code, message }` — the entry
(`manifest.json`, `form.json`, `templates/2.json`, `files/<id>.png`, or empty for the ZIP
itself), the place inside its JSON (`definition.pages[0].title`, `design.blocks.heading_1`), and
a finer code.

| Code                       | Means                                                                                                                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `package_invalid`          | Not a ZIP this format allows (damaged, ZIP64, encrypted, overlapping entries, bad checksum), no or a broken manifest, or a manifest that disagrees with the entries.                                                 |
| `package_too_large`        | Past a limit above: the file, an entry, everything inflated, too many entries, templates or pictures.                                                                                                                |
| `package_too_new`          | Made by a newer Integr8 Plus: `formatVersion`, the form's `schemaVersion` or a design's `schemaVersion` is newer than this server reads. Update first.                                                               |
| `package_entry_unexpected` | An entry the format has no place for (`unknown_entry`), one not in the manifest (`unlisted_entry`), an unsafe name (`unsafe_path`), a name twice (`duplicate_entry`), or a picture no template uses (`file_unused`). |
| `package_file_mismatch`    | A picture whose length (`file_size`) or SHA-256 (`file_hash`) differs from the manifest, or one a template uses that is not there (`file_missing`).                                                                  |
| `package_image_invalid`    | A picture that is not a readable PNG, JPEG or WebP, not the kind its name or content type says, or too large in pixels.                                                                                              |
| `package_form_invalid`     | `form.json` is not `{ definition, settings }`, the definition has no usable `schemaVersion`, or the settings are wrong.                                                                                              |
| `package_template_invalid` | A template without a valid name, or whose design the PDF designer cannot read; each designer issue is a problem with its path.                                                                                       |

`checkFormPackage` does not throw. It returns `{ ok, problems, warnings }`: `problems` are what
would stop publishing the form (the engine's codes, e.g. `duplicate_id`, `unknown_field`,
`circular_dependency`, `schema_version_too_low`, at `form.json` / `definition.<path>` with the
`elements` involved) or saving a template against it (the designer's codes, e.g.
`unknown_field`, `wrong_field_type`, `unknown_option`, `not_repeating`, `outside_section`, at
`templates/<n>.json` / `design.blocks.<block id>`), plus `file_missing` and `file_unused` when
pictures are given. `warnings` stop nothing: `translation_missing` (a text with no English or no
Arabic), `title_mismatch` (manifest and definition titles differ), `templates_not_checked` (the
form has problems, so its templates could not be checked against it).

## Versioning

Three version numbers, each refused when newer than the reader knows:

- **`formatVersion`** (this file's layout and manifest): 1. It is raised whenever the layout or
  the manifest changes, including a new optional field, because readers are strict. A reader
  checks it before anything else, so a newer file is reported as too new rather than as a list
  of entries it has never heard of. When it is raised, readers keep reading every older version.
- **The form's `schemaVersion`**: the form engine's format (1 or 2 in 1.3.0). Older formats are
  read as they are.
- **A design's `schemaVersion`**: the PDF designer's format (2 in 1.3.0). Version 1 designs are
  upgraded on reading.

A server only imports files whose three versions it knows; an older server asks for an update.
The forms AI tool is released at the app's version, so a tool and a server of the same version
always agree.

## Importing and exporting

Export is from the last published version, or from the draft when chosen (`source`). Import
creates a **new, unpublished draft form** in the company being acted as (or a staff-made library
template, from the dashboard's Templates page), with its PDF templates and every picture copied
into storage under new ids; it never replaces an existing form. Both are for Integr8 staff only
and are audited. The routes and screens are described with the form builder
([builder.md](builder.md)).
