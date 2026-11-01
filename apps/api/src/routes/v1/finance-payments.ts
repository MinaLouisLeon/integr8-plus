import {
  compareDecimals,
  formatInvoiceReference,
  formatReceiptReference,
  formatWorkOrderReference,
  holds,
  hoursOfMs,
  jobTimes,
  multiplyDecimals,
  paymentMethodSchema,
  type Principal,
  positiveQuantitySchema,
} from '@integr8/core';
import {
  addDecimals,
  type AllocationRefusal,
  type PaymentReceipt,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { crmAudit as audit, decodeDateCursor, encodeDateCursor } from './crm-shared.js';
import {
  FINANCE,
  FINANCE_TAGS,
  invoiceSummaries,
  invoiceSummarySchema,
} from './finance-invoices.js';
import { peopleOf, personBody, personSchema, readableWorkOrder } from './operations.js';
import { companyToday } from './sales-quotes.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Money a company received from its customers, the customer's account, and
 * what a job cost against what it earned (CRM/ERP plan, phase B1; ADR-0007).
 *
 * A payment is recorded by hand — no gateway — by an owner or admin, once,
 * and allocated to the customer's issued invoices; the database refuses to
 * allocate more than the payment has or the invoice owes. What is not
 * allocated stays on the customer's account.
 */

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export const receiptSummarySchema = z.object({
  id: z.uuid(),
  /** `RC-000123`. */
  reference: z.string(),
  customer: z.object({ id: z.uuid(), name: z.string() }),
  receivedOn: z.iso.date(),
  amount: z.string(),
  currencyCode: z.string(),
  method: paymentMethodSchema,
  paymentReference: z.string().nullable(),
  allocated: z.string(),
  /** Still on the customer's account; nothing once reversed. */
  unallocated: z.string(),
  /** Taken back (0064): its allocations were removed and the ledger took the money back. */
  reversed: z.boolean(),
  recordedAt: z.iso.datetime(),
});

export const allocationSchema = z.object({
  id: z.uuid(),
  invoice: z.object({ id: z.uuid(), reference: z.string().nullable() }),
  receipt: z.object({
    id: z.uuid(),
    reference: z.string(),
    receivedOn: z.iso.date(),
    method: paymentMethodSchema,
  }),
  amount: z.string(),
  allocatedBy: personSchema,
  allocatedAt: z.iso.datetime(),
  removedBy: personSchema.nullable(),
  removedAt: z.iso.datetime().nullable(),
});

export const receiptDetailSchema = z.object({
  receipt: receiptSummarySchema.extend({ notes: z.string().nullable(), recordedBy: personSchema }),
  /** Why, when and by whom the payment was taken back (0064); null while it stands. */
  reversal: z
    .object({
      reason: z.string(),
      reversedOn: z.iso.date(),
      reversedBy: personSchema,
      reversedAt: z.iso.datetime(),
    })
    .nullable(),
  /** Every allocation, removed ones included, oldest first. */
  allocations: z.array(allocationSchema),
  /** The customer's issued invoices in this currency that still owe, for allocating. */
  openInvoices: z.array(invoiceSummarySchema),
  can: z.object({
    allocate: z.boolean(),
    removeAllocation: z.boolean(),
    /** Take the payment back, with a reason: owners and admins, once (0064). */
    reverse: z.boolean(),
  }),
});

const accountSchema = z.object({
  currencyCode: z.string(),
  owed: z.string(),
  unallocated: z.string(),
  net: z.string(),
});

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

async function receiptSummaries(
  tx: TenantTransaction,
  receipts: readonly PaymentReceipt[],
): Promise<z.infer<typeof receiptSummarySchema>[]> {
  const [customers, amounts, reversals] = await Promise.all([
    tx.customers.findMany([...new Set(receipts.map((receipt) => receipt.customerId))]),
    tx.financePayments.receiptAmounts(receipts.map((receipt) => receipt.id)),
    tx.financePayments.reversalsFor(receipts.map((receipt) => receipt.id)),
  ]);
  const customer = new Map(customers.map((row) => [row.id, row]));
  return receipts.map((receipt) => {
    const figures = amounts.get(receipt.id) ?? {
      amount: receipt.amount,
      allocated: '0',
      unallocated: receipt.amount,
    };
    return {
      id: receipt.id,
      reference: formatReceiptReference(receipt.reference),
      customer: { id: receipt.customerId, name: customer.get(receipt.customerId)?.name ?? '' },
      receivedOn: receipt.receivedOn,
      amount: receipt.amount,
      currencyCode: receipt.currencyCode,
      method: receipt.method,
      paymentReference: receipt.paymentReference,
      allocated: figures.allocated,
      unallocated: figures.unallocated,
      reversed: reversals.has(receipt.id),
      recordedAt: iso(receipt.recordedAt),
    };
  });
}

/** Allocations shaped with their invoice and receipt, for a receipt or an invoice. */
export async function allocationBodies(
  tx: TenantTransaction,
  allocations: readonly {
    id: string;
    receiptId: string;
    invoiceId: string;
    amount: string;
    allocatedBy: string;
    allocatedAt: Date;
    removedBy: string | null;
    removedAt: Date | null;
  }[],
): Promise<z.infer<typeof allocationSchema>[]> {
  if (allocations.length === 0) {
    return [];
  }
  const [names, invoices, receipts] = await Promise.all([
    peopleOf(tx),
    tx.financeInvoices.findInvoices(allocations.map((row) => row.invoiceId)),
    tx.financePayments.findReceipts(allocations.map((row) => row.receiptId)),
  ]);
  const invoice = new Map(invoices.map((row) => [row.id, row]));
  const receipt = new Map(receipts.map((row) => [row.id, row]));
  return allocations.map((row) => {
    const of = invoice.get(row.invoiceId)!;
    const from = receipt.get(row.receiptId)!;
    return {
      id: row.id,
      invoice: {
        id: of.id,
        reference: of.reference === null ? null : formatInvoiceReference(of.reference),
      },
      receipt: {
        id: from.id,
        reference: formatReceiptReference(from.reference),
        receivedOn: from.receivedOn,
        method: from.method,
      },
      amount: row.amount,
      allocatedBy: personBody(row.allocatedBy, names),
      allocatedAt: iso(row.allocatedAt),
      removedBy: row.removedBy === null ? null : personBody(row.removedBy, names),
      removedAt: isoOrNull(row.removedAt),
    };
  });
}

/** The customer's issued invoices in a currency that still owe, oldest due first. */
async function openInvoicesFor(
  tx: TenantTransaction,
  customerId: string,
  currencyCode: string | undefined,
  today: string,
): Promise<z.infer<typeof invoiceSummarySchema>[]> {
  const page = await tx.financeInvoices.listInvoices({
    customerId,
    statuses: ['issued', 'partially_paid'],
    limit: 100,
  });
  const shaped = await invoiceSummaries(tx, page.items, today);
  return shaped
    .filter((row) => currencyCode === undefined || row.currencyCode === currencyCode)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''));
}

