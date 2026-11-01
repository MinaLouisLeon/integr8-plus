# Business PDFs: quotes, invoices, purchase orders and job reports

Added in 1.3.0 (the owner's decision 11 of 1 November 2026, option C). The server
prints a **quote**, an **invoice**, a **purchase order** or a **job report** as a PDF
in the company's look, keeps it in the documents register beside the PDFs made from
submissions and the uploaded ones, and lets the office download it or email it to the
customer or supplier. Printing from the browser stays exactly as it was. There is no
designer for these layouts: they are fixed, like the browser-printed ones.

Samples, printed through the real printer in English and Arabic:
[`docs/screenshots/1.3.0/business-pdfs/`](../screenshots/1.3.0/business-pdfs/) (each
PDF and a picture of its first page). They are made by
`pnpm --filter @integr8/api exec tsx src/documents/business-samples-cli.ts <dir>` with
`PDF_CHROMIUM_PATH` naming a Chromium.

## What each one says

The layouts are pure functions in `@integr8/document-render`
(`packages/document-render/src/business/`): a snapshot of the record becomes one HTML
page, which the server prints with the same Chromium, scripts off and network shut, as
a form document (ADR-0001 D4).

Every page has the company's **look**: its logo and name at the top with the address
and tax number from the finance settings (the invoice keeps the issuer frozen when it
was issued), its brand colour on headings, table headers and rules, Noto Sans (both
scripts), a running header with the company's name and the document's title, a running
footer with the reference and **Page X of Y**, and the company's footer text (finance
settings) at the end. The look comes from the shared document look the PDF template
builder introduces in the same release (`DocumentLook`, `documentLook`); until the
two branches meet, `business/look.ts` is a temporary copy of its names and shapes,
not exported, deleted at merge. A company's PDFs use its accent colour and Noto Sans
until a font choice is stored for business documents.

| Kind               | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Quote**          | What the browser-printed quote shows: title, issued and valid-until dates, the customer as issued (name, address, contact), introduction, lines with discount and tax columns when any line has one, gross/discount/net/tax/total, terms, and the customer's answer. "Withdrawn" stamp on a cancelled quote.                                                                                                                                                                                                                     |
| **Invoice**        | What the browser-printed invoice shows: issuer with tax number, issue and due dates, bill-to, lines, totals, then credited, paid and balance due, the notes and how to pay. Adds the issued credit notes and the payments received, each with its reference, date and amount. "Void" stamp on a void invoice.                                                                                                                                                                                                                    |
| **Purchase order** | What the browser-printed order shows: the company as buyer, the supplier (address, contact, email, phone, tax number), deliver-to, lines with item codes, prices and tax, totals, notes. "Cancelled" stamp on a cancelled order.                                                                                                                                                                                                                                                                                                 |
| **Job report**     | Customer (account number, phone), site (address, coordinates and a Google Maps link written out), site contact, job number, type, status, priority, created/completed/signed-off dates, description, the comments marked for the customer, visits with their engineers and times, the time on the job (arrived, started, finished, travelling, time on site, working, waiting for parts), parts used with serial numbers and batches, the forms filled in, the checklist, photos and the customer's sign-off with the signature. |

### The job report's forms: a list, not every answer

The report lists each form on the job with who submitted it, when, and the titles of
the PDFs already made from it; it does not print the answers. A form's answers already
have their own PDF, designed by Integr8 for that form (often a certificate the customer
must keep as it is), and a job can carry several long forms: printing every answer
again would make the report long, duplicate the certificate in a different layout, and
show answers a company never meant for the customer. The note under the list says
where the answers are.

### Photos

Job attachments of kind `photo` that are pictures, grouped before, after and other, in
a grid of three, at most **60** (`JOB_REPORT_MAX_PHOTOS`); the report says how many
more are kept with the job. Each is shrunk to 900 pixels on its longest side. 60 rather
than the form document's 120 keeps a full report small enough to email (see below).
The customer's signature is printed under "Customer sign-off", or why they could not
sign.

## Who may

Each kind follows its own module, and every one also needs the **documents** module,
which keeps the register (a company without it has no PDFs panel; browser printing
still works).

| Kind           | Module switch | See its PDFs, download              | Make a PDF                                             | Email it            |
| -------------- | ------------- | ----------------------------------- | ------------------------------------------------------ | ------------------- |
| Quote          | `sales`       | `sales.read`                        | `sales.manage`                                         | `sales.manage`      |
| Invoice        | `finance`     | `finance.read`                      | `finance.manage`                                       | `finance.manage`    |
| Purchase order | `purchasing`  | `purchasing.read` and seeing prices | `purchasing.manage`                                    | `purchasing.manage` |
| Job report     | (always)      | reading the job (all, or assigned)  | reading the job and `work_order.manage` or `.progress` | `work_order.manage` |

