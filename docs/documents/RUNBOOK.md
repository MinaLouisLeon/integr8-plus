# PDF documents — runbook

For whoever runs Integr8 Plus. What the feature is, how to switch it on for a
company, how to tell it is working, and what to do when it is not. The
decisions behind it are in [ADR-0001](./ADR-0001-pdf-documents.md).

## What it is

Integr8 staff design **PDF templates** for a company's forms, in the staff
desktop app. A company member turns a submission into a **PDF document** from
one of those templates. The worker prints it with Chromium, draws the
template's backgrounds under every page, and stores it in the company's own R2
bucket. Each document has a **QR code** that opens `WEB_APP_URL/d/<code>`, where
anyone with the link can view and download it. The company's apps list the
documents, search them, stop their links and delete them. Owners and admins
can also **upload a PDF** the company already has (release 1.2.4), and choose
which documents are **shared**: only a shared document opens from its QR code or
the company's website. A company's own website can look a document up with a
**website key**.

## The server

Nothing to configure in a normal deployment.

- The API image installs Debian's Chromium at `/usr/bin/chromium` and the Noto
  and DejaVu fonts, for Latin and Arabic. The worker uses them; the API process
  never starts Chromium.
- `PDF_RENDERER=chromium` is the default and the only value production
  accepts. `recording` makes a plain placeholder PDF, for tests and laptops
  without Chromium.
- `WEB_APP_URL` must be the web app's address. Every QR code points there, and
  a server without it refuses to make documents (`document_link_unavailable`).

| Setting                              | Default             | What it does                                                   |
| ------------------------------------ | ------------------- | -------------------------------------------------------------- |
| `PDF_RENDERER`                       | `chromium`          | `chromium`, or `recording` for tests.                          |
| `PDF_CHROMIUM_PATH`                  | `/usr/bin/chromium` | Where the worker finds Chromium.                               |
| `PDF_RENDER_TIMEOUT_MS`              | `30000`             | Longest one document may take; inside the worker's 60 s lease. |
| `PDF_MAX_CONCURRENT`                 | `2`                 | Documents printed at once by one worker.                       |
| `WEBSITE_LOOKUP_RATE_LIMIT`          | `60`                | Website lookups one key may make per window.                   |
| `WEBSITE_LOOKUP_RATE_WINDOW_SECONDS` | `60`                | The window for that limit.                                     |

### Is it working?

The worker says so once, when it starts:

```bash
docker compose -f deploy/compose.yml --env-file deploy/.env logs worker | grep "PDF documents"
```

`PDF documents can be printed` is right. `PDF documents cannot be printed`
names the reason, usually that `PDF_CHROMIUM_PATH` points at nothing. Every
other job runs as before; documents asked for are marked failed with
`renderer_unavailable` until it is fixed.

## Switching it on for a company

1. Dashboard → the company → **Features** → `documents` on.
2. In the staff desktop app, acting as the company: Forms → the form →
   **PDF templates**. The form must have been published.
3. A template has three parts:
   - **Page**: the language (English, Arabic or the company's), margins, text
     size, page numbers and footer text, a background image for every page,
     and the first page (like the others, plain, or its own background, with
     its own top margin for a taller letterhead). Backgrounds are PNG, JPEG or
     WebP, drawn edge to edge on A4: 2480 × 3508 pixels is ideal.
   - **Document fields**: values stored with each document and searchable in
     the register. Each is typed by the person making the PDF, taken from an
     answer, or taken from the submission (date, who, job number, asset
     number). Mark one field **What the visitor types** if the company's
     website will look documents up, and optionally a second **A second field
     that must match**.
   - **Content**: headings, text with placeholders, answers, checkboxes, all of
     a question's options with boxes, tables (answers, a repeating group, or
     fixed text), images (the logo, an uploaded picture, a photo or signature
     answer), the QR code, lines, space, page breaks, and rows of two or three
     columns.
4. **Save template**. The preview beside the editor uses the same renderer as
   the server, filled with a recent submission when one is chosen; dashed
   lines show page breaks. The PDF itself always comes from the server.

Who can do what:

| Seat                    | Read the register | Make a PDF | Stop links, delete | Design templates |
| ----------------------- | ----------------- | ---------- | ------------------ | ---------------- |
| Owner, admin            | Yes               | Yes        | Yes                | No               |
| Dispatcher              | Yes               | Yes        | No                 | No               |
| Engineer                | Own documents     | Yes        | No                 | No               |
| Viewer                  | Yes               | No         | No                 | No               |
| Integr8 staff, as owner | Yes               | Yes        | Yes                | Yes              |