async function receiptDetail(
  tx: TenantTransaction,
  principal: Principal,
  receipt: PaymentReceipt,
): Promise<z.infer<typeof receiptDetailSchema>> {
  const [summary, allocations, names, today, reversals] = await Promise.all([
    receiptSummaries(tx, [receipt]),
    tx.financePayments.allocationsForReceipt(receipt.id),
    peopleOf(tx),
    companyToday(tx),
    tx.financePayments.reversalsFor([receipt.id]),
  ]);
  const issue = holds(principal, 'finance.issue');
  const reversal = reversals.get(receipt.id);
  return {
    receipt: {
      ...summary[0]!,
      notes: receipt.notes,
      recordedBy: personBody(receipt.recordedBy, names),
    },
    reversal:
      reversal === undefined
        ? null
        : {
            reason: reversal.reason,
            reversedOn: reversal.reversedOn,
            reversedBy: personBody(reversal.reversedBy, names),
            reversedAt: iso(reversal.reversedAt),
          },
    allocations: await allocationBodies(tx, allocations),
    openInvoices:
      reversal === undefined
        ? await openInvoicesFor(tx, receipt.customerId, receipt.currencyCode, today)
        : [],
    can: {
      allocate:
        issue && reversal === undefined && compareDecimals(summary[0]!.unallocated, '0') > 0,
      removeAllocation: issue && reversal === undefined,
      reverse: issue && reversal === undefined,
    },
  };
}

