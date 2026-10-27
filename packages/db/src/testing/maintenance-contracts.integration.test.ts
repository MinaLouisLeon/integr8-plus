import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../connection.js';
import type { ServiceContract, ServiceContractWrite } from '../repositories/contracts.js';
import {
  asTenant,
  connectAsApp,
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
} from './harness.js';

/**
 * Maintenance plans, contracts and deadlines (migration 0053), against a real
 * database.
 *
 * What holds for every client is proven here: contracts are numbered and keep
 * their customer, a cancelled contract is final, a new job is given its
 * coverage and its deadlines, a job's own state changes meet them, a deadline
 * met late or passed unmet is recorded once and written into the job's
 * history, an occurrence is unique per plan and date and append-only, and the
 * worker's bookkeeping does not bump a record's version.
 */

const MANAGER = '00000000-0000-4000-8000-00000000d401';
const AHMED = '00000000-0000-4000-8000-00000000e401';

let northwind: TenantFixture;
let owner: pg.Client;
let app: pg.Client;
let customerId: string;
let siteId: string;
let otherSiteId: string;
let jobTypeId: string;
let assetId: string;

const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(northwind.id, fn);

function contractOf(result: ServiceContractWrite): ServiceContract {
  if (result.outcome !== 'written') {
    throw new Error(`expected a written contract, got ${result.outcome}`);
  }
  return result.contract;
}

const today = () => new Date().toISOString().slice(0, 10);
const daysFromToday = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  northwind = await createTenant('northwind');
  owner = await connectAsOwner();
  app = await connectAsApp();

  await inTenant(async (tx) => {
    for (const userId of [MANAGER, AHMED]) {
      await tx.tenantUsers.create({
        userId,
        email: `${userId.slice(-4)}@${northwind.slug}.example`,
        displayName: userId.slice(-4),
        role: userId === MANAGER ? 'admin' : 'engineer',
      });
    }
    customerId = (await tx.customers.create({ name: 'Riverside Housing' }, MANAGER)).id;
    siteId = (
      await tx.sites.create(
        customerId,
        { name: 'Block A', address: { line1: '1 River Road', city: 'Leeds', countryCode: 'gb' } },
        MANAGER,
      )
    ).id;
    otherSiteId = (
      await tx.sites.create(
        customerId,
        { name: 'Block B', address: { line1: '2 River Road', city: 'Leeds', countryCode: 'gb' } },
        MANAGER,
      )
    ).id;
    jobTypeId = (await tx.jobTypes.create({ name: 'AC service', code: 'acs' }, MANAGER)).id;
    const registered = await tx.assets.register(
      { name: 'Rooftop AC unit', customerId, siteId, tagCode: 'TAG-P27-0001' },
      MANAGER,
    );
    if (registered === 'serial_taken') {
      throw new Error('unexpected serial clash');
    }
    assetId = registered.asset.id;
  });
});

afterAll(async () => {
  await owner.end();
  await app.end();
  await releaseTestDatabase();
});

