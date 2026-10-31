import { describe, expect, it } from 'vitest';
import { mayCorrectAccess, saveAccess } from './access.js';
import { applySnapshot } from './snapshot.js';
import { customerDetail, me, siteBody, uuid, workOrderDetail } from './testing/fixtures.js';
import { openTestDatabase } from './testing/node-driver.js';

const NOW = new Date('2026-10-31T09:00:00.000Z');

async function phone() {
  const { db } = await openTestDatabase();
  const customer = customerDetail();
  await db.write(['work_orders'], (sql) =>
    applySnapshot(sql, { me: me(), workOrders: [], customers: [customer], forms: [] }, NOW),
  );
  return { db, customer };
}

describe('correcting access notes from the phone', () => {
  it('is offered on the crew of an open job at the site, and not once every job there has closed', async () => {
    const customer = customerDetail();
    const site = customer.sites[0]!;
    const open = workOrderDetail(customer, { state: 'on_site' });
    const { db } = await openTestDatabase();
    await db.write(['work_orders'], (sql) =>
      applySnapshot(sql, { me: me(), workOrders: [open], customers: [customer], forms: [] }, NOW),
    );
    await db.write(['meta'], (sql) =>
      saveAccess(sql, { permissions: ['work_order.progress'], features: {} }),
    );
    expect(await db.read((sql) => mayCorrectAccess(sql, site.id))).toBe(true);

    const closed = workOrderDetail(customer, {
      state: 'complete',
      completedAt: '2026-10-30T15:00:00.000Z',
    });
    await db.write(['work_orders'], (sql) =>
      applySnapshot(sql, { me: me(), workOrders: [closed], customers: [customer], forms: [] }, NOW),
    );
    expect(await db.read((sql) => mayCorrectAccess(sql, site.id))).toBe(false);
  });

  it('is not offered on a job somebody else is working, nor without the right to work jobs', async () => {
    const customer = customerDetail();
    const site = customer.sites[0]!;
    const theirs = workOrderDetail(customer, { state: 'dispatched' });
    theirs.crew = [
      { id: uuid(), name: 'Cara', lead: true, assignedAt: theirs.workOrder.createdAt },
    ];
    const { db } = await openTestDatabase();
    await db.write(['work_orders'], (sql) =>
      applySnapshot(sql, { me: me(), workOrders: [theirs], customers: [customer], forms: [] }, NOW),
    );
    await db.write(['meta'], (sql) =>
      saveAccess(sql, { permissions: ['work_order.progress'], features: {} }),
    );
    expect(await db.read((sql) => mayCorrectAccess(sql, site.id))).toBe(false);

    await db.write(['meta'], (sql) => saveAccess(sql, { permissions: [], features: {} }));
    expect(await db.read((sql) => mayCorrectAccess(sql, site.id))).toBe(false);
  });

  it('is offered to the office at any site', async () => {
    const customer = customerDetail({ sites: [] });
    const other = siteBody(customer.customer.id);
    const { db } = await phone();
    await db.write(['meta'], (sql) =>
      saveAccess(sql, { permissions: ['customer.manage'], features: {} }),
    );
    expect(await db.read((sql) => mayCorrectAccess(sql, other.id))).toBe(true);
  });
});