function allocationRefusal(refusal: AllocationRefusal, field: string): never {
  switch (refusal) {
    case 'over_receipt':
      throw unprocessable('over_receipt', 'That is more than this payment has left to allocate.', [
        { field, code: 'over_receipt', message: 'More than the payment has left.' },
      ]);
    case 'over_invoice':
      throw unprocessable('over_invoice', 'That is more than the invoice still owes.', [
        { field, code: 'over_invoice', message: 'More than the invoice owes.' },
      ]);
    case 'invoice_not_open':
      throw conflict('invoice_not_issued', 'Payments are allocated only to issued invoices.');
    case 'mismatch':
      throw unprocessable(
        'allocation_mismatch',
        'A payment is allocated only to the same customer’s invoices in its currency.',
      );
    case 'receipt_reversed':
      throw conflict('payment_reversed', 'This payment was reversed; it is not allocated again.');
  }
}

// ---------------------------------------------------------------------------
// Routes: payments
// ---------------------------------------------------------------------------

const receiptParams = z.object({ receiptId: z.uuid() });

export const listPaymentsRoute = defineRoute({
  method: 'get',
  path: '/v1/finance/payments',
  operationId: 'listCustomerPayments',
  summary: 'Find payments received',
  description:
    'Newest first. `q` matches a reference (`RC-000123`), the bank reference, or words of the customer’s name; `unallocated=true` keeps those with money left on account.',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.read',
  feature: FINANCE,
  params: noSchema,
  query: z.object({
    q: z.string().trim().max(200).optional(),
    customerId: z.uuid().optional(),
    unallocated: z.enum(['true', 'false']).optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of payments.',
      schema: z.object({ items: z.array(receiptSummarySchema), nextCursor: z.string().nullable() }),
    },
  },
  handler: async ({ query }, context) => {
    const after = decodeDateCursor(query.cursor);
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const page = await tx.financePayments.listReceipts({
        ...(query.q === undefined ? {} : { text: query.q }),
        ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
        ...(query.unallocated === 'true' ? { unallocatedOnly: true } : {}),
        ...(after === undefined ? {} : { after: { recordedAt: after.createdAt, id: after.id } }),
        limit: query.limit,
      });
      return {
        items: await receiptSummaries(tx, page.items),
        nextCursor: encodeDateCursor(
          page.next === undefined
            ? undefined
            : { createdAt: page.next.recordedAt, id: page.next.id },
        ),
      };
    });
    return { status: 200, body };
  },
});

const allocationInputSchema = z.object({ invoiceId: z.uuid(), amount: positiveQuantitySchema });

export const recordPaymentRoute = defineRoute({
  method: 'post',
  path: '/v1/finance/payments',
  operationId: 'recordCustomerPayment',
  summary: 'Record a payment received',
  description:
    'Owners and admins. Recorded by hand (cash, bank transfer, other) — no gateway — and never changed afterwards. `allocations` puts it against the customer’s issued invoices at once; anything left stays on account. The whole request is refused if any allocation is (422 `over_receipt`, `over_invoice`, `allocation_mismatch`; 409 `invoice_not_issued`). A date after today is 422 `received_in_future`. **`Idempotency-Key` required**: money is never recorded twice.',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.issue',
  feature: FINANCE,
  idempotent: 'required',
  params: noSchema,
  query: noSchema,
  body: z.object({
    customerId: z.uuid(),
    receivedOn: z.iso.date(),
    amount: positiveQuantitySchema,
    currencyCode: z
      .string()
      .regex(/^[A-Z]{3}$/u)
      .optional(),
    method: paymentMethodSchema,
    paymentReference: z.string().trim().max(200).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    allocations: z.array(allocationInputSchema).max(50).default([]),
  }),
  responses: {
    201: { description: 'The payment.', schema: receiptDetailSchema },
    404: { description: 'No such customer or invoice.' },
    409: { description: 'An invoice is not issued.' },
    422: { description: 'An allocation is refused, or the date is in the future.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const customer = await tx.customers.find(body.customerId);
      if (customer === undefined) {
        throw notFound('This customer does not exist.');
      }
      if (body.receivedOn > (await companyToday(tx))) {
        throw unprocessable('received_in_future', 'A payment cannot be received in the future.', [
          {
            field: 'body.receivedOn',
            code: 'received_in_future',
            message: 'Choose today or earlier.',
          },
        ]);
      }
      const receipt = await tx.financePayments.recordReceipt(
        {
          customerId: customer.id,
          receivedOn: body.receivedOn,
          amount: body.amount,
          currencyCode: body.currencyCode ?? (await tx.settings.get()).currency,
          method: body.method,
          paymentReference: body.paymentReference ?? null,
          notes: body.notes ?? null,
        },
        principal.userId,
      );
      await audit(tx, context, 'payment.recorded', 'payment', receipt.id, {
        reference: formatReceiptReference(receipt.reference),
        amount: receipt.amount,
        currencyCode: receipt.currencyCode,
        method: receipt.method,
      });
      for (const [index, allocation] of body.allocations.entries()) {
        if ((await tx.financeInvoices.findInvoice(allocation.invoiceId)) === undefined) {
          throw notFound('This invoice does not exist.');
        }
        const result = await tx.financePayments.allocate(
          receipt.id,
          allocation.invoiceId,
          allocation.amount,
          principal.userId,
        );
        if (typeof result === 'string') {
          allocationRefusal(result, `body.allocations.${index}.amount`);
        }
        await audit(tx, context, 'payment.allocated', 'payment', receipt.id, {
          invoiceId: allocation.invoiceId,
          amount: allocation.amount,
        });
      }
      return receiptDetail(tx, principal, receipt);
    });
    return { status: 201, body: detail };
  },
});

