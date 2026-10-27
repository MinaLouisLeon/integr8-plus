import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '../../http/logger.js';
import { runDeadlineAlerts, runMaintenancePlans } from '../../maintenance/tasks.js';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Maintenance plans, contracts and deadlines over HTTP (P27), against a real
 * database.
 *
 * What the office relies on: a contract marks new jobs covered or chargeable
 * and an override lands in the job's history; a plan's job is made once,
 * ahead of its due date, unplanned and covered by its contract; a priority's
 * rule gives a job its deadlines, and a missed one is recorded and reported.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let dispatcher: Member;
let viewer: Member;
const tokens = new Map<Member, string>();
let customerId: string;
let siteId: string;
let otherSiteId: string;
let jobTypeId: string;

const logger = createLogger({ level: 'error', write: () => undefined });

interface ErrorBody {
  error: { code: string };
}

interface Summary {
  id: string;
  coverage: { status: string; reason: string; contract: { id: string } | null } | null;
  deadline: { kind: string; state: string } | null;
  maintenance: boolean;
}

interface Detail {
  workOrder: Summary & { revision: number };
  coverage: { status: string; reason: string; overrideReason: string | null } | null;
  deadlines: { response: { state: string } | null; completion: { state: string } | null } | null;
  maintenancePlans: { planId: string }[];
  events: { kind: string }[];
}

async function token(who: Member): Promise<string> {
  let value = tokens.get(who);
  if (value === undefined) {
    value = await api.signIn(who);
    tokens.set(who, value);
  }
  return value;
}

async function call<T>(
  who: Member,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: unknown,
  expected = 200,
): Promise<T> {
  const response = await api.call(await token(who), {
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    headers: { 'idempotency-key': randomUUID() },
  });
  expect(response.statusCode, `${method} ${url}: ${response.body}`).toBe(expected);
  return (response.body === '' ? undefined : JSON.parse(response.body)) as T;
}

const today = () => new Date().toISOString().slice(0, 10);
const daysFromToday = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

const job = (body: Record<string, unknown> = {}) =>
  call<Detail>(
    dispatcher,
    'POST',
    '/v1/work-orders',
    { customerId, siteId, jobTypeId, ...body },
    201,
  );

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin('p27-staff');
  owner = await api.member('owner', 'owner');
  dispatcher = await api.member('dispatcher', 'dispatcher');
  viewer = await api.member('viewer', 'viewer');
  const staffToken = await api.staff(owner);
  jobTypeId = (
    await (async () => {
      const response = await api.call(staffToken, {
        method: 'POST',
        url: '/v1/job-types',
        payload: { name: 'AC service', code: 'acs', expectedDurationMinutes: 60 },
      });
      expect(response.statusCode, response.body).toBe(201);
      return JSON.parse(response.body) as { id: string };
    })()
  ).id;
  customerId = (
    await call<{ id: string }>(dispatcher, 'POST', '/v1/customers', { name: 'Riverside' }, 201)
  ).id;
  siteId = (
    await call<{ id: string }>(
      dispatcher,
      'POST',
      `/v1/customers/${customerId}/sites`,
      { name: 'Block A', address: { line1: '1 River Road', city: 'Leeds', countryCode: 'GB' } },
      201,
    )
  ).id;
  otherSiteId = (
    await call<{ id: string }>(
      dispatcher,
      'POST',
      `/v1/customers/${customerId}/sites`,
      { name: 'Block B', address: { line1: '2 River Road', city: 'Leeds', countryCode: 'GB' } },
      201,
    )
  ).id;
});

afterAll(async () => {
  await api.close();
});

describe('contracts', () => {
  let contractId: string;

  it('lets dispatchers keep them and viewers only read them', async () => {
    const created = await call<{ id: string; reference: string; standing: string }>(
      dispatcher,
      'POST',
      '/v1/contracts',
      {
        customerId,
        title: 'Annual AC care',
        startsOn: daysFromToday(-10),
        endsOn: daysFromToday(355),
        siteIds: [siteId],
        includedCallouts: 1,
      },
      201,
    );
    contractId = created.id;
    expect(created.reference).toMatch(/^CT-\d{6}$/u);
    expect(created.standing).toBe('active');
    const listed = await call<{ items: { id: string }[]; can: { manage: boolean } }>(
      viewer,
      'GET',
      `/v1/contracts?customerId=${customerId}`,
    );
    expect(listed.items.map((item) => item.id)).toContain(contractId);
    expect(listed.can.manage).toBe(false);
    const refused = await call<ErrorBody>(
      viewer,
      'POST',
      '/v1/contracts',
      { customerId, title: 'Nope', startsOn: today(), endsOn: today() },
      403,
    );
    expect(refused.error.code).toBeDefined();
  });

  it('marks new jobs covered, and says why one is chargeable', async () => {
    const covered = await job();
    expect(covered.coverage).toMatchObject({ status: 'covered', reason: 'contract' });
    expect(covered.workOrder.coverage?.contract?.id).toBe(contractId);

    const elsewhere = await job({ siteId: otherSiteId });
    expect(elsewhere.coverage).toMatchObject({ status: 'chargeable', reason: 'site_not_covered' });

    // One call-out a year is included, and it was used by the first job.
    const second = await job();
    expect(second.coverage).toMatchObject({ status: 'chargeable', reason: 'callouts_used' });
  });

  it('records an override in the job’s history', async () => {
    const chargeable = await job({ siteId: otherSiteId });
    const coverage = await call<{ status: string; reason: string }>(
      dispatcher,
      'PUT',
      `/v1/work-orders/${chargeable.workOrder.id}/coverage`,
      { status: 'covered', contractId, reason: 'Goodwill after the last visit' },
    );
    expect(coverage).toMatchObject({ status: 'covered', reason: 'override' });
    const detail = await call<Detail>(
      dispatcher,
      'GET',
      `/v1/work-orders/${chargeable.workOrder.id}`,
    );
    expect(detail.events.map((event) => event.kind)).toContain('coverage_changed');
  });

  it('renews once, into a contract that names the old one', async () => {
    const current = await call<{ contract: { version: number } }>(
      dispatcher,
      'GET',
      `/v1/contracts/${contractId}`,
    );
    const renewed = await call<{ renewedFrom: { id: string } | null }>(
      dispatcher,
      'POST',
      `/v1/contracts/${contractId}/renew`,
      { expectedVersion: current.contract.version },
      201,
    );
    expect(renewed.renewedFrom?.id).toBe(contractId);
    const again = await call<ErrorBody>(
      dispatcher,
      'POST',
      `/v1/contracts/${contractId}/renew`,
      { expectedVersion: current.contract.version },
      409,
    );
    expect(['contract_already_renewed', 'contract_changed']).toContain(again.error.code);
  });
});

