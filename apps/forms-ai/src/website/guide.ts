import {
  type ContractField,
  DEFAULT_API_URL,
  ENV_API_URL,
  ENV_WEBSITE_KEY,
  ERROR_BODY_EXAMPLE,
  LINK_MINUTES,
  LOOKUPS_PER_MINUTE,
  WEBSITE_ENDPOINTS,
} from './contract.js';

/**
 * What the AI reads before adding the shared PDF search to a company's
 * website (`get_website_guide`, `get_website_api`). The facts are those of
 * docs/documents/WEBSITE-LOOKUP.md, written for an AI working in the
 * website's code rather than for a person.
 */

export const WEBSITE_GUIDE_SECTIONS = ['overview', 'setup', 'security', 'troubleshooting'] as const;
export type WebsiteGuideSection = (typeof WEBSITE_GUIDE_SECTIONS)[number];

export const WEBSITE_SECTION_TITLES: Readonly<Record<WebsiteGuideSection, string>> = {
  overview: 'What the page does and the order of work',
  setup: 'What the company and Integr8 must do first; the environment',
  security: 'Rules the code must keep',
  troubleshooting: 'When the page finds nothing',
};

function overview(): string {
  return `# Shared PDF search on a company website — overview

An Integr8 Plus company issues PDF documents (certificates, reports) and can **share** them. Its own website can then offer a page where the company's customer types a reference number (and the customer name) and gets **View** and **Download** for that one document. The website's **server** asks Integr8 Plus with a **website key** (\`i8wk_…\`) that Integr8 staff create for the company.

- One document or none per search, never a list: the API has no list or search endpoint, by design, so nobody can browse a company's documents by guessing.
- The website must be **Next.js (App Router)**; the example uses a Server Action. Other stacks are not covered by this tool.
- This tool works offline: it never calls Integr8 and never holds the key. The developer tests the page against the real API themselves.

## Order of work

1. \`get_website_guide\` "setup": confirm the developer has the key, the API address and the switches.
2. \`get_website_api\`: the exact request and answers.
3. \`get_website_example\`: the files for the page (options: route, src folder, whether the customer name is required, language).
4. Add them to the website, fitted to its styling, layout and i18n.
5. \`check_website_integration\` with the website's folder; fix every problem, then the warnings.
6. The developer sets the environment, runs the site and tries a shared document and a wrong number.

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
- For documents that should need the customer name too: choose the customer when uploading a PDF; for made documents, Integr8 gives the template a second field.

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
3. **Ask for both values** when the company's documents have a second one (the customer name): a number alone is easy to guess.
4. **Use the links at once.** \`viewUrl\` and \`downloadUrl\` work for ${String(LINK_MINUTES)} minutes: send them straight to the visitor; never store, cache or email them. \`link\` (the document's page on Integr8) is stable and safe to keep.
5. **No caching.** \`cache: 'no-store'\` on every call to Integr8.
6. **A limit per visitor.** Integr8 allows ${String(LOOKUPS_PER_MINUTE)} lookups a minute per key, shared by all visitors. Put the website's own limit in front (Vercel Firewall rate limiting, or middleware) so one visitor cannot use it up.
7. **Don't index the page** (\`robots: { index: false }\`), and don't put the reference in the URL.
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
| 422 \`validation_failed\` | The website sent a wrong body (both \`reference\` and \`key\`, neither, too long). | Fix the code; see \`get_website_api\`. |
| 429 \`rate_limited\` | Over ${String(LOOKUPS_PER_MINUTE)} lookups a minute with this key. | Wait (\`Retry-After\` header); add a per-visitor limit. |
| 200 \`found: false\` | No shared document with this reference (and customer name). | Check the document's Sharing switch, that its link was not stopped or expired, and that the customer name matches exactly (capitals and extra spaces are ignored). |
`;
}

const BUILDERS: Readonly<Record<WebsiteGuideSection, () => string>> = {
  overview,
  setup,
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
    parts.push(`## ${endpoint.method} ${endpoint.path}\n\n${endpoint.summary}\n`);
    if (endpoint.pathParams.length > 0) {
      parts.push(`Path:\n\n${table(endpoint.pathParams)}\n`);
    }
    if (endpoint.body.length > 0) {
      parts.push(`Body (JSON):\n\n${table(endpoint.body)}\n`);
    }
    parts.push(`200 answer:\n\n${table(endpoint.response)}\n`);
    if (endpoint.documentFields.length > 0) {
      parts.push(`\`document\`:\n\n${table(endpoint.documentFields)}\n`);
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

{ "reference": "GS-2026-0042", "customer": "Nile Towers" }
\`\`\`

\`\`\`json
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
    "fields": [{ "key": "certificate", "label": { "en": "Certificate number", "ar": "رقم الشهادة" }, "value": "GS-2026-0042" }]
  }
}
\`\`\`

\`\`\`json
{ "found": false, "document": null }
\`\`\`

Matching is exact after trimming and ignoring capitals. A document with a second value is found only when \`customer\` matches too; one without is found by \`reference\` alone.

Integr8's other website endpoints (\`/v1/website/jobs/{id}\`, \`/quotes/{id}\`, \`/invoices/{id}\`) need the website's own customer sign-in and are outside this tool.
`);
  return parts.join('\n');
}
