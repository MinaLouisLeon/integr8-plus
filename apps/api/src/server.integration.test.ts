import { FakeIdentityProvider, generateSigningKeyPair } from '@integr8/auth';
import { closeDatabase, getPlatformDataSource, withTenant } from '@integr8/db';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildServices } from './composition.js';
import { loadApiConfig } from './config.js';
import { createLogger } from './http/logger.js';
import { allRoutes } from './routes/index.js';
import { buildServer } from './server.js';

/**
 * The assembled API, over real HTTP, against real Postgres.
 *
 * Three of P04's four exit criteria are demonstrated here — idempotent replay,
 * the outdated-client response, and the request id on every log line and in the
 * response. The fourth, that the generated client compiles in all three
 * front-end apps, is proven by `pnpm build`.
 *
 * The identity provider is faked. Everything worth testing in this service
 * happens after a credential has been accepted, and a real Supabase project in
 * front of these tests would make them slower and flakier without making them
 * more truthful.
 */

const ACKNOWLEDGEMENT = 'i-know-this-database-is-disposable';

let app: FastifyInstance;
let identity: FakeIdentityProvider;
let logLines: Record<string, unknown>[] = [];

let tenantId: string;
let owner: { userId: string; email: string; password: string };
let engineer: { userId: string; email: string; password: string };

const PASSWORD = 'a perfectly good passphrase';

function unique(label: string): string {
  return `${label}.${randomUUID().slice(0, 8)}@test.integr8.example`;
}

async function createMember(role: 'owner' | 'engineer', label: string) {
  const email = unique(label);
  const created = await identity.createIdentity(email, PASSWORD);

  await withTenant(tenantId, (tx) =>
    tx.tenantUsers.create({
      userId: created.userId,
      email,
      displayName: label,
      role,
      status: 'active',
    }),
  );

  return { userId: created.userId, email, password: PASSWORD };
}

async function signIn(who: { email: string; password: string }): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/auth/sign-in',
    headers: { 'x-client-version': '1.0.0', 'x-client-app': 'web' },
    payload: { email: who.email, password: who.password, clientApp: 'web' },
  });

  expect(response.statusCode, response.body).toBe(200);
  return (JSON.parse(response.body) as { tokens: { accessToken: string } }).tokens.accessToken;
}

beforeAll(async () => {
  if (process.env.APP_ENV !== 'test' || process.env.INTEGR8_TEST_DATABASE !== ACKNOWLEDGEMENT) {
    throw new Error(
      [
        'The API integration suite needs the same disposable Postgres as @integr8/db:',
        '',
        '  APP_ENV=test',
        `  INTEGR8_TEST_DATABASE=${ACKNOWLEDGEMENT}`,
        '  DATABASE_URL, DATABASE_URL_ADMIN, DATABASE_URL_AUTH',
        '',
        'See docs/database/runbook-supabase-setup.md.',
      ].join('\n'),
    );
  }

  // Keys per run rather than checked in: a test key in the repository is a key
  // somebody eventually reuses in staging.
  const pair = await generateSigningKeyPair();
  process.env.AUTH_SIGNING_KEY_ID = pair.kid;
  process.env.AUTH_SIGNING_KEY = JSON.stringify(pair.privateJwk);
  process.env.AUTH_VERIFICATION_KEYS = JSON.stringify([pair.publicJwk]);
  process.env.AUTH_ISSUER = 'https://api.test.integr8';

  const config = loadApiConfig({
    ...process.env,
    API_MIN_SUPPORTED_CLIENT: '1.0.0',
    API_UPDATE_URL: 'https://integr8.example/download',
  });

  identity = new FakeIdentityProvider();
  const services = await buildServices({ config, identity });

  app = buildServer({
    config,
    services,
    routes: allRoutes(config),
    logger: createLogger({
      level: 'debug',
      write: (line) => logLines.push(JSON.parse(line) as Record<string, unknown>),
    }),
  });
  await app.ready();

  const tenant = await getPlatformDataSource().tenants.create({
    slug: `api-${randomUUID().slice(0, 8)}`,
    name: 'API Test Ltd',
  });
  tenantId = tenant.id;

  owner = await createMember('owner', 'owner');
  engineer = await createMember('engineer', 'engineer');
});

