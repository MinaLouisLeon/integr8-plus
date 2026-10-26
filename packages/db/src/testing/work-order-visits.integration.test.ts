import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../connection.js';
import type { Visit, VisitWrite } from '../repositories/work-order-visits.js';
import type { WorkOrder } from '../repositories/work-orders.js';
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
 * Visits (migration 0051), against a real database.
 *
 * The board's promise — nobody is double-booked across jobs, even when two
 * dispatchers drop a visit at the same moment — is a constraint, so it is
 * proven here with the repository and with raw SQL as the runtime role.
 */

const DISPATCHER = '00000000-0000-4000-8000-00000000d201';
const AHMED = '00000000-0000-4000-8000-00000000e201';
const SARA = '00000000-0000-4000-8000-00000000e202';
const OMAR = '00000000-0000-4000-8000-00000000e203';

let northwind: TenantFixture;
let contoso: TenantFixture;
let owner: pg.Client;
let app: pg.Client;
let customerId: string;
let siteId: string;
let jobTypeId: string;

const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[1]) => withTenant(northwind.id, fn);

const at = (day: number, time: string) =>
  new Date(`2026-11-${String(day).padStart(2, '0')}T${time}:00Z`);

const newJob = (crew: string[]) =>
  inTenant((tx) =>
    tx.workOrders.create(
      {
        customerId,
        siteId,
        jobTypeId,
        crew: crew.map((userId, index) => ({ userId, lead: index === 0 })),
      },
      DISPATCHER,
    ),
  );

function written(result: VisitWrite): Visit {
  if (result.outcome !== 'written') {
    throw new Error(`expected a written visit, got ${result.outcome}`);
  }
  return result.visit;
}

const plan = async (job: WorkOrder, day: number, from: string, to: string, people: string[]) =>
  written(
    await inTenant((tx) =>
      tx.visits.create(
        { workOrderId: job.id, startsAt: at(day, from), endsAt: at(day, to), assigneeIds: people },
        DISPATCHER,
      ),
    ),
  );

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  northwind = await createTenant('northwind');
  contoso = await createTenant('contoso');
  owner = await connectAsOwner();
  app = await connectAsApp();

  await withTenant(northwind.id, async (tx) => {
    for (const userId of [DISPATCHER, AHMED, SARA, OMAR]) {
      await tx.tenantUsers.create({
        userId,
        email: `${userId.slice(-4)}@${northwind.slug}.example`,
        displayName: userId.slice(-4),
        role: userId === DISPATCHER ? 'dispatcher' : 'engineer',
      });
    }
    const customer = await tx.customers.create({ name: 'Riverside Housing' }, DISPATCHER);
    customerId = customer.id;
    siteId = (
      await tx.sites.create(
        customerId,
        { name: 'Block A', address: { line1: '1 River Road', city: 'Leeds', countryCode: 'gb' } },
        DISPATCHER,
      )
    ).id;
    jobTypeId = (
      await tx.jobTypes.create(
        { name: 'AC service', code: 'ac', expectedDurationMinutes: 120 },
        DISPATCHER,
      )
    ).id;
  });
  await withTenant(contoso.id, (tx) =>
    tx.tenantUsers.create({
      userId: DISPATCHER,
      email: `d201@${contoso.slug}.example`,
      displayName: 'd201',
      role: 'dispatcher',
    }),
  );
});

afterAll(async () => {
  await owner.end();
  await app.end();
  await releaseTestDatabase();
});

