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
 * Sales orders over HTTP (CRM/ERP plan, phase S1; ADR-0006): an accepted
 * quote converts exactly once, owners confirm and the confirmation reserves
 * what the location holds and flags the rest, reservations show on balances
 * and keep other jobs from taking the stock, parts used on linked jobs and
 * linked jobs completing deliver the lines, cancelling releases everything,
 * and company isolation.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let dispatcher: Member;
let engineer: Member;
const tokens = new Map<Member, string>();
let customerId: string;
let siteId: string;
let jobTypeId: string;

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
  quote: { id: string; reference: string } | null;
  totals: { total: string };
  toOrder: boolean;
  reserveLocation: { id: string } | null;
  confirmedTo: { customerName: string } | null;
  internalNotes: string | null;
  version: number;
}
interface OrderLine {
  description: string;
  quantity: string;
  quantityReserved: string;
  quantityFulfilled: string;
  shortfall: string;
  stock: boolean;
  reserveLocation: { id: string } | null;
}
interface OrderDetail {
  order: OrderBody;
  lines: OrderLine[];
  workOrders: { id: string; state: string }[];
  can: Record<string, boolean>;
}
interface QuoteDetail {
  quote: { id: string; status: string; version: number; convertedOrderId: string | null };
  can: Record<string, boolean>;
}
interface JobDetail {
  workOrder: { id: string; revision: number; state: string };
  materials: { status: string; availableQuantity: string | null }[];
  salesOrders: { id: string; reference: string }[];
}
interface Balance {
  location: { id: string };
  onHand: string;
  reserved: string;
  available: string;
}

const tag = () => randomUUID().slice(0, 6);

