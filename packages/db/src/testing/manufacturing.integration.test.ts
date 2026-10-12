import { randomUUID } from 'node:crypto';
import { DEFAULT_CHART, toTenantId } from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Item } from '../repositories/inventory-catalogue.js';
import type { StockLocation } from '../repositories/inventory-stock.js';
import {
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
  withUnprotectedRepositories,
} from './harness.js';

/**
 * Migration 0039 (seventh round; ADR-0011): bills of materials versioned and
 * never changed, never of themselves; assembly orders frozen once done;
 * assembly movements signed, and posting as one 'assembly' document —
 * inventory up by the labour and overhead added, absorbed — not as stock.
 */

const USER = '00000000-0000-4000-8000-00000000f901';

let owner: pg.Client;
let tenant: TenantFixture;
let pump: Item;
let hose: Item;
let kit: Item;
let labour: Item;
let store: StockLocation;

const repos = <T>(fn: Parameters<typeof withUnprotectedRepositories<T>>[1]) =>
  withUnprotectedRepositories(toTenantId(tenant.id), fn);

const chart = DEFAULT_CHART.map((account) => ({
  code: account.code,
  name: account.name.en,
  type: account.type,
  ...(account.role === undefined ? {} : { role: account.role }),
}));

async function item(sku: string, kind: 'stock_item' | 'non_stock_item' | 'service' = 'stock_item') {
  return repos((tx) => tx.inventoryCatalogue.createItem({ sku, name: sku, kind }, USER));
}

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  tenant = await createTenant('manufacturing');
  await repos(async (tx) => {
    await tx.tenantUsers.create({
      userId: USER,
      email: `maker@${tenant.slug}.example`,
      displayName: 'Mona Maker',
      role: 'inventory_manager',
    });
  });
  pump = await item('PUMP');
  hose = await item('HOSE');
  kit = await item('KIT');
  labour = await item('FITTING', 'service');
  store = await repos((tx) =>
    tx.inventoryStock.createLocation({ name: 'Store', kind: 'warehouse' }),
  );
});

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

describe('bills of materials', () => {
  it('are versioned: saving supersedes the one in use, which never changes', async () => {
    const first = await repos((tx) =>
      tx.manufacturing.saveBom(
        kit.id,
        {
          labourCost: '50',
          overheadCost: '10',
          note: null,
          components: [
            { itemId: pump.id, quantity: '1' },
            { itemId: hose.id, quantity: '2.5' },
          ],
        },
        USER,
      ),
    );
    expect(first).toMatchObject({ version: 1, labourCost: '50', supersededAt: null });
    const second = await repos((tx) =>
      tx.manufacturing.saveBom(
        kit.id,
        {
          labourCost: '60',
          overheadCost: '10',
          note: 'Longer hose',
          components: [
            { itemId: pump.id, quantity: '1' },
            { itemId: hose.id, quantity: '3' },
          ],
        },
        USER,
      ),
    );
    expect(second.version).toBe(2);
    expect((await repos((tx) => tx.manufacturing.bom(first.id)))?.supersededAt).not.toBeNull();
    expect((await repos((tx) => tx.manufacturing.activeBom(kit.id)))?.id).toBe(second.id);
    await expect(
      owner.query(`update erp_boms set labour_cost = 1 where id = $1`, [second.id]),
    ).rejects.toMatchObject({ constraint: 'erp_boms_frozen' });
    await expect(
      owner.query(`update erp_bom_components set quantity = 9 where bom_id = $1`, [second.id]),
    ).rejects.toMatchObject({ constraint: 'erp_boms_frozen' });
    await expect(
      owner.query(`delete from erp_boms where id = $1`, [first.id]),
    ).rejects.toMatchObject({ constraint: 'erp_boms_frozen' });
  });

  it('are for stock items, of stock and non-stock items, never of themselves', async () => {
    await expect(
      repos((tx) =>
        tx.manufacturing.saveBom(
          labour.id,
          {
            labourCost: '0',
            overheadCost: '0',
            note: null,
            components: [{ itemId: pump.id, quantity: '1' }],
          },
          USER,
        ),
      ),
    ).rejects.toMatchObject({ constraint: 'erp_boms_stock_item' });
    await expect(
      repos((tx) =>
        tx.manufacturing.saveBom(
          pump.id,
          {
            labourCost: '0',
            overheadCost: '0',
            note: null,
            components: [{ itemId: pump.id, quantity: '1' }],
          },
          USER,
        ),
      ),
    ).rejects.toMatchObject({ constraint: 'erp_bom_components_not_itself' });
    await expect(
      repos((tx) =>
        tx.manufacturing.saveBom(
          pump.id,
          {
            labourCost: '0',
            overheadCost: '0',
            note: null,
            components: [{ itemId: labour.id, quantity: '1' }],
          },
          USER,
        ),
      ),
    ).rejects.toMatchObject({ constraint: 'erp_bom_components_item_kind' });
  });
});

