import {
  addDays,
  balanceSettled,
  compareDecimals,
  creditNoteStatusSchema,
  CREDIT_NOTE_STATUSES,
  currencyCodeSchema,
  dueDaysSchema,
  formatCreditNoteReference,
  formatInvoiceReference,
  formatReceiptReference,
  formatSalesOrderReference,
  formatWorkOrderReference,
  holds,
  hoursOfMs,
  INVOICE_STATUSES,
  invoiceOrderBasisSchema,
  invoiceStatus,
  invoiceStatusSchema,
  isZeroDecimal,
  jobTimes,
  paymentMethodSchema,
  type Principal,
  type InvoiceStatus,
  quantitySchema,
} from '@integr8/core';
import {
  addDecimals,
  type CreditNote,
  type CreditNoteLineInput,
  type FinanceSettings,
  getPlatformDataSource,
  type Invoice,
  type InvoiceAmounts,
  type InvoiceLine,
  type InvoiceLineInput,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { ApiError, conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import {
  crmAudit as audit,
  decodeDateCursor,
  encodeDateCursor,
  versionConflict,
} from './crm-shared.js';
import {
  addressSchema,
  many,
  type People,
  peopleOf,
  personBody,
  personSchema,
} from './operations.js';
import {
  companyToday,
  documentLineInputs,
  documentLineSchema,
  lineBodies,
  lineInputSchema,
  requireCustomerParties,
  totalsSchema,
} from './sales-quotes.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * A company's invoices and credit notes (CRM/ERP plan, phase B1; ADR-0004,
 * ADR-0007). Not Integr8's billing (`/v1/billing/*`), and not a certified tax
 * document: the issuer block is what the company typed in its settings.
 *
 * A dispatcher drafts — blank, from a sales order, or from a completed job —
 * and an owner or admin issues, which numbers the invoice and copies the
 * customer and the issuer onto it. Nothing billed from an order or a job is
 * billed twice. An issued invoice never changes: a credit note reduces it,
 * and one nothing was paid or credited against may be voided.
 */

/**
 * Above zero. `compareDecimals` reads digits only, so a remainder that went
 * negative (billed on `ordered`, then on `delivered` with less delivered) must
 * be ruled out by its sign first.
 */
function isPositiveDecimal(value: string): boolean {
  return !value.trim().startsWith('-') && !isZeroDecimal(value);
}

export const FINANCE_TAGS = ['finance'];
export const FINANCE = 'finance' as const;

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export const amountsSchema = z.object({
  total: z.string(),
  /** Payments allocated to it. */
  allocated: z.string(),
  /** Issued credit notes against it. */
  credited: z.string(),
  /** What it still owes. */
  balance: z.string(),
});

const sourceSchema = z
  .object({
    kind: z.enum(['sales_order', 'work_order']),
    id: z.uuid(),
    /** `SO-000123` or `WO-000123`. */
    reference: z.string(),
  })
  .nullable();

export const invoiceSummarySchema = z.object({
  id: z.uuid(),
  /** `INV-000123`; null while a draft. */
  reference: z.string().nullable(),
  customer: z.object({ id: z.uuid(), name: z.string() }),
  /** Derived from the facts: credit notes and payments allocated. */
  status: invoiceStatusSchema,
  /** Issued, still owing, and past its due date. */
  overdue: z.boolean(),
  currencyCode: z.string(),
  issueDate: z.iso.date().nullable(),
  dueDate: z.iso.date().nullable(),
  amounts: amountsSchema,
  source: sourceSchema,
  /**
   * Made from a job that has parts no invoice bills yet: recorded on a phone
   * before the job closed and synced after it was invoiced (0062). Drafting
   * from the job again bills just those.
   */
  partsNotYetBilled: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const issuerSchema = z.object({
  name: z.string(),
  address: z.string().nullable(),
  taxReference: z.string().nullable(),
  paymentInstructions: z.string().nullable(),
  footer: z.string().nullable(),
});

export const invoiceSchema = invoiceSummarySchema.extend({
  site: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  contact: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  /** Printed for the customer. */
  notes: z.string().nullable(),
  /** Never printed; null to seats without `finance.manage`. */
  internalNotes: z.string().nullable(),
  /** The customer as the issued invoice names them; null while a draft. */
  billedTo: z
    .object({
      customerName: z.string(),
      customerAddress: addressSchema,
      contactName: z.string().nullable(),
      contactEmail: z.string().nullable(),
    })
    .nullable(),
  /** The company as the issued invoice names it; null while a draft. */
  issuer: issuerSchema.nullable(),
  totals: totalsSchema,
  issuedBy: personSchema.nullable(),
  issuedAt: z.iso.datetime().nullable(),
  voidedBy: personSchema.nullable(),
  voidedAt: z.iso.datetime().nullable(),
  voidReason: z.string().nullable(),
  version: z.number().int(),
  createdBy: personSchema,
});

export const invoiceLineSchema = documentLineSchema.extend({
  /** The sales order line it bills, if it came from an order. */
  salesOrderLineId: z.uuid().nullable(),
  /** The part used on the job it bills, if it came from a job. */
  workOrderMaterialId: z.uuid().nullable(),
});

export const creditNoteSummarySchema = z.object({
  id: z.uuid(),
  /** `CN-000123`; null while a draft. */
  reference: z.string().nullable(),
  invoice: z.object({ id: z.uuid(), reference: z.string().nullable() }),
  customer: z.object({ id: z.uuid(), name: z.string() }),
  status: creditNoteStatusSchema,
  reason: z.string(),
  currencyCode: z.string(),
  issueDate: z.iso.date().nullable(),
  total: z.string(),
  version: z.number().int(),
  createdAt: z.iso.datetime(),
});

export const invoicePaymentSchema = z.object({
  allocationId: z.uuid(),
  receipt: z.object({ id: z.uuid(), reference: z.string() }),
  receivedOn: z.iso.date(),
  method: paymentMethodSchema,
  amount: z.string(),
  allocatedAt: z.iso.datetime(),
});

export const invoiceDetailSchema = z.object({
  invoice: invoiceSchema,
  lines: z.array(invoiceLineSchema),
  creditNotes: z.array(creditNoteSummarySchema),
  /** Payments allocated to it, oldest first. */
  payments: z.array(invoicePaymentSchema),
  can: z.object({
    edit: z.boolean(),
    discard: z.boolean(),
    issue: z.boolean(),
    void: z.boolean(),
    credit: z.boolean(),
    recordPayment: z.boolean(),
  }),
});

export const creditNoteDetailSchema = z.object({
  creditNote: creditNoteSummarySchema.extend({
    issuedBy: personSchema.nullable(),
    issuedAt: z.iso.datetime().nullable(),
    version: z.number().int(),
    createdBy: personSchema,
  }),
  lines: z.array(documentLineSchema.extend({ invoiceLineId: z.uuid().nullable() })),
  totals: totalsSchema,
  /** The invoice it reduces, with what it owes now. */
  invoice: invoiceSummarySchema,
  can: z.object({ edit: z.boolean(), discard: z.boolean(), issue: z.boolean() }),
});

export const financeSettingsSchema = z.object({
  legalName: z.string().nullable(),
  address: z.string().nullable(),
  taxReference: z.string().nullable(),
  paymentInstructions: z.string().nullable(),
  footer: z.string().nullable(),
  defaultDueDays: z.number().int(),
  /** Null to seats that may not see costs. */
  labourHourlyCost: z.string().nullable(),
  labourHourlyRate: z.string().nullable(),
  version: z.number().int(),
  /** The company's own name, used when no legal name is set. */
  companyName: z.string(),
  can: z.object({ edit: z.boolean() }),
});

// ---------------------------------------------------------------------------
// Shaping
// ---------------------------------------------------------------------------

const ZERO: InvoiceAmounts = { total: '0', allocated: '0', credited: '0', balance: '0' };

function derivedStatus(invoice: Invoice, amounts: InvoiceAmounts): InvoiceStatus {
  return invoiceStatus(invoice.status, amounts, invoice.currencyCode);
}

function isOverdue(invoice: Invoice, amounts: InvoiceAmounts, today: string): boolean {
  return (
    invoice.status === 'issued' &&
    invoice.dueDate !== null &&
    invoice.dueDate < today &&
    !balanceSettled(amounts.balance, invoice.currencyCode)
  );
}

export async function invoiceSummaries(
  tx: TenantTransaction,
  invoices: readonly Invoice[],
  today: string,
): Promise<z.infer<typeof invoiceSummarySchema>[]> {
  const [customers, amounts, orders, jobs] = await Promise.all([
    tx.customers.findMany([...new Set(invoices.map((invoice) => invoice.customerId))]),
    tx.financeInvoices.invoiceAmounts(invoices.map((invoice) => invoice.id)),
    tx.salesOrders.findOrders(
      invoices.flatMap((invoice) => (invoice.salesOrderId === null ? [] : [invoice.salesOrderId])),
    ),
    tx.workOrders.findMany(
      invoices.flatMap((invoice) => (invoice.workOrderId === null ? [] : [invoice.workOrderId])),
    ),
  ]);
  const customer = new Map(customers.map((row) => [row.id, row]));
  const order = new Map(orders.map((row) => [row.id, row]));
  const job = new Map(jobs.map((row) => [row.id, row]));
  const unbilled = await tx.financeInvoices.jobsWithUnbilledParts(
    invoices.flatMap((invoice) =>
      invoice.workOrderId === null || invoice.status === 'void' ? [] : [invoice.workOrderId],
    ),
  );
  return invoices.map((invoice) => {
    const figures = amounts.get(invoice.id) ?? ZERO;
    const fromOrder = invoice.salesOrderId === null ? undefined : order.get(invoice.salesOrderId);
    const fromJob = invoice.workOrderId === null ? undefined : job.get(invoice.workOrderId);
    return {
      id: invoice.id,
      reference: invoice.reference === null ? null : formatInvoiceReference(invoice.reference),
      customer: {
        id: invoice.customerId,
        name: invoice.customerName ?? customer.get(invoice.customerId)?.name ?? '',
      },
      status: derivedStatus(invoice, figures),
      overdue: isOverdue(invoice, figures, today),
      currencyCode: invoice.currencyCode,
      issueDate: invoice.issueDate,
      dueDate: invoice.dueDate,
      amounts: figures,
      source:
        fromOrder !== undefined
          ? {
              kind: 'sales_order' as const,
              id: fromOrder.id,
              reference: formatSalesOrderReference(fromOrder.reference),
            }
          : fromJob !== undefined
            ? {
                kind: 'work_order' as const,
                id: fromJob.id,
                reference: formatWorkOrderReference(fromJob.reference),
              }
            : null,
      partsNotYetBilled:
        invoice.status !== 'void' &&
        invoice.workOrderId !== null &&
        unbilled.has(invoice.workOrderId),
      createdAt: iso(invoice.createdAt),
      updatedAt: iso(invoice.updatedAt),
    };
  });
}

export async function creditNoteSummaries(
  tx: TenantTransaction,
  notes: readonly CreditNote[],
): Promise<z.infer<typeof creditNoteSummarySchema>[]> {
  const invoices = new Map(
    (await tx.financeInvoices.findInvoices(notes.map((note) => note.invoiceId))).map((invoice) => [
      invoice.id,
      invoice,
    ]),
  );
  const customers = new Map(
    (
      await tx.customers.findMany([
        ...new Set([...invoices.values()].map((invoice) => invoice.customerId)),
      ])
    ).map((customer) => [customer.id, customer]),
  );
  const totals = await Promise.all(
    notes.map((note) => tx.financeInvoices.creditNoteTotals(note.id)),
  );
  return notes.map((note, index) => {
    const invoice = invoices.get(note.invoiceId)!;
    return {
      id: note.id,
      reference: note.reference === null ? null : formatCreditNoteReference(note.reference),
      invoice: {
        id: invoice.id,
        reference: invoice.reference === null ? null : formatInvoiceReference(invoice.reference),
      },
      customer: {
        id: invoice.customerId,
        name: invoice.customerName ?? customers.get(invoice.customerId)?.name ?? '',
      },
      status: note.status,
      reason: note.reason,
      currencyCode: invoice.currencyCode,
      issueDate: note.issueDate,
      total: totals[index]!.total,
      version: note.version,
      createdAt: iso(note.createdAt),
    };
  });
}

function invoiceLineBodies(lines: readonly InvoiceLine[]): z.infer<typeof invoiceLineSchema>[] {
  const shaped = lineBodies(lines);
  return shaped.map((line, index) => ({
    ...line,
    salesOrderLineId: lines[index]!.salesOrderLineId,
    workOrderMaterialId: lines[index]!.workOrderMaterialId,
  }));
}

export async function invoiceDetail(
  tx: TenantTransaction,
  principal: Principal,
  invoice: Invoice,
  people?: People,
): Promise<z.infer<typeof invoiceDetailSchema>> {
  const today = await companyToday(tx);
  const names = people ?? (await peopleOf(tx));
  const [summary, lines, totals, site, contacts, notes, allocations] = await Promise.all([
    invoiceSummaries(tx, [invoice], today),
    tx.financeInvoices.invoiceLines(invoice.id),
    tx.financeInvoices.invoiceTotals(invoice.id),
    invoice.siteId === null ? undefined : tx.sites.find(invoice.siteId),
    invoice.contactId === null ? [] : tx.customers.findContacts([invoice.contactId]),
    tx.financeInvoices.creditNotesForInvoice(invoice.id),
    tx.financePayments.allocationsForInvoice(invoice.id),
  ]);
  const receipts = new Map(
    (await tx.financePayments.findReceipts(allocations.map((row) => row.receiptId))).map(
      (receipt) => [receipt.id, receipt],
    ),
  );
  const manage = holds(principal, 'finance.manage');
  const issueRight = holds(principal, 'finance.issue');
  const amounts = summary[0]!.amounts;
  const owing = !balanceSettled(amounts.balance, invoice.currencyCode);
  const untouched = amounts.allocated === '0' && amounts.credited === '0';
  return {
    invoice: {
      ...summary[0]!,
      site: site === undefined ? null : { id: site.id, name: site.name },
      contact: contacts[0] === undefined ? null : { id: contacts[0].id, name: contacts[0].name },
      notes: invoice.notes,
      internalNotes: manage ? invoice.internalNotes : null,
      billedTo:
        invoice.customerName === null || invoice.customerAddress === null
          ? null
          : {
              customerName: invoice.customerName,
              customerAddress: invoice.customerAddress,
              contactName: invoice.contactName,
              contactEmail: invoice.contactEmail,
            },
      issuer: invoice.issuer,
      totals,
      issuedBy: invoice.issuedBy === null ? null : personBody(invoice.issuedBy, names),
      issuedAt: isoOrNull(invoice.issuedAt),
      voidedBy: invoice.voidedBy === null ? null : personBody(invoice.voidedBy, names),
      voidedAt: isoOrNull(invoice.voidedAt),
      voidReason: invoice.voidReason,
      version: invoice.version,
      createdBy: personBody(invoice.createdBy, names),
    },
    lines: invoiceLineBodies(lines),
    creditNotes: await creditNoteSummaries(tx, notes),
    payments: allocations.map((allocation) => {
      const receipt = receipts.get(allocation.receiptId)!;
      return {
        allocationId: allocation.id,
        receipt: { id: receipt.id, reference: formatReceiptReference(receipt.reference) },
        receivedOn: receipt.receivedOn,
        method: receipt.method,
        amount: allocation.amount,
        allocatedAt: iso(allocation.allocatedAt),
      };
    }),
    can: {
      edit: manage && invoice.status === 'draft',
      discard: manage && invoice.status === 'draft',
      issue: issueRight && invoice.status === 'draft' && lines.length > 0,
      void: issueRight && invoice.status === 'issued' && untouched,
      credit: manage && invoice.status === 'issued' && owing,
      recordPayment: issueRight && invoice.status === 'issued' && owing,
    },
  };
}

async function creditNoteDetail(
  tx: TenantTransaction,
  principal: Principal,
  note: CreditNote,
): Promise<z.infer<typeof creditNoteDetailSchema>> {
  const names = await peopleOf(tx);
  const [summary, lines, totals, invoice] = await Promise.all([
    creditNoteSummaries(tx, [note]),
    tx.financeInvoices.creditNoteLines(note.id),
    tx.financeInvoices.creditNoteTotals(note.id),
    tx.financeInvoices.findInvoice(note.invoiceId),
  ]);
  const shaped = lineBodies(lines).map((line, index) => ({
    ...line,
    invoiceLineId: lines[index]!.invoiceLineId,
  }));
  const draft = note.status === 'draft';
  return {
    creditNote: {
      ...summary[0]!,
      issuedBy: note.issuedBy === null ? null : personBody(note.issuedBy, names),
      issuedAt: isoOrNull(note.issuedAt),
      version: note.version,
      createdBy: personBody(note.createdBy, names),
    },
    lines: shaped,
    totals,
    invoice: (await invoiceSummaries(tx, [invoice!], await companyToday(tx)))[0]!,
    can: {
      edit: draft && holds(principal, 'finance.manage'),
      discard: draft && holds(principal, 'finance.manage'),
      issue: draft && lines.length > 0 && holds(principal, 'finance.issue'),
    },
  };
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const invoiceLineInputSchema = lineInputSchema.extend({
  /** Kept when editing a line that came from an order. */
  salesOrderLineId: z.uuid().nullable().optional(),
  /** Kept when editing a line that came from a job. */
  workOrderMaterialId: z.uuid().nullable().optional(),
});

const creditNoteLineInputSchema = lineInputSchema.extend({
  /** The invoice line it credits, if any. */
  invoiceLineId: z.uuid().nullable().optional(),
});

async function invoiceLineInputs(
  tx: TenantTransaction,
  lines: readonly z.infer<typeof invoiceLineInputSchema>[],
): Promise<InvoiceLineInput[]> {
  const base = await documentLineInputs(tx, lines);
  return base.map((line, index) => ({
    ...line,
    salesOrderLineId: lines[index]!.salesOrderLineId ?? null,
    workOrderMaterialId: lines[index]!.workOrderMaterialId ?? null,
  }));
}

function overInvoiced(message: string, index: number): never {
  throw unprocessable('over_invoiced', message, [
    { field: `body.lines.${index}.quantity`, code: 'over_invoiced', message },
  ]);
}

/**
 * Lines that came from an order or a job must belong to the invoice's
 * source and never bill more than it holds, counting every other invoice
 * that is not void. The source is locked first, so two invoices take turns.
 */
async function checkSourcedLines(
  tx: TenantTransaction,
  invoice: { id?: string; salesOrderId: string | null; workOrderId: string | null },
  lines: readonly InvoiceLineInput[],
): Promise<void> {
  const orderLineIds = lines.flatMap((line) =>
    line.salesOrderLineId == null ? [] : [line.salesOrderLineId],
  );
  const materialIds = lines.flatMap((line) =>
    line.workOrderMaterialId == null ? [] : [line.workOrderMaterialId],
  );
  if (orderLineIds.length > 0) {
    if (invoice.salesOrderId === null) {
      throw unprocessable('line_not_from_source', 'This invoice was not made from a sales order.');
    }
    await tx.financeInvoices.lockSource('sales_order', invoice.salesOrderId);
    const orderLines = new Map(
      (await tx.salesOrders.orderLines(invoice.salesOrderId)).map((line) => [line.id, line]),
    );
    const elsewhere = await tx.financeInvoices.invoicedOrderQuantities(orderLineIds, invoice.id);
    const here = new Map<string, string>();
    lines.forEach((line, index) => {
      if (line.salesOrderLineId == null) {
        return;
      }
      const orderLine = orderLines.get(line.salesOrderLineId);
      if (orderLine === undefined) {
        throw unprocessable('line_not_from_source', 'A line names a line of another order.', [
          {
            field: `body.lines.${index}.salesOrderLineId`,
            code: 'line_not_from_source',
            message: 'Not a line of this invoice’s order.',
          },
        ]);
      }
      const sum = addDecimals(here.get(orderLine.id) ?? '0', line.quantity);
      here.set(orderLine.id, sum);
      const billed = addDecimals(sum, elsewhere.get(orderLine.id) ?? '0');
      if (compareDecimals(billed, orderLine.quantity) > 0) {
        overInvoiced(`More of “${orderLine.description}” than the order holds is invoiced.`, index);
      }
    });
  }
  if (materialIds.length > 0) {
    if (invoice.workOrderId === null) {
      throw unprocessable('line_not_from_source', 'This invoice was not made from a job.');
    }
    await tx.financeInvoices.lockSource('work_order', invoice.workOrderId);
    const materials = new Map(
      (await tx.inventoryMaterials.listForJob(invoice.workOrderId)).map((material) => [
        material.id,
        material,
      ]),
    );
    const billed = await tx.financeInvoices.invoicedMaterials(materialIds, invoice.id);
    const seen = new Set<string>();
    lines.forEach((line, index) => {
      if (line.workOrderMaterialId == null) {
        return;
      }
      const material = materials.get(line.workOrderMaterialId);
      if (material?.status !== 'posted') {
        throw unprocessable('line_not_from_source', 'A line names a part not used on this job.', [
          {
            field: `body.lines.${index}.workOrderMaterialId`,
            code: 'line_not_from_source',
            message: 'Not a part used on this invoice’s job.',
          },
        ]);
      }
      if (billed.has(material.id) || seen.has(material.id)) {
        overInvoiced('This part is already on an invoice.', index);
      }
      seen.add(material.id);
      const used = addDecimals(material.quantity, `-${material.returnedQuantity}`);
      if (compareDecimals(line.quantity, used) > 0) {
        overInvoiced('More of this part than was used on the job is invoiced.', index);
      }
    });
  }
}

function invoiceRefusal(result: 'not_found' | 'version_conflict' | 'not_draft'): never {
  if (result === 'not_found') {
    throw notFound('This invoice does not exist.');
  }
  if (result === 'version_conflict') {
    throw versionConflict();
  }
  throw conflict('invoice_not_draft', 'Only a draft changes. Credit or void an issued invoice.');
}

function creditNoteRefusal(result: 'not_found' | 'version_conflict' | 'not_draft'): never {
  if (result === 'not_found') {
    throw notFound('This credit note does not exist.');
  }
  if (result === 'version_conflict') {
    throw versionConflict();
  }
  throw conflict('credit_note_not_draft', 'Only a draft credit note changes.');
}

async function requireInvoice(tx: TenantTransaction, invoiceId: string): Promise<Invoice> {
  const invoice = await tx.financeInvoices.lockInvoice(invoiceId);
  if (invoice === undefined) {
    throw notFound('This invoice does not exist.');
  }
  return invoice;
}

async function requireCreditNote(tx: TenantTransaction, creditNoteId: string): Promise<CreditNote> {
  const note = await tx.financeInvoices.lockCreditNote(creditNoteId);
  if (note === undefined) {
    throw notFound('This credit note does not exist.');
  }
  return note;
}

/** The company's own name, for the issuer block when no legal name is set. */
export async function companyName(tenantId: string): Promise<string> {
  return (await getPlatformDataSource().tenants.findById(tenantId))?.name ?? '';
}

function settingsBody(
  settings: FinanceSettings,
  principal: Principal,
  name: string,
): z.infer<typeof financeSettingsSchema> {
  const issue = holds(principal, 'finance.issue');
  return {
    legalName: settings.legalName,
    address: settings.address,
    taxReference: settings.taxReference,
    paymentInstructions: settings.paymentInstructions,
    footer: settings.footer,
    defaultDueDays: settings.defaultDueDays,
    labourHourlyCost: issue ? settings.labourHourlyCost : null,
    labourHourlyRate: settings.labourHourlyRate,
    version: settings.version,
    companyName: name,
    can: { edit: issue },
  };
}

const LABOUR = { en: 'Labour on site', ar: 'العمل في الموقع' } as const;

// ---------------------------------------------------------------------------
// Routes: settings
// ---------------------------------------------------------------------------

export const getFinanceSettingsRoute = defineRoute({
  method: 'get',
  path: '/v1/finance/settings',
  operationId: 'getFinanceSettings',
  summary: 'Who issues the invoices, and what an hour costs',
  description:
    'The issuer block printed on invoices, the default days to pay, and the labour cost and rate. The cost is shown only to owners and admins.',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.read',
  feature: FINANCE,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'The settings.', schema: financeSettingsSchema } },
  handler: async (_request, context) => {
    const { principal } = context;
    const settings = await withTenant(principal.tenantId, (tx) => tx.financeInvoices.settings());
    return {
      status: 200,
      body: settingsBody(settings, principal, await companyName(principal.tenantId)),
    };
  },
});

const optionalText = (max: number) => z.string().max(max).nullable().optional();

export const saveFinanceSettingsRoute = defineRoute({
  method: 'put',
  path: '/v1/finance/settings',
  operationId: 'saveFinanceSettings',
  summary: 'Set who issues the invoices, and what an hour costs',
  description:
    'Owners and admins. `expectedVersion` 0 the first time. These details are printed as typed: the product makes no tax or e-invoicing claim.',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.issue',
  feature: FINANCE,
  params: noSchema,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(0),
    legalName: optionalText(200),
    address: optionalText(1000),
    taxReference: optionalText(100),
    paymentInstructions: optionalText(2000),
    footer: optionalText(2000),
    defaultDueDays: dueDaysSchema.optional(),
    labourHourlyCost: quantitySchema.nullable().optional(),
    labourHourlyRate: quantitySchema.nullable().optional(),
  }),
  responses: {
    200: { description: 'The settings.', schema: financeSettingsSchema },
    409: { description: 'Changed elsewhere (`version_conflict`).' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const { expectedVersion, ...input } = body;
    const saved = await withTenant(principal.tenantId, async (tx) => {
      const result = await tx.financeInvoices.saveSettings(
        input,
        expectedVersion,
        principal.userId,
      );
      if (result === 'version_conflict') {
        throw versionConflict();
      }
      await audit(tx, context, 'finance_settings.updated', 'finance_settings', principal.tenantId, {
        fields: Object.keys(input),
      });
      return result;
    });
    return {
      status: 200,
      body: settingsBody(saved, principal, await companyName(principal.tenantId)),
    };
  },
});

// ---------------------------------------------------------------------------
// Routes: invoices
// ---------------------------------------------------------------------------

const invoiceParams = z.object({ invoiceId: z.uuid() });

export const listInvoicesRoute = defineRoute({
  method: 'get',
  path: '/v1/finance/invoices',
  operationId: 'listCustomerInvoices',
  summary: 'Find invoices',
  description:
    'Newest first, a page at a time. `q` matches a reference (`INV-000123`, `123`) or words of the customer’s name; `status` is the derived status; `overdue=true` keeps those past due and still owing; `partsNotBilled=true` keeps those made from a job with parts no invoice bills yet, for a follow-up invoice.',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.read',
  feature: FINANCE,
  params: noSchema,
  query: z.object({
    q: z.string().trim().max(200).optional(),
    status: many(invoiceStatusSchema, INVOICE_STATUSES.length),
    customerId: z.uuid().optional(),
    salesOrderId: z.uuid().optional(),
    workOrderId: z.uuid().optional(),
    overdue: z.enum(['true', 'false']).optional(),
    /** Made from a job with parts recorded after it was invoiced (0062). */
    partsNotBilled: z.enum(['true', 'false']).optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of invoices.',
      schema: z.object({ items: z.array(invoiceSummarySchema), nextCursor: z.string().nullable() }),
    },
  },
  handler: async ({ query }, context) => {
    const after = decodeDateCursor(query.cursor);
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const today = await companyToday(tx);
      const page = await tx.financeInvoices.listInvoices({
        ...(query.q === undefined ? {} : { text: query.q }),
        statuses: query.status,
        ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
        ...(query.salesOrderId === undefined ? {} : { salesOrderId: query.salesOrderId }),
        ...(query.workOrderId === undefined ? {} : { workOrderId: query.workOrderId }),
        ...(query.overdue === 'true' ? { overdue: { today } } : {}),
        ...(query.partsNotBilled === 'true' ? { partsNotBilled: true } : {}),
        ...(after === undefined ? {} : { after }),
        limit: query.limit,
      });
      return {
        items: await invoiceSummaries(tx, page.items, today),
        nextCursor: encodeDateCursor(page.next),
      };
    });
    return { status: 200, body };
  },
});

