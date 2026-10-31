import { day, type DemoContext } from '../context.js';
import { type DemoItem, itemBySku } from './inventory.js';

/**
 * Manufacturing: two kits assembled from stock, their bills of materials
 * (one revised, so the version history shows), assembly orders in each state
 * and a material plan with some of its suggestions drafted.
 *
 * Adds to refs:
 *   items             two more: KT-AC-INST (AC installation kit), KT-PPM-SVC (PPM service kit)
 *   assemblyOrders    { id, reference, status }[]
 */

interface AssemblyOrder {
  id: string;
  reference: string;
  status: string;
  version: number;
}

export async function seedManufacturing(ctx: DemoContext): Promise<void> {
  const items = ctx.refs.items as DemoItem[];
  const locations = ctx.refs.locations as Record<string, string>;

  const kit = async (sku: string, name: string, price: string) => {
    const created = await ctx.call<{ id: string; kind: DemoItem['kind']; unit: string }>(
      'store',
      'POST',
      '/v1/inventory/items',
      { sku, name, kind: 'stock_item', unit: 'set', salePrice: price, leadTimeDays: 1 },
    );
    const item: DemoItem = {
      id: created.id,
      sku,
      name,
      kind: created.kind,
      unit: created.unit,
      cost: '0.00',
      price,
      supplierId: null,
    };
    items.push(item);
    return item;
  };
  const component = (sku: string, quantity: string) => ({
    itemId: itemBySku(ctx, sku).id,
    quantity,
  });

  const acKit = await kit('KT-AC-INST', 'AC installation kit', '1900.00');
  const ppmKit = await kit('KT-PPM-SVC', 'PPM service kit', '780.00');

  // The AC kit's bill, then a revision that adds tape: two versions to compare.
  await ctx.call('store', 'PUT', `/v1/manufacturing/boms/items/${acKit.id}`, {
    labourCost: '80.00',
    note: 'First version',
    components: [
      component('EL-CBL-025', '5'),
      component('EL-MCB-032', '1'),
      component('CN-SIL-300', '1'),
    ],
  });
  await ctx.call('store', 'PUT', `/v1/manufacturing/boms/items/${acKit.id}`, {
    labourCost: '80.00',
    overheadCost: '20.00',
    note: 'Added insulation tape after site feedback',
    components: [
      component('EL-CBL-025', '5'),
      component('EL-MCB-032', '1'),
      component('CN-SIL-300', '1'),
      component('CN-TAP-019', '2'),
    ],
  });
  await ctx.call('store', 'PUT', `/v1/manufacturing/boms/items/${ppmKit.id}`, {
    labourCost: '40.00',
    note: 'Standard quarterly service',
    components: [
      component('HV-FLT-001', '2'),
      component('CN-CLN-005', '1'),
      component('SF-GLV-001', '1'),
    ],
  });

  const orders: { id: string; reference: string; status: string }[] = [];
  const draft = (item: DemoItem, quantity: string, note: string, plannedFor: string) =>
    ctx.call<AssemblyOrder>('store', 'POST', '/v1/manufacturing/orders', {
      direction: 'assemble',
      itemId: item.id,
      locationId: locations.warehouse,
      quantity,
      note,
      plannedFor,
    });

  // Completed: kits in stock, costed from their parts.
  for (const [item, quantity] of [
    [acKit, '4'],
    [ppmKit, '10'],
  ] as const) {
    const order = await draft(item, quantity, 'Build for this month', day(-5));
    const done = await ctx.call<AssemblyOrder>(
      'store',
      'POST',
      `/v1/manufacturing/orders/${order.id}/complete`,
      {
        expectedVersion: order.version,
      },
    );
    orders.push({ id: done.id, reference: done.reference, status: done.status });
  }

  // Open: planned for next week.
  const open = await draft(acKit, '6', 'For the Red Sea resort installations', day(6));
  orders.push({ id: open.id, reference: open.reference, status: open.status });

  // Cancelled.
  const dropped = await draft(ppmKit, '20', 'Duplicate of the monthly build', day(2));
  const cancelled = await ctx.call<AssemblyOrder>(
    'store',
    'POST',
    `/v1/manufacturing/orders/${dropped.id}/cancel`,
    {
      expectedVersion: dropped.version,
    },
  );
  orders.push({ id: cancelled.id, reference: cancelled.reference, status: cancelled.status });
  ctx.refs.assemblyOrders = orders;

  // Keep more PPM kits than are on hand, so the plan has something to suggest.
  await ctx.call('store', 'PUT', `/v1/inventory/items/${ppmKit.id}/reorder-levels`, {
    levels: [{ locationId: locations.warehouse, minimum: '25' }],
  });
  interface Plan {
    id: string;
    suggestions: { id: string; action: string }[];
  }
  const plan = await ctx.call<Plan>('store', 'POST', '/v1/manufacturing/plans', {
    horizonDays: 30,
  });
  // Draft the build, leave any purchase suggestions for somebody to look at.
  const assemble = plan.suggestions.filter((row) => row.action === 'build');
  let drafted = 0;
  if (assemble.length > 0) {
    const result = await ctx.attempt<{ assemblyOrders: unknown[]; purchaseOrders: unknown[] }>(
      'store',
      'POST',
      `/v1/manufacturing/plans/${plan.id}/draft`,
      { suggestionIds: assemble.map((row) => row.id), locationId: locations.warehouse },
    );
    drafted = (result?.assemblyOrders.length ?? 0) + (result?.purchaseOrders.length ?? 0);
  }

  ctx.log(
    `2 kits with bills of materials, ${String(orders.length)} assembly orders, a plan with ${String(plan.suggestions.length)} suggestions (${String(drafted)} drafted)`,
  );
}
