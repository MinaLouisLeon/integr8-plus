import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Connection, type StaffTokens } from './connection.js';
import { RouteIndex } from './openapi.js';
import { createDevServer } from './server.js';
import { Trace } from './trace.js';

/**
 * The tools as an AI tool calls them, against a stand-in API that answers the
 * few routes they use. What is proved: requests carry the right headers and a
 * reason naming the tool, a request that does not fit is never sent, the
 * staff token is refreshed and the new pair kept, and no token, password or
 * code reaches a tool result or the trace file.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ENGINEER = '22222222-2222-4222-8222-222222222222';
const STAFF_TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJzdGFmZi1vbmUifQ.c3RhZmYtc2lnbmF0dXJl';
const STAFF_TOKEN_2 = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJzdGFmZi10d28ifQ.c3RhZmYtc2lnbmF0dXJl';
const GRANT_TOKEN = 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJncmFudC1vbmUifQ.Z3JhbnQtc2lnbmF0dXJl';
const REFRESH = 'i8p1.first-refresh-token-value-abcdef';

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: unknown;
}

const seen: Seen[] = [];
const persisted: StaffTokens[] = [];
let expireStaffOnce = true;
let api: Server;
let folder: string;
let trace: Trace;
const client = new Client({ name: 'test', version: '1.0.0' });

function reply(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'req-1' });
  response.end(JSON.stringify(body));
}

async function handle(request: IncomingMessage, response: ServerResponse) {
  const chunks: Buffer[] = [];
  for await (const chunk of request as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const raw = Buffer.concat(chunks);
  // A form file arrives as bytes; everything else is JSON.
  const body: unknown =
    text === ''
      ? null
      : (request.headers['content-type'] ?? '').includes('json')
        ? JSON.parse(text)
        : { bytes: raw.length, start: raw.subarray(0, 2).toString('latin1') };
  seen.push({ method: request.method ?? '', path: url.pathname, headers: request.headers, body });
  const auth = request.headers.authorization ?? '';
  const route = `${request.method ?? ''} ${url.pathname}`;

  if (route === 'POST /v1/platform/auth/refresh') {
    return reply(response, 200, {
      accessToken: STAFF_TOKEN_2,
      refreshToken: 'i8p1.second-refresh-token-value-abcdef',
      accessTokenExpiresAt: new Date().toISOString(),
      refreshTokenExpiresAt: new Date().toISOString(),
      sessionId: '33333333-3333-4333-8333-333333333333',
      sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scope: 'test_companies',
    });
  }
  if (url.pathname.startsWith('/v1/platform/')) {
    // The first staff call finds its access token lapsed.
    if (auth === `Bearer ${STAFF_TOKEN}` && expireStaffOnce) {
      expireStaffOnce = false;
      return reply(response, 401, { error: { code: 'unauthorised' } });
    }
    if (auth !== `Bearer ${STAFF_TOKEN_2}` && auth !== `Bearer ${STAFF_TOKEN}`) {
      return reply(response, 401, { error: { code: 'unauthorised' } });
    }
  }
  switch (route) {
    case 'GET /v1/platform/me':
      return reply(response, 200, {
        email: 'dev@integr8.example',
        scope: 'test_companies',
        sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        environment: 'staging',
      });
    case 'GET /v1/platform/companies':
      return reply(response, 200, {
        items: [
          {
            id: TENANT,
            name: 'Nile Test Co',
            slug: 'nile-test',
            status: 'active',
            activeMembers: 2,
            createdAt: new Date().toISOString(),
            isTest: true,
          },
        ],
      });
    case `POST /v1/platform/companies/${TENANT}/impersonate`:
      return reply(response, 201, {
        grantId: '44444444-4444-4444-8444-444444444444',
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        tokens: { accessToken: GRANT_TOKEN, refreshToken: 'i8r1.grant-refresh-token-abcdef' },
      });
    case `GET /v1/platform/companies/${TENANT}/test-audit`:
      return reply(response, 200, {
        items: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            action: 'customer.created',
            resourceType: 'customer',
            resourceId: 'c1',
            requestId: 'req-1',
          },
        ],
      });
    case 'GET /v1/members':
      return reply(response, 200, {
        items: [
          { userId: ENGINEER, email: 'omar@nile.example', displayName: 'Omar', role: 'engineer' },
        ],
      });
    case 'POST /v1/forms/import':
      return reply(response, 201, { formId: '66666666-6666-4666-8666-666666666666' });
    case 'POST /v1/customers':
      return reply(response, 201, { id: 'c1', name: 'Acme', portalToken: GRANT_TOKEN });
    default:
      return reply(response, 404, { error: { code: 'not_found' } });
  }
}

beforeAll(async () => {
  api = createServer((request, response) => {
    void handle(request, response);
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  folder = mkdtempSync(join(tmpdir(), 'dev-mcp-trace-'));
  trace = new Trace({ folder });
  const connection = new Connection({
    api: `http://127.0.0.1:${String((api.address() as AddressInfo).port)}`,
    tokens: {
      accessToken: STAFF_TOKEN,
      refreshToken: REFRESH,
      sessionExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    },
    trace,
    clientVersion: '1.3.6',
    persist: (tokens) => {
      persisted.push(tokens);
      return Promise.resolve();
    },
  });
  const server = createDevServer({
    routes: RouteIndex.load(),
    trace,
    context: () => Promise.resolve({ mode: 'remote', connection }),
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

describe('the developer tools', () => {
  it('lists every tool, and none of them signs in', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    // The Forms for AI tools are listed too (forms-tools.test.ts); none signs in.
    expect(names.filter((name) => /log_?in|sign_?in|token|password/u.test(name))).toEqual([]);
    expect(names).toEqual(
      expect.arrayContaining([
        'call_api',
        'create_test_company',
        'find_route',
        'get_audit',
        'get_change_request',
        'get_route',
        'get_trace',
        'import_form_package',
        'list_change_requests',
        'list_test_companies',
        'read_outbox',
        'status',
        'submit_form',
        'use_company',
      ]),
    );
  });

  it('says where it points, refreshing the staff token and keeping the new pair', async () => {
    const status = await call('status');
    expect(status.text).toMatch(/Environment: staging/u);
    expect(status.text).toMatch(/limited to test companies/u);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.accessToken).toBe(STAFF_TOKEN_2);
  });

  it('lists test companies and their people', async () => {
    expect((await call('list_test_companies')).text).toMatch(/Nile Test Co \(slug nile-test/u);
    const used = await call('use_company', { company: 'nile-test' });
    expect(used.text).toMatch(/engineer\s+Omar <omar@nile\.example>/u);
    const impersonation = seen.find((entry) => entry.path.endsWith('/impersonate'));
    expect((impersonation?.body as { reason: string }).reason).toMatch(/^Developer MCP: /u);
  });

  it('does not send a request that does not fit the route', async () => {
    const before = seen.length;
    const refused = await call('call_api', {
      method: 'POST',
      path: '/v1/customers',
      as: 'engineer',
      purpose: 'creating a customer',
      body: { status: 'nope' },
    });
    expect(refused.error).toBe(true);
    expect(refused.text).toMatch(/body\.name/u);
    expect(seen.length).toBe(before);
  });

  it('calls a route as a person, with the client headers and an idempotency key', async () => {
    const answer = await call('call_api', {
      method: 'POST',
      path: '/v1/customers',
      as: 'engineer',
      purpose: 'creating a customer',
      body: { name: 'Acme' },
    });
    expect(answer.text).toMatch(/^201 in \d+ ms/u);
    expect(answer.text).toMatch(/customer\.created customer c1/u);
    const sent = seen.find((entry) => entry.path === '/v1/customers');
    expect(sent?.headers['x-client-app']).toBe('api');
    expect(sent?.headers['x-client-version']).toBe('1.3.6');
    expect(sent?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(sent?.headers.authorization).toBe(`Bearer ${GRANT_TOKEN}`);
  });

  it('imports a form file saved with the Forms tools into the company', async () => {
    const example = JSON.parse((await call('get_example', { key: 'boiler_service' })).text) as {
      definition: Record<string, unknown>;
    };
    const saved = await call('save_package', { definition: example.definition });
    expect(saved.error).toBe(false);
    const path = join(folder, 'forms', 'Boiler service.integr8form');
    const imported = await call('import_form_package', { path });
    expect(imported.text).toMatch(/^201 in \d+ ms/u);
    const sent = seen.find((entry) => entry.path === '/v1/forms/import');
    expect(sent?.headers['content-type']).toBe('application/vnd.integr8.form+zip');
    expect(sent?.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u);
    expect(sent?.body).toEqual({ bytes: readFileSync(path).length, start: 'PK' });
  });

  it('refuses staff routes through call_api', async () => {
    const refused = await call('call_api', {
      method: 'GET',
      path: '/v1/platform/companies',
      as: 'company',
      purpose: 'listing companies',
    });
    expect(refused.error).toBe(true);
  });

  it('shows the trace, newest first, and one entry in full', async () => {
    const recent = await call('get_trace');
    expect(recent.text).toMatch(/POST \/v1\/customers → 201/u);
    const one = await call('get_trace', { id: 1 });
    expect(one.text).toMatch(/"method"/u);
  });

  it('never lets a token, password or code reach a result or the trace file', () => {
    const everything = [...outputs, readFileSync(trace.file ?? '', 'utf8')].join('\n');
    for (const secret of [STAFF_TOKEN, STAFF_TOKEN_2, GRANT_TOKEN, REFRESH, 'i8r1.grant']) {
      expect(everything).not.toContain(secret);
    }
    expect(everything).toContain('[hidden]');
  });
});