const invoiceFields = {
  customerId: z.uuid(),
  siteId: z.uuid().nullable().optional(),
  contactId: z.uuid().nullable().optional(),
  dueDate: z.iso.date().nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
  internalNotes: z.string().max(10_000).nullable().optional(),
};

export const createInvoiceRoute = defineRoute({
  method: 'post',
  path: '/v1/finance/invoices',
  operationId: 'createCustomerInvoice',
  summary: 'Draft an invoice',
  description:
    'A blank draft in the company currency (or `currencyCode`), with lines from the catalogue or written by hand. Unnumbered until issued. Honours `Idempotency-Key`.',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.manage',
  feature: FINANCE,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    ...invoiceFields,
    currencyCode: currencyCodeSchema.optional(),
    lines: z.array(lineInputSchema).max(200).default([]),
  }),
  responses: {
    201: { description: 'The draft.', schema: invoiceDetailSchema },
    404: { description: 'No such customer or item.' },
    422: {
      description:
        'The site or contact is not the customer’s; a hand-written line has no description.',
    },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      await requireCustomerParties(tx, body);
      const lines = await documentLineInputs(tx, body.lines);
      const invoice = await tx.financeInvoices.createInvoice(
        {
          customerId: body.customerId,
          siteId: body.siteId ?? null,
          contactId: body.contactId ?? null,
          currencyCode: body.currencyCode ?? (await tx.settings.get()).currency,
          dueDate: body.dueDate ?? null,
          notes: body.notes ?? null,
          internalNotes: body.internalNotes ?? null,
        },
        lines,
        principal.userId,
      );
      await audit(tx, context, 'invoice.created', 'invoice', invoice.id, { lines: lines.length });
      return invoiceDetail(tx, principal, invoice);
    });
    return { status: 201, body: detail };
  },
});

