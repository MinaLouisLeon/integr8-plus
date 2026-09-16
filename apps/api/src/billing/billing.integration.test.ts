import { getPlatformDataSource, type PlanAllowance } from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../http/logger.js';
import { forgetTenantStatus } from '../http/suspension.js';
import { forgetAllowances } from '../media/quota.js';
import { type ApiHarness, type Member, startApi } from '../testing/api-harness.js';
import { runDunning } from './dunning.js';

/**
 * P17's exit criteria, as tests.
 *
 * Four claims, and the fourth is the one the whole phase exists for:
 *
 * 1. subscribing puts a company on a plan and its entitlements take effect;
 * 2. a webhook delivered twice changes nothing the second time;
 * 3. a failed payment carries a company through dunning to read-only **without
 *    losing any data** — it can still read everything it had;
 * 4. exceeding a plan limit is refused by the API, not by a screen.
 *
 * The harness runs on the recording billing provider, which treats a posted
 * body as an already-translated event. That is not a shortcut around the
 * signature: signature verification is Stripe-specific and is tested against
 * real signatures in `provider.test.ts`. What is tested here is everything that
 * happens *after* a delivery has been believed, which is the part that touches
 * a customer's data.
 */

let api: ApiHarness;
let owner: Member;
let token: string;

/**
 * What the plans allowed before this suite touched them.
 *
 * `plan_allowances` is one row per plan for the whole platform, so a test that
 * edits one edits it for every company in the shared test database. They go
 * back afterwards.
 */
let original: PlanAllowance[] = [];

const silent = createLogger({ level: 'error', write: () => undefined });

const DAY_MS = 24 * 60 * 60 * 1000;
const STARTER_PRICE = 'price_test_starter_monthly';

/**
 * Unique per run.
 *
 * A provider's subscription id belongs to one company — the table says so with
 * a unique constraint — and the test database is not emptied between runs, so
 * a fixed id would collide with the company the last run left behind.
 */
const RUN = randomUUID().slice(0, 8);
const CUSTOMER = `cus_test_${RUN}`;
const SUBSCRIPTION = `sub_test_${RUN}`;

beforeAll(async () => {
  // A return address, because a checkout has to send the browser back
  // somewhere. Without one the route answers 503 rather than inventing a URL.
  api = await startApi({ env: { BILLING_RETURN_URL: 'https://app.test.integr8.example' } });
  owner = await api.member('owner', 'billing-owner');
  token = await api.signIn(owner);
  original = await getPlatformDataSource().metering.allowances();

  await getPlatformDataSource().metering.setAllowance('starter', {
    providerPriceMonthly: STARTER_PRICE,
    seats: 5,
    submissionsPerMonth: 100,
    updatedBy: null,
  });
  forgetAllowances();
});

afterAll(async () => {
  const platform = getPlatformDataSource();
  for (const allowance of original) {
    await platform.metering.setAllowance(allowance.plan, {
      storageBytes: allowance.storageBytes,
      retentionDays: allowance.retentionDays,
      overage: allowance.overage,
      warnAtPercent: allowance.warnAtPercent,
      seats: allowance.seats,
      submissionsPerMonth: allowance.submissionsPerMonth,
      providerPriceMonthly: allowance.providerPriceMonthly,
      providerPriceYearly: allowance.providerPriceYearly,
      updatedBy: null,
    });
  }
  forgetAllowances();
  await api.close();
});

/**
 * Puts the company back on a paid, healthy subscription.
 *
 * Every test starts from the same place, because a suite where test three only
 * passes after test two has run is a suite that lies the first time somebody
 * runs one test on its own.
 */
beforeEach(async () => {
  const platform = getPlatformDataSource();
  await platform.billing.start({
    tenantId: api.tenantId,
    provider: 'recording',
    plan: 'trial',
    trialEndsAt: null,
  });
  await platform.billing.update(api.tenantId, {
    providerCustomerId: CUSTOMER,
    providerSubscriptionId: SUBSCRIPTION,
    status: 'active',
    plan: 'starter',
    trialEndsAt: null,
    pastDueSince: null,
    graceEndsAt: null,
    remindersSent: 0,
  });
  await platform.tenants.setPlan(api.tenantId, { plan: 'starter' });
  await platform.tenants.setReadOnly(api.tenantId, null);
  forgetTenantStatus(api.tenantId);
  forgetAllowances();
});

