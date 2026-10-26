import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WorkOrderDetail } from './api-types.js';
import { myVisits } from './queries.js';
import { applySnapshot } from './snapshot.js';
import {
  type ChangeContext,
  type LocalChangeError,
  recordVisitDone,
  selectBatch,
} from './sync/outbox.js';
import { customerDetail, ENGINEER, me, uuid, workOrderDetail } from './testing/fixtures.js';
import { openTestDatabase } from './testing/node-driver.js';

/**
 * Visits on the phone (P25): the engineer's day as the office planned it, read
 * from the jobs the phone holds, and a visit marked done with no signal.
 */

const NOW = new Date('2026-11-02T10:00:00.000Z');
const COLLEAGUE = uuid();
const random = (length: number) => new Uint8Array(randomBytes(length));

type Visit = WorkOrderDetail['visits'][number];

function visit(overrides: Partial<Visit> & Pick<Visit, 'startsAt' | 'endsAt'>): Visit {
  return {
    id: uuid(),
    workOrderId: '',
    status: 'planned',
    notes: null,
    assignees: [{ id: ENGINEER, name: 'Ed Engineer' }],
    completedAt: null,
    completedBy: null,
    cancelledAt: null,
    cancelReason: null,
    revision: 1,
    warnings: [],
    qualificationGaps: [],
    ...overrides,
  };
}

async function phone() {
  const { db } = await openTestDatabase();
  const customer = customerDetail();
  const afternoon = visit({
    startsAt: '2026-11-02T13:00:00.000Z',
    endsAt: '2026-11-02T15:00:00.000Z',
  });
  const morning = visit({
    startsAt: '2026-11-02T08:00:00.000Z',
    endsAt: '2026-11-02T11:00:00.000Z',
    assignees: [
      { id: ENGINEER, name: 'Ed Engineer' },
      { id: COLLEAGUE, name: 'Cara Colleague' },
    ],
  });
  const tomorrow = visit({
    startsAt: '2026-11-03T08:00:00.000Z',
    endsAt: '2026-11-03T09:00:00.000Z',
  });
  const notMine = visit({
    startsAt: '2026-11-02T09:00:00.000Z',
    endsAt: '2026-11-02T10:00:00.000Z',
    assignees: [{ id: COLLEAGUE, name: 'Cara Colleague' }],
  });
  const cancelled = visit({
    startsAt: '2026-11-02T16:00:00.000Z',
    endsAt: '2026-11-02T17:00:00.000Z',
    status: 'cancelled',
  });
  const boiler = workOrderDetail(customer, { visits: [afternoon, tomorrow, cancelled] });
  const pump = workOrderDetail(customer, { visits: [morning, notMine] });
  await db.write(['work_orders'], (sql) =>
    applySnapshot(
      sql,
      { me: me(), workOrders: [boiler, pump], customers: [customer], forms: [] },
      NOW,
    ),
  );
  const clock = { current: NOW, now: () => clock.current };
  const context: ChangeContext = { db, clock, random };
  const day = () =>
    db.read((sql) =>
      myVisits(sql, {
        userId: ENGINEER,
        from: new Date('2026-11-02T00:00:00.000Z'),
        to: new Date('2026-11-03T00:00:00.000Z'),
      }),
    );
  return { db, context, boiler, pump, morning, afternoon, cancelled, day };
}

describe('the engineer’s visits', () => {
  it('lists today’s visits that are theirs, earliest first, with whom they go', async () => {
    const { day, morning, afternoon, pump, boiler } = await phone();
    const visits = await day();
    expect(visits.map((entry) => entry.id)).toEqual([morning.id, afternoon.id]);
    expect(visits[0]).toMatchObject({
      people: ['Ed Engineer', 'Cara Colleague'],
      job: { id: pump.workOrder.id, referenceLabel: pump.workOrder.referenceLabel },
    });
    expect(visits[1]?.job.id).toBe(boiler.workOrder.id);
  });

  it('marks a visit done on the phone at once, and queues it to send', async () => {
    const { db, context, day, morning, pump } = await phone();
    const id = await recordVisitDone(context, {
      workOrderId: pump.workOrder.id,
      visitId: morning.id,
    });
    expect(id).toBeDefined();
    expect((await day()).find((entry) => entry.id === morning.id)?.status).toBe('done');

    const { rows } = await db.read((sql) => selectBatch(sql, NOW));
    expect(rows.map((row) => [row.kind, row.payload])).toEqual([
      ['work_order.visit_done', { visitId: morning.id }],
    ]);

    // Doing it again changes nothing and sends nothing more.
    expect(
      await recordVisitDone(context, { workOrderId: pump.workOrder.id, visitId: morning.id }),
    ).toBeUndefined();
  });

  it('refuses a visit that was called off, or is not on the job', async () => {
    const { context, boiler, cancelled, morning } = await phone();
    await expect(
      recordVisitDone(context, { workOrderId: boiler.workOrder.id, visitId: cancelled.id }),
    ).rejects.toMatchObject({ code: 'visit_final' } satisfies Partial<LocalChangeError>);
    await expect(
      recordVisitDone(context, { workOrderId: boiler.workOrder.id, visitId: morning.id }),
    ).rejects.toMatchObject({ code: 'visit_unknown' } satisfies Partial<LocalChangeError>);
  });
});
