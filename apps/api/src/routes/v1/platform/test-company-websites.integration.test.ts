import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type PlatformAdmin, startApi } from '../../../testing/api-harness.js';

/**
 * A test company's website setup from a session limited to test companies (P43).
 *
 * The developer MCP server makes a website key, switches Integr8's website
 * grants on and points the document links at a website on the developer's
 * machine. These prove the API keeps that to test companies and to those
 * flags and fields, and that localhost stays out of reach of real companies.
 */

let api: ApiHarness;
let full: PlatformAdmin;
let limited: PlatformAdmin;
let limitedNotManager: PlatformAdmin;
let testCompany: string;
let realCompany: string;

async function onboard(isTest: boolean, extra: Record<string, unknown> = {}) {
  const slug = `${isTest ? 'test' : 'real'}-${randomUUID().slice(0, 8)}`;
  return api.call(full.accessToken, {
    method: 'POST',
    url: '/v1/platform/companies',
    payload: { slug, name: `${slug} Ltd`, ownerEmail: `owner@${slug}.example`, isTest, ...extra },
  });
}

async function onboarded(isTest: boolean): Promise<string> {
  const response = await onboard(isTest);
  expect(response.statusCode).toBe(201);
  return (JSON.parse(response.body) as { company: { id: string } }).company.id;
}

const errorCode = (body: string) => (JSON.parse(body) as { error?: { code?: string } }).error?.code;

beforeAll(async () => {
  api = await startApi();
  full = await api.platformAdmin('full', { manager: true });
  limited = await api.platformAdmin('developer', { manager: true, scope: 'test_companies' });
  limitedNotManager = await api.platformAdmin('helper', { scope: 'test_companies' });
  testCompany = await onboarded(true);
  realCompany = await onboarded(false);
});

afterAll(async () => {
  await api.close();
});

describe('website keys from a limited session', () => {
  it('are made, listed, disabled and revoked on a test company', async () => {
    const made = await api.call(limited.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${testCompany}/website-keys`,
      payload: { label: 'Developer MCP' },
    });
    expect(made.statusCode).toBe(201);
    const { key, secret } = JSON.parse(made.body) as { key: { id: string }; secret: string };
    expect(secret).toMatch(/^i8wk_/u);

    const listed = await api.call(limited.accessToken, {
      method: 'GET',
      url: `/v1/platform/companies/${testCompany}/website-keys`,
    });
    expect(listed.statusCode).toBe(200);
    expect(
      (JSON.parse(listed.body) as { items: { id: string }[] }).items.map((k) => k.id),
    ).toContain(key.id);

    const disabled = await api.call(limited.accessToken, {
      method: 'PATCH',
      url: `/v1/platform/companies/${testCompany}/website-keys/${key.id}`,
      payload: { enabled: false },
    });
    expect(disabled.statusCode).toBe(200);

    const revoked = await api.call(limited.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${testCompany}/website-keys/${key.id}/revoke`,
    });
    expect(revoked.statusCode).toBe(200);
  });

  it('are refused on a real company', async () => {
    for (const request of [
      { method: 'GET' as const, url: `/v1/platform/companies/${realCompany}/website-keys` },
      {
        method: 'POST' as const,
        url: `/v1/platform/companies/${realCompany}/website-keys`,
        payload: { label: 'nope' },
      },
    ]) {
      const refused = await api.call(limited.accessToken, request);
      expect(refused.statusCode, request.url).toBe(403);
      expect(errorCode(refused.body), request.url).toBe('session_scope');
    }
  });

  it('need a staff manager on a real company only', async () => {
    const test = await api.call(limitedNotManager.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${testCompany}/website-keys`,
      payload: { label: 'any staff member' },
    });
    expect(test.statusCode).toBe(201);
    const made = JSON.parse(test.body) as { key: { id: string } };
    const revoked = await api.call(limitedNotManager.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${testCompany}/website-keys/${made.key.id}/revoke`,
    });
    expect(revoked.statusCode).toBe(200);

    const notManager = await api.platformAdmin('staff-not-manager');
    const real = await api.call(notManager.accessToken, {
      method: 'POST',
      url: `/v1/platform/companies/${realCompany}/website-keys`,
      payload: { label: 'not a manager' },
    });
    expect(real.statusCode).toBe(403);
    expect(errorCode(real.body)).toBe('staff_manager_only');
  });
});

