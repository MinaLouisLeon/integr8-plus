import { randomUUID } from 'node:crypto';
import { toTenantId } from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DuplicatePostingError,
  InsufficientStockError,
  type MovementInput,
  NotStockItemError,
} from '../repositories/inventory-stock.js';
import {
  asTenant,
  connectAsApp,
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
  withUnprotectedRepositories,
} from './harness.js';

/**
 * Migration 0026 (CRM/ERP plan, phase E1; ADR-0003): the catalogue and the
 * stock ledger — the rules the database keeps whatever the API does.
 */

const USER = '00000000-0000-4000-8000-00000000e101';

let owner: pg.Client;
let app: pg.Client;
let northwind: TenantFixture;
let southgate: TenantFixture;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  app = await connectAsApp();
  northwind = await createTenant('inv-northwind');
  southgate = await createTenant('inv-southgate');
});

afterAll(async () => {
  await app.end();
  await owner.end();
  await releaseTestDatabase();
});

const repos = <T>(
  tenant: TenantFixture,
  fn: Parameters<typeof withUnprotectedRepositories<T>>[1],
) => withUnprotectedRepositories(toTenantId(tenant.id), fn);

async function item(tenant: TenantFixture, sku: string, kind = 'stock_item') {
  return repos(tenant, (tx) =>
    tx.inventoryCatalogue.createItem(
      { sku, name: `Item ${sku}`, kind: kind as 'stock_item' },
      USER,
    ),
  );
}

async function location(tenant: TenantFixture, name: string) {
  return repos(tenant, (tx) => tx.inventoryStock.createLocation({ name, kind: 'warehouse' }));
}

function move(
  tenant: TenantFixture,
  movements: readonly (Omit<MovementInput, 'sourceKey'> & { sourceKey?: string })[],
) {
  return repos(tenant, (tx) =>
    tx.inventoryStock.post(
      movements.map((movement) => ({ sourceKey: randomUUID(), ...movement })),
      { postingId: randomUUID(), actorId: USER },
    ),
  );
}

const onHand = async (tenant: TenantFixture, itemId: string, locationId: string) =>
  (await repos(tenant, (tx) => tx.inventoryStock.balances({ itemId, locationId })))[0]?.onHand ??
  '0';

describe('the module switches', () => {
  it('declares inventory and purchasing, both off unless Integr8 switches them on', async () => {
    const result = await owner.query<{ key: string; default_enabled: boolean }>(
      `select key, default_enabled from feature_flags where key in ('inventory', 'purchasing') order by key`,
    );
    expect(result.rows).toEqual([
      { key: 'inventory', default_enabled: false },
      { key: 'purchasing', default_enabled: false },
    ]);
  });
});