async function setFlag(key: string, enabled: boolean) {
  const response = await api.call(admin.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function newItem(payload: Record<string, unknown> = {}) {
  const response = await call(dispatcher, 'POST', '/v1/inventory/items', {
    sku: `PART-${tag()}`,
    name: `Part ${tag()}`,
    salePrice: '10',
    ...payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ id: string }>(response);
}

async function newStore() {
  const response = await call(dispatcher, 'POST', '/v1/inventory/locations', {
    name: `Store ${tag()}`,
    kind: 'warehouse',
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ id: string; name: string }>(response);
}

async function receive(itemId: string, locationId: string, quantity: string) {
  const response = await call(
    dispatcher,
    'POST',
    '/v1/inventory/movements',
    { type: 'receipt', itemId, locationId, quantity, unitCost: '5' },
    randomUUID(),
  );
  expect(response.statusCode, response.body).toBe(201);
}

async function balance(itemId: string, locationId: string): Promise<Balance> {
  const balances = json<{ items: Balance[] }>(
    await call(dispatcher, 'GET', `/v1/inventory/balances?itemId=${itemId}`),
  );
  return (
    balances.items.find((row) => row.location.id === locationId) ?? {
      location: { id: locationId },
      onHand: '0',
      reserved: '0',
      available: '0',
    }
  );
}

async function newOrder(lines: Record<string, unknown>[], who: Member = dispatcher) {
  const response = await call(who, 'POST', '/v1/sales/orders', {
    customerId,
    siteId,
    title: `Order ${tag()}`,
    internalNotes: 'Keep an eye on the second valve.',
    lines,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<OrderDetail>(response);
}

async function confirm(detail: OrderDetail, locationId: string | null, who: Member = owner) {
  const response = await call(who, 'POST', `/v1/sales/orders/${detail.order.id}/confirm`, {
    expectedVersion: detail.order.version,
    ...(locationId === null ? {} : { reserveLocationId: locationId }),
  });
  return response;
}

async function order(id: string, who: Member = dispatcher) {
  const response = await call(who, 'GET', `/v1/sales/orders/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return json<OrderDetail>(response);
}

async function newJob(crew: Member[] = [engineer]) {
  const response = await call(dispatcher, 'POST', '/v1/work-orders', {
    customerId,
    siteId,
    jobTypeId,
    crew: crew.map((member, index) => ({ userId: member.userId, lead: index === 0 })),
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<JobDetail>(response);
}

async function move(job: JobDetail, to: string, who: Member = dispatcher) {
  const response = await call(who, 'POST', `/v1/work-orders/${job.workOrder.id}/transitions`, {
    to,
    expectedRevision: job.workOrder.revision,
  });
  expect(response.statusCode, response.body).toBe(200);
  return json<JobDetail>(response);
}

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin('so-staff');
  owner = await api.member('owner', 'so-owner');
  dispatcher = await api.member('dispatcher', 'so-dispatcher');
  engineer = await api.member('engineer', 'so-engineer');
  const type = await api.call(await api.staff(owner), {
    method: 'POST',
    url: '/v1/job-types',
    payload: { name: 'Boiler service', code: 'boiler' },
  });
  expect(type.statusCode, type.body).toBe(201);
  jobTypeId = json<{ id: string }>(type).id;
  const customer = await call(dispatcher, 'POST', '/v1/customers', {
    name: 'Riverside Housing',
    address: { line1: '1 River Road', city: 'Cairo', countryCode: 'EG' },
  });
  expect(customer.statusCode, customer.body).toBe(201);
  customerId = json<{ id: string }>(customer).id;
  const site = await call(dispatcher, 'POST', `/v1/customers/${customerId}/sites`, {
    name: 'Block A',
    address: { line1: '1 River Road' },
  });
  expect(site.statusCode, site.body).toBe(201);
  siteId = json<{ id: string }>(site).id;
});

afterAll(async () => {
  await api.close();
});

describe('the module switch', () => {
  it('refuses every order route until sales is on; inventory is on for the stock', async () => {
    const refused = await call(dispatcher, 'GET', '/v1/sales/orders');
    expect(refused.statusCode).toBe(403);
    expect(code(refused)).toBe('feature_disabled');
    await setFlag('inventory', true);
    await setFlag('sales', true);
    const allowed = await call(dispatcher, 'GET', '/v1/sales/orders');
    expect(allowed.statusCode, allowed.body).toBe(200);
  });
});

describe('converting a quote', () => {
  it('makes one order from an accepted quote, carrying its lines, and never a second', async () => {
    const valve = await newItem();
    const quote = await call(dispatcher, 'POST', '/v1/sales/quotes', {
      customerId,
      siteId,
      title: 'Two valves and a visit',
      lines: [
        { itemId: valve.id, quantity: '2', discountBp: 1000 },
        { description: 'Call-out', quantity: '1', unitPrice: '50', taxRateBp: 1400 },
      ],
    });
    expect(quote.statusCode, quote.body).toBe(201);
    let detail = json<QuoteDetail>(quote);

    // Not accepted yet: a draft, then issued, cannot convert.
    const early = await call(dispatcher, 'POST', `/v1/sales/quotes/${detail.quote.id}/convert`, {
      expectedVersion: detail.quote.version,
    });
    expect(early.statusCode).toBe(409);
    expect(code(early)).toBe('quote_not_accepted');

    detail = json<QuoteDetail>(
      await call(owner, 'POST', `/v1/sales/quotes/${detail.quote.id}/issue`, {
        expectedVersion: detail.quote.version,
      }),
    );
    detail = json<QuoteDetail>(
      await call(dispatcher, 'POST', `/v1/sales/quotes/${detail.quote.id}/answer`, {
        expectedVersion: detail.quote.version,
        status: 'accepted',
        name: 'Mrs Hassan',
      }),
    );
    expect(detail.quote.status).toBe('accepted');
    expect(detail.can.convert).toBe(true);

    const converted = await call(
      dispatcher,
      'POST',
      `/v1/sales/quotes/${detail.quote.id}/convert`,
      {
        expectedVersion: detail.quote.version,
      },
    );
    expect(converted.statusCode, converted.body).toBe(201);
    const made = json<OrderDetail>(converted);
    expect(made.order).toMatchObject({
      status: 'draft',
      quote: { id: detail.quote.id, reference: expect.stringMatching(/^QT-\d{6}$/u) as string },
      totals: { total: '75' }, // 2 × 10 less 10% = 18, plus 50 + 14% tax = 57
      internalNotes: null,
      toOrder: false,
    });
    expect(made.order.reference).toMatch(/^SO-\d{6}$/u);
    expect(made.lines.map((line) => [line.description, line.quantity, line.stock])).toEqual([
      [expect.stringMatching(/^Part /u), '2', true],
      ['Call-out', '1', false],
    ]);
    expect(made.can).toMatchObject({ edit: true, confirm: false, linkJobs: true });

    const after = json<QuoteDetail>(
      await call(dispatcher, 'GET', `/v1/sales/quotes/${detail.quote.id}`),
    );
    expect(after.quote).toMatchObject({ status: 'converted', convertedOrderId: made.order.id });
    const again = await call(dispatcher, 'POST', `/v1/sales/quotes/${detail.quote.id}/convert`, {
      expectedVersion: after.quote.version,
    });
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('quote_converted');
  });
});

describe('confirming', () => {
  it('is for owners and admins, needs a location for stock lines, reserves what is there and flags the rest', async () => {
    const valve = await newItem();
    const store = await newStore();
    await receive(valve.id, store.id, '6');
    const first = await newOrder([
      { itemId: valve.id, quantity: '4' },
      { description: 'Fitting', quantity: '1', unitPrice: '80' },
    ]);
    expect(first.order.internalNotes).toBe('Keep an eye on the second valve.');

    expect((await confirm(first, store.id, dispatcher)).statusCode).toBe(403);
    const noLocation = await confirm(first, null);
    expect(noLocation.statusCode).toBe(422);
    expect(code(noLocation)).toBe('location_required');

    const confirmed = await confirm(first, store.id);
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    const held = json<OrderDetail>(confirmed);
    expect(held.order).toMatchObject({
      status: 'confirmed',
      confirmedTo: { customerName: 'Riverside Housing' },
      reserveLocation: { id: store.id },
      toOrder: false,
    });
    expect(held.lines.map((line) => [line.quantityReserved, line.shortfall])).toEqual([
      ['4', '0'],
      ['0', '1'], // not stock: delivered by the job, never "to order"
    ]);
    expect(held.can).toMatchObject({ edit: false, confirm: false, reserve: true, cancel: true });
    expect(await balance(valve.id, store.id)).toMatchObject({
      onHand: '6',
      reserved: '4',
      available: '2',
    });
    const item = json<{ reserved: string; available: string; stock: Balance[] }>(
      await call(dispatcher, 'GET', `/v1/inventory/items/${valve.id}`),
    );
    expect(item).toMatchObject({ reserved: '4', available: '2' });
    expect(item.stock[0]).toMatchObject({ reserved: '4', available: '2' });

    // A second order for five finds only two left to promise.
    const second = await newOrder([{ itemId: valve.id, quantity: '5' }]);
    const short = json<OrderDetail>(await confirm(second, store.id));
    expect(short.order.toOrder).toBe(true);
    expect(short.lines[0]).toMatchObject({ quantityReserved: '2', shortfall: '3' });
    const toOrder = json<{ items: { order: { id: string }; shortfall: string }[] }>(
      await call(dispatcher, 'GET', '/v1/sales/to-order'),
    );
    expect(toOrder.items.filter((row) => row.order.id === second.order.id)).toEqual([
      expect.objectContaining({ shortfall: '3' }),
    ]);

    // Goods arrive; a dispatcher re-runs the reservation.
    await receive(valve.id, store.id, '10');
    const rerun = await call(dispatcher, 'POST', `/v1/sales/orders/${second.order.id}/reserve`, {
      expectedVersion: short.order.version,
    });
    expect(rerun.statusCode, rerun.body).toBe(200);
    expect(json<OrderDetail>(rerun).lines[0]).toMatchObject({
      quantityReserved: '5',
      shortfall: '0',
    });
    expect(await balance(valve.id, store.id)).toMatchObject({
      onHand: '16',
      reserved: '9',
      available: '7',
    });

    // Confirmed lines are frozen.
    const edit = await call(dispatcher, 'PATCH', `/v1/sales/orders/${first.order.id}`, {
      expectedVersion: held.order.version,
      title: 'Changed',
    });
    expect(edit.statusCode).toBe(409);
    expect(code(edit)).toBe('order_not_draft');

    // Cancelling a confirmed order is for owners and admins, and lets go of what it held.
    const refused = await call(dispatcher, 'POST', `/v1/sales/orders/${second.order.id}/cancel`, {
      expectedVersion: json<OrderDetail>(rerun).order.version,
    });
    expect(refused.statusCode).toBe(403);
    const cancelled = await call(owner, 'POST', `/v1/sales/orders/${second.order.id}/cancel`, {
      expectedVersion: json<OrderDetail>(rerun).order.version,
      reason: 'Customer changed their mind',
    });
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(json<OrderDetail>(cancelled).order.status).toBe('cancelled');
    expect(await balance(valve.id, store.id)).toMatchObject({ reserved: '4', available: '12' });
  });

  it('cannot confirm an empty order', async () => {
    const empty = await newOrder([]);
    const response = await confirm(empty, null);
    expect(response.statusCode).toBe(422);
    expect(code(response)).toBe('order_empty');
  });
});

describe('the jobs that deliver an order', () => {
  it('are linked or created on purpose; their parts and completion deliver the lines, and nobody else takes reserved stock', async () => {
    const valve = await newItem();
    const store = await newStore();
    await receive(valve.id, store.id, '5');
    const draft = await newOrder([
      { itemId: valve.id, quantity: '3' },
      { description: 'Fitting', quantity: '1', unitPrice: '80' },
    ]);
    const confirmed = json<OrderDetail>(await confirm(draft, store.id));
    expect(confirmed.lines[0]).toMatchObject({ quantityReserved: '3' });

    // Another job of the same customer may take only what is not promised.
    const other = await newJob();
    const tooMany = await call(
      dispatcher,
      'POST',
      `/v1/work-orders/${other.workOrder.id}/materials`,
      { itemId: valve.id, locationId: store.id, quantity: '3' },
      randomUUID(),
    );
    expect(tooMany.statusCode, tooMany.body).toBe(201);
    expect(json<JobDetail>(tooMany).materials[0]).toMatchObject({
      status: 'conflict',
      availableQuantity: '2',
    });

    // Create a job for the order, from the order.
    const created = await call(
      dispatcher,
      'POST',
      `/v1/sales/orders/${draft.order.id}/work-orders`,
      {
        create: {
          jobTypeId,
          crew: [{ userId: engineer.userId, lead: true }],
        },
      },
      randomUUID(),
    );
    expect(created.statusCode, created.body).toBe(200);
    const withJob = json<OrderDetail>(created);
    expect(withJob.workOrders).toHaveLength(1);
    const jobId = withJob.workOrders[0]!.id;
    let job = json<JobDetail>(await call(dispatcher, 'GET', `/v1/work-orders/${jobId}`));
    expect(job.salesOrders).toEqual([expect.objectContaining({ id: draft.order.id })]);

    // Linking another customer's job is refused; linking this one again is harmless.
    const stranger = await call(dispatcher, 'POST', '/v1/customers', { name: `Other ${tag()}` });
    const strangerSite = await call(
      dispatcher,
      'POST',
      `/v1/customers/${json<{ id: string }>(stranger).id}/sites`,
      { name: 'Elsewhere', address: { line1: '2 Far Road' } },
    );
    const foreign = await call(dispatcher, 'POST', '/v1/work-orders', {
      customerId: json<{ id: string }>(stranger).id,
      siteId: json<{ id: string }>(strangerSite).id,
      jobTypeId,
    });
    const notTheirs = await call(
      dispatcher,
      'POST',
      `/v1/sales/orders/${draft.order.id}/work-orders`,
      { workOrderId: json<JobDetail>(foreign).workOrder.id },
      randomUUID(),
    );
    expect(notTheirs.statusCode).toBe(422);
    expect(code(notTheirs)).toBe('work_order_not_customers');
    const relinked = await call(
      dispatcher,
      'POST',
      `/v1/sales/orders/${draft.order.id}/work-orders`,
      { workOrderId: jobId },
      randomUUID(),
    );
    expect(relinked.statusCode, relinked.body).toBe(200);
    expect(json<OrderDetail>(relinked).workOrders).toHaveLength(1);

    // Parts used on the linked job come out of its reservation and deliver the line.
    const used = await call(
      dispatcher,
      'POST',
      `/v1/work-orders/${jobId}/materials`,
      { itemId: valve.id, locationId: store.id, quantity: '2' },
      randomUUID(),
    );
    expect(used.statusCode, used.body).toBe(201);
    expect(json<JobDetail>(used).materials.at(-1)).toMatchObject({ status: 'posted' });
    let current = await order(draft.order.id);
    expect(current.order.status).toBe('partially_fulfilled');
    expect(current.lines[0]).toMatchObject({
      quantityFulfilled: '2',
      quantityReserved: '1',
      shortfall: '0',
    });
    expect(await balance(valve.id, store.id)).toMatchObject({
      onHand: '3',
      reserved: '1',
      available: '2',
    });

    // The job completes: the fitting is delivered with it; the valve line waits for its last part.
    job = await move(job, 'dispatched');
    job = await move(job, 'on_site');
    job = await move(job, 'in_progress');
    job = await move(job, 'complete');
    expect(job.workOrder.state).toBe('complete');
    current = await order(draft.order.id);
    expect(current.order.status).toBe('partially_fulfilled');
    expect(current.lines[1]).toMatchObject({ quantityFulfilled: '1' });

    // The last valve, recorded after completion by the office, closes the order.
    const last = await call(
      dispatcher,
      'POST',
      `/v1/work-orders/${jobId}/materials`,
      { itemId: valve.id, locationId: store.id, quantity: '1' },
      randomUUID(),
    );
    expect(last.statusCode, last.body).toBe(201);
    current = await order(draft.order.id);
    expect(current.order.status).toBe('fulfilled');
    expect(current.lines.map((line) => line.quantityReserved)).toEqual(['0', '0']);
    expect(current.can).toMatchObject({ cancel: false, linkJobs: false, reserve: false });
    expect(await balance(valve.id, store.id)).toMatchObject({
      onHand: '2',
      reserved: '0',
      available: '2',
    });

    // Unlinking a job that was never linked is a 404; unlinking the real one works.
    const gone = await call(
      dispatcher,
      'DELETE',
      `/v1/sales/orders/${draft.order.id}/work-orders/${other.workOrder.id}`,
    );
    expect(gone.statusCode).toBe(404);
    const unlinked = await call(
      dispatcher,
      'DELETE',
      `/v1/sales/orders/${draft.order.id}/work-orders/${jobId}`,
    );
    expect(unlinked.statusCode, unlinked.body).toBe(200);
    expect(json<OrderDetail>(unlinked).workOrders).toEqual([]);
  });
});

describe('reading', () => {
  it('lists by status and text; engineers see nothing; another company cannot reach an order', async () => {
    const draft = await newOrder([{ description: 'Hand-written', quantity: '1', unitPrice: '1' }]);
    const list = json<{ items: OrderBody[] }>(
      await call(dispatcher, 'GET', `/v1/sales/orders?status=draft&q=${draft.order.reference}`),
    );
    expect(list.items.map((row) => row.id)).toEqual([draft.order.id]);
    expect((await call(engineer, 'GET', '/v1/sales/orders')).statusCode).toBe(403);

    const elsewhere = await getPlatformDataSource().tenants.create({
      slug: `so-other-${randomUUID().slice(0, 8)}`,
      name: 'Elsewhere Ltd',
    });
    const theirCustomer = await withTenant(elsewhere.id, (tx) =>
      tx.customers.create({ name: 'Theirs' }, randomUUID()),
    );
    const theirOrder = await withTenant(elsewhere.id, (tx) =>
      tx.salesOrders.createOrder(
        { customerId: theirCustomer.id, title: 'Theirs', currencyCode: 'EGP' },
        [],
        randomUUID(),
      ),
    );
    expect((await call(owner, 'GET', `/v1/sales/orders/${theirOrder.id}`)).statusCode).toBe(404);
    const cross = await call(dispatcher, 'POST', '/v1/sales/orders', {
      customerId: theirCustomer.id,
      title: 'Cross',
    });
    expect(cross.statusCode).toBe(404);
    expect(code(cross)).toBe('customer_not_found');
  });
});
