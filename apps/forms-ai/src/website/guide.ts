import {
  type ContractField,
  DEFAULT_API_URL,
  DEFAULT_DOCUMENT_ROUTE,
  ENV_API_URL,
  ENV_WEBSITE_KEY,
  ERROR_BODY_EXAMPLE,
  LINK_MINUTES,
  LOOKUPS_PER_MINUTE,
  SEARCH_LIMIT,
  WEBSITE_ENDPOINTS,
} from './contract.js';

/**
 * What the AI reads before adding the shared PDF search to a company's
 * website (`get_website_guide`, `get_website_api`). The facts are those of
 * docs/documents/WEBSITE-LOOKUP.md, written for an AI working in the
 * website's code rather than for a person.
 */

export const WEBSITE_GUIDE_SECTIONS = [
  'overview',
  'setup',
  'document-page',
  'security',
  'troubleshooting',
] as const;
export type WebsiteGuideSection = (typeof WEBSITE_GUIDE_SECTIONS)[number];

export const WEBSITE_SECTION_TITLES: Readonly<Record<WebsiteGuideSection, string>> = {
  overview: 'What the page does and the order of work',
  setup: 'What the company and Integr8 must do first; the environment',
  'document-page': 'The page shared links and QR codes open (/documents/<code>)',
  security: 'Rules the code must keep',
  troubleshooting: 'When the page finds nothing',
};

function overview(): string {
  return `# Shared PDF pages on a company website — overview

An Integr8 Plus company issues PDF documents (certificates, reports) and can **share** them. Its own website then gets two pages, both asking Integr8 Plus from the website's **server** with a **website key** (\`i8wk_…\`) that Integr8 staff create for the company:

- **The search page.** One search box: the company's customer types what the company gave them (a certificate number, a serial number) and gets **View** and **Download** for every shared document whose reference, or one of the fields the company made searchable, is exactly that. At most ${String(SEARCH_LIMIT)} come back; never the whole list, and never by the customer's name, so nobody can browse a company's documents.
- **The document page**, \`/${DEFAULT_DOCUMENT_ROUTE}/<code>\`. When Integr8 points the company's document links at its website, every shared link and new QR code opens this page instead of Integr8's own (see section "document-page").

- The website must be **Next.js (App Router)**; the example uses a Server Action and a server component. Other stacks are not covered by this tool.
- This tool works offline: it never calls Integr8 and never holds the key. The developer tests the pages against the real API themselves.

## Order of work

1. \`get_website_guide\` "setup": confirm the developer has the key, the API address and the switches.
2. \`get_website_api\`: the exact requests and answers.
3. \`get_website_example\`: the files for both pages (options: the search page's folder, the document page's folder, src folder, language).
4. Add them to the website, fitted to its styling, layout and i18n.
5. \`check_website_integration\` with the website's folder; fix every problem, then the warnings.
6. Tell Integr8 the document page's address (\`https://<site>/${DEFAULT_DOCUMENT_ROUTE}/{code}\`) so staff point the company's links at it.
7. The developer sets the environment, runs the site and tries a shared document, its link, a wrong number and a made-up code.

${contents()}`;
}

function setup(): string {
  return `# Before the page can find anything

## From Integr8 (staff)

- **The website key**, starting \`i8wk_\`. Only an Integr8 staff manager can create it, on the platform dashboard (company → Website keys). It is shown once; a company can have two live keys, so the website can move to a new one before the old is revoked.
- **The API address**: \`${DEFAULT_API_URL}\` in production.
- **Integr8's grant** \`website_files\` on the company's Features panel, and the company's **documents** module on.

## From the company (owner or admin)

- **Settings → Website access**: switch on documents for the website.
- **Share** each document the website may show: every document has a Sharing switch in the Documents register, and **new documents start not shared**. A not-shared, stopped, expired or deleted document is answered exactly like a number nobody issued.
- **What the search finds**: an uploaded PDF by its reference number and by any **extra field** typed for it (Documents → Upload a PDF → Add field, or later on its page); a made document by its template's lookup field. Never by the customer's name.

## The document link address (Integr8 staff)

On the company's page in the platform dashboard (Website and apps → **Document link address**), staff set where shared links and new QR codes open: \`https://<the registered website>/${DEFAULT_DOCUMENT_ROUTE}/{code}\` by default, on the company's registered website or a host under it. Set it **after** the document page is live: until then links keep opening Integr8's own page. QR codes printed before keep working at Integr8's address.

## The environment (server only)

| Name | Value |
| --- | --- |
| \`${ENV_API_URL}\` | \`${DEFAULT_API_URL}\` |
| \`${ENV_WEBSITE_KEY}\` | \`i8wk_…\` |

- Locally in \`.env.local\` (git-ignored by Next.js). On Vercel: Settings → Environment Variables (Production, and Preview if wanted), then redeploy.
- Never prefix with \`NEXT_PUBLIC_\`; never write the key in code, in \`.env.example\`, in a commit or in a message to the AI. Ask the developer to paste it into the file themselves.
- One extra package: \`server-only\`.
`;
}

