/**
 * What a company website may ask Integr8 Plus for its shared PDF documents,
 * written out for the AI that builds the website (`get_website_api`).
 *
 * The program cannot import the API (apps never import each other, and it
 * must stay offline), so the three routes are described here by hand.
 * `contract.test.ts` reads `apps/api/openapi.json` and fails when a field, a
 * required flag or a status here stops matching the real routes
 * (`apps/api/src/routes/v1/documents-public.ts` and `website-data.ts`).
 */

export interface ContractField {
  name: string;
  type: string;
  required: boolean;
  meaning: string;
}

export interface ContractStatus {
  status: number;
  code: string;
  meaning: string;
  /** What the website should show the visitor. */
  website: string;
}

export interface WebsiteEndpoint {
  key: 'lookup' | 'byCode' | 'file';
  method: 'POST' | 'GET';
  /** As written in openapi.json. */
  path: string;
  summary: string;
  pathParams: ContractField[];
  body: ContractField[];
  response: ContractField[];
  /** The fields of `document` in the answer (and of each of `documents`), for the lookup and by code. */
  documentFields: ContractField[];
  errors: ContractStatus[];
}

/** The website key's shape: a prefix and 256 random bits (API `WEBSITE_KEY_PATTERN`). */
export const WEBSITE_KEY_PATTERN = /^i8wk_[A-Za-z0-9_-]{43}$/u;
/** The same, to find a key written anywhere in a file. */
export const WEBSITE_KEY_IN_TEXT = /i8wk_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/u;

export const ENV_API_URL = 'INTEGR8_API_URL';
export const ENV_WEBSITE_KEY = 'INTEGR8_WEBSITE_KEY';
export const DEFAULT_API_URL = 'https://api.integr8-media.com';
/** The API's default lookups per key per minute (`WEBSITE_LOOKUP_RATE_LIMIT`). */
export const LOOKUPS_PER_MINUTE = 60;
/** How long `viewUrl` and `downloadUrl` work. */
export const LINK_MINUTES = 5;
/** At most this many documents answer one search (API `WEBSITE_SEARCH_LIMIT`). */
export const SEARCH_LIMIT = 10;
/** A document link's code: 128 random bits, URL-safe (API `codeParams`). */
export const DOCUMENT_CODE_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
/** Where Integr8 suggests the document page lives on the website: `/documents/{code}`. */
export const DEFAULT_DOCUMENT_ROUTE = 'documents';

const auth: ContractStatus[] = [
  {
    status: 401,
    code: 'website_key_invalid',
    meaning: 'No key, a mistyped key, or a disabled or revoked one.',
    website: 'Log it on the server; show the visitor the same "not found" as for no match.',
  },
  {
    status: 403,
    code: 'feature_disabled',
    meaning:
      "Documents are off for the company, or Integr8's `website_files` grant or the company's own Website access switch is off.",
    website: 'Log it on the server; show "not found". Ask Integr8 / the company to switch it on.',
  },
];

const tooMany: ContractStatus = {
  status: 429,
  code: 'rate_limited',
  meaning: `More than ${String(LOOKUPS_PER_MINUTE)} requests a minute with this key (the limit is per key, shared by every visitor).`,
  website: 'Show "please try again in a minute". Add your own limit per visitor in front.',
};

/** The fields of one found document, the same in the search and by code. */
const DOCUMENT_FIELDS: ContractField[] = [
  { name: 'title', type: 'string', required: true, meaning: "The document's title." },
  {
    name: 'formTitle',
    type: 'string',
    required: true,
    meaning: 'The form it was made from; empty for an uploaded PDF.',
  },
  { name: 'createdAt', type: 'ISO date-time', required: true, meaning: 'When it was made.' },
  {
    name: 'pageCount',
    type: 'integer or null',
    required: true,
    meaning: 'Pages; null for an uploaded PDF.',
  },
  {
    name: 'link',
    type: 'string or null',
    required: true,
    meaning:
      "The document's own link (what its QR code opens): the company website's document page when Integr8 set one up, else Integr8's page. Stable: safe to show and link to.",
  },
  {
    name: 'code',
    type: 'string (22 characters)',
    required: true,
    meaning:
      "The link's code: what the website's own document page (`/documents/{code}`) is opened with. Stable, safe in an address.",
  },
  {
    name: 'viewUrl',
    type: 'string',
    required: true,
    meaning: `Opens the PDF in the browser. Works for ${String(LINK_MINUTES)} minutes: use at once, never store or cache.`,
  },
  {
    name: 'downloadUrl',
    type: 'string',
    required: true,
    meaning: `Saves the PDF under its title. Works for ${String(LINK_MINUTES)} minutes, like viewUrl.`,
  },
  {
    name: 'expiresAt',
    type: 'ISO date-time',
    required: true,
    meaning: 'When viewUrl and downloadUrl stop working.',
  },
  {
    name: 'fields',
    type: '{ key, label: { en?, ar? }, value }[]',
    required: true,
    meaning:
      "The document's fields with their labels in each language (an uploaded PDF: `reference`, maybe `customer`, and the fields the company typed, `custom_1`…).",
  },
];

