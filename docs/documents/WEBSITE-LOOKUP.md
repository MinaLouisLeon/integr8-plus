# Connecting a company's website to Integr8

For the developer of a company's own website (Next.js on Vercel), and for the
company deciding what its website may show. It lets the company's customer find
a document by its reference (a certificate number, say), and an authenticated
customer see a job's status, a quote or an invoice, through Integr8's API.

The website's **server** asks Integr8 Plus with a **website key**. The key is a
secret: it lives in the server's environment and never reaches a browser.
The company website must authenticate its own customers before asking for a
job, a quote or an invoice; the key identifies the company website, not an
individual customer.

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
  the template's lookup field (a certificate number, say), and the template may
  name a second field that must match too (the customer's name, say).
- **Uploaded** by the company (Documents → **Upload a PDF**): a PDF it already
  has, such as a certificate signed on paper, with a **reference number** and,
  optionally, the **customer** it is for. The reference is what the website
  finds it by; when a customer was chosen, the customer's name is the second
  value and must match too.

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
`https://app.integr8-media.com/d/<code>`: the company, the title, the form (or,
for an uploaded document, its reference) and the date, with View and Download.
A made document carries the code on the PDF when its template has a QR block;
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

## The request

By reference, with the second value when the document has one:

```http
POST /v1/website/documents/lookup
Authorization: Bearer i8wk_…
Content-Type: application/json

{ "reference": "GS-2026-0042", "customer": "Nile Towers" }
```

`reference` is matched against whatever field is each document's reference: an
uploaded document's reference number, or a made document's lookup field,
whatever its template calls it. `customer` is the second value: the customer's
name for an uploaded document with a customer, or the template's second field.
A document that has a second value is found only when it matches too; one
without is found by its reference alone. Values are compared exactly, ignoring
capitals and extra spaces.

Naming the template's fields still works, for websites built before 1.2.4:

```json
{
  "key": { "field": "certificate", "value": "GS-2026-0042" },
  "confirm": { "field": "customer", "value": "Nile Towers" }
}
```

Send one form or the other: `reference` (with `customer`), or `key` (with
`confirm`).

## The answer

Always `200` when the key is good, with one document or none:

```json
{
  "found": true,
  "document": {
    "title": "Gas certificate · GS-2026-0042",
    "formTitle": "Gas safety certificate",
    "createdAt": "2026-10-16T09:00:00.000Z",
    "pageCount": 2,
    "link": "https://app.integr8-media.com/d/2Xq…",
    "viewUrl": "https://…",
    "downloadUrl": "https://…",
    "expiresAt": "2026-10-16T09:05:00.000Z",
    "fields": [
      { "key": "certificate", "label": { "en": "Certificate number" }, "value": "GS-2026-0042" }
    ]
  }
}
```

```json
{ "found": false, "document": null }
```

- `link` is the document's own page, the one its QR code opens. It is stable:
  safe to show and to link to.
- `viewUrl` opens the PDF in the browser and `downloadUrl` saves it. Both stop
  working at `expiresAt`, five minutes after they were made, so use them at once
  and never store them.
- An uploaded document has an empty `formTitle` and no page count; its fields
  are `reference` and, when it has a customer, `customer`.
- A document that is not shared, was stopped, has expired or was deleted is not
  found: the same `found: false` as for a reference nobody issued.

Other answers:

| Status | `error.code`          | Meaning                                                                                                             |
| ------ | --------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 422    | `validation_failed`   | The body is not as above (for example both `reference` and `key`, or neither).                                      |
| 401    | `website_key_invalid` | No key, a mistyped key, or a revoked one.                                                                           |
| 403    | `feature_disabled`    | The documents module is off for the company, or Integr8's `website_files` grant or the company's own switch is off. |
| 429    | `rate_limited`        | More than 60 lookups a minute with this key; slow down.                                                             |

## A Next.js example

A Server Action does the lookup on the server; the page only ever sees the
result. App Router, TypeScript.

`app/certificates/actions.ts`:

```ts
'use server';

export interface LookupResult {
  found: boolean;
  title?: string;
  link?: string;
  viewUrl?: string;
  downloadUrl?: string;
}

export async function findCertificate(
  _previous: LookupResult | null,
  form: FormData,
): Promise<LookupResult> {
  const number = String(form.get('number') ?? '').trim();
  const customer = String(form.get('customer') ?? '').trim();
  if (number === '') {
    return { found: false };
  }
  const response = await fetch(`${process.env.INTEGR8_API_URL}/v1/website/documents/lookup`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${process.env.INTEGR8_WEBSITE_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ reference: number, ...(customer === '' ? {} : { customer }) }),
    cache: 'no-store',
  });
  if (!response.ok) {
    // 401, 403 or 429: log it on the server, show the visitor "not found".
    console.error('Integr8 lookup failed', response.status);
    return { found: false };
  }
  const body = (await response.json()) as {
    found: boolean;
    document: { title: string; link: string; viewUrl: string; downloadUrl: string } | null;
  };
  return body.document === null
    ? { found: false }
    : {
        found: true,
        title: body.document.title,
        link: body.document.link,
        viewUrl: body.document.viewUrl,
        downloadUrl: body.document.downloadUrl,
      };
}
```

`app/certificates/page.tsx`:

```tsx
'use client';

import { useActionState } from 'react';
import { findCertificate, type LookupResult } from './actions';

export default function CertificatesPage() {
  const [result, search, searching] = useActionState<LookupResult | null, FormData>(
    findCertificate,
    null,
  );
  return (
    <main>
      <h1>Check a certificate</h1>
      <form action={search}>
        <label>
          Certificate number <input name="number" required />
        </label>
        <label>
          Customer name <input name="customer" required />
        </label>
        <button type="submit" disabled={searching}>
          Find
        </button>
      </form>
      {result === null ? null : result.found ? (
        <p>
          {result.title}: <a href={result.viewUrl}>View</a> ·{' '}
          <a href={result.downloadUrl}>Download</a> · <a href={result.link}>Permanent link</a>
        </p>
      ) : (
        <p>No certificate matches.</p>
      )}
    </main>
  );
}
```

## Good practice

- Ask for both values: a number alone is easy to guess, a number and a name
  together are not. Ask the company to choose the customer when it uploads a
  document, and Integr8 to give its templates a second field, so its documents
  need both.
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

| Method | Endpoint                           | Returns                                                                                                 |
| ------ | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `POST` | `/v1/website/documents/lookup`     | One shared document found by its reference, and the customer's name when it has one.                    |
| `GET`  | `/v1/website/files/{documentId}`   | Five-minute view and download links for one shared, ready document.                                     |
| `GET`  | `/v1/website/jobs/{workOrderId}`   | Customer-safe job reference, status, title and due dates.                                               |
| `GET`  | `/v1/website/quotes/{quoteId}`     | One issued quote with customer-visible terms, totals and lines. Drafts and internal notes are excluded. |
| `GET`  | `/v1/website/invoices/{invoiceId}` | One issued invoice summary. Drafts and internal notes are excluded.                                     |

Each capability is checked separately against the company's switch and
Integr8's grant, both off for a new company; documents, quotes and invoices
also need their product module switched on. Turning off either switch blocks new
requests for that capability only. Disabling a website key blocks every
capability; revoking it cannot be undone.

The company website is responsible for its visitor login and authorization. A
record UUID must come from a trusted company-controlled flow. The API key is a
company-wide credential and should only be used after the website has checked
that the visitor may access that specific record.