describe('contracts', () => {
  it('numbers contracts and keeps their customer', async () => {
    const contract = await inTenant(async (tx) =>
      contractOf(
        await tx.contracts.create(
          { customerId, title: 'Annual AC care', startsOn: '2020-01-01', endsOn: '2020-12-31' },
          MANAGER,
        ),
      ),
    );
    expect(contract.reference).toBeGreaterThan(0);
    const other = await inTenant((tx) => tx.customers.create({ name: 'Elsewhere Ltd' }, MANAGER));
    await expect(
      asTenant(app, northwind.id, () =>
        app.query('update service_contracts set customer_id = $1 where id = $2', [
          other.id,
          contract.id,
        ]),
      ),
    ).rejects.toThrow(/keeps its number, customer/u);
  });

  it('refuses a covered site that is not the customer’s', async () => {
    const other = await inTenant((tx) =>
      tx.customers.create({ name: 'Another Customer' }, MANAGER),
    );
    const result = await inTenant((tx) =>
      tx.contracts.create(
        {
          customerId: other.id,
          title: 'Wrong site',
          startsOn: '2026-01-01',
          endsOn: '2026-12-31',
          siteIds: [siteId],
        },
        MANAGER,
      ),
    );
    expect(result.outcome).toBe('site_not_customers');
  });

  it('keeps a cancelled contract as it was', async () => {
    const contract = await inTenant(async (tx) =>
      contractOf(
        await tx.contracts.create(
          { customerId, title: 'Short trial', startsOn: '2021-01-01', endsOn: '2021-03-31' },
          MANAGER,
        ),
      ),
    );
    const cancelled = await inTenant((tx) =>
      tx.contracts.cancel(
        contract.id,
        contract.version,
        { cancelledOn: '2021-02-01', reason: 'Sold the building' },
        MANAGER,
      ),
    );
    expect(cancelled.outcome).toBe('written');
    await expect(
      asTenant(app, northwind.id, () =>
        app.query(`update service_contracts set title = 'x' where id = $1`, [contract.id]),
      ),
    ).rejects.toThrow(/was cancelled/u);
  });

  it('does not count a renewal reminder as an edit', async () => {
    const contract = await inTenant(async (tx) =>
      contractOf(
        await tx.contracts.create(
          {
            customerId,
            title: 'Ending soon',
            startsOn: daysFromToday(-300),
            endsOn: daysFromToday(20),
          },
          MANAGER,
        ),
      ),
    );
    const due = await inTenant((tx) => tx.contracts.dueRenewalAlerts(today()));
    expect(due.map((alert) => alert.contract.id)).toContain(contract.id);
    await inTenant((tx) => tx.contracts.markRenewalAlerted(contract.id, 'notice'));
    const after = await inTenant((tx) => tx.contracts.find(contract.id));
    expect(after?.version).toBe(contract.version);
    const again = await inTenant((tx) => tx.contracts.dueRenewalAlerts(today()));
    expect(again.map((alert) => alert.contract.id)).not.toContain(contract.id);
  });

  it('renews into a new contract that names the old one, once', async () => {
    const contract = await inTenant(async (tx) =>
      contractOf(
        await tx.contracts.create(
          {
            customerId,
            title: 'Renew me',
            startsOn: '2022-01-01',
            endsOn: '2022-12-31',
            siteIds: [siteId],
          },
          MANAGER,
        ),
      ),
    );
    const renewed = await inTenant(async (tx) =>
      contractOf(
        await tx.contracts.renew(
          contract.id,
          contract.version,
          { startsOn: '2023-01-01', endsOn: '2023-12-31' },
          MANAGER,
        ),
      ),
    );
    expect(renewed.renewedFromId).toBe(contract.id);
    expect(renewed.siteIds).toEqual([siteId]);
    const twice = await inTenant(async (tx) => {
      const latest = (await tx.contracts.find(contract.id))!;
      return tx.contracts.renew(
        contract.id,
        latest.version,
        { startsOn: '2023-01-01', endsOn: '2023-12-31' },
        MANAGER,
      );
    });
    expect(twice.outcome).toBe('already_renewed');
  });
});

describe('coverage of a new job', () => {
  it('covers a job at a covered site, and says why one elsewhere is chargeable', async () => {
    const contract = await inTenant(async (tx) =>
      contractOf(
        await tx.contracts.create(
          {
            customerId,
            title: 'Block A only',
            startsOn: daysFromToday(-30),
            endsOn: daysFromToday(300),
            siteIds: [siteId],
          },
          MANAGER,
        ),
      ),
    );
    const [inside, outside] = await inTenant(async (tx) => {
      const a = await tx.workOrders.create({ customerId, siteId, jobTypeId }, MANAGER);
      const b = await tx.workOrders.create({ customerId, siteId: otherSiteId, jobTypeId }, MANAGER);
      const coverage = await tx.contracts.coverageOf([a.id, b.id]);
      return [coverage.get(a.id), coverage.get(b.id)];
    });
    expect(inside).toMatchObject({
      status: 'covered',
      reason: 'contract',
      contractId: contract.id,
    });
    expect(outside).toMatchObject({ status: 'chargeable', reason: 'site_not_covered' });
  });

  it('records an override in the job’s history', async () => {
    const job = await inTenant((tx) =>
      tx.workOrders.create({ customerId, siteId: otherSiteId, jobTypeId }, MANAGER),
    );
    await inTenant((tx) =>
      tx.contracts.overrideCoverage(
        job.id,
        { status: 'covered', contractId: null, reason: 'Goodwill' },
        MANAGER,
      ),
    );
    const events = await inTenant((tx) => tx.workOrders.listEvents(job.id));
    expect(events.map((event) => event.kind)).toContain('coverage_changed');
  });
});

