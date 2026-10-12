import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Bills of materials and assembly over HTTP (seventh round; ADR-0011): kept by
 * owners, admins and inventory managers, read by viewers; an assembly takes
 * its parts out at their cost and brings the item in at their cost plus
 * labour and overhead; a shortage moves nothing; completing twice moves
 * stock once; a disassembly puts the parts back; the ledger gets one entry.
 */

let api: ApiHarness;
let staff: PlatformAdmin;
let owner: Member;
let storekeeper: Member;
let viewer: Member;
let engineer: Member;
const tokens = new Map<Member, string>();

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

async function token(who: Member): Promise<string> {
  let value = tokens.get(who);
  if (value === undefined) {
    value = await api.signIn(who);
    tokens.set(who, value);
  }
  return value;
}

async function call(
  who: Member,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) {
  return api.call(await token(who), {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
}

async function flag(key: string, enabled: boolean) {
  const response = await api.call(staff.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function newItem(sku: string, extra: Record<string, unknown> = {}) {
  const response = await call(storekeeper, 'POST', '/v1/inventory/items', {
    sku,
    name: sku,
    ...extra,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ id: string }>(response).id;
}

async function onHand(itemId: string, locationId: string): Promise<string> {
  const balances = json<{ items: { location: { id: string }; onHand: string }[] }>(
    await call(owner, 'GET', `/v1/inventory/balances?itemId=${itemId}`),
  );
  return balances.items.find((row) => row.location.id === locationId)?.onHand ?? '0';
}

interface Order {
  id: string;
  reference: string;
  status: string;
  version: number;
  unitCost: string | null;
  needs: { item: { id: string }; quantity: string; available: string; short: string }[];
  outputs: { item: { id: string }; quantity: string }[];
  can: { complete: boolean };
}

let pump: string;
let hose: string;
let clip: string;
let kit: string;
let fitting: string;
let store: string;

beforeAll(async () => {
  api = await startApi();
  staff = await api.platformAdmin('mfg-staff');
  owner = await api.member('owner', 'mfg-owner');
  storekeeper = await api.member('inventory_manager', 'mfg-store');
  viewer = await api.member('viewer', 'mfg-viewer');
  engineer = await api.member('engineer', 'mfg-engineer');
  await flag('inventory', true);
  await flag('ledger', true);
  const setUp = await call(owner, 'POST', '/v1/ledger/setup', { startDate: '2026-01-01' });
  expect(setUp.statusCode, setUp.body).toBe(201);
  pump = await newItem('PUMP');
  hose = await newItem('HOSE', { unit: 'm' });
  clip = await newItem('CLIP', { kind: 'non_stock_item', defaultUnitCost: '2' });
  kit = await newItem('KIT');
  fitting = await newItem('FITTING', { kind: 'service' });
  const location = await call(storekeeper, 'POST', '/v1/inventory/locations', {
    name: 'Workshop',
    kind: 'warehouse',
  });
  store = json<{ id: string }>(location).id;
  for (const [itemId, quantity, unitCost] of [
    [pump, '3', '1000'],
    [hose, '10', '20'],
  ] as const) {
    const received = await call(storekeeper, 'POST', '/v1/inventory/movements', {
      type: 'receipt',
      itemId,
      locationId: store,
      quantity,
      unitCost,
    });
    expect(received.statusCode, received.body).toBe(201);
  }
});

afterAll(async () => {
  await api.close();
});

describe('bills of materials', () => {
  it('need the manufacturing module, and are kept by the store and read by viewers', async () => {
    expect(code(await call(storekeeper, 'GET', '/v1/manufacturing/boms'))).toBe('feature_disabled');
    await flag('manufacturing', true);
    const saved = await call(storekeeper, 'PUT', `/v1/manufacturing/boms/items/${kit}`, {
      labourCost: '50',
      overheadCost: '10',
      components: [
        { itemId: pump, quantity: '1' },
        { itemId: hose, quantity: '2.5' },
        { itemId: clip, quantity: '4' },
      ],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    // 1,000 + 50 of hose + 8 of clips + 50 + 10.
    expect(json<{ version: number; unitCost: string }>(saved)).toMatchObject({
      version: 1,
      unitCost: '1118',
    });
    const read = json<{ current: { unitCost: string | null } }>(
      await call(viewer, 'GET', `/v1/manufacturing/boms/items/${kit}`),
    );
    expect(read.current.unitCost).toBeNull();
    // Any version opens by its id, and keeps what it held.
    const version = json<{ id: string; version: number; components: unknown[] }>(
      await call(viewer, 'GET', `/v1/manufacturing/boms/${json<{ id: string }>(saved).id}`),
    );
    expect(version).toMatchObject({ version: 1 });
    expect(version.components).toHaveLength(3);
    expect((await call(engineer, 'GET', '/v1/manufacturing/boms')).statusCode).toBe(403);
    expect(
      (
        await call(viewer, 'PUT', `/v1/manufacturing/boms/items/${kit}`, {
          components: [{ itemId: pump, quantity: '1' }],
        })
      ).statusCode,
    ).toBe(403);
  });

  it('never contain themselves, nor a service', async () => {
    expect(
      code(
        await call(storekeeper, 'PUT', `/v1/manufacturing/boms/items/${pump}`, {
          components: [{ itemId: kit, quantity: '1' }],
        }),
      ),
    ).toBe('contains_itself');
    expect(
      code(
        await call(storekeeper, 'PUT', `/v1/manufacturing/boms/items/${pump}`, {
          components: [{ itemId: fitting, quantity: '1' }],
        }),
      ),
    ).toBe('component_kind');
  });
});

describe('assembly orders', () => {
  it('take the parts out and bring the item in at their cost, once', async () => {
    const drafted = await call(storekeeper, 'POST', '/v1/manufacturing/orders', {
      itemId: kit,
      locationId: store,
      quantity: '2',
    });
    expect(drafted.statusCode, drafted.body).toBe(201);
    const order = json<Order>(drafted);
    expect(order.reference).toMatch(/^AO-\d{6}$/u);
    // The clips are not stocked, so not taken out.
    expect(order.needs.map((need) => [need.item.id, need.quantity, need.short])).toEqual([
      [pump, '2', '0'],
      [hose, '5', '0'],
    ]);
    expect(order.can.complete).toBe(true);

    const completed = await call(
      storekeeper,
      'POST',
      `/v1/manufacturing/orders/${order.id}/complete`,
      {
        expectedVersion: order.version,
      },
    );
    expect(completed.statusCode, completed.body).toBe(200);
    expect(json<Order>(completed)).toMatchObject({ status: 'completed', unitCost: '1118' });
    const again = await call(storekeeper, 'POST', `/v1/manufacturing/orders/${order.id}/complete`, {
      expectedVersion: order.version,
    });
    expect(again.statusCode).toBe(200);
    expect(await onHand(kit, store)).toBe('2');
    expect(await onHand(pump, store)).toBe('1');
    expect(await onHand(hose, store)).toBe('5');
    const detail = json<{ item: { averageUnitCost: string } }>(
      await call(owner, 'GET', `/v1/inventory/items/${kit}`),
    );
    expect(detail.item.averageUnitCost).toBe('1118');

    const posted = json<{
      items: { source: { kind: string; id: string }; status: string; amount: string }[];
    }>(await call(owner, 'GET', '/v1/ledger/postings?status=posted&limit=200')).items.filter(
      (posting) => posting.source.id === order.id,
    );
    // Labour, overhead and the clips: 2 × 68.
    expect(posted).toMatchObject([{ source: { kind: 'assembly' }, amount: '136' }]);
  });

  it('refuse a shortage, moving nothing', async () => {
    const order = json<Order>(
      await call(storekeeper, 'POST', '/v1/manufacturing/orders', {
        itemId: kit,
        locationId: store,
        quantity: '2',
      }),
    );
    expect(order.needs[0]).toMatchObject({ available: '1', short: '1' });
    expect(order.can.complete).toBe(false);
    const refused = await call(
      storekeeper,
      'POST',
      `/v1/manufacturing/orders/${order.id}/complete`,
      { expectedVersion: order.version },
    );
    expect(code(refused)).toBe('shortage');
    // Each short item says by how much, for the screen to say it in its language.
    const details = json<{ error: { details: { params: Record<string, string> }[] } }>(refused)
      .error.details;
    expect(details).toHaveLength(1);
    expect(details[0]?.params).toMatchObject({
      itemId: pump,
      short: '1',
      needed: '2',
      available: '1',
    });
    expect(await onHand(pump, store)).toBe('1');
    const cancelled = await call(owner, 'POST', `/v1/manufacturing/orders/${order.id}/cancel`, {
      expectedVersion: order.version,
    });
    expect(json<Order>(cancelled).status).toBe('cancelled');
  });

  it('take a unit apart into its parts', async () => {
    const order = json<Order>(
      await call(storekeeper, 'POST', '/v1/manufacturing/orders', {
        direction: 'disassemble',
        itemId: kit,
        locationId: store,
        quantity: '1',
      }),
    );
    expect(order.needs.map((need) => need.item.id)).toEqual([kit]);
    expect(order.outputs.map((output) => [output.item.id, output.quantity])).toEqual([
      [pump, '1'],
      [hose, '2.5'],
    ]);
    const done = await call(storekeeper, 'POST', `/v1/manufacturing/orders/${order.id}/complete`, {
      expectedVersion: order.version,
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(await onHand(kit, store)).toBe('1');
    expect(await onHand(pump, store)).toBe('2');
    expect(await onHand(hose, store)).toBe('7.5');
  });
});

describe('planning', () => {
  interface Plan {
    id: string;
    suggestions: {
      id: string;
      item: { id: string };
      action: string;
      quantity: string;
      leadTimeDays: number;
      supplier: { name: string } | null;
      drafted: { kind: string; reference: string } | null;
    }[];
  }

  it('suggests building what is short and buying its missing parts, and drafts them on request', async () => {
    await flag('purchasing', true);
    const supplier = await call(storekeeper, 'POST', '/v1/purchasing/suppliers', {
      name: 'Acme Pumps',
      leadTimeDays: 7,
    });
    expect(supplier.statusCode, supplier.body).toBe(201);
    const supplierId = json<{ id: string }>(supplier).id;
    for (const [itemId, extra] of [
      [pump, { preferredSupplierId: supplierId }],
      [kit, { leadTimeDays: 2 }],
    ] as const) {
      const current = json<{ item: { version: number } }>(
        await call(owner, 'GET', `/v1/inventory/items/${itemId}`),
      );
      const updated = await call(storekeeper, 'PATCH', `/v1/inventory/items/${itemId}`, {
        expectedVersion: current.item.version,
        ...extra,
      });
      expect(updated.statusCode, updated.body).toBe(200);
    }
    // One kit on hand, four wanted there.
    const levels = await call(storekeeper, 'PUT', `/v1/inventory/items/${kit}/reorder-levels`, {
      levels: [{ locationId: store, minimum: '4' }],
    });
    expect(levels.statusCode, levels.body).toBe(200);

    const ran = await call(storekeeper, 'POST', '/v1/manufacturing/plans', { horizonDays: 30 });
    expect(ran.statusCode, ran.body).toBe(201);
    const plan = json<Plan>(ran);
    // Three kits to build need three pumps (two held), 7.5 m of hose (7.5 held) and
    // twelve clips, which are never stocked.
    const byItem = (rows: Plan['suggestions']) =>
      rows.map((row) => [row.item.id, row.action, row.quantity]).sort();
    expect(byItem(plan.suggestions)).toEqual(
      [
        [kit, 'build', '3'],
        [pump, 'buy', '1'],
        [clip, 'buy', '12'],
      ].sort(),
    );
    const pumpRow = plan.suggestions.find((row) => row.item.id === pump)!;
    const kitRow = plan.suggestions.find((row) => row.item.id === kit)!;
    const clipRow = plan.suggestions.find((row) => row.item.id === clip)!;
    expect(pumpRow).toMatchObject({ leadTimeDays: 7, supplier: { name: 'Acme Pumps' } });
    expect(clipRow.supplier).toBeNull();
    expect(
      (await call(viewer, 'POST', '/v1/manufacturing/plans', { horizonDays: 30 })).statusCode,
    ).toBe(403);

    // Nobody to buy the clips from yet.
    expect(
      code(
        await call(storekeeper, 'POST', `/v1/manufacturing/plans/${plan.id}/draft`, {
          suggestionIds: [clipRow.id],
          locationId: store,
        }),
      ),
    ).toBe('no_supplier');
    const drafted = await call(storekeeper, 'POST', `/v1/manufacturing/plans/${plan.id}/draft`, {
      suggestionIds: [kitRow.id, pumpRow.id],
      locationId: store,
    });
    expect(drafted.statusCode, drafted.body).toBe(200);
    const result = json<{
      assemblyOrders: { id: string; reference: string }[];
      purchaseOrders: { id: string; reference: string }[];
      plan: Plan;
    }>(drafted);
    expect(result.assemblyOrders).toHaveLength(1);
    expect(result.purchaseOrders.map((order) => order.reference)).toEqual([
      expect.stringMatching(/^PO-\d{6}$/u),
    ]);
    expect(result.plan.suggestions.filter((row) => row.drafted !== null)).toHaveLength(2);
    expect(
      result.plan.suggestions
        .flatMap((row) => (row.drafted === null ? [] : [row.drafted.reference]))
        .sort(),
    ).toEqual([result.assemblyOrders[0]!.reference, result.purchaseOrders[0]!.reference].sort());
    const order = json<{ order: { status: string } }>(
      await call(owner, 'GET', `/v1/purchasing/orders/${result.purchaseOrders[0]!.id}`),
    );
    // Drafted, still to be approved as usual.
    expect(order.order.status).toBe('draft');
    expect(
      code(
        await call(storekeeper, 'POST', `/v1/manufacturing/plans/${plan.id}/draft`, {
          suggestionIds: [kitRow.id],
          locationId: store,
        }),
      ),
    ).toBe('already_drafted');

    // The drafted assembly now counts, so no more kits; the purchase order is not
    // approved yet, so the pump is still short.
    const again = json<Plan>(
      await call(storekeeper, 'POST', '/v1/manufacturing/plans', { horizonDays: 30 }),
    );
    expect(byItem(again.suggestions)).toEqual(
      [
        [pump, 'buy', '1'],
        [clip, 'buy', '12'],
      ].sort(),
    );
  });
});
