import { getPlatformDataSource } from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../http/logger.js';
import { type ApiHarness, type Member, startApi } from '../testing/api-harness.js';
import { runDunning } from './dunning.js';

/**
 * A deployment that takes no card payments (`BILLING_PROVIDER=none`).
 *
 * Integr8 invoices every company and sets its plan from the dashboard. So
 * every company reads as invoiced, the card routes say so, nothing from a
 * provider is believed, and no trial runs out into read-only — including for a
 * company that was made self-serve before the deployment switched.
 */

let api: ApiHarness;
let owner: Member;
let token: string;

const silent = createLogger({ level: 'error', write: () => undefined });
const DAY_MS = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  api = await startApi({
    env: {
      BILLING_PROVIDER: 'none',
      BILLING_RETURN_URL: 'https://app.test.integr8.example',
      WEB_APP_URL: 'https://app.test.integr8.example',
    },
  });
  owner = await api.member('owner', 'none-owner');
  token = await api.signIn(owner);

  // The harness's company is self-serve, on a trial that ran out a week ago:
  // what a company made before the switch to `none` can look like.
  await getPlatformDataSource().billing.start({
    tenantId: api.tenantId,
    provider: 'recording',
    plan: 'starter',
    trialEndsAt: new Date(Date.now() - 7 * DAY_MS),
  });
});

afterAll(async () => {
  // Dunning runs over every company in the shared test database, so the lapsed
  // trial made above must not be left for another suite's run to end.
  await getPlatformDataSource().billing.update(api.tenantId, {
    status: 'active',
    trialEndsAt: null,
  });
  await api.close();
});

describe('billing with no card provider', () => {
  it('shows every company as invoiced by Integr8, with no trial running out', async () => {
    const response = await api.call(token, { method: 'GET', url: '/v1/billing/subscription' });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as {
      billingMode: string;
      status: string;
      trialEndsAt: string | null;
    };
    expect(body).toMatchObject({ billingMode: 'invoiced', status: 'active', trialEndsAt: null });
  });

  it('refuses a card checkout and the card portal, saying Integr8 invoices the company', async () => {
    const checkout = await api.call(token, {
      method: 'POST',
      url: '/v1/billing/checkout',
      headers: { 'idempotency-key': randomUUID() },
      payload: { plan: 'starter' },
    });
    expect(checkout.statusCode).toBe(409);
    expect((JSON.parse(checkout.body) as { error: { code: string } }).error.code).toBe(
      'billing_invoiced',
    );

    const portal = await api.call(token, {
      method: 'POST',
      url: '/v1/billing/portal',
      headers: { 'idempotency-key': randomUUID() },
    });
    expect(portal.statusCode).toBe(409);
    expect((JSON.parse(portal.body) as { error: { code: string } }).error.code).toBe(
      'billing_invoiced',
    );

    const invoices = await api.call(token, { method: 'GET', url: '/v1/billing/invoices' });
    expect(JSON.parse(invoices.body)).toEqual({ items: [] });
  });

  it('believes no webhook', async () => {
    const response = await api.app.inject({
      method: 'POST',
      url: '/v1/billing/webhook',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=x' },
      payload: JSON.stringify({ id: 'evt_x', type: 'invoice.paid' }),
    });
    expect(response.statusCode).toBe(400);
  });

  it('ends no trial and makes nobody read-only', async () => {
    const report = await runDunning({
      config: api.config,
      logger: silent,
      workerId: 'test',
      force: true,
      now: new Date(Date.now() + 60 * DAY_MS),
    });
    expect(report).toMatchObject({ trialsEnded: 0, remindersPosted: 0, madeReadOnly: 0 });
    const tenant = await getPlatformDataSource().tenants.findById(api.tenantId);
    expect(tenant?.readOnlySince ?? null).toBeNull();
  });

  it('makes a new company invoiced, whatever the dashboard asked for', async () => {
    const admin = await api.platformAdmin('none-billing');
    const slug = `none-${randomUUID().slice(0, 8)}`;
    const created = await api.call(admin.accessToken, {
      method: 'POST',
      url: '/v1/platform/companies',
      payload: {
        slug,
        name: 'Cairo Cooling',
        plan: 'starter',
        seats: 10,
        billingMode: 'self_serve',
        ownerEmail: `owner@${slug}.example`,
      },
    });
    expect(created.statusCode).toBe(201);
    const company = (JSON.parse(created.body) as { company: { id: string } }).company;

    const tenant = await getPlatformDataSource().tenants.findById(company.id);
    expect(tenant?.billingMode).toBe('invoiced');
    const subscription = await getPlatformDataSource().billing.find(company.id);
    expect(subscription).toMatchObject({ status: 'active', trialEndsAt: null });
  });
});
