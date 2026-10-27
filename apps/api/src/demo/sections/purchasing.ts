import { day, type DemoContext } from '../context.js';
import { type DemoItem, itemBySku } from './inventory.js';

/**
 * Purchasing and the stock follow-ups around it: supplier price lists,
 * purchase orders in every state, receipts and a return, serial and batch
 * tracked items, van requests and stock counts.
 *
 * Adds to refs:
 *   purchaseOrders  { id, reference, status }[]
 *   items           two more: SM-MTR-001 (serial tracked) and HV-OIL-001 (batch tracked)
 */

interface Order {
  order: { id: string; reference: string; status: string; version: number };
  lines: { id: string; item: { id: string }; quantityOrdered: string }[];
  receipts: { id: string; lines: { id: string; orderLineId: string; quantity: string }[] }[];
}

interface Supplier {
  id: string;
  key: string;
}

export async function seedPurchasing(ctx: DemoContext): Promise<void> {
  const suppliers = ctx.refs.suppliers as Supplier[];
  const items = ctx.refs.items as DemoItem[];
  const locations = ctx.refs.locations as Record<string, string>;
  const supplier = (key: string) => suppliers.find((candidate) => candidate.key === key)!.id;

  // Price lists: each stock item at its preferred supplier, a bulk break on
  // the consumables, and a second quote for the AC units from another source.
  let prices = 0;
  for (const item of items) {
    if (item.supplierId === null || item.kind === 'service') {
      continue;
    }
    await ctx.call('store', 'POST', `/v1/purchasing/suppliers/${item.supplierId}/prices`, {
      itemId: item.id,
      currencyCode: 'EGP',
      unitPrice: item.cost,
      validFrom: day(-90),
    });
    prices += 1;
    if (item.sku.startsWith('CN-') || item.sku === 'HV-FLT-001') {
      await ctx.call('store', 'POST', `/v1/purchasing/suppliers/${item.supplierId}/prices`, {
        itemId: item.id,
        currencyCode: 'EGP',
        minQuantity: '100',
        unitPrice: (Number(item.cost) * 0.9).toFixed(2),
        validFrom: day(-90),
        validTo: day(180),
      });
      prices += 1;
    }
  }
  for (const sku of ['EQ-SPL-120', 'EQ-SPL-240']) {
    const item = itemBySku(ctx, sku);
    await ctx.call('store', 'POST', `/v1/purchasing/suppliers/${supplier('elec')}/prices`, {
      itemId: item.id,
      currencyCode: 'EGP',
      unitPrice: (Number(item.cost) * 1.04).toFixed(2),
      validFrom: day(-30),
    });
    prices += 1;
  }

  // Two tracked items, new to the catalogue so tracking starts clean.
  const tracked = async (
    sku: string,
    name: string,
    cost: string,
    price: string,
    tracking: 'serial' | 'batch',
    supplierKey: string,
    unit = 'each',
  ) => {
    const created = await ctx.call<{
      id: string;
      version: number;
      kind: DemoItem['kind'];
      unit: string;
    }>('store', 'POST', '/v1/inventory/items', {
      sku,
      name,
      kind: 'stock_item',
      unit,
      defaultUnitCost: cost,
      salePrice: price,
      preferredSupplierId: supplier(supplierKey),
      leadTimeDays: 7,
    });
    await ctx.call('store', 'POST', `/v1/inventory/items/${created.id}/tracking`, {
      tracking,
      expectedVersion: created.version,
    });
    const item: DemoItem = {
      id: created.id,
      sku,
      name,
      kind: created.kind,
      unit: created.unit,
      cost,
      price,
      supplierId: supplier(supplierKey),
    };
    items.push(item);
    return item;
  };
  const meter = await tracked(
    'SM-MTR-001',
    'Smart energy meter',
    '2100.00',
    '3600.00',
    'serial',
    'elec',
  );
  const oil = await tracked(
    'HV-OIL-001',
    'Compressor oil POE 1L',
    '310.00',
    '560.00',
    'batch',
    'cool',
    'l',
  );

  const orders: { id: string; reference: string; status: string }[] = [];
  const draft = async (
    key: string,
    lines: { item: DemoItem; quantity: string; unitPrice?: string }[],
    extra: Record<string, unknown> = {},
  ) => {
    const created = await ctx.call<Order>('store', 'POST', '/v1/purchasing/orders', {
      supplierId: supplier(key),
      currencyCode: 'EGP',
      deliveryLocationId: locations.warehouse,
      expectedDate: day(7),
      lines: lines.map((line) => ({
        itemId: line.item.id,
        quantityOrdered: line.quantity,
        unitPrice: line.unitPrice ?? line.item.cost,
        taxRateBp: 1400,
      })),
      ...extra,
    });
    return created;
  };
  const approve = (order: Order) =>
    ctx.call<Order>('owner', 'POST', `/v1/purchasing/orders/${order.order.id}/approve`, {
      expectedVersion: order.order.version,
    });
  const receive = (
    order: Order,
    lines: { line: number; quantity: string; lots?: Record<string, unknown>[] }[],
    note: string,
  ) =>
    ctx.call<Order>('store', 'POST', `/v1/purchasing/orders/${order.order.id}/receipts`, {
      expectedVersion: order.order.version,
      locationId: locations.warehouse,
      supplierNote: note,
      lines: lines.map((line) => ({
        orderLineId: order.lines[line.line]!.id,
        quantity: line.quantity,
        ...(line.lots === undefined ? {} : { lots: line.lots }),
      })),
    });
  const record = (order: Order) => {
    orders.push({
      id: order.order.id,
      reference: order.order.reference,
      status: order.order.status,
    });
  };

  // 1. Fully received: filters and the tracked items, with their serials and batches.
  let full = await approve(
    await draft(
      'cool',
      [
        { item: itemBySku(ctx, 'HV-FLT-001'), quantity: '100', unitPrice: '162.00' },
        { item: oil, quantity: '24' },
      ],
      { notes: 'Quarterly filter restock', expectedDate: day(-20) },
    ),
  );
  full = await receive(
    full,
    [
      { line: 0, quantity: '100' },
      {
        line: 1,
        quantity: '24',
        lots: [
          { code: 'POE-2409-A', expiresOn: day(400), quantity: '12' },
          { code: 'POE-2410-B', expiresOn: day(520), quantity: '12' },
        ],
      },
    ],
    'Delivery note DN-55120',
  );
  record(full);

  let meters = await approve(
    await draft('elec', [{ item: meter, quantity: '5' }], { expectedDate: day(-12) }),
  );
  meters = await receive(
    meters,
    [
      {
        line: 0,
        quantity: '5',
        lots: [1, 2, 3, 4, 5].map((n) => ({ code: `SEM-24-00${String(n)}`, quantity: '1' })),
      },
    ],
    'DN-88411',
  );
  record(meters);

  // 2. Partly received, with a return of damaged goods from the receipt.
  let partial = await approve(
    await draft(
      'elec',
      [
        { item: itemBySku(ctx, 'EL-LED-040'), quantity: '40' },
        { item: itemBySku(ctx, 'EL-RCD-040'), quantity: '10' },
      ],
      { expectedDate: day(-3), notes: 'Smart Village refit' },
    ),
  );
  partial = await receive(
    partial,
    [
      { line: 0, quantity: '25' },
      { line: 1, quantity: '10' },
    ],
    'Part delivery; balance next week',
  );
  const receipt = partial.receipts[0];
  const ledLine = receipt?.lines.find((line) => line.orderLineId === partial.lines[0]!.id);
  if (receipt !== undefined && ledLine !== undefined) {
    partial =
      (await ctx.attempt<Order>('store', 'POST', `/v1/purchasing/receipts/${receipt.id}/returns`, {
        reason: 'Two panels cracked in transit',
        lines: [{ receiptLineId: ledLine.id, quantity: '2' }],
      })) ?? partial;
  }
  record(partial);

  // 3. Approved and waiting for delivery.
  record(
    await approve(
      await draft(
        'plumb',
        [
          { item: itemBySku(ctx, 'PL-PMP-001'), quantity: '3' },
          { item: itemBySku(ctx, 'PL-VLV-022'), quantity: '30' },
        ],
        { expectedDate: day(5) },
      ),
    ),
  );

  // 4. A draft still being put together.
  record(
    await draft(
      'safety',
      [
        { item: itemBySku(ctx, 'SF-GLV-001'), quantity: '50' },
        { item: itemBySku(ctx, 'SF-HAR-001'), quantity: '2' },
      ],
      { notes: 'Waiting for the new harness sizes' },
    ),
  );

  // 5. Cancelled.
  const cancelled = await draft('cool', [{ item: itemBySku(ctx, 'EQ-SPL-240'), quantity: '4' }]);
  record(
    await ctx.call<Order>('owner', 'POST', `/v1/purchasing/orders/${cancelled.order.id}/cancel`, {
      expectedVersion: cancelled.order.version,
      reason: 'Customer postponed the installation',
    }),
  );

  // 6. From the reorder screen: the thermostat is below its minimum.
  const reorder = await ctx.attempt<{ orders: { id: string; reference: string }[] }>(
    'store',
    'POST',
    `/v1/inventory/locations/${locations.warehouse}/reorder`,
    {
      lines: [
        { itemId: itemBySku(ctx, 'HV-THM-200').id, supplierId: supplier('cool'), quantity: '10' },
      ],
    },
  );
  for (const order of reorder?.orders ?? []) {
    orders.push({ id: order.id, reference: order.reference, status: 'draft' });
  }
  ctx.refs.purchaseOrders = orders;

  // Van requests: one picked, one cancelled, one still open.
  interface VanRequest {
    id: string;
    version: number;
  }
  const ask = (
    as: 'engineer1' | 'engineer2' | 'engineer3',
    van: string,
    lines: [string, string][],
    notes: string,
  ) =>
    ctx.call<VanRequest>(as, 'POST', '/v1/inventory/van-requests', {
      vanLocationId: van,
      notes,
      lines: lines.map(([sku, quantity]) => ({ itemId: itemBySku(ctx, sku).id, quantity })),
    });
  const picked = await ask(
    'engineer1',
    locations.van1!,
    [
      ['HV-CAP-035', '3'],
      ['CN-TAP-019', '10'],
    ],
    'Running low after the Heliopolis jobs',
  );
  await ctx.call('store', 'POST', `/v1/inventory/van-requests/${picked.id}/pick`, {
    expectedVersion: picked.version,
    fromLocationId: locations.warehouse,
    lines: [
      { itemId: itemBySku(ctx, 'HV-CAP-035').id, quantity: '3' },
      { itemId: itemBySku(ctx, 'CN-TAP-019').id, quantity: '10' },
    ],
  });
  const withdrawn = await ask('engineer2', locations.van2!, [['SF-GLV-001', '4']], 'Gloves');
  await ctx.call('engineer2', 'POST', `/v1/inventory/van-requests/${withdrawn.id}/cancel`, {
    expectedVersion: withdrawn.version,
  });
  await ask(
    'engineer3',
    locations.van3!,
    [
      ['EL-MCB-032', '6'],
      ['EL-CBL-025', '50'],
    ],
    'For the school rewiring next week',
  );

  // Stock counts: Van 1 counted and posted (one filter short), a cancelled one.
  interface Count {
    count: { id: string; version: number };
  }
  const count = await ctx.call<Count>('store', 'POST', '/v1/inventory/counts', {
    locationId: locations.van1,
    notes: 'Monthly van check',
  });
  const counted = await ctx.call<Count>(
    'store',
    'PUT',
    `/v1/inventory/counts/${count.count.id}/lines`,
    {
      expectedVersion: count.count.version,
      lines: [
        { itemId: itemBySku(ctx, 'HV-FLT-001').id, countedQuantity: '9' },
        { itemId: itemBySku(ctx, 'EL-MCB-032').id, countedQuantity: '6' },
        { itemId: itemBySku(ctx, 'SF-GLV-001').id, countedQuantity: '5' },
      ],
    },
  );
  await ctx.call('store', 'POST', `/v1/inventory/counts/${count.count.id}/post`, {
    expectedVersion: counted.count.version,
  });
  const abandoned = await ctx.call<Count>('store', 'POST', '/v1/inventory/counts', {
    locationId: locations.secondary,
    notes: 'Started by mistake',
  });
  await ctx.call('store', 'POST', `/v1/inventory/counts/${abandoned.count.id}/cancel`, {
    expectedVersion: abandoned.count.version,
  });
  // And one in progress at the main warehouse.
  const open = await ctx.call<Count>('store', 'POST', '/v1/inventory/counts', {
    locationId: locations.warehouse,
    notes: 'Year-end count, aisle A',
  });
  await ctx.attempt('store', 'PUT', `/v1/inventory/counts/${open.count.id}/lines`, {
    expectedVersion: open.count.version,
    lines: [{ itemId: itemBySku(ctx, 'CN-SIL-300').id, countedQuantity: '52' }],
  });

  ctx.log(
    `${String(prices)} supplier prices, ${String(orders.length)} purchase orders, 2 tracked items, 3 van requests, 3 stock counts`,
  );
}
