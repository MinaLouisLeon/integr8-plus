import { describe, expect, it } from 'vitest';
import { openJobs } from './queries.js';
import { searchLocal } from './search.js';
import { applySnapshot } from './snapshot.js';
import { customerDetail, me, uuid, workOrderDetail } from './testing/fixtures.js';
import { openTestDatabase } from './testing/node-driver.js';

/**
 * What P27 adds to the phone's job list: each job's deadlines, whether a
 * contract covers it and whether a maintenance plan made it, read from the job
 * as the phone downloaded it, so the list can show them with no signal.
 */

const NOW = new Date('2026-11-02T10:00:00.000Z');

describe('the job list', () => {
  it('carries deadlines, coverage and planned maintenance, and none for a job without them', async () => {
    const { db } = await openTestDatabase();
    const customer = customerDetail();
    const contractId = uuid();
    const planned = workOrderDetail(customer, {
      title: 'Quarterly AC service',
      coverage: {
        status: 'covered',
        reason: 'maintenance_plan',
        contract: { id: contractId, reference: 'CT-000012', title: 'Annual care' },
        overrideReason: null,
        overriddenAt: null,
      },
      deadlines: {
        priority: 'urgent',
        clock: 'always',
        warnMinutes: 30,
        response: {
          dueAt: '2026-11-02T12:00:00.000Z',
          metAt: null,
          state: 'running',
          missedAt: null,
        },
        completion: null,
      },
      maintenancePlans: [
        {
          planId: uuid(),
          title: 'Quarterly AC service',
          asset: { id: uuid(), name: 'Rooftop AC', reference: 'AS-000001' },
          dueOn: '2026-11-15',
        },
      ],
    });
    const plain = workOrderDetail(customer, { title: 'Boiler repair' });
    await db.write(['work_orders'], (sql) =>
      applySnapshot(
        sql,
        { me: me(), workOrders: [planned, plain], customers: [customer], forms: [] },
        NOW,
      ),
    );

    const jobs = await db.read((sql) => openJobs(sql));
    const first = jobs.find((entry) => entry.id === planned.workOrder.id);
    const second = jobs.find((entry) => entry.id === plain.workOrder.id);
    expect(first).toMatchObject({ coverage: 'covered', maintenance: true });
    expect(first?.deadlines?.response?.dueAt).toBe('2026-11-02T12:00:00.000Z');
    expect(second).toMatchObject({ coverage: null, maintenance: false, deadlines: null });

    const found = await db.read((sql) => searchLocal(sql, 'quarterly'));
    expect(found.workOrders[0]).toMatchObject({ coverage: 'covered', maintenance: true });
  });
});
