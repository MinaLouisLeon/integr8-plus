import { day, type DemoContext } from '../context.js';
import { itemBySku } from './inventory.js';

/**
 * Invoices, credit notes and payments, in every state the screens show.
 *
 * Invoices are drafted from completed jobs and sales orders when earlier
 * sections left some (refs.workOrders, refs.salesOrders), and written by hand
 * for the rest. Every line carries 14% VAT.
 *
 * Issue dates cannot be backdated and a due date cannot be before today, so
 * "overdue" is the invoice issued due today: it shows as overdue from
 * tomorrow.
 *
 * Adds to refs:
 *   invoices  { id, status, customerId, total }[]
 */

const VAT = 1400;

interface InvoiceDetail {
  invoice: {
    id: string;
    version: number;
    status: string;
    customer: { id: string };
    amounts: { total: string; balance: string };
  };
}

interface Customer {
  id: string;
  name: string;
  contacts: string[];
  sites: { id: string; name: string }[];
}

type Line = Record<string, unknown>;

export async function seedFinance(ctx: DemoContext): Promise<void> {
  const customers = ctx.refs.customers as Customer[];
  const invoices: { id: string; status: string; customerId: string; total: string }[] = [];
  const customer = (index: number) => customers[index % customers.length]!;

  const line = (sku: string, quantity: string, discountBp = 0): Line => {
    const item = itemBySku(ctx, sku);
    return {
      itemId: item.id,
      description: item.name,
      quantity,
      unit: item.unit,
      unitPrice: item.price,
      taxRateBp: VAT,
      ...(discountBp === 0 ? {} : { discountBp }),
    };
  };
  const service = (description: string, quantity: string, unitPrice: string): Line => ({
    description,
    quantity,
    unit: 'hour',
    unitPrice,
    taxRateBp: VAT,
  });

  const draft = async (index: number, lines: Line[], notes?: string) => {
    const target = customer(index);
    return ctx.call<InvoiceDetail>('owner', 'POST', '/v1/finance/invoices', {
      customerId: target.id,
      ...(target.sites[0] === undefined ? {} : { siteId: target.sites[0].id }),
      ...(target.contacts[0] === undefined ? {} : { contactId: target.contacts[0] }),
      currencyCode: 'EGP',
      ...(notes === undefined ? {} : { notes }),
      lines,
    });
  };
  const issue = async (detail: InvoiceDetail, dueDate?: string) =>
    ctx.call<InvoiceDetail>('owner', 'POST', `/v1/finance/invoices/${detail.invoice.id}/issue`, {
      expectedVersion: detail.invoice.version,
      ...(dueDate === undefined ? {} : { dueDate }),
    });
  const totalOf = (detail: InvoiceDetail) => detail.invoice.amounts.total;
  const record = (detail: InvoiceDetail, status: string) => {
    invoices.push({
      id: detail.invoice.id,
      status,
      customerId: detail.invoice.customer.id,
      total: totalOf(detail),
    });
  };

  // From completed jobs: parts used and labour come across.
  const workOrders = (ctx.refs.workOrders as { id: string; state: string }[] | undefined) ?? [];
  const finished = workOrders.filter(
    (order) => order.state === 'complete' || order.state === 'reviewed',
  );
  let fromJobs = 0;
  for (const [index, order] of finished.slice(0, 3).entries()) {
    const drafted = await ctx.attempt<InvoiceDetail>(
      'owner',
      'POST',
      '/v1/finance/invoices/from-job',
      {
        workOrderId: order.id,
      },
    );
    if (drafted === undefined) {
      continue;
    }
    fromJobs += 1;
    if (index < 2) {
      const issued = await ctx.attempt<InvoiceDetail>(
        'owner',
        'POST',
        `/v1/finance/invoices/${drafted.invoice.id}/issue`,
        { expectedVersion: drafted.invoice.version },
      );
      record(issued ?? drafted, issued === undefined ? 'draft' : 'issued');
    } else {
      record(drafted, 'draft');
    }
  }

  // From sales orders: what was ordered, or what was delivered.
  const salesOrders = (ctx.refs.salesOrders as { id: string; status: string }[] | undefined) ?? [];
  const invoiceable = salesOrders.filter((order) => !['draft', 'cancelled'].includes(order.status));
  let fromOrders = 0;
  for (const order of invoiceable.slice(0, 2)) {
    const drafted =
      (await ctx.attempt<InvoiceDetail>('owner', 'POST', '/v1/finance/invoices/from-order', {
        salesOrderId: order.id,
        basis: 'delivered',
      })) ??
      (await ctx.attempt<InvoiceDetail>('owner', 'POST', '/v1/finance/invoices/from-order', {
        salesOrderId: order.id,
        basis: 'ordered',
      }));
    if (drafted === undefined) {
      continue;
    }
    fromOrders += 1;
    const issued = await ctx.attempt<InvoiceDetail>(
      'owner',
      'POST',
      `/v1/finance/invoices/${drafted.invoice.id}/issue`,
      { expectedVersion: drafted.invoice.version },
    );
    record(issued ?? drafted, issued === undefined ? 'draft' : 'issued');
  }

  // By hand. Paid in full.
  const paid1 = await issue(
    await draft(
      0,
      [line('SV-PPM-VISIT', '2'), line('HV-FLT-001', '8'), line('CN-CLN-005', '5')],
      'Quarterly PPM, Towers A and B.',
    ),
  );
  record(paid1, 'paid');
  const paid2 = await issue(
    await draft(1, [
      line('SV-CALL-OUT', '1'),
      service('Engineer labour — theatre AHU repair', '3', '650.00'),
      line('HV-FAN-250', '1'),
    ]),
  );
  record(paid2, 'paid');
  const paid3 = await issue(
    await draft(4, [line('EL-LED-040', '12', 1000), service('Fitting LED panels', '6', '650.00')]),
  );
  record(paid3, 'paid');

  // Part-paid.
  const part1 = await issue(
    await draft(3, [
      line('EQ-SPL-240', '2'),
      line('EQ-BRK-KIT', '2'),
      service('Installation, cold store office', '8', '650.00'),
    ]),
  );
  record(part1, 'part_paid');
  const part2 = await issue(
    await draft(5, [
      line('EQ-SPL-120', '4', 500),
      service('Installation, guest rooms', '10', '650.00'),
    ]),
  );
  record(part2, 'part_paid');

  // Issued, not yet paid.
  const open1 = await issue(
    await draft(2, [
      line('PL-VLV-022', '6'),
      line('PL-PMP-001', '1'),
      service('Pump replacement', '4', '650.00'),
    ]),
  );
  record(open1, 'issued');
  const open2 = await issue(
    await draft(6, [line('SV-PPM-VISIT', '1'), line('HV-CAP-035', '2')]),
    day(14),
  );
  record(open2, 'issued');

  // Due today: overdue from tomorrow.
  const overdue = await issue(
    await draft(
      7,
      [line('SV-CALL-OUT', '1'), service('Freezer alarm fault-finding', '2', '650.00')],
      'Second reminder sent.',
    ),
    day(0),
  );
  record(overdue, 'overdue');

  // Credited in part: two filters returned unused.
  const credited = await issue(
    await draft(0, [line('HV-FLT-001', '10'), line('SV-PPM-VISIT', '1')]),
  );
  record(credited, 'credited');
  const note = await ctx.call<{ creditNote: { id: string; version: number } }>(
    'owner',
    'POST',
    `/v1/finance/invoices/${credited.invoice.id}/credit-notes`,
    {
      reason: 'Two filters returned unused',
      lines: [{ ...line('HV-FLT-001', '2') }],
    },
  );
  await ctx.call('owner', 'POST', `/v1/finance/credit-notes/${note.creditNote.id}/issue`, {
    expectedVersion: note.creditNote.version,
  });
  // A second credit note left as a draft.
  await ctx.attempt('owner', 'POST', `/v1/finance/invoices/${open1.invoice.id}/credit-notes`, {
    reason: 'Goodwill discount on labour, awaiting approval',
    lines: [service('Goodwill: one hour of labour', '1', '650.00')],
  });

  // Voided: raised against the wrong customer.
  const voided = await issue(await draft(3, [line('SV-PPM-VISIT', '1')]));
  await ctx.call('owner', 'POST', `/v1/finance/invoices/${voided.invoice.id}/void`, {
    expectedVersion: voided.invoice.version,
    reason: 'Raised against the wrong customer',
  });
  record(voided, 'void');

  // Drafts, and one discarded.
  const draft1 = await draft(
    1,
    [line('PL-GDT-001', '2'), service('Gas detector installation', '3', '650.00')],
    'Waiting for the PO number.',
  );
  record(draft1, 'draft');
  record(await draft(4, [line('SF-GLV-001', '20'), line('CN-SIL-300', '6')]), 'draft');
  const discarded = await draft(5, [line('SV-LAB-HR', '1')]);
  await ctx.call('owner', 'POST', `/v1/finance/invoices/${discarded.invoice.id}/discard`, {
    expectedVersion: discarded.invoice.version,
  });

  // Payments. Amounts are read back from the issued invoices, so they match.
  const pay = async (
    target: InvoiceDetail,
    amount: string,
    receivedOn: string,
    method: 'cash' | 'bank_transfer' | 'other',
    reference: string,
  ) => {
    const customerId = target.invoice.customer.id;
    await ctx.call('owner', 'POST', '/v1/finance/payments', {
      customerId,
      receivedOn,
      amount,
      currencyCode: 'EGP',
      method,
      paymentReference: reference,
      allocations: [{ invoiceId: target.invoice.id, amount }],
    });
  };
  const half = (detail: InvoiceDetail) => (Number(totalOf(detail)) / 2).toFixed(2);

  await pay(paid1, totalOf(paid1), day(-1), 'bank_transfer', 'NBE-TRX-88213');
  await pay(paid2, totalOf(paid2), day(0), 'bank_transfer', 'CIB-55102');
  await pay(paid3, totalOf(paid3), day(0), 'cash', 'Receipt book 0142');
  await pay(part1, half(part1), day(0), 'bank_transfer', 'NBE-TRX-88407');
  await pay(part2, '10000.00', day(0), 'other', 'Cheque 004512');

  // On account: money received, not yet put against an invoice.
  await ctx.call('owner', 'POST', '/v1/finance/payments', {
    customerId: customer(2).id,
    receivedOn: day(0),
    amount: '5000.00',
    currencyCode: 'EGP',
    method: 'bank_transfer',
    paymentReference: 'Advance for next quarter',
    notes: 'Not yet allocated: the customer will tell us which invoice.',
  });

  // Read back where each one ended up, after payments and credits.
  for (const entry of invoices) {
    const current = await ctx.attempt<InvoiceDetail>(
      'owner',
      'GET',
      `/v1/finance/invoices/${entry.id}`,
    );
    if (current !== undefined) {
      entry.status = current.invoice.status;
    }
  }
  ctx.refs.invoices = invoices;
  ctx.log(
    `${String(invoices.length)} invoices (${String(fromJobs)} from jobs, ${String(fromOrders)} from sales orders), 2 credit notes, 6 payments`,
  );
}
