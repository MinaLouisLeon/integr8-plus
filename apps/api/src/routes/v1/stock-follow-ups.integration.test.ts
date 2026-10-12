import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Inventory and the field follow-ups over HTTP (eighth round; ADR-0012):
 * site locations holding the customer's stock, item images, supplier price
 * lists and reorder drafts, deliveries by hand, van refills and parts bought
 * from a merchant for a job.
 */

let api: ApiHarness;
let staff: PlatformAdmin;
let owner: Member;
let dispatcher: Member;
let engineer: Member;
let viewer: Member;
let customerId: string;
let siteId: string;
let jobTypeId: string;
let storeId: string;
const tokens = new Map<Member, string>();

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;
const tag = () => randomUUID().slice(0, 6);

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

async function ok<T>(response: { statusCode: number; body: string }): Promise<T> {
  expect([200, 201], response.body).toContain(response.statusCode);
  return Promise.resolve(json<T>(response));
}

async function newItem(payload: Record<string, unknown> = {}) {
  return ok<{ item: { id: string } } & { id?: string }>(
    await call(dispatcher, 'POST', '/v1/inventory/items', {
      sku: `FU-${tag()}`,
      name: `Part ${tag()}`,
      salePrice: '20',
      ...payload,
    }),
  ).then((body) => ({ id: body.id ?? body.item.id }));
}

async function receive(itemId: string, locationId: string, quantity: string) {
  await ok(
    await call(dispatcher, 'POST', '/v1/inventory/movements', {
      type: 'receipt',
      itemId,
      locationId,
      quantity,
      unitCost: '5',
    }),
  );
}

async function onHand(itemId: string, locationId: string): Promise<string> {
  const balances = json<{ items: { location: { id: string }; onHand: string }[] }>(
    await call(dispatcher, 'GET', `/v1/inventory/balances?itemId=${itemId}`),
  );
  return balances.items.find((row) => row.location.id === locationId)?.onHand ?? '0';
}

