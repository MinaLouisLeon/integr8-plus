import { toTenantId } from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePurchaseOrderReference } from '../repositories/inventory-purchasing.js';
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
 * Migration 0027 (CRM/ERP plan, phase E2): suppliers, purchase orders and
 * goods receipts — the rules the database keeps whatever the API does.
 */

const USER = '00000000-0000-4000-8000-00000000e201';

let owner: pg.Client;
let northwind: TenantFixture;
let southgate: TenantFixture;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  northwind = await createTenant('po-northwind');
  southgate = await createTenant('po-southgate');
});

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

const repos = <T>(
  tenant: TenantFixture,
  fn: Parameters<typeof withUnprotectedRepositories<T>>[1],
) => withUnprotectedRepositories(toTenantId(tenant.id), fn);

async function fixtures(tenant: TenantFixture, tag: string) {
  return repos(tenant, async (tx) => {
    const supplier = await tx.inventoryPurchasing.createSupplier({ name: `Supplier ${tag}` }, USER);
    const item = await tx.inventoryCatalogue.createItem(
      { sku: `PO-${tag}`, name: `Item ${tag}`, kind: 'stock_item' },
      USER,
    );
    const store = await tx.inventoryStock.createLocation({
      name: `Store ${tag}`,
      kind: 'warehouse',
    });
    return { supplier, item, store };
  });
}

describe('references', () => {
  it('numbers orders PO-000001, PO-000002… per company, with no gaps between companies', async () => {
    const a = await fixtures(northwind, 'ref-a');
    const b = await fixtures(southgate, 'ref-b');
    const order = (tenant: TenantFixture, supplierId: string, supplierName: string) =>
      repos(tenant, (tx) =>
        tx.inventoryPurchasing.createOrder(
          { supplierId, supplierName, currencyCode: 'GBP' },
          [],
          USER,
        ),
      );

    const first = await order(northwind, a.supplier.id, a.supplier.name);
    const second = await order(northwind, a.supplier.id, a.supplier.name);
    const other = await order(southgate, b.supplier.id, b.supplier.name);
    expect(second.reference).toBe(first.reference + 1);
    expect(other.reference).toBe(1);
  });

  it('reads a reference however someone types it', () => {
    expect(parsePurchaseOrderReference('PO-000123')).toBe(123);
    expect(parsePurchaseOrderReference('po 7')).toBe(7);
    expect(parsePurchaseOrderReference(' 42 ')).toBe(42);
    expect(parsePurchaseOrderReference('Acme')).toBeUndefined();
    expect(parsePurchaseOrderReference('')).toBeUndefined();
  });
});

