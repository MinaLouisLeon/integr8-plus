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
 * Suppliers, purchase orders and goods receipts over HTTP (CRM/ERP plan,
 * phase E2): the module switch, who drafts and who approves, lines frozen on
 * approval, receipts into the ledger at the price received, returns as
 * reversals, and every posting exactly once.
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

interface OrderBody {
  id: string;
  reference: string;
  status: string;
  currencyCode: string;
  totals: { subtotal: string; tax: string; total: string } | null;
  version: number;
  approvedBy: string | null;
}
interface LineBody {
  id: string;
  quantityOrdered: string;
  quantityReceived: string;
  unitPrice: string | null;
  subtotal: string | null;
}
interface ReceiptBody {
  id: string;
  lines: { id: string; quantity: string; returnedQuantity: string }[];
}
interface OrderDetail {
  order: OrderBody;
  lines: LineBody[];
  receipts: ReceiptBody[];
  can: { edit: boolean; approve: boolean; cancel: boolean; receive: boolean };
}

const tag = () => randomUUID().slice(0, 6);

async function newSupplier(payload: Record<string, unknown> = {}) {
  const response = await call(dispatcher, 'POST', '/v1/purchasing/suppliers', {
    name: `Supplier ${tag()}`,
    ...payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ id: string; name: string; version: number; status: string }>(response);
}

async function newItem(payload: Record<string, unknown> = {}) {
  const response = await call(dispatcher, 'POST', '/v1/inventory/items', {
    sku: `SKU-${tag()}`,
    name: `Item ${tag()}`,
    ...payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ id: string; name: string; averageUnitCost: string | null; version: number }>(
    response,
  );
}

async function newLocation() {
  const response = await call(dispatcher, 'POST', '/v1/inventory/locations', {
    name: `Store ${tag()}`,
    kind: 'warehouse',
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ id: string }>(response);
}

async function newOrder(payload: Record<string, unknown> = {}): Promise<OrderDetail> {
  const supplier = await newSupplier();
  const response = await call(dispatcher, 'POST', '/v1/purchasing/orders', {
    supplierId: supplier.id,
    ...payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<OrderDetail>(response);
}

async function approve(detail: OrderDetail, who: Member = owner): Promise<OrderDetail> {
  const response = await call(who, 'POST', `/v1/purchasing/orders/${detail.order.id}/approve`, {
    expectedVersion: detail.order.version,
  });
  expect(response.statusCode, response.body).toBe(200);
  return json<OrderDetail>(response);
}

async function onHand(itemId: string, locationId: string): Promise<string> {
  const balances = json<{ items: { location: { id: string }; onHand: string }[] }>(
    await call(dispatcher, 'GET', `/v1/inventory/balances?itemId=${itemId}`),
  );
  return balances.items.find((row) => row.location.id === locationId)?.onHand ?? '0';
}

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin('po-staff');
  owner = await api.member('owner', 'po-owner');
  dispatcher = await api.member('dispatcher', 'po-dispatcher');
  engineer = await api.member('engineer', 'po-engineer');
  viewer = await api.member('viewer', 'po-viewer');
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

describe('the purchasing module switch', () => {
  it('refuses every purchasing route until Integr8 switches it on', async () => {
    const before = await call(owner, 'GET', '/v1/purchasing/suppliers');
    expect(before.statusCode).toBe(403);
    expect(code(before)).toBe('feature_disabled');

    await setFlag('inventory', true);
    await setFlag('purchasing', true);
    expect((await call(owner, 'GET', '/v1/purchasing/suppliers')).statusCode).toBe(200);
  });
});

describe('suppliers', () => {
  it('are added by dispatchers, named once, and read by viewers but not engineers', async () => {
    const name = `Acme ${tag()}`;
    const supplier = await newSupplier({
      name,
      email: 'orders@acme.example',
      leadTimeDays: 5,
      address: { city: 'Cairo', countryCode: 'eg' },
    });
    expect(supplier).toMatchObject({ name, status: 'active' });

    const taken = await call(dispatcher, 'POST', '/v1/purchasing/suppliers', {
      name: name.toUpperCase(),
    });
    expect(taken.statusCode).toBe(409);
    expect(code(taken)).toBe('supplier_name_taken');

    const read = await call(viewer, 'GET', `/v1/purchasing/suppliers/${supplier.id}`);
    expect(read.statusCode).toBe(200);
    expect(json<{ can: { manage: boolean } }>(read).can).toEqual({ manage: false });
    expect(
      (await call(engineer, 'GET', `/v1/purchasing/suppliers/${supplier.id}`)).statusCode,
    ).toBe(403);
    expect(
      (
        await call(viewer, 'PATCH', `/v1/purchasing/suppliers/${supplier.id}`, {
          expectedVersion: supplier.version,
          notes: 'x',
        })
      ).statusCode,
    ).toBe(403);
  });

  it('can be made inactive, which stops new orders and hides them from the default list', async () => {
    const supplier = await newSupplier();
    const updated = await call(dispatcher, 'PATCH', `/v1/purchasing/suppliers/${supplier.id}`, {
      expectedVersion: supplier.version,
      status: 'inactive',
    });
    expect(updated.statusCode, updated.body).toBe(200);

    const refused = await call(dispatcher, 'POST', '/v1/purchasing/orders', {
      supplierId: supplier.id,
    });
    expect(refused.statusCode).toBe(422);
    expect(code(refused)).toBe('supplier_inactive');

    const listed = json<{ items: { id: string }[] }>(
      await call(dispatcher, 'GET', '/v1/purchasing/suppliers?limit=200'),
    );
    expect(listed.items.some((row) => row.id === supplier.id)).toBe(false);
    const all = json<{ items: { id: string }[] }>(
      await call(dispatcher, 'GET', '/v1/purchasing/suppliers?status=inactive'),
    );
    expect(all.items.some((row) => row.id === supplier.id)).toBe(true);
  });

  it('can be an item’s preferred supplier', async () => {
    const supplier = await newSupplier();
    const item = await newItem();
    const updated = await call(dispatcher, 'PATCH', `/v1/inventory/items/${item.id}`, {
      expectedVersion: item.version,
      preferredSupplierId: supplier.id,
      supplierPartNumber: 'ACM-77',
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(json<Record<string, unknown>>(updated)).toMatchObject({
      preferredSupplierId: supplier.id,
      supplierPartNumber: 'ACM-77',
    });
    const missing = await call(dispatcher, 'PATCH', `/v1/inventory/items/${item.id}`, {
      expectedVersion: item.version + 1,
      preferredSupplierId: randomUUID(),
    });
    expect(missing.statusCode).toBe(404);
    expect(code(missing)).toBe('supplier_not_found');
  });
});

describe('purchase orders', () => {
  it('are drafted in the company currency with exact totals, numbered in order', async () => {
    const item = await newItem({ name: 'Copper pipe' });
    const first = await newOrder({
      lines: [
        { itemId: item.id, quantityOrdered: '3', unitPrice: '0.1', taxRateBp: 2000 },
        { itemId: item.id, description: 'Pipe, extra', quantityOrdered: '1.5', unitPrice: '2' },
      ],
    });
    expect(first.order).toMatchObject({
      status: 'draft',
      currencyCode: 'EGP',
      totals: { subtotal: '3.3', tax: '0.06', total: '3.36' },
    });
    expect(first.order.reference).toMatch(/^PO-\d{6}$/u);
    expect(first.lines.map((line) => line.subtotal)).toEqual(['0.3', '3']);
    expect(first.can).toEqual({ edit: true, approve: false, cancel: true, receive: false });
    // What the printed order names: the company, and the supplier as it is now.
    const printed = json<{
      parties: { buyer: { name: string }; supplier: { name: string; email: string | null } };
    }>(await call(dispatcher, 'GET', `/v1/purchasing/orders/${first.order.id}`));
    expect(printed.parties.buyer.name).not.toBe('');
    expect(printed.parties.supplier.name).toMatch(/^Supplier /u);

    const second = await newOrder();
    expect(Number(second.order.reference.slice(3))).toBe(
      Number(first.order.reference.slice(3)) + 1,
    );

    const found = json<{ items: { id: string }[] }>(
      await call(viewer, 'GET', `/v1/purchasing/orders?q=${first.order.reference}`),
    );
    expect(found.items.map((row) => row.id)).toEqual([first.order.id]);
  });

  it('take the company currency by name, and refuse any other', async () => {
    const item = await newItem();
    const named = await newOrder({
      currencyCode: 'EGP',
      lines: [{ itemId: item.id, quantityOrdered: '1', unitPrice: '10' }],
    });
    expect(named.order.currencyCode).toBe('EGP');

    // A receipt folds the price into the item's average cost, which is in the
    // company currency and converts nothing: 10 dollars would become 10 pounds.
    const supplier = await newSupplier();
    const dollars = await call(dispatcher, 'POST', '/v1/purchasing/orders', {
      supplierId: supplier.id,
      currencyCode: 'USD',
      lines: [{ itemId: item.id, quantityOrdered: '1', unitPrice: '10' }],
    });
    expect(dollars.statusCode, dollars.body).toBe(422);
    expect(code(dollars)).toBe('purchase_currency_not_company');
    expect(json<{ error: { details: { field: string }[] } }>(dollars).error.details[0]?.field).toBe(
      'body.currencyCode',
    );
  });

  it('drafted in another currency before that was refused are not received', async () => {
    const item = await newItem();
    const store = await newLocation();
    const supplier = await newSupplier();
    // Written the way the API used to accept it, straight through the repository.
    const order = await withTenant(api.tenantId, (tx) =>
      tx.inventoryPurchasing.createOrder(
        {
          supplierId: supplier.id,
          supplierName: supplier.name,
          currencyCode: 'USD',
          deliveryLocationId: store.id,
        },
        [{ itemId: item.id, description: 'Item', quantityOrdered: '2', unitPrice: '10' }],
        dispatcher.userId,
      ),
    );
    const approved = await approve(
      json<OrderDetail>(await call(dispatcher, 'GET', `/v1/purchasing/orders/${order.id}`)),
    );
    const refused = await call(
      dispatcher,
      'POST',
      `/v1/purchasing/orders/${order.id}/receipts`,
      {
        expectedVersion: approved.order.version,
        lines: [{ orderLineId: approved.lines[0]!.id, quantity: '2' }],
      },
      randomUUID(),
    );
    expect(refused.statusCode, refused.body).toBe(422);
    expect(code(refused)).toBe('purchase_currency_not_company');
    expect(await onHand(item.id, store.id)).toBe('0');
  });

  it('hide prices from those who may not see them', async () => {
    const item = await newItem();
    const order = await newOrder({
      lines: [{ itemId: item.id, quantityOrdered: '2', unitPrice: '5' }],
    });
    const seen = json<OrderDetail>(
      await call(viewer, 'GET', `/v1/purchasing/orders/${order.order.id}`),
    );
    expect(seen.order.totals).toBeNull();
    expect(seen.lines[0]).toMatchObject({ unitPrice: null, subtotal: null, quantityOrdered: '2' });
    expect(seen.can).toEqual({ edit: false, approve: false, cancel: false, receive: false });
  });

  it('are approved by owners and admins only, and then no longer change', async () => {
    const item = await newItem();
    const draft = await newOrder({
      lines: [{ itemId: item.id, quantityOrdered: '2', unitPrice: '5' }],
    });
    const byDispatcher = await call(
      dispatcher,
      'POST',
      `/v1/purchasing/orders/${draft.order.id}/approve`,
      { expectedVersion: draft.order.version },
    );
    expect(byDispatcher.statusCode).toBe(403);

    const edited = await call(dispatcher, 'PATCH', `/v1/purchasing/orders/${draft.order.id}`, {
      expectedVersion: draft.order.version,
      lines: [{ itemId: item.id, quantityOrdered: '4', unitPrice: '5' }],
      notes: 'Deliver to the back door',
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const revised = json<OrderDetail>(edited);
    expect(revised.order.totals?.total).toBe('20');

    const approved = await approve(revised);
    expect(approved.order).toMatchObject({ status: 'approved', approvedBy: owner.userId });
    expect(approved.can).toEqual({ edit: false, approve: false, cancel: true, receive: true });

    const late = await call(dispatcher, 'PATCH', `/v1/purchasing/orders/${draft.order.id}`, {
      expectedVersion: approved.order.version,
      notes: 'Too late',
    });
    expect(late.statusCode).toBe(409);
    expect(code(late)).toBe('order_not_draft');

    const stale = await call(owner, 'POST', `/v1/purchasing/orders/${draft.order.id}/approve`, {
      expectedVersion: 1,
    });
    expect(stale.statusCode).toBe(409);
  });

  it('cannot be approved empty, and can be cancelled with a reason', async () => {
    const empty = await newOrder();
    const refused = await call(owner, 'POST', `/v1/purchasing/orders/${empty.order.id}/approve`, {
      expectedVersion: empty.order.version,
    });
    expect(refused.statusCode).toBe(422);
    expect(code(refused)).toBe('order_empty');

    const cancelled = await call(
      dispatcher,
      'POST',
      `/v1/purchasing/orders/${empty.order.id}/cancel`,
      {
        expectedVersion: empty.order.version,
        reason: 'Ordered twice',
      },
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(json<OrderDetail>(cancelled).order).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Ordered twice',
    });
    const again = await call(dispatcher, 'POST', `/v1/purchasing/orders/${empty.order.id}/cancel`, {
      expectedVersion: json<OrderDetail>(cancelled).order.version,
    });
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('order_closed');
  });
});

describe('goods receipts', () => {
  it('put stock items into the ledger at the price received, and settle the order status', async () => {
    const pipe = await newItem({ unit: 'm' });
    const fitting = await newItem({ kind: 'service', name: 'Delivery' });
    const store = await newLocation();
    const draft = await newOrder({
      deliveryLocationId: store.id,
      lines: [
        { itemId: pipe.id, quantityOrdered: '10', unitPrice: '2' },
        { itemId: fitting.id, quantityOrdered: '1', unitPrice: '15' },
      ],
    });
    const approved = await approve(draft);
    const [pipeLine, deliveryLine] = approved.lines;

    const notYet = await call(
      dispatcher,
      'POST',
      `/v1/purchasing/orders/${draft.order.id}/receipts`,
      {
        expectedVersion: draft.order.version,
        lines: [{ orderLineId: pipeLine!.id, quantity: '1' }],
      },
      null,
    );
    expect(notYet.statusCode).toBe(400);
    expect(code(notYet)).toBe('idempotency_key_required');

    const key = randomUUID();
    const payload = {
      expectedVersion: approved.order.version,
      supplierNote: 'DN-4411',
      lines: [{ orderLineId: pipeLine!.id, quantity: '4', unitCost: '2.5' }],
    };
    const first = await call(
      dispatcher,
      'POST',
      `/v1/purchasing/orders/${draft.order.id}/receipts`,
      payload,
      key,
    );
    expect(first.statusCode, first.body).toBe(201);
    const partial = json<OrderDetail>(first);
    expect(partial.order.status).toBe('partially_received');
    expect(partial.lines[0]?.quantityReceived).toBe('4');
    expect(partial.receipts).toHaveLength(1);
    const replay = await call(
      dispatcher,
      'POST',
      `/v1/purchasing/orders/${draft.order.id}/receipts`,
      payload,
      key,
    );
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(await onHand(pipe.id, store.id)).toBe('4');
    const priced = json<{ item: { averageUnitCost: string } }>(
      await call(dispatcher, 'GET', `/v1/inventory/items/${pipe.id}`),
    );
    expect(priced.item.averageUnitCost).toBe('2.5');

    const tooMany = await call(
      dispatcher,
      'POST',
      `/v1/purchasing/orders/${draft.order.id}/receipts`,
      {
        expectedVersion: partial.order.version,
        lines: [{ orderLineId: pipeLine!.id, quantity: '7' }],
      },
      randomUUID(),
    );
    expect(tooMany.statusCode).toBe(422);
    expect(code(tooMany)).toBe('over_received');
    expect(await onHand(pipe.id, store.id)).toBe('4');

    const rest = await call(
      dispatcher,
      'POST',
      `/v1/purchasing/orders/${draft.order.id}/receipts`,
      {
        expectedVersion: partial.order.version,
        lines: [
          { orderLineId: pipeLine!.id, quantity: '6' },
          { orderLineId: deliveryLine!.id, quantity: '1' },
        ],
      },
      randomUUID(),
    );
    expect(rest.statusCode, rest.body).toBe(201);
    const full = json<OrderDetail>(rest);
    expect(full.order.status).toBe('received');
    expect(full.can).toEqual({ edit: false, approve: false, cancel: false, receive: false });
    expect(await onHand(pipe.id, store.id)).toBe('10');
    // 4 at 2.5 and 6 at 2: (10 + 12) / 10.
    const averaged = json<{ item: { averageUnitCost: string } }>(
      await call(dispatcher, 'GET', `/v1/inventory/items/${pipe.id}`),
    );
    expect(averaged.item.averageUnitCost).toBe('2.2');
    // The service line never touched the ledger.
    expect(await onHand(fitting.id, store.id)).toBe('0');

    const closed = await call(
      dispatcher,
      'POST',
      `/v1/purchasing/orders/${draft.order.id}/receipts`,
      {
        expectedVersion: full.order.version,
        lines: [{ orderLineId: pipeLine!.id, quantity: '1' }],
      },
      randomUUID(),
    );
    expect(closed.statusCode).toBe(409);
    expect(code(closed)).toBe('order_not_receivable');
  });

  it('need a location, an approved order, and the purchasing permission', async () => {
    const item = await newItem();
    const draft = await newOrder({
      lines: [{ itemId: item.id, quantityOrdered: '1', unitPrice: '1' }],
    });
    const unapproved = await call(
      dispatcher,
      'POST',
      `/v1/purchasing/orders/${draft.order.id}/receipts`,
      {
        expectedVersion: draft.order.version,
        lines: [{ orderLineId: draft.lines[0]!.id, quantity: '1' }],
      },
      randomUUID(),
    );
    expect(unapproved.statusCode).toBe(409);
    expect(code(unapproved)).toBe('order_not_receivable');

    const approved = await approve(draft);
    const nowhere = await call(
      dispatcher,
      'POST',
      `/v1/purchasing/orders/${draft.order.id}/receipts`,
      {
        expectedVersion: approved.order.version,
        lines: [{ orderLineId: draft.lines[0]!.id, quantity: '1' }],
      },
      randomUUID(),
    );
    expect(nowhere.statusCode).toBe(422);
    expect(code(nowhere)).toBe('location_required');

    const store = await newLocation();
    const byEngineer = await call(
      engineer,
      'POST',
      `/v1/purchasing/orders/${draft.order.id}/receipts`,
      {
        expectedVersion: approved.order.version,
        locationId: store.id,
        lines: [{ orderLineId: draft.lines[0]!.id, quantity: '1' }],
      },
      randomUUID(),
    );
    expect(byEngineer.statusCode).toBe(403);
  });

  it('are reversed by returns to the supplier, which reopen the order line', async () => {
    const item = await newItem();
    const store = await newLocation();
    const draft = await newOrder({
      deliveryLocationId: store.id,
      lines: [{ itemId: item.id, quantityOrdered: '5', unitPrice: '3' }],
    });
    const approved = await approve(draft);
    const received = json<OrderDetail>(
      await call(
        dispatcher,
        'POST',
        `/v1/purchasing/orders/${draft.order.id}/receipts`,
        {
          expectedVersion: approved.order.version,
          lines: [{ orderLineId: approved.lines[0]!.id, quantity: '5' }],
        },
        randomUUID(),
      ),
    );
    expect(received.order.status).toBe('received');
    const receipt = received.receipts[0]!;

    // Some of it has been used: the return can only take what is still there.
    const used = await call(
      dispatcher,
      'POST',
      '/v1/inventory/movements',
      { type: 'issue', itemId: item.id, locationId: store.id, quantity: '4', reason: 'Fitted' },
      randomUUID(),
    );
    expect(used.statusCode, used.body).toBe(201);
    const tooMuch = await call(
      dispatcher,
      'POST',
      `/v1/purchasing/receipts/${receipt.id}/returns`,
      { reason: 'Wrong size', lines: [{ receiptLineId: receipt.lines[0]!.id, quantity: '2' }] },
      randomUUID(),
    );
    expect(tooMuch.statusCode).toBe(409);
    expect(code(tooMuch)).toBe('insufficient_stock');
    expect(await onHand(item.id, store.id)).toBe('1');

    const returned = await call(
      dispatcher,
      'POST',
      `/v1/purchasing/receipts/${receipt.id}/returns`,
      { reason: 'Wrong size', lines: [{ receiptLineId: receipt.lines[0]!.id, quantity: '1' }] },
      randomUUID(),
    );
    expect(returned.statusCode, returned.body).toBe(201);
    const reopened = json<OrderDetail>(returned);
    expect(reopened.order.status).toBe('partially_received');
    expect(reopened.lines[0]?.quantityReceived).toBe('4');
    expect(reopened.receipts[0]?.lines[0]?.returnedQuantity).toBe('1');
    expect(await onHand(item.id, store.id)).toBe('0');

    const movements = json<{ items: { kind: string; quantity: string }[] }>(
      await call(dispatcher, 'GET', `/v1/inventory/movements?itemId=${item.id}`),
    );
    expect(movements.items.map((row) => row.kind)).toContain('return_to_supplier');

    const over = await call(
      dispatcher,
      'POST',
      `/v1/purchasing/receipts/${receipt.id}/returns`,
      { reason: 'Again', lines: [{ receiptLineId: receipt.lines[0]!.id, quantity: '4.5' }] },
      randomUUID(),
    );
    expect(over.statusCode).toBe(422);
    expect(code(over)).toBe('over_returned');
  });
});

describe('another company', () => {
  it('cannot be reached by id', async () => {
    const elsewhere = await getPlatformDataSource().tenants.create({
      slug: `po-other-${randomUUID().slice(0, 8)}`,
      name: 'Elsewhere Supplies Ltd',
    });
    const theirs = await withTenant(elsewhere.id, (tx) =>
      tx.inventoryPurchasing.createSupplier({ name: 'Theirs' }, randomUUID()),
    );
    expect((await call(owner, 'GET', `/v1/purchasing/suppliers/${theirs.id}`)).statusCode).toBe(
      404,
    );
    const order = await call(dispatcher, 'POST', '/v1/purchasing/orders', {
      supplierId: theirs.id,
    });
    expect(order.statusCode).toBe(404);
    expect(code(order)).toBe('supplier_not_found');
  });
});