describe('planning visits', () => {
  it('plans several visits of one job, each with its own people and times', async () => {
    const job = await newJob([AHMED, SARA]);
    const first = await plan(job, 2, '08:00', '12:00', [AHMED, SARA]);
    const second = await plan(job, 3, '08:00', '10:00', [SARA]);

    expect(first).toMatchObject({ status: 'planned', revision: 1, assigneeIds: [AHMED, SARA] });
    const visits = await inTenant((tx) => tx.visits.listForWorkOrders([job.id]));
    expect(visits.get(job.id)?.map((visit) => visit.id)).toEqual([first.id, second.id]);

    const history = await inTenant((tx) => tx.workOrders.listEvents(job.id));
    expect(history.filter((event) => event.kind === 'visit_scheduled')).toHaveLength(2);
    expect(history.filter((event) => event.kind === 'visit_assigned')).toHaveLength(3);
  });

  it('refuses someone who is not on the job’s crew', async () => {
    const job = await newJob([AHMED]);
    const result = await inTenant((tx) =>
      tx.visits.create(
        {
          workOrderId: job.id,
          startsAt: at(4, '08:00'),
          endsAt: at(4, '09:00'),
          assigneeIds: [OMAR],
        },
        DISPATCHER,
      ),
    );
    expect(result).toEqual({ outcome: 'not_on_crew', userIds: [OMAR] });
  });

  it('refuses a slot that ends before it starts', async () => {
    const job = await newJob([AHMED]);
    const result = await inTenant((tx) =>
      tx.visits.create(
        { workOrderId: job.id, startsAt: at(4, '10:00'), endsAt: at(4, '09:00') },
        DISPATCHER,
      ),
    );
    expect(result).toEqual({ outcome: 'invalid_slot', problem: 'ends_before_start' });
  });
});

describe('double booking', () => {
  it('refuses the same person on overlapping visits of different jobs, and names the clash', async () => {
    const boiler = await newJob([OMAR]);
    const pump = await newJob([OMAR]);
    const existing = await plan(boiler, 10, '08:00', '10:00', [OMAR]);

    const result = await inTenant((tx) =>
      tx.visits.create(
        {
          workOrderId: pump.id,
          startsAt: at(10, '09:00'),
          endsAt: at(10, '11:00'),
          assigneeIds: [OMAR],
        },
        DISPATCHER,
      ),
    );
    expect(result).toMatchObject({
      outcome: 'double_booked',
      conflicts: [
        { userId: OMAR, conflictingVisitId: existing.id, conflictingWorkOrderId: boiler.id },
      ],
    });
    // Nothing of the refused visit is left behind.
    expect((await inTenant((tx) => tx.visits.listForWorkOrders([pump.id]))).size).toBe(0);
  });

  it('allows overlapping visits of the same job, and visits that only touch', async () => {
    const job = await newJob([OMAR]);
    const other = await newJob([OMAR]);
    await plan(job, 11, '08:00', '12:00', [OMAR]);
    await plan(job, 11, '10:00', '13:00', [OMAR]);
    await plan(other, 11, '13:00', '14:00', [OMAR]);
  });

  it('refuses moving a visit onto someone’s other job', async () => {
    const morning = await newJob([SARA]);
    const afternoon = await newJob([SARA]);
    await plan(morning, 12, '08:00', '10:00', [SARA]);
    const later = await plan(afternoon, 12, '14:00', '15:00', [SARA]);

    const result = await inTenant((tx) =>
      tx.visits.update(
        later.id,
        later.revision,
        { startsAt: at(12, '09:00'), endsAt: at(12, '10:30') },
        DISPATCHER,
      ),
    );
    expect(result.outcome).toBe('double_booked');
    const unchanged = await inTenant((tx) => tx.visits.find(later.id));
    expect(unchanged?.startsAt).toEqual(at(12, '14:00'));
  });

  it('holds for raw SQL as the runtime role, not just the repository', async () => {
    const first = await newJob([AHMED]);
    const second = await newJob([AHMED]);
    await plan(first, 13, '08:00', '10:00', [AHMED]);
    const clash = await plan(second, 13, '11:00', '12:00', [AHMED]);

    await expect(
      asTenant(app, northwind.id, () =>
        app.query(
          `update work_order_visits set starts_at = $1, ends_at = $2, last_actor = $3 where id = $4`,
          [at(13, '09:00'), at(13, '10:00'), DISPATCHER, clash.id],
        ),
      ),
    ).rejects.toMatchObject({ code: '23P01' });
  });

  it('frees people when a visit is cancelled', async () => {
    const first = await newJob([AHMED]);
    const second = await newJob([AHMED]);
    const cancelled = await plan(first, 14, '08:00', '10:00', [AHMED]);
    written(
      await inTenant((tx) =>
        tx.visits.cancel(cancelled.id, cancelled.revision, 'Customer away', DISPATCHER),
      ),
    );
    await plan(second, 14, '08:00', '10:00', [AHMED]);
  });
});