describe('an order', () => {
  it('totals its lines exactly, tax per line in basis points', async () => {
    const { supplier, item } = await fixtures(northwind, 'totals');
    const totals = await repos(northwind, async (tx) => {
      const order = await tx.inventoryPurchasing.createOrder(
        { supplierId: supplier.id, supplierName: supplier.name, currencyCode: 'GBP' },
        [
          {
            itemId: item.id,
            description: 'Cable',
            quantityOrdered: '3',
            unitPrice: '0.1',
            taxRateBp: 2000,
          },
          { itemId: item.id, description: 'Cable, more', quantityOrdered: '1.5', unitPrice: '2' },
        ],
        USER,
      );
      return {
        lines: await tx.inventoryPurchasing.orderLines(order.id),
        totals: await tx.inventoryPurchasing.orderTotals(order.id),
      };
    });
    expect(totals.lines.map((line) => [line.subtotal, line.tax])).toEqual([
      ['0.3', '0.06'],
      ['3', '0'],
    ]);
    expect(totals.totals).toEqual({ subtotal: '3.3', tax: '0.06', total: '3.36' });
  });

  it('freezes its lines once approved; only what arrived still moves', async () => {
    const { supplier, item } = await fixtures(northwind, 'frozen');
    const order = await repos(northwind, (tx) =>
      tx.inventoryPurchasing.createOrder(
        { supplierId: supplier.id, supplierName: supplier.name, currencyCode: 'GBP' },
        [{ itemId: item.id, description: 'Cable', quantityOrdered: '4', unitPrice: '1' }],
        USER,
      ),
    );
    const [line] = await repos(northwind, (tx) => tx.inventoryPurchasing.orderLines(order.id));

    // A draft's lines can be rewritten.
    const edited = await repos(northwind, (tx) =>
      tx.inventoryPurchasing.updateDraft(order.id, order.version, {}, [
        { itemId: item.id, description: 'Cable, revised', quantityOrdered: '5', unitPrice: '1' },
      ]),
    );
    expect(edited).toMatchObject({ version: order.version + 1 });

    const approved = await repos(northwind, (tx) =>
      tx.inventoryPurchasing.setStatus(order.id, order.version + 1, {
        status: 'approved',
        actorId: USER,
      }),
    );
    expect(approved).toMatchObject({ status: 'approved', approvedBy: USER });

    expect(
      await repos(northwind, (tx) =>
        tx.inventoryPurchasing.updateDraft(order.id, order.version + 2, {}, []),
      ),
    ).toBe('not_draft');
    await expect(
      owner.query(`update erp_purchase_order_lines set quantity_ordered = 99 where order_id = $1`, [
        order.id,
      ]),
    ).rejects.toMatchObject({ constraint: 'erp_purchase_order_lines_frozen' });
    await expect(
      owner.query(`delete from erp_purchase_order_lines where order_id = $1`, [order.id]),
    ).rejects.toMatchObject({ constraint: 'erp_purchase_order_lines_frozen' });
    // Receipts still move what arrived.
    await owner.query(
      `update erp_purchase_order_lines set quantity_received = 2 where order_id = $1`,
      [order.id],
    );
    expect(line).toBeDefined();
  });

  it('never records more received than ordered', async () => {
    const { supplier, item } = await fixtures(northwind, 'over');
    const order = await repos(northwind, (tx) =>
      tx.inventoryPurchasing.createOrder(
        { supplierId: supplier.id, supplierName: supplier.name, currencyCode: 'GBP' },
        [{ itemId: item.id, description: 'Cable', quantityOrdered: '4', unitPrice: '1' }],
        USER,
      ),
    );
    await expect(
      owner.query(
        `update erp_purchase_order_lines set quantity_received = 4.0001 where order_id = $1`,
        [order.id],
      ),
    ).rejects.toMatchObject({ constraint: 'erp_purchase_order_lines_received_range' });
  });

  it('refuses a stale version and an approval that names nobody', async () => {
    const { supplier } = await fixtures(northwind, 'stale');
    const order = await repos(northwind, (tx) =>
      tx.inventoryPurchasing.createOrder(
        { supplierId: supplier.id, supplierName: supplier.name, currencyCode: 'GBP' },
        [],
        USER,
      ),
    );
    expect(
      await repos(northwind, (tx) =>
        tx.inventoryPurchasing.setStatus(order.id, order.version + 5, {
          status: 'approved',
          actorId: USER,
        }),
      ),
    ).toBe('version_conflict');
    await expect(
      owner.query(`update erp_purchase_orders set status = 'approved' where id = $1`, [order.id]),
    ).rejects.toMatchObject({ constraint: 'erp_purchase_orders_approved_pairing' });
  });
});