function security(): string {
  return `# Rules the code must keep

1. **The key stays on the server.** Read \`process.env.${ENV_WEBSITE_KEY}\` only in a Server Action, a Route Handler or a module that starts with \`import 'server-only'\`. Never in a \`'use client'\` file, never in props, never in a response, never in a log.
2. **One answer for every failure.** Not found, 401, 403 and 422 all show the visitor the same "no document matches". Log the status on the server. Only 429 may say "try again in a minute".
3. **One search box, sent as \`q\`.** Don't ask for the customer name: the search never matches it, and a company that wants a document hard to find gives it a reference nobody can guess.
4. **Use the links at once.** \`viewUrl\` and \`downloadUrl\` work for ${String(LINK_MINUTES)} minutes: send them straight to the visitor; never store, cache or email them. \`link\` (the document's own page) and \`code\` are stable and safe to keep.
5. **No caching.** \`cache: 'no-store'\` on every call to Integr8.
6. **A limit per visitor.** Integr8 allows ${String(LOOKUPS_PER_MINUTE)} lookups a minute per key, shared by all visitors. Put the website's own limit in front (Vercel Firewall rate limiting, or middleware) so one visitor cannot use it up.
7. **Don't index the pages** (\`robots: { index: false }\`), and don't put what the visitor typed in the URL. The document page's code in its address is fine: it is 128 random bits, and it is what the link was made of.
9. **The document page says one thing for every refusal**: "This link is not valid", whatever the reason (unknown code, not shared, stopped, expired, another company's, a switch off). Check the code's shape (22 characters of A–Z a–z 0–9 _ -) before calling, and render it on the server for every visit (\`dynamic = 'force-dynamic'\`).
8. **Don't invent endpoints.** Only those in \`get_website_api\` exist.
`;
}

function troubleshooting(): string {
  return `# When the page finds nothing

The visitor always sees "not found"; the server log says why.

| Server log | Cause | Fix |
| --- | --- | --- |
| \`${ENV_API_URL} or ${ENV_WEBSITE_KEY} is not set\` | The environment is missing on this deployment. | Add both in Vercel (or .env.local) and redeploy. |
| 401 \`website_key_invalid\` | Mistyped, disabled or revoked key. | Ask Integr8 for the key's state or a new key. |
| 403 \`feature_disabled\` | Integr8's \`website_files\` grant, the company's Website access switch, or the documents module is off. | Ask Integr8 / the company owner. |
| 422 \`validation_failed\` | The website sent a wrong body (not exactly one of \`q\`, \`reference\` and \`key\`, or too long), or a malformed code. | Fix the code; see \`get_website_api\`. |
| 429 \`rate_limited\` | Over ${String(LOOKUPS_PER_MINUTE)} lookups a minute with this key. | Wait (\`Retry-After\` header); add a per-visitor limit. |
| 200 \`found: false\` (search) | No shared document whose reference or searchable field is exactly what was typed. | Check the document's Sharing switch, that its link was not stopped or expired, and that the text matches a field exactly (capitals and extra spaces are ignored; part of a value does not match). A customer name never matches. |
| 200 \`found: false\` (document page) | The code is not one of this company's shared, live documents. | Check the document's Sharing switch and its link in the company's register. A code from another company's document is never found with this key. |
| Shared links open a 404 on the website | Integr8 pointed the links at the website before the page existed, or at another address. | Add the document page at the address Integr8 set (\`get_website_example\` "documentRoute"), or ask Integr8 to change the address. |
`;
}

function documentPage(): string {
  return `# The document page: /${DEFAULT_DOCUMENT_ROUTE}/<code>

Every shared document has a link and a QR code. By default they open Integr8's own page. When Integr8 staff set the company's **document link address** (for example \`https://www.example.com/${DEFAULT_DOCUMENT_ROUTE}/{code}\`), every link shown or copied from then on, every share by email or WhatsApp, and the QR code on every new PDF open **the company's website** instead, with the document's code in the address.

So the website needs a page at that address:

- \`app/${DEFAULT_DOCUMENT_ROUTE}/[code]/page.tsx\` (or the folder that matches the address Integr8 set), a **server component** rendered for every visit (\`export const dynamic = 'force-dynamic'\`).
- It reads \`code\` from the address, checks it is 22 characters of A–Z a–z 0–9 _ -, and asks \`GET /v1/website/documents/by-code/{code}\` with the website key, from the server.
- Found: the title, the form, the date, the fields, **View** and **Download** (five-minute links: rendered fresh on each visit, never cached).
- Anything else: "This link is not valid" — the same words whatever the reason.
- Not indexed (\`robots: { index: false }\`).

\`get_website_example\` writes this page (option \`documentRoute\`, "${DEFAULT_DOCUMENT_ROUTE}" by default) beside the search page. Once it is deployed, give Integr8 its address; links switch over when staff save it. QR codes printed earlier keep opening Integr8's page, which keeps working.
`;
}

