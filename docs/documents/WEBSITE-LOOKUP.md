# Connecting a company's website to Integr8

For the developer of a company's own website (Next.js on Vercel). It lets the
company's authenticated customer see an issued document, job status, quote or
invoice through Integr8's API.

The website's **server** asks Integr8 Plus with a **website key**. The key is a
secret: it lives in the server's environment and never reaches a browser.
The company website must authenticate its own customers before making requests;
the key identifies the company website, not an individual customer.

## What you get from Integr8

- **The key**, which starts with `i8wk_`. Integr8 shows it once; keep it in a
  password manager until it is in Vercel.
- **The API address**, for example `https://api.integr8-media.com`.
- **The field names** to search by, agreed with Integr8 when the company's PDF
  template was designed: the field the visitor types (for example
  `certificate`) and, if the template asks for one, a second field that must
  match too (for example `customer`).
- **Capability switches.** The company owner or admin controls its switches in
  **Settings → Website access** (owners and admins). Integr8 controls four
  independent grants (`website_files`, `website_jobs`, `website_quotes`, and
  `website_invoices`) on the company's **Features** panel. Both sides must be
  on for that capability to work.
- **Key controls.** Only an Integr8 staff manager (an account made with the
  terminal command) can create, enable, disable, revoke or delete a key; other
  Integr8 staff can see that it exists and how it is used. Disabling is
  reversible; revoking stops service and leaves a record; deleting removes the
  record. A key's secret is never recoverable.

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

```http
POST /v1/website/documents/lookup
Authorization: Bearer i8wk_…
Content-Type: application/json

{
  "key": { "field": "certificate", "value": "GS-2026-0042" },
  "confirm": { "field": "customer", "value": "Nile Towers" }
}
```

`confirm` is needed only when the template has a second field. Values are
compared exactly, ignoring capitals and extra spaces.

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
- A document the company stopped, expired or deleted is not found.

Other answers:

| Status | `error.code`          | Meaning                                                                                                                          |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 422    | `validation_failed`   | The body is not as above.                                                                                                        |
| 401    | `website_key_invalid` | No key, a mistyped key, or a revoked one.                                                                                        |
| 403    | `feature_disabled`    | Documents are switched off for the company, or Integr8's `website_files` grant or the company's own website-files switch is off. |
| 429    | `rate_limited`        | More than 60 lookups a minute with this key; slow down.                                                                          |

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
    body: JSON.stringify({
      key: { field: 'certificate', value: number },
      ...(customer === '' ? {} : { confirm: { field: 'customer', value: customer } }),
    }),
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

- Ask for both fields when the template has two: a number alone is easy to
  guess, a number and a name together are not.
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
| `POST` | `/v1/website/documents/lookup`     | One document found by the agreed template field and optional confirmation field.                        |
| `GET`  | `/v1/website/files/{documentId}`   | Five-minute view and download links for one ready customer document.                                    |
| `GET`  | `/v1/website/jobs/{workOrderId}`   | Customer-safe job reference, status, title and due dates.                                               |
| `GET`  | `/v1/website/quotes/{quoteId}`     | One issued quote with customer-visible terms, totals and lines. Drafts and internal notes are excluded. |
| `GET`  | `/v1/website/invoices/{invoiceId}` | One issued invoice summary. Drafts and internal notes are excluded.                                     |

Each capability is checked separately against the company and Integr8 switches;
documents, quotes and invoices also require their existing product module to
be enabled. Turning off either website switch blocks new requests. Disabling a
website key blocks all capabilities; revoking it cannot be undone.

The company website is responsible for its visitor login and authorization. A
record UUID must come from a trusted company-controlled flow. The API key is a
company-wide credential and should only be used after the website has checked
that the visitor may access that specific record.