describe('flags from a limited session', () => {
  it('may switch documents and the website grants on a test company', async () => {
    for (const key of ['documents', 'website_files', 'website_jobs']) {
      const set = await api.call(limited.accessToken, {
        method: 'PUT',
        url: `/v1/platform/companies/${testCompany}/flags/${key}`,
        payload: { enabled: true },
      });
      expect(set.statusCode, key).toBe(200);
      expect((JSON.parse(set.body) as { flags: Record<string, boolean> }).flags[key], key).toBe(
        true,
      );
    }
  });

  it('may not switch any other flag, nor any flag on a real company', async () => {
    const other = await api.call(limited.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${testCompany}/flags/payroll`,
      payload: { enabled: true },
    });
    expect(other.statusCode).toBe(403);
    expect(errorCode(other.body)).toBe('session_scope');

    const real = await api.call(limited.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${realCompany}/flags/website_files`,
      payload: { enabled: true },
    });
    expect(real.statusCode).toBe(403);
    expect(errorCode(real.body)).toBe('session_scope');
  });
});

describe('website and document links from a limited session', () => {
  it('may point a test company at a website on localhost', async () => {
    const changed = await api.call(limited.accessToken, {
      method: 'PATCH',
      url: `/v1/platform/companies/${testCompany}/settings`,
      payload: {
        websiteUrl: 'http://localhost:3000',
        documentLinkPattern: 'http://localhost:3000/documents/{code}',
      },
    });
    expect(changed.statusCode).toBe(200);
    const body = JSON.parse(changed.body) as { websiteUrl: string; documentLinkPattern: string };
    expect(body.websiteUrl).toBe('http://localhost:3000');
    expect(body.documentLinkPattern).toBe('http://localhost:3000/documents/{code}');
  });

  it('may not change anything else', async () => {
    const refused = await api.call(limited.accessToken, {
      method: 'PATCH',
      url: `/v1/platform/companies/${testCompany}/settings`,
      payload: { aiDesktopEnabled: true },
    });
    expect(refused.statusCode).toBe(403);
    expect(errorCode(refused.body)).toBe('session_scope');
  });

  it('may not touch a real company', async () => {
    const refused = await api.call(limited.accessToken, {
      method: 'PATCH',
      url: `/v1/platform/companies/${realCompany}/settings`,
      payload: { websiteUrl: 'https://real.example' },
    });
    expect(refused.statusCode).toBe(403);
    expect(errorCode(refused.body)).toBe('session_scope');
  });
});

describe('localhost for a real company', () => {
  it('is refused as its website, even from the dashboard', async () => {
    const refused = await api.call(full.accessToken, {
      method: 'PATCH',
      url: `/v1/platform/companies/${realCompany}/settings`,
      payload: { websiteUrl: 'http://localhost:3000' },
    });
    expect(refused.statusCode).toBe(422);
    expect(errorCode(refused.body)).toBe('website_url_local_only');

    const onboarding = await onboard(false, { websiteUrl: 'http://127.0.0.1:3000' });
    expect(onboarding.statusCode).toBe(422);
    expect(errorCode(onboarding.body)).toBe('website_url_local_only');
  });

  it('is refused as its document links', async () => {
    const site = await api.call(full.accessToken, {
      method: 'PATCH',
      url: `/v1/platform/companies/${realCompany}/settings`,
      payload: { websiteUrl: 'https://real.example' },
    });
    expect(site.statusCode).toBe(200);
    const refused = await api.call(full.accessToken, {
      method: 'PATCH',
      url: `/v1/platform/companies/${realCompany}/settings`,
      payload: { documentLinkPattern: 'http://localhost:3000/documents/{code}' },
    });
    expect(refused.statusCode).toBe(422);
    expect(errorCode(refused.body)).toBe('document_link_invalid');
  });

  it('is still accepted for a new test company', async () => {
    const created = await onboard(true, { websiteUrl: 'http://localhost:3000' });
    expect(created.statusCode).toBe(201);
  });
});
