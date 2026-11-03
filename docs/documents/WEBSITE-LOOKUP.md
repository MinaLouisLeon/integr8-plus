# Connecting a company's website to Integr8

For the developer of a company's own website (Next.js on Vercel), and for the
company deciding what its website may show. It lets the company's customer find
documents by what the company gave them (a certificate number, say), open a
shared document's own page on the company's site, and an authenticated
customer see a job's status, a quote or an invoice, through Integr8's API.

The website's **server** asks Integr8 Plus with a **website key**. The key is a
secret: it lives in the server's environment and never reaches a browser.
The company website must authenticate its own customers before asking for a
job, a quote or an invoice; the key identifies the company website, not an
individual customer.

Building the website with an AI coding tool? **Integr8 Forms for AI** (the program on
`/download`, see [`docs/forms-ai/README.md`](../forms-ai/README.md#for-a-company-website)) gives
it this guide, the exact API, a ready Next.js search page in English and Arabic, and a check of
the website's code for a leaked key or a wrong call.

## What you get from Integr8

- **The key**, which starts with `i8wk_`. Integr8 shows it once; keep it in a
  password manager until it is in Vercel.
- **The API address**, for example `https://api.integr8-media.com`.
- **Four switches, each separate, all off to begin with.** The company website
  can reach **documents**, **job status**, **quotes** and **invoices**, and each
  needs two switches on:
  - Integr8's grant on the company's **Features** panel: `website_files`
    (documents), `website_jobs`, `website_quotes`, `website_invoices`;
  - the company's own switch in **Settings → Website access** (owners and
    admins).

  A new company starts with all eight off. A company that had a switch on
  before release 1.2.4 keeps it on. Documents, quotes and invoices also need
  their module (`documents`, `sales`, `finance`) switched on.

- **Key controls.** Only an Integr8 staff manager (an account made with the
  terminal command) can create, enable, disable, revoke or delete a key; other
  Integr8 staff can see that it exists and how it is used. Disabling is
  reversible; revoking stops service and leaves a record; deleting removes the
  record. A key's secret is never recoverable.

## Which documents the website can find

The register holds two kinds of PDF, and the website finds both the same way:

- **Made from a submission** with a template Integr8 designed. Its reference is
  the template's lookup field (a certificate number, say). A second field the
  template names (the customer's name, say) is asked for only by the older
  two-value search; the one search box never matches it.
- **Uploaded** by the company (Documents → **Upload a PDF**): a PDF it already
  has, such as a certificate signed on paper, with a **reference number** and,
  optionally, the **customer** it is for, and any **extra fields** typed for
  it (a serial number, say; 0075). The reference and the extra fields are what
  the website's search finds it by; the customer's name never is.

A document is found only while it is **shared** and its link is live:

- Every document has a **Sharing** switch on its page in the register, turned
  by the company's owners and admins (`document.upload`). Off, the website
  lookup does not find it, `/v1/website/files/{documentId}` answers 404, and
  its QR code's page says "This link is not valid", exactly as for a code that
  never existed. On, all of them work.
- **New documents start not shared**, made or uploaded, so nothing a company
  makes is public until someone decides it should be. Documents made before
  release 1.2.4 stay shared, because their QR codes are already printed.
- Uploading, and every change of sharing, is recorded in the company's audit
  log.
- Stopping a document's link (**Stop the link**), its expiry date passing, or
  deleting it hides it too, whatever the switch says.

## The QR code

Every document, made or uploaded, has its own page at
`https://app.integr8-media.com/d/<code>`, or on the company's own website when
Integr8 set a document link address (see "The document page" below): the company, the title, the form (or,
for an uploaded document, its reference) and the date, with View and Download.
A made document carries the code on the PDF when its template has a share QR block, but
only once it is shared: until then the place is blank, and sharing re-prints the PDF with
the code in it (0075). An uploaded PDF given a QR place gets the code stamped in the same
way. A template's **fixed** QR code is a link or text printed from the start instead;
every document shows its QR code on its page in the register, to print or send.
The page opens only while the document is shared and its link is live.

## Set the environment

In Vercel → the project → **Settings** → **Environment Variables**, for
Production (and Preview if wanted):

| Name                  | Value                           |
| --------------------- | ------------------------------- |
| `INTEGR8_API_URL`     | `https://api.integr8-media.com` |
| `INTEGR8_WEBSITE_KEY` | `i8wk_…`                        |

Never prefix them with `NEXT_PUBLIC_`: that would put the key in the pages.
Redeploy after adding them.
Read these variables only in a Next.js Server Action, Route Handler or other
server-side module. Never pass them as props or return them in a response.

## The search

One search box (since 0075). Send what the visitor typed as `q`:

```http
POST /v1/website/documents/lookup
Authorization: Bearer i8wk_…
Content-Type: application/json

{ "q": "GS-2026-0042" }
```

`q` is matched against every **searchable** field of every shared document:

- a made document's lookup field (whatever its template calls it);
- an uploaded document's reference number;
- the **extra fields** typed for an uploaded document (Documents → **Upload a
  PDF** → **Add field**, or later on its page), such as a serial number.

It is never matched against the customer's name, so typing a company's name
lists nothing. Values are compared exactly, ignoring capitals and extra
spaces: part of a value does not match. Every match comes back, newest first,
at most ten.

The older forms still work, for websites built before the one box, and find
one document or none: `reference` with `customer` as the second value (a
document that has one is found only when it matches too), and, from before
1.2.4, `key` with `confirm` naming the template's fields. Send exactly one of
`q`, `reference` and `key`.

## The answer

Always `200` when the key is good:

```json
{
  "found": true,
  "documents": [
    {
      "title": "Gas certificate · GS-2026-0042",
      "formTitle": "Gas safety certificate",
      "createdAt": "2026-10-16T09:00:00.000Z",
      "pageCount": 2,
      "link": "https://www.example.com/documents/2Xq…",
      "code": "2Xq…",
      "viewUrl": "https://…",
      "downloadUrl": "https://…",
      "expiresAt": "2026-10-16T09:05:00.000Z",
      "fields": [
        { "key": "certificate", "label": { "en": "Certificate number" }, "value": "GS-2026-0042" }
      ]
    }
  ],
  "document": { "…": "the first of documents, for older websites" }
}
```

```json
{ "found": false, "document": null, "documents": [] }
```

- `link` is the document's own page, the one its QR code opens: the company
  website's document page when Integr8 set a document link address, Integr8's
  `/d/` page otherwise. It is stable: safe to show and to link to. `code` is
  the code in it.
- `viewUrl` opens the PDF in the browser and `downloadUrl` saves it. Both stop
  working at `expiresAt`, five minutes after they were made, so use them at once
  and never store them.
- An uploaded document has an empty `formTitle` and no page count; its fields
  are `reference`, `customer` when it has one, and its typed fields
  (`custom_1`, …).
- A document that is not shared, was stopped, has expired or was deleted is not
  found: the same `found: false` as for a reference nobody issued.

Other answers:

| Status | `error.code`          | Meaning                                                                                                             |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 422    | `validation_failed`   | The body is not as above (not exactly one of `q`, `reference` and `key`, or a value too long).                      |
| 401    | `website_key_invalid` | No key, a mistyped key, or a revoked one.                                                                           |
| 403    | `feature_disabled`    | The documents module is off for the company, or Integr8's `website_files` grant or the company's own switch is off. |
| 429    | `rate_limited`        | More than 60 lookups a minute with this key; slow down.                                                             |

## The document page

Integr8 staff can point a company's document links at its own website (the
company's page on the dashboard → Website and apps → **Document link
address**): an https address on the registered website, with `{code}` where
the document's code goes, such as `https://www.example.com/documents/{code}`.
From then on every link the register shows or copies, every share by email or
WhatsApp, and the QR code on every new PDF open that address. QR codes printed
before keep opening Integr8's `/d/` page, which keeps working. Set the address
only once the page is live, or the links land on a 404.

The page reads the code from its address and asks, from the server:

```http
GET /v1/website/documents/by-code/2Xq…
Authorization: Bearer i8wk_…
```

```json
{
  "found": true,
  "document": { "title": "…", "code": "2Xq…", "viewUrl": "https://…", "…": "as in the search" }
}
```

`found: false` for a code that is not one of this company's documents, or is
not shared, stopped, expired or deleted: the page shows "This link is not
valid" alike. A code that is not 22 characters of A–Z a–z 0–9 `_` `-` is
refused with 422; check it before asking. Render the page on the server for
every visit (`dynamic = 'force-dynamic'`), so its five-minute links are fresh,
and keep it out of search engines (`robots: { index: false }`).

## A Next.js example

**Integr8 Forms for AI** (`get_website_example`) writes both pages, the search
and the document page, in English and Arabic, with a server-only client, and
`check_website_integration` checks them. The core of it, a Server Action and
the document page, App Router, TypeScript:

`app/certificates/actions.ts`:

```ts
'use server';

export interface Found {
  title: string;
  link: string | null;
  viewUrl: string;
  downloadUrl: string;
}

export async function findDocuments(_previous: Found[] | null, form: FormData): Promise<Found[]> {
  const q = String(form.get('q') ?? '').trim();
  if (q === '') {
    return [];
  }
  const response = await fetch(`${process.env.INTEGR8_API_URL}/v1/website/documents/lookup`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.INTEGR8_WEBSITE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ q }),
    cache: 'no-store',
  });
  if (!response.ok) {
    // 401, 403 or 429: log it on the server, show the visitor "not found".
    console.error('Integr8 search failed', response.status);
    return [];
  }
  const body = (await response.json()) as { documents: Found[] };
  return body.documents.map(({ title, link, viewUrl, downloadUrl }) => ({
    title,
    link,
    viewUrl,
    downloadUrl,
  }));
}
```

`app/documents/[code]/page.tsx`:

```tsx
export const dynamic = 'force-dynamic';
export const metadata = { robots: { index: false } };

export default async function DocumentPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const response = /^[A-Za-z0-9_-]{22}$/.test(code)
    ? await fetch(`${process.env.INTEGR8_API_URL}/v1/website/documents/by-code/${code}`, {
        headers: { authorization: `Bearer ${process.env.INTEGR8_WEBSITE_KEY}` },
        cache: 'no-store',
      })
    : undefined;
  const body = response?.ok
    ? ((await response.json()) as {
        document: { title: string; viewUrl: string; downloadUrl: string } | null;
      })
    : { document: null };
  if (body.document === null) {
    return <p>This link is not valid.</p>;
  }
  return (
    <main>
      <h1>{body.document.title}</h1>
      <a href={body.document.viewUrl}>View</a> · <a href={body.document.downloadUrl}>Download</a>
    </main>
  );
}
```

## Good practice

- Give each document something hard to guess to be found by: its reference, or
  an extra field typed when it is uploaded. The search never asks for the
  customer's name, and never matches it.
- Ask the company to share a document only once its customer may see it:
  sharing is what lets the website and the QR code show it.
- Show the same "not found" whatever went wrong, so the page teaches nothing
  to someone guessing numbers.
- Add your own limit per visitor (Vercel's firewall or middleware) as well:
  Integr8's limit is per key, so one visitor could use up the website's
  allowance for everybody.
- When Integr8 gives you a new key, put it in Vercel and redeploy; tell them,
  verify the replacement works, then ask them to revoke the old one. A disabled
  key can be enabled again; a revoked key cannot.

## Other customer website endpoints

The OpenAPI source of truth is `apps/api/openapi.json`. Every request uses the
same `Authorization: Bearer <website key>` header. These endpoints return one
known record by its UUID; they do not list or search across company records.

| Method | Endpoint                               | Returns                                                                                                 |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/website/documents/lookup`         | The search: every shared document whose reference or searchable field is what the visitor typed (≤ 10). |
| `GET`  | `/v1/website/documents/by-code/{code}` | One shared document by its link's code, for the website's document page.                                |
| `GET`  | `/v1/website/files/{documentId}`       | Five-minute view and download links for one shared, ready document.                                     |
| `GET`  | `/v1/website/jobs/{workOrderId}`       | Customer-safe job reference, status, title and due dates.                                               |
| `GET`  | `/v1/website/quotes/{quoteId}`         | One issued quote with customer-visible terms, totals and lines. Drafts and internal notes are excluded. |
| `GET`  | `/v1/website/invoices/{invoiceId}`     | One issued invoice summary. Drafts and internal notes are excluded.                                     |

Each capability is checked separately against the company's switch and
Integr8's grant, both off for a new company; documents, quotes and invoices
also need their product module switched on. Turning off either switch blocks new
requests for that capability only. Disabling a website key blocks every
capability; revoking it cannot be undone.

The company website is responsible for its visitor login and authorization. A
record UUID must come from a trusted company-controlled flow. The API key is a
company-wide credential and should only be used after the website has checked
that the visitor may access that specific record.