/** Posts a translated event at the webhook, as the provider would deliver it. */
async function deliver(event: {
  id: string;
  type: string;
  event: Record<string, unknown>;
}): Promise<{ received: boolean; duplicate: boolean; handled: boolean }> {
  const response = await api.app.inject({
    method: 'POST',
    url: '/v1/billing/webhook',
    remoteAddress: api.remoteAddress,
    headers: {
      'x-client-version': '1.0.0',
      'x-client-app': 'web',
      'content-type': 'application/json',
    },
    payload: JSON.stringify(event),
  });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as { received: boolean; duplicate: boolean; handled: boolean };
}

function subscriptionChanged(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    type: 'customer.subscription.updated',
    event: {
      kind: 'subscription_changed',
      customerId: CUSTOMER,
      subscriptionId: SUBSCRIPTION,
      status: 'active',
      priceId: STARTER_PRICE,
      interval: 'month',
      currentPeriodStart: new Date(Date.now() - DAY_MS).toISOString(),
      currentPeriodEnd: new Date(Date.now() + 30 * DAY_MS).toISOString(),
      cancelAtPeriodEnd: false,
      ...overrides,
    },
  };
}

async function subscription(): Promise<Record<string, unknown>> {
  const response = await api.call(token, { method: 'GET', url: '/v1/billing/subscription' });
  expect(response.statusCode).toBe(200);
  return JSON.parse(response.body) as Record<string, unknown>;
}