describe('receipts', () => {
  it('track what arrived against each line, and returns free the quantity again', async () => {
    const { supplier, item, store } = await fixtures(northwind, 'receipt');
    const state = await repos(northwind, async (tx) => {
      const order = await tx.inventoryPurchasing.createOrder(
        { supplierId: supplier.id, supplierName: supplier.name, currencyCode: 'GBP' },
        [
          { itemId: item.id, description: 'Cable', quantityOrdered: '4', unitPrice: '1' },
          { itemId: item.id, description: 'Cable, more', quantityOrdered: '2', unitPrice: '1' },
        ],
        USER,
      );
      await tx.inventoryPurchasing.setStatus(order.id, order.version, {
        status: 'approved',
        actorId: USER,
      });
      const [first, second] = await tx.inventoryPurchasing.orderLines(order.id);
      const none = await tx.inventoryPurchasing.receivedState(order.id);
      const receipt = await tx.inventoryPurchasing.recordReceipt(
        {
          orderId: order.id,
          locationId: store.id,
          supplierNote: 'DN-1',
          notes: null,
          receivedBy: USER,
        },
        [{ orderLineId: first!.id, quantity: '4', unitCost: '1' }],
      );
      const partial = await tx.inventoryPurchasing.receivedState(order.id);
      await tx.inventoryPurchasing.recordReceipt(
        {
          orderId: order.id,
          locationId: store.id,
          supplierNote: null,
          notes: null,
          receivedBy: USER,
        },
        [{ orderLineId: second!.id, quantity: '2', unitCost: '1' }],
      );
      const full = await tx.inventoryPurchasing.receivedState(order.id);
      const returned = await tx.inventoryPurchasing.recordReturn(receipt.lines[0]!.id, '1.5');
      const afterReturn = await tx.inventoryPurchasing.receivedState(order.id);
      const lines = await tx.inventoryPurchasing.orderLines(order.id);
      const receipts = await tx.inventoryPurchasing.receiptsFor(order.id);
      return { none, partial, full, returned, afterReturn, lines, receipts };
    });
    expect([state.none, state.partial, state.full, state.afterReturn]).toEqual([
      'none',
      'partial',
      'full',
      'partial',
    ]);
    expect(state.returned.returnedQuantity).toBe('1.5');
    expect(state.lines.map((line) => line.quantityReceived)).toEqual(['2.5', '2']);
    expect(state.receipts).toHaveLength(2);
    expect(state.receipts[0]?.supplierNote).toBe('DN-1');
  });

  it('cannot return more than a line received', async () => {
    const { supplier, item, store } = await fixtures(northwind, 'over-return');
    await expect(
      repos(northwind, async (tx) => {
        const order = await tx.inventoryPurchasing.createOrder(
          { supplierId: supplier.id, supplierName: supplier.name, currencyCode: 'GBP' },
          [{ itemId: item.id, description: 'Cable', quantityOrdered: '4', unitPrice: '1' }],
          USER,
        );
        await tx.inventoryPurchasing.setStatus(order.id, order.version, {
          status: 'approved',
          actorId: USER,
        });
        const [line] = await tx.inventoryPurchasing.orderLines(order.id);
        const receipt = await tx.inventoryPurchasing.recordReceipt(
          {
            orderId: order.id,
            locationId: store.id,
            supplierNote: null,
            notes: null,
            receivedBy: USER,
          },
          [{ orderLineId: line!.id, quantity: '3', unitCost: '1' }],
        );
        await tx.inventoryPurchasing.recordReturn(receipt.lines[0]!.id, '3.5');
      }),
    ).rejects.toMatchObject({ constraint: 'erp_goods_receipt_lines_returned_range' });
  });
});

describe('suppliers', () => {
  it('have one name per company, matched without regard to case', async () => {
    await repos(northwind, (tx) =>
      tx.inventoryPurchasing.createSupplier({ name: 'Acme Ltd' }, USER),
    );
    await expect(
      repos(northwind, (tx) => tx.inventoryPurchasing.createSupplier({ name: 'acme ltd' }, USER)),
    ).rejects.toMatchObject({ constraint: 'erp_suppliers_name_unique' });
    // Another company may use the same name.
    await expect(
      repos(southgate, (tx) => tx.inventoryPurchasing.createSupplier({ name: 'Acme Ltd' }, USER)),
    ).resolves.toMatchObject({ name: 'Acme Ltd' });
  });

  it('keep a preferred supplier on an item, and refuse one from another company', async () => {
    const { supplier, item } = await fixtures(northwind, 'preferred');
    const other = await fixtures(southgate, 'preferred-other');
    const updated = await repos(northwind, (tx) =>
      tx.inventoryCatalogue.updateItem(item.id, item.version, {
        preferredSupplierId: supplier.id,
        supplierPartNumber: 'ACM-1',
      }),
    );
    expect(updated).toMatchObject({
      preferredSupplierId: supplier.id,
      supplierPartNumber: 'ACM-1',
    });
    await expect(
      repos(northwind, (tx) =>
        tx.inventoryCatalogue.updateItem(item.id, item.version + 1, {
          preferredSupplierId: other.supplier.id,
        }),
      ),
    ).rejects.toMatchObject({ constraint: 'erp_items_supplier_fk' });
  });
});
