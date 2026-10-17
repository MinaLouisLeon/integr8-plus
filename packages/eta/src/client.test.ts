import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  EtaApiError,
  EtaClient,
  type EtaClientOptions,
  EtaTokenCache,
  type TransportRequest,
  type TransportResponse,
  TransportError,
} from './client.js';
import { createNodeTransport } from './node/transport.js';
import { compileSchema, decodeSchemaBase64, SchemaUnreadableError } from './schema.js';

/** A fake ETA: answers by route; records every request. No network, no credentials. */
function fakeEta(
  routes: Record<
    string,
    (request: TransportRequest, count: number) => TransportResponse | Promise<TransportResponse>
  >,
) {
  const calls: TransportRequest[] = [];
  const counts = new Map<string, number>();
  const transport = async (request: TransportRequest) => {
    calls.push(request);
    const url = new URL(request.url);
    const key = `${request.method} ${url.pathname}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    const route = routes[key];
    if (route === undefined) {
      return json(404, { error: { code: 'NotFound', message: key } });
    }
    return route(request, count);
  };
  return { calls, transport };
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): TransportResponse {
  return { status, headers, body: new TextEncoder().encode(JSON.stringify(body)) };
}

const tokenRoute = () =>
  json(200, { access_token: 'token-1', expires_in: 3600, token_type: 'Bearer' });

function client(
  transport: EtaClientOptions['transport'],
  overrides: Partial<EtaClientOptions> = {},
) {
  let n = 0;
  return new EtaClient({
    endpoints: {
      identityBaseUrl: 'https://id.example.test/',
      apiBaseUrl: 'https://api.example.test',
    },
    credentials: { clientId: 'client-a', clientSecret: 'secret-a' },
    cacheKey: 'tenant-a:preprod:1',
    cache: new EtaTokenCache(),
    transport,
    sleep: () => Promise.resolve(),
    newCorrelationId: () => `corr-${String((n += 1))}`,
    ...overrides,
  });
}

describe('the ETA client: tokens', () => {
  it('asks for a client-credentials token with Basic authentication', async () => {
    const eta = fakeEta({
      'POST /connect/token': tokenRoute,
      'GET /api/v1.0/documenttypes': () => json(200, []),
    });
    await client(eta.transport).documentTypes();
    const token = eta.calls[0]!;
    expect(token.url).toBe('https://id.example.test/connect/token');
    expect(token.headers.authorization).toBe(
      `Basic ${Buffer.from('client-a:secret-a').toString('base64')}`,
    );
    expect(token.body).toBe('grant_type=client_credentials');
    expect(token.headers.onbehalfof).toBeUndefined();
    expect(eta.calls[1]!.headers.authorization).toBe('Bearer token-1');
  });

  it('asks once for concurrent calls and reuses the token until near expiry', async () => {
    let now = 0;
    const eta = fakeEta({
      'POST /connect/token': (_, count) =>
        json(200, { access_token: `token-${String(count)}`, expires_in: 120 }),
      'GET /api/v1.0/documenttypes': () => json(200, []),
    });
    const c = client(eta.transport, { now: () => now });
    await Promise.all([c.documentTypes(), c.documentTypes(), c.documentTypes()]);
    expect(eta.calls.filter((call) => call.url.endsWith('/connect/token'))).toHaveLength(1);
    now = 59_000;
    await c.documentTypes();
    expect(eta.calls.filter((call) => call.url.endsWith('/connect/token'))).toHaveLength(1);
    now = 61_000; // inside the 60-second skew before expiry
    await c.documentTypes();
    expect(eta.calls.filter((call) => call.url.endsWith('/connect/token'))).toHaveLength(2);
  });

  it('never shares a token between two companies', async () => {
    const cache = new EtaTokenCache();
    const eta = fakeEta({
      'POST /connect/token': (request) =>
        json(200, {
          access_token:
            request.headers.authorization ===
            `Basic ${Buffer.from('client-a:secret-a').toString('base64')}`
              ? 'A'
              : 'B',
          expires_in: 3600,
        }),
      'GET /api/v1.0/documenttypes': () => json(200, []),
    });
    await client(eta.transport, { cache }).documentTypes();
    await client(eta.transport, {
      cache,
      cacheKey: 'tenant-b:preprod:1',
      credentials: { clientId: 'client-b', clientSecret: 'secret-b' },
    }).documentTypes();
    const bearers = eta.calls
      .filter((call) => call.url.includes('documenttypes'))
      .map((call) => call.headers.authorization);
    expect(bearers).toEqual(['Bearer A', 'Bearer B']);
  });

  it('refreshes the token once on a 401', async () => {
    const eta = fakeEta({
      'POST /connect/token': (_, count) =>
        json(200, { access_token: `token-${String(count)}`, expires_in: 3600 }),
      'GET /api/v1.0/documenttypes': (request) =>
        request.headers.authorization === 'Bearer token-1' ? json(401, {}) : json(200, []),
    });
    await client(eta.transport).documentTypes();
    expect(eta.calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/connect/token',
      '/api/v1.0/documenttypes',
      '/connect/token',
      '/api/v1.0/documenttypes',
    ]);
  });

  it('reports refused credentials as unauthorized, without the secret in the message', async () => {
    const eta = fakeEta({ 'POST /connect/token': () => json(400, { error: 'invalid_client' }) });
    const error = await client(eta.transport)
      .checkCredentials()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EtaApiError);
    expect((error as EtaApiError).code).toBe('invalid_client');
    expect(JSON.stringify(error)).not.toContain('secret-a');
    expect((error as Error).message).not.toContain('secret-a');
  });

  it('sends the on-behalf-of header only for an intermediary', async () => {
    const eta = fakeEta({ 'POST /connect/token': tokenRoute });
    await client(eta.transport, { onBehalfOf: '100000001' }).checkCredentials();
    expect(eta.calls[0]!.headers.onbehalfof).toBe('100000001');
  });
});

describe('the ETA client: submission', () => {
  it('sends the signed text unchanged and reads accepted and rejected documents', async () => {
    const eta = fakeEta({
      'POST /connect/token': tokenRoute,
      'POST /api/v1.0/documentsubmissions/': () =>
        json(202, {
          submissionId: 'SUB1',
          acceptedDocuments: [{ uuid: 'UUID1', longId: 'LONG1', internalId: 'INV-1' }],
          rejectedDocuments: [
            {
              internalId: 'INV-2',
              error: {
                code: 'BadStructure',
                message: 'Bad',
                target: 'INV-2',
                details: [{ code: 'X', message: 'Field', target: 'issuer' }],
              },
            },
          ],
        }),
    });
    const signed = '{"a":1.10,"signatures":[{"signatureType":"I","value":"QQ=="}]}';
    const result = await client(eta.transport).submit([signed, signed]);
    const sent = eta.calls[1]!;
    expect(sent.body).toBe(`{"documents":[${signed},${signed}]}`);
    expect(sent.headers['content-type']).toBe('application/json');
    expect(result.submissionId).toBe('SUB1');
    expect(result.accepted).toEqual([{ uuid: 'UUID1', longId: 'LONG1', internalId: 'INV-1' }]);
    expect(result.rejected[0]!.error.details).toEqual([
      { code: 'X', message: 'Field', target: 'issuer' },
    ]);
  });

  it('never retries a submission, and calls a lost answer ambiguous', async () => {
    const eta = fakeEta({
      'POST /connect/token': tokenRoute,
      'POST /api/v1.0/documentsubmissions/': () => {
        throw new TransportError('timeout', 'slow');
      },
    });
    const error = (await client(eta.transport)
      .submit(['{}'])
      .catch((e: unknown) => e)) as EtaApiError;
    expect(error.kind).toBe('timeout');
    expect(error.ambiguous).toBe(true);
    expect(eta.calls.filter((call) => call.url.includes('documentsubmissions'))).toHaveLength(1);
  });

  it('treats a 5xx on submission as ambiguous and a 4xx as definite', async () => {
    const five = fakeEta({
      'POST /connect/token': tokenRoute,
      'POST /api/v1.0/documentsubmissions/': () => json(503, {}),
    });
    expect(
      (
        (await client(five.transport)
          .submit(['{}'])
          .catch((e: unknown) => e)) as EtaApiError
      ).ambiguous,
    ).toBe(true);
    expect(five.calls.filter((call) => call.url.includes('documentsubmissions'))).toHaveLength(1);
    const four = fakeEta({
      'POST /connect/token': tokenRoute,
      'POST /api/v1.0/documentsubmissions/': () =>
        json(400, { error: { code: 'BadRequest', message: 'No' } }),
    });
    const error = (await client(four.transport)
      .submit(['{}'])
      .catch((e: unknown) => e)) as EtaApiError;
    expect(error.ambiguous).toBe(false);
    expect(error.code).toBe('BadRequest');
  });
});

describe('the ETA client: reads', () => {
  it('retries a rate-limited read after Retry-After, a little', async () => {
    const waits: number[] = [];
    const eta = fakeEta({
      'POST /connect/token': tokenRoute,
      'GET /api/v1.0/documents/UUID1/details': (_, count) =>
        count < 3
          ? json(429, {}, { 'retry-after': '2' })
          : json(200, { status: 'Valid', longId: 'L' }),
    });
    const status = await client(eta.transport, {
      sleep: (ms) => (waits.push(ms), Promise.resolve()),
    }).documentStatus('UUID1');
    expect(status.status).toBe('Valid');
    expect(waits).toEqual([2000, 2000]);
  });

  it('gives up after its retries', async () => {
    const eta = fakeEta({
      'POST /connect/token': tokenRoute,
      'GET /api/v1.0/documents/UUID1/details': () => json(500, {}),
    });
    await expect(client(eta.transport).documentStatus('UUID1')).rejects.toMatchObject({
      kind: 'server',
    });
    expect(eta.calls.filter((call) => call.url.includes('details'))).toHaveLength(3);
  });

  it('collects validation errors from invalid steps', async () => {
    const eta = fakeEta({
      'POST /connect/token': tokenRoute,
      'GET /api/v1.0/documents/UUID1/details': () =>
        json(200, {
          status: 'Invalid',
          validationResults: {
            status: 'Invalid',
            validationSteps: [
              { name: 'Structure', status: 'Valid' },
              {
                name: 'Totals',
                status: 'Invalid',
                error: {
                  errorCode: 'T',
                  error: 'Totals differ',
                  innerError: [{ code: 'T1', error: 'Line 1 total' }],
                },
              },
            ],
          },
        }),
    });
    const status = await client(eta.transport).documentStatus('UUID1');
    expect(status.status).toBe('Invalid');
    expect(status.validationErrors.map((error) => error.message)).toEqual([
      'Totals differ',
      'Line 1 total',
    ]);
  });

  it('decodes a document type version’s Base64 schema', async () => {
    const schema = '{"type":"object","required":["issuer"]}';
    const eta = fakeEta({
      'POST /connect/token': tokenRoute,
      'GET /api/v1.0/documenttypes/1/versions/2': () =>
        json(200, {
          versionNumber: '1.0',
          status: 'Active',
          jsonSchema: Buffer.from(schema).toString('base64'),
        }),
    });
    const version = await client(eta.transport).documentTypeVersion('1', '2');
    expect(version.schemaText).toBe(schema);
    expect(version.versionNumber).toBe('1.0');
  });
});

describe('schema validation', () => {
  it('validates a document against a fetched schema', () => {
    const schema = compileSchema(
      JSON.stringify({
        type: 'object',
        required: ['issuer', 'totalAmount'],
        properties: { totalAmount: { type: 'number', multipleOf: 0.00001 } },
      }),
    );
    expect(schema.validate('{"issuer":{},"totalAmount":1111.5}')).toEqual([]);
    expect(
      schema
        .validate('{"totalAmount":"x"}')
        .map((issue) => issue.keyword)
        .sort(),
    ).toEqual(['required', 'type']);
  });

  it('refuses a schema that is not JSON or does not compile', () => {
    expect(() => compileSchema('not json')).toThrow(SchemaUnreadableError);
    expect(() => compileSchema('{"type":"nonsense"}')).toThrow(SchemaUnreadableError);
  });

  it('decodes Base64 with a BOM', () => {
    expect(decodeSchemaBase64(Buffer.from('\uFEFF{"a":1}').toString('base64'))).toBe('{"a":1}');
  });
});

describe('the Node transport', () => {
  it('refuses plain HTTP to anything but this machine', async () => {
    const transport = createNodeTransport();
    await expect(
      transport({ method: 'GET', url: 'http://example.test/', headers: {}, timeoutMs: 1000 }),
    ).rejects.toBeInstanceOf(TransportError);
  });

  it('times out and reports it as a timeout', async () => {
    const server = createServer(() => {
      // never answers
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const transport = createNodeTransport();
    await expect(
      transport({
        method: 'GET',
        url: `http://127.0.0.1:${String(port)}/`,
        headers: {},
        timeoutMs: 200,
      }),
    ).rejects.toMatchObject({ kind: 'timeout' });
    server.closeAllConnections();
    server.close();
  });

  it('carries a request and its answer to a local server', async () => {
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString()));
      request.on('end', () => {
        response.setHeader('retry-after', '5');
        response.end(
          JSON.stringify({ method: request.method, body, auth: request.headers.authorization }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const answer = await createNodeTransport()({
      method: 'POST',
      url: `http://127.0.0.1:${String(port)}/x`,
      headers: { authorization: 'Bearer t' },
      body: '{"a":1.10}',
      timeoutMs: 2000,
    });
    expect(JSON.parse(new TextDecoder().decode(answer.body))).toEqual({
      method: 'POST',
      body: '{"a":1.10}',
      auth: 'Bearer t',
    });
    expect(answer.headers['retry-after']).toBe('5');
    server.close();
  });
});