describe('subscribing', () => {
  it('sends the company to the provider with the price and the seat count', async () => {
    const response = await api.call(token, {
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { plan: 'starter', interval: 'month' },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body) as { url: string; provider: string };
    expect(body.url).toContain('/checkout/');

    // The provider is asked for the price we hold for that plan, not one the
    // client named: a client that could choose the price could choose the bill.
    const recorded = api.services.billing as unknown as {
      checkouts: { priceId: string; quantity: number; tenantId: string }[];
    };
    const last = recorded.checkouts.at(-1);
    expect(last?.priceId).toBe(STARTER_PRICE);
    expect(last?.tenantId).toBe(api.tenantId);
    expect(last?.quantity).toBeGreaterThanOrEqual(1);
  });

  it('refuses a plan nobody has priced, rather than sending somebody to a broken checkout', async () => {
    await getPlatformDataSource().metering.setAllowance('enterprise', {
      providerPriceMonthly: null,
      updatedBy: null,
    });
    forgetAllowances();

    const response = await api.call(token, {
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { plan: 'enterprise', interval: 'month' },
    });

    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe(
      'plan_not_purchasable',
    );
  });

  it('applies the plan and its entitlements when the provider confirms', async () => {
    await getPlatformDataSource().tenants.setPlan(api.tenantId, { plan: 'trial' });
    forgetTenantStatus(api.tenantId);

    const outcome = await deliver(subscriptionChanged(`evt_sub_${String(Date.now())}`));
    expect(outcome.handled).toBe(true);

    const body = await subscription();
    expect(body.plan).toBe('starter');
    expect(body.status).toBe('active');
    // The limits the API enforces, on the screen that warns about them: the
    // same numbers, from the same row, so a warning cannot disagree with a
    // refusal.
    expect(body.entitlements).toMatchObject({ seats: 5, submissionsPerMonth: 100 });
  });
});

describe('a delivery from a stranger', () => {
  it('is accepted without any of the headers our own clients send', async () => {
    // Stripe sends `stripe-signature` and a JSON body. It does not send
    // `x-client-app`, and it has never heard of our minimum client version —
    // so the version gate has to let the webhook path through, or every real
    // delivery would be refused with "update your app".
    const response = await api.app.inject({
      method: 'POST',
      url: '/v1/billing/webhook',
      remoteAddress: api.remoteAddress,
      headers: { 'content-type': 'application/json', 'stripe-signature': 'ignored-by-the-fake' },
      payload: JSON.stringify({
        id: `evt_bare_${String(Date.now())}`,
        type: 'customer.subscription.updated',
        event: { kind: 'ignored' },
      }),
    });

    expect(response.statusCode, response.body).toBe(200);
  });
});

describe('a delivery that arrives twice', () => {
  it('changes nothing the second time', async () => {
    const id = `evt_dupe_${String(Date.now())}`;

    const first = await deliver(subscriptionChanged(id));
    expect(first).toMatchObject({ duplicate: false, handled: true });

    // Not a different event with the same meaning — the same delivery again,
    // which is what a provider's retry is.
    const second = await deliver(subscriptionChanged(id, { status: 'canceled' }));
    expect(second).toMatchObject({ duplicate: true, handled: false });

    // The `canceled` in the retry was ignored along with the rest of it. Had it
    // been applied, this company would now be read-only because a delivery was
    // retried.
    const body = await subscription();
    expect(body.status).toBe('active');
    expect(body.readOnly).toBe(false);

    // And it was stored once, which is what made the second one a no-op.
    const stored = (await getPlatformDataSource().billing.recentEvents(200)).filter(
      (event) => event.providerEventId === id,
    );
    expect(stored).toHaveLength(1);
  });
});

describe('a payment that fails', () => {
  it('moves the company through dunning to read-only, and loses nothing', async () => {
    const platform = getPlatformDataSource();

    // Something of the company's to lose, made while everything was fine.
    const created = await api.call(token, {
      method: 'POST',
      url: '/v1/job-types',
      payload: { name: 'Before the trouble', code: `PAID${String(Date.now()).slice(-6)}` },
    });
    expect(created.statusCode).toBe(201);
    const jobTypeId = (JSON.parse(created.body) as { id: string }).id;

    // 1. The charge fails. The grace period starts, and writes still work.
    await deliver({
      id: `evt_failed_${String(Date.now())}`,
      type: 'invoice.payment_failed',
      event: { kind: 'payment_failed', customerId: CUSTOMER, subscriptionId: SUBSCRIPTION },
    });

    let state = await subscription();
    expect(state.status).toBe('past_due');
    expect(state.readOnly).toBe(false);
    expect(state.graceEndsAt).not.toBeNull();

    // 2. A reminder, partway through the grace. In-app only — see dunning.ts.
    const reminded = await runDunning({
      config: api.config,
      logger: silent,
      workerId: 'test',
      force: true,
      now: new Date(Date.now() + 4 * DAY_MS),
    });
    expect(reminded.remindersPosted).toBeGreaterThanOrEqual(1);
    expect(reminded.madeReadOnly).toBe(0);

    const banners = await platform.settings.announcementsFor(api.tenantId);
    expect(banners.some((banner) => (banner.message.en ?? '').includes('read-only'))).toBe(true);

    // 3. The grace runs out.
    const stopped = await runDunning({
      config: api.config,
      logger: silent,
      workerId: 'test',
      force: true,
      now: new Date(Date.now() + (api.config.BILLING_GRACE_DAYS + 1) * DAY_MS),
    });
    expect(stopped.madeReadOnly).toBe(1);

    // Writes are refused — with 402, which says what is actually missing.
    const refused = await api.call(token, {
      method: 'POST',
      url: '/v1/job-types',
      payload: { name: 'After the trouble', code: `LATE${String(Date.now()).slice(-6)}` },
    });
    expect(refused.statusCode).toBe(402);
    expect((JSON.parse(refused.body) as { error: { code: string } }).error.code).toBe(
      'tenant_read_only',
    );

    // Nothing has been deleted. This is the criterion: reads still work, and
    // what the company had is still there.
    const stillThere = await api.call(token, { method: 'GET', url: '/v1/job-types' });
    expect(stillThere.statusCode).toBe(200);
    expect(stillThere.body).toContain(jobTypeId);

    // And paying is still possible, which is the point of read-only rather
    // than suspension: a company that cannot reach the checkout cannot fix it.
    const checkout = await api.call(token, {
      method: 'POST',
      url: '/v1/billing/checkout',
      payload: { plan: 'starter', interval: 'month' },
    });
    expect(checkout.statusCode).toBe(200);

    // 4. They pay. Writing comes back without anybody touching the database.
    await deliver({
      id: `evt_paid_${String(Date.now())}`,
      type: 'invoice.payment_succeeded',
      event: { kind: 'payment_succeeded', customerId: CUSTOMER, subscriptionId: SUBSCRIPTION },
    });

    state = await subscription();
    expect(state.status).toBe('active');
    expect(state.readOnly).toBe(false);

    const allowed = await api.call(token, {
      method: 'POST',
      url: '/v1/job-types',
      payload: { name: 'After paying', code: `OKAY${String(Date.now()).slice(-6)}` },
    });
    expect(allowed.statusCode).toBe(201);
  });

  it('ends a trial into the same grace period rather than straight into read-only', async () => {
    const platform = getPlatformDataSource();
    await platform.billing.update(api.tenantId, {
      status: 'trialing',
      trialEndsAt: new Date(Date.now() - DAY_MS),
      pastDueSince: null,
      graceEndsAt: null,
    });

    const report = await runDunning({
      config: api.config,
      logger: silent,
      workerId: 'test',
      force: true,
    });
    expect(report.trialsEnded).toBe(1);

    const state = await subscription();
    expect(state.status).toBe('past_due');
    // Still writable: a trial that ends is given the same fortnight a failed
    // card is given.
    expect(state.readOnly).toBe(false);
    expect(state.graceEndsAt).not.toBeNull();
  });
});

describe('plan limits', () => {
  it('refuses an invitation when every seat is taken', async () => {
    const platform = getPlatformDataSource();
    const used = (await subscription()).usage as { seatsUsed: number };

    await platform.metering.setAllowance('starter', {
      seats: used.seatsUsed,
      updatedBy: null,
    });
    forgetAllowances();

    const refused = await api.call(token, {
      method: 'POST',
      url: '/v1/members/invitations',
      payload: { email: `no-seat-${String(Date.now())}@test.integr8.example`, role: 'engineer' },
    });

    expect(refused.statusCode).toBe(409);
    const body = JSON.parse(refused.body) as {
      error: { code: string; details?: { params?: Record<string, string> }[] };
    };
    expect(body.error.code).toBe('seat_limit_reached');
    // The numbers are in the refusal, so a screen can say "5 of 5" rather than
    // "something went wrong".
    expect(body.error.details?.[0]?.params).toMatchObject({
      seats: String(used.seatsUsed),
    });

    await platform.metering.setAllowance('starter', { seats: 5, updatedBy: null });
    forgetAllowances();
  });

  it('refuses a submission once the month’s allowance is spent', async () => {
    const platform = getPlatformDataSource();

    // One submission actually made, and a plan that allows exactly one. The
    // constraint on `plan_allowances` refuses a plan of zero, which is right:
    // a plan nobody can submit anything on is not a plan.
    const formId = await publishedForm();
    const draft = await api.call(token, {
      method: 'POST',
      url: '/v1/submissions',
      payload: { formId },
    });
    expect(draft.statusCode, draft.body).toBe(201);
    const started = JSON.parse(draft.body) as { submission: { id: string; revision: number } };

    const submitted = await api.call(token, {
      method: 'POST',
      url: `/v1/submissions/${started.submission.id}/submit`,
      payload: { answers: {}, expectedRevision: started.submission.revision },
    });
    expect(submitted.statusCode, submitted.body).toBe(200);

    await platform.metering.setAllowance('starter', {
      submissionsPerMonth: 1,
      updatedBy: null,
    });
    forgetAllowances();

    // Refused before the form is even opened, so nobody fills in a form they
    // are not allowed to submit. This is the request a client cannot talk its
    // way out of: there is no UI in it at all.
    const refused = await api.call(token, {
      method: 'POST',
      url: '/v1/submissions',
      payload: { formId },
    });

    expect(refused.statusCode, refused.body).toBe(409);
    const body = JSON.parse(refused.body) as {
      error: { code: string; details?: { params?: Record<string, string> }[] };
    };
    expect(body.error.code).toBe('submission_limit_reached');
    expect(body.error.details?.[0]?.params).toMatchObject({ submissionsPerMonth: '1' });

    await platform.metering.setAllowance('starter', {
      submissionsPerMonth: 100,
      updatedBy: null,
    });
    forgetAllowances();
  });
});

/**
 * A form with one optional question, published, so a submission can be made.
 *
 * Deliberately the emptiest form the engine will accept: this suite is about
 * how many submissions a plan allows, not about what is in them.
 */
async function publishedForm(): Promise<string> {
  const created = await api.call(token, {
    method: 'POST',
    url: '/v1/forms',
    payload: { title: `Billing limit ${RUN}` },
  });
  expect(created.statusCode, created.body).toBe(201);
  const formId = (JSON.parse(created.body) as { form: { id: string } }).form.id;

  const detail = JSON.parse(
    (await api.call(token, { method: 'GET', url: `/v1/forms/${formId}` })).body,
  ) as { draft: { revision: number } | null };

  const saved = await api.call(token, {
    method: 'PUT',
    url: `/v1/forms/${formId}/draft`,
    payload: {
      definition: {
        schemaVersion: 1,
        title: { en: 'Billing limit' },
        pages: [
          {
            id: 'page_1',
            sections: [
              {
                id: 'section_1',
                fields: [{ id: 'note', type: 'text', label: { en: 'Anything to add?' } }],
              },
            ],
          },
        ],
      },
      expectedRevision: detail.draft?.revision ?? null,
    },
  });
  expect(saved.statusCode, saved.body).toBe(200);

  const published = await api.call(token, {
    method: 'POST',
    url: `/v1/forms/${formId}/draft/publish`,
    payload: {
      expectedRevision: (JSON.parse(saved.body) as { revision: number }).revision,
      acknowledgeBreakingChanges: false,
    },
  });
  expect(published.statusCode, published.body).toBe(200);

  return formId;
}
