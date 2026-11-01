import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * The customer's link (CRM/ERP plan, phase S1; ADR-0006): the token the
 * office copies opens the issued quote with no session, shows the company and
 * nothing internal, takes one answer that spends it and wins the opportunity,
 * refuses an expired quote, and tells a stranger nothing about a bad link.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
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

/** No session at all: what the customer's browser sends. */
const anonymous = (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) =>
  api.app.inject({
    method,
    url,
    headers: { 'x-client-version': '1.0.0', 'x-client-app': 'web' },
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
  owner = await api.member('owner', 'pq-owner');
  dispatcher = await api.member('dispatcher', 'pq-dispatcher');
  const flag = await api.call(admin.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/sales`,
    payload: { enabled: true },
  });
  expect(flag.statusCode, flag.body).toBe(200);
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
  it('opens the issued quote without a session, showing the company and nothing internal', async () => {
    const issued = await issuedQuote();
    expect(issued.acceptToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    const response = await anonymous('GET', `/v1/public/quotes/${issued.acceptToken}`);
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
    const noName = await anonymous('POST', `/v1/public/quotes/${issued.acceptToken}/answer`, {
      status: 'accepted',
    });
    expect(noName.statusCode).toBe(422);

    const accepted = await anonymous('POST', `/v1/public/quotes/${issued.acceptToken}/answer`, {
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
    expect((await anonymous('GET', `/v1/public/quotes/${issued.acceptToken}`)).statusCode).toBe(
      404,
    );
    expect(
      (
        await anonymous('POST', `/v1/public/quotes/${issued.acceptToken}/answer`, {
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
    const seen = json<PublicQuote>(
      await anonymous('GET', `/v1/public/quotes/${issued.acceptToken}`),
    );
    expect(seen.quote.expired).toBe(true);
    expect(seen.canAnswer).toBe(false);
    const late = await anonymous('POST', `/v1/public/quotes/${issued.acceptToken}/answer`, {
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
    expect((await anonymous('GET', `/v1/public/quotes/${issued.acceptToken}`)).statusCode).toBe(
      404,
    );
    const unknown = await anonymous('GET', `/v1/public/quotes/${randomUUID().replaceAll('-', '')}`);
    expect(unknown.statusCode).toBe(404);
    const malformed = await anonymous('GET', '/v1/public/quotes/not%20a%20token');
    expect(malformed.statusCode).toBe(422);
  });
});

describe('with the sales module switched off (Low 13)', () => {
  async function sales(enabled: boolean) {
    const flag = await api.call(admin.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/flags/sales`,
      payload: { enabled },
    });
    expect(flag.statusCode, flag.body).toBe(200);
  }

  it('says the quote is no longer online, naming the company, and restores it when on', async () => {
    const open = await issuedQuote();
    const expired = await issuedQuote({ validUntil: '2020-01-01' });
    const withdrawn = await issuedQuote();
    const cancelled = await call(owner, 'POST', `/v1/sales/quotes/${withdrawn.quote.id}/cancel`, {
      expectedVersion: withdrawn.quote.version,
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    const company = json<PublicQuote>(
      await anonymous('GET', `/v1/public/quotes/${open.acceptToken}`),
    ).company.name;

    await sales(false);
    try {
      const seen = await anonymous('GET', `/v1/public/quotes/${open.acceptToken}`);
      expect(seen.statusCode).toBe(410);
      const error = json<{
        error: { code: string; message: string; details: { params: { company: string } }[] };
      }>(seen).error;
      expect(error.code).toBe('quote_unavailable');
      expect(error.message).toBe(
        `This quote is no longer available online. Please contact ${company}.`,
      );
      expect(error.details[0]?.params.company).toBe(company);
      expect(seen.body).not.toContain('Boiler service');

      // In Arabic for a reader whose browser prefers it.
      const arabic = await api.app.inject({
        method: 'GET',
        url: `/v1/public/quotes/${open.acceptToken}`,
        headers: {
          'x-client-version': '1.0.0',
          'x-client-app': 'web',
          'accept-language': 'ar-EG,ar;q=0.9,en;q=0.8',
        },
      });
      expect(arabic.statusCode).toBe(410);
      expect(json<{ error: { message: string } }>(arabic).error.message).toContain(company);
      expect(json<{ error: { message: string } }>(arabic).error.message).toContain(
        '\u064a\u064f\u0631\u062c\u0649',
      );

      // Nor can it be answered, and an expired one says the same.
      const answer = await anonymous('POST', `/v1/public/quotes/${open.acceptToken}/answer`, {
        status: 'accepted',
        name: 'While off',
      });
      expect(answer.statusCode).toBe(410);
      expect(code(answer)).toBe('quote_unavailable');
      expect((await anonymous('GET', `/v1/public/quotes/${expired.acceptToken}`)).statusCode).toBe(
        410,
      );

      // A withdrawn link stays a 404 that names nobody.
      const gone = await anonymous('GET', `/v1/public/quotes/${withdrawn.acceptToken}`);
      expect(gone.statusCode).toBe(404);
      expect(gone.body).not.toContain(company);
    } finally {
      await sales(true);
    }

    // Back on: the link opens as before; the expired one is still expired.
    const again = json<PublicQuote>(
      await anonymous('GET', `/v1/public/quotes/${open.acceptToken}`),
    );
    expect(again.canAnswer).toBe(true);
    const stillExpired = json<PublicQuote>(
      await anonymous('GET', `/v1/public/quotes/${expired.acceptToken}`),
    );
    expect(stillExpired.quote.expired).toBe(true);
    expect(stillExpired.canAnswer).toBe(false);
    expect((await anonymous('GET', `/v1/public/quotes/${withdrawn.acceptToken}`)).statusCode).toBe(
      404,
    );
  });
});