export const getPaymentRoute = defineRoute({
  method: 'get',
  path: '/v1/finance/payments/:receiptId',
  operationId: 'getCustomerPayment',
  summary: 'A payment, where it went, and the invoices it could still pay',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.read',
  feature: FINANCE,
  params: receiptParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The payment.', schema: receiptDetailSchema },
    404: { description: 'No such payment.' },
  },
  handler: async ({ params }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const receipt = await tx.financePayments.findReceipt(params.receiptId);
      if (receipt === undefined) {
        throw notFound('This payment does not exist.');
      }
      return receiptDetail(tx, context.principal, receipt);
    });
    return { status: 200, body };
  },
});

export const allocatePaymentRoute = defineRoute({
  method: 'post',
  path: '/v1/finance/payments/:receiptId/allocations',
  operationId: 'allocateCustomerPayment',
  summary: 'Put part of a payment against an invoice',
  description:
    'Owners and admins. Never more than the payment has left (422 `over_receipt`) or the invoice owes (422 `over_invoice`); only the same customer’s issued invoices in the payment’s currency.',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.issue',
  feature: FINANCE,
  params: receiptParams,
  query: noSchema,
  body: allocationInputSchema,
  responses: {
    200: { description: 'The payment.', schema: receiptDetailSchema },
    404: { description: 'No such payment or invoice.' },
    409: { description: 'The invoice is not issued.' },
    422: { description: 'More than either has, or another customer or currency.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const receipt = await tx.financePayments.findReceipt(params.receiptId);
      if (receipt === undefined) {
        throw notFound('This payment does not exist.');
      }
      if ((await tx.financeInvoices.findInvoice(body.invoiceId)) === undefined) {
        throw notFound('This invoice does not exist.');
      }
      const result = await tx.financePayments.allocate(
        receipt.id,
        body.invoiceId,
        body.amount,
        principal.userId,
      );
      if (typeof result === 'string') {
        allocationRefusal(result, 'body.amount');
      }
      await audit(tx, context, 'payment.allocated', 'payment', receipt.id, {
        invoiceId: body.invoiceId,
        amount: body.amount,
      });
      return receiptDetail(tx, principal, receipt);
    });
    return { status: 200, body: detail };
  },
});

export const removeAllocationRoute = defineRoute({
  method: 'post',
  path: '/v1/finance/payments/:receiptId/allocations/:allocationId/remove',
  operationId: 'removeCustomerPaymentAllocation',
  summary: 'Take an allocation back',
  description:
    'Owners and admins. The money returns to the customer’s account and the invoice owes it again; the allocation stays on record as removed. 409 `allocation_removed` when already removed.',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.issue',
  feature: FINANCE,
  params: receiptParams.extend({ allocationId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The payment.', schema: receiptDetailSchema },
    404: { description: 'No such payment or allocation.' },
    409: { description: 'Already removed.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const receipt = await tx.financePayments.findReceipt(params.receiptId);
      const allocation = await tx.financePayments.findAllocation(params.allocationId);
      if (receipt === undefined || allocation?.receiptId !== receipt.id) {
        throw notFound('This allocation does not exist.');
      }
      const result = await tx.financePayments.removeAllocation(allocation.id, principal.userId);
      if (result === 'not_found') {
        throw notFound('This allocation does not exist.');
      }
      if (result === 'already_removed') {
        throw conflict('allocation_removed', 'This allocation was already removed.');
      }
      await audit(tx, context, 'payment.allocation_removed', 'payment', receipt.id, {
        allocationId: allocation.id,
        invoiceId: allocation.invoiceId,
        amount: allocation.amount,
      });
      return receiptDetail(tx, principal, receipt);
    });
    return { status: 200, body: detail };
  },
});