describe('deadlines', () => {
  it('gives a job its priority’s deadlines and records a miss in its history and the report', async () => {
    await call(owner, 'PUT', '/v1/deadline-rules', {
      rules: [
        {
          priority: 'urgent',
          responseMinutes: 1,
          completionMinutes: 2,
          clock: 'always',
          warnMinutes: 0,
        },
      ],
    });
    const urgent = await job({ priority: 'urgent', siteId: otherSiteId });
    expect(urgent.deadlines?.response?.state).toBe('running');

    // Two minutes later, as far as the worker is concerned.
    const report = await runDeadlineAlerts({
      config: api.config,
      logger,
      workerId: 'test',
      email: api.services.email,
      now: new Date(Date.now() + 3 * 60_000),
      force: true,
    });
    expect(report.failures).toEqual([]);
    expect(report.missed).toBeGreaterThanOrEqual(1);

    const detail = await call<Detail>(dispatcher, 'GET', `/v1/work-orders/${urgent.workOrder.id}`);
    expect(detail.events.some((event) => event.kind === 'deadline_missed')).toBe(true);

    const yearly = await call<{ misses: { workOrder: { id: string } }[] }>(
      dispatcher,
      'GET',
      '/v1/deadline-report',
    );
    expect(yearly.misses.map((miss) => miss.workOrder.id)).toContain(urgent.workOrder.id);
  });

  it('lets only owners and admins set the rules', async () => {
    await call(dispatcher, 'PUT', '/v1/deadline-rules', { rules: [] }, 403);
  });
});

describe('maintenance plans', () => {
  let assetId: string;

  beforeAll(async () => {
    const response = await api.call(admin.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/flags/assets`,
      payload: { enabled: true },
    });
    expect(response.statusCode, response.body).toBe(200);
    assetId = (
      await call<{ id: string }>(
        dispatcher,
        'POST',
        '/v1/assets',
        { name: 'Rooftop AC', siteId },
        201,
      )
    ).id;
  });

  it('makes a plan’s job once, ahead of its due date, unplanned and linked to the asset', async () => {
    const plan = await call<{ id: string; nextDueOn: string; upcoming: string[] }>(
      dispatcher,
      'POST',
      '/v1/maintenance-plans',
      {
        assetId,
        jobTypeId,
        title: 'Quarterly AC service',
        intervalCount: 3,
        intervalUnit: 'month',
        counting: 'calendar',
        startsOn: daysFromToday(10),
        leadDays: 30,
      },
      201,
    );
    expect(plan.nextDueOn).toBe(daysFromToday(10));
    expect(plan.upcoming.length).toBeGreaterThan(1);

    const first = await runMaintenancePlans({
      config: api.config,
      logger,
      workerId: 'test',
      force: true,
    });
    expect(first.failures).toEqual([]);
    expect(first.jobsCreated).toBe(1);
    const second = await runMaintenancePlans({
      config: api.config,
      logger,
      workerId: 'test',
      force: true,
    });
    expect(second.jobsCreated).toBe(0);

    const listed = await call<{ items: { standing: string; workOrder: { id: string } | null }[] }>(
      dispatcher,
      'GET',
      `/v1/maintenance?assetId=${assetId}`,
    );
    const made = listed.items.find((item) => item.workOrder !== null);
    expect(made?.standing).toBe('created');
    const detail = await call<Detail>(dispatcher, 'GET', `/v1/work-orders/${made!.workOrder!.id}`);
    expect(detail.maintenancePlans.map((entry) => entry.planId)).toEqual([plan.id]);
    expect(detail.workOrder.maintenance).toBe(true);
    // A planned job has its due window, not a response deadline.
    expect(detail.deadlines).toBeNull();
    expect(detail.events.map((event) => event.kind)).toContain('maintenance_planned');
  });

  it('refuses a plan for a contract of another customer', async () => {
    const other = await call<{ id: string }>(
      dispatcher,
      'POST',
      '/v1/customers',
      { name: 'Elsewhere' },
      201,
    );
    const theirs = await call<{ id: string }>(
      dispatcher,
      'POST',
      '/v1/contracts',
      { customerId: other.id, title: 'Theirs', startsOn: today(), endsOn: daysFromToday(30) },
      201,
    );
    const refused = await call<ErrorBody>(
      dispatcher,
      'POST',
      '/v1/maintenance-plans',
      {
        assetId,
        jobTypeId,
        contractId: theirs.id,
        title: 'Wrong contract',
        intervalCount: 1,
        intervalUnit: 'year',
        counting: 'calendar',
        startsOn: daysFromToday(100),
      },
      422,
    );
    expect(refused.error.code).toBe('contract_not_customers');
  });
});
