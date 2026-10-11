import { getPlatformDataSource, withTenant } from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * The catalogue, locations, the stock ledger and counts over HTTP (CRM/ERP
 * plan, phase E1): the module switch, who may do what, costs only for those
 * who move stock, nothing below zero, and every posting exactly once.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let dispatcher: Member;
let engineer: Member;
let viewer: Member;
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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: Record<string, unknown>,
  key?: string | null,
) {
  return api.call(await token(who), {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    ...(key === null || key === undefined ? {} : { headers: { 'idempotency-key': key } }),
  });
}

interface ItemBody {
  id: string;
  sku: string;
  averageUnitCost: string | null;
  defaultUnitCost: string | null;
  version: number;
}
interface LocationBody {
  id: string;
  name: string;
  kind: string;
  assignedTo: string | null;
  version: number;
}

const tag = () => randomUUID().slice(0, 6);

async function newItem(payload: Record<string, unknown> = {}): Promise<ItemBody> {
  const response = await call(dispatcher, 'POST', '/v1/inventory/items', {
    sku: `SKU-${tag()}`,
    name: `Item ${tag()}`,
    ...payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<ItemBody>(response);
}

async function newLocation(payload: Record<string, unknown> = {}): Promise<LocationBody> {
  const response = await call(dispatcher, 'POST', '/v1/inventory/locations', {
    name: `Store ${tag()}`,
    kind: 'warehouse',
    ...payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<LocationBody>(response);
}

function post(
  payload: Record<string, unknown>,
  who: Member = dispatcher,
  key: string | null = randomUUID(),
) {
  return call(who, 'POST', '/v1/inventory/movements', payload, key);
}

async function onHand(itemId: string, locationId: string): Promise<string> {
  const balances = json<{ items: { location: { id: string }; onHand: string }[] }>(
    await call(viewer, 'GET', `/v1/inventory/balances?itemId=${itemId}`),
  );
  return balances.items.find((row) => row.location.id === locationId)?.onHand ?? '0';
}

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin('inv-staff');
  owner = await api.member('owner', 'inv-owner');
  dispatcher = await api.member('dispatcher', 'inv-dispatcher');
  engineer = await api.member('engineer', 'inv-engineer');
  viewer = await api.member('viewer', 'inv-viewer');
});

afterAll(async () => {
  await api.close();
});

async function setFlag(key: string, enabled: boolean) {
  const response = await api.call(admin.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

describe('the inventory module switch', () => {
  it('refuses every inventory route until Integr8 switches it on', async () => {
    const before = await call(owner, 'GET', '/v1/inventory/items');
    expect(before.statusCode).toBe(403);
    expect(code(before)).toBe('feature_disabled');

    await setFlag('inventory', true);
    const me = json<{ features: Record<string, boolean> }>(await call(owner, 'GET', '/v1/me'));
    expect(me.features).toMatchObject({ inventory: true, purchasing: false });
    expect((await call(owner, 'GET', '/v1/inventory/items')).statusCode).toBe(200);
  });
});

describe('the catalogue', () => {
  it('adds items, refuses a taken SKU, and finds one by barcode', async () => {
    const category = json<{ id: string }>(
      await call(dispatcher, 'POST', '/v1/inventory/categories', { name: `Valves ${tag()}` }),
    );
    const sku = `VAL-${tag()}`;
    const barcode = `629${Date.now()}`;
    const item = await newItem({
      sku,
      name: 'Ball valve 15mm',
      categoryId: category.id,
      unit: 'each',
      barcode,
      defaultUnitCost: '120.5',
    });
    expect(item).toMatchObject({ sku, defaultUnitCost: '120.5', averageUnitCost: '0' });

    const taken = await call(dispatcher, 'POST', '/v1/inventory/items', {
      sku: sku.toLowerCase(),
      name: 'Duplicate',
    });
    expect(taken.statusCode).toBe(409);
    expect(code(taken)).toBe('sku_taken');

    const found = await call(engineer, 'GET', `/v1/inventory/lookup?barcode=${barcode}`);
    expect(found.statusCode).toBe(200);
    expect(json<ItemBody>(found)).toMatchObject({ id: item.id, defaultUnitCost: null });
  });

  it('lets engineers and viewers read without costs, and change nothing', async () => {
    const item = await newItem({ defaultUnitCost: '9.99' });
    for (const who of [engineer, viewer]) {
      const read = json<{ item: ItemBody; can: { manage: boolean; move: boolean } }>(
        await call(who, 'GET', `/v1/inventory/items/${item.id}`),
      );
      expect(read.item).toMatchObject({ defaultUnitCost: null, averageUnitCost: null });
      expect(read.can).toEqual({ manage: false, move: false });
      const write = await call(who, 'POST', '/v1/inventory/items', {
        sku: `X-${tag()}`,
        name: 'X',
      });
      expect(write.statusCode).toBe(403);
    }
  });
});

describe('locations and vans', () => {
  it('assigns one van per member, and only to a member', async () => {
    const van = await newLocation({
      name: `Van ${tag()}`,
      kind: 'van',
      assignedTo: engineer.userId,
    });
    expect(van).toMatchObject({ kind: 'van', assignedTo: engineer.userId });

    const second = await call(dispatcher, 'POST', '/v1/inventory/locations', {
      name: `Van ${tag()}`,
      kind: 'van',
      assignedTo: engineer.userId,
    });
    expect(second.statusCode).toBe(409);
    expect(code(second)).toBe('member_has_van');

    const stranger = await call(dispatcher, 'POST', '/v1/inventory/locations', {
      name: `Van ${tag()}`,
      kind: 'van',
      assignedTo: randomUUID(),
    });
    expect(stranger.statusCode).toBe(422);
    expect(code(stranger)).toBe('assignee_not_member');

    const warehouse = await call(dispatcher, 'POST', '/v1/inventory/locations', {
      name: `Store ${tag()}`,
      kind: 'warehouse',
      assignedTo: engineer.userId,
    });
    expect(warehouse.statusCode).toBe(422);

    // Hand the van back, so later tests can give the engineer another.
    const unassigned = await call(dispatcher, 'PATCH', `/v1/inventory/locations/${van.id}`, {
      expectedVersion: van.version,
      assignedTo: null,
    });
    expect(json<LocationBody>(unassigned).assignedTo).toBeNull();
    const audit = await withTenant(api.tenantId, (tx) =>
      tx.auditLog.list({ resourceType: 'inventory_location', resourceId: van.id }),
    );
    expect(audit.map((entry) => entry.action)).toContain('inventory_location.van_assigned');
  });
});

describe('moving stock', () => {
  it('receives at a price, averages the cost, transfers to a van and issues with a reason', async () => {
    const item = await newItem({ unit: 'm' });
    const store = await newLocation();
    const van = await newLocation({ name: `Van ${tag()}`, kind: 'van' });

    expect(
      (
        await post({
          type: 'receipt',
          itemId: item.id,
          locationId: store.id,
          quantity: '100',
          unitCost: '2',
        })
      ).statusCode,
    ).toBe(201);
    expect(
      (
        await post({
          type: 'receipt',
          itemId: item.id,
          locationId: store.id,
          quantity: '50',
          unitCost: '3.5',
        })
      ).statusCode,
    ).toBe(201);
    const detail = json<{ item: ItemBody; onHand: string }>(
      await call(dispatcher, 'GET', `/v1/inventory/items/${item.id}`),
    );
    expect(detail).toMatchObject({ onHand: '150', item: { averageUnitCost: '2.5' } });

    const transfer = await post({
      type: 'transfer',
      itemId: item.id,
      fromLocationId: store.id,
      toLocationId: van.id,
      quantity: '12.5',
    });
    expect(transfer.statusCode, transfer.body).toBe(201);
    const moved = json<{ movements: { kind: string; quantity: string; unitCost: string }[] }>(
      transfer,
    );
    expect(moved.movements.map((row) => [row.kind, row.quantity, row.unitCost])).toEqual([
      ['transfer_out', '-12.5', '2.5'],
      ['transfer_in', '12.5', '2.5'],
    ]);
    expect(await onHand(item.id, store.id)).toBe('137.5');
    expect(await onHand(item.id, van.id)).toBe('12.5');

    const noReason = await post({
      type: 'issue',
      itemId: item.id,
      locationId: van.id,
      quantity: '1',
    });
    expect(noReason.statusCode).toBe(422);
    const issued = await post({
      type: 'issue',
      itemId: item.id,
      locationId: van.id,
      quantity: '2.5',
      reason: 'Damaged on site',
    });
    expect(issued.statusCode).toBe(201);
    expect(await onHand(item.id, van.id)).toBe('10');
  });

  it('never goes below zero, and moves nothing when refused', async () => {
    const item = await newItem();
    const store = await newLocation();
    const van = await newLocation({ name: `Van ${tag()}`, kind: 'van' });
    await post({ type: 'receipt', itemId: item.id, locationId: store.id, quantity: '3' });

    const tooMuch = await post({
      type: 'transfer',
      itemId: item.id,
      fromLocationId: store.id,
      toLocationId: van.id,
      quantity: '5',
    });
    expect(tooMuch.statusCode).toBe(409);
    expect(code(tooMuch)).toBe('insufficient_stock');
    expect(await onHand(item.id, store.id)).toBe('3');
    expect(await onHand(item.id, van.id)).toBe('0');

    const out = await post({
      type: 'adjustment',
      itemId: item.id,
      locationId: store.id,
      direction: 'out',
      quantity: '3.0001',
      reason: 'Shrinkage',
    });
    expect(code(out)).toBe('insufficient_stock');
  });

  it('needs an idempotency key, and posts a retried request once', async () => {
    const item = await newItem();
    const store = await newLocation();
    const missing = await post(
      { type: 'receipt', itemId: item.id, locationId: store.id, quantity: '1' },
      dispatcher,
      null,
    );
    expect(missing.statusCode).toBe(400);
    expect(code(missing)).toBe('idempotency_key_required');

    const key = randomUUID();
    const payload = { type: 'receipt', itemId: item.id, locationId: store.id, quantity: '4' };
    const first = await post(payload, dispatcher, key);
    const again = await post(payload, dispatcher, key);
    expect(first.statusCode).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(await onHand(item.id, store.id)).toBe('4');
  });

  it('moves only stock items, and only for those who may', async () => {
    const service = await newItem({ kind: 'service', unit: 'hour' });
    const store = await newLocation();
    const refused = await post({
      type: 'receipt',
      itemId: service.id,
      locationId: store.id,
      quantity: '1',
    });
    expect(refused.statusCode).toBe(422);
    expect(code(refused)).toBe('not_stock_item');

    const item = await newItem();
    const engineerMove = await post(
      { type: 'receipt', itemId: item.id, locationId: store.id, quantity: '1' },
      engineer,
    );
    expect(engineerMove.statusCode).toBe(403);
  });

  it('keeps an item that holds stock a stock item, and a location that holds stock open', async () => {
    const item = await newItem();
    const store = await newLocation();
    await post({ type: 'receipt', itemId: item.id, locationId: store.id, quantity: '1' });

    const kind = await call(dispatcher, 'PATCH', `/v1/inventory/items/${item.id}`, {
      expectedVersion: item.version,
      kind: 'non_stock_item',
    });
    expect(code(kind)).toBe('item_has_stock');
    const archive = await call(dispatcher, 'PATCH', `/v1/inventory/locations/${store.id}`, {
      expectedVersion: 1,
      archived: true,
    });
    expect(code(archive)).toBe('location_not_empty');
  });
});

describe('reorder levels and counts', () => {
  it('lists what is below its reorder level, including what has none', async () => {
    const item = await newItem();
    const store = await newLocation();
    const empty = await newLocation();
    await post({ type: 'receipt', itemId: item.id, locationId: store.id, quantity: '2' });
    const set = await call(dispatcher, 'PUT', `/v1/inventory/items/${item.id}/reorder-levels`, {
      levels: [
        { locationId: store.id, minimum: '5' },
        { locationId: empty.id, minimum: '1' },
      ],
    });
    expect(set.statusCode, set.body).toBe(200);

    const low = json<{
      items: { item: { id: string }; location: { id: string }; onHand: string }[];
    }>(await call(viewer, 'GET', `/v1/inventory/balances?belowMinimum=true&itemId=${item.id}`));
    expect(low.items.map((row) => [row.location.id, row.onHand]).sort()).toEqual(
      [
        [store.id, '2'],
        [empty.id, '0'],
      ].sort(),
    );
  });

  it('posts a count as adjustments to what was counted, once', async () => {
    const item = await newItem();
    const store = await newLocation();
    await post({ type: 'receipt', itemId: item.id, locationId: store.id, quantity: '10' });

    const created = json<{ count: { id: string; version: number } }>(
      await call(dispatcher, 'POST', '/v1/inventory/counts', { locationId: store.id }),
    );
    const lines = await call(dispatcher, 'PUT', `/v1/inventory/counts/${created.count.id}/lines`, {
      expectedVersion: created.count.version,
      lines: [{ itemId: item.id, countedQuantity: '7.25' }],
    });
    expect(lines.statusCode, lines.body).toBe(200);
    const version = json<{ count: { version: number } }>(lines).count.version;

    const posted = await call(dispatcher, 'POST', `/v1/inventory/counts/${created.count.id}/post`, {
      expectedVersion: version,
    });
    expect(posted.statusCode, posted.body).toBe(200);
    expect(
      json<{
        count: { status: string };
        lines: { expectedQuantity: string; countedQuantity: string }[];
      }>(posted),
    ).toMatchObject({
      count: { status: 'posted' },
      lines: [{ expectedQuantity: '10', countedQuantity: '7.25' }],
    });
    expect(await onHand(item.id, store.id)).toBe('7.25');

    const twice = await call(dispatcher, 'POST', `/v1/inventory/counts/${created.count.id}/post`, {
      expectedVersion: version + 1,
    });
    expect(code(twice)).toBe('count_not_draft');

    const history = json<{ items: { kind: string; quantity: string }[] }>(
      await call(viewer, 'GET', `/v1/inventory/movements?itemId=${item.id}`),
    );
    expect(history.items[0]).toMatchObject({ kind: 'count_adjustment', quantity: '-2.75' });
  });

  it('replays the ledger and finds every balance right', async () => {
    const result = json<{ discrepancies: unknown[] }>(
      await call(owner, 'GET', '/v1/inventory/reconcile'),
    );
    expect(result.discrepancies).toEqual([]);
    expect((await call(dispatcher, 'GET', '/v1/inventory/reconcile')).statusCode).toBe(200);
    expect((await call(viewer, 'GET', '/v1/inventory/reconcile')).statusCode).toBe(403);
  });
});

describe('another company', () => {
  it('cannot be reached by id', async () => {
    const elsewhere = await getPlatformDataSource().tenants.create({
      slug: `inv-other-${randomUUID().slice(0, 8)}`,
      name: 'Elsewhere Stock Ltd',
    });
    const theirs = await withTenant(elsewhere.id, (tx) =>
      tx.inventoryCatalogue.createItem({ sku: 'THEIRS', name: 'Theirs' }, randomUUID()),
    );
    const store = await newLocation();
    expect((await call(owner, 'GET', `/v1/inventory/items/${theirs.id}`)).statusCode).toBe(404);
    const moved = await post({
      type: 'receipt',
      itemId: theirs.id,
      locationId: store.id,
      quantity: '1',
    });
    expect(moved.statusCode).toBe(404);
    expect(code(moved)).toBe('item_not_found');
  });
});
