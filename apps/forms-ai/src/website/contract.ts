/**
 * What a company website may ask Integr8 Plus for its shared PDF documents,
 * written out for the AI that builds the website (`get_website_api`).
 *
 * The program cannot import the API (apps never import each other, and it
 * must stay offline), so the two routes are described here by hand.
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
  key: 'lookup' | 'file';
  method: 'POST' | 'GET';
  /** As written in openapi.json. */
  path: string;
  summary: string;
  pathParams: ContractField[];
  body: ContractField[];
  response: ContractField[];
  /** The fields of `document` in the answer, for the lookup. */
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

export const WEBSITE_ENDPOINTS: readonly WebsiteEndpoint[] = [
  {
    key: 'lookup',
    method: 'POST',
    path: '/v1/website/documents/lookup',
    summary:
      'Find one shared document by the reference a visitor typed (a certificate number), with the second value (the customer name) when the document has one. One match or none, never a list.',
    pathParams: [],
    body: [
      {
        name: 'reference',
        type: 'string, 1–500 characters',
        required: false,
        meaning:
          "What the visitor typed: matched against each document's reference (an uploaded document's reference number, or a made document's lookup field). Send this or `key`, never both.",
      },
      {
        name: 'customer',
        type: 'string, 1–500 characters',
        required: false,
        meaning:
          "The second value, with `reference`: the customer name (or the template's second field). A document that has one is found only when it matches too.",
      },
      {
        name: 'key',
        type: '{ field: string (1–64), value: string (1–500) }',
        required: false,
        meaning:
          'Older form, for websites built before 1.2.4: a named template field. Use `reference` in new websites.',
      },
      {
        name: 'confirm',
        type: '{ field: string (1–64), value: string (1–500) }',
        required: false,
        meaning: 'The second value with `key`. Use `customer` in new websites.',
      },
    ],
    response: [
      { name: 'found', type: 'boolean', required: true, meaning: 'Whether one document matched.' },
      {
        name: 'document',
        type: 'object or null',
        required: true,
        meaning: 'The document when found, else null.',
      },
    ],
    documentFields: [
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
          "The document's own page on Integr8 (what its QR code opens). Stable: safe to show and link to.",
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
          "The document's fields with their labels in each language (an uploaded PDF: `reference` and maybe `customer`).",
      },
    ],
    errors: [
      {
        status: 422,
        code: 'validation_failed',
        meaning: 'The body is wrong: both `reference` and `key`, neither, or a value too long.',
        website: 'A bug in the website: fix the request. Show "not found".',
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