const BUILDERS: Readonly<Record<WebsiteGuideSection, () => string>> = {
  overview,
  setup,
  'document-page': documentPage,
  security,
  troubleshooting,
};

export function websiteGuideSection(section: WebsiteGuideSection): string {
  return BUILDERS[section]();
}

function contents(): string {
  return `## Sections (call get_website_guide with "section")\n\n${WEBSITE_GUIDE_SECTIONS.map((section) => `- \`${section}\`: ${WEBSITE_SECTION_TITLES[section]}`).join('\n')}\n`;
}

const table = (fields: readonly ContractField[]) =>
  [
    '| Field | Type | Required | Meaning |',
    '| --- | --- | --- | --- |',
    ...fields.map(
      (field) =>
        `| \`${field.name}\` | ${field.type} | ${field.required ? 'yes' : 'no'} | ${field.meaning} |`,
    ),
  ].join('\n');

/** The two endpoints, as the AI needs them to write the call. */
export function websiteApiText(): string {
  const parts = [
    `# Integr8 Plus website API for shared documents

Base: \`process.env.${ENV_API_URL}\` (\`${DEFAULT_API_URL}\` in production). Every request: \`Authorization: Bearer <process.env.${ENV_WEBSITE_KEY}>\`, from the website's server only. JSON in and out. A refusal's body is:

\`\`\`json
${JSON.stringify(ERROR_BODY_EXAMPLE, null, 2)}
\`\`\`
`,
  ];
  for (const endpoint of WEBSITE_ENDPOINTS) {
    // Two of them answer with documents; the third, by id, is older and narrower.
    parts.push(`## ${endpoint.method} ${endpoint.path}\n\n${endpoint.summary}\n`);
    if (endpoint.pathParams.length > 0) {
      parts.push(`Path:\n\n${table(endpoint.pathParams)}\n`);
    }
    if (endpoint.body.length > 0) {
      parts.push(`Body (JSON):\n\n${table(endpoint.body)}\n`);
    }
    parts.push(`200 answer:\n\n${table(endpoint.response)}\n`);
    if (endpoint.documentFields.length > 0) {
      parts.push(
        `${endpoint.key === 'lookup' ? 'Each of `documents`, and `document`' : '`document`'}:\n\n${table(endpoint.documentFields)}\n`,
      );
    }
    parts.push(
      [
        'Refusals:',
        '',
        '| Status | `error.code` | Meaning | What the website does |',
        '| --- | --- | --- | --- |',
        ...endpoint.errors.map(
          (error) =>
            `| ${String(error.status)} | \`${error.code}\` | ${error.meaning} | ${error.website} |`,
        ),
        '',
      ].join('\n'),
    );
  }
  parts.push(`## Examples

\`\`\`http
POST /v1/website/documents/lookup
Authorization: Bearer i8wk_…
Content-Type: application/json

{ "q": "GS-2026-0042" }
\`\`\`

\`\`\`json
{
  "found": true,
  "documents": [
    {
      "title": "Gas certificate · GS-2026-0042",
      "formTitle": "Gas safety certificate",
      "createdAt": "2026-10-16T09:00:00.000Z",
      "pageCount": 2,
      "link": "https://www.example.com/documents/2XqA7…",
      "code": "2XqA7…",
      "viewUrl": "https://…",
      "downloadUrl": "https://…",
      "expiresAt": "2026-10-16T09:05:00.000Z",
      "fields": [{ "key": "certificate", "label": { "en": "Certificate number", "ar": "رقم الشهادة" }, "value": "GS-2026-0042" }]
    }
  ],
  "document": { "…": "the first of documents" }
}
\`\`\`

\`\`\`json
{ "found": false, "document": null, "documents": [] }
\`\`\`

\`\`\`http
GET /v1/website/documents/by-code/2XqA7…
Authorization: Bearer i8wk_…
\`\`\`

\`\`\`json
{ "found": true, "document": { "title": "…", "code": "2XqA7…", "viewUrl": "https://…", "…": "as above" } }
\`\`\`

Matching is exact after trimming and ignoring capitals: part of a value does not match. The search never matches the customer name.

Integr8's other website endpoints (\`/v1/website/jobs/{id}\`, \`/quotes/{id}\`, \`/invoices/{id}\`) need the website's own customer sign-in and are outside this tool.
`);
  return parts.join('\n');
}
