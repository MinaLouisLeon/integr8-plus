import { randomUUID } from 'node:crypto';
import { getPlatformDataSource } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { routeAllows } from '../../../http/session-scope.js';
import { type ApiHarness, type PlatformAdmin, startApi } from '../../../testing/api-harness.js';
import { allRoutes } from '../../index.js';

/**
 * Test companies and staff sessions limited to them (0077, P38).
 *
 * The developer MCP server signs in with `scope: "test_companies"`. These
 * prove the API, not the tool, keeps it there: every other platform route is
 * refused, every open route is refused for a real company, the session ends 8
 * hours after sign-in and refreshing keeps both its scope and its end, and a
 * test company is not billed, gets no app builds and sends no mail.
 */

let api: ApiHarness;
let full: PlatformAdmin;
let limited: PlatformAdmin;
let testCompany: string;
let realCompany: string;

async function onboard(isTest: boolean, extra: Record<string, unknown> = {}): Promise<string> {
  const slug = `${isTest ? 'test' : 'real'}-${randomUUID().slice(0, 8)}`;
  const response = await api.call(full.accessToken, {
    method: 'POST',
    url: '/v1/platform/companies',
    payload: { slug, name: `${slug} Ltd`, ownerEmail: `owner@${slug}.example`, isTest, ...extra },
  });
  expect(response.statusCode).toBe(201);
  const body = JSON.parse(response.body) as { company: { id: string; isTest: boolean } };
  expect(body.company.isTest).toBe(isTest);
  return body.company.id;
}

const errorCode = (body: string) => (JSON.parse(body) as { error?: { code?: string } }).error?.code;

beforeAll(async () => {
  api = await startApi();
  full = await api.platformAdmin('full');
  limited = await api.platformAdmin('developer', { scope: 'test_companies' });
  testCompany = await onboard(true);
  realCompany = await onboard(false);
});

afterAll(async () => {
  await api.close();
});