export const invoiceFromOrderRoute = defineRoute({
  method: 'post',
  path: '/v1/finance/invoices/from-order',
  operationId: 'createCustomerInvoiceFromOrder',
  summary: 'Draft an invoice from a sales order',
  description:
    '`basis: ordered` bills what the order holds; `delivered` bills what its jobs delivered. Either way only what no other invoice (drafts included, voids not) already bills. The order must be confirmed or delivered (409 `order_not_billable`); nothing left to bill is 422 `nothing_to_invoice`. Honours `Idempotency-Key`.',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.manage',
  feature: FINANCE,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({ salesOrderId: z.uuid(), basis: invoiceOrderBasisSchema.default('delivered') }),
  responses: {
    201: { description: 'The draft.', schema: invoiceDetailSchema },
    404: { description: 'No such sales order.' },
    409: { description: 'The order is a draft or cancelled (`order_not_billable`).' },
    422: {
      description:
        'Everything is already invoiced, or nothing delivered yet (`nothing_to_invoice`).',
    },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const order = await tx.salesOrders.findOrder(body.salesOrderId);
      if (order === undefined) {
        throw notFound('This sales order does not exist.');
      }
      if (order.status === 'draft' || order.status === 'cancelled') {
        throw conflict('order_not_billable', 'Only a confirmed or delivered order is invoiced.');
      }
      await tx.financeInvoices.lockSource('sales_order', order.id);
      const orderLines = await tx.salesOrders.orderLines(order.id);
      const already = await tx.financeInvoices.invoicedOrderQuantities(
        orderLines.map((line) => line.id),
      );
      const lines: InvoiceLineInput[] = orderLines.flatMap((line) => {
        const due = body.basis === 'ordered' ? line.quantity : line.quantityFulfilled;
        const left = addDecimals(due, `-${already.get(line.id) ?? '0'}`);
        return isPositiveDecimal(left)
          ? [
              {
                itemId: line.itemId,
                description: line.description,
                quantity: left,
                unit: line.unit,
                unitPrice: line.unitPrice,
                discountBp: line.discountBp,
                taxRateBp: line.taxRateBp,
                salesOrderLineId: line.id,
              },
            ]
          : [];
      });
      if (lines.length === 0) {
        throw unprocessable(
          'nothing_to_invoice',
          body.basis === 'delivered'
            ? 'Nothing delivered on this order is left to invoice.'
            : 'Everything on this order is already invoiced.',
        );
      }
      const invoice = await tx.financeInvoices.createInvoice(
        {
          customerId: order.customerId,
          siteId: order.siteId,
          contactId: order.contactId,
          salesOrderId: order.id,
          currencyCode: order.currencyCode,
          notes: order.notes,
        },
        lines,
        principal.userId,
      );
      await audit(tx, context, 'invoice.created', 'invoice', invoice.id, {
        salesOrderId: order.id,
        basis: body.basis,
        lines: lines.length,
      });
      return invoiceDetail(tx, principal, invoice);
    });
    return { status: 201, body: detail };
  },
});

