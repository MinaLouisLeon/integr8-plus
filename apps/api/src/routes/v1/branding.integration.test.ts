import { getPlatformDataSource } from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type Member, startApi } from '../../testing/api-harness.js';

/**
 * A company's look is Integr8's to set, and its apps are built for it (0022).
 *
 * Four claims:
 *
 * 1. the branding fields on `/v1/settings` are refused to the company's own
 *    owner and accepted from staff acting as the company, while the owner
 *    keeps the working day;
 * 2. `/v1/me` carries the whole brand to every app;
 * 3. the brand is readable with no session at all, by slug, and nothing else is;
 * 4. an app built for one company refuses an account from another, and the
 *    pipeline's list of companies to build for is behind the build token.
 */

const BUILD_TOKEN = 'a-build-token-long-enough-to-pass-the-minimum-length';

let api: ApiHarness;
let owner: Member;
let ownerToken: string;
let staffToken: string;
let slug: string;

beforeAll(async () => {
  api = await startApi({ env: { BUILD_TOKEN } });
  owner = await api.member('owner', 'branding-owner');
  ownerToken = await api.signIn(owner);
  staffToken = await api.staff(owner);
  slug = (await getPlatformDataSource().tenants.findById(api.tenantId))?.slug ?? '';
});

afterAll(async () => {
  await api.close();
});

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

