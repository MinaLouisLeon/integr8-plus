import { z } from 'zod';
import { compareDecimals } from './inventory.js';

/**
 * A company's invoices, credit notes and payment receipts (CRM/ERP plan, phase
 * B1; ADR-0004, ADR-0007): the vocabularies the database checks, the API
 * validates and the screens translate.
 *
 * This is the company's own commercial ledger, not Integr8's subscription
 * billing and not a certified tax document. Money is a decimal string end to
 * end; discount and tax are whole basis points per line; every total comes
 * from the lines in SQL.
 */

/** What the database keeps: a draft, an issued (frozen, numbered) invoice, or a voided one. */
export const INVOICE_STORED_STATUSES = ['draft', 'issued', 'void'] as const;
export type InvoiceStoredStatus = (typeof INVOICE_STORED_STATUSES)[number];

/**
 * What an invoice is, as people read it — derived from the facts (credit
 * notes and allocated payments), never set by hand.
 */
export const INVOICE_STATUSES = [
  'draft',
  'issued',
  'partially_paid',
  'paid',
  'credited',
  'void',
] as const;
export const invoiceStatusSchema = z.enum(INVOICE_STATUSES);
export type InvoiceStatus = z.infer<typeof invoiceStatusSchema>;

/**
 * The status an issued invoice has from its balance: `paid` once payments and
 * credits cover it (`credited` when credit notes alone did), `partially_paid`
 * once any payment is allocated, else `issued`.
 */
export function invoiceStatus(
  stored: InvoiceStoredStatus,
  amounts: { balance: string; allocated: string },
): InvoiceStatus {
  if (stored !== 'issued') {
    return stored;
  }
  const settled = compareDecimals(amounts.balance, '0') <= 0;
  const anyPaid = compareDecimals(amounts.allocated, '0') > 0;
  if (settled) {
    return anyPaid ? 'paid' : 'credited';
  }
  return anyPaid ? 'partially_paid' : 'issued';
}

export const CREDIT_NOTE_STATUSES = ['draft', 'issued'] as const;
export const creditNoteStatusSchema = z.enum(CREDIT_NOTE_STATUSES);
export type CreditNoteStatus = z.infer<typeof creditNoteStatusSchema>;

/** How money reached the company. No gateway: every payment is recorded by hand. */
export const PAYMENT_METHODS = ['cash', 'bank_transfer', 'other'] as const;
export const paymentMethodSchema = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

/** Where an invoice's lines came from. */
export const INVOICE_SOURCES = ['sales_order', 'work_order', 'blank'] as const;
export type InvoiceSource = (typeof INVOICE_SOURCES)[number];

/** Which quantity of a sales order an invoice bills: everything ordered, or what was delivered. */
export const INVOICE_ORDER_BASES = ['ordered', 'delivered'] as const;
export const invoiceOrderBasisSchema = z.enum(INVOICE_ORDER_BASES);
export type InvoiceOrderBasis = z.infer<typeof invoiceOrderBasisSchema>;

/** Which document a per-company finance counter numbers. */
export const FINANCE_DOCUMENT_KINDS = ['invoice', 'credit_note', 'payment'] as const;
export type FinanceDocumentKind = (typeof FINANCE_DOCUMENT_KINDS)[number];

const pad = (reference: number) => String(reference).padStart(6, '0');
export const formatInvoiceReference = (reference: number) => `INV-${pad(reference)}`;
export const formatCreditNoteReference = (reference: number) => `CN-${pad(reference)}`;
export const formatReceiptReference = (reference: number) => `RC-${pad(reference)}`;

/** `INV-000123`, `CN-123`, `RC-000123` or `123`, as typed into a search box. */
export function parseFinanceReference(text: string): number | undefined {
  const match = /^\s*(?:(?:INV|CN|RC)-?)?0*(\d{1,9})\s*$/iu.exec(text);
  if (match === null) {
    return undefined;
  }
  const value = Number(match[1]);
  return value > 0 ? value : undefined;
}

/** Days from issue to due, as a company default. */
export const dueDaysSchema = z.number().int().min(0).max(365);

/**
 * Milliseconds as hours with up to two decimals, as decimal text: whole
 * minutes first, then hundredths of an hour by integer arithmetic, so the
 * labour line never carries a float's tail. `5_400_000` is `'1.5'`.
 */
export function hoursOfMs(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const hundredths = Math.round((minutes * 100) / 60);
  const whole = Math.floor(hundredths / 100);
  const fraction = String(hundredths % 100)
    .padStart(2, '0')
    .replace(/0+$/u, '');
  return fraction === '' ? String(whole) : `${String(whole)}.${fraction}`;
}

/** `YYYY-MM-DD` plus whole days, in the calendar alone (no time zone). */
export function addDays(day: string, days: number): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const result = new Date(Date.UTC(year, month - 1, date + days));
  return result.toISOString().slice(0, 10);
}
