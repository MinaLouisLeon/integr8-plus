import { getPlatformDataSource, withTenant } from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Quotes over HTTP (CRM/ERP plan, phase S1): the module switch, who drafts
 * and who issues, exact totals from catalogue prices with discounts and tax,
 * lines frozen on issue, the office's record of the customer's answer winning
 * the opportunity, revisions, expiry, and company isolation.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let dispatcher: Member;
let engineer: Member;
let viewer: Member;
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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: Record<string, unknown>,
  key?: string | null,
) {
  return api.call(await token(who), {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    ...(key === null || key === undefined ? {} : { headers: { 'idempotency-key': key } }),
  });
}

interface QuoteBody {
  id: string;
  reference: string;
  revision: number;
  status: string;
  expired: boolean;
  currencyCode: string;
  totals: { gross: string; discount: string; net: string; tax: string; total: string };
  internalNotes: string | null;
  issuedTo: { customerName: string } | null;
  hasLink: boolean;
  answer: { status: string; via: string; name: string | null } | null;
  opportunity: { id: string } | null;
  version: number;
}
interface LineBody {
  description: string;
  unit: string;
  unitPrice: string;
  gross: string;
  discount: string;
  tax: string;
  total: string;
}
interface Detail {
  quote: QuoteBody;
  lines: LineBody[];
  can: Record<string, boolean>;
}

const tag = () => randomUUID().slice(0, 6);