export const invoiceFromJobRoute = defineRoute({
  method: 'post',
  path: '/v1/finance/invoices/from-job',
  operationId: 'createCustomerInvoiceFromJob',
  summary: 'Draft an invoice from a completed job',
  description:
    'One line per part used on the job (net of returns, at the item’s sale price) and one labour line for the time on site, at the company’s labour rate when set. The job must be complete (409 `job_not_complete`) and not already invoiced (409 `job_already_invoiced`) — except that a job already invoiced with parts no invoice bills yet (recorded on a phone before the job closed and synced after, `partsNotYetBilled`) gets a follow-up draft with just those parts and no labour. Honours `Idempotency-Key`.',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.manage',
  feature: FINANCE,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({ workOrderId: z.uuid() }),
  responses: {
    201: { description: 'The draft.', schema: invoiceDetailSchema },
    404: { description: 'No such job.' },
    409: {
      description:
        'Not complete (`job_not_complete`) or already invoiced (`job_already_invoiced`).',
    },
    422: { description: 'Nothing on the job to bill (`nothing_to_invoice`).' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const job = await tx.workOrders.find(body.workOrderId);
      if (job === undefined) {
        throw notFound('This work order does not exist.');
      }
      if (job.state !== 'complete' && job.state !== 'reviewed') {
        throw conflict('job_not_complete', 'Only a completed job is invoiced.');
      }
      await tx.financeInvoices.lockSource('work_order', job.id);
      const earlier = await tx.financeInvoices.invoicesForWorkOrder(job.id);
      const [allMaterials, events, settings, company] = await Promise.all([
        tx.inventoryMaterials.listForJob(job.id),
        tx.workOrders.listEvents(job.id),
        tx.financeInvoices.settings(),
        tx.settings.get(),
      ]);
      // A job is invoiced once. What can follow is a part a phone recorded before
      // the job closed and synced after it was invoiced (0062): the follow-up
      // bills those parts alone, never the labour again.
      const followUp = earlier.length > 0;
      const billed = followUp
        ? await tx.financeInvoices.invoicedMaterials(allMaterials.map((material) => material.id))
        : new Set<string>();
      const materials = allMaterials.filter((material) => !billed.has(material.id));
      const unbilledParts = materials.some(
        (material) =>
          material.status === 'posted' &&
          isPositiveDecimal(addDecimals(material.quantity, `-${material.returnedQuantity}`)),
      );
      if (followUp && !unbilledParts) {
        throw new ApiError(409, 'job_already_invoiced', 'This job is already on an invoice.', [
          {
            field: 'body.workOrderId',
            code: 'job_already_invoiced',
            message: 'Open the existing invoice.',
            params: { invoiceId: earlier[0]!.id },
          },
        ]);
      }
      const items = new Map(
        (await tx.inventoryCatalogue.findItems(materials.map((material) => material.itemId))).map(
          (item) => [item.id, item],
        ),
      );
      const lines: InvoiceLineInput[] = materials.flatMap((material) => {
        const used = addDecimals(material.quantity, `-${material.returnedQuantity}`);
        const item = items.get(material.itemId);
        return material.status === 'posted' && isPositiveDecimal(used) && item !== undefined
          ? [
              {
                itemId: item.id,
                description: item.name,
                quantity: used,
                unit: item.unit,
                unitPrice: item.salePrice ?? '0',
                workOrderMaterialId: material.id,
              },
            ]
          : [];
      });
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
      const hours = followUp ? '0' : hoursOfMs(times.onSiteMs + times.workMs);
      if (compareDecimals(hours, '0') > 0) {
        lines.push({
          description: `${company.locale === 'ar' ? LABOUR.ar : LABOUR.en} — ${formatWorkOrderReference(job.reference)}`,
          quantity: hours,
          unit: 'hour',
          unitPrice: settings.labourHourlyRate ?? '0',
        });
      }
      if (lines.length === 0) {
        throw unprocessable('nothing_to_invoice', 'No parts or time were recorded on this job.');
      }
      const invoice = await tx.financeInvoices.createInvoice(
        {
          customerId: job.customerId,
          siteId: job.siteId,
          workOrderId: job.id,
          currencyCode: company.currency,
        },
        lines,
        principal.userId,
      );
      await audit(tx, context, 'invoice.created', 'invoice', invoice.id, {
        workOrderId: job.id,
        lines: lines.length,
        hours,
        ...(followUp ? { followUpOf: earlier.map((invoice) => invoice.id) } : {}),
      });
      return invoiceDetail(tx, principal, invoice);
    });
    return { status: 201, body: detail };
  },
});

