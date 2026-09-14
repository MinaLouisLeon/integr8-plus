import { describe, expect, it } from 'vitest';
import { matchExpression, searchLocal } from './search';
import { applySnapshot } from './snapshot';
import { customerDetail, me, siteBody, workOrderDetail } from './testing/fixtures';
import { openTestDatabase } from './testing/node-driver';

const NOW = new Date('2026-09-14T12:00:00.000Z');

async function phone() {
  const riverside = customerDetail({ name: 'Riverside Housing', accountNumber: 'RH-001' });
  const cafe = customerDetail({ name: 'Café Rouge', accountNumber: 'CR-7' });
  const arabic = customerDetail({ name: 'مؤسسة النخيل', accountNumber: 'NK-3' });
  const boiler = workOrderDetail(riverside, { title: 'Boiler service' });
  const leak = workOrderDetail(cafe, {
    title: 'Leak under the sink',
    site: siteBody(cafe.customer.id, {
      name: 'Kitchen',
      address: { ...cafe.sites[0]!.address, line1: '9 Market Street' },
    }),
  });
  const { db } = await openTestDatabase();
  await db.write(['work_orders'], (sql) =>
    applySnapshot(
      sql,
      { me: me(), workOrders: [boiler, leak], customers: [riverside, cafe, arabic], forms: [] },
      NOW,
    ),
  );
  return { db, riverside, cafe, arabic, boiler, leak };
}

describe('local search', () => {
  it('matches the start of each word typed', async () => {
    const { db, riverside, boiler } = await phone();
    const results = await db.read((sql) => searchLocal(sql, 'riv hou'));
    expect(results.customers.map((row) => row.id)).toEqual([riverside.customer.id]);
    expect(results.workOrders.map((row) => row.id)).toEqual([boiler.workOrder.id]);
  });

  it('finds a job by its reference, with or without the prefix and zeros', async () => {
    const { db, boiler } = await phone();
    for (const text of [boiler.workOrder.referenceLabel, String(boiler.workOrder.reference)]) {
      const results = await db.read((sql) => searchLocal(sql, text));
      expect(results.workOrders.map((row) => row.id)).toContain(boiler.workOrder.id);
    }
  });

  it('finds a job by its site address and a customer by account number', async () => {
    const { db, cafe, leak } = await phone();
    expect(
      (await db.read((sql) => searchLocal(sql, 'market st'))).workOrders.map((row) => row.id),
    ).toEqual([leak.workOrder.id]);
    expect(
      (await db.read((sql) => searchLocal(sql, 'CR-7'))).customers.map((row) => row.id),
    ).toEqual([cafe.customer.id]);
  });

  it('ignores accents and case, and searches Arabic', async () => {
    const { db, cafe, arabic } = await phone();
    expect(
      (await db.read((sql) => searchLocal(sql, 'CAFE'))).customers.map((row) => row.id),
    ).toEqual([cafe.customer.id]);
    expect(
      (await db.read((sql) => searchLocal(sql, 'النخيل'))).customers.map((row) => row.id),
    ).toEqual([arabic.customer.id]);
  });

  it('treats what is typed as words, never as query syntax', async () => {
    const { db } = await phone();
    for (const text of ['"', 'AND', 'title:boiler', 'NEAR(a b)', '*', 'riv" OR "x', '-', '(']) {
      await expect(db.read((sql) => searchLocal(sql, text))).resolves.toBeDefined();
    }
    expect(matchExpression('  ')).toBeUndefined();
    expect(matchExpression('it\'s "odd"')).toBe('"it"* "s"* "odd"*');
  });

  it('follows changes to the rows it searches', async () => {
    const { db, riverside, boiler } = await phone();
    await db.write(['work_orders'], (sql) =>
      applySnapshot(
        sql,
        {
          me: me(),
          workOrders: [workOrderDetail(riverside, { title: 'Radiator bleed' })],
          customers: [],
          forms: [],
        },
        NOW,
      ),
    );
    // The second snapshot no longer lists the first job, so search no longer finds it.
    const boilers = await db.read((sql) => searchLocal(sql, 'boiler'));
    expect(boilers.workOrders.map((row) => row.id)).not.toContain(boiler.workOrder.id);
    expect((await db.read((sql) => searchLocal(sql, 'radiator'))).workOrders).toHaveLength(1);
  });
});