describe('changing a visit', () => {
  it('moves a visit and swaps who goes, refusing a stale revision', async () => {
    const job = await newJob([AHMED, SARA]);
    const visit = await plan(job, 16, '08:00', '10:00', [AHMED]);

    const moved = written(
      await inTenant((tx) =>
        tx.visits.update(
          visit.id,
          visit.revision,
          { startsAt: at(16, '13:00'), endsAt: at(16, '15:00'), assigneeIds: [SARA] },
          DISPATCHER,
        ),
      ),
    );
    expect(moved).toMatchObject({ revision: 2, assigneeIds: [SARA], startsAt: at(16, '13:00') });

    const stale = await inTenant((tx) =>
      tx.visits.update(visit.id, visit.revision, { startsAt: at(16, '09:00') }, DISPATCHER),
    );
    expect(stale.outcome).toBe('conflict');

    const kinds = (await inTenant((tx) => tx.workOrders.listEvents(job.id))).map(
      (event) => event.kind,
    );
    expect(kinds).toEqual(expect.arrayContaining(['visit_rescheduled', 'visit_unassigned']));
  });

  it('treats done and cancelled as final, and marking done twice as harmless', async () => {
    const job = await newJob([AHMED]);
    const visit = await plan(job, 17, '08:00', '10:00', [AHMED]);
    const done = written(
      await inTenant((tx) => tx.visits.markDone(visit.id, at(17, '10:05'), AHMED)),
    );
    expect(done).toMatchObject({ status: 'done', completedBy: AHMED });
    expect(
      (await inTenant((tx) => tx.visits.markDone(visit.id, at(17, '10:06'), AHMED))).outcome,
    ).toBe('written');
    const moved = await inTenant((tx) =>
      tx.visits.update(visit.id, done.revision, { startsAt: at(17, '11:00') }, DISPATCHER),
    );
    expect(moved.outcome).toBe('final');
  });
});

describe('following the job', () => {
  it('takes someone off the job’s planned visits when they leave the crew', async () => {
    const job = await newJob([AHMED, SARA]);
    const visit = await plan(job, 20, '08:00', '10:00', [AHMED, SARA]);
    await inTenant((tx) =>
      tx.workOrders.setCrew(job.id, [{ userId: SARA, lead: true }], DISPATCHER),
    );
    expect((await inTenant((tx) => tx.visits.find(visit.id)))?.assigneeIds).toEqual([SARA]);
  });

  it('cancels planned visits when the job is cancelled, and refuses new ones', async () => {
    const job = await newJob([AHMED]);
    const visit = await plan(job, 21, '08:00', '10:00', [AHMED]);
    const cancelled = await inTenant((tx) =>
      tx.workOrders.transition(job.id, job.revision, 'cancelled', DISPATCHER, 'Customer withdrew'),
    );
    expect(cancelled.outcome).toBe('written');
    expect(await inTenant((tx) => tx.visits.find(visit.id))).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Job cancelled',
    });
    const refused = await inTenant((tx) =>
      tx.visits.create(
        { workOrderId: job.id, startsAt: at(22, '08:00'), endsAt: at(22, '09:00') },
        DISPATCHER,
      ),
    );
    expect(refused).toEqual({ outcome: 'job_closed', state: 'cancelled' });
  });
});

describe('the calendar', () => {
  it('lists visits overlapping a window, for chosen people, and jobs still to schedule', async () => {
    const job = await newJob([OMAR]);
    const visit = await plan(job, 25, '22:00', '23:30', [OMAR]);
    await newJob([OMAR]);

    const day = await inTenant((tx) =>
      tx.visits.listInRange({ from: at(25, '00:00'), to: at(26, '00:00'), userIds: [OMAR] }),
    );
    expect(day.map((found) => found.id)).toContain(visit.id);
    expect(
      await inTenant((tx) =>
        tx.visits.listInRange({ from: at(25, '00:00'), to: at(26, '00:00'), userIds: [SARA] }),
      ),
    ).toEqual([]);

    const unscheduled = await inTenant((tx) => tx.visits.listUnscheduled());
    expect(unscheduled.map((entry) => entry.workOrderId)).not.toContain(job.id);
    expect(unscheduled[0]?.expectedDurationMinutes).toBe(120);
  });

  it('shows one company nothing of another’s', async () => {
    const elsewhere = await withTenant(contoso.id, (tx) =>
      tx.visits.listInRange({ from: at(1, '00:00'), to: at(30, '00:00') }),
    );
    expect(elsewhere).toEqual([]);
  });
});