describe('who sets the brand', () => {
  it('refuses a branding field from the company’s own owner, with the Integr8 message', async () => {
    const response = await api.call(ownerToken, {
      method: 'PATCH',
      url: '/v1/settings',
      payload: { brandColour: '#112233' },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(response.body).toContain('Integr8');
  });

  it('still lets the owner change the working day', async () => {
    const response = await api.call(ownerToken, {
      method: 'PATCH',
      url: '/v1/settings',
      payload: { timezone: 'Europe/London', workDayStarts: 9 * 60 },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(json<{ timezone: string }>(response).timezone).toBe('Europe/London');
  });

  it('accepts the whole brand from staff acting as the company', async () => {
    const response = await api.call(staffToken, {
      method: 'PATCH',
      url: '/v1/settings',
      payload: {
        brandColour: '#112233',
        shellColour: '#0A1F44',
        defaultTheme: 'dark',
        websiteUrl: 'https://www.example-company.test/',
        appsEnabled: true,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const body = json<{
      brandColour: string;
      shellColour: string;
      defaultTheme: string;
      websiteUrl: string;
      appsEnabled: boolean;
      timezone: string;
    }>(response);
    expect(body.shellColour).toBe('#0A1F44');
    expect(body.defaultTheme).toBe('dark');
    expect(body.websiteUrl).toBe('https://www.example-company.test/');
    expect(body.appsEnabled).toBe(true);
    // The owner's change above survived: only what is sent changes.
    expect(body.timezone).toBe('Europe/London');
  });

  it('refuses a website that is not https', async () => {
    const response = await api.call(staffToken, {
      method: 'PATCH',
      url: '/v1/settings',
      payload: { websiteUrl: 'http://insecure.example' },
    });
    expect(response.statusCode, response.body).toBe(422);
  });

  it('refuses an app icon that is not a stored image of this company’s', async () => {
    const response = await api.call(staffToken, {
      method: 'PATCH',
      url: '/v1/settings',
      payload: { appIconMediaId: randomUUID() },
    });
    expect(response.statusCode, response.body).toBe(422);
    expect(response.body).toContain('app_icon_not_found');
  });

  it('hands the whole brand to every app through /v1/me', async () => {
    const response = await api.call(ownerToken, { method: 'GET', url: '/v1/me' });
    expect(response.statusCode).toBe(200);
    const { company, permissions } = json<{
      company: Record<string, unknown>;
      permissions: string[];
    }>(response);
    expect(company).toMatchObject({
      slug,
      brandColour: '#112233',
      shellColour: '#0A1F44',
      defaultTheme: 'dark',
      websiteUrl: 'https://www.example-company.test/',
    });
    // The owner does not hold it; the staff seat does.
    expect(permissions).not.toContain('branding.manage');
    const staff = await api.call(staffToken, { method: 'GET', url: '/v1/me' });
    expect(json<{ permissions: string[] }>(staff).permissions).toContain('branding.manage');
  });
});

describe('the public brand', () => {
  it('answers by slug with no session, and exposes only the brand', async () => {
    const response = await api.app.inject({
      method: 'GET',
      url: `/v1/public/companies/${slug}/brand`,
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'mobile' },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toContain('max-age');
    const body = json<Record<string, unknown>>(response);
    expect(body).toEqual({
      slug,
      name: expect.any(String) as string,
      brandColour: '#112233',
      shellColour: '#0A1F44',
      defaultTheme: 'dark',
      websiteUrl: 'https://www.example-company.test/',
      logoPath: null,
      appIconPath: null,
    });
  });

  it('knows nothing about a slug that is not a company', async () => {
    const response = await api.app.inject({
      method: 'GET',
      url: '/v1/public/companies/no-such-company/brand',
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'mobile' },
    });
    expect(response.statusCode).toBe(404);
    const logo = await api.app.inject({
      method: 'GET',
      url: `/v1/public/companies/${slug}/logo`,
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'mobile' },
    });
    expect(logo.statusCode).toBe(404);
  });
});

describe('an app built for one company', () => {
  it('signs its own people in by slug', async () => {
    const response = await api.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'mobile' },
      payload: {
        email: owner.email,
        password: owner.password,
        clientApp: 'mobile',
        companySlug: slug,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(json<{ tenantId: string }>(response).tenantId).toBe(api.tenantId);
  });

  it('refuses an account from another company with wrong_company', async () => {
    const other = await getPlatformDataSource().tenants.create({
      slug: `other-${randomUUID().slice(0, 8)}`,
      name: 'Somebody Else Ltd',
      plan: 'trial',
      seats: null,
      onboardedBy: null,
    });
    const response = await api.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'mobile' },
      payload: {
        email: owner.email,
        password: owner.password,
        clientApp: 'mobile',
        companySlug: other.slug,
      },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(json<{ error: { code: string } }>(response).error.code).toBe('wrong_company');
  });

  it('refuses a slug that names no company the same way', async () => {
    const response = await api.app.inject({
      method: 'POST',
      url: '/v1/auth/sign-in',
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'mobile' },
      payload: {
        email: owner.email,
        password: owner.password,
        clientApp: 'mobile',
        companySlug: 'never-onboarded',
      },
    });
    expect(response.statusCode, response.body).toBe(403);
    expect(json<{ error: { code: string } }>(response).error.code).toBe('wrong_company');
  });
});

describe('the pipeline’s list of companies to build for', () => {
  it('needs the build token', async () => {
    const missing = await api.app.inject({
      method: 'GET',
      url: '/v1/build/companies',
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'web' },
    });
    expect(missing.statusCode).toBe(403);
    const wrong = await api.app.inject({
      method: 'GET',
      url: '/v1/build/companies',
      headers: {
        'x-client-version': '1.0.0',
        'x-client-app': 'web',
        authorization: 'Bearer not-the-token-at-all-but-just-as-long-as-one',
      },
    });
    expect(wrong.statusCode).toBe(403);
  });

  it('lists the companies with apps switched on, by slug', async () => {
    const response = await api.app.inject({
      method: 'GET',
      url: '/v1/build/companies',
      headers: {
        'x-client-version': '1.0.0',
        'x-client-app': 'web',
        authorization: `Bearer ${BUILD_TOKEN}`,
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    const { items } = json<{ items: { slug: string; name: string }[] }>(response);
    expect(items.map((item) => item.slug)).toContain(slug);
  });
});