async function setFlag(key: string, enabled: boolean) {
  const response = await api.call(admin.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function newQuote(payload: Record<string, unknown> = {}, who: Member = dispatcher) {
  const response = await call(who, 'POST', '/v1/sales/quotes', {
    customerId,
    title: `Quote ${tag()}`,
    ...payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<Detail>(response);
}

async function issue(detail: Detail, who: Member = owner) {
  const response = await call(who, 'POST', `/v1/sales/quotes/${detail.quote.id}/issue`, {
    expectedVersion: detail.quote.version,
  });
  expect(response.statusCode, response.body).toBe(200);
  return json<Detail & { acceptToken: string; acceptUrl: string | null }>(response);
}

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin('qt-staff');
  owner = await api.member('owner', 'qt-owner');
  dispatcher = await api.member('dispatcher', 'qt-dispatcher');
  engineer = await api.member('engineer', 'qt-engineer');
  viewer = await api.member('viewer', 'qt-viewer');
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

describe('the sales module switch', () => {
  it('refuses every quote route until Integr8 switches it on', async () => {
    const before = await call(owner, 'GET', '/v1/sales/quotes');
    expect(before.statusCode).toBe(403);
    expect(code(before)).toBe('feature_disabled');
    await setFlag('sales', true);
    await setFlag('inventory', true);
    await setFlag('crm', true);
    const me = json<{ features: Record<string, boolean> }>(await call(owner, 'GET', '/v1/me'));
    expect(me.features).toMatchObject({ sales: true });
    expect((await call(owner, 'GET', '/v1/sales/quotes')).statusCode).toBe(200);
  });
});

describe('drafting', () => {
  it('prices catalogue lines from the item, applies discount and tax exactly, and numbers quotes in order', async () => {
    const item = await call(dispatcher, 'POST', '/v1/inventory/items', {
      sku: `VAL-${tag()}`,
      name: 'Ball valve 15mm',
      unit: 'each',
      salePrice: '0.1',
    });
    expect(item.statusCode, item.body).toBe(201);
    const first = await newQuote({
      lines: [
        { itemId: json<{ id: string }>(item).id, quantity: '3', discountBp: 2000, taxRateBp: 1400 },
        { description: 'Labour', quantity: '1.5', unit: 'hour', unitPrice: '2' },
      ],
      internalNotes: 'Margin is thin',
    });
    expect(first.quote).toMatchObject({
      status: 'draft',
      currencyCode: 'EGP',
      totals: { gross: '3.3', discount: '0.06', net: '3.24', tax: '0.0336', total: '3.2736' },
      internalNotes: 'Margin is thin',
    });
    expect(first.quote.reference).toMatch(/^QT-\d{6}$/u);
    expect(first.lines[0]).toMatchObject({
      description: 'Ball valve 15mm',
      unit: 'each',
      unitPrice: '0.1',
      total: '0.2736',
    });
    expect(first.can).toEqual({
      edit: true,
      issue: false,
      revise: false,
      answer: false,
      convert: false,
      cancel: true,
    });

    const second = await newQuote();
    expect(Number(second.quote.reference.slice(3))).toBe(
      Number(first.quote.reference.slice(3)) + 1,
    );

    const found = json<{ items: { id: string }[] }>(
      await call(viewer, 'GET', `/v1/sales/quotes?q=${first.quote.reference}`),
    );
    expect(found.items.map((row) => row.id)).toEqual([first.quote.id]);
  });

  it('needs a description on a hand-written line, and refuses another customer’s site', async () => {
    const bare = await call(dispatcher, 'POST', '/v1/sales/quotes', {
      customerId,
      title: 'Bare',
      lines: [{ quantity: '1', unitPrice: '1' }],
    });
    expect(bare.statusCode).toBe(422);
    expect(code(bare)).toBe('description_required');

    const other = await call(dispatcher, 'POST', '/v1/customers', { name: `Other ${tag()}` });
    const site = await call(
      dispatcher,
      'POST',
      `/v1/customers/${json<{ id: string }>(other).id}/sites`,
      { name: 'Their site', address: { line1: '2 Other Road' } },
    );
    const wrongSite = await call(dispatcher, 'POST', '/v1/sales/quotes', {
      customerId,
      title: 'Wrong site',
      siteId: json<{ id: string }>(site).id,
    });
    expect(wrongSite.statusCode).toBe(422);
    expect(code(wrongSite)).toBe('site_not_customers');
  });

  it('is for dispatchers and above; viewers read without internal notes; engineers see nothing', async () => {
    const quote = await newQuote({ internalNotes: 'Secret' });
    const asViewer = json<Detail>(await call(viewer, 'GET', `/v1/sales/quotes/${quote.quote.id}`));
    expect(asViewer.quote.internalNotes).toBeNull();
    expect(Object.values(asViewer.can).every((allowed) => !allowed)).toBe(true);
    expect(
      (await call(viewer, 'POST', '/v1/sales/quotes', { customerId, title: 'x' })).statusCode,
    ).toBe(403);
    expect((await call(engineer, 'GET', `/v1/sales/quotes/${quote.quote.id}`)).statusCode).toBe(
      403,
    );
  });
});

describe('issuing and answering', () => {
  it('is for owners and admins, freezes the customer and lines, and mints a link once', async () => {
    const draft = await newQuote({
      lines: [{ description: 'Service', quantity: '1', unitPrice: '100' }],
      validUntil: '2999-12-31',
    });
    const byDispatcher = await call(
      dispatcher,
      'POST',
      `/v1/sales/quotes/${draft.quote.id}/issue`,
      {
        expectedVersion: draft.quote.version,
      },
    );
    expect(byDispatcher.statusCode).toBe(403);

    const issued = await issue(draft);
    expect(issued.quote).toMatchObject({
      status: 'issued',
      hasLink: true,
      issuedTo: { customerName: 'Riverside Housing' },
      expired: false,
    });
    expect(issued.acceptToken).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    expect(issued.can).toMatchObject({ edit: false, issue: false, answer: true, revise: true });

    const late = await call(dispatcher, 'PATCH', `/v1/sales/quotes/${draft.quote.id}`, {
      expectedVersion: issued.quote.version,
      title: 'Too late',
    });
    expect(late.statusCode).toBe(409);
    expect(code(late)).toBe('quote_not_draft');

    const read = json<Detail & { acceptToken?: string }>(
      await call(dispatcher, 'GET', `/v1/sales/quotes/${draft.quote.id}`),
    );
    expect(read.acceptToken).toBeUndefined();
    expect(read.quote.hasLink).toBe(true);
  });

  it('cannot issue an empty draft', async () => {
    const empty = await newQuote();
    const refused = await call(owner, 'POST', `/v1/sales/quotes/${empty.quote.id}/issue`, {
      expectedVersion: empty.quote.version,
    });
    expect(refused.statusCode).toBe(422);
    expect(code(refused)).toBe('quote_empty');
  });

  it('records the office’s answer, wins the opportunity, and spends the link', async () => {
    const opportunity = await call(owner, 'POST', '/v1/crm/opportunities', {
      title: 'Boiler replacement',
      customerId,
    });
    expect(opportunity.statusCode, opportunity.body).toBe(201);
    const opportunityId = json<{ id: string }>(opportunity).id;
    const draft = await newQuote({
      opportunityId,
      lines: [{ description: 'Boiler', quantity: '1', unitPrice: '5000' }],
    });
    const issued = await issue(draft);
    const accepted = await call(dispatcher, 'POST', `/v1/sales/quotes/${draft.quote.id}/answer`, {
      expectedVersion: issued.quote.version,
      status: 'accepted',
      name: 'Sam, by phone',
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const detail = json<Detail>(accepted);
    expect(detail.quote).toMatchObject({
      status: 'accepted',
      hasLink: false,
      answer: { status: 'accepted', via: 'office', name: 'Sam, by phone' },
    });
    expect(detail.can).toMatchObject({
      convert: true,
      answer: false,
      cancel: false,
      revise: false,
    });

    const won = json<{ opportunity: { status: string } }>(
      await call(owner, 'GET', `/v1/crm/opportunities/${opportunityId}`),
    );
    expect(won.opportunity.status).toBe('won');

    const again = await call(dispatcher, 'POST', `/v1/sales/quotes/${draft.quote.id}/answer`, {
      expectedVersion: detail.quote.version,
      status: 'rejected',
    });
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('quote_not_issued');
  });

  it('revises a rejected quote into a new draft revision under the same reference', async () => {
    const draft = await newQuote({
      lines: [{ description: 'Pump', quantity: '1', unitPrice: '900' }],
    });
    const issued = await issue(draft);
    const rejected = json<Detail>(
      await call(dispatcher, 'POST', `/v1/sales/quotes/${draft.quote.id}/answer`, {
        expectedVersion: issued.quote.version,
        status: 'rejected',
        reason: 'Too dear',
      }),
    );
    expect(rejected.quote.status).toBe('rejected');
    const revised = await call(dispatcher, 'POST', `/v1/sales/quotes/${draft.quote.id}/revise`, {
      expectedVersion: rejected.quote.version,
    });
    expect(revised.statusCode, revised.body).toBe(200);
    const next = json<Detail>(revised);
    expect(next.quote).toMatchObject({
      status: 'draft',
      revision: 2,
      reference: `${draft.quote.reference}-R2`,
      issuedTo: null,
      answer: null,
    });
    const edited = await call(dispatcher, 'PATCH', `/v1/sales/quotes/${draft.quote.id}`, {
      expectedVersion: next.quote.version,
      lines: [{ description: 'Pump, smaller', quantity: '1', unitPrice: '700' }],
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(json<Detail>(edited).quote.totals.total).toBe('700');
  });

  it('does not take an answer on an expired quote, but lets it be revised', async () => {
    const draft = await newQuote({
      validUntil: '2000-01-01',
      lines: [{ description: 'Old', quantity: '1', unitPrice: '1' }],
    });
    const issued = await issue(draft);
    expect(issued.quote.expired).toBe(true);
    expect(issued.can).toMatchObject({ answer: false, revise: true });
    const refused = await call(dispatcher, 'POST', `/v1/sales/quotes/${draft.quote.id}/answer`, {
      expectedVersion: issued.quote.version,
      status: 'accepted',
    });
    expect(refused.statusCode).toBe(409);
    expect(code(refused)).toBe('quote_expired');
  });

  it('withdraws a draft or issued quote, never an accepted one', async () => {
    const draft = await newQuote();
    const cancelled = await call(dispatcher, 'POST', `/v1/sales/quotes/${draft.quote.id}/cancel`, {
      expectedVersion: draft.quote.version,
      reason: 'Customer went elsewhere',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(json<Detail>(cancelled).quote.status).toBe('cancelled');
    const twice = await call(dispatcher, 'POST', `/v1/sales/quotes/${draft.quote.id}/cancel`, {
      expectedVersion: json<Detail>(cancelled).quote.version,
    });
    expect(twice.statusCode).toBe(409);
    expect(code(twice)).toBe('quote_closed');
  });
});

describe('another company', () => {
  it('cannot be reached by id', async () => {
    const elsewhere = await getPlatformDataSource().tenants.create({
      slug: `qt-other-${randomUUID().slice(0, 8)}`,
      name: 'Elsewhere Ltd',
    });
    const theirCustomer = await withTenant(elsewhere.id, (tx) =>
      tx.customers.create({ name: 'Theirs' }, randomUUID()),
    );
    const theirQuote = await withTenant(elsewhere.id, (tx) =>
      tx.salesQuotes.createQuote(
        { customerId: theirCustomer.id, title: 'Theirs', currencyCode: 'EGP' },
        [],
        randomUUID(),
      ),
    );
    expect((await call(owner, 'GET', `/v1/sales/quotes/${theirQuote.id}`)).statusCode).toBe(404);
    const cross = await call(dispatcher, 'POST', '/v1/sales/quotes', {
      customerId: theirCustomer.id,
      title: 'Cross',
    });
    expect(cross.statusCode).toBe(404);
    expect(code(cross)).toBe('customer_not_found');
  });
});
