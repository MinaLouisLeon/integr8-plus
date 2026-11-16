# PDF documents

The `documents` module. Integr8 staff design **PDF templates** for a company's
forms in the desktop app; the company turns a submission into a **document**
from one; the worker prints it with Chromium and stores it in the company's
bucket. The company can also **upload** PDFs it already has, and the server
prints **business PDFs** for quotes, invoices, purchase orders and job reports.
Every document has a code and a QR link, works only while **shared**, and can be
found from the company's own website.

## Templates

Designed beside the form, on a published form (`document.design`, staff only
through impersonation). A design (`schemaVersion` 2) has:

- **Page**: language (English, Arabic or the company's), portrait or landscape,
  margins, text size, a three-place header and footer, page numbers, a
  background image per page and a different first page (A4 backgrounds, 2480 ×
  3508 px ideal; PNG, JPEG or WebP).
- **Look**: brand colour, palette, lines, fonts: `noto-sans` and `noto-naskh`
  (installed in the API image, Latin and Arabic) or `integr8-display` and
  `integr8-text` (the Integr8 Media website's fonts, embedded from the pinned
  `@fontsource` packages; nothing is fetched while printing).
- **Document fields**: values stored with each document, searchable in the
  register; typed by the person, taken from an answer or from the submission.
  One may be the website's lookup field.
- **Content**: headings, text with placeholders (`{{answer.<key>}}`,
  `{{company.website}}`, …), answers, check boxes, all options, tables (answers, a
  repeating section, fixed text), images (logo, a picture, a photo or signature
  answer), Information blocks from the form, the QR code (`content: share` for
  the document's own link, or `fixed` text with placeholders), lines, space, page
  breaks, two- or three-column rows.

The designer has drag and drop with undo, copy and duplicate, and a preview
drawn by the same renderer as the server. **Preview as PDF** prints the unsaved
design in the API process (never stored or counted; 6 a minute per person, 30 a
minute per server, `PDF_MAX_CONCURRENT` at once; 503 `document_preview_failed`
when it cannot print). The `api` container's memory cap is 1 GB for it.

**When a form drops a question.** Publishing a version that removes or changes
a question a template uses is allowed after a confirmation; the template is
marked **Needs attention** (`needsAttention`, `problems` on `GET
/v1/document-templates`) and keeps printing: a single-answer block is left out,
a table loses that row, a placeholder prints nothing. A submission on an older
version prints its own answers.

**Copying.** Duplicate within a form; copy to another form of the company (every
question the template names is matched in the target form by key, then by
wording; nothing is saved until each one is matched or taken out:
`document_template_unmatched`); copy to another company with its form; carried
into the library and into `.integr8form` files. Every copy gets its own copy of
every picture. Refused whole on `storage_quota_exceeded` or
`document_template_image_missing`.

## Documents

| Seat (built-in roles) | Read the register | Make a PDF | Upload, share, stop, delete | Design templates |
| --------------------- | ----------------- | ---------- | --------------------------- | ---------------- |
| Owner, admin          | Yes               | Yes        | Yes                         | Staff only       |
| Dispatcher            | Yes               | Yes        | No                          | No               |
| Engineer              | Own documents     | Yes        | No                          | No               |
| Accountant, viewer    | Yes               | No         | No                          | No               |

(`document.read`, `document.create`, `document.manage`, `document.upload`,
`document.design`; the exact matrix is `packages/core/src/permissions.table.md`.)
Making a PDF also needs the right to read the submission; a draft cannot be made
into a document.

- **Printing.** The `documents.render` job: Chromium at `PDF_CHROMIUM_PATH`, at
  most `PDF_RENDER_TIMEOUT_MS` (30 s) each, `PDF_MAX_CONCURRENT` (2) per worker.
  The worker logs `PDF documents can be printed` (or why not) at start.
  Failures: `renderer_unavailable`, `render_timeout`, `render_failed` (each after
  3 tries), `template_invalid`, `source_missing`, `storage_unavailable`,
  `storage_quota_exceeded`. A failed document is deleted and made again.
- **Uploads** (`document.upload`): a PDF up to 20 MB, checked by its bytes, with
  a title, a reference, optionally a customer, and up to 10 typed fields
  (`PUT /v1/documents/{id}/fields`). The QR code's place is chosen by dragging on
  a pdf.js view of the page (`qr_placement`, page fractions).
- **Sharing.** A switch per document; **new documents start not shared**.
  Unshared, the QR page and the website answer exactly as for a code that never
  existed. Sharing queues `documents.reprint`: a generated document is printed
  again from its `printed_design` with its code; an uploaded one is stamped
  with pdf-lib (the original is kept). Stopping sharing keeps the code. The
  register's rows have Share (copy, email, WhatsApp, QR), Stop sharing and
  Delete.
- **Links.** `WEB_APP_URL/d/<code>` by default, or the company's own site when
  staff set its `document_link_pattern` (`https://<site>/documents/{code}`, same
  host or below). **Stop the link** and an expiry date stop it at once (undoable);
  **Delete** removes it and the file goes through `MEDIA_RESTORE_DAYS`. A stopped
  link says "no longer available"; any other bad code "not valid".
- **In the desktop app** links open through the operating system
  (`tauri-plugin-opener`, passed to shared screens as `openLink`); in a browser
  the tab opens at the click (`openPendingLink`) so pop-up blockers allow it.

## Business PDFs

Quotes, invoices, purchase orders and a job report in the company's look
(`packages/document-render/src/business`), made from the record's own screen
(**PDFs** panel), listed in the register with their kind (`/v1/business-documents`,
queue `documents.render_business`). They need the documents module and the
record's module. They start not shared like every document (a quote PDF made
from the issue dialog links to the quote page instead). They can be **emailed**
from the dialog (up to 10 MB; replies go to the sender; audit
`document.emailed`). Drafts are refused (`business_document_draft`). The job
report lists the job's forms rather than every answer.

## The company's website

The company's website **server** calls `/v1/website/…` with a website key
(`i8wk_…`, shown once, kept in the server's environment as
`INTEGR8_WEBSITE_KEY`, never in a page). Only a staff manager (an account made
with `admin-cli create`) makes, enables, disables, revokes or deletes a real
company's keys, on the dashboard's company page; for a test company any staff
member may, and so may the developer MCP server's limited session (P43). Two may
be live at once for rotation; each makes `WEBSITE_LOOKUP_RATE_LIMIT` (60) lookups
a minute.

The company's website (`websiteUrl`) and its document link pattern are https,
on the registered website. A **test company** may also use `http://localhost:<port>`
or `http://127.0.0.1:<port>` for both (migration 0021, P43), so a website being
built on a developer's computer opens from a test document's QR code; any other
company is refused (422 `website_url_local_only`, `document_link_invalid`), and
the database refuses it too.

| Route                                           | Needs (Integr8's grant **and** the company's switch in Settings → Website access)                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/website/documents/lookup` (`{ "q" }`) | `website_files` + documents module. Exact match on the reference and search fields (never the customer's name), up to 10 shared, live documents |
| `GET /v1/website/documents/by-code/{code}`      | `website_files`: serves the document page on the company's own site                                                                             |
| `GET /v1/website/files/{documentId}`            | `website_files`                                                                                                                                 |
| `GET /v1/website/jobs/{workOrderId}`            | `website_jobs`                                                                                                                                  |
| `GET /v1/website/quotes/{quoteId}`              | `website_quotes` + sales module                                                                                                                 |
| `GET /v1/website/invoices/{invoiceId}`          | `website_invoices` + finance module                                                                                                             |

All eight switches start off. The website must sign in its own customers before
showing a job, quote or invoice: the key identifies the website, not a person.
Integr8 Forms for AI gives an AI tool the guide, the exact contract (held to
`openapi.json` by `contract.test.ts`), a ready Next.js search page in both
languages, and a check for a leaked key; the developer MCP server also sets a
test company up and calls these routes with its key
([contributing/developer-tools.md](../contributing/developer-tools.md)).

Without a session, also: `GET /v1/public/documents/{code}` (the QR page) and
`GET /v1/public/quotes/{token}` with `POST …/answer` (the customer's quote link).

## Settings

| Setting                                         | Default             |                                              |
| ----------------------------------------------- | ------------------- | -------------------------------------------- |
| `PDF_RENDERER`                                  | `chromium`          | `recording` makes a placeholder (tests only) |
| `PDF_CHROMIUM_PATH`                             | `/usr/bin/chromium` | Installed in the API image                   |
| `PDF_RENDER_TIMEOUT_MS`                         | `30000`             | Inside the worker's 60 s lease               |
| `PDF_MAX_CONCURRENT`                            | `2`                 | Per worker, and previews per API container   |
| `WEBSITE_LOOKUP_RATE_LIMIT`, `…_WINDOW_SECONDS` | `60`, `60`          | Per key                                      |
| `WEB_APP_URL`                                   | —                   | Every default QR link points here; required  |