describe('the ledger', () => {
  it('adds every movement to its balance, and transfers both halves together', async () => {
    const cable = await item(northwind, 'CAB-1');
    const store = await location(northwind, 'Main store');
    const van = await location(northwind, 'Van 1');

    await move(northwind, [
      { itemId: cable.id, locationId: store.id, kind: 'receipt', quantity: '10.5' },
    ]);
    await move(northwind, [
      { itemId: cable.id, locationId: store.id, kind: 'transfer_out', quantity: '-4.25' },
      { itemId: cable.id, locationId: van.id, kind: 'transfer_in', quantity: '4.25' },
    ]);
    expect(await onHand(northwind, cable.id, store.id)).toBe('6.25');
    expect(await onHand(northwind, cable.id, van.id)).toBe('4.25');
  });

  it('never goes negative, and refuses a whole posting when one part would', async () => {
    const valve = await item(northwind, 'VAL-1');
    const store = await location(northwind, 'Valve store');
    const van = await location(northwind, 'Valve van');
    await move(northwind, [
      { itemId: valve.id, locationId: store.id, kind: 'receipt', quantity: '3' },
    ]);

    await expect(
      move(northwind, [
        { itemId: valve.id, locationId: van.id, kind: 'transfer_in', quantity: '5' },
        { itemId: valve.id, locationId: store.id, kind: 'transfer_out', quantity: '-5' },
      ]),
    ).rejects.toBeInstanceOf(InsufficientStockError);
    expect(await onHand(northwind, valve.id, store.id)).toBe('3');
    expect(await onHand(northwind, valve.id, van.id)).toBe('0');

    await expect(
      move(northwind, [{ itemId: valve.id, locationId: van.id, kind: 'issue', quantity: '-1' }]),
    ).rejects.toBeInstanceOf(InsufficientStockError);
  });

  it('lets only one of two concurrent issues take the last of the stock', async () => {
    const pump = await item(northwind, 'PMP-1');
    const store = await location(northwind, 'Pump store');
    await move(northwind, [
      { itemId: pump.id, locationId: store.id, kind: 'receipt', quantity: '10' },
    ]);

    const results = await Promise.allSettled(
      [1, 2, 3].map(() =>
        move(northwind, [{ itemId: pump.id, locationId: store.id, kind: 'issue', quantity: '-4' }]),
      ),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    const refused = results.filter((result) => result.status === 'rejected');
    expect(refused).toHaveLength(1);
    expect(refused[0]!.reason).toBeInstanceOf(InsufficientStockError);
    expect(await onHand(northwind, pump.id, store.id)).toBe('2');
  });

  it('posts a source once', async () => {
    const fuse = await item(northwind, 'FUS-1');
    const store = await location(northwind, 'Fuse store');
    const sourceKey = `receipt-line:${randomUUID()}`;
    await move(northwind, [
      { itemId: fuse.id, locationId: store.id, kind: 'receipt', quantity: '1', sourceKey },
    ]);
    await expect(
      move(northwind, [
        { itemId: fuse.id, locationId: store.id, kind: 'receipt', quantity: '1', sourceKey },
      ]),
    ).rejects.toBeInstanceOf(DuplicatePostingError);
    expect(await onHand(northwind, fuse.id, store.id)).toBe('1');
  });

  it('moves only stock items, and only with the sign their kind carries', async () => {
    const labour = await item(northwind, 'SVC-1', 'service');
    const store = await location(northwind, 'Service store');
    await expect(
      move(northwind, [
        { itemId: labour.id, locationId: store.id, kind: 'receipt', quantity: '1' },
      ]),
    ).rejects.toBeInstanceOf(NotStockItemError);

    const bolt = await item(northwind, 'BLT-1');
    await expect(
      move(northwind, [{ itemId: bolt.id, locationId: store.id, kind: 'receipt', quantity: '-1' }]),
    ).rejects.toThrow(/erp_stock_movements_quantity_signed/u);
  });

  it('is append-only, and its balances are not the application’s to write', async () => {
    const nut = await item(northwind, 'NUT-1');
    const store = await location(northwind, 'Nut store');
    await move(northwind, [
      { itemId: nut.id, locationId: store.id, kind: 'receipt', quantity: '2' },
    ]);

    await expect(
      asTenant(app, northwind.id, () => app.query(`update erp_stock_movements set quantity = 99`)),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      asTenant(app, northwind.id, () => app.query(`delete from erp_stock_movements`)),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      asTenant(app, northwind.id, () => app.query(`update erp_stock_balances set on_hand = 99`)),
    ).rejects.toThrow(/permission denied/u);
    // Even the schema owner cannot rewrite history.
    await expect(owner.query(`update erp_stock_movements set reason = 'edited'`)).rejects.toThrow(
      /append-only/u,
    );
  });

  it('keeps each company’s catalogue and stock to itself', async () => {
    const theirs = await item(southgate, 'SOUTH-1');
    const theirStore = await location(southgate, 'South store');
    await move(southgate, [
      { itemId: theirs.id, locationId: theirStore.id, kind: 'receipt', quantity: '5' },
    ]);

    const seen = await asTenant(app, northwind.id, async () => ({
      items: (await app.query(`select id from erp_items where id = $1`, [theirs.id])).rows,
      balances: (
        await app.query(`select * from erp_stock_balances where item_id = $1`, [theirs.id])
      ).rows,
    }));
    expect(seen).toEqual({ items: [], balances: [] });

    const ours = await location(northwind, 'Cross store');
    await expect(
      move(northwind, [{ itemId: theirs.id, locationId: ours.id, kind: 'receipt', quantity: '1' }]),
    ).rejects.toThrow(/erp_stock_movements_item_fk/u);
  });
});

describe('cost', () => {
  it('keeps one weighted average per item, changed only by receipts', async () => {
    const boiler = await item(northwind, 'BOI-1');
    const store = await location(northwind, 'Boiler store');
    const receive = async (quantity: string, unitCost: string) =>
      repos(northwind, async (tx) => {
        const average = await tx.inventoryStock.applyReceiptCost(boiler.id, quantity, unitCost);
        await tx.inventoryStock.post(
          [
            {
              itemId: boiler.id,
              locationId: store.id,
              kind: 'receipt',
              quantity,
              unitCost,
              sourceKey: randomUUID(),
            },
          ],
          { postingId: randomUUID(), actorId: USER },
        );
        return average;
      });

    expect(await receive('10', '5')).toBe('5');
    expect(await receive('10', '7')).toBe('6');
    await move(northwind, [
      { itemId: boiler.id, locationId: store.id, kind: 'issue', quantity: '-15' },
    ]);
    // 5 left at 6, plus 3 at 10: (30 + 30) / 8 = 7.5
    expect(await receive('3', '10')).toBe('7.5');
    // Rounded once, to four places: (8 × 7.5 + 1 × 0.0001) / 9
    expect(await receive('1', '0.0001')).toBe('6.6667');
  });
});

describe('stock counts', () => {
  it('posts the difference between counted and held, and records what was held', async () => {
    const tape = await item(northwind, 'TAP-1');
    const glue = await item(northwind, 'GLU-1');
    const store = await location(northwind, 'Count store');
    await move(northwind, [
      { itemId: tape.id, locationId: store.id, kind: 'receipt', quantity: '10' },
      { itemId: glue.id, locationId: store.id, kind: 'receipt', quantity: '4' },
    ]);

    const count = await repos(northwind, (tx) => tx.inventoryStock.createCount(store.id, USER));
    const drafted = await repos(northwind, (tx) =>
      tx.inventoryStock.setCountLines(count.id, count.version, [
        { itemId: tape.id, countedQuantity: '8.5' },
        { itemId: glue.id, countedQuantity: '4' },
      ]),
    );
    expect(typeof drafted === 'object' && drafted.version).toBe(2);

    const posted = await repos(northwind, (tx) =>
      tx.inventoryStock.postCount(count.id, 2, { postingId: randomUUID(), actorId: USER }),
    );
    expect(typeof posted === 'object' && posted.count).toMatchObject({
      status: 'posted',
      postedBy: USER,
    });
    expect(typeof posted === 'object' && posted.movements.map((m) => m.quantity)).toEqual(['-1.5']);
    expect(await onHand(northwind, tape.id, store.id)).toBe('8.5');

    const lines = await repos(northwind, (tx) => tx.inventoryStock.countLines(count.id));
    expect(lines.find((line) => line.itemId === tape.id)?.expectedQuantity).toBe('10');

    expect(
      await repos(northwind, (tx) =>
        tx.inventoryStock.postCount(count.id, 3, { postingId: randomUUID(), actorId: USER }),
      ),
    ).toBe('not_draft');
  });
});

describe('replay', () => {
  it('reproduces every balance from 100 000 movements, and reads one quickly', async () => {
    const tenant = await createTenant('inv-volume');
    const items = await Promise.all(
      Array.from({ length: 10 }, (_, index) => item(tenant, `VOL-${index}`)),
    );
    const places = await Promise.all(
      Array.from({ length: 5 }, (_, index) => location(tenant, `Volume ${index}`)),
    );
    const itemIds = items.map((row) => row.id);
    const placeIds = places.map((row) => row.id);

    // 60 000 receipts, then 40 000 issues of what they brought in, through the
    // real trigger, written by the schema owner in bulk.
    await owner.query(
      `insert into erp_stock_movements
         (tenant_id, posting_id, item_id, location_id, kind, quantity, source_key, actor_id)
       select $1, gen_random_uuid(), ($2::uuid[])[1 + n % 10], ($3::uuid[])[1 + (n / 10) % 5],
              'receipt', 1.25, 'bulk-in:' || n, $4
         from generate_series(0, 59999) as n`,
      [tenant.id, itemIds, placeIds, USER],
    );
    await owner.query(
      `insert into erp_stock_movements
         (tenant_id, posting_id, item_id, location_id, kind, quantity, source_key, actor_id)
       select $1, gen_random_uuid(), ($2::uuid[])[1 + n % 10], ($3::uuid[])[1 + (n / 10) % 5],
              'issue', -1.25, 'bulk-out:' || n, $4
         from generate_series(0, 39999) as n`,
      [tenant.id, itemIds, placeIds, USER],
    );

    expect(await repos(tenant, (tx) => tx.inventoryStock.reconcile())).toEqual([]);

    const started = performance.now();
    const balances = await repos(tenant, (tx) =>
      tx.inventoryStock.balances({ itemId: itemIds[0]! }),
    );
    const elapsed = performance.now() - started;
    expect(balances).toHaveLength(5);
    // 20 000 movements remain per 10 items × 5 places: 400 net receipts of 1.25 each.
    expect(balances.every((balance) => balance.onHand === '500')).toBe(true);
    expect(elapsed).toBeLessThan(300);

    // A tampered balance is found.
    await owner.query(
      `update erp_stock_balances set on_hand = on_hand + 1
        where tenant_id = $1 and item_id = $2 and location_id = $3`,
      [tenant.id, itemIds[0], placeIds[0]],
    );
    expect(await repos(tenant, (tx) => tx.inventoryStock.reconcile())).toEqual([
      { itemId: itemIds[0], locationId: placeIds[0], ledger: '500', balance: '501' },
    ]);
  }, 120_000);
});

describe('parts on jobs (0062)', () => {
  it('refuses a part on a cancelled job, and keeps whether one was recorded after the close', async () => {
    const service = await item(northwind, 'SVC-0062', 'service');
    const job = await repos(northwind, async (tx) => {
      await tx.tenantUsers.create({
        userId: USER,
        email: 'parts@northwind.example',
        displayName: 'Parts',
        role: 'dispatcher',
      });
      const customer = await tx.customers.create({ name: 'Riverside' }, USER);
      const site = await tx.sites.create(
        customer.id,
        { name: 'Block A', address: { line1: '1 River Road' } },
        USER,
      );
      const type = await tx.jobTypes.create({ name: 'Service', code: 'svc-0062' }, USER);
      return tx.workOrders.create(
        { customerId: customer.id, siteId: site.id, jobTypeId: type.id },
        USER,
      );
    });
    const part = (recordedAfterClose: boolean) =>
      repos(northwind, (tx) =>
        tx.inventoryMaterials.create({
          workOrderId: job.id,
          itemId: service.id,
          locationId: null,
          quantity: '1',
          unitCost: null,
          status: 'posted',
          recordedBy: USER,
          recordedAfterClose,
        }),
      );
    const marked = await part(true);
    expect(marked.recordedAfterClose).toBe(true);
    await expect(
      owner.query(
        `update erp_work_order_materials set recorded_after_close = false where id = $1`,
        [marked.id],
      ),
    ).rejects.toThrow(/keeps whether it was recorded after its job closed/u);

    const cancelled = await repos(northwind, (tx) =>
      tx.workOrders.transition(job.id, job.revision, 'cancelled', USER, 'Not needed'),
    );
    expect(cancelled.outcome).toBe('written');
    await expect(part(false)).rejects.toThrow(/is cancelled; no parts can be recorded on it/u);
  });
});

describe('deleting a company', () => {
  it('takes its ledger with it, and only when the deletion is due', async () => {
    const tenant = await createTenant('inv-purge');
    const rope = await item(tenant, 'ROP-1');
    const store = await location(tenant, 'Purge store');
    const [first] = await move(tenant, [
      { itemId: rope.id, locationId: store.id, kind: 'receipt', quantity: '2' },
    ]);
    await repos(tenant, (tx) =>
      tx.inventoryStock.post(
        [
          {
            itemId: rope.id,
            locationId: store.id,
            kind: 'adjustment',
            quantity: '-1',
            sourceKey: randomUUID(),
            reversalOf: first!.id,
          },
        ],
        { postingId: randomUUID(), actorId: USER },
      ),
    );

    const exported = await owner.query<{ id: string }>(
      `insert into tenant_exports (tenant_id, tenant_slug, status, object_key)
       values ($1, 'inv-purge', 'ready', 'exports/inv-purge.zip') returning id`,
      [tenant.id],
    );
    await owner.query(
      `insert into tenant_deletions (tenant_id, tenant_slug, export_id, reason, purge_after)
       values ($1, 'inv-purge', $2, 'Integration test of the purge', now() - interval '1 minute')`,
      [tenant.id, exported.rows[0]!.id],
    );
    await owner.query(`select purge_tenant($1)`, [tenant.id]);

    const left = await owner.query(
      `select count(*)::int as n from erp_stock_movements where tenant_id = $1`,
      [tenant.id],
    );
    expect(left.rows[0]).toEqual({ n: 0 });
    // The guard is back on afterwards.
    await expect(owner.query(`delete from erp_stock_movements`)).rejects.toThrow(/append-only/u);
  });
});
