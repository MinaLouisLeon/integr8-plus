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
 * A company's invoices and credit notes over HTTP (CRM/ERP plan, phase B1;
 * ADR-0007): the module switch, dispatchers draft and owners issue, the
 * issuer settings, exact totals, numbering when issued, drafts from an order
 * and from a job that never bill the same thing twice, issued invoices that
 * never change, voids while untouched, credit notes no larger than the
 * balance, finding, and company isolation.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let dispatcher: Member;
let engineer: Member;
let viewer: Member;
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

interface InvoiceBody {
  id: string;
  reference: string | null;
  status: string;
  overdue: boolean;
  issueDate: string | null;
  dueDate: string | null;
  amounts: { total: string; allocated: string; credited: string; balance: string };
  totals: { gross: string; discount: string; net: string; tax: string; total: string };
  internalNotes: string | null;
  billedTo: { customerName: string } | null;
  issuer: { name: string; taxReference: string | null } | null;
  source: { kind: string; id: string; reference: string } | null;
  version: number;
}
interface InvoiceLine {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  total: string;
  salesOrderLineId: string | null;
  workOrderMaterialId: string | null;
}
interface InvoiceDetail {
  invoice: InvoiceBody;
  lines: InvoiceLine[];
  creditNotes: { id: string; reference: string | null; status: string; total: string }[];
  can: Record<string, boolean>;
}
interface CreditNoteDetail {
  creditNote: {
    id: string;
    reference: string | null;
    status: string;
    version: number;
    total: string;
  };
  invoice: { amounts: { balance: string; credited: string }; status: string };
  can: Record<string, boolean>;
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

const LINES = [
  {
    description: 'Annual service',
    quantity: '2',
    unitPrice: '100',
    discountBp: 1000,
    taxRateBp: 1400,
  },
  { description: 'Call-out', quantity: '1', unitPrice: '50' },
];

async function draft(payload: Record<string, unknown> = {}) {
  const response = await call(
    dispatcher,
    'POST',
    '/v1/finance/invoices',
    { customerId, internalNotes: 'Chase in person.', lines: LINES, ...payload },
    randomUUID(),
  );
  expect(response.statusCode, response.body).toBe(201);
  return json<InvoiceDetail>(response);
}

async function issue(detail: InvoiceDetail, payload: Record<string, unknown> = {}) {
  const response = await call(owner, 'POST', `/v1/finance/invoices/${detail.invoice.id}/issue`, {
    expectedVersion: detail.invoice.version,
    ...payload,
  });
  expect(response.statusCode, response.body).toBe(200);
  return json<InvoiceDetail>(response);
}

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin('fi-staff');
  owner = await api.member('owner', 'fi-owner');
  dispatcher = await api.member('dispatcher', 'fi-dispatcher');
  engineer = await api.member('engineer', 'fi-engineer');
  viewer = await api.member('viewer', 'fi-viewer');
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

describe('the finance module switch', () => {
  it('refuses every finance route until Integr8 switches it on', async () => {
    const refused = await call(dispatcher, 'GET', '/v1/finance/invoices');
    expect(refused.statusCode).toBe(403);
    expect(code(refused)).toBe('feature_disabled');
    await setFlag('finance', true);
    expect((await call(dispatcher, 'GET', '/v1/finance/invoices')).statusCode).toBe(200);
  });
});

describe('settings', () => {
  it('are set by owners and admins; the labour cost is theirs to see', async () => {
    const before = json<{ version: number; companyName: string; defaultDueDays: number }>(
      await call(viewer, 'GET', '/v1/finance/settings'),
    );
    expect(before).toMatchObject({ version: 0, defaultDueDays: 30 });
    expect(before.companyName).not.toBe('');
    const refused = await call(dispatcher, 'PUT', '/v1/finance/settings', {
      expectedVersion: 0,
      legalName: 'Riverside Services LLC',
    });
    expect(refused.statusCode).toBe(403);
    const saved = await call(owner, 'PUT', '/v1/finance/settings', {
      expectedVersion: 0,
      legalName: 'Northwind Services LLC',
      taxReference: 'TRN-100-200',
      paymentInstructions: 'Bank transfer to account 001',
      defaultDueDays: 14,
      labourHourlyCost: '120',
      labourHourlyRate: '200',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(json<{ labourHourlyCost: string | null; version: number }>(saved)).toMatchObject({
      labourHourlyCost: '120',
      version: 1,
    });
    const seenByViewer = json<{ labourHourlyCost: string | null; labourHourlyRate: string }>(
      await call(viewer, 'GET', '/v1/finance/settings'),
    );
    expect(seenByViewer).toMatchObject({ labourHourlyCost: null, labourHourlyRate: '200' });
    const stale = await call(owner, 'PUT', '/v1/finance/settings', {
      expectedVersion: 0,
      footer: 'x',
    });
    expect(stale.statusCode).toBe(409);
  });
});

describe('a blank invoice', () => {
  it('is drafted by a dispatcher, issued by an owner, numbered then, and never changes after', async () => {
    const drafted = await draft();
    expect(drafted.invoice).toMatchObject({
      reference: null,
      status: 'draft',
      internalNotes: 'Chase in person.',
      // 2 × 100 less 10% = 180, plus 14% = 205.2; plus 50.
      amounts: { total: '255.2', balance: '255.2' },
      totals: { gross: '250', discount: '20', net: '230', tax: '25.2', total: '255.2' },
    });
    expect(drafted.can).toMatchObject({ edit: true, discard: true, issue: false });

    const notYou = await call(
      dispatcher,
      'POST',
      `/v1/finance/invoices/${drafted.invoice.id}/issue`,
      {
        expectedVersion: drafted.invoice.version,
      },
    );
    expect(notYou.statusCode).toBe(403);
    const pastDue = await call(owner, 'POST', `/v1/finance/invoices/${drafted.invoice.id}/issue`, {
      expectedVersion: drafted.invoice.version,
      dueDate: '2020-01-01',
    });
    expect(pastDue.statusCode).toBe(422);
    expect(code(pastDue)).toBe('due_before_issue');

    const issued = await issue(drafted);
    expect(issued.invoice.reference).toMatch(/^INV-\d{6}$/u);
    expect(issued.invoice).toMatchObject({
      status: 'issued',
      billedTo: { customerName: 'Riverside Housing' },
      issuer: { name: 'Northwind Services LLC', taxReference: 'TRN-100-200' },
    });
    // Due 14 days after issue, the company default.
    const issueDay = new Date(`${issued.invoice.issueDate!}T00:00:00Z`);
    expect(issued.invoice.dueDate).toBe(
      new Date(issueDay.getTime() + 14 * 86_400_000).toISOString().slice(0, 10),
    );
    expect(issued.can).toMatchObject({
      edit: false,
      issue: false,
      void: true,
      credit: true,
      recordPayment: true,
    });

    const edit = await call(dispatcher, 'PATCH', `/v1/finance/invoices/${issued.invoice.id}`, {
      expectedVersion: issued.invoice.version,
      notes: 'Changed',
    });
    expect(edit.statusCode).toBe(409);
    expect(code(edit)).toBe('invoice_not_draft');

    const second = await issue(await draft());
    expect(Number(second.invoice.reference!.slice(4))).toBe(
      Number(issued.invoice.reference!.slice(4)) + 1,
    );
  });

  it('is discarded while a draft, leaving no gap; an empty draft is not issued', async () => {
    const empty = await draft({ lines: [] });
    const refused = await call(owner, 'POST', `/v1/finance/invoices/${empty.invoice.id}/issue`, {
      expectedVersion: empty.invoice.version,
    });
    expect(refused.statusCode).toBe(422);
    expect(code(refused)).toBe('invoice_empty');
    const discarded = await call(
      dispatcher,
      'POST',
      `/v1/finance/invoices/${empty.invoice.id}/discard`,
      {
        expectedVersion: empty.invoice.version,
      },
    );
    expect(discarded.statusCode, discarded.body).toBe(204);
    expect(
      (await call(dispatcher, 'GET', `/v1/finance/invoices/${empty.invoice.id}`)).statusCode,
    ).toBe(404);
  });

  it('is read by viewers without internal notes, and not at all by engineers', async () => {
    const drafted = await draft();
    const seen = json<InvoiceDetail>(
      await call(viewer, 'GET', `/v1/finance/invoices/${drafted.invoice.id}`),
    );
    expect(seen.invoice.internalNotes).toBeNull();
    expect(Object.values(seen.can).every((value) => !value)).toBe(true);
    expect((await call(engineer, 'GET', '/v1/finance/invoices')).statusCode).toBe(403);
  });
});

describe('voiding and crediting', () => {
  it('voids an untouched invoice with a reason, keeping its number', async () => {
    const issued = await issue(await draft());
    const voided = await call(owner, 'POST', `/v1/finance/invoices/${issued.invoice.id}/void`, {
      expectedVersion: issued.invoice.version,
      reason: 'Raised against the wrong customer',
    });
    expect(voided.statusCode, voided.body).toBe(200);
    expect(json<InvoiceDetail>(voided).invoice).toMatchObject({
      status: 'void',
      reference: issued.invoice.reference,
    });
  });

  it('credits part of an invoice, never more than it owes, and then refuses to void it', async () => {
    const issued = await issue(await draft());
    const partial = await call(
      dispatcher,
      'POST',
      `/v1/finance/invoices/${issued.invoice.id}/credit-notes`,
      {
        reason: 'Call-out waived',
        lines: [
          {
            invoiceLineId: issued.lines[1]!.id,
            description: 'Call-out',
            quantity: '1',
            unitPrice: '50',
          },
        ],
      },
      randomUUID(),
    );
    expect(partial.statusCode, partial.body).toBe(201);
    const note = json<CreditNoteDetail>(partial);
    expect(note.creditNote).toMatchObject({ reference: null, status: 'draft', total: '50' });
    const done = await call(owner, 'POST', `/v1/finance/credit-notes/${note.creditNote.id}/issue`, {
      expectedVersion: note.creditNote.version,
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(json<CreditNoteDetail>(done)).toMatchObject({
      creditNote: { status: 'issued', reference: expect.stringMatching(/^CN-\d{6}$/u) as string },
      invoice: { amounts: { credited: '50', balance: '205.2' } },
    });

    // The whole invoice is now more than it owes.
    const whole = json<CreditNoteDetail>(
      await call(
        dispatcher,
        'POST',
        `/v1/finance/invoices/${issued.invoice.id}/credit-notes`,
        { reason: 'Everything', whole: true },
        randomUUID(),
      ),
    );
    expect(whole.creditNote.total).toBe('255.2');
    const over = await call(
      owner,
      'POST',
      `/v1/finance/credit-notes/${whole.creditNote.id}/issue`,
      {
        expectedVersion: whole.creditNote.version,
      },
    );
    expect(over.statusCode).toBe(422);
    expect(code(over)).toBe('credit_over_balance');
    expect(
      (
        await call(dispatcher, 'POST', `/v1/finance/credit-notes/${whole.creditNote.id}/discard`, {
          expectedVersion: whole.creditNote.version,
        })
      ).statusCode,
    ).toBe(204);

    const now = json<InvoiceDetail>(
      await call(owner, 'GET', `/v1/finance/invoices/${issued.invoice.id}`),
    );
    expect(now.creditNotes).toHaveLength(1);
    expect(now.can.void).toBe(false);
    const voided = await call(owner, 'POST', `/v1/finance/invoices/${issued.invoice.id}/void`, {
      expectedVersion: now.invoice.version,
      reason: 'Too late',
    });
    expect(voided.statusCode).toBe(409);
    expect(code(voided)).toBe('invoice_settled');

    // A draft invoice cannot be credited.
    const drafted = await draft();
    const early = await call(
      dispatcher,
      'POST',
      `/v1/finance/invoices/${drafted.invoice.id}/credit-notes`,
      { reason: 'No', whole: true },
      randomUUID(),
    );
    expect(early.statusCode).toBe(409);
    expect(code(early)).toBe('invoice_not_issued');
  });
});

describe('from a sales order', () => {
  it('bills what was ordered or delivered, once, and refuses to bill more by editing', async () => {
    await setFlag('sales', true);
    const created = await call(dispatcher, 'POST', '/v1/sales/orders', {
      customerId,
      siteId,
      title: `Order ${tag()}`,
      lines: [
        { description: 'Pump installation', quantity: '2', unitPrice: '300', taxRateBp: 1400 },
      ],
    });
    expect(created.statusCode, created.body).toBe(201);
    const order = json<{ order: { id: string; version: number; reference: string } }>(created);

    const draftOrder = await call(
      dispatcher,
      'POST',
      '/v1/finance/invoices/from-order',
      { salesOrderId: order.order.id, basis: 'ordered' },
      randomUUID(),
    );
    expect(draftOrder.statusCode).toBe(409);
    expect(code(draftOrder)).toBe('order_not_billable');

    const confirmed = await call(owner, 'POST', `/v1/sales/orders/${order.order.id}/confirm`, {
      expectedVersion: order.order.version,
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);

    const nothingDelivered = await call(
      dispatcher,
      'POST',
      '/v1/finance/invoices/from-order',
      { salesOrderId: order.order.id, basis: 'delivered' },
      randomUUID(),
    );
    expect(nothingDelivered.statusCode).toBe(422);
    expect(code(nothingDelivered)).toBe('nothing_to_invoice');

    const ordered = await call(
      dispatcher,
      'POST',
      '/v1/finance/invoices/from-order',
      { salesOrderId: order.order.id, basis: 'ordered' },
      randomUUID(),
    );
    expect(ordered.statusCode, ordered.body).toBe(201);
    const fromOrder = json<InvoiceDetail>(ordered);
    expect(fromOrder.invoice.source).toEqual({
      kind: 'sales_order',
      id: order.order.id,
      reference: order.order.reference,
    });
    expect(fromOrder.lines).toEqual([
      expect.objectContaining({ description: 'Pump installation', quantity: '2', total: '684' }),
    ]);

    // Already billed: a second draft from the same order finds nothing.
    const again = await call(
      dispatcher,
      'POST',
      '/v1/finance/invoices/from-order',
      { salesOrderId: order.order.id, basis: 'ordered' },
      randomUUID(),
    );
    expect(again.statusCode).toBe(422);
    expect(code(again)).toBe('nothing_to_invoice');

    // Billing three of two by editing the draft is refused; one is fine.
    const line = fromOrder.lines[0]!;
    const tooMany = await call(
      dispatcher,
      'PATCH',
      `/v1/finance/invoices/${fromOrder.invoice.id}`,
      {
        expectedVersion: fromOrder.invoice.version,
        lines: [
          {
            description: line.description,
            quantity: '3',
            unitPrice: line.unitPrice,
            salesOrderLineId: line.salesOrderLineId,
          },
        ],
      },
    );
    expect(tooMany.statusCode).toBe(422);
    expect(code(tooMany)).toBe('over_invoiced');
    const fewer = await call(dispatcher, 'PATCH', `/v1/finance/invoices/${fromOrder.invoice.id}`, {
      expectedVersion: fromOrder.invoice.version,
      lines: [
        {
          description: line.description,
          quantity: '1',
          unitPrice: line.unitPrice,
          taxRateBp: 1400,
          salesOrderLineId: line.salesOrderLineId,
        },
      ],
    });
    expect(fewer.statusCode, fewer.body).toBe(200);
    // Now one is left to bill.
    const rest = await call(
      dispatcher,
      'POST',
      '/v1/finance/invoices/from-order',
      { salesOrderId: order.order.id, basis: 'ordered' },
      randomUUID(),
    );
    expect(rest.statusCode, rest.body).toBe(201);
    expect(json<InvoiceDetail>(rest).lines[0]).toMatchObject({ quantity: '1' });
    const listed = json<{ items: { id: string }[] }>(
      await call(dispatcher, 'GET', `/v1/finance/invoices?salesOrderId=${order.order.id}`),
    );
    expect(listed.items).toHaveLength(2);
  });
});

describe('from a job', () => {
  it('bills the parts used on a completed job, once', async () => {
    await setFlag('inventory', true);
    const item = json<{ id: string }>(
      await call(dispatcher, 'POST', '/v1/inventory/items', {
        sku: `VAL-${tag()}`,
        name: 'Ball valve',
        salePrice: '35',
      }),
    );
    const store = json<{ id: string }>(
      await call(dispatcher, 'POST', '/v1/inventory/locations', {
        name: `Store ${tag()}`,
        kind: 'warehouse',
      }),
    );
    expect(
      (
        await call(
          dispatcher,
          'POST',
          '/v1/inventory/movements',
          { type: 'receipt', itemId: item.id, locationId: store.id, quantity: '5', unitCost: '20' },
          randomUUID(),
        )
      ).statusCode,
    ).toBe(201);
    let job = json<{ workOrder: { id: string; revision: number } }>(
      await call(dispatcher, 'POST', '/v1/work-orders', {
        customerId,
        siteId,
        jobTypeId,
        crew: [{ userId: engineer.userId, lead: true }],
      }),
    );
    const used = await call(
      dispatcher,
      'POST',
      `/v1/work-orders/${job.workOrder.id}/materials`,
      { itemId: item.id, locationId: store.id, quantity: '2' },
      randomUUID(),
    );
    expect(used.statusCode, used.body).toBe(201);

    const early = await call(
      dispatcher,
      'POST',
      '/v1/finance/invoices/from-job',
      { workOrderId: job.workOrder.id },
      randomUUID(),
    );
    expect(early.statusCode).toBe(409);
    expect(code(early)).toBe('job_not_complete');

    for (const to of ['dispatched', 'on_site', 'in_progress', 'complete']) {
      const moved = await call(
        dispatcher,
        'POST',
        `/v1/work-orders/${job.workOrder.id}/transitions`,
        {
          to,
          expectedRevision: job.workOrder.revision,
        },
      );
      expect(moved.statusCode, moved.body).toBe(200);
      job = json<typeof job>(moved);
    }

    const created = await call(
      dispatcher,
      'POST',
      '/v1/finance/invoices/from-job',
      { workOrderId: job.workOrder.id },
      randomUUID(),
    );
    expect(created.statusCode, created.body).toBe(201);
    const fromJob = json<InvoiceDetail>(created);
    expect(fromJob.invoice.source).toMatchObject({ kind: 'work_order', id: job.workOrder.id });
    expect(fromJob.lines[0]).toMatchObject({
      description: 'Ball valve',
      quantity: '2',
      unitPrice: '35',
      total: '70',
    });
    expect(fromJob.lines[0]!.workOrderMaterialId).not.toBeNull();

    const twice = await call(
      dispatcher,
      'POST',
      '/v1/finance/invoices/from-job',
      { workOrderId: job.workOrder.id },
      randomUUID(),
    );
    expect(twice.statusCode).toBe(409);
    expect(code(twice)).toBe('job_already_invoiced');

    // The same part twice on the draft is refused.
    const line = fromJob.lines[0]!;
    const doubled = await call(dispatcher, 'PATCH', `/v1/finance/invoices/${fromJob.invoice.id}`, {
      expectedVersion: fromJob.invoice.version,
      lines: [line, line].map((each) => ({
        description: each.description,
        quantity: '1',
        unitPrice: each.unitPrice,
        workOrderMaterialId: each.workOrderMaterialId,
      })),
    });
    expect(doubled.statusCode).toBe(422);
    expect(code(doubled)).toBe('over_invoiced');
  });
});

describe('finding invoices', () => {
  it('by reference, derived status and overdue', async () => {
    const issued = await issue(await draft());
    const byReference = json<{ items: { id: string }[] }>(
      await call(dispatcher, 'GET', `/v1/finance/invoices?q=${issued.invoice.reference!}`),
    );
    expect(byReference.items.map((row) => row.id)).toEqual([issued.invoice.id]);
    const issuedOnes = json<{ items: { status: string }[] }>(
      await call(dispatcher, 'GET', '/v1/finance/invoices?status=issued&limit=100'),
    );
    expect(issuedOnes.items.length).toBeGreaterThan(0);
    expect(issuedOnes.items.every((row) => row.status === 'issued')).toBe(true);
    const overdue = json<{ items: unknown[] }>(
      await call(dispatcher, 'GET', '/v1/finance/invoices?overdue=true'),
    );
    expect(overdue.items).toEqual([]);
  });
});

describe('another company', () => {
  it('cannot be reached by id', async () => {
    const elsewhere = await getPlatformDataSource().tenants.create({
      slug: `fi-other-${randomUUID().slice(0, 8)}`,
      name: 'Elsewhere Ltd',
    });
    const theirCustomer = await withTenant(elsewhere.id, (tx) =>
      tx.customers.create({ name: 'Theirs' }, randomUUID()),
    );
    const theirInvoice = await withTenant(elsewhere.id, (tx) =>
      tx.financeInvoices.createInvoice(
        { customerId: theirCustomer.id, currencyCode: 'EGP' },
        [{ description: 'x', quantity: '1', unitPrice: '1' }],
        randomUUID(),
      ),
    );
    expect((await call(owner, 'GET', `/v1/finance/invoices/${theirInvoice.id}`)).statusCode).toBe(
      404,
    );
    const cross = await call(
      dispatcher,
      'POST',
      '/v1/finance/invoices',
      { customerId: theirCustomer.id },
      randomUUID(),
    );
    expect(cross.statusCode).toBe(404);
    expect(code(cross)).toBe('customer_not_found');
  });
});