export const getInvoiceRoute = defineRoute({
  method: 'get',
  path: '/v1/finance/invoices/:invoiceId',
  operationId: 'getCustomerInvoice',
  summary: 'An invoice, with its lines, credit notes and what it still owes',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.read',
  feature: FINANCE,
  params: invoiceParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The invoice.', schema: invoiceDetailSchema },
    404: { description: 'No such invoice.' },
  },
  handler: async ({ params }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const invoice = await tx.financeInvoices.findInvoice(params.invoiceId);
      if (invoice === undefined) {
        throw notFound('This invoice does not exist.');
      }
      return invoiceDetail(tx, context.principal, invoice);
    });
    return { status: 200, body };
  },
});

export const updateInvoiceRoute = defineRoute({
  method: 'patch',
  path: '/v1/finance/invoices/:invoiceId',
  operationId: 'updateCustomerInvoice',
  summary: 'Change a draft invoice',
  description:
    'Any of the fields, and the whole set of lines when `lines` is given; lines from an order or a job keep their `salesOrderLineId` / `workOrderMaterialId` and may not bill more than the source holds (422 `over_invoiced`). Only a draft changes (409 `invoice_not_draft`).',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.manage',
  feature: FINANCE,
  params: invoiceParams,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(1),
    customerId: z.uuid().optional(),
    siteId: invoiceFields.siteId,
    contactId: invoiceFields.contactId,
    dueDate: invoiceFields.dueDate,
    notes: invoiceFields.notes,
    internalNotes: invoiceFields.internalNotes,
    lines: z.array(invoiceLineInputSchema).max(200).optional(),
  }),
  responses: {
    200: { description: 'The draft.', schema: invoiceDetailSchema },
    404: { description: 'No such invoice, customer or item.' },
    409: {
      description: 'Not a draft (`invoice_not_draft`) or changed elsewhere (`version_conflict`).',
    },
    422: {
      description:
        'A line bills more than its source holds (`over_invoiced`), or names another source (`line_not_from_source`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const current = await requireInvoice(tx, params.invoiceId);
      if (
        body.customerId !== undefined &&
        body.customerId !== current.customerId &&
        (current.salesOrderId !== null || current.workOrderId !== null)
      ) {
        throw unprocessable(
          'customer_fixed',
          'An invoice made from an order or a job keeps its customer.',
        );
      }
      await requireCustomerParties(tx, {
        customerId: body.customerId ?? current.customerId,
        siteId: body.siteId,
        contactId: body.contactId,
      });
      const lines = body.lines === undefined ? undefined : await invoiceLineInputs(tx, body.lines);
      if (lines !== undefined) {
        await checkSourcedLines(tx, current, lines);
      }
      const result = await tx.financeInvoices.updateDraft(
        current.id,
        body.expectedVersion,
        {
          ...(body.customerId === undefined ? {} : { customerId: body.customerId }),
          ...(body.siteId === undefined ? {} : { siteId: body.siteId }),
          ...(body.contactId === undefined ? {} : { contactId: body.contactId }),
          ...(body.dueDate === undefined ? {} : { dueDate: body.dueDate }),
          ...(body.notes === undefined ? {} : { notes: body.notes }),
          ...(body.internalNotes === undefined ? {} : { internalNotes: body.internalNotes }),
        },
        lines,
      );
      if (typeof result === 'string') {
        invoiceRefusal(result);
      }
      await audit(tx, context, 'invoice.updated', 'invoice', result.id, {
        fields: Object.keys(body).filter((key) => key !== 'expectedVersion'),
      });
      return invoiceDetail(tx, principal, result);
    });
    return { status: 200, body: detail };
  },
});

