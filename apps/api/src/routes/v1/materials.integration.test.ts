import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Parts used on jobs over HTTP and through the phone's sync (CRM/ERP plan,
 * phase E2; ADR-0005): the module switch, an engineer's parts come from their
 * own van on their own jobs, the server decides under the lock — posted or a
 * conflict, never negative — conflicts are resolved by the office, returns
 * reverse a use, and a phone's action posts once however often it arrives.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let dispatcher: Member;
let engineer: Member;
let colleague: Member;
const tokens = new Map<Member, string>();
let jobTypeId: string;
let customerId: string;
let siteId: string;

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

interface MaterialBody {
  id: string;
  item: { id: string };
  location: { id: string } | null;
  quantity: string;
  returnedQuantity: string;
  unitCost: string | null;
  status: string;
  availableQuantity: string | null;
  clientActionId: string | null;
}
interface Detail {
  workOrder: { id: string; referenceLabel: string };
  materials: MaterialBody[];
  materialsCost: string | null;
  van: { id: string; name: string } | null;
  can: { recordParts: boolean };
}

const tag = () => randomUUID().slice(0, 6);

async function newItem(payload: Record<string, unknown> = {}) {
  const response = await call(dispatcher, 'POST', '/v1/inventory/items', {
    sku: `PART-${tag()}`,
    name: `Part ${tag()}`,
    ...payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ id: string }>(response);
}

async function newLocation(payload: Record<string, unknown> = {}) {
  const response = await call(dispatcher, 'POST', '/v1/inventory/locations', {
    name: `Store ${tag()}`,
    kind: 'warehouse',
    ...payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ id: string; name: string }>(response);
}

async function stock(itemId: string, locationId: string, quantity: string, unitCost = '10') {
  const response = await call(
    dispatcher,
    'POST',
    '/v1/inventory/movements',
    { type: 'receipt', itemId, locationId, quantity, unitCost },
    randomUUID(),
  );
  expect(response.statusCode, response.body).toBe(201);
}

async function onHand(itemId: string, locationId: string): Promise<string> {
  const balances = json<{ items: { location: { id: string }; onHand: string }[] }>(
    await call(dispatcher, 'GET', `/v1/inventory/balances?itemId=${itemId}`),
  );
  return balances.items.find((row) => row.location.id === locationId)?.onHand ?? '0';
}

async function newJob(crew: Member[]): Promise<Detail> {
  const response = await call(dispatcher, 'POST', '/v1/work-orders', {
    customerId,
    siteId,
    jobTypeId,
    crew: crew.map((member, index) => ({ userId: member.userId, lead: index === 0 })),
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<Detail>(response);
}

const use = (
  who: Member,
  job: Detail,
  payload: Record<string, unknown>,
  key: string | null = randomUUID(),
) => call(who, 'POST', `/v1/work-orders/${job.workOrder.id}/materials`, payload, key);

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin('mat-staff');
  owner = await api.member('owner', 'mat-owner');
  dispatcher = await api.member('dispatcher', 'mat-dispatcher');
  engineer = await api.member('engineer', 'mat-engineer');
  colleague = await api.member('engineer', 'mat-colleague');

  const type = await api.call(await api.staff(owner), {
    method: 'POST',
    url: '/v1/job-types',
    payload: { name: 'Boiler service', code: 'boiler' },
  });
  expect(type.statusCode, type.body).toBe(201);
  jobTypeId = json<{ id: string }>(type).id;
  const customer = await call(dispatcher, 'POST', '/v1/customers', { name: 'Riverside' });
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

async function setFlag(key: string, enabled: boolean) {
  const response = await api.call(admin.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

describe('the module switch', () => {
  it('shows a job without parts, and refuses to record any, until inventory is on', async () => {
    const job = await newJob([engineer]);
    expect(job).toMatchObject({ materials: [], materialsCost: null, van: null });
    expect(job.can.recordParts).toBe(false);
    const refused = await use(engineer, job, { itemId: randomUUID(), quantity: '1' });
    expect(refused.statusCode).toBe(403);
    expect(code(refused)).toBe('feature_disabled');

    await setFlag('inventory', true);
    const seen = json<Detail>(await call(engineer, 'GET', `/v1/work-orders/${job.workOrder.id}`));
    expect(seen.can.recordParts).toBe(true);
  });
});

describe('an engineer', () => {
  it('uses parts from their own van on their own job, which the office sees costed', async () => {
    const valve = await newItem();
    const van = await newLocation({
      name: `Van ${tag()}`,
      kind: 'van',
      assignedTo: engineer.userId,
    });
    await stock(valve.id, van.id, '5', '12');
    const job = await newJob([engineer]);
    expect(
      json<Detail>(await call(engineer, 'GET', `/v1/work-orders/${job.workOrder.id}`)).van,
    ).toEqual({ id: van.id, name: van.name });

    const noKey = await use(engineer, job, { itemId: valve.id, quantity: '2' }, null);
    expect(noKey.statusCode).toBe(400);

    const used = await use(engineer, job, { itemId: valve.id, quantity: '2', note: 'Replaced' });
    expect(used.statusCode, used.body).toBe(201);
    const mine = json<Detail>(used);
    expect(mine.materials).toHaveLength(1);
    expect(mine.materials[0]).toMatchObject({
      item: { id: valve.id },
      location: { id: van.id },
      quantity: '2',
      status: 'posted',
      unitCost: null,
    });
    expect(mine.materialsCost).toBeNull();
    expect(await onHand(valve.id, van.id)).toBe('3');

    const office = json<Detail>(
      await call(dispatcher, 'GET', `/v1/work-orders/${job.workOrder.id}`),
    );
    expect(office.materials[0]?.unitCost).toBe('12');
    expect(office.materialsCost).toBe('24');

    const movements = json<{ items: { kind: string; quantity: string; reason: string | null }[] }>(
      await call(dispatcher, 'GET', `/v1/inventory/movements?itemId=${valve.id}`),
    );
    expect(movements.items[0]).toMatchObject({
      kind: 'consumption',
      quantity: '-2',
      reason: job.workOrder.referenceLabel,
    });
  });

  it('is refused and flagged when the van does not hold enough; the office resolves it', async () => {
    const pump = await newItem();
    const van = await newLocation({
      name: `Van ${tag()}`,
      kind: 'van',
      assignedTo: colleague.userId,
    });
    await stock(pump.id, van.id, '3');
    const job = await newJob([colleague]);

    const short = await use(colleague, job, { itemId: pump.id, quantity: '10' });
    expect(short.statusCode, short.body).toBe(201);
    const flagged = json<Detail>(short).materials[0]!;
    expect(flagged).toMatchObject({ status: 'conflict', availableQuantity: '3', unitCost: null });
    expect(await onHand(pump.id, van.id)).toBe('3');

    const waiting = json<{ items: { id: string; workOrder: { id: string } }[] }>(
      await call(dispatcher, 'GET', '/v1/inventory/materials/conflicts'),
    );
    expect(waiting.items.map((row) => [row.id, row.workOrder.id])).toContainEqual([
      flagged.id,
      job.workOrder.id,
    ]);
    expect((await call(colleague, 'GET', '/v1/inventory/materials/conflicts')).statusCode).toBe(
      403,
    );

    // The engineer may not retry; the office may, and with 3 it posts.
    const engineerRetry = await call(
      colleague,
      'POST',
      `/v1/work-orders/${job.workOrder.id}/materials/${flagged.id}/resolve`,
      { action: 'retry', quantity: '3' },
    );
    expect(engineerRetry.statusCode).toBe(403);
    const retried = await call(
      dispatcher,
      'POST',
      `/v1/work-orders/${job.workOrder.id}/materials/${flagged.id}/resolve`,
      { action: 'retry', quantity: '3' },
    );
    expect(retried.statusCode, retried.body).toBe(200);
    expect(json<Detail>(retried).materials[0]).toMatchObject({
      status: 'posted',
      quantity: '3',
      availableQuantity: null,
      unitCost: '10',
    });
    expect(await onHand(pump.id, van.id)).toBe('0');

    // A second refusal the engineer drops themselves.
    const again = json<Detail>(await use(colleague, job, { itemId: pump.id, quantity: '1' }));
    const second = again.materials.find((row) => row.status === 'conflict')!;
    const cancelled = await call(
      colleague,
      'POST',
      `/v1/work-orders/${job.workOrder.id}/materials/${second.id}/resolve`,
      { action: 'cancel' },
    );
    expect(cancelled.statusCode, cancelled.body).toBe(200);
    expect(json<Detail>(cancelled).materials.find((row) => row.id === second.id)?.status).toBe(
      'cancelled',
    );
    const twice = await call(
      colleague,
      'POST',
      `/v1/work-orders/${job.workOrder.id}/materials/${second.id}/resolve`,
      { action: 'cancel' },
    );
    expect(twice.statusCode).toBe(409);
    expect(code(twice)).toBe('not_a_conflict');
  });

  it('needs a van and their own job; a dispatcher names any location', async () => {
    const cable = await newItem();
    const store = await newLocation();
    await stock(cable.id, store.id, '20');
    const job = await newJob([engineer]);

    // The colleague is not on this job: to them it is not there.
    const notMine = await use(colleague, job, { itemId: cable.id, quantity: '1' });
    expect(notMine.statusCode).toBe(404);

    // The owner has no van: the office names where from.
    const nowhere = await use(owner, job, { itemId: cable.id, quantity: '1' });
    expect(nowhere.statusCode).toBe(422);
    expect(code(nowhere)).toBe('location_required');
    const fromStore = await use(dispatcher, job, {
      itemId: cable.id,
      quantity: '1.5',
      locationId: store.id,
    });
    expect(fromStore.statusCode, fromStore.body).toBe(201);
    expect(await onHand(cable.id, store.id)).toBe('18.5');

    // An engineer without a van (the colleague lost theirs) cannot take stock.
    const vanless = await api.member('engineer', 'mat-vanless');
    const vanlessJob = await newJob([vanless]);
    const noVan = await use(vanless, vanlessJob, { itemId: cable.id, quantity: '1' });
    expect(noVan.statusCode).toBe(422);
    expect(code(noVan)).toBe('no_van');
    // …but may record a service, which touches no stock.
    const callout = await newItem({ kind: 'service', name: 'Call-out', defaultUnitCost: '40' });
    const recorded = await use(vanless, vanlessJob, { itemId: callout.id, quantity: '1' });
    expect(recorded.statusCode, recorded.body).toBe(201);
    expect(json<Detail>(recorded).materials[0]).toMatchObject({
      status: 'posted',
      location: null,
    });
    expect(
      json<Detail>(await call(dispatcher, 'GET', `/v1/work-orders/${vanlessJob.workOrder.id}`))
        .materialsCost,
    ).toBe('40');
  });

  it('puts an unused part back, never more than was used', async () => {
    const filter = await newItem();
    const van = await newLocation({
      name: `Van ${tag()}`,
      kind: 'van',
      assignedTo: engineer.userId,
    }).catch(() => undefined);
    // The engineer already has a van from an earlier test; find it.
    const detail = json<Detail>(
      await call(engineer, 'GET', `/v1/work-orders/${(await newJob([engineer])).workOrder.id}`),
    );
    const vanId = van?.id ?? detail.van!.id;
    await stock(filter.id, vanId, '4');
    const job = await newJob([engineer]);
    const used = json<Detail>(await use(engineer, job, { itemId: filter.id, quantity: '3' }));
    const material = used.materials[0]!;
    expect(await onHand(filter.id, vanId)).toBe('1');

    const back = await call(
      engineer,
      'POST',
      `/v1/work-orders/${job.workOrder.id}/materials/${material.id}/return`,
      { quantity: '2', reason: 'Not needed' },
      randomUUID(),
    );
    expect(back.statusCode, back.body).toBe(201);
    expect(json<Detail>(back).materials[0]).toMatchObject({ quantity: '3', returnedQuantity: '2' });
    expect(await onHand(filter.id, vanId)).toBe('3');
    expect(
      json<Detail>(await call(dispatcher, 'GET', `/v1/work-orders/${job.workOrder.id}`))
        .materialsCost,
    ).toBe('10');

    const over = await call(
      engineer,
      'POST',
      `/v1/work-orders/${job.workOrder.id}/materials/${material.id}/return`,
      { quantity: '2' },
      randomUUID(),
    );
    expect(over.statusCode).toBe(422);
    expect(code(over)).toBe('over_returned');
    expect(await onHand(filter.id, vanId)).toBe('3');
  });
});

describe('from the phone', () => {
  it('posts a use once however often it arrives, flags a short one, and sends the van stock down', async () => {
    const seal = await newItem();
    const job = await newJob([engineer]);
    const detail = json<Detail>(await call(engineer, 'GET', `/v1/work-orders/${job.workOrder.id}`));
    const vanId = detail.van!.id;
    await stock(seal.id, vanId, '2');

    const pulled = json<{
      vanStock: {
        location: { id: string } | null;
        items: { item: { id: string }; onHand: string }[];
      };
    }>(await call(engineer, 'GET', '/v1/sync/pull'));
    expect(pulled.vanStock.location?.id).toBe(vanId);
    expect(pulled.vanStock.items.find((row) => row.item.id === seal.id)?.onHand).toBe('2');

    const materialId = randomUUID();
    const mutation = {
      id: randomUUID(),
      entityId: job.workOrder.id,
      recordedAt: new Date().toISOString(),
      kind: 'work_order.material',
      payload: { materialId, itemId: seal.id, quantity: '1', note: 'From the van' },
    };
    const push = (mutations: Record<string, unknown>[]) =>
      call(engineer, 'POST', '/v1/sync/push', { sentAt: new Date().toISOString(), mutations });
    const first = json<{ results: { outcome: string; alreadyApplied: boolean }[] }>(
      await push([mutation]),
    );
    expect(first.results[0]).toMatchObject({ outcome: 'applied', alreadyApplied: false });
    // The same action under a new change id (a reinstalled phone, say) still posts once.
    const again = json<{ results: { outcome: string; alreadyApplied: boolean }[] }>(
      await push([{ ...mutation, id: randomUUID() }]),
    );
    expect(again.results[0]).toMatchObject({ outcome: 'applied', alreadyApplied: true });
    expect(await onHand(seal.id, vanId)).toBe('1');

    const short = json<{ results: { outcome: string }[] }>(
      await push([
        {
          ...mutation,
          id: randomUUID(),
          payload: { materialId: randomUUID(), itemId: seal.id, quantity: '5' },
        },
      ]),
    );
    expect(short.results[0]?.outcome).toBe('applied');
    const after = json<Detail>(await call(engineer, 'GET', `/v1/work-orders/${job.workOrder.id}`));
    expect(after.materials.map((row) => [row.status, row.quantity, row.clientActionId])).toEqual([
      ['posted', '1', materialId],
      ['conflict', '5', expect.any(String)],
    ]);
    expect(await onHand(seal.id, vanId)).toBe('1');
  });
});

describe('closed, cancelled and invoiced jobs (0062)', () => {
  interface Transitioned {
    workOrder: { id: string; revision: number; state: string };
  }
  interface Marked extends Detail {
    materials: (MaterialBody & { recordedAfterClose: boolean })[];
    partsNotYetBilled: boolean;
  }
  const move = async (
    job: { workOrder: { id: string } },
    path: string[],
    reason?: string,
    who: Member = dispatcher,
  ) => {
    let current = json<Transitioned>(
      await call(dispatcher, 'GET', `/v1/work-orders/${job.workOrder.id}`),
    );
    for (const to of path) {
      const response = await call(who, 'POST', `/v1/work-orders/${job.workOrder.id}/transitions`, {
        to,
        expectedRevision: current.workOrder.revision,
        ...(reason === undefined ? {} : { reason }),
      });
      expect(response.statusCode, response.body).toBe(200);
      current = json<Transitioned>(response);
    }
  };
  const push = async (job: Detail, itemId: string, recordedAt: Date) => {
    const response = await call(engineer, 'POST', '/v1/sync/push', {
      sentAt: new Date().toISOString(),
      mutations: [
        {
          id: randomUUID(),
          entityId: job.workOrder.id,
          recordedAt: recordedAt.toISOString(),
          kind: 'work_order.material',
          payload: { materialId: randomUUID(), itemId, quantity: '1' },
        },
      ],
    });
    return json<{ results: { outcome: string; code?: string }[] }>(response).results[0]!;
  };
  const seen = async (job: Detail) =>
    json<Marked>(await call(dispatcher, 'GET', `/v1/work-orders/${job.workOrder.id}`));

  it('takes a phone part recorded before the job closed, marked, and bills it on a follow-up invoice', async () => {
    await setFlag('finance', true);
    const gasket = await newItem({ salePrice: '30' });
    const job = await newJob([engineer]);
    const vanId = json<Detail>(await call(engineer, 'GET', `/v1/work-orders/${job.workOrder.id}`))
      .van!.id;
    await stock(gasket.id, vanId, '5');

    const onSite = new Date(Date.now() - 60_000);
    await move(job, ['dispatched', 'on_site', 'in_progress', 'complete']);

    // The office's screen refuses new parts on a closed job.
    const refused = await use(dispatcher, job, {
      itemId: gasket.id,
      quantity: '1',
      locationId: vanId,
    });
    expect(refused.statusCode).toBe(409);
    expect(code(refused)).toBe('work_order_closed');

    // The phone's part, recorded on site before the job closed, is taken and marked.
    expect(await push(job, gasket.id, onSite)).toMatchObject({ outcome: 'applied' });
    // One recorded after the job closed is not.
    expect(await push(job, gasket.id, new Date())).toMatchObject({
      outcome: 'rejected',
      code: 'work_order_closed',
    });
    let detail = await seen(job);
    expect(detail.materials.map((row) => [row.status, row.recordedAfterClose])).toEqual([
      ['posted', true],
    ]);
    expect(await onHand(gasket.id, vanId)).toBe('4');
    expect(detail.can.recordParts).toBe(false);

    // Invoiced; then another part from the phone arrives, recorded before the close.
    const first = await call(owner, 'POST', '/v1/finance/invoices/from-job', {
      workOrderId: job.workOrder.id,
    });
    expect(first.statusCode, first.body).toBe(201);
    expect(detail.partsNotYetBilled).toBe(false);
    expect(await push(job, gasket.id, onSite)).toMatchObject({ outcome: 'applied' });
    detail = await seen(job);
    expect(detail.partsNotYetBilled).toBe(true);
    expect(detail.materialsCost).toBe('20');
    const waiting = json<{ items: { id: string; partsNotYetBilled: boolean }[] }>(
      await call(owner, 'GET', '/v1/finance/invoices?partsNotBilled=true'),
    );
    expect(waiting.items).toEqual([
      expect.objectContaining({
        id: json<{ invoice: { id: string } }>(first).invoice.id,
        partsNotYetBilled: true,
      }),
    ]);

    // The follow-up bills just the part not yet billed, and no labour again.
    const followUp = await call(owner, 'POST', '/v1/finance/invoices/from-job', {
      workOrderId: job.workOrder.id,
    });
    expect(followUp.statusCode, followUp.body).toBe(201);
    const { lines } = json<{
      lines: { workOrderMaterialId: string | null; quantity: string }[];
    }>(followUp);
    expect(lines).toEqual([
      expect.objectContaining({ workOrderMaterialId: detail.materials[1]!.id, quantity: '1' }),
    ]);
    expect((await seen(job)).partsNotYetBilled).toBe(false);
    const again = await call(owner, 'POST', '/v1/finance/invoices/from-job', {
      workOrderId: job.workOrder.id,
    });
    expect(code(again)).toBe('job_already_invoiced');

    // Returning an unused part stays allowed.
    const back = await call(
      engineer,
      'POST',
      `/v1/work-orders/${job.workOrder.id}/materials/${detail.materials[0]!.id}/return`,
      { quantity: '1' },
      randomUUID(),
    );
    expect(back.statusCode, back.body).toBe(201);
  });

  it('refuses parts on a cancelled job from everywhere, and on an invoiced job from the office', async () => {
    const washer = await newItem();
    const job = await newJob([engineer]);
    const vanId = json<Detail>(await call(engineer, 'GET', `/v1/work-orders/${job.workOrder.id}`))
      .van!.id;
    await stock(washer.id, vanId, '5');
    const before = new Date(Date.now() - 60_000);
    await move(job, ['cancelled'], 'Customer cancelled');
    expect(await push(job, washer.id, before)).toMatchObject({
      outcome: 'rejected',
      code: 'work_order_closed',
    });
    const refused = await use(engineer, job, { itemId: washer.id, quantity: '1' });
    expect(code(refused)).toBe('work_order_closed');
    expect(await onHand(washer.id, vanId)).toBe('5');

    // Reopened after it was invoiced: the office cannot add parts nobody would bill.
    const invoiced = await newJob([engineer]);
    await use(engineer, invoiced, { itemId: washer.id, quantity: '1' });
    await move(invoiced, ['dispatched', 'on_site', 'in_progress', 'complete']);
    const bill = await call(owner, 'POST', '/v1/finance/invoices/from-job', {
      workOrderId: invoiced.workOrder.id,
    });
    expect(bill.statusCode, bill.body).toBe(201);
    await move(invoiced, ['in_progress'], 'One more check', owner);
    const late = await use(engineer, invoiced, { itemId: washer.id, quantity: '1' });
    expect(late.statusCode).toBe(409);
    expect(code(late)).toBe('work_order_invoiced');
    expect((await seen(invoiced)).can.recordParts).toBe(false);
  });
});
