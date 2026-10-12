import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { vanStock } from '../queries.js';
import { applySnapshot } from '../snapshot.js';
import { customerDetail, me, workOrderDetail } from '../testing/fixtures.js';
import { openTestDatabase } from '../testing/node-driver.js';
import { type ChangeContext, LocalChangeError, recordMaterial, selectBatch } from './outbox.js';

/**
 * Parts used from the van, recorded on the phone (CRM/ERP plan, phase E2;
 * ADR-0005): the use shows on the job at once and goes to the outbox under the
 * job, the van's forecast comes down by it, and nothing not in the van is
 * offered.
 */

const NOW = new Date('2026-10-11T12:00:00.000Z');
const random = (length: number) => new Uint8Array(randomBytes(length));
const VALVE = '00000000-0000-4000-8000-00000000f001';
const VAN = '00000000-0000-4000-8000-00000000f102';

async function phone() {
  const { db } = await openTestDatabase();
  const customer = customerDetail();
  const job = workOrderDetail(customer, { state: 'in_progress' });
  await db.write(['work_orders', 'van_stock'], async (sql) => {
    await applySnapshot(
      sql,
      { me: me(), workOrders: [job], customers: [customer], forms: [] },
      NOW,
    );
    await sql.run(
      `insert into van_stock (item_id, location_id, location_name, sku, name, kind, unit, on_hand, updated_at)
       values (?, ?, 'Van 1', 'VAL-15', 'Ball valve 15mm', 'stock_item', 'each', '5', ?)`,
      [VALVE, VAN, NOW.toISOString()],
    );
  });
  const clock = { current: NOW, now: () => clock.current };
  const context: ChangeContext = { db, clock, random };
  return { db, context, job };
}

describe('a part used from the van', () => {
  it('shows on the job at once, queues under the job, and comes off the van forecast', async () => {
    const { db, context, job } = await phone();
    const id = await recordMaterial(context, {
      workOrderId: job.workOrder.id,
      itemId: VALVE,
      quantity: '2',
      note: 'Replaced',
    });

    const local = await db.read(async (sql) => {
      const row = await sql.get<{ data: string }>('select data from work_orders where id = ?', [
        job.workOrder.id,
      ]);
      return JSON.parse(row!.data) as typeof job;
    });
    expect(local.materials).toHaveLength(1);
    expect(local.materials[0]).toMatchObject({
      item: { id: VALVE, name: 'Ball valve 15mm', unit: 'each' },
      location: { id: VAN, name: 'Van 1' },
      quantity: '2',
      note: 'Replaced',
      status: 'posted',
    });

    const { rows } = await db.read((sql) => selectBatch(sql, NOW));
    expect(rows.map((row) => [row.id, row.kind, row.entityKey, row.workOrderId])).toEqual([
      [id, 'work_order.material', `work_order:${job.workOrder.id}`, job.workOrder.id],
    ]);
    expect(rows[0]?.payload).toMatchObject({
      materialId: local.materials[0]!.id,
      itemId: VALVE,
      quantity: '2',
      note: 'Replaced',
    });

    const stock = await db.read(vanStock);
    expect(stock).toHaveLength(1);
    expect(stock[0]).toMatchObject({ onHand: '5', forecast: '3' });

    // A second use takes the forecast further down, never below zero.
    await recordMaterial(context, { workOrderId: job.workOrder.id, itemId: VALVE, quantity: '4' });
    expect((await db.read(vanStock))[0]?.forecast).toBe('0');
  });

  it('refuses a part the van does not hold, and a quantity that is not one', async () => {
    const { context, job } = await phone();
    await expect(
      recordMaterial(context, {
        workOrderId: job.workOrder.id,
        itemId: '00000000-0000-4000-8000-00000000f999',
        quantity: '1',
      }),
    ).rejects.toMatchObject({ code: 'item_not_in_van' });
    await expect(
      recordMaterial(context, { workOrderId: job.workOrder.id, itemId: VALVE, quantity: '0' }),
    ).rejects.toBeInstanceOf(LocalChangeError);
    await expect(
      recordMaterial(context, { workOrderId: job.workOrder.id, itemId: VALVE, quantity: 'two' }),
    ).rejects.toMatchObject({ code: 'quantity_invalid' });
  });
});

describe('a serial-numbered part from the van', () => {
  const METER = '00000000-0000-4000-8000-00000000f003';
  const SN1 = '00000000-0000-4000-8000-00000000a101';
  const SN2 = '00000000-0000-4000-8000-00000000a102';

  async function withMeters() {
    const setup = await phone();
    await setup.db.write(['van_stock'], async (sql) => {
      await sql.run(
        `insert into van_stock (item_id, location_id, location_name, sku, name, kind, unit, on_hand,
                                tracking, lots, updated_at)
         values (?, ?, 'Van 1', 'MTR-1', 'Gas meter', 'stock_item', 'each', '2', 'serial', ?, ?)`,
        [
          METER,
          VAN,
          JSON.stringify([
            { lotId: SN1, kind: 'serial', code: 'SN-1', expiresOn: null, onHand: '1' },
            { lotId: SN2, kind: 'serial', code: 'SN-2', expiresOn: null, onHand: '1' },
          ]),
          NOW.toISOString(),
        ],
      );
    });
    return setup;
  }

  it('names its serial number from the van, shows it on the job, and takes it off the van', async () => {
    const { db, context, job } = await withMeters();
    const base = { workOrderId: job.workOrder.id, itemId: METER, quantity: '1' };
    await expect(recordMaterial(context, base)).rejects.toMatchObject({
      code: 'serial_required',
    });
    await expect(
      recordMaterial(context, {
        ...base,
        lots: [{ lotId: '00000000-0000-4000-8000-00000000a999', quantity: '1' }],
      }),
    ).rejects.toMatchObject({ code: 'lot_not_in_van' });
    await expect(
      recordMaterial(context, { ...base, lots: [{ lotId: SN1, quantity: '2' }] }),
    ).rejects.toMatchObject({ code: 'lots_mismatch' });

    await recordMaterial(context, { ...base, lots: [{ lotId: SN1, quantity: '1' }] });
    const { rows } = await db.read((sql) => selectBatch(sql, NOW));
    expect(rows[0]?.payload).toMatchObject({ lots: [{ lotId: SN1, quantity: '1' }] });
    const local = await db.read(async (sql) => {
      const row = await sql.get<{ data: string }>('select data from work_orders where id = ?', [
        job.workOrder.id,
      ]);
      return JSON.parse(row!.data) as typeof job;
    });
    expect(local.materials[0]?.lots).toEqual([
      { lotId: SN1, kind: 'serial', code: 'SN-1', expiresOn: null, quantity: '1' },
    ]);
    const meter = (await db.read(vanStock)).find((row) => row.item.id === METER)!;
    expect(meter.item.tracking).toBe('serial');
    expect(meter.lots.map((lot) => [lot.code, lot.forecast])).toEqual([
      ['SN-1', '0'],
      ['SN-2', '1'],
    ]);
  });
});
