import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Serial numbers and batches over HTTP and through the phone (ninth round;
 * ADR-0013): tracking switched on only when the stock is accounted for, stock
 * arriving under its codes, leaving by earliest expiry unless named, an expired
 * batch only with a reason, a serial number held once, parts on jobs taking
 * the van's lots offline, a clash kept as a conflict, counts by lot, and the
 * serial lookup tracing a unit from receipt to job.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let dispatcher: Member;
let engineer: Member;
const tokens = new Map<Member, string>();
let jobTypeId: string;
let customerId: string;
let siteId: string;
let vanId: string;

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;
const tag = () => randomUUID().slice(0, 6);

async function call(
  who: Member,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: Record<string, unknown>,
) {
  let value = tokens.get(who);
  if (value === undefined) {
    value = await api.signIn(who);
    tokens.set(who, value);
  }
  return api.call(value, {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
}

interface LotLine {
  lotId: string;
  kind: string;
  code: string;
  expiresOn: string | null;
  onHand: string;
}
interface ItemDetail {
  item: { id: string; version: number; tracking: string };
  stock: { location: { id: string }; onHand: string; lots: LotLine[] }[];
}

async function newItem() {
  const response = await call(dispatcher, 'POST', '/v1/inventory/items', {
    sku: `LOT-${tag()}`,
    name: `Tracked ${tag()}`,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ id: string; version: number }>(response);
}

async function newLocation(payload: Record<string, unknown> = {}) {
  const response = await call(dispatcher, 'POST', '/v1/inventory/locations', {
    name: `Store ${tag()}`,
    kind: 'warehouse',
    ...payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ id: string }>(response).id;
}

const detail = async (itemId: string) =>
  json<ItemDetail>(await call(dispatcher, 'GET', `/v1/inventory/items/${itemId}`));

const lotsAt = async (itemId: string, locationId: string) =>
  (await detail(itemId)).stock.find((row) => row.location.id === locationId)?.lots ?? [];

async function track(itemId: string, tracking: string, lots?: Record<string, unknown>[]) {
  const current = await detail(itemId);
  return call(dispatcher, 'POST', `/v1/inventory/items/${itemId}/tracking`, {
    tracking,
    expectedVersion: current.item.version,
    ...(lots === undefined ? {} : { lots }),
  });
}

const move = (payload: Record<string, unknown>) =>
  call(dispatcher, 'POST', '/v1/inventory/movements', payload);

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin('lots-staff');
  owner = await api.member('owner', 'lots-owner');
  dispatcher = await api.member('dispatcher', 'lots-dispatcher');
  engineer = await api.member('engineer', 'lots-engineer');
  const flag = await api.call(admin.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/inventory`,
    payload: { enabled: true },
  });
  expect(flag.statusCode, flag.body).toBe(200);

  const type = await api.call(await api.staff(owner), {
    method: 'POST',
    url: '/v1/job-types',
    payload: { name: 'Install', code: 'install' },
  });
  expect(type.statusCode, type.body).toBe(201);
  jobTypeId = json<{ id: string }>(type).id;
  customerId = json<{ id: string }>(
    await call(dispatcher, 'POST', '/v1/customers', { name: 'Harbour' }),
  ).id;
  siteId = json<{ id: string }>(
    await call(dispatcher, 'POST', `/v1/customers/${customerId}/sites`, {
      name: 'Quay',
      address: { line1: '2 Quay Street' },
    }),
  ).id;
  vanId = await newLocation({ name: `Van ${tag()}`, kind: 'van', assignedTo: engineer.userId });
});

afterAll(async () => {
  await api.close();
});

describe('switching tracking on', () => {
  it('is immediate with nothing on hand, and needs the stock accounted for otherwise', async () => {
    const empty = await newItem();
    const on = await track(empty.id, 'serial');
    expect(on.statusCode, on.body).toBe(200);
    expect(json<ItemDetail>(on).item.tracking).toBe('serial');

    const filter = await newItem();
    const store = await newLocation();
    expect(
      (
        await move({
          type: 'receipt',
          itemId: filter.id,
          locationId: store,
          quantity: '5',
          unitCost: '4',
        })
      ).statusCode,
    ).toBe(201);
    expect(code(await track(filter.id, 'batch'))).toBe('lots_quantity_mismatch');
    expect(
      code(await track(filter.id, 'batch', [{ locationId: store, code: 'B-OLD', quantity: '4' }])),
    ).toBe('lots_quantity_mismatch');
    const switched = await track(filter.id, 'batch', [
      { locationId: store, code: 'B-OLD', expiresOn: '2031-01-31', quantity: '3' },
      { locationId: store, code: 'B-NEW', expiresOn: '2032-06-30', quantity: '2' },
    ]);
    expect(switched.statusCode, switched.body).toBe(200);
    const after = json<ItemDetail>(switched);
    expect(after.stock.find((row) => row.location.id === store)?.onHand).toBe('5');
    expect((await lotsAt(filter.id, store)).map((lot) => [lot.code, lot.onHand])).toEqual([
      ['B-OLD', '3'],
      ['B-NEW', '2'],
    ]);

    // Untracked stock arriving is refused now; it names its batch.
    expect(
      code(await move({ type: 'receipt', itemId: filter.id, locationId: store, quantity: '1' })),
    ).toBe('lots_required');

    // Switching off keeps the stock and forgets the batches.
    const off = await track(filter.id, 'none');
    expect(off.statusCode, off.body).toBe(200);
    expect(json<ItemDetail>(off).stock.find((row) => row.location.id === store)).toMatchObject({
      onHand: '5',
      lots: [],
    });
  });
});

describe('batches', () => {
  it('leave by earliest expiry, skip an expired one, and use it only with a reason', async () => {
    const item = await newItem();
    expect((await track(item.id, 'batch')).statusCode).toBe(200);
    const store = await newLocation();
    const receive = (lotCode: string, expiresOn: string, quantity: string) =>
      move({
        type: 'receipt',
        itemId: item.id,
        locationId: store,
        quantity,
        unitCost: '2',
        lots: [{ code: lotCode, expiresOn, quantity }],
      });
    expect((await receive('LATE', '2040-01-01', '4')).statusCode).toBe(201);
    expect((await receive('SOON', '2039-01-01', '2')).statusCode).toBe(201);
    expect((await receive('GONE', '2001-01-01', '3')).statusCode).toBe(201);

    const issued = await move({
      type: 'issue',
      itemId: item.id,
      locationId: store,
      quantity: '3',
      reason: 'Workshop',
    });
    expect(issued.statusCode, issued.body).toBe(201);
    expect((await lotsAt(item.id, store)).map((lot) => [lot.code, lot.onHand])).toEqual([
      ['GONE', '3'],
      ['LATE', '3'],
    ]);

    const gone = (await lotsAt(item.id, store)).find((lot) => lot.code === 'GONE')!;
    const named = {
      type: 'transfer',
      itemId: item.id,
      fromLocationId: store,
      toLocationId: vanId,
      quantity: '1',
      lots: [{ lotId: gone.lotId, quantity: '1' }],
    };
    expect(code(await move(named))).toBe('batch_expired');
    expect(code(await move({ ...named, allowExpired: true }))).toBe('reason_required');
    expect(
      (await move({ ...named, allowExpired: true, reason: 'Customer asked for it' })).statusCode,
    ).toBe(201);
    expect((await lotsAt(item.id, vanId)).map((lot) => [lot.code, lot.onHand])).toEqual([
      ['GONE', '1'],
    ]);

    expect(
      code(
        await move({
          type: 'issue',
          itemId: item.id,
          locationId: store,
          quantity: '2',
          reason: 'x',
          lots: [{ code: 'LATE', quantity: '1' }],
        }),
      ),
    ).toBe('lots_quantity_mismatch');
  });
});

describe('serial numbers', () => {
  it('arrive one at a time, are held once, and trace to the job they were fitted on', async () => {
    const meter = await newItem();
    expect((await track(meter.id, 'serial')).statusCode).toBe(200);
    const store = await newLocation();
    expect(
      code(
        await move({
          type: 'receipt',
          itemId: meter.id,
          locationId: store,
          quantity: '2',
          lots: [{ code: 'SN-1', quantity: '2' }],
        }),
      ),
    ).toBe('serial_single_unit');
    const received = await move({
      type: 'receipt',
      itemId: meter.id,
      locationId: store,
      quantity: '3',
      unitCost: '50',
      lots: [{ code: 'SN-100' }, { code: 'SN-101' }, { code: 'SN-102' }],
    });
    expect(received.statusCode, received.body).toBe(201);
    expect(
      code(
        await move({
          type: 'receipt',
          itemId: meter.id,
          locationId: store,
          quantity: '1',
          lots: [{ code: 'SN-100' }],
        }),
      ),
    ).toBe('serial_in_stock');

    // Two to the van, named.
    const moved = await move({
      type: 'transfer',
      itemId: meter.id,
      fromLocationId: store,
      toLocationId: vanId,
      quantity: '2',
      lots: [{ code: 'SN-101' }, { code: 'SN-102' }],
    });
    expect(moved.statusCode, moved.body).toBe(201);

    // The phone sees the van's serial numbers and fits one offline.
    const pulled = json<{
      vanStock: { items: { item: { id: string; tracking: string }; lots: LotLine[] }[] };
    }>(await call(engineer, 'GET', '/v1/sync/pull'));
    const vanLine = pulled.vanStock.items.find((row) => row.item.id === meter.id)!;
    expect(vanLine.item.tracking).toBe('serial');
    expect(vanLine.lots.map((lot) => lot.code)).toEqual(['SN-101', 'SN-102']);

    const job = json<{ workOrder: { id: string } }>(
      await call(dispatcher, 'POST', '/v1/work-orders', {
        customerId,
        siteId,
        jobTypeId,
        crew: [{ userId: engineer.userId, lead: true }],
      }),
    );
    const push = (payload: Record<string, unknown>) =>
      call(engineer, 'POST', '/v1/sync/push', {
        sentAt: new Date().toISOString(),
        mutations: [
          {
            id: randomUUID(),
            entityId: job.workOrder.id,
            recordedAt: new Date().toISOString(),
            kind: 'work_order.material',
            payload: { materialId: randomUUID(), itemId: meter.id, quantity: '1', ...payload },
          },
        ],
      });
    const sn101 = vanLine.lots.find((lot) => lot.code === 'SN-101')!;
    const fitted = json<{ results: { outcome: string }[] }>(
      await push({ lots: [{ lotId: sn101.lotId, quantity: '1' }] }),
    );
    expect(fitted.results[0]?.outcome).toBe('applied');

    // SN-100 is in the store, not the van: kept as a conflict, not refused.
    const sn100 = json<{ items: { lotId: string; code: string }[] }>(
      await call(dispatcher, 'GET', '/v1/inventory/lots?code=sn-10'),
    ).items.find((lot) => lot.code === 'SN-100')!;
    const clash = json<{ results: { outcome: string }[] }>(
      await push({ lots: [{ lotId: sn100.lotId, quantity: '1' }] }),
    );
    expect(clash.results[0]?.outcome).toBe('applied');

    interface Material {
      id: string;
      status: string;
      lots: { code: string }[] | null;
    }
    const jobDetail = json<{ materials: Material[] }>(
      await call(dispatcher, 'GET', `/v1/work-orders/${job.workOrder.id}`),
    );
    expect(jobDetail.materials.map((row) => [row.status, row.lots?.map((l) => l.code)])).toEqual([
      ['posted', ['SN-101']],
      ['conflict', ['SN-100']],
    ]);
    expect((await lotsAt(meter.id, vanId)).map((lot) => lot.code)).toEqual(['SN-102']);

    // The office moves SN-100 into the van and retries: it posts as asked.
    expect(
      (
        await move({
          type: 'transfer',
          itemId: meter.id,
          fromLocationId: store,
          toLocationId: vanId,
          quantity: '1',
          lots: [{ lotId: sn100.lotId }],
        })
      ).statusCode,
    ).toBe(201);
    const conflictId = jobDetail.materials.find((row) => row.status === 'conflict')!.id;
    const retried = await call(
      dispatcher,
      'POST',
      `/v1/work-orders/${job.workOrder.id}/materials/${conflictId}/resolve`,
      { action: 'retry' },
    );
    expect(retried.statusCode, retried.body).toBe(200);
    expect(json<{ materials: Material[] }>(retried).materials.map((row) => row.status)).toEqual([
      'posted',
      'posted',
    ]);

    // Put back: the same serial number returns to the van.
    const postedId = jobDetail.materials.find((row) => row.status === 'posted')!.id;
    const back = await call(
      engineer,
      'POST',
      `/v1/work-orders/${job.workOrder.id}/materials/${postedId}/return`,
      { quantity: '1' },
    );
    expect(back.statusCode, back.body).toBe(201);
    expect((await lotsAt(meter.id, vanId)).map((lot) => lot.code)).toEqual(['SN-101', 'SN-102']);

    // The trace: received, moved to the van, used on the job, put back.
    const trace = json<{
      stock: { location: { id: string }; onHand: string }[];
      history: { source: { kind: string }; workOrder: { id: string } | null }[];
    }>(await call(dispatcher, 'GET', `/v1/inventory/lots/${sn101.lotId}`));
    expect(trace.stock.map((row) => [row.location.id, row.onHand])).toEqual([[vanId, '1']]);
    expect(trace.history.map((row) => row.source.kind)).toEqual([
      'manual',
      'manual',
      'manual',
      'job_part',
      'job_part_return',
    ]);
    expect(trace.history.at(-2)?.workOrder?.id).toBe(job.workOrder.id);
  });
});

describe('a count', () => {
  it('counts a batched item by batch, and a batch it does not list as none', async () => {
    const item = await newItem();
    expect((await track(item.id, 'batch')).statusCode).toBe(200);
    const store = await newLocation();
    for (const [lotCode, quantity] of [
      ['C-1', '4'],
      ['C-2', '2'],
    ] as const) {
      expect(
        (
          await move({
            type: 'receipt',
            itemId: item.id,
            locationId: store,
            quantity,
            lots: [{ code: lotCode, quantity }],
          })
        ).statusCode,
      ).toBe(201);
    }
    const count = json<{ count: { id: string; version: number } }>(
      await call(dispatcher, 'POST', '/v1/inventory/counts', { locationId: store }),
    );
    expect(
      code(
        await call(dispatcher, 'PUT', `/v1/inventory/counts/${count.count.id}/lines`, {
          expectedVersion: count.count.version,
          lines: [{ itemId: item.id, countedQuantity: '3' }],
        }),
      ),
    ).toBe('lots_required');
    const lines = await call(dispatcher, 'PUT', `/v1/inventory/counts/${count.count.id}/lines`, {
      expectedVersion: count.count.version,
      lines: [
        { itemId: item.id, countedQuantity: '3', lotCode: 'C-1' },
        { itemId: item.id, countedQuantity: '5', lotCode: 'C-9', lotExpiresOn: '2035-05-05' },
      ],
    });
    expect(lines.statusCode, lines.body).toBe(200);
    const posted = await call(dispatcher, 'POST', `/v1/inventory/counts/${count.count.id}/post`, {
      expectedVersion: json<{ count: { version: number } }>(lines).count.version,
    });
    expect(posted.statusCode, posted.body).toBe(200);
    expect((await lotsAt(item.id, store)).map((lot) => [lot.code, lot.onHand]).sort()).toEqual([
      ['C-1', '3'],
      ['C-9', '5'],
    ]);
  });
});

describe('a part used before its item was tracked', () => {
  it('comes back under the code given', async () => {
    const item = await newItem();
    const store = await newLocation();
    expect(
      (await move({ type: 'receipt', itemId: item.id, locationId: store, quantity: '3' }))
        .statusCode,
    ).toBe(201);
    const job = json<{ workOrder: { id: string } }>(
      await call(dispatcher, 'POST', '/v1/work-orders', {
        customerId,
        siteId,
        jobTypeId,
        crew: [{ userId: engineer.userId, lead: true }],
      }),
    );
    const used = await call(dispatcher, 'POST', `/v1/work-orders/${job.workOrder.id}/materials`, {
      itemId: item.id,
      locationId: store,
      quantity: '2',
    });
    expect(used.statusCode, used.body).toBe(201);
    const materialId = json<{ materials: { id: string }[] }>(used).materials[0]!.id;
    expect(
      (await track(item.id, 'batch', [{ locationId: store, code: 'LEFT', quantity: '1' }]))
        .statusCode,
    ).toBe(200);

    const url = `/v1/work-orders/${job.workOrder.id}/materials/${materialId}/return`;
    expect(code(await call(dispatcher, 'POST', url, { quantity: '1' }))).toBe('lots_required');
    const back = await call(dispatcher, 'POST', url, {
      quantity: '1',
      lots: [{ code: 'BACK', quantity: '1' }],
    });
    expect(back.statusCode, back.body).toBe(201);
    expect((await lotsAt(item.id, store)).map((lot) => [lot.code, lot.onHand]).sort()).toEqual([
      ['BACK', '1'],
      ['LEFT', '1'],
    ]);
  });
});
