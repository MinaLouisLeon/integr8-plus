# ADR-0001: PDF documents from submissions

- Status: accepted
- Date: 16 October 2026
- Decided with: the owner, in conversation, before any code

## Context

Each company fills forms that Integr8 staff build for it. Companies need a
submission as a document: their own layout, on A4, with checkboxes, text,
tables, photos, a signature and a QR code; kept in their own storage; found
again in their apps; reachable by a printed QR code; and, for some, searchable
from the company's own website.

Nothing in the repository rendered a PDF before this. The only documents were
the invoice and the quote, printed by the browser.

## Decisions

### D1. Templates are designed by Integr8 staff, per form

A form may have any number of **PDF templates**. Only Integr8 staff, sitting in
the company's seat, design them (`document.design`, a staff-only permission like
`form.manage`). The designer is a tab of the desktop form builder. A template is
data: page settings, document fields and a list of blocks. A template has a
revision; a document records the revision it was made from.

### D2. Blocks, not free placement

A template is a column of blocks, one under another, with a row block for two
or three blocks side by side: heading, text (static, or with the form's answers,
the document fields, the company and the submission placed in it), a field's
answer, a checkbox, a table (label-and-value rows, or a repeating group as rows),
an image (the company logo, an uploaded picture, or a photo or signature
answer), the QR code, a divider, a spacer and a page break. Tables grow with the
data and break across pages; Arabic and right-to-left layout come from the
browser engine that renders them (D4). Pixel placement was rejected: it cannot
grow with the data, and the PDF libraries that place text do not shape Arabic.

### D3. A4 portrait, a repeating background, an optional first page

Every page is A4 portrait. A template may have a background image drawn behind
every page, and, when staff turn it on, a different background for the first
page. Margins are set per template and keep the content clear of the
background's printed bands. A header and footer with page numbers repeat on top.
Landscape is out of scope.

### D4. The PDF is made on the server

A worker renders the template to HTML with the submission's answers, a headless
Chromium prints it to PDF, and the backgrounds are drawn under each page. The
apps cannot do this: a browser's print-to-PDF hands the file to the person, not
to the app, so it can be neither stored nor given a QR code; three apps on
different systems would print different fonts and page breaks; and a stored
document must be what the server holds, not what a client uploaded. The price is
Chromium and fonts in the API image, which the worker shares.

### D5. Documents live in the company's own bucket, and count against its storage

The PDF is written to the company's R2 bucket and recorded in the media ledger
as a `document`, so it counts towards the company's storage and plan allowance
like any upload. It is linked to its document record. Template images are
uploaded through the ordinary media flow and linked to their template, and the
plan's retention sweep leaves them alone: retiring a template's background would
break every later document. Generated documents follow retention like any file.

### D6. Document fields: typed or taken from the submission

Each template defines document fields, such as "File name" or "ISO code". A
field is either typed by the person exporting (optionally required) or filled
from the submission (an answer, the job reference, the site, the date). Values
are stored with the document, searchable in the company's register, and may be
placed on the page.

### D7. The QR code is a short link on Integr8's domain

When an export starts, the server mints a random code (128 bits, base64url) and
the QR encodes `WEB_APP_URL/d/<code>`. The page there shows the company, the
form, the date, and **View** and **Download**. Anyone with the link may open it:
no account, no sign-in. The code is stored as the company's to show again in
its register; it is not a secret from the company, and a printed copy carries it
anyway. One code opens one document.

### D8. The register: list, search, expire, delete

The company's apps list their documents, searchable by the document fields, the
form, the template and the date. **Expire** stops the link at once and can be
undone; an optional expiry date does the same by itself. **Delete** removes the
record, the link and the file (through the ledger's restore window and the
existing purge sweep), and is audited. Reading needs `document.read`, exporting
`document.create` and the right to read the submission, expiring and deleting
`document.manage`.

### D9. A module, switched on per company

