import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * The customer's link (CRM/ERP plan, phase S1; ADR-0006), on the company's own
 * website: the link opens `<website>/q/<token>`, whose server reads the issued
 * quote with its website key. It shows the company and nothing internal, takes
 * one answer that spends it and wins the opportunity, refuses an expired quote,
 * and tells a stranger nothing about a bad link. Integr8 serves no quote page,
 * and a company without a website has no customer link.
 */

const SITE = 'https://www.riverside-services.example';

let api: ApiHarness;
let admin: PlatformAdmin;
let manager: PlatformAdmin;
let websiteKey: string;
let owner: Member;
let dispatcher: Member;
const tokens = new Map<Member, string>();
let customerId: string;

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

async function token(who: Member): Promise<string> {
  let value = tokens.get(who);
  if (value === undefined) {
    value = await api.signIn(who);
    tokens.set(who, value);
  }
  return value;
}

async function call(
  who: Member,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
) {
  return api.call(await token(who), {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
  });
}

/** The company website's server, holding its key: what reads the quote now. */
const website = (
  method: 'GET' | 'POST',
  token: string,
  payload?: Record<string, unknown>,
  key: string | null = websiteKey,
) =>
  api.app.inject({
    method,
    url: `/v1/website/quotes/by-token/${token}${method === 'POST' ? '/answer' : ''}`,
    headers: {
      'x-client-version': '1.0.0',
      'x-client-app': 'web',
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
    },
    ...(payload === undefined ? {} : { payload }),
  });

interface QuoteDetail {
  quote: { id: string; status: string; version: number; hasLink: boolean };
}
interface PublicQuote {
  company: { name: string; logoPath: string | null };
  quote: {
    reference: string;
    status: string;
    expired: boolean;
    customerName: string;
    answer: { status: string; name: string | null } | null;
  };
  lines: { description: string; total: string }[];
  totals: { total: string };
  canAnswer: boolean;
}