export const WEBSITE_ENDPOINTS: readonly WebsiteEndpoint[] = [
  {
    key: 'lookup',
    method: 'POST',
    path: '/v1/website/documents/lookup',
    summary: `The search box. Send what the visitor typed as \`q\`: every shared document with a searchable field (its reference, a made document's lookup field, or a field the company typed on an uploaded PDF) exactly equal to it, ignoring capitals and extra spaces, comes back in \`documents\`, newest first, at most ${String(SEARCH_LIMIT)}. Never matched against the customer name.`,
    pathParams: [],
    body: [
      {
        name: 'q',
        type: 'string, 1–500 characters',
        required: false,
        meaning:
          'What the visitor typed in the one search box. Use this in new websites; send exactly one of `q`, `reference` or `key`.',
      },
      {
        name: 'reference',
        type: 'string, 1–500 characters',
        required: false,
        meaning:
          "Older form (websites built before the one search box): matched against each document's reference only, with `customer`. Finds one document or none.",
      },
      {
        name: 'customer',
        type: 'string, 1–500 characters',
        required: false,
        meaning:
          "Older form, with `reference`: the customer name (or the template's second field). A document that has one is found only when it matches too.",
      },
      {
        name: 'key',
        type: '{ field: string (1–64), value: string (1–500) }',
        required: false,
        meaning:
          'Oldest form, for websites built before 1.2.4: a named template field. Use `q` in new websites.',
      },
      {
        name: 'confirm',
        type: '{ field: string (1–64), value: string (1–500) }',
        required: false,
        meaning: 'The second value with `key`. Use `q` in new websites.',
      },
    ],
    response: [
      {
        name: 'found',
        type: 'boolean',
        required: true,
        meaning: 'Whether at least one document matched.',
      },
      {
        name: 'documents',
        type: 'object[]',
        required: true,
        meaning: `Every match, newest first, at most ${String(SEARCH_LIMIT)}; empty when none. Each has the fields below.`,
      },
      {
        name: 'document',
        type: 'object or null',
        required: true,
        meaning: 'The newest match (the first of `documents`), else null. Kept for older websites.',
      },
    ],
    documentFields: DOCUMENT_FIELDS,
    errors: [
      {
        status: 422,
        code: 'validation_failed',
        meaning:
          'The body is wrong: not exactly one of `q`, `reference` and `key`, or a value too long.',
        website: 'A bug in the website: fix the request. Show "not found".',
      },
      ...auth,
      tooMany,
    ],
  },
  {
    key: 'byCode',
    method: 'GET',
    path: '/v1/website/documents/by-code/{code}',
    summary:
      "The document page. When Integr8 points a company's document links at its website (`https://<site>/documents/{code}`), every shared link and new QR code opens that page; it asks this with the code from its address. Found only for one of this company's documents that is shared and live; anything else is `found: false`.",
    pathParams: [
      {
        name: 'code',
        type: 'string, 22 characters of A–Z a–z 0–9 _ -',
        required: true,
        meaning: "The code from the page's address.",
      },
    ],
    body: [],
    response: [
      {
        name: 'found',
        type: 'boolean',
        required: true,
        meaning: 'Whether the code opens a document.',
      },
      {
        name: 'document',
        type: 'object or null',
        required: true,
        meaning: 'The document when found, else null.',
      },
    ],
    documentFields: DOCUMENT_FIELDS,
    errors: [
      {
        status: 422,
        code: 'validation_failed',
        meaning: 'The code is not 22 URL-safe characters.',
        website: 'Show "this link is not valid" (check the code first and skip the call).',
      },
      ...auth,
      tooMany,
    ],
  },
  {
    key: 'file',
    method: 'GET',
    path: '/v1/website/files/{documentId}',
    summary:
      'Fresh five-minute links for one shared document whose id the website already holds from a trusted, company-controlled flow. Not a search: there is no list.',
    pathParams: [
      { name: 'documentId', type: 'UUID', required: true, meaning: "The document's id." },
    ],
    body: [],
    response: [
      { name: 'documentId', type: 'UUID', required: true, meaning: "The document's id." },
      { name: 'title', type: 'string', required: true, meaning: "The document's title." },
      { name: 'pageCount', type: 'integer or null', required: true, meaning: 'Pages, if known.' },
      { name: 'viewUrl', type: 'string', required: true, meaning: 'As in the lookup.' },
      { name: 'downloadUrl', type: 'string', required: true, meaning: 'As in the lookup.' },
      { name: 'expiresAt', type: 'ISO date-time', required: true, meaning: 'As in the lookup.' },
    ],
    documentFields: [],
    errors: [
      ...auth,
      {
        status: 404,
        code: 'not_found',
        meaning: 'No such document, or not shared, stopped, expired or deleted.',
        website: 'Show "not found".',
      },
      {
        status: 422,
        code: 'validation_failed',
        meaning: 'The id is not a UUID.',
        website: 'Show "not found".',
      },
      tooMany,
    ],
  },
];

/** Every `/v1/website/…` path the API has, documents or not, so a check can spot an invented one. */
export const KNOWN_WEBSITE_PATHS: readonly RegExp[] = [
  /^\/v1\/website\/documents\/lookup$/u,
  /^\/v1\/website\/documents\/by-code\/[^/]+$/u,
  /^\/v1\/website\/files\/[^/]+$/u,
  /^\/v1\/website\/jobs\/[^/]+$/u,
  /^\/v1\/website\/quotes\/[^/]+$/u,
  /^\/v1\/website\/invoices\/[^/]+$/u,
];

/** The error body every refusal carries (openapi `Error`). */
export const ERROR_BODY_EXAMPLE = {
  error: {
    code: 'website_key_invalid',
    message: 'This website key is not valid.',
    requestId: 'req_…',
  },
};