Documents are a module flag (`documents`, off by default), shown on the
dashboard's company page with the others. Without it nothing appears in the
company's apps and the routes answer 403.

### D10. A website lookup, by key, from the company's own server

A company's website (Next.js on Vercel) may look a document up by a document
field that staff mark as the template's lookup key, optionally with a second
field that must also match. The website's server calls one endpoint with a
**website key** in `Authorization: Bearer …`; the key never reaches a browser.
The answer is one match or none, exact and case-insensitive, never a list; an
expired document is not found. Lookups are rate-limited per key and counted.

### D11. Website keys are issued only by the terminal account

Only a staff manager, the account created with `platform-admin create` in the
terminal, can create or revoke a company's website key, from the dashboard's
company page. The key is shown once, stored as a SHA-256 hash, and at most two
are live per company so one can be rolled over. Creating and revoking are in the
platform audit log. Other staff see that a key exists, its last characters and
when it was last used.

### D12. Failure is visible

A render that fails leaves the document marked failed with a reason, and the
person who asked sees it. A server without a usable Chromium says so in its
startup log and on the document, and every other feature runs as before.

## Consequences

- New tables: `document_templates`, `documents`, `document_field_values`
  (tenant-scoped), `website_keys` (platform-level, bound to a company).
- New dependencies: `playwright-core` (Chromium driver) and `pdf-lib`
  (backgrounds), both permissively licensed; Chromium and Noto fonts from Debian
  in the API image.
- The worker's lease must outlast a render; renders are capped well below it.
- One more public door, `/d/<code>`, and one key-protected endpoint. Both answer
  one document per correct key and nothing else.

## Addendum: decided while building (16 October 2026)

- **The document's language is the template's.** A template prints in English
  or Arabic, or follows the company's language when it says neither. Labels,
  yes and no, dates and the page direction all follow it.
- **The first page may have its own top margin**, for a letterhead taller than
  the band on the other pages.
- **Whoever made a document can open it.** Reading the register needs
  `document.read`; a seat with only `document.create`, such as an engineer, can
  still open and download the documents it made itself.
- **A document's title** is the template's name, followed by the value of its
  lookup field when it has one: `Gas certificate · GS-2026-0042`.
- **The design travels with the render job**, so a template saved while a
  document waits to be printed does not change what was asked for.
- **Printing is bounded.** Chromium runs with scripts off and the network shut;
  pictures are resized before they are placed; at most 120 photos and
  signatures go into one document; one render may take 30 seconds and is tried
  three times at most before the document is marked failed.
- **The website lookup** answers `found: false` rather than 404, returns the
  document's fields with it, and gives five-minute links to view and download
  the PDF besides the stable `/d/<code>` page. Keys look like `i8wk_…` and are
  limited to 60 lookups a minute each by default.

## Addendum: website keys and the website data API (31 October 2026)

- **D10 widened.** The same key now also reads one job, one issued quote, one
  issued invoice or one document's links by id (`/v1/website/jobs|quotes|invoices|files/:id`),
  never a list. Each capability needs Integr8's grant (`website_files`,
  `website_jobs`, `website_quotes`, `website_invoices`) and the company's own
  switch, and quotes, invoices and files their module; the document lookup needs
  the `website_files` grant and switch too. Drafts are never shown, another
  company's id is not found, and every route shares the key's rate limit.
- **D11 restored.** For a while any active staff member could create, enable,
  disable or revoke a key, and only deleting was kept for the staff manager.
  That is undone: creating, enabling, disabling, revoking and deleting are all
  for a staff manager (`requireStaffManager`), as this decision said. Any staff
  member may still list keys and see their use.