beforeAll(async () => {
  api = await startApi();
  staff = await api.platformAdmin('fu-staff');
  owner = await api.member('owner', 'fu-owner');
  dispatcher = await api.member('dispatcher', 'fu-dispatcher');
  engineer = await api.member('engineer', 'fu-engineer');
  viewer = await api.member('viewer', 'fu-viewer');
  for (const flag of ['inventory', 'purchasing', 'sales']) {
    const response = await api.call(staff.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/flags/${flag}`,
      payload: { enabled: true },
    });
    expect(response.statusCode, response.body).toBe(200);
  }
  const type = await api.call(await api.staff(owner), {
    method: 'POST',
    url: '/v1/job-types',
    payload: { name: 'Pump service', code: 'pump' },
  });
  expect(type.statusCode, type.body).toBe(201);
  jobTypeId = json<{ id: string }>(type).id;
  customerId = (
    await ok<{ id: string }>(
      await call(dispatcher, 'POST', '/v1/customers', { name: 'Garden City Towers' }),
    )
  ).id;
  siteId = (
    await ok<{ id: string }>(
      await call(dispatcher, 'POST', `/v1/customers/${customerId}/sites`, {
        name: 'Tower A',
        address: { line1: '3 Nile Street' },
      }),
    )
  ).id;
  storeId = (
    await ok<{ id: string }>(
      await call(dispatcher, 'POST', '/v1/inventory/locations', {
        name: 'Main store',
        kind: 'warehouse',
      }),
    )
  ).id;
});

afterAll(async () => {
  await api.close();
});

describe('site locations holding the customer’s stock', () => {
  it('take our stock as an issue, keep a record, and let nothing out', async () => {
    const item = await newItem();
    await receive(item.id, storeId, '10');
    const theirs = await ok<{ id: string; ownership: string; version: number }>(
      await call(dispatcher, 'POST', '/v1/inventory/locations', {
        name: 'Tower A plant room',
        kind: 'site',
        siteId,
        ownership: 'customer',
      }),
    );
    expect(theirs.ownership).toBe('customer');
    expect(
      code(
        await call(dispatcher, 'POST', '/v1/inventory/locations', {
          name: 'Bad',
          kind: 'warehouse',
          ownership: 'customer',
        }),
      ),
    ).toBe('validation_failed');

    const moved = await ok<{ movements: { kind: string; unitCost: string | null }[] }>(
      await call(dispatcher, 'POST', '/v1/inventory/movements', {
        type: 'transfer',
        itemId: item.id,
        fromLocationId: storeId,
        toLocationId: theirs.id,
        quantity: '4',
      }),
    );
    expect(moved.movements.map((movement) => movement.kind).sort()).toEqual([
      'issue',
      'transfer_in',
    ]);
    expect(moved.movements.find((row) => row.kind === 'transfer_in')?.unitCost).toBeNull();
    expect(await onHand(item.id, theirs.id)).toBe('4');

    // Not ours: left out of the item's stock everywhere together.
    const listed = json<{ items: { id: string; onHand: string }[] }>(
      await call(dispatcher, 'GET', '/v1/inventory/items?limit=200'),
    );
    expect(listed.items.find((row) => row.id === item.id)?.onHand).toBe('6');

    const back = await call(dispatcher, 'POST', '/v1/inventory/movements', {
      type: 'transfer',
      itemId: item.id,
      fromLocationId: theirs.id,
      toLocationId: storeId,
      quantity: '1',
    });
    expect(code(back)).toBe('customer_stock_stays');
    expect(
      code(
        await call(owner, 'PATCH', `/v1/inventory/locations/${theirs.id}`, {
          expectedVersion: theirs.version,
          ownership: 'ours',
        }),
      ),
    ).toBe('ownership_fixed');
  });
});

describe('item media', () => {
  it('keeps images and datasheets, one image the main one', async () => {
    const item = await newItem();
    const upload = async (contentType: string) => {
      const created = json<{
        media: { id: string };
        upload: { url: string; headers: Record<string, string> };
      }>(await call(dispatcher, 'POST', '/v1/media', { contentType, byteSize: 1_000 }));
      const target = new URL(created.upload.url);
      const put = await api.app.inject({
        remoteAddress: api.remoteAddress,
        method: 'PUT',
        url: target.pathname + target.search,
        headers: created.upload.headers,
        payload: randomBytes(1_000),
      });
      expect(put.statusCode, put.body).toBe(200);
      expect(
        (await call(dispatcher, 'POST', `/v1/media/${created.media.id}/complete`)).statusCode,
      ).toBe(200);
      return created.media.id;
    };
    const front = await upload('image/jpeg');
    const sheet = await upload('application/pdf');
    const side = await upload('image/jpeg');
    const url = `/v1/inventory/items/${item.id}/media`;
    await ok(await call(dispatcher, 'POST', url, { fileId: front, title: 'Front' }));
    await ok(await call(dispatcher, 'POST', url, { fileId: sheet, title: 'Datasheet' }));
    expect(
      code(await call(dispatcher, 'POST', url, { fileId: sheet, title: 'x', main: true })),
    ).toBe('main_not_image');
    const listed = await ok<{ items: { id: string; title: string; isMain: boolean }[] }>(
      await call(dispatcher, 'POST', url, { fileId: side, title: 'Side' }),
    );
    expect(listed.items.map((row) => [row.title, row.isMain])).toEqual([
      ['Front', true],
      ['Side', false],
      ['Datasheet', false],
    ]);
    const sideId = listed.items.find((row) => row.title === 'Side')!.id;
    const after = await ok<{ items: { title: string; isMain: boolean }[] }>(
      await call(dispatcher, 'POST', `${url}/${sideId}/main`),
    );
    expect(after.items[0]).toMatchObject({ title: 'Side', isMain: true });
    // Everyone who sees the item sees its files; only the catalogue's keepers change them.
    expect(json<{ items: unknown[] }>(await call(viewer, 'GET', url)).items).toHaveLength(3);
    expect((await call(viewer, 'DELETE', `${url}/${sideId}`)).statusCode).toBe(403);
  });
});

describe('price lists and reorder', () => {
  let supplierId: string;
  let item: { id: string };

  it('price new order lines from the break in force', async () => {
    supplierId = (
      await ok<{ id: string }>(
        await call(owner, 'POST', '/v1/purchasing/suppliers', { name: `Pumps ${tag()}` }),
      )
    ).id;
    item = await newItem({ preferredSupplierId: supplierId });
    const prices = `/v1/purchasing/suppliers/${supplierId}/prices`;
    await ok(
      await call(owner, 'POST', prices, {
        itemId: item.id,
        currencyCode: 'EGP',
        unitPrice: '100',
        validFrom: '2020-01-01',
      }),
    );
    await ok(
      await call(owner, 'POST', prices, {
        itemId: item.id,
        currencyCode: 'EGP',
        minQuantity: '12',
        unitPrice: '90',
        validFrom: '2020-01-01',
      }),
    );
    expect(
      code(
        await call(owner, 'POST', prices, {
          itemId: item.id,
          currencyCode: 'EGP',
          unitPrice: '95',
          validFrom: '2024-01-01',
        }),
      ),
    ).toBe('price_overlaps');
    expect(
      json<{ items: unknown[] }>(
        await call(owner, 'GET', `/v1/purchasing/prices?itemId=${item.id}`),
      ).items,
    ).toHaveLength(2);

    const order = await ok<{ lines: { unitPrice: string }[] }>(
      await call(owner, 'POST', '/v1/purchasing/orders', {
        supplierId,
        currencyCode: 'EGP',
        lines: [
          { itemId: item.id, quantityOrdered: '3' },
          { itemId: item.id, quantityOrdered: '12', description: 'Bulk' },
        ],
      }),
    );
    expect(order.lines.map((line) => line.unitPrice)).toEqual(['100', '90']);
    const other = await newItem();
    expect(
      code(
        await call(owner, 'POST', '/v1/purchasing/orders', {
          supplierId,
          lines: [{ itemId: other.id, quantityOrdered: '1' }],
        }),
      ),
    ).toBe('price_required');
  });

  it('list what is short net of what is on order, and draft one order per supplier', async () => {
    const fresh = `Store ${tag()}`;
    const store = await ok<{ id: string }>(
      await call(dispatcher, 'POST', '/v1/inventory/locations', { name: fresh, kind: 'warehouse' }),
    );
    await ok(
      await call(owner, 'PUT', `/v1/inventory/items/${item.id}/reorder-levels`, {
        levels: [{ locationId: store.id, minimum: '10' }],
      }),
    );
    await receive(item.id, store.id, '2');
    const list = await ok<{
      items: {
        item: { id: string };
        short: string;
        suggested: string;
        price: { unitPrice: string } | null;
      }[];
    }>(await call(owner, 'GET', `/v1/inventory/locations/${store.id}/reorder`));
    expect(list.items).toHaveLength(1);
    // Eight short, raised to the supplier's smallest break.
    expect(list.items[0]).toMatchObject({
      short: '8',
      suggested: '8',
      price: { unitPrice: '100' },
    });

    const drafted = await ok<{ orders: { reference: string; lines: number }[] }>(
      await call(owner, 'POST', `/v1/inventory/locations/${store.id}/reorder`, {
        lines: [{ itemId: item.id, supplierId, quantity: '12' }],
      }),
    );
    expect(drafted.orders).toHaveLength(1);
    expect(drafted.orders[0]?.lines).toBe(1);
    // Now on order for this location: nothing is short.
    expect(
      json<{ items: unknown[] }>(
        await call(owner, 'GET', `/v1/inventory/locations/${store.id}/reorder`),
      ).items,
    ).toHaveLength(0);
    expect(
      (await call(engineer, 'GET', `/v1/inventory/locations/${store.id}/reorder`)).statusCode,
    ).toBe(403);
  });
});

describe('deliveries by hand', () => {
  it('deliver part of an order from a location, never more than ordered', async () => {
    const item = await newItem();
    await receive(item.id, storeId, '10');
    const created = await ok<{ order: { id: string; version: number } }>(
      await call(dispatcher, 'POST', '/v1/sales/orders', {
        customerId,
        siteId,
        title: 'Spare pumps',
        lines: [
          { itemId: item.id, quantity: '5' },
          { description: 'Delivery charge', quantity: '1', unitPrice: '50' },
        ],
      }),
    );
    const confirmed = await ok<{
      order: { id: string; version: number };
      lines: { id: string; quantityReserved: string }[];
    }>(
      await call(owner, 'POST', `/v1/sales/orders/${created.order.id}/confirm`, {
        expectedVersion: created.order.version,
        reserveLocationId: storeId,
      }),
    );
    const [stockLine, chargeLine] = confirmed.lines;
    expect(stockLine?.quantityReserved).toBe('5');
    const url = `/v1/sales/orders/${created.order.id}/deliveries`;
    expect(
      code(
        await call(dispatcher, 'POST', url, {
          expectedVersion: confirmed.order.version,
          locationId: storeId,
          lines: [{ orderLineId: stockLine!.id, quantity: '6' }],
        }),
      ),
    ).toBe('over_delivery');
    const delivered = await ok<{
      delivery: { id: string; reference: string; lines: { quantity: string }[] };
      order: {
        order: { status: string };
        lines: { quantityFulfilled: string; quantityReserved: string }[];
      };
    }>(
      await call(dispatcher, 'POST', url, {
        expectedVersion: confirmed.order.version,
        locationId: storeId,
        lines: [
          { orderLineId: stockLine!.id, quantity: '3' },
          { orderLineId: chargeLine!.id, quantity: '1' },
        ],
      }),
    );
    expect(delivered.delivery.reference).toMatch(/^DN-\d{6}$/u);
    expect(delivered.order.order.status).toBe('partially_fulfilled');
    expect(delivered.order.lines[0]).toMatchObject({
      quantityFulfilled: '3',
      quantityReserved: '2',
    });
    expect(await onHand(item.id, storeId)).toBe('7');

    const note = await ok<{ reference: string; customer: { name: string }; lines: unknown[] }>(
      await call(viewer, 'GET', `/v1/sales/deliveries/${delivered.delivery.id}`),
    );
    expect(note).toMatchObject({
      reference: delivered.delivery.reference,
      customer: { name: 'Garden City Towers' },
    });
    expect(note.lines).toHaveLength(2);
    expect(
      (
        await call(viewer, 'POST', url, {
          expectedVersion: 1,
          locationId: storeId,
          lines: [{ orderLineId: stockLine!.id, quantity: '1' }],
        })
      ).statusCode,
    ).toBe(403);
  });
});

describe('van refills', () => {
  it('are asked for by the engineer and picked by the store, possibly short', async () => {
    const item = await newItem();
    await receive(item.id, storeId, '3');
    const van = await ok<{ id: string }>(
      await call(dispatcher, 'POST', '/v1/inventory/locations', {
        name: `Van ${tag()}`,
        kind: 'van',
        assignedTo: engineer.userId,
      }),
    );
    const request = await ok<{
      id: string;
      version: number;
      status: string;
      can: { pick: boolean };
    }>(
      await call(engineer, 'POST', '/v1/inventory/van-requests', {
        lines: [{ itemId: item.id, quantity: '5' }],
      }),
    );
    expect(request).toMatchObject({ status: 'open', can: { pick: false } });
    const pick = (quantity: string) =>
      call(dispatcher, 'POST', `/v1/inventory/van-requests/${request.id}/pick`, {
        expectedVersion: request.version,
        fromLocationId: storeId,
        lines: [{ itemId: item.id, quantity }],
      });
    expect(code(await pick('6'))).toBe('over_request');
    expect(code(await pick('4'))).toBe('insufficient_stock');
    const picked = await ok<{ status: string; lines: { requested: string; picked: string }[] }>(
      await pick('3'),
    );
    expect(picked).toMatchObject({ status: 'picked', lines: [{ requested: '5', picked: '3' }] });
    expect(await onHand(item.id, van.id)).toBe('3');
    const pulled = json<{
      vanStock: {
        items: { item: { id: string }; onHand: string; reserved: string; available: string }[];
      };
    }>(await call(engineer, 'GET', '/v1/sync/pull'));
    expect(pulled.vanStock.items.find((row) => row.item.id === item.id)).toMatchObject({
      onHand: '3',
      reserved: '0',
      available: '3',
      mainImageFileId: null,
    });
    const mine = json<{ items: { id: string }[] }>(
      await call(engineer, 'GET', '/v1/inventory/van-requests'),
    );
    expect(mine.items.map((row) => row.id)).toEqual([request.id]);
    expect(
      code(
        await call(engineer, 'POST', `/v1/inventory/van-requests/${request.id}/cancel`, {
          expectedVersion: request.version + 1,
        }),
      ),
    ).toBe('request_not_open');
  });
});

describe('parts bought from a merchant', () => {
  it('are recorded on the job once, never as stock, and count in its cost', async () => {
    const job = await ok<{ workOrder: { id: string } }>(
      await call(dispatcher, 'POST', '/v1/work-orders', {
        customerId,
        siteId,
        jobTypeId,
        crew: [{ userId: engineer.userId, lead: true }],
      }),
    );
    const url = `/v1/work-orders/${job.workOrder.id}/purchases`;
    const id = randomUUID();
    const body = {
      id,
      description: 'Teflon tape',
      merchant: 'El Nour hardware',
      quantity: '2',
      unitPrice: '12.5',
    };
    const first = await ok<{
      items: { id: string; unitPrice: string | null }[];
      total: string | null;
    }>(await call(engineer, 'POST', url, body));
    expect(first.items).toHaveLength(1);
    // The engineer sees what they paid, not the job's costs.
    expect(first.items[0]?.unitPrice).toBe('12.5');
    expect(first.total).toBeNull();
    const again = await ok<{ items: unknown[] }>(await call(engineer, 'POST', url, body));
    expect(again.items).toHaveLength(1);

    const stock = await newItem();
    expect(
      code(await call(engineer, 'POST', url, { ...body, id: randomUUID(), itemId: stock.id })),
    ).toBe('stock_item_bought');
    const office = json<{ total: string | null }>(await call(dispatcher, 'GET', url));
    expect(office.total).toBe('25');

    // From the phone, offline: the receipt waits for its purchase; resends land once.
    const bought = randomUUID();
    const push = (mutations: Record<string, unknown>[]) =>
      call(engineer, 'POST', '/v1/sync/push', { sentAt: new Date().toISOString(), mutations });
    const receipt = {
      id: randomUUID(),
      entityId: bought,
      recordedAt: new Date().toISOString(),
      kind: 'work_order.purchase_receipt',
      payload: { attachmentId: randomUUID(), mediaId: randomUUID(), title: 'Receipt' },
    };
    const early = json<{ results: { outcome: string; code?: string }[] }>(await push([receipt]));
    expect(early.results[0]).toMatchObject({ outcome: 'retry', code: 'purchase_not_ready' });
    const mutation = {
      id: randomUUID(),
      entityId: job.workOrder.id,
      recordedAt: new Date().toISOString(),
      kind: 'work_order.purchase',
      payload: { id: bought, description: 'Washers', quantity: '10', unitPrice: '1.5' },
    };
    const pushed = json<{ results: { outcome: string; alreadyApplied: boolean }[] }>(
      await push([mutation]),
    );
    expect(pushed.results[0]).toMatchObject({ outcome: 'applied', alreadyApplied: false });
    const resent = json<{ results: { outcome: string; alreadyApplied: boolean }[] }>(
      await push([{ ...mutation, id: randomUUID() }]),
    );
    expect(resent.results[0]).toMatchObject({ outcome: 'applied', alreadyApplied: true });
    expect(json<{ total: string | null }>(await call(dispatcher, 'GET', url)).total).toBe('40');
  });
});
