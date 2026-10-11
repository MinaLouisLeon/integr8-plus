import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Payments, the customer's account and job cost over HTTP (CRM/ERP plan,
 * phase B1; ADR-0007): only owners and admins record money, once per key;
 * allocations never exceed the payment or the invoice and can be taken
 * back; the invoice's status follows; what is left stays on account; and a
 * job's cost against what it earned, shown only to those who see costs.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let dispatcher: Member;
let engineer: Member;
let viewer: Member;
const tokens = new Map<Member, string>();
let customerId: string;
let otherCustomerId: string;
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

interface InvoiceDetail {
  invoice: {
    id: string;
    reference: string;
    status: string;
    version: number;
    amounts: { total: string; allocated: string; balance: string };
  };
  payments: { allocationId: string; amount: string; receipt: { reference: string } }[];
  can: Record<string, boolean>;
}
interface ReceiptDetail {
  receipt: {
    id: string;
    reference: string;
    amount: string;
    allocated: string;
    unallocated: string;
  };
  allocations: { id: string; amount: string; invoice: { id: string }; removedAt: string | null }[];
  openInvoices: { id: string }[];
  can: Record<string, boolean>;
}
interface JobCosts {
  seesCosts: boolean;
  parts: { cost: string | null };
  labour: { hours: string; cost: string | null; costed: boolean };
  cost: string | null;
  invoiced: { net: string; invoices: number };
  profit: string | null;
}

const today = () => new Date().toISOString().slice(0, 10);

async function setFlag(key: string) {
  const response = await api.call(admin.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
    payload: { enabled: true },
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** An issued invoice for 114: 100 plus 14% tax. */
async function issuedInvoice(customer = customerId) {
  const drafted = json<InvoiceDetail>(
    await call(
      dispatcher,
      'POST',
      '/v1/finance/invoices',
      {
        customerId: customer,
        lines: [{ description: 'Service', quantity: '1', unitPrice: '100', taxRateBp: 1400 }],
      },
      randomUUID(),
    ),
  );
  const issued = await call(owner, 'POST', `/v1/finance/invoices/${drafted.invoice.id}/issue`, {
    expectedVersion: drafted.invoice.version,
  });
  expect(issued.statusCode, issued.body).toBe(200);
  return json<InvoiceDetail>(issued);
}

const pay = (
  payload: Record<string, unknown>,
  key: string | null = randomUUID(),
  who: Member = owner,
) =>
  call(
    who,
    'POST',
    '/v1/finance/payments',
    { customerId, receivedOn: today(), method: 'bank_transfer', ...payload },
    key,
  );

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin('fp-staff');
  owner = await api.member('owner', 'fp-owner');
  dispatcher = await api.member('dispatcher', 'fp-dispatcher');
  engineer = await api.member('engineer', 'fp-engineer');
  viewer = await api.member('viewer', 'fp-viewer');
  await setFlag('finance');
  const type = await api.call(await api.staff(owner), {
    method: 'POST',
    url: '/v1/job-types',
    payload: { name: 'Boiler service', code: 'boiler' },
  });
  jobTypeId = json<{ id: string }>(type).id;
  customerId = json<{ id: string }>(
    await call(dispatcher, 'POST', '/v1/customers', { name: 'Riverside Housing' }),
  ).id;
  otherCustomerId = json<{ id: string }>(
    await call(dispatcher, 'POST', '/v1/customers', { name: 'Other Housing' }),
  ).id;
  siteId = json<{ id: string }>(
    await call(dispatcher, 'POST', `/v1/customers/${customerId}/sites`, {
      name: 'Block A',
      address: { line1: '1 River Road' },
    }),
  ).id;
});

afterAll(async () => {
  await api.close();
});