export const reversePaymentRoute = defineRoute({
  method: 'post',
  path: '/v1/finance/payments/:receiptId/reverse',
  operationId: 'reverseCustomerPayment',
  summary: 'Take a payment back',
  description:
    'Owners and admins, with a reason: a bounced cheque, a transfer that never arrived, a payment recorded against the wrong customer. The payment is not deleted: a reversal is recorded beside it, dated today in the company’s calendar, its allocations are removed so the invoices owe again, it is never allocated again, and the ledger posts the opposite of its entry. Both stay in the history. Once only: 409 `payment_already_reversed`. Honours `Idempotency-Key`.',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.issue',
  feature: FINANCE,
  idempotent: true,
  params: receiptParams,
  query: noSchema,
  body: z.object({ reason: z.string().trim().min(1).max(2000) }),
  responses: {
    200: { description: 'The payment, reversed.', schema: receiptDetailSchema },
    404: { description: 'No such payment.' },
    409: { description: 'Already reversed (`payment_already_reversed`).' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const receipt = await tx.financePayments.findReceipt(params.receiptId);
      if (receipt === undefined) {
        throw notFound('This payment does not exist.');
      }
      const allocations = (await tx.financePayments.allocationsForReceipt(receipt.id)).filter(
        (allocation) => allocation.removedAt === null,
      );
      const result = await tx.financePayments.reverseReceipt(
        receipt.id,
        { reason: body.reason, reversedOn: await companyToday(tx) },
        principal.userId,
      );
      if (result === 'already_reversed') {
        throw conflict('payment_already_reversed', 'This payment was already reversed.');
      }
      await audit(tx, context, 'payment.reversed', 'payment', receipt.id, {
        reference: formatReceiptReference(receipt.reference),
        amount: receipt.amount,
        currencyCode: receipt.currencyCode,
        reason: result.reason,
        allocationsRemoved: allocations.map((allocation) => ({
          invoiceId: allocation.invoiceId,
          amount: allocation.amount,
        })),
      });
      return receiptDetail(tx, principal, receipt);
    });
    return { status: 200, body: detail };
  },
});

// ---------------------------------------------------------------------------
// Routes: the customer's account
// ---------------------------------------------------------------------------

export const customerAccountRoute = defineRoute({
  method: 'get',
  path: '/v1/finance/customers/:customerId/account',
  operationId: 'getCustomerAccount',
  summary: 'What a customer owes and has on account',
  description:
    'Per currency: what issued invoices still owe, what payments have left unallocated, and the difference; with the invoices that still owe and the payments with money left.',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.read',
  feature: FINANCE,
  params: z.object({ customerId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The account.',
      schema: z.object({
        accounts: z.array(accountSchema),
        openInvoices: z.array(invoiceSummarySchema),
        unallocatedPayments: z.array(receiptSummarySchema),
      }),
    },
    404: { description: 'No such customer.' },
  },
  handler: async ({ params }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      if ((await tx.customers.find(params.customerId)) === undefined) {
        throw notFound('This customer does not exist.');
      }
      const [accounts, today, receipts] = await Promise.all([
        tx.financePayments.customerAccount(params.customerId),
        companyToday(tx),
        tx.financePayments.listReceipts({
          customerId: params.customerId,
          unallocatedOnly: true,
          limit: 100,
        }),
      ]);
      return {
        accounts,
        openInvoices: await openInvoicesFor(tx, params.customerId, undefined, today),
        unallocatedPayments: await receiptSummaries(tx, receipts.items),
      };
    });
    return { status: 200, body };
  },
});

