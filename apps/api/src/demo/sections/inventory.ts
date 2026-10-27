import type { DemoContext } from '../context.js';

/**
 * The stock catalogue: categories, suppliers, items, the warehouse and vans,
 * opening stock and reorder levels. Sales, jobs, purchasing and manufacturing
 * all build on this.
 *
 * Adds to refs:
 *   suppliers  { id, name }[]
 *   items      { id, sku, name, kind, unit, cost, price, supplierId }[]  (index by sku with itemBySku)
 *   locations  { warehouse, secondary, van1, van2, van3 } → location id
 */

export interface DemoItem {
  id: string;
  sku: string;
  name: string;
  kind: 'stock_item' | 'non_stock_item' | 'service';
  unit: string;
  cost: string;
  price: string;
  supplierId: string | null;
}

/** The item with this SKU, or throws: a typo here is a bug in the seed. */
export function itemBySku(ctx: DemoContext, sku: string): DemoItem {
  const item = (ctx.refs.items as DemoItem[] | undefined)?.find(
    (candidate) => candidate.sku === sku,
  );
  if (item === undefined) {
    throw new Error(`demo item ${sku} is missing`);
  }
  return item;
}

const SUPPLIERS = [
  {
    key: 'cool',
    name: 'Cairo Cooling Supplies',
    contactName: 'Ashraf Nasr',
    email: 'orders@cairocooling.example.com',
    phone: '+20 2 2590 1111',
    paymentTerms: '30 days',
    leadTimeDays: 5,
    taxReference: '100-200-301',
    city: 'Cairo',
  },
  {
    key: 'elec',
    name: 'Delta Electrical Wholesale',
    contactName: 'Rasha Galal',
    email: 'sales@deltaelectrical.example.com',
    phone: '+20 2 2591 2222',
    paymentTerms: '45 days',
    leadTimeDays: 3,
    taxReference: '100-200-302',
    city: 'Tanta',
  },
  {
    key: 'plumb',
    name: 'Pyramids Plumbing & Gas',
    contactName: 'Magdy Sobhy',
    email: 'trade@pyramidsplumbing.example.com',
    phone: '+20 2 2592 3333',
    paymentTerms: '30 days',
    leadTimeDays: 7,
    taxReference: '100-200-303',
    city: 'Giza',
  },
  {
    key: 'safety',
    name: 'SafeWork PPE Egypt',
    contactName: 'Mona Yassin',
    email: 'hello@safeworkppe.example.com',
    phone: '+20 2 2593 4444',
    paymentTerms: 'On order',
    leadTimeDays: 2,
    taxReference: '100-200-304',
    city: 'Cairo',
  },
] as const;

const CATEGORIES = [
  'HVAC parts',
  'Electrical',
  'Plumbing & gas',
  'Consumables',
  'Safety equipment',
  'Equipment',
  'Services',
] as const;

interface ItemSeed {
  sku: string;
  name: string;
  category: (typeof CATEGORIES)[number];
  kind?: DemoItem['kind'];
  unit?: string;
  cost: string;
  price: string;
  supplier?: (typeof SUPPLIERS)[number]['key'];
  /** Opening stock in the main warehouse, and on each van. */
  stock?: { warehouse: number; van?: number };
  minimum?: number;
  barcode?: string;
}

