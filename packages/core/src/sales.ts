import { z } from 'zod';

/**
 * Quotes and sales orders (CRM/ERP plan, phase S1): the vocabularies the
 * database checks, the API validates and the screens translate.
 *
 * Money is a decimal string end to end; a discount or tax rate is a whole
 * number of basis points (1450 = 14.5%). Totals are computed in SQL from the
 * lines and never taken from a request.
 */

/**
 * A quote's life. `draft` is edited freely; `issued` is frozen and may be
 * accepted or rejected (by the office or through the customer's link) until
 * its expiry; `converted` has become a sales order, once; `cancelled` is
 * withdrawn. Revising an issued, rejected or expired quote makes a new
 * `draft` revision under the same reference.
 */
export const QUOTE_STATUSES = [
  'draft',
  'issued',
  'accepted',
  'rejected',
  'converted',
  'cancelled',
] as const;
export const quoteStatusSchema = z.enum(QUOTE_STATUSES);
export type QuoteStatus = z.infer<typeof quoteStatusSchema>;

/** How a customer's answer reached the company (ADR-0006). */
export const QUOTE_ANSWER_VIAS = ['office', 'link'] as const;
export const quoteAnswerViaSchema = z.enum(QUOTE_ANSWER_VIAS);
export type QuoteAnswerVia = z.infer<typeof quoteAnswerViaSchema>;

/** Statuses a customer may still answer from, expiry permitting. */
export function quoteAnswerable(status: QuoteStatus): boolean {
  return status === 'issued';
}

/** Statuses a quote may be revised from: anything issued that did not become an order. */
export function quoteRevisable(status: QuoteStatus): boolean {
  return status === 'issued' || status === 'rejected';
}

/** Whether a quote with this expiry can still be answered on this day (`YYYY-MM-DD` both). */
export function quoteExpired(validUntil: string | null, today: string): boolean {
  return validUntil !== null && validUntil < today;
}

export const SALES_ORDER_STATUSES = [
  'draft',
  'confirmed',
  'partially_fulfilled',
  'fulfilled',
  'cancelled',
] as const;
export const salesOrderStatusSchema = z.enum(SALES_ORDER_STATUSES);
export type SalesOrderStatus = z.infer<typeof salesOrderStatusSchema>;

/** Statuses in which an order holds reservations and may take jobs. */
export function salesOrderOpen(status: SalesOrderStatus): boolean {
  return status === 'confirmed' || status === 'partially_fulfilled';
}

/** A discount as basis points of the line's gross: 0 to 100%. */
export const discountBpSchema = z.number().int().min(0).max(10_000);

/** Which document a per-company reference counter numbers. */
export const SALES_DOCUMENT_KINDS = ['quote', 'sales_order', 'delivery'] as const;
export type SalesDocumentKind = (typeof SALES_DOCUMENT_KINDS)[number];

export function formatQuoteReference(reference: number, revision = 1): string {
  const base = `QT-${String(reference).padStart(6, '0')}`;
  return revision > 1 ? `${base}-R${revision}` : base;
}

export function formatSalesOrderReference(reference: number): string {
  return `SO-${String(reference).padStart(6, '0')}`;
}

/** A delivery note's number: goods handed over on a sales order (ADR-0012). */
export function formatDeliveryReference(reference: number): string {
  return `DN-${String(reference).padStart(6, '0')}`;
}

/** A reference as someone might type it: `QT-000123`, `so 7`, `123`. */
export function parseSalesReference(text: string): number | undefined {
  const match = /^\s*(?:(?:qt|so)[-\s]?)?0*(\d{1,9})(?:-r\d+)?\s*$/iu.exec(text);
  return match === null ? undefined : Number(match[1]);
}