describe('recording a payment', () => {
  it('is for owners and admins, needs a key, and is recorded once per key', async () => {
    expect((await pay({ amount: '10' }, randomUUID(), dispatcher)).statusCode).toBe(403);
    expect((await pay({ amount: '10' }, null)).statusCode).toBe(400);
    const future = await pay({ amount: '10', receivedOn: '2099-01-01' });
    expect(future.statusCode).toBe(422);
    expect(code(future)).toBe('received_in_future');

    const key = randomUUID();
    const first = await pay({ amount: '25', paymentReference: 'TRX-77' }, key);
    expect(first.statusCode, first.body).toBe(201);
    const again = await pay({ amount: '25', paymentReference: 'TRX-77' }, key);
    expect(again.statusCode).toBe(201);
    expect(json<ReceiptDetail>(again).receipt.id).toBe(json<ReceiptDetail>(first).receipt.id);
    expect(json<ReceiptDetail>(first).receipt).toMatchObject({
      reference: expect.stringMatching(/^RC-\d{6}$/u) as string,
      amount: '25',
      unallocated: '25',
    });
    const found = json<{ items: { id: string }[] }>(
      await call(viewer, 'GET', '/v1/finance/payments?q=TRX-77'),
    );
    expect(found.items.map((row) => row.id)).toEqual([json<ReceiptDetail>(first).receipt.id]);
    expect((await call(engineer, 'GET', '/v1/finance/payments')).statusCode).toBe(403);
  });

  it('is allocated to invoices on the way in; the invoice’s status follows and the rest stays on account', async () => {
    const one = await issuedInvoice();
    const two = await issuedInvoice();
    const recorded = await pay({
      amount: '150',
      allocations: [
        { invoiceId: one.invoice.id, amount: '114' },
        { invoiceId: two.invoice.id, amount: '30' },
      ],
    });
    expect(recorded.statusCode, recorded.body).toBe(201);
    const receipt = json<ReceiptDetail>(recorded);
    expect(receipt.receipt).toMatchObject({ allocated: '144', unallocated: '6' });
    expect(receipt.can.allocate).toBe(true);

    const paid = json<InvoiceDetail>(
      await call(owner, 'GET', `/v1/finance/invoices/${one.invoice.id}`),
    );
    expect(paid.invoice).toMatchObject({
      status: 'paid',
      amounts: { allocated: '114', balance: '0' },
    });
    expect(paid.payments).toEqual([
      expect.objectContaining({
        amount: '114',
        receipt: { id: receipt.receipt.id, reference: receipt.receipt.reference },
      }),
    ]);
    expect(paid.can).toMatchObject({ recordPayment: false, void: false, credit: false });
    const partly = json<InvoiceDetail>(
      await call(owner, 'GET', `/v1/finance/invoices/${two.invoice.id}`),
    );
    expect(partly.invoice).toMatchObject({ status: 'partially_paid', amounts: { balance: '84' } });

    // Over what is left, over what is owed, another customer: all refused.
    const overReceipt = await call(
      owner,
      'POST',
      `/v1/finance/payments/${receipt.receipt.id}/allocations`,
      {
        invoiceId: two.invoice.id,
        amount: '7',
      },
    );
    expect(overReceipt.statusCode).toBe(422);
    expect(code(overReceipt)).toBe('over_receipt');
    const theirs = await issuedInvoice(otherCustomerId);
    const mismatch = await call(
      owner,
      'POST',
      `/v1/finance/payments/${receipt.receipt.id}/allocations`,
      {
        invoiceId: theirs.invoice.id,
        amount: '1',
      },
    );
    expect(mismatch.statusCode).toBe(422);
    expect(code(mismatch)).toBe('allocation_mismatch');
    const bigger = json<ReceiptDetail>(await pay({ amount: '500' }));
    const overInvoice = await call(
      owner,
      'POST',
      `/v1/finance/payments/${bigger.receipt.id}/allocations`,
      {
        invoiceId: two.invoice.id,
        amount: '85',
      },
    );
    expect(overInvoice.statusCode).toBe(422);
    expect(code(overInvoice)).toBe('over_invoice');

    // A refused allocation on the way in records nothing at all.
    const before = json<{ items: unknown[] }>(
      await call(owner, 'GET', '/v1/finance/payments?limit=100'),
    );
    const refused = await pay({
      amount: '10',
      allocations: [{ invoiceId: two.invoice.id, amount: '11' }],
    });
    expect(refused.statusCode).toBe(422);
    const after = json<{ items: unknown[] }>(
      await call(owner, 'GET', '/v1/finance/payments?limit=100'),
    );
    expect(after.items).toHaveLength(before.items.length);

    // Taking an allocation back: the invoice owes it again; the record stays.
    const allocationId = receipt.allocations.find((row) => row.invoice.id === two.invoice.id)!.id;
    const removed = await call(
      owner,
      'POST',
      `/v1/finance/payments/${receipt.receipt.id}/allocations/${allocationId}/remove`,
    );
    expect(removed.statusCode, removed.body).toBe(200);
    expect(json<ReceiptDetail>(removed).receipt).toMatchObject({
      allocated: '114',
      unallocated: '36',
    });
    expect(
      json<ReceiptDetail>(removed).allocations.find((row) => row.id === allocationId)!.removedAt,
    ).not.toBeNull();
    const twice = await call(
      owner,
      'POST',
      `/v1/finance/payments/${receipt.receipt.id}/allocations/${allocationId}/remove`,
    );
    expect(twice.statusCode).toBe(409);
    expect(code(twice)).toBe('allocation_removed');
    expect(
      json<InvoiceDetail>(await call(owner, 'GET', `/v1/finance/invoices/${two.invoice.id}`))
        .invoice.status,
    ).toBe('issued');
  });
});