describe('deadlines', () => {
  it('meets the response deadline when the job is dispatched', async () => {
    const job = await inTenant(async (tx) => {
      await tx.deadlines.replaceRules(
        [
          {
            priority: 'urgent',
            responseMinutes: 120,
            completionMinutes: 480,
            clock: 'always',
            warnMinutes: 30,
          },
        ],
        MANAGER,
      );
      return tx.workOrders.create(
        {
          customerId,
          siteId,
          jobTypeId,
          priority: 'urgent',
          crew: [{ userId: AHMED, lead: true }],
        },
        MANAGER,
      );
    });
    const before = (await inTenant((tx) => tx.deadlines.ofJobs([job.id]))).get(job.id);
    expect(before?.responseDueAt).not.toBeNull();
    const dispatched = await inTenant((tx) =>
      tx.workOrders.transition(job.id, job.revision, 'dispatched', MANAGER),
    );
    expect(dispatched.outcome).toBe('written');
    const after = (await inTenant((tx) => tx.deadlines.ofJobs([job.id]))).get(job.id);
    expect(after?.respondedAt).not.toBeNull();
    expect(after?.responseMissedAt).toBeNull();
  });

  it('records a deadline that passed unmet once, in the job’s history', async () => {
    const job = await inTenant((tx) =>
      tx.workOrders.create({ customerId, siteId, jobTypeId, priority: 'urgent' }, MANAGER),
    );
    // Put the deadline in the past, as if two hours went by.
    await asTenant(owner, northwind.id, () =>
      owner.query(
        `update work_order_deadlines set response_due_at = now() - interval '1 minute' where work_order_id = $1`,
        [job.id],
      ),
    );
    const first = await inTenant((tx) => tx.deadlines.recordMisses(new Date()));
    expect(first.map((notice) => notice.workOrderId)).toContain(job.id);
    const second = await inTenant((tx) => tx.deadlines.recordMisses(new Date()));
    expect(second.map((notice) => notice.workOrderId)).not.toContain(job.id);
    const events = await inTenant((tx) => tx.workOrders.listEvents(job.id));
    expect(events.filter((event) => event.kind === 'deadline_missed')).toHaveLength(1);

    // A recorded miss is never cleared.
    await asTenant(app, northwind.id, () =>
      app.query(
        'update work_order_deadlines set response_missed_at = null where work_order_id = $1',
        [job.id],
      ),
    );
    const kept = (await inTenant((tx) => tx.deadlines.ofJobs([job.id]))).get(job.id);
    expect(kept?.responseMissedAt).not.toBeNull();
  });

  it('records a deadline met late as missed', async () => {
    const job = await inTenant((tx) =>
      tx.workOrders.create(
        {
          customerId,
          siteId,
          jobTypeId,
          priority: 'urgent',
          crew: [{ userId: AHMED, lead: true }],
        },
        MANAGER,
      ),
    );
    await asTenant(owner, northwind.id, () =>
      owner.query(
        `update work_order_deadlines set response_due_at = now() - interval '1 minute' where work_order_id = $1`,
        [job.id],
      ),
    );
    await inTenant((tx) => tx.workOrders.transition(job.id, job.revision, 'dispatched', MANAGER));
    const deadline = (await inTenant((tx) => tx.deadlines.ofJobs([job.id]))).get(job.id);
    expect(deadline?.responseMissedAt).not.toBeNull();
  });

  it('closes a cancelled job’s deadlines without a miss', async () => {
    const job = await inTenant((tx) =>
      tx.workOrders.create({ customerId, siteId, jobTypeId, priority: 'urgent' }, MANAGER),
    );
    await inTenant((tx) =>
      tx.workOrders.transition(job.id, job.revision, 'cancelled', MANAGER, 'Duplicate'),
    );
    await asTenant(owner, northwind.id, () =>
      owner.query(
        `update work_order_deadlines set response_due_at = now() - interval '1 minute' where work_order_id = $1`,
        [job.id],
      ),
    );
    const misses = await inTenant((tx) => tx.deadlines.recordMisses(new Date()));
    expect(misses.map((notice) => notice.workOrderId)).not.toContain(job.id);
  });

  it('gives no deadline to a priority without a rule', async () => {
    const job = await inTenant((tx) =>
      tx.workOrders.create({ customerId, siteId, jobTypeId, priority: 'low' }, MANAGER),
    );
    expect((await inTenant((tx) => tx.deadlines.ofJobs([job.id]))).has(job.id)).toBe(false);
  });
});