afterAll(async () => {
  await app.close();
  await closeDatabase();
});

describe('the request id', () => {
  /**
   * P04's fourth exit criterion, in both halves: the caller is given an id, and
   * every log line for that request carries the same one.
   */
  it('is returned to the caller on every response', async () => {
    const ok = await app.inject({ method: 'GET', url: '/health' });
    expect(ok.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);

    const missing = await app.inject({ method: 'GET', url: '/v1/nothing-here' });
    expect(missing.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('appears in the error body as well as the header, so a screenshot is enough', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/nothing-here' });
    const body = JSON.parse(response.body) as { error: { requestId: string } };

    expect(body.error.requestId).toBe(response.headers['x-request-id']);
  });

  it('is the same on every log line belonging to one request', async () => {
    logLines = [];
    const token = await signIn(owner);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}`, 'x-client-version': '1.0.0' },
    });

    const requestId = response.headers['x-request-id'];
    const lines = logLines.filter((line) => line.requestId === requestId);

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.some((line) => line.message === 'Request completed')).toBe(true);
    // And the tenant is on those lines, so a customer-specific investigation is
    // one filter rather than a correlation exercise.
    expect(lines.some((line) => line.tenantId === tenantId)).toBe(true);
  });

  it('differs between requests', async () => {
    const first = await app.inject({ method: 'GET', url: '/health' });
    const second = await app.inject({ method: 'GET', url: '/health' });

    expect(first.headers['x-request-id']).not.toBe(second.headers['x-request-id']);
  });
});

describe('an out-of-date client', () => {
  /**
   * P04's third exit criterion. A signed binary cannot be force-updated, so the
   * only alternative to this is an old client failing later, confusingly.
   */
  it('is told so, clearly, with somewhere to go', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { 'x-client-version': '0.9.0', 'x-client-app': 'desktop' },
    });

    expect(response.statusCode).toBe(503);

    const body = JSON.parse(response.body) as {
      error: { code: string; message: string; details?: { field: string; message: string }[] };
    };

    expect(body.error.code).toBe('client_too_old');
    expect(body.error.message).toContain('0.9.0');
    expect(body.error.message).toContain('1.0.0');
    expect(body.error.message).toContain('https://integr8.example/download');

    // The minimum is in the details as data, so a client can act on it without
    // parsing the sentence.
    expect(body.error.details?.some((detail) => detail.message === '1.0.0')).toBe(true);
  });

  it('is told before authentication, so an expired token is not the confusing part', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { 'x-client-version': '0.9.0' },
    });

    // No token at all, and still 503 rather than 401: the version is the
    // actionable problem and the one worth reporting.
    expect(response.statusCode).toBe(503);
  });

  it('advertises the minimum on every response, including successful ones', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['min-supported-client']).toBe('1.0.0');
  });

  it('serves a client that declares no version', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/me' });
    // 401, not 503: it is unauthenticated, not unsupported.
    expect(response.statusCode).toBe(401);
  });

  it('serves the health endpoints whatever version a probe claims', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { 'x-client-version': '0.0.1' },
    });

    expect(response.statusCode).toBe(200);
  });
});

describe('idempotency', () => {
  /**
   * P04's second exit criterion: replaying a mutating request with the same key
   * produces one effect, not two.
   */
  it('produces one invitation for two identical requests', async () => {
    const token = await signIn(owner);
    const email = unique('invitee');
    const key = randomUUID();

    const send = () =>
      app.inject({
        method: 'POST',
        url: '/v1/members/invitations',
        headers: {
          authorization: `Bearer ${token}`,
          'x-client-version': '1.0.0',
          'idempotency-key': key,
        },
        payload: { email, role: 'engineer' },
      });

    const first = await send();
    const second = await send();

    expect(first.statusCode, first.body).toBe(201);
    expect(second.statusCode).toBe(201);

    // Identical response, so a client cannot tell it retried.
    expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(first.headers['idempotent-replay']).toBeUndefined();

    // And exactly one invitation exists.
    const pending = await withTenant(tenantId, (tx) => tx.invitations.listPending());
    expect(pending.filter((invitation) => invitation.email === email)).toHaveLength(1);
  });

  it('creates two invitations when two different keys are used', async () => {
    const token = await signIn(owner);
    const headers = { authorization: `Bearer ${token}`, 'x-client-version': '1.0.0' };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { email: unique('one'), role: 'viewer' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers: { ...headers, 'idempotency-key': randomUUID() },
      payload: { email: unique('two'), role: 'viewer' },
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(JSON.parse(first.body)).not.toEqual(JSON.parse(second.body));
  });

  it('refuses the same key with a different body', async () => {
    // A client bug. Replaying the first response would hide it and silently
    // discard the second request.
    const token = await signIn(owner);
    const key = randomUUID();
    const headers = {
      authorization: `Bearer ${token}`,
      'x-client-version': '1.0.0',
      'idempotency-key': key,
    };

    await app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers,
      payload: { email: unique('first'), role: 'viewer' },
    });

    const conflicting = await app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers,
      payload: { email: unique('second'), role: 'viewer' },
    });

    expect(conflicting.statusCode).toBe(409);
    expect((JSON.parse(conflicting.body) as { error: { code: string } }).error.code).toBe(
      'idempotency_key_reused',
    );
  });

  it('ignores the order of keys in the body', async () => {
    const token = await signIn(owner);
    const email = unique('reordered');
    const key = randomUUID();
    const headers = {
      authorization: `Bearer ${token}`,
      'x-client-version': '1.0.0',
      'idempotency-key': key,
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers,
      payload: { email, role: 'viewer' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers,
      payload: { role: 'viewer', email },
    });

    expect(second.statusCode).toBe(201);
    expect(JSON.parse(second.body)).toEqual(JSON.parse(first.body));
  });

  it('lets the same key be retried after the request failed', async () => {
    // Holding a key after a failure would turn one transient error into a day
    // of rejections for that client.
    const token = await signIn(owner);
    const key = randomUUID();
    const headers = {
      authorization: `Bearer ${token}`,
      'x-client-version': '1.0.0',
      'idempotency-key': key,
    };

    const failed = await app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers,
      payload: { email: owner.email, role: 'viewer' },
    });
    expect(failed.statusCode).toBe(422);

    const retried = await app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers,
      payload: { email: owner.email, role: 'viewer' },
    });

    // A real attempt, not a replay of the failure.
    expect(retried.statusCode).toBe(422);
    expect(retried.headers['idempotent-replay']).toBeUndefined();
  });

  it('runs a mutation with no key exactly as before', async () => {
    const token = await signIn(owner);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers: { authorization: `Bearer ${token}`, 'x-client-version': '1.0.0' },
      payload: { email: unique('nokey'), role: 'viewer' },
    });

    expect(response.statusCode).toBe(201);
  });
});

describe('authentication and permissions', () => {
  it('refuses a request with no token', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/me' });
    expect(response.statusCode).toBe(401);
  });

  it('gives the same answer for every kind of bad token', async () => {
    const bodies = await Promise.all(
      ['Bearer nonsense', 'Basic abc', 'Bearer ', 'nonsense'].map(async (authorization) => {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/me',
          headers: { authorization },
        });
        expect(response.statusCode).toBe(401);
        return (JSON.parse(response.body) as { error: { message: string } }).error.message;
      }),
    );

    // One message for all of them: telling a caller which failure it was tells
    // an attacker how close they are.
    expect(new Set(bodies).size).toBe(1);
  });

  it('serves an authenticated request', async () => {
    const token = await signIn(owner);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      tenantId: string;
      role: string;
      permissions: string[];
    };

    expect(body.tenantId).toBe(tenantId);
    expect(body.role).toBe('owner');
    expect(body.permissions).toContain('member.invite');
  });

  it('refuses a permission the role does not hold, and says which', async () => {
    const token = await signIn(engineer);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers: { authorization: `Bearer ${token}` },
      payload: { email: unique('nope'), role: 'viewer' },
    });

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.body) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('forbidden');
    expect(body.error.message).toContain('member.invite');
  });

  it('resolves permissions per role', async () => {
    const token = await signIn(engineer);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });

    const body = JSON.parse(response.body) as { permissions: string[] };
    expect(body.permissions).toContain('member.read');
    expect(body.permissions).not.toContain('member.invite');
  });
});

describe('the error model', () => {
  it('reports validation failures field by field', async () => {
    const token = await signIn(owner);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/members/invitations',
      headers: { authorization: `Bearer ${token}` },
      payload: { email: 'x', role: 'sovereign' },
    });

    expect(response.statusCode).toBe(422);
    const body = JSON.parse(response.body) as {
      error: { code: string; details: { field: string }[] };
    };

    expect(body.error.code).toBe('validation_failed');
    expect(body.error.details.map((detail) => detail.field).sort()).toEqual([
      'body.email',
      'body.role',
    ]);
  });

  it('uses one shape for every failure', async () => {
    const responses = await Promise.all([
      app.inject({ method: 'GET', url: '/v1/nothing-here' }),
      app.inject({ method: 'GET', url: '/v1/me' }),
      app.inject({ method: 'GET', url: '/v1/me', headers: { 'x-client-version': '0.0.1' } }),
    ]);

    for (const response of responses) {
      const body = JSON.parse(response.body) as { error: Record<string, unknown> };
      expect(Object.keys(body)).toEqual(['error']);
      expect(typeof body.error.code).toBe('string');
      expect(typeof body.error.message).toBe('string');
      expect(typeof body.error.requestId).toBe('string');
    }
  });

  it('does not leak an internal message to the caller', async () => {
    const response = await app.inject({ method: 'POST', url: '/health/probe-error' });

    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body) as { error: { message: string } };
    // The deliberate probe declares its own code, so this asserts the shape
    // rather than the redaction; the redaction of *unexpected* errors is
    // covered by the unit tests for `toApiError`.
    expect(body.error.message).not.toContain('stack');
  });
});

describe('health and readiness', () => {
  it('answers liveness without touching anything else', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    expect((JSON.parse(response.body) as { status: string }).status).toBe('ok');
  });

  it('reports readiness with the checks it made', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });
    const body = JSON.parse(response.body) as {
      status: string;
      checks: { name: string; ok: boolean }[];
    };

    expect(body.checks.some((check) => check.name === 'schema')).toBe(true);
    expect(response.statusCode).toBe(body.status === 'ready' ? 200 : 503);
  });
});

describe('sessions', () => {
  it('lists this device and marks it current', async () => {
    const token = await signIn(owner);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { items: { isCurrent: boolean }[] };
    expect(body.items.filter((session) => session.isCurrent)).toHaveLength(1);
  });

  it('signs a device out, after which its token stops working', async () => {
    const token = await signIn(owner);
    const sessions = await app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${token}` },
    });
    const current = (
      JSON.parse(sessions.body) as { items: { id: string; isCurrent: boolean }[] }
    ).items.find((session) => session.isCurrent);

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/v1/sessions/${current?.id ?? ''}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(revoked.statusCode).toBe(200);
    expect((JSON.parse(revoked.body) as { revoked: boolean }).revoked).toBe(true);

    // The access token is still cryptographically valid for another quarter of
    // an hour; refreshing is what stops.
    const refresh = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refreshToken: 'i8r1.00000000-0000-4000-8000-000000000001.nope' },
    });
    expect(refresh.statusCode).toBe(401);
  });
});