No new permission was added. A viewer reads but makes nothing, as everywhere; an
engineer makes a report of a job they are on; the office emails. A purchase order's PDF
prints prices, so only a seat that sees purchase prices sees it. A record a seat may
not read answers 404. The documents register itself (`document.read`) lists every
business PDF too.

Only a record that has left **draft** is printed by the server (409
`business_document_draft`): a draft quote has no customer frozen on it, a draft
invoice has no number, and a draft order has not been approved. Drafts are printed from
the browser, as before. Because only issued or approved records are printed, and those
are never deleted, a business PDF never stands in the way of discarding a draft.

## The QR code and sharing

Every business PDF has the register's own public code. Its QR code opens:

- **a quote**: the customer's quote page (`/q/<token>`) when the PDF is made from the
  link the issue step hands over ("Make PDF with this link" in that dialog). The token
  is kept only as a hash, so this is the one moment it can be printed; the server checks
  it is still the quote's live link (422 `quote_link_invalid`). The quote page has its
  own rules (ADR-0006): it stops when the quote is answered, revised or withdrawn, or
  when the sales module is off. Otherwise, the PDF's own page.
- **an invoice**: the PDF's own page, `/d/<code>`. There is no online invoice page (the
  website data API's `website_invoices` serves a company's own website, not customers).
- **a purchase order and a job report**: the PDF's own page.

Like every document since 1.2.4, a business PDF **starts not shared**: its `/d/` page
answers "not available" until someone with `document.upload` (owners and admins)
switches sharing on, in the register or when making it ("Let its QR code open the PDF
online", offered only to them). A quote PDF printed with the customer's link works
without sharing, because that link is the quote page, not the PDF. Business PDFs carry
two fields, `reference` and `customer` (or `supplier`), so the register finds them by
number or name; neither is a website-lookup field, so the company website's document
lookup does not find business PDFs (it has its own quote, invoice and job endpoints).

## Emailing

"Email PDF" sends a ready PDF as an **attachment** (Resend accepts attachments; the
recording sender keeps it), with "Company: Invoice INV-000123" as the subject, the
company's language for the words, the person's own note if they typed one, and
**reply-to** set to the person who sent it, so the customer's answer reaches them. The
address is filled in from the record (the contact the quote or invoice was issued to,
the supplier's email, the job's site contact or else its customer) and can be changed.
A PDF larger than 10 MB is refused (422 `document_too_large_to_email`); one not yet
printed is refused (409 `document_not_ready`). Whether the provider took it is shown,
and every send is in the audit log with the address (`document.emailed`).

## The pipeline

`POST /v1/business-documents` reads the record **as the person asking sees it** and
puts that snapshot on the `documents.render_business` queue with the document, which
starts pending. The worker (`apps/api/src/documents/business.ts`) reads the logo,
photos and signature from the company's bucket, prints, stores the PDF in the bucket
within the company's storage allowance, records it in the media ledger and marks the
document ready, or failed with a reason the screens show; it retries what another
attempt might fix (three attempts), exactly as the form documents' job does. A PDF is a
copy of the record at that moment: changing the record afterwards changes nothing in
it; make another.

| Route                                           | What                                                                                   |
| ----------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /v1/business-documents?kind=&recordId=`    | A record's PDFs (newest 20), what this seat may do, the address, the company language. |
| `POST /v1/business-documents`                   | Make one: `kind`, `recordId`, `language`, `shareable`, `quoteLinkToken`. 202, pending. |
| `GET /v1/business-documents/:documentId/file`   | A five-minute link, inline or as a download.                                           |
| `POST /v1/business-documents/:documentId/email` | Email it: `to`, `message`. Answers `{ sent, problem }`.                                |

Data: migration **0074** adds `quote_id`, `invoice_id`, `purchase_order_id` and
`work_order_id` to `documents`, each with a key that carries `tenant_id`, and the
sources `quote`, `invoice`, `purchase_order`, `job_report`; a check keeps exactly the
one record column of the source set. No new table, so the tenant purge and the data
export already cover them.

## Screens

The quote, invoice, purchase order and job screens (web and desktop, shared through
`@integr8/operations-dom`) have a **PDFs** panel under the record: the record's PDFs
with their state and whether the QR code opens them, **Make PDF** (language: the
company's or chosen; sharing for those who may), **View**, **Download** and **Email
PDF**. The register marks each with its kind. The phone app's online documents list
shows business PDFs like any other and opens them, but its job screen has no Make PDF
button: the phone works jobs from its offline copy and has never made server documents.
Adding one is a small, separate change (an online call and a button on the job screen);
until then an engineer uses the web app.