const ITEMS: readonly ItemSeed[] = [
  {
    sku: 'HV-FLT-001',
    name: 'Air filter 600×600 G4',
    category: 'HVAC parts',
    cost: '180.00',
    price: '320.00',
    supplier: 'cool',
    stock: { warehouse: 120, van: 10 },
    minimum: 40,
    barcode: '6221000000011',
  },
  {
    sku: 'HV-CAP-035',
    name: 'Run capacitor 35µF',
    category: 'HVAC parts',
    cost: '95.00',
    price: '210.00',
    supplier: 'cool',
    stock: { warehouse: 45, van: 4 },
    minimum: 15,
  },
  {
    sku: 'HV-FAN-250',
    name: 'Condenser fan motor 250W',
    category: 'HVAC parts',
    cost: '1450.00',
    price: '2600.00',
    supplier: 'cool',
    stock: { warehouse: 8 },
    minimum: 4,
  },
  {
    sku: 'HV-GAS-410',
    name: 'Refrigerant R410A (11.3 kg)',
    category: 'HVAC parts',
    cost: '3900.00',
    price: '6200.00',
    supplier: 'cool',
    stock: { warehouse: 6 },
    minimum: 3,
  },
  {
    sku: 'HV-THM-200',
    name: 'Programmable thermostat',
    category: 'HVAC parts',
    cost: '850.00',
    price: '1600.00',
    supplier: 'cool',
    stock: { warehouse: 3 },
    minimum: 5,
  },
  {
    sku: 'EL-MCB-032',
    name: 'MCB 32A single pole',
    category: 'Electrical',
    cost: '110.00',
    price: '240.00',
    supplier: 'elec',
    stock: { warehouse: 80, van: 6 },
    minimum: 20,
  },
  {
    sku: 'EL-RCD-040',
    name: 'RCD 40A 30mA',
    category: 'Electrical',
    cost: '640.00',
    price: '1150.00',
    supplier: 'elec',
    stock: { warehouse: 18, van: 2 },
    minimum: 6,
  },
  {
    sku: 'EL-CBL-025',
    name: 'Cable 2.5mm² twin & earth',
    category: 'Electrical',
    unit: 'm',
    cost: '22.00',
    price: '45.00',
    supplier: 'elec',
    stock: { warehouse: 600, van: 50 },
    minimum: 200,
  },
  {
    sku: 'EL-LED-040',
    name: 'LED panel 600×600 40W',
    category: 'Electrical',
    cost: '520.00',
    price: '950.00',
    supplier: 'elec',
    stock: { warehouse: 35 },
    minimum: 10,
  },
  {
    sku: 'PL-VLV-022',
    name: 'Ball valve 22mm',
    category: 'Plumbing & gas',
    cost: '140.00',
    price: '290.00',
    supplier: 'plumb',
    stock: { warehouse: 40, van: 4 },
    minimum: 12,
  },
  {
    sku: 'PL-PMP-001',
    name: 'Circulation pump',
    category: 'Plumbing & gas',
    cost: '2750.00',
    price: '4600.00',
    supplier: 'plumb',
    stock: { warehouse: 4 },
    minimum: 2,
  },
  {
    sku: 'PL-GDT-001',
    name: 'Gas leak detector',
    category: 'Plumbing & gas',
    cost: '1250.00',
    price: '2300.00',
    supplier: 'plumb',
    stock: { warehouse: 5 },
    minimum: 2,
  },
  {
    sku: 'CN-TAP-019',
    name: 'Insulation tape 19mm',
    category: 'Consumables',
    unit: 'roll',
    cost: '12.00',
    price: '30.00',
    supplier: 'elec',
    stock: { warehouse: 200, van: 20 },
    minimum: 50,
  },
  {
    sku: 'CN-SIL-300',
    name: 'Silicone sealant 300ml',
    category: 'Consumables',
    cost: '65.00',
    price: '130.00',
    supplier: 'plumb',
    stock: { warehouse: 60, van: 6 },
    minimum: 20,
  },
  {
    sku: 'CN-CLN-005',
    name: 'Coil cleaner 5L',
    category: 'Consumables',
    unit: 'l',
    cost: '45.00',
    price: '95.00',
    supplier: 'cool',
    stock: { warehouse: 50 },
    minimum: 15,
  },
  {
    sku: 'SF-GLV-001',
    name: 'Work gloves',
    category: 'Safety equipment',
    unit: 'pair',
    cost: '35.00',
    price: '70.00',
    supplier: 'safety',
    stock: { warehouse: 100, van: 5 },
    minimum: 30,
  },
  {
    sku: 'SF-HAR-001',
    name: 'Safety harness',
    category: 'Safety equipment',
    cost: '1800.00',
    price: '3200.00',
    supplier: 'safety',
    stock: { warehouse: 6 },
    minimum: 2,
  },
  {
    sku: 'EQ-SPL-120',
    name: 'Split AC unit 12,000 BTU',
    category: 'Equipment',
    cost: '14500.00',
    price: '21500.00',
    supplier: 'cool',
    stock: { warehouse: 10 },
    minimum: 3,
  },
  {
    sku: 'EQ-SPL-240',
    name: 'Split AC unit 24,000 BTU',
    category: 'Equipment',
    cost: '23500.00',
    price: '33900.00',
    supplier: 'cool',
    stock: { warehouse: 6 },
    minimum: 2,
  },
  {
    sku: 'EQ-WHT-080',
    name: 'Electric water heater 80L',
    category: 'Equipment',
    cost: '5200.00',
    price: '7900.00',
    supplier: 'plumb',
    stock: { warehouse: 7 },
    minimum: 2,
  },
  {
    sku: 'EQ-BRK-KIT',
    name: 'AC mounting bracket kit',
    category: 'Equipment',
    kind: 'non_stock_item',
    cost: '450.00',
    price: '850.00',
    supplier: 'cool',
  },
  {
    sku: 'SV-LAB-HR',
    name: 'Engineer labour (per hour)',
    category: 'Services',
    kind: 'service',
    unit: 'hour',
    cost: '250.00',
    price: '650.00',
  },
  {
    sku: 'SV-CALL-OUT',
    name: 'Emergency call-out fee',
    category: 'Services',
    kind: 'service',
    cost: '0.00',
    price: '1200.00',
  },
  {
    sku: 'SV-PPM-VISIT',
    name: 'Planned maintenance visit',
    category: 'Services',
    kind: 'service',
    cost: '400.00',
    price: '1800.00',
  },
];

