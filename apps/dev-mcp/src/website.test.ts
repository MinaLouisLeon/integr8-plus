import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection } from './connection.js';
import { envFileProblem, writeEnvValues } from './envfile.js';
import { RouteIndex } from './openapi.js';
import { testPdf } from './pdf.js';
import { redact } from './redact.js';
import { createDevServer } from './server.js';
import { boxVault, memoryVault, type SecretBox } from './store.js';
import { Trace } from './trace.js';

/**
 * The website tools (P43) as an AI tool calls them, against a stand-in API.
 * What is proved: the website key is kept and written to `.env.local` but
 * never reaches a result or the trace; call_website_api sends that key and no
 * person's token; call_api refuses a website route; set_website_access and
 * seed_shared_documents call the routes in order.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const KEY_ID = '77777777-7777-4777-8777-777777777777';
const SECRET = 'i8wk_secret-website-key-value-abcdefghijklmnopqrstu';
const STAFF = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJzdGFmZi1vbmUifQ.c3RhZmYtc2lnbmF0dXJl';
const GRANT = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJncmFudC1vbmUifQ.Z3JhbnQtc2lnbmF0dXJl';
const MEDIA = '88888888-8888-4888-8888-888888888888';
const DOCUMENT = '99999999-9999-4999-8999-999999999999';

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

const seen: Seen[] = [];
let api: Server;
let base: string;
let folder: string;
let trace: Trace;
let lookups = 0;
const client = new Client({ name: 'test', version: '1.0.0' });

function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'req-1' });
  response.end(JSON.stringify(body));
}

const key = () => ({
  id: KEY_ID,
  hint: 'rstu',
  label: 'Developer MCP',
  enabled: true,
  createdAt: new Date().toISOString(),
  createdBy: 'Dev',
  revokedAt: null,
  lastUsedAt: lookups === 0 ? null : new Date().toISOString(),
  lookups,
  found: lookups,
});

const document = (shareable: boolean) => ({
  id: DOCUMENT,
  title: 'Boiler certificate',
  status: 'ready',
  failureCode: null,
  shareable,
  linkOpens: true,
  link: 'http://localhost:3000/documents/ABC123',
  publicCode: 'ABC123',
  reference: 'CERT-0042',
  fields: [
    { key: 'reference', label: 'Reference', value: 'CERT-0042', lookupRole: 'key' },
    { key: 'f1', label: 'Serial', value: 'SN-77', lookupRole: 'search' },
  ],
});

async function handle(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const body: unknown =
    raw.length === 0
      ? null
      : (request.headers['content-type'] ?? '').includes('json')
        ? JSON.parse(raw.toString('utf8'))
        : { bytes: raw.length, start: raw.subarray(0, 5).toString('latin1') };
  seen.push({ method: request.method ?? '', path: url.pathname, headers: request.headers, body });
  const route = `${request.method ?? ''} ${url.pathname}`;
  const companyPath = `/v1/platform/companies/${TENANT}`;
  switch (route) {
    case 'GET /v1/platform/companies':
      return reply(response, 200, {
        items: [{ id: TENANT, name: 'Nile Test Co', slug: 'nile-test', isTest: true }],
      });
    case `POST ${companyPath}/impersonate`:
      return reply(response, 201, {
        grantId: '44444444-4444-4444-8444-444444444444',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        tokens: { accessToken: GRANT },
      });
    case 'GET /v1/members':
      return reply(response, 200, { items: [] });
    case `POST ${companyPath}/website-keys`:
      return reply(response, 201, { key: key(), secret: SECRET });
    case `GET ${companyPath}/website-keys`:
      return reply(response, 200, { items: [key()], canManage: true, canDelete: true, maxLive: 2 });
    case `POST ${companyPath}/website-keys/${KEY_ID}/revoke`:
      return reply(response, 200, { ...key(), revokedAt: new Date().toISOString() });
    case `PUT ${companyPath}/flags/documents`:
    case `PUT ${companyPath}/flags/website_files`:
      return reply(response, 200, { flags: { documents: true, website_files: true } });
    case `PATCH ${companyPath}/settings`:
      return reply(response, 200, body);
    case 'PATCH /v1/settings/website-access':
      return reply(response, 200, body);
    case 'POST /v1/media':
      return reply(response, 201, {
        media: { id: MEDIA },
        upload: {
          url: `${base}/upload/${MEDIA}?X-Amz-Signature=signed-part-must-stay-hidden`,
          method: 'PUT',
          headers: { 'content-type': 'application/pdf' },
        },
      });
    case `PUT /upload/${MEDIA}`:
      response.writeHead(200);
      return response.end();
    case `POST /v1/media/${MEDIA}/complete`:
      return reply(response, 200, { id: MEDIA });
    case 'POST /v1/documents':
      return reply(response, 201, document(false));
    case `POST /v1/documents/${DOCUMENT}/share`:
      return reply(response, 200, document(true));
    case 'POST /v1/website/documents/lookup':
      lookups += 1;
      return reply(response, 200, {
        found: true,
        documents: [{ code: 'ABC123', viewUrl: `${base}/f?X-Amz-Signature=view-link-hidden` }],
      });
    default:
      return reply(response, 404, { error: { code: 'not_found' } });
  }
}

beforeAll(async () => {
  api = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${String((api.address() as AddressInfo).port)}`;
  folder = mkdtempSync(join(tmpdir(), 'dev-mcp-website-'));
  trace = new Trace({ folder });
  const connection = new Connection({
    api: base,
    tokens: {
      accessToken: STAFF,
      refreshToken: 'i8p1.refresh-token-value-abcdefgh',
      sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    trace,
    clientVersion: '2.0.0',
  });
  const websiteKeys = memoryVault();
  const server = createDevServer({
    routes: RouteIndex.load(),
    trace,
    context: () => Promise.resolve({ mode: 'remote', connection, websiteKeys }),
    forms: {
      host: {
        platform: process.platform,
        arch: process.arch,
        home: join(folder, 'home'),
        env: { INTEGR8_FORMS_OUTPUT: join(folder, 'forms') },
      },
      scratch: join(folder, 'scratch'),
      browser: () => undefined,
      openUrl: () => Promise.resolve(false),
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  await client.callTool({ name: 'use_company', arguments: { company: 'nile-test' } });
});

afterAll(async () => {
  await client.close();
  await new Promise((resolve) => api.close(resolve));
  rmSync(folder, { recursive: true, force: true });
});

const outputs: string[] = [];

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: { text?: string }[];
  };
  const text = result.content.map((part) => part.text ?? '').join('\n');
  outputs.push(text);
  return { text, error: result.isError === true };
}

describe('website keys', () => {
  it('refuses to write the key anywhere but a .env*.local file', async () => {
    const before = seen.length;
    for (const envFile of [
      join(folder, '.env'),
      join(folder, '.env.example'),
      'relative/.env.local',
    ]) {
      const refused = await call('create_website_key', { envFile });
      expect(refused.error, envFile).toBe(true);
    }
    expect(seen.length).toBe(before);
  });

  it('makes a key, keeps it, and writes it to .env.local without showing it', async () => {
    const envFile = join(folder, '.env.local');
    writeFileSync(envFile, 'OTHER=1\nINTEGR8_WEBSITE_KEY=old\n');
    const made = await call('create_website_key', { envFile });
    expect(made.error).toBe(false);
    expect(made.text).toMatch(/Made key 7777.*…rstu/u);
    expect(made.text).not.toContain(SECRET);
    const written = readFileSync(envFile, 'utf8');
    expect(written).toBe(`OTHER=1\nINTEGR8_WEBSITE_KEY=${SECRET}\nINTEGR8_API_URL=${base}\n`);
    if (process.platform !== 'win32') {
      expect(statSync(envFile).mode & 0o777).toBe(0o600);
    }
  });

  it('lists the keys and says which are kept here', async () => {
    const listed = await call('list_website_keys');
    expect(listed.text).toMatch(/…rstu "Developer MCP": live.*kept here/u);
  });
});

describe('call_website_api', () => {
  it('sends the website key and no person, and reports the key’s use', async () => {
    const grants = seen.filter((entry) => entry.path.endsWith('/impersonate')).length;
    const answer = await call('call_website_api', {
      method: 'POST',
      path: '/v1/website/documents/lookup',
      body: { q: 'SN-77' },
    });
    expect(answer.error).toBe(false);
    expect(answer.text).toMatch(/^200 in \d+ ms .*as website \(key …rstu\)/u);
    expect(answer.text).toMatch(/Key use now: 1 lookups, 1 found/u);
    expect(answer.text).not.toContain('view-link-hidden');
    const sent = seen.findLast((entry) => entry.path === '/v1/website/documents/lookup');
    expect(sent?.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(seen.filter((entry) => entry.path.endsWith('/impersonate')).length).toBe(grants);
  });

  it('refuses a route that is not a website route, and call_api refuses a website route', async () => {
    expect((await call('call_website_api', { method: 'GET', path: '/v1/documents' })).error).toBe(
      true,
    );
    const refused = await call('call_api', {
      method: 'POST',
      path: '/v1/website/documents/lookup',
      as: 'company',
      purpose: 'looking a document up',
      body: { q: 'SN-77' },
    });
    expect(refused.error).toBe(true);
    expect(refused.text).toMatch(/call_website_api/u);
  });
});

describe('set_website_access', () => {
  it('switches the grants, the company’s switch and the website in order', async () => {
    const from = seen.length;
    const done = await call('set_website_access', {
      files: true,
      websiteUrl: 'http://localhost:3000',
      documentLinkPattern: 'http://localhost:3000/documents/{code}',
    });
    expect(done.error).toBe(false);
    expect(
      seen
        .slice(from)
        .map((entry) => `${entry.method} ${entry.path}`)
        .filter((path) => !path.endsWith('/impersonate') && !path.includes('/impersonate/')),
    ).toEqual([
      `PUT /v1/platform/companies/${TENANT}/flags/documents`,
      `PUT /v1/platform/companies/${TENANT}/flags/website_files`,
      'PATCH /v1/settings/website-access',
      `PATCH /v1/platform/companies/${TENANT}/settings`,
    ]);
    expect(seen.at(-2)?.body).toEqual({ websiteFilesEnabled: true });
  });
});

describe('seed_shared_documents', () => {
  it('uploads a generated PDF, adds it with its fields and shares it', async () => {
    const from = seen.length;
    const seeded = await call('seed_shared_documents', {
      documents: [
        {
          kind: 'uploaded',
          title: 'Boiler certificate',
          reference: 'CERT-0042',
          fields: [{ label: 'Serial', value: 'SN-77' }],
        },
      ],
    });
    expect(seeded.error).toBe(false);
    expect(seeded.text).toMatch(/code ABC123, shared/u);
    expect(seeded.text).toMatch(/search values: CERT-0042 \| SN-77/u);
    const paths = seen.slice(from).map((entry) => `${entry.method} ${entry.path}`);
    expect(
      paths.filter((path) => !path.endsWith('/impersonate') && !path.includes('/impersonate/')),
    ).toEqual([
      'POST /v1/media',
      `PUT /upload/${MEDIA}`,
      `POST /v1/media/${MEDIA}/complete`,
      'POST /v1/documents',
      `POST /v1/documents/${DOCUMENT}/share`,
    ]);
    const uploaded = seen.find((entry) => entry.path === `/upload/${MEDIA}`);
    expect(uploaded?.headers.authorization).toBeUndefined();
    expect((uploaded?.body as { start: string }).start).toBe('%PDF-');
    const added = seen.find((entry) => entry.path === '/v1/documents' && entry.method === 'POST');
    expect(added?.body).toMatchObject({
      fileId: MEDIA,
      reference: 'CERT-0042',
      fields: [{ label: 'Serial', value: 'SN-77' }],
      shareable: false,
    });
  });
});

describe('revoking', () => {
  it('revokes and forgets the key', async () => {
    expect((await call('revoke_website_key', { keyId: KEY_ID })).error).toBe(false);
    const after = await call('call_website_api', {
      method: 'POST',
      path: '/v1/website/documents/lookup',
      body: { q: 'SN-77' },
    });
    expect(after.error).toBe(true);
    expect(after.text).toMatch(/No website key is kept here/u);
  });
});

describe('secrets', () => {
  it('never shows the website key or a signed link in a result or the trace file', () => {
    const everything = [...outputs, readFileSync(trace.file ?? '', 'utf8')].join('\n');
    for (const secret of [
      SECRET,
      STAFF,
      GRANT,
      'signed-part-must-stay-hidden',
      'view-link-hidden',
    ]) {
      expect(everything).not.toContain(secret);
    }
  });
});

describe('the helpers', () => {
  it('accept only .env*.local files', () => {
    expect(envFileProblem(join(folder, '.env.local'))).toBeUndefined();
    expect(envFileProblem(join(folder, '.env.development.local'))).toBeUndefined();
    expect(envFileProblem(join(folder, '.env'))).toBeDefined();
    expect(envFileProblem(join(folder, '.env.production'))).toBeDefined();
    expect(envFileProblem('.env.local')).toBeDefined();
  });

  it('keep every other line, and quote what needs it', () => {
    const file = join(folder, '.env.test.local');
    writeFileSync(file, '# comment\r\nexport INTEGR8_API_URL=old\r\nKEEP=yes\r\n');
    writeEnvValues(file, { INTEGR8_API_URL: 'https://api.example', NEW: 'has space' });
    expect(readFileSync(file, 'utf8')).toBe(
      '# comment\nINTEGR8_API_URL=https://api.example\nKEEP=yes\nNEW="has space"\n',
    );
  });

  it('make a PDF with a sound cross-reference table', () => {
    const pdf = Buffer.from(testPdf('Certificate (copy)', ['Serial: SN-77', 'Arabic: رقم']));
    const textOf = pdf.toString('latin1');
    expect(textOf.startsWith('%PDF-1.4')).toBe(true);
    expect(textOf.trimEnd().endsWith('%%EOF')).toBe(true);
    const start = Number(/startxref\n(\d+)/u.exec(textOf)?.[1]);
    expect(textOf.slice(start, start + 4)).toBe('xref');
    for (const match of textOf.matchAll(/^(\d{10}) 00000 n $/gmu)) {
      expect(textOf.slice(Number(match[1]))).toMatch(/^\d+ 0 obj/u);
    }
    expect(textOf).toContain('(Certificate \\(copy\\)) Tj');
    expect(textOf).toContain('(Arabic: ???) Tj');
  });

  it('keep website keys in one entry per API, and forget them', async () => {
    const entries = new Map<string, string>();
    const box: SecretBox = {
      kind: 'file',
      get: (name) => entries.get(name),
      set: (name, secret) => entries.set(name, secret),
      delete: (name) => entries.delete(name),
    };
    const vault = boxVault(box, 'https://api.example');
    const stored = {
      tenantId: TENANT,
      keyId: KEY_ID,
      hint: 'rstu',
      label: null,
      secret: SECRET,
      createdAt: new Date().toISOString(),
    };
    await vault.put(stored);
    expect([...entries.keys()]).toEqual(['https://api.example#website-keys']);
    expect(await vault.list(TENANT)).toEqual([stored]);
    expect(await vault.list('another')).toEqual([]);
    await vault.remove(TENANT, KEY_ID);
    expect(entries.size).toBe(0);
  });

  it('hide a website key wherever it appears', () => {
    expect(redact(`key ${SECRET} here`)).toBe('key [hidden] here');
    expect(existsSync(folder)).toBe(true);
  });
});