describe('the customer’s account', () => {
  it('says what is owed, what is on account, and which invoices and payments are open', async () => {
    const fresh = json<{ id: string }>(
      await call(dispatcher, 'POST', '/v1/customers', { name: 'Account Ltd' }),
    ).id;
    const invoice = await issuedInvoice(fresh);
    await pay({
      customerId: fresh,
      amount: '200',
      allocations: [{ invoiceId: invoice.invoice.id, amount: '50' }],
    });
    const account = json<{
      accounts: { currencyCode: string; owed: string; unallocated: string; net: string }[];
      openInvoices: { id: string; amounts: { balance: string } }[];
      unallocatedPayments: { unallocated: string }[];
    }>(await call(viewer, 'GET', `/v1/finance/customers/${fresh}/account`));
    expect(account.accounts).toEqual([
      { currencyCode: 'EGP', owed: '64', unallocated: '150', net: '-86' },
    ]);
    expect(account.openInvoices).toEqual([
      expect.objectContaining({
        id: invoice.invoice.id,
        amounts: expect.objectContaining({ balance: '64' }) as unknown,
      }),
    ]);
    expect(account.unallocatedPayments.map((row) => row.unallocated)).toEqual(['150']);
  });
});

describe('a job’s cost', () => {
  it('adds parts and labour at the company rate, against what the job earned, for those who see costs', async () => {
    await setFlag('inventory');
    expect(
      (
        await call(owner, 'PUT', '/v1/finance/settings', {
          expectedVersion: 0,
          labourHourlyCost: '100',
          labourHourlyRate: '150',
        })
      ).statusCode,
    ).toBe(200);
    const item = json<{ id: string }>(
      await call(dispatcher, 'POST', '/v1/inventory/items', {
        sku: `P-${randomUUID().slice(0, 6)}`,
        name: 'Valve',
        salePrice: '40',
      }),
    );
    const store = json<{ id: string }>(
      await call(dispatcher, 'POST', '/v1/inventory/locations', {
        name: `S-${randomUUID().slice(0, 6)}`,
        kind: 'warehouse',
      }),
    );
    await call(
      dispatcher,
      'POST',
      '/v1/inventory/movements',
      { type: 'receipt', itemId: item.id, locationId: store.id, quantity: '4', unitCost: '12.5' },
      randomUUID(),
    );
    let job = json<{ workOrder: { id: string; revision: number } }>(
      await call(dispatcher, 'POST', '/v1/work-orders', {
        customerId,
        siteId,
        jobTypeId,
        crew: [{ userId: engineer.userId, lead: true }],
      }),
    );
    await call(
      dispatcher,
      'POST',
      `/v1/work-orders/${job.workOrder.id}/materials`,
      { itemId: item.id, locationId: store.id, quantity: '2' },
      randomUUID(),
    );
    for (const to of ['dispatched', 'on_site', 'in_progress', 'complete']) {
      job = json<typeof job>(
        await call(dispatcher, 'POST', `/v1/work-orders/${job.workOrder.id}/transitions`, {
          to,
          expectedRevision: job.workOrder.revision,
        }),
      );
    }

    const before = json<JobCosts>(
      await call(dispatcher, 'GET', `/v1/finance/work-orders/${job.workOrder.id}/costs`),
    );
    expect(before).toMatchObject({
      seesCosts: true,
      parts: { cost: '25' },
      labour: { hours: '0', cost: '0', costed: true },
      cost: '25',
      invoiced: { net: '0', invoices: 0 },
      profit: '-25',
    });
    const hidden = json<JobCosts>(
      await call(viewer, 'GET', `/v1/finance/work-orders/${job.workOrder.id}/costs`),
    );
    expect(hidden).toMatchObject({
      seesCosts: false,
      parts: { cost: null },
      cost: null,
      profit: null,
    });

    const drafted = json<InvoiceDetail>(
      await call(
        dispatcher,
        'POST',
        '/v1/finance/invoices/from-job',
        { workOrderId: job.workOrder.id },
        randomUUID(),
      ),
    );
    await call(owner, 'POST', `/v1/finance/invoices/${drafted.invoice.id}/issue`, {
      expectedVersion: drafted.invoice.version,
    });
    const after = json<JobCosts>(
      await call(owner, 'GET', `/v1/finance/work-orders/${job.workOrder.id}/costs`),
    );
    expect(after).toMatchObject({ invoiced: { net: '80', invoices: 1 }, profit: '55' });
  });
});