describe('maintenance plans', () => {
  it('records one occurrence per plan and date, append-only, in the job’s history', async () => {
    const plan = await inTenant((tx) =>
      tx.maintenance.createPlan(
        {
          assetId,
          jobTypeId,
          title: 'Quarterly service',
          intervalCount: 3,
          intervalUnit: 'month',
          counting: 'calendar',
          startsOn: daysFromToday(10),
        },
        { nextDueOn: daysFromToday(10), nextSequence: 0 },
        MANAGER,
      ),
    );
    expect(plan.siteId).toBe(siteId);
    const due = await inTenant((tx) => tx.maintenance.dueForCreation(today()));
    expect(due.map((entry) => entry.plan.id)).toContain(plan.id);

    const job = await inTenant((tx) =>
      tx.workOrders.create(
        { customerId, siteId, jobTypeId, assetIds: [assetId], maintenance: { contractId: null } },
        MANAGER,
      ),
    );
    const first = await inTenant((tx) =>
      tx.maintenance.recordOccurrence({
        planId: plan.id,
        dueOn: plan.nextDueOn!,
        workOrderId: job.id,
      }),
    );
    const again = await inTenant((tx) =>
      tx.maintenance.recordOccurrence({
        planId: plan.id,
        dueOn: plan.nextDueOn!,
        workOrderId: job.id,
      }),
    );
    expect([first, again]).toEqual([true, false]);
    await expect(
      asTenant(app, northwind.id, () =>
        app.query('delete from maintenance_occurrences where plan_id = $1', [plan.id]),
      ),
    ).rejects.toThrow(/append-only/u);

    const events = await inTenant((tx) => tx.workOrders.listEvents(job.id));
    expect(events.map((event) => event.kind)).toContain('maintenance_planned');
    // A planned job has its due window, not a response deadline.
    expect((await inTenant((tx) => tx.deadlines.ofJobs([job.id]))).has(job.id)).toBe(false);
    const plans = await inTenant((tx) => tx.maintenance.plansOfWorkOrders([job.id]));
    expect(plans.get(job.id)?.map((entry) => entry.planId)).toEqual([plan.id]);
  });

  it('does not count the worker moving a plan on as an edit', async () => {
    const plan = await inTenant((tx) =>
      tx.maintenance.createPlan(
        {
          assetId,
          jobTypeId,
          title: 'Yearly inspection',
          intervalCount: 1,
          intervalUnit: 'year',
          counting: 'calendar',
          startsOn: '2030-01-01',
        },
        { nextDueOn: '2030-01-01', nextSequence: 0 },
        MANAGER,
      ),
    );
    await inTenant((tx) =>
      tx.maintenance.advance(plan.id, { nextDueOn: '2031-01-01', nextSequence: 1 }),
    );
    const after = await inTenant((tx) => tx.maintenance.findPlan(plan.id));
    expect(after).toMatchObject({ version: plan.version, nextDueOn: '2031-01-01' });
  });
});