// ---------------------------------------------------------------------------
// Routes: what a job cost, against what it earned
// ---------------------------------------------------------------------------

export const jobCostsSchema = z.object({
  workOrder: z.object({ id: z.uuid(), reference: z.string() }),
  currencyCode: z.string(),
  /** Whether this seat sees costs; when not, every cost and the profit are null. */
  seesCosts: z.boolean(),
  parts: z.object({ cost: z.string().nullable() }),
  labour: z.object({
    /** Time on site and working, from the job's state changes. */
    hours: z.string(),
    hourlyCost: z.string().nullable(),
    cost: z.string().nullable(),
    /** False when the company has no labour cost set: the job cost is parts only. */
    costed: z.boolean(),
  }),
  cost: z.string().nullable(),
  /** The net (before tax) of issued invoices made from the job, less issued credit notes. */
  invoiced: z.object({ net: z.string(), invoices: z.number().int() }),
  profit: z.string().nullable(),
});

export const jobCostsRoute = defineRoute({
  method: 'get',
  path: '/v1/finance/work-orders/:workOrderId/costs',
  operationId: 'getJobCosts',
  summary: 'What a job cost, against what it earned',
  description:
    'Parts at their cost when used (net of returns) and parts bought from a merchant at what was paid, labour at the company’s hourly cost when set, and the net of the job’s issued invoices less credit notes. Costs and profit are shown to owners, admins and those who move stock; without a labour cost the figure is parts only and says so (`labour.costed: false`). An estimate for the office, not an accounting entry.',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.read',
  feature: FINANCE,
  params: z.object({ workOrderId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The job’s costs.', schema: jobCostsSchema },
    404: { description: 'No such job.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, principal, params.workOrderId);
      const [events, settings, company, usedCost, boughtCost, invoices] = await Promise.all([
        tx.workOrders.listEvents(job.id),
        tx.financeInvoices.settings(),
        tx.settings.get(),
        tx.inventoryMaterials.costForJob(job.id),
        // Parts bought from a merchant for the job count too (ADR-0012).
        tx.workOrderPurchases.totalForJob(job.id),
        tx.financeInvoices.invoicesForWorkOrder(job.id),
      ]);
      const partsCost = addDecimals(usedCost, boughtCost);
      const sees =
        holds(principal, 'finance.issue') ||
        holds(principal, 'inventory.move') ||
        holds(principal, 'purchasing.manage');
      const times = jobTimes(
        events.flatMap((event) =>
          event.toState === null || event.fromState === null
            ? []
            : [
                {
                  fromState: event.fromState,
                  toState: event.toState,
                  occurredAt: event.occurredAt,
                },
              ],
        ),
      );
      const hours = hoursOfMs(times.onSiteMs + times.workMs);
      const labourCost =
        settings.labourHourlyCost === null
          ? null
          : multiplyDecimals(hours, settings.labourHourlyCost);
      const cost = labourCost === null ? partsCost : addDecimals(partsCost, labourCost);
      let net = '0';
      let counted = 0;
      for (const invoice of invoices.filter((row) => row.status === 'issued')) {
        counted += 1;
        net = addDecimals(net, (await tx.financeInvoices.invoiceTotals(invoice.id)).net);
        for (const note of await tx.financeInvoices.creditNotesForInvoice(invoice.id)) {
          if (note.status === 'issued') {
            net = addDecimals(net, `-${(await tx.financeInvoices.creditNoteTotals(note.id)).net}`);
          }
        }
      }
      return {
        workOrder: { id: job.id, reference: formatWorkOrderReference(job.reference) },
        currencyCode: company.currency,
        seesCosts: sees,
        parts: { cost: sees ? partsCost : null },
        labour: {
          hours,
          hourlyCost: sees ? settings.labourHourlyCost : null,
          cost: sees ? labourCost : null,
          costed: settings.labourHourlyCost !== null,
        },
        cost: sees ? cost : null,
        invoiced: { net, invoices: counted },
        profit: sees ? addDecimals(net, `-${cost}`) : null,
      };
    });
    return { status: 200, body };
  },
});

export const paymentRoutes = [
  listPaymentsRoute,
  recordPaymentRoute,
  getPaymentRoute,
  allocatePaymentRoute,
  removeAllocationRoute,
  reversePaymentRoute,
  customerAccountRoute,
  jobCostsRoute,
];