async function issuedQuote(payload: Record<string, unknown> = {}) {
  const created = await call(dispatcher, 'POST', '/v1/sales/quotes', {
    customerId,
    title: 'Boiler service',
    introduction: 'Thank you for asking us.',
    terms: 'Payment within 30 days.',
    internalNotes: 'Margin is thin on this one.',
    lines: [{ description: 'Annual service', quantity: '1', unitPrice: '120', taxRateBp: 1400 }],
    ...payload,
  });
  expect(created.statusCode, created.body).toBe(201);
  const detail = json<QuoteDetail>(created);
  const issued = await call(owner, 'POST', `/v1/sales/quotes/${detail.quote.id}/issue`, {
    expectedVersion: detail.quote.version,
  });
  expect(issued.statusCode, issued.body).toBe(200);
  return json<QuoteDetail & { acceptToken: string; acceptUrl: string | null }>(issued);
}

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin('pq-staff');
  manager = await api.platformAdmin('pq-manager', { manager: true });
  owner = await api.member('owner', 'pq-owner');
  dispatcher = await api.member('dispatcher', 'pq-dispatcher');
  for (const name of ['sales', 'website_quotes']) {
    const flag = await api.call(admin.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/flags/${name}`,
      payload: { enabled: true },
    });
    expect(flag.statusCode, flag.body).toBe(200);
  }
  const site = await api.call(admin.accessToken, {
    method: 'PATCH',
    url: `/v1/platform/companies/${api.tenantId}/settings`,
    payload: { websiteUrl: SITE },
  });
  expect(site.statusCode, site.body).toBe(200);
  const own = await call(owner, 'PATCH', '/v1/settings/website-access', {
    websiteQuotesEnabled: true,
  });
  expect(own.statusCode, own.body).toBe(200);
  const key = await api.call(manager.accessToken, {
    method: 'POST',
    url: `/v1/platform/companies/${api.tenantId}/website-keys`,
    payload: { label: 'quote pages' },
  });
  expect(key.statusCode, key.body).toBe(201);
  websiteKey = json<{ secret: string }>(key).secret;
  const customer = await call(dispatcher, 'POST', '/v1/customers', {
    name: 'Riverside Housing',
    address: { line1: '1 River Road', city: 'Cairo', countryCode: 'EG' },
  });
  expect(customer.statusCode, customer.body).toBe(201);
  customerId = json<{ id: string }>(customer).id;
});

afterAll(async () => {
  await api.close();
});

describe('the customer’s link', () => {
  it('points at the company’s website and is served only through its key', async () => {
    const issued = await issuedQuote();
    expect(issued.acceptUrl).toBe(`${SITE}/q/${issued.acceptToken}`);
    // Integr8 serves no quote page.
    const integr8 = await api.app.inject({
      method: 'GET',
      url: `/v1/public/quotes/${issued.acceptToken}`,
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'web' },
    });
    expect(integr8.statusCode).toBe(404);
    // No key, or a made-up one: refused alike.
    for (const key of [null, `i8wk_${'x'.repeat(43)}`]) {
      const refused = await website('GET', issued.acceptToken, undefined, key);
      expect(refused.statusCode).toBe(401);
      expect(code(refused)).toBe('website_key_invalid');
    }
  });

  it('opens the issued quote for the website, showing the company and nothing internal', async () => {
    const issued = await issuedQuote();
    expect(issued.acceptToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const response = await website('GET', issued.acceptToken);
    expect(response.statusCode, response.body).toBe(200);
    const seen = json<PublicQuote>(response);
    expect(seen.quote).toMatchObject({
      status: 'issued',
      expired: false,
      customerName: 'Riverside Housing',
      answer: null,
    });
    expect(seen.company.name).not.toBe('');
    expect(seen.lines).toEqual([expect.objectContaining({ description: 'Annual service' })]);
    expect(seen.totals.total).toBe('136.8');
    expect(seen.canAnswer).toBe(true);
    expect(response.body).not.toContain('Margin is thin');
    expect(response.body).not.toContain(customerId);
  });

  it('takes one answer, which spends the link and shows in the office', async () => {
    const issued = await issuedQuote();
    const noName = await website('POST', issued.acceptToken, {
      status: 'accepted',
    });
    expect(noName.statusCode).toBe(422);

    const accepted = await website('POST', issued.acceptToken, {
      status: 'accepted',
      name: 'Mrs Hassan',
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const after = json<PublicQuote>(accepted);
    expect(after.quote).toMatchObject({
      status: 'accepted',
      answer: { status: 'accepted', name: 'Mrs Hassan' },
    });
    expect(after.canAnswer).toBe(false);

    // Spent: the same link now says nothing.
    expect((await website('GET', issued.acceptToken)).statusCode).toBe(404);
    expect(
      (
        await website('POST', issued.acceptToken, {
          status: 'rejected',
          name: 'Again',
        })
      ).statusCode,
    ).toBe(404);

    const office = json<{
      quote: { status: string; hasLink: boolean; answer: { via: string; name: string | null } };
      can: { convert: boolean };
    }>(await call(dispatcher, 'GET', `/v1/sales/quotes/${issued.quote.id}`));
    expect(office.quote).toMatchObject({
      status: 'accepted',
      hasLink: false,
      answer: { via: 'link', name: 'Mrs Hassan' },
    });
    expect(office.can.convert).toBe(true);
  });

  it('refuses an expired quote but still shows it', async () => {
    const issued = await issuedQuote({ validUntil: '2020-01-01' });
    const seen = json<PublicQuote>(await website('GET', issued.acceptToken));
    expect(seen.quote.expired).toBe(true);
    expect(seen.canAnswer).toBe(false);
    const late = await website('POST', issued.acceptToken, {
      status: 'accepted',
      name: 'Too late',
    });
    expect(late.statusCode).toBe(409);
    expect(code(late)).toBe('quote_expired');
  });

  it('dies with a revision or a withdrawal, and an unknown link is the same 404', async () => {
    const issued = await issuedQuote();
    const revised = await call(dispatcher, 'POST', `/v1/sales/quotes/${issued.quote.id}/revise`, {
      expectedVersion: issued.quote.version,
    });
    expect(revised.statusCode, revised.body).toBe(200);
    expect((await website('GET', issued.acceptToken)).statusCode).toBe(404);
    const unknown = await website('GET', randomUUID().replaceAll('-', ''));
    expect(unknown.statusCode).toBe(404);
    const malformed = await website('GET', 'not%20a%20token');
    expect(malformed.statusCode).toBe(422);
  });
});

describe('when the company cannot show quotes online', () => {
  async function sales(enabled: boolean) {
    const flag = await api.call(admin.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/flags/sales`,
      payload: { enabled },
    });
    expect(flag.statusCode, flag.body).toBe(200);
  }

  it('refuses the website while sales is off, and opens again when it is on', async () => {
    const open = await issuedQuote();
    await sales(false);
    try {
      const seen = await website('GET', open.acceptToken);
      expect(seen.statusCode).toBe(403);
      expect(code(seen)).toBe('feature_disabled');
      expect(seen.body).not.toContain('Boiler service');
      const answer = await website('POST', open.acceptToken, {
        status: 'accepted',
        name: 'While off',
      });
      expect(answer.statusCode).toBe(403);
    } finally {
      await sales(true);
    }
    expect(json<PublicQuote>(await website('GET', open.acceptToken)).canAnswer).toBe(true);
  });

  it('gives no customer link and serves nothing without a website', async () => {
    const before = await issuedQuote();
    const settings = `/v1/platform/companies/${api.tenantId}/settings`;
    const cleared = await api.call(admin.accessToken, {
      method: 'PATCH',
      url: settings,
      payload: { websiteUrl: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    try {
      const issued = await issuedQuote();
      expect(issued.acceptUrl).toBeNull();
      const refused = await website('GET', before.acceptToken);
      expect(refused.statusCode).toBe(403);
      expect(code(refused)).toBe('website_missing');
    } finally {
      const restored = await api.call(admin.accessToken, {
        method: 'PATCH',
        url: settings,
        payload: { websiteUrl: SITE },
      });
      expect(restored.statusCode, restored.body).toBe(200);
    }
  });
});