export async function seedInventory(ctx: DemoContext): Promise<void> {
  const suppliers: { id: string; name: string; key: string }[] = [];
  for (const seed of SUPPLIERS) {
    const { key, city, ...body } = seed;
    const created = await ctx.call<{ id: string }>('store', 'POST', '/v1/purchasing/suppliers', {
      ...body,
      address: { line1: 'Industrial area', city, countryCode: 'EG' },
    });
    suppliers.push({ id: created.id, name: seed.name, key });
  }
  ctx.refs.suppliers = suppliers;

  const categories: Record<string, string> = {};
  for (const name of CATEGORIES) {
    categories[name] = (
      await ctx.call<{ id: string }>('store', 'POST', '/v1/inventory/categories', { name })
    ).id;
  }

  const location = async (body: Record<string, unknown>) =>
    (await ctx.call<{ id: string }>('store', 'POST', '/v1/inventory/locations', body)).id;
  const locations = {
    warehouse: await location({
      name: 'Main warehouse — Nasr City',
      kind: 'warehouse',
      notes: 'Racks A–F. Deliveries 8:00–14:00.',
    }),
    secondary: await location({ name: 'Alexandria store', kind: 'warehouse' }),
    van1: await location({
      name: 'Van 1 — Youssef',
      kind: 'van',
      assignedTo: ctx.people.engineer1.userId,
    }),
    van2: await location({
      name: 'Van 2 — Mariam',
      kind: 'van',
      assignedTo: ctx.people.engineer2.userId,
    }),
    van3: await location({
      name: 'Van 3 — Ahmed',
      kind: 'van',
      assignedTo: ctx.people.engineer3.userId,
    }),
  };
  ctx.refs.locations = locations;

  const items: DemoItem[] = [];
  for (const seed of ITEMS) {
    const supplier = suppliers.find((candidate) => candidate.key === seed.supplier);
    const created = await ctx.call<{ id: string; kind: DemoItem['kind']; unit: string }>(
      'store',
      'POST',
      '/v1/inventory/items',
      {
        sku: seed.sku,
        name: seed.name,
        kind: seed.kind ?? 'stock_item',
        categoryId: categories[seed.category],
        unit: seed.unit ?? 'each',
        defaultUnitCost: seed.cost,
        salePrice: seed.price,
        ...(supplier === undefined
          ? {}
          : {
              preferredSupplierId: supplier.id,
              supplierPartNumber: `${supplier.key.toUpperCase()}-${seed.sku}`,
              leadTimeDays: 5,
            }),
        ...(seed.barcode === undefined ? {} : { barcode: seed.barcode }),
      },
    );
    items.push({
      id: created.id,
      sku: seed.sku,
      name: seed.name,
      kind: created.kind,
      unit: created.unit,
      cost: seed.cost,
      price: seed.price,
      supplierId: supplier?.id ?? null,
    });

    // Opening stock, then some of it out onto the vans.
    if (seed.stock !== undefined) {
      await ctx.call('store', 'POST', '/v1/inventory/movements', {
        type: 'receipt',
        itemId: created.id,
        locationId: locations.warehouse,
        quantity: String(seed.stock.warehouse),
        unitCost: seed.cost,
        reason: 'Opening stock',
      });
      if (seed.stock.van !== undefined) {
        for (const van of [locations.van1, locations.van2, locations.van3]) {
          await ctx.call('store', 'POST', '/v1/inventory/movements', {
            type: 'transfer',
            itemId: created.id,
            fromLocationId: locations.warehouse,
            toLocationId: van,
            quantity: String(seed.stock.van),
            reason: 'Van top-up',
          });
        }
      }
    }
    if (seed.minimum !== undefined) {
      await ctx.call('store', 'PUT', `/v1/inventory/items/${created.id}/reorder-levels`, {
        levels: [{ locationId: locations.warehouse, minimum: String(seed.minimum) }],
      });
    }
  }
  ctx.refs.items = items;

  // A little history: a damaged item written off, a stock transfer to Alexandria.
  await ctx.call('store', 'POST', '/v1/inventory/movements', {
    type: 'adjustment',
    itemId: itemBySku(ctx, 'EL-LED-040').id,
    locationId: locations.warehouse,
    direction: 'out',
    quantity: '2',
    reason: 'Damaged in delivery',
  });
  await ctx.call('store', 'POST', '/v1/inventory/movements', {
    type: 'transfer',
    itemId: itemBySku(ctx, 'HV-FLT-001').id,
    fromLocationId: locations.warehouse,
    toLocationId: locations.secondary,
    quantity: '30',
    reason: 'Stock for Alexandria jobs',
  });

  ctx.log(
    `${String(suppliers.length)} suppliers, ${String(items.length)} items, ${String(Object.keys(locations).length)} locations with opening stock`,
  );
}