const versionBody = z.object({ expectedVersion: z.number().int().min(1) });

export const discardInvoiceRoute = defineRoute({
  method: 'post',
  path: '/v1/finance/invoices/:invoiceId/discard',
  operationId: 'discardCustomerInvoice',
  summary: 'Discard a draft invoice',
  description:
    'A draft has no number yet, so nothing is lost from the sequence. 409 `invoice_not_draft` once issued.',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.manage',
  feature: FINANCE,
  params: invoiceParams,
  query: noSchema,
  body: versionBody,
  responses: {
    204: { description: 'Discarded.' },
    404: { description: 'No such invoice.' },
    409: { description: 'Not a draft or changed elsewhere.' },
  },
  handler: async ({ params, body }, context) => {
    await withTenant(context.principal.tenantId, async (tx) => {
      const result = await tx.financeInvoices.discardDraft(params.invoiceId, body.expectedVersion);
      if (result !== true) {
        invoiceRefusal(result);
      }
      await audit(tx, context, 'invoice.discarded', 'invoice', params.invoiceId, {});
    });
    return { status: 204, body: undefined };
  },
});

export const issueInvoiceRoute = defineRoute({
  method: 'post',
  path: '/v1/finance/invoices/:invoiceId/issue',
  operationId: 'issueCustomerInvoice',
  summary: 'Issue an invoice',
  description:
    'Owners and admins. Numbers it (`INV-000001` onwards), dates it today in the company’s calendar, sets the due date (given, the draft’s, or today plus the default days), and copies the customer and the issuer block onto it. From then on it never changes. 422 `invoice_empty`, `due_before_issue`, `over_invoiced`; 409 `invoice_not_draft`.',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.issue',
  feature: FINANCE,
  params: invoiceParams,
  query: noSchema,
  body: versionBody.extend({ dueDate: z.iso.date().optional() }),
  responses: {
    200: { description: 'The issued invoice.', schema: invoiceDetailSchema },
    404: { description: 'No such invoice.' },
    409: {
      description: 'Not a draft (`invoice_not_draft`) or changed elsewhere (`version_conflict`).',
    },
    422: {
      description:
        'No lines (`invoice_empty`), a due date before today (`due_before_issue`), or a line billed twice (`over_invoiced`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const invoice = await requireInvoice(tx, params.invoiceId);
      if (invoice.status !== 'draft') {
        invoiceRefusal('not_draft');
      }
      if (invoice.version !== body.expectedVersion) {
        throw versionConflict();
      }
      const lines = await tx.financeInvoices.invoiceLines(invoice.id);
      if (lines.length === 0) {
        throw unprocessable('invoice_empty', 'Add at least one line before issuing.');
      }
      await checkSourcedLines(tx, invoice, lines);
      const [settings, today, customer, contacts] = await Promise.all([
        tx.financeInvoices.settings(),
        companyToday(tx),
        tx.customers.find(invoice.customerId),
        invoice.contactId === null ? [] : tx.customers.findContacts([invoice.contactId]),
      ]);
      const dueDate = body.dueDate ?? invoice.dueDate ?? addDays(today, settings.defaultDueDays);
      if (dueDate < today) {
        throw unprocessable('due_before_issue', 'The due date is before today.', [
          { field: 'body.dueDate', code: 'due_before_issue', message: 'Choose today or later.' },
        ]);
      }
      const issued = await tx.financeInvoices.issue(invoice.id, invoice.version, {
        issuedBy: principal.userId,
        issueDate: today,
        dueDate,
        customerName: customer!.name,
        customerAddress: customer!.address,
        contactName: contacts[0]?.name ?? null,
        contactEmail: contacts[0]?.email ?? null,
        issuer: {
          name: settings.legalName ?? (await companyName(principal.tenantId)),
          address: settings.address,
          taxReference: settings.taxReference,
          paymentInstructions: settings.paymentInstructions,
          footer: settings.footer,
        },
      });
      if (typeof issued === 'string') {
        invoiceRefusal(issued);
      }
      await audit(tx, context, 'invoice.issued', 'invoice', issued.id, {
        reference: formatInvoiceReference(issued.reference!),
        dueDate,
      });
      return invoiceDetail(tx, principal, issued);
    });
    return { status: 200, body: detail };
  },
});