describe('assembly orders', () => {
  it('are numbered, use a bill of their own item, and never change once done', async () => {
    const bom = (await repos((tx) => tx.manufacturing.activeBom(kit.id)))!;
    const order = await repos((tx) =>
      tx.manufacturing.createOrder(
        {
          direction: 'assemble',
          itemId: kit.id,
          bomId: bom.id,
          locationId: store.id,
          quantity: '2',
        },
        USER,
      ),
    );
    expect(order).toMatchObject({ status: 'draft', reference: 1 });
    await expect(
      repos((tx) =>
        tx.manufacturing.createOrder(
          {
            direction: 'assemble',
            itemId: pump.id,
            bomId: bom.id,
            locationId: store.id,
            quantity: '1',
          },
          USER,
        ),
      ),
    ).rejects.toMatchObject({ constraint: 'erp_assembly_orders_bom_item' });
    const cancelled = (await repos((tx) =>
      tx.manufacturing.cancel(order.id, order.version, USER),
    ))!;
    expect(cancelled.status).toBe('cancelled');
    await expect(
      owner.query(`update erp_assembly_orders set note = 'x' where id = $1`, [order.id]),
    ).rejects.toMatchObject({ constraint: 'erp_assembly_orders_frozen' });
    await expect(
      owner.query(`delete from erp_assembly_orders where id = $1`, [order.id]),
    ).rejects.toMatchObject({ constraint: 'erp_assembly_orders_frozen' });
  });

  it('move stock with signed kinds, and post as one assembly, not as stock', async () => {
    const settings = await repos((tx) =>
      tx.ledger.setUp({ startDate: '2026-01-01', fiscalStartMonth: 1, chart }, USER),
    );
    if (settings === 'already_set_up') {
      throw new Error(settings);
    }
    const bom = (await repos((tx) => tx.manufacturing.activeBom(kit.id)))!;
    const order = await repos((tx) =>
      tx.manufacturing.createOrder(
        {
          direction: 'assemble',
          itemId: kit.id,
          bomId: bom.id,
          locationId: store.id,
          quantity: '2',
        },
        USER,
      ),
    );
    await expect(
      repos((tx) =>
        tx.inventoryStock.post(
          [
            {
              itemId: pump.id,
              locationId: store.id,
              kind: 'assembly_output',
              quantity: '-1',
              unitCost: '1',
              sourceKey: 'wrong-sign',
            },
          ],
          { postingId: order.id, actorId: USER },
        ),
      ),
    ).rejects.toMatchObject({ constraint: 'erp_stock_movements_quantity_signed' });

    // Stock to build from: 2 pumps at 1,000 and 6 m of hose at 20.
    await repos((tx) =>
      tx.inventoryStock.post(
        [
          {
            itemId: pump.id,
            locationId: store.id,
            kind: 'receipt',
            quantity: '2',
            unitCost: '1000',
            sourceKey: 'r-pump',
          },
          {
            itemId: hose.id,
            locationId: store.id,
            kind: 'receipt',
            quantity: '6',
            unitCost: '20',
            sourceKey: 'r-hose',
          },
        ],
        { postingId: randomUUID(), actorId: USER },
      ),
    );
    // Two kits: 2,000 of pumps and 120 of hose out; in at those plus 2 × 70.
    await repos(async (tx) => {
      await tx.inventoryStock.post(
        [
          {
            itemId: pump.id,
            locationId: store.id,
            kind: 'assembly_consumption',
            quantity: '-2',
            unitCost: '1000',
            sourceKey: `assembly:${order.id}:${pump.id}`,
          },
          {
            itemId: hose.id,
            locationId: store.id,
            kind: 'assembly_consumption',
            quantity: '-6',
            unitCost: '20',
            sourceKey: `assembly:${order.id}:${hose.id}`,
          },
          {
            itemId: kit.id,
            locationId: store.id,
            kind: 'assembly_output',
            quantity: '2',
            unitCost: '1130',
            sourceKey: `assembly:${order.id}:${kit.id}`,
          },
        ],
        { postingId: order.id, actorId: USER },
      );
      await tx.manufacturing.complete(order.id, order.version, USER, {
        unitCost: '1130',
        labourCost: '60',
        overheadCost: '10',
      });
    });
    expect(await repos((tx) => tx.ledger.postingBySource('stock', order.id))).toBeUndefined();
    const posting = await repos((tx) => tx.ledger.postingBySource('assembly', order.id));
    expect(posting).toMatchObject({ status: 'posted', label: 'AO-000002' });
    const [lines, accounts] = await Promise.all([
      repos((tx) => tx.ledger.lines(posting!.journalId!)),
      repos((tx) => tx.ledger.accounts()),
    ]);
    const code = new Map(accounts.map((account) => [account.id, account.code]));
    expect(lines.map((line) => [code.get(line.accountId), line.debit, line.credit])).toEqual([
      ['1300', '140', '0'],
      ['5300', '0', '140'],
    ]);
  });
});