Making a PDF also needs the right to read the submission. A draft cannot be
made into a document.

## When a document fails

The document is marked **Failed** and its page says why. The codes:

| Code                     | Meaning                                       | What to do                                                       |
| ------------------------ | --------------------------------------------- | ---------------------------------------------------------------- |
| `renderer_unavailable`   | The worker has no usable Chromium.            | Check the worker's start-up line; fix `PDF_CHROMIUM_PATH`.       |
| `render_timeout`         | Printing took longer than the limit, 3 times. | A huge document: fewer photos, or raise `PDF_RENDER_TIMEOUT_MS`. |
| `render_failed`          | Chromium or the PDF step failed, 3 times.     | The worker log has the error, under `Document render failed`.    |
| `template_invalid`       | The template no longer reads as a template.   | Open it in the designer, fix what it lists, save.                |
| `source_missing`         | The submission or template was deleted.       | Nothing to fix; delete the document.                             |
| `storage_unavailable`    | The company's bucket could not be reached.    | Check R2; delete the document and make it again.                 |
| `storage_quota_exceeded` | The company's storage is full.                | Free space or raise the plan, then make it again.                |

A failed document is deleted from its page and made again from the
submission.

## Uploaded documents and sharing (1.2.4)

- **Upload a PDF** (Documents, owners and admins: `document.upload`): a PDF of
  at most 20 MB, checked to be a PDF by its bytes, with a title, its reference
  number and optionally the customer it is for. It is ready at once, marked
  **Uploaded**, with its own QR link; stopping, expiry and deletion work as for
  a made document. The reference (and the customer's name) are what the website
  lookup finds it by.
- **Sharing** is a switch on every document's page, for the same people. Off,
  the QR code's page and the website answer as if the document did not exist.
  **New documents start not shared**, made or uploaded; documents made before
  1.2.4 stay shared. Uploads and every change of sharing are in the company's
  audit log. When a company says its QR codes "stopped working", check first
  that the document is shared.

## Links, expiry and deletion

- **Stop the link** stops the QR code's page and the website lookup at once.
  The file is kept, and **Open the link again** undoes it.
- An **expiry date** stops the link by itself at that moment.
- **Delete** removes the record and the link at once; the PDF goes through the
  media restore window (`MEDIA_RESTORE_DAYS`) and the existing purge, like any
  deleted file. Every one of these is in the company's audit log.
- A stopped link answers "This document is no longer available". Any other bad
  code answers "This link is not valid", so guessing teaches nothing.

## Website keys

Only an account made with `platform-admin create` in the terminal (a staff
manager) can make, enable, disable, revoke or delete one: dashboard → the
company → **Website keys**. Other staff see the keys, their last characters and
their use, and are refused with `staff_manager_only` if they try to change one.

A key answers only while both switches for what it asks are on: Integr8's grant
on the company's **Features** panel (`website_files` for documents,
`website_jobs`, `website_quotes`, `website_invoices`) and the company's own
switch in **Settings → Website access**. All eight are off for a new company;
a company that had one on before 1.2.4 keeps it. Documents also need the
documents module, quotes the sales module and invoices the finance module, and
a document must be shared to be found.

- The key is shown once. Copy it into the website server's environment as
  `INTEGR8_WEBSITE_KEY`; it never goes in the website's pages.
- Two keys may be live at once. To replace one: make the new key, put it on the
  website, then revoke the old one.
- The panel shows each key's last four characters, when it was last used, and
  how many lookups found something.
- Making, enabling, disabling, revoking and deleting are in the platform audit
  log.
- Each key may make 60 lookups a minute by default; more answer 429.

Give the company's website developer
[the website developer's guide](./WEBSITE-LOOKUP.md).

## Storage

A document's PDF counts towards the company's storage like any upload, and
follows the plan's retention. Template backgrounds and pictures are tied to
their template and the retention sweep leaves them alone.

## Rolling back

Leave migration `0048_documents` applied when going back to an older version:
the older code ignores its tables. The same for `0067_document_uploads_and_sharing`:
1.2.3 keeps working on it, lists uploaded documents without their reference,
and ignores sharing (its QR links open whatever the switch says) until 1.2.4 is
back. Its `.down.sql` drops every document and
template and is for development databases only.