describe('a session limited to test companies', () => {
  it('says what it is and ends 8 hours after sign-in', async () => {
    const me = JSON.parse(
      (await api.call(limited.accessToken, { method: 'GET', url: '/v1/platform/me' })).body,
    ) as { scope: string; sessionExpiresAt: string; environment: string };
    expect(me.scope).toBe('test_companies');
    const hours = (new Date(me.sessionExpiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(7.9);
    expect(hours).toBeLessThanOrEqual(8);
    expect(me.environment).toBe('test');
  });

  it('keeps its scope and its end when refreshed', async () => {
    const refreshed = await api.app.inject({
      method: 'POST',
      url: '/v1/platform/auth/refresh',
      remoteAddress: api.remoteAddress,
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'web' },
      payload: { refreshToken: limited.refreshToken },
    });
    expect(refreshed.statusCode).toBe(200);
    const tokens = JSON.parse(refreshed.body) as {
      accessToken: string;
      refreshToken: string;
      scope: string;
      sessionExpiresAt: string;
    };
    expect(tokens.scope).toBe('test_companies');
    const session = await getPlatformDataSource().platformSessions.find(limited.sessionId);
    expect(new Date(tokens.sessionExpiresAt).getTime()).toBe(session?.expiresAt.getTime());
    limited = { ...limited, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  });

  it('lists test companies only', async () => {
    const list = JSON.parse(
      (await api.call(limited.accessToken, { method: 'GET', url: '/v1/platform/companies' })).body,
    ) as { items: { id: string; isTest: boolean }[] };
    expect(list.items.length).toBeGreaterThan(0);
    expect(list.items.every((company) => company.isTest)).toBe(true);
    expect(list.items.map((company) => company.id)).toContain(testCompany);
    expect(list.items.map((company) => company.id)).not.toContain(realCompany);
  });

  it('reads a test company, and is refused a real one', async () => {
    const own = await api.call(limited.accessToken, {
      method: 'GET',
      url: `/v1/platform/companies/${testCompany}`,
    });
    expect(own.statusCode).toBe(200);
    for (const url of [
      `/v1/platform/companies/${realCompany}`,
      `/v1/platform/companies/${realCompany}/impersonations`,
      `/v1/platform/companies/${realCompany}/test-outbox`,
      `/v1/platform/companies/${realCompany}/test-audit`,
      `/v1/platform/companies/${randomUUID()}`,
    ]) {
      const refused = await api.call(limited.accessToken, { method: 'GET', url });
      expect(refused.statusCode, url).toBe(403);
      expect(errorCode(refused.body), url).toBe('session_scope');
    }
    const acting = await api.call(limited.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${realCompany}/impersonate`,
      payload: { reason: 'Developer MCP: trying to reach a real company' },
    });
    expect(acting.statusCode).toBe(403);
  });

  it('is refused on every platform route outside the open list', async () => {
    const closed = allRoutes(api.config).filter(
      (route) => route.security === 'platform' && !routeAllows(route, 'test_companies'),
    );
    let refused = 0;
    for (const route of closed) {
      const url = route.path
        .replace(/:tenantId/gu, testCompany)
        .replace(/:[a-zA-Z]+/gu, () => randomUUID());
      const response = await api.call(limited.accessToken, {
        method: route.method.toUpperCase() as 'GET',
        url,
        ...(route.method === 'get' || route.method === 'delete' ? {} : { payload: {} }),
      });
      // A body that does not parse is refused before the session is read;
      // anything that reaches the session check is refused there.
      if (response.statusCode === 400) {
        continue;
      }
      expect(response.statusCode, `${route.method} ${route.path}`).toBe(403);
      expect(errorCode(response.body), `${route.method} ${route.path}`).toBe('session_scope');
      refused += 1;
    }
    expect(refused).toBeGreaterThan(20);
  });

  it('writes each refusal to the platform audit log', async () => {
    const audit = await api.call(full.accessToken, {
      method: 'GET',
      url: '/v1/platform/audit?action=platform.session_scope_refused',
    });
    const entries = (JSON.parse(audit.body) as { entries: { actorLabel: string }[] }).entries;
    expect(entries.some((entry) => entry.actorLabel === limited.email)).toBe(true);
  });

  it('acts as a test company only with a reason that names the tool', async () => {
    const plain = await api.call(limited.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${testCompany}/impersonate`,
      payload: { reason: 'Checking the submissions list' },
    });
    expect(plain.statusCode).toBe(422);
    expect(errorCode(plain.body)).toBe('developer_reason_required');

    const named = await api.call(limited.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${testCompany}/impersonate`,
      payload: { reason: 'Developer MCP: checking the submissions list' },
    });
    expect(named.statusCode).toBe(201);
    const grants = JSON.parse(
      (
        await api.call(limited.accessToken, {
          method: 'GET',
          url: `/v1/platform/companies/${testCompany}/impersonations`,
        })
      ).body,
    ) as { items: { fromLimitedSession: boolean; platformUserId: string }[] };
    expect(grants.items[0]).toMatchObject({ fromLimitedSession: true, platformUserId: limited.id });

    // What the grant did is in the company's own audit log, under the staff account.
    const audit = JSON.parse(
      (
        await api.call(limited.accessToken, {
          method: 'GET',
          url: `/v1/platform/companies/${testCompany}/test-audit`,
        })
      ).body,
    ) as { items: { action: string; actorId: string | null }[] };
    expect(audit.items.some((entry) => entry.actorId === limited.id)).toBe(true);
  });

  it('signs itself out', async () => {
    // The 8-hour end is proved with a clock in @integr8/auth's platform session suite.
    const out = await api.call(limited.accessToken, {
      method: 'POST',
      url: '/v1/platform/auth/sign-out',
      payload: {},
    });
    expect(out.statusCode).toBe(204);
    const after = await api.call(limited.accessToken, { method: 'GET', url: '/v1/platform/me' });
    expect(after.statusCode).toBe(401);
  });
});

describe('a test company', () => {
  it('keeps its mail in its outbox instead of sending it', async () => {
    const company = await onboard(true, { sendInvitation: true });
    const outbox = JSON.parse(
      (
        await api.call(full.accessToken, {
          method: 'GET',
          url: `/v1/platform/companies/${company}/test-outbox`,
        })
      ).body,
    ) as { items: { channel: string; recipient: string; details: { kind?: string } }[] };
    expect(outbox.items.map((item) => [item.channel, item.details.kind])).toEqual([
      ['email', 'invitation'],
    ]);
  });

  it('gets no app builds', async () => {
    const refused = await api.call(full.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${testCompany}/app-builds`,
      payload: {},
    });
    expect(refused.statusCode).toBe(409);
    expect(errorCode(refused.body)).toBe('test_company_no_apps');
    const switchedOn = await api.call(full.accessToken, {
      method: 'PATCH',
      url: `/v1/platform/companies/${testCompany}/settings`,
      payload: { appsEnabled: true },
    });
    expect(errorCode(switchedOn.body)).toBe('test_company_no_apps');
  });

  it('is left out of billing and of the dashboard filter for real companies', async () => {
    const billed = await getPlatformDataSource().billing.list();
    expect(billed.map((subscription) => subscription.tenantId)).not.toContain(testCompany);
    const real = JSON.parse(
      (
        await api.call(full.accessToken, {
          method: 'GET',
          url: '/v1/platform/companies?test=false',
        })
      ).body,
    ) as { items: { id: string }[] };
    expect(real.items.map((company) => company.id)).not.toContain(testCompany);
  });

  it('answers the outbox and audit reads for test companies only', async () => {
    const refused = await api.call(full.accessToken, {
      method: 'GET',
      url: `/v1/platform/companies/${realCompany}/test-outbox`,
    });
    expect(errorCode(refused.body)).toBe('not_a_test_company');
  });
});
