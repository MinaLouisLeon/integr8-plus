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