- Proven by `website-data.integration.test.ts` (every route: missing, malformed,
  invented, disabled and revoked keys; each switch on its own; drafts; another
  company's key; the rate limit; who may manage keys) and the website section
  of `documents.integration.test.ts` (the file route and the lookup's switches).

## Addendum: uploaded documents, sharing and the separate website switches (1 November 2026)

Decided by the owner (Low item 9), built for release 1.2.4.

- **Uploaded PDFs join the register.** A company's owners and admins
  (`document.upload`, a new permission; custom roles may add it) upload a PDF
  it already has: PDF only, checked by its bytes, at most 20 MB, with a title, a
  reference number and optionally a customer. It is stored through the media
  path like any upload and linked to its document. Migration 0067 makes the
  template, revision, submission and form columns nullable for these
  (`source = 'uploaded'`), with a check that keeps every generated document
  exactly as it was. The reference becomes the document's lookup key field and
  the customer's name its confirming field, so D10 needs nothing new to find
  one. An uploaded document is ready at once; nothing is printed.
- **D7 and D10 gain a sharing switch.** `shareable` on every document: off, the
  QR code's link answers 404 like an unknown code and the website lookup and
  `/v1/website/files/:id` do not find it. New documents, made or uploaded,
  start off, so nothing becomes public by being made; existing documents stay
  on (their codes are printed). `POST /v1/documents/:id/share`, with
  `document.upload`, turns it, and each change is in the audit log.
- **The lookup by reference.** `/v1/website/documents/lookup` also takes
  `reference` and `customer`, matched against whichever field is each
  document's key and confirming field; `key` and `confirm` keep working.
- **The website switches stay four, each separate, all off by default** on
  both sides (Integr8's grant and the company's switch): documents, jobs,
  quotes and invoices. Companies that had one on keep it. The flags' own
  descriptions now say what each opens.
- Proven in `documents.integration.test.ts` (uploads: permission, a non-PDF by
  content and by type, someone else's file, 20 MB, the register, the file, the
  public page; sharing: hidden until shared, audited; the lookup by reference
  with and without a customer, and nothing unshared) and
  `website-data.integration.test.ts` (every switch off for a new company).

## Addendum: copying templates (1 November 2026)

Decided by the owner (form builder decisions 1 and 10, Option B), built for
release 1.3.0.

- **D1 gains copies.** A template can be duplicated within its form, copied to
  another form of the same company, travel with its form to another company,
  and travel with a staff-made library form to every company that starts from
  it. There are no starter templates for the built-in library forms.
- **D5 holds for copies.** A picture belongs to one template, so a copy never
  shares one: every picture is copied under a new id into the bucket of
  whoever holds the copy, tied to the new template, and counted against that
  company's allowance (a blocking allowance refuses the copy). A library
  template's pictures are the platform's: a `platform-library` bucket beside
  `platform-exports`, chosen over a company bucket because the library
  outlives any company and no company should pay for it.
- **A copy to another form is matched before it is saved.** Templates name
  questions by answer key. The pure functions in `@integr8/document-render`
  (`references.ts`: `designReferences`, `matchDesignReferences`,
  `referenceCandidates`, `unresolvedReferences`, `rewriteDesignReferences`)
  walk the design as JSON, so a reference in a part of the format added later
  (a header slot, say) is still found; they match by answer key where the
  question fits, then by English or Arabic wording (an Information block by
  its id, then its heading), and rewrite the design
  with each reference renamed or what used it taken out. The designer and the
  server run the same functions; the server refuses until every reference is
  decided, so a half-matched template is never stored.
- **A template copied with its form to another company is not checked against
  a published version there**, because the form arrives as a draft: its
  answer keys are the ones it was designed for. Publishing the form there
  is the first check, as for any template whose form changes.
- Proven in `references.test.ts` (finding, matching, rewriting) and
  `form-copy.integration.test.ts` (duplicate, copy to another form refused
  until matched, copies to another company and through the library with their
  pictures in the right buckets and ledgers).

## Addendum: the template builder for 1.3.0 (1 November 2026)

Decided by the owner (form and PDF builder round, decisions 6–9, 12 and 13);
built for release 1.3.0. Template designs are now **version 2**
(`DESIGN_SCHEMA_VERSION = 2`). A version 1 design is upgraded whenever it is
read (`upgradeDesign`): portrait, no header, the plain Noto fonts, black
headings, and its footer — page numbers at the end, its line of text at the
start — in the new three places. The HTML and footer an upgraded design prints
are byte for byte what version 1 printed (checked by rendering the same
designs before and after, pixel for pixel). The API refuses a version 1 design
saved over a template a newer designer saved (409 `document_template_newer`):
an older desktop app reads a newer design as an empty one.

- **D3 widened: a header, and a footer in three places** (decision 6). Each has
  a start, a centre and an end place, mirrored in Arabic; each place is the
  company logo (a height in millimetres), text with placeholders
  (`{{page.number}}`, `{{page.count}}`, `{{work_order.reference}}`,
  `{{document.date}}`, `{{field.<key>}}`, `{{answer.<question>}}`,
  `{{company.name}}`, …), "Page X of Y", or nothing. Either may be set "not on
  the first page". They are Chromium's header and footer templates, which see
  none of the page's styles: everything is inlined, the logo is a data URI and
  the fonts are embedded again. A template cannot know its page number, so a
  band left off the first page is done by printing twice — once with the bands
  every page has, once with the first page's — and taking the first page of
  the second print and the rest of the first (`firstPageFrom`). Both prints
  lay out the same content in the same page box, so they break the same way.
- **D3 widened: landscape** (decision 7). A4 portrait or landscape per template
  (`page.orientation`); `@page`, Chromium and the preview follow it, and
  backgrounds are prepared at 3508 × 2480 pixels for landscape (2480 × 3508
  for portrait). The designer says which size to upload.
- **Style** (decision 9). Per template: a brand colour — the company's accent
  colour at the time of printing (the default for new templates), one of its
  own, or none — for headings, table titles, table header rows and dividers;
  table lines none, light (as before) or strong; shaded table header rows;
  striped rows; and a font. Per block: a text colour from black, grey, brand
  and red, and light shading. Older templates keep `brandColour: null`.
- **Fonts.** Four keys, each covering English and Arabic: `noto-sans` (Noto
  Sans and Noto Sans Arabic, the stack every template had), `noto-naskh` (Noto
  Serif, Noto Naskh Arabic, DejaVu Serif), `integr8-display` (Unbounded and
  Alexandria headings, Inter and IBM Plex Sans Arabic text) and `integr8-text`
  (Inter and IBM Plex Sans Arabic). The Noto and DejaVu fonts are installed in
  the API image. The website's fonts are the exact-pinned `@fontsource` files
  (5.3.0) the web and desktop apps already ship: the API reads them from its
  own `node_modules` and embeds them in the page and in the header and footer
  as `@font-face` rules with data URIs (`documentFontFaces`), because Chromium
  prints offline and does not read WOFF2 files installed as system fonts.
  Variable fonts come out as Type 3 fonts in the PDF; text stays selectable.
- **The shared document look.** The header, footer, colour and font are one
  shape, `DocumentLook` in `@integr8/document-render`
  (`{ brandColour, fontKey, logo?, header?, footer? }`), turned by
  `documentLook(look, { locale, margins, orientation, fontSize, fontFaceCss,
placeholder, mode })` into base CSS and the printer's header and footer
  templates. Templates use it, and so do the server's other branded PDFs.
- **D2 editing** (decision 8). Blocks are dragged by a handle within the
  template and into and out of a row's columns (rows and page breaks stay at
  the top level); the arrows remain for the keyboard. Undo and redo (Ctrl+Z,
  Ctrl+Y or Ctrl+Shift+Z) keep 100 steps, typing joined into one step while it
  continues. A block can be duplicated, or copied and pasted into another
  template of the same form (the clipboard is kept on the device per company
  and form; pasted blocks get fresh ids, and a page break or row is not pasted
  into a column). Unsaved work is written to the device as it is made, in the
  form builder's recovery format, and offered back when the template is opened
  again; leaving it — another template, a link elsewhere in the app, closing
  the window — asks first. The PDF tab stays open, unsaved work and all, while
  the form builder shows another tab.
- **Preview as PDF** (decision 12). `POST /v1/document-templates/:id/preview`
  prints the design it is sent, saved or not, exactly as a document is printed
  — the company's pictures, fonts, header, footer and backgrounds — filled with
  a submitted submission of the form or, without one, with made-up answers to
  every question (`sampleAnswers`). The PDF is returned as base64 and nothing
  is stored or counted against storage. Staff only (`document.design`), and
  limited to 6 a minute per person and 30 a minute for the whole server
  (`rate_limited`), so previews cannot crowd out documents. It is printed by
  the API process's own Chromium, at most `PDF_MAX_CONCURRENT` at once per
  process, closed again after five idle minutes. The desktop app
  shows the PDF with pdf.js (`pdfjs-dist` 4.10.38, its legacy build), drawing
  pages on canvases: not every desktop webview shows a PDF in a frame, and the
  app's content security policy keeps frames and plugins shut. The live HTML
  preview shows the header and footer, the orientation and the style; it uses
  the fonts the app already serves (its frame shares the app's origin, scripts
  still off).
- **Templates and form versions** (decision 13). A template names questions by
  id. The publish check (`POST /v1/forms/:id/draft/check`) lists, as
  `documentTemplates`, every non-archived template and block that would name a
  question the new version drops or changes — a problem it does not already
  have — and publishing then needs `acknowledgeTemplateChanges` (or
  `acknowledgeBreakingChanges`, which a dropped or retyped question already
  needs), otherwise 409 `document_templates_affected`. Afterwards the template
  answers `needsAttention: true` with its `problems`, each naming its block or
  document field, and the designer marks it in the list and outlines the
  blocks (a row whose column holds one too).
- **Making documents keeps working.** A design is never checked against the
  form when a document is made or printed, so `template_invalid` now only means
  a design that no longer reads at all. The form printed is the one the
  submission answered, so a submission from an earlier version prints its own
  answers. Where a question is gone: a block showing one answer (answer,
  checkbox, all options, a photo or signature image) is left out; an answers
  table loses that row, and is left out when it has none; a repeating-group
  table whose group is gone is left out, and a column whose question is gone
  stays with blank cells; a placeholder prints nothing; a document field taken
  from it is empty and is not stored.
- **Saving with broken references is allowed** for references the stored
  template already had, so fixing one block never waits on the others; a save
  that adds a new broken reference is still refused (422
  `document_template_invalid`). The problems stay listed until fixed.
- Proven by `look.test.ts` and `render.test.ts` (`@integr8/document-render`),
  `printer.test.ts` (Chromium: landscape, a header left off the first page),
  `documents-designer.integration.test.ts` (the preview: staff only, unsaved,
  sample answers, a submission, nothing stored, the rate limit; version 2 and
  `document_template_newer`; the check, the confirmation, needs attention,
  saving, and a document made from an older submission) and the desktop's
  `designer.test.tsx` (moving, duplicating, pasting, undo). Sample PDFs printed
  by the real printer path are in `docs/screenshots/1.3.0/pdf/`.

## Addendum: business PDFs (1 November 2026, 1.3.0)

The owner chose (decision 11, option C) to print quotes, invoices, purchase orders and
a job report on the server too, in the company's look, kept in this register. They use
D4's printer, D5's bucket and allowance, D7's public code and D12's failures unchanged,
with fixed layouts instead of designed templates (no D1-D3), a snapshot of the record
instead of a submission (no D6 fields: a business PDF's `reference` and `customer` or
`supplier` are fields only for searching the register), and each kind's own module and
permissions on top of D9's switch. New ones start not shared, as since 1.2.4. Details:
[`BUSINESS-PDFS.md`](./BUSINESS-PDFS.md).