export const voidInvoiceRoute = defineRoute({
  method: 'post',
  path: '/v1/finance/invoices/:invoiceId/void',
  operationId: 'voidCustomerInvoice',
  summary: 'Void an issued invoice nothing was paid or credited against',
  description:
    'Owners and admins, with a reason. It keeps its number and lines and is shown as void. Once a payment or a credit note is against it, credit it instead (409 `invoice_settled`).',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.issue',
  feature: FINANCE,
  params: invoiceParams,
  query: noSchema,
  body: versionBody.extend({ reason: z.string().trim().min(1).max(1000) }),
  responses: {
    200: { description: 'The void invoice.', schema: invoiceDetailSchema },
    404: { description: 'No such invoice.' },
    409: {
      description:
        'Not issued (`invoice_not_issued`), paid or credited (`invoice_settled`), or changed elsewhere.',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const invoice = await requireInvoice(tx, params.invoiceId);
      if (invoice.status !== 'issued') {
        throw conflict('invoice_not_issued', 'Only an issued invoice is voided; discard a draft.');
      }
      const result = await tx.financeInvoices.voidInvoice(
        invoice.id,
        body.expectedVersion,
        principal.userId,
        body.reason,
      );
      if (result === 'settled') {
        throw conflict(
          'invoice_settled',
          'A payment or a credit note is against this invoice. Credit it instead.',
        );
      }
      if (typeof result === 'string') {
        invoiceRefusal(result);
      }
      await audit(tx, context, 'invoice.voided', 'invoice', result.id, {
        reference: formatInvoiceReference(result.reference!),
        reason: body.reason,
      });
      return invoiceDetail(tx, principal, result);
    });
    return { status: 200, body: detail };
  },
});

// ---------------------------------------------------------------------------
// Routes: credit notes
// ---------------------------------------------------------------------------

const creditNoteParams = z.object({ creditNoteId: z.uuid() });

async function creditNoteLineInputs(
  tx: TenantTransaction,
  invoice: Invoice,
  lines: readonly z.infer<typeof creditNoteLineInputSchema>[],
): Promise<CreditNoteLineInput[]> {
  const invoiceLines = new Set(
    (await tx.financeInvoices.invoiceLines(invoice.id)).map((line) => line.id),
  );
  const base = await documentLineInputs(tx, lines);
  return base.map((line, index) => {
    const invoiceLineId = lines[index]!.invoiceLineId ?? null;
    if (invoiceLineId !== null && !invoiceLines.has(invoiceLineId)) {
      throw unprocessable('line_not_from_invoice', 'A line names a line of another invoice.', [
        {
          field: `body.lines.${index}.invoiceLineId`,
          code: 'line_not_from_invoice',
          message: 'Not a line of this invoice.',
        },
      ]);
    }
    return { ...line, invoiceLineId };
  });
}

export const createCreditNoteRoute = defineRoute({
  method: 'post',
  path: '/v1/finance/invoices/:invoiceId/credit-notes',
  operationId: 'createCreditNote',
  summary: 'Draft a credit note against an issued invoice',
  description:
    '`whole: true` copies every line of the invoice; otherwise `lines` (each may name the `invoiceLineId` it credits). A `reason` is printed. Issuing it later refuses more than the invoice still owes. Honours `Idempotency-Key`.',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.manage',
  feature: FINANCE,
  idempotent: true,
  params: invoiceParams,
  query: noSchema,
  body: z.object({
    reason: z.string().trim().min(1).max(1000),
    whole: z.boolean().default(false),
    lines: z.array(creditNoteLineInputSchema).max(200).default([]),
  }),
  responses: {
    201: { description: 'The draft credit note.', schema: creditNoteDetailSchema },
    404: { description: 'No such invoice.' },
    409: { description: 'The invoice is not issued (`invoice_not_issued`).' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const invoice = await requireInvoice(tx, params.invoiceId);
      if (invoice.status !== 'issued') {
        throw conflict('invoice_not_issued', 'Only an issued invoice is credited.');
      }
      const lines: CreditNoteLineInput[] = body.whole
        ? (await tx.financeInvoices.invoiceLines(invoice.id)).map((line) => ({
            invoiceLineId: line.id,
            itemId: line.itemId,
            description: line.description,
            quantity: line.quantity,
            unit: line.unit,
            unitPrice: line.unitPrice,
            discountBp: line.discountBp,
            taxRateBp: line.taxRateBp,
          }))
        : await creditNoteLineInputs(tx, invoice, body.lines);
      const note = await tx.financeInvoices.createCreditNote(
        invoice.id,
        body.reason,
        lines,
        principal.userId,
      );
      if (note === 'invoice_not_open') {
        throw conflict('invoice_not_issued', 'Only an issued invoice is credited.');
      }
      await audit(tx, context, 'credit_note.created', 'credit_note', note.id, {
        invoiceId: invoice.id,
        lines: lines.length,
      });
      return creditNoteDetail(tx, principal, note);
    });
    return { status: 201, body: detail };
  },
});

export const listCreditNotesRoute = defineRoute({
  method: 'get',
  path: '/v1/finance/credit-notes',
  operationId: 'listCreditNotes',
  summary: 'Find credit notes',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.read',
  feature: FINANCE,
  params: noSchema,
  query: z.object({
    q: z.string().trim().max(200).optional(),
    status: many(creditNoteStatusSchema, CREDIT_NOTE_STATUSES.length),
    invoiceId: z.uuid().optional(),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of credit notes.',
      schema: z.object({
        items: z.array(creditNoteSummarySchema),
        nextCursor: z.string().nullable(),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const after = decodeDateCursor(query.cursor);
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const page = await tx.financeInvoices.listCreditNotes({
        ...(query.q === undefined ? {} : { text: query.q }),
        statuses: query.status,
        ...(query.invoiceId === undefined ? {} : { invoiceId: query.invoiceId }),
        ...(after === undefined ? {} : { after }),
        limit: query.limit,
      });
      return {
        items: await creditNoteSummaries(tx, page.items),
        nextCursor: encodeDateCursor(page.next),
      };
    });
    return { status: 200, body };
  },
});

export const getCreditNoteRoute = defineRoute({
  method: 'get',
  path: '/v1/finance/credit-notes/:creditNoteId',
  operationId: 'getCreditNote',
  summary: 'A credit note, with its lines and the invoice it reduces',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.read',
  feature: FINANCE,
  params: creditNoteParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The credit note.', schema: creditNoteDetailSchema },
    404: { description: 'No such credit note.' },
  },
  handler: async ({ params }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const note = await tx.financeInvoices.findCreditNote(params.creditNoteId);
      if (note === undefined) {
        throw notFound('This credit note does not exist.');
      }
      return creditNoteDetail(tx, context.principal, note);
    });
    return { status: 200, body };
  },
});

export const updateCreditNoteRoute = defineRoute({
  method: 'patch',
  path: '/v1/finance/credit-notes/:creditNoteId',
  operationId: 'updateCreditNote',
  summary: 'Change a draft credit note',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.manage',
  feature: FINANCE,
  params: creditNoteParams,
  query: noSchema,
  body: versionBody.extend({
    reason: z.string().trim().min(1).max(1000).optional(),
    lines: z.array(creditNoteLineInputSchema).max(200).optional(),
  }),
  responses: {
    200: { description: 'The draft.', schema: creditNoteDetailSchema },
    404: { description: 'No such credit note.' },
    409: { description: 'Not a draft (`credit_note_not_draft`) or changed elsewhere.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const current = await requireCreditNote(tx, params.creditNoteId);
      const invoice = (await tx.financeInvoices.findInvoice(current.invoiceId))!;
      const lines =
        body.lines === undefined ? undefined : await creditNoteLineInputs(tx, invoice, body.lines);
      const result = await tx.financeInvoices.updateCreditNoteDraft(
        current.id,
        body.expectedVersion,
        body.reason === undefined ? {} : { reason: body.reason },
        lines,
      );
      if (typeof result === 'string') {
        creditNoteRefusal(result);
      }
      await audit(tx, context, 'credit_note.updated', 'credit_note', result.id, {
        fields: Object.keys(body).filter((key) => key !== 'expectedVersion'),
      });
      return creditNoteDetail(tx, principal, result);
    });
    return { status: 200, body: detail };
  },
});

export const discardCreditNoteRoute = defineRoute({
  method: 'post',
  path: '/v1/finance/credit-notes/:creditNoteId/discard',
  operationId: 'discardCreditNote',
  summary: 'Discard a draft credit note',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.manage',
  feature: FINANCE,
  params: creditNoteParams,
  query: noSchema,
  body: versionBody,
  responses: {
    204: { description: 'Discarded.' },
    404: { description: 'No such credit note.' },
    409: { description: 'Not a draft or changed elsewhere.' },
  },
  handler: async ({ params, body }, context) => {
    await withTenant(context.principal.tenantId, async (tx) => {
      const result = await tx.financeInvoices.discardCreditNoteDraft(
        params.creditNoteId,
        body.expectedVersion,
      );
      if (result !== true) {
        creditNoteRefusal(result);
      }
      await audit(tx, context, 'credit_note.discarded', 'credit_note', params.creditNoteId, {});
    });
    return { status: 204, body: undefined };
  },
});

export const issueCreditNoteRoute = defineRoute({
  method: 'post',
  path: '/v1/finance/credit-notes/:creditNoteId/issue',
  operationId: 'issueCreditNote',
  summary: 'Issue a credit note',
  description:
    'Owners and admins. Numbers it (`CN-000001` onwards) and takes its total off the invoice’s balance. Refused for more than the invoice still owes (422 `credit_over_balance`), with no lines (422 `credit_note_empty`), or when the invoice is no longer issued (409 `invoice_not_issued`).',
  tags: FINANCE_TAGS,
  security: 'authenticated',
  permission: 'finance.issue',
  feature: FINANCE,
  params: creditNoteParams,
  query: noSchema,
  body: versionBody,
  responses: {
    200: { description: 'The issued credit note.', schema: creditNoteDetailSchema },
    404: { description: 'No such credit note.' },
    409: { description: 'Not a draft, the invoice is not issued, or changed elsewhere.' },
    422: { description: 'More than the invoice owes, or no lines.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const note = await requireCreditNote(tx, params.creditNoteId);
      if (note.status !== 'draft') {
        creditNoteRefusal('not_draft');
      }
      const result = await tx.financeInvoices.issueCreditNote(
        note.id,
        body.expectedVersion,
        principal.userId,
        await companyToday(tx),
      );
      if (result === 'over_balance') {
        throw unprocessable(
          'credit_over_balance',
          'This credit note takes off more than the invoice still owes.',
        );
      }
      if (result === 'empty') {
        throw unprocessable('credit_note_empty', 'Add at least one line before issuing.');
      }
      if (result === 'invoice_not_open') {
        throw conflict('invoice_not_issued', 'The invoice is no longer issued.');
      }
      if (typeof result === 'string') {
        creditNoteRefusal(result);
      }
      await audit(tx, context, 'credit_note.issued', 'credit_note', result.id, {
        reference: formatCreditNoteReference(result.reference!),
        invoiceId: result.invoiceId,
      });
      return creditNoteDetail(tx, principal, result);
    });
    return { status: 200, body: detail };
  },
});

export const invoiceRoutes = [
  getFinanceSettingsRoute,
  saveFinanceSettingsRoute,
  listInvoicesRoute,
  createInvoiceRoute,
  invoiceFromOrderRoute,
  invoiceFromJobRoute,
  getInvoiceRoute,
  updateInvoiceRoute,
  discardInvoiceRoute,
  issueInvoiceRoute,
  voidInvoiceRoute,
  createCreditNoteRoute,
  listCreditNotesRoute,
  getCreditNoteRoute,
  updateCreditNoteRoute,
  discardCreditNoteRoute,
  issueCreditNoteRoute,
];
