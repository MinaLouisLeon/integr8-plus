import {
  type QuoteAnswerVia,
  type QuoteStatus,
  type Unit,
  type UserId,
  parseSalesReference,
  toUserId,
} from '@integr8/core';
import { type Kysely, type Selectable, sql } from 'kysely';
import type { CrmQuotesTable, Database } from '../schema.js';
import { toDayString, trimDecimal } from './crm-leads.js';
import type { Address } from './customers.js';
import { prefixQuery } from './customers.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Quotes (CRM/ERP plan, phase S1; ADR-0006).
 *
 * A quote is numbered per company on creation and frozen when issued: the
 * customer's name and address are copied onto it and its lines stop changing
 * (trigger `crm_quote_lines_guard`). Money is `numeric(20,4)` end to end;
 * line and document totals are computed here in SQL from the lines, rounded
 * half-up to four places once per line, and come back as decimal strings.
 */

export interface Quote {
  id: string;
  reference: number;
  revision: number;
  customerId: string;
  siteId: string | null;
  contactId: string | null;
  opportunityId: string | null;
  status: QuoteStatus;
  title: string;
  currencyCode: string;
  /** `YYYY-MM-DD`. */
  validUntil: string | null;
  introduction: string | null;
  terms: string | null;
  internalNotes: string | null;
  /** The customer as the issued quote names them; null while a draft. */
  customerName: string | null;
  customerAddress: Address | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  issuedBy: UserId | null;
  issuedAt: Date | null;
  /** Whether a customer link is live. The token itself is never stored. */
  hasToken: boolean;
  answeredAt: Date | null;
  answeredBy: UserId | null;
  answeredVia: QuoteAnswerVia | null;
  answeredName: string | null;
  answeredFrom: string | null;
  rejectionReason: string | null;
  convertedOrderId: string | null;
  convertedAt: Date | null;
  cancelledBy: UserId | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  version: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuoteLine {
  id: string;
  position: number;
  itemId: string | null;
  description: string;
  quantity: string;
  unit: Unit;
  unitPrice: string;
  discountBp: number;
  taxRateBp: number;
  /** `quantity × unitPrice`, rounded to four places. */
  gross: string;
  /** The discount on the gross, rounded to four places. */
  discount: string;
  /** Gross less discount. */
  net: string;
  /** Tax on the net, rounded to four places. */
  tax: string;
  /** Net plus tax. */
  total: string;
}

export interface DocumentTotals {
  gross: string;
  discount: string;
  net: string;
  tax: string;
  total: string;
}

export interface QuoteLineInput {
  itemId?: string | null;
  description: string;
  quantity: string;
  unit?: Unit;
  unitPrice: string;
  discountBp?: number;
  taxRateBp?: number;
}

export interface QuoteInput {
  customerId: string;
  siteId?: string | null;
  contactId?: string | null;
  opportunityId?: string | null;
  title: string;
  currencyCode: string;
  validUntil?: string | null;
  introduction?: string | null;
  terms?: string | null;
  internalNotes?: string | null;
}

export interface QuoteQuery {
  /** Words from the title or customer name, or a reference such as `QT-000123`. */
  text?: string;
  statuses?: readonly QuoteStatus[];
  customerId?: string;
  opportunityId?: string;
  after?: { createdAt: Date; id: string };
  limit?: number;
}

export interface QuotePage {
  items: Quote[];
  next: { createdAt: Date; id: string } | undefined;
}

export type QuoteRefusal = 'not_found' | 'version_conflict';

/** The customer as the quote shows them, copied when issued. */
export interface QuoteSnapshot {
  customerName: string;
  customerAddress: Address;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
}

/**
 * Each line's figures and the document's, in one SQL expression set. Each
 * figure is rounded to the line's own scale (0064): its currency's minor unit
 * for lines written since, four places for those written before, so a
 * document issued before keeps its totals exactly.
 */
export const LINE_MATH = sql`
  round(l.quantity * l.unit_price, l.money_scale) as gross,
  round(round(l.quantity * l.unit_price, l.money_scale) * l.discount_bp / 10000, l.money_scale) as discount,
  round(round(l.quantity * l.unit_price, l.money_scale) - round(round(l.quantity * l.unit_price, l.money_scale) * l.discount_bp / 10000, l.money_scale), l.money_scale) as net,
  round((round(l.quantity * l.unit_price, l.money_scale) - round(round(l.quantity * l.unit_price, l.money_scale) * l.discount_bp / 10000, l.money_scale)) * l.tax_rate_bp / 10000, l.money_scale) as tax
`;

export class SalesQuotesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async createQuote(
    input: QuoteInput,
    lines: readonly QuoteLineInput[],
    createdBy: UserId | string,
  ): Promise<Quote> {
    const row = await this.db
      .insertInto('crm_quotes')
      .values({
        tenant_id: this.tenantId,
        created_by: toUserId(createdBy),
        customer_id: input.customerId,
        site_id: input.siteId ?? null,
        contact_id: input.contactId ?? null,
        opportunity_id: input.opportunityId ?? null,
        title: input.title.trim(),
        currency_code: input.currencyCode,
        valid_until: input.validUntil ?? null,
        introduction: blankToNull(input.introduction),
        terms: blankToNull(input.terms),
        internal_notes: blankToNull(input.internalNotes),
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    await this.#writeLines(row.id, lines);
    return toQuote(row);
  }

  async findQuote(quoteId: string): Promise<Quote | undefined> {
    const row = await this.db
      .selectFrom('crm_quotes')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', quoteId)
      .executeTakeFirst();
    return row === undefined ? undefined : toQuote(row);
  }

  /** Locks the quote for the rest of the transaction: one answer, one conversion. */
  async lockQuote(quoteId: string): Promise<Quote | undefined> {
    const row = await this.db
      .selectFrom('crm_quotes')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', quoteId)
      .forUpdate()
      .executeTakeFirst();
    return row === undefined ? undefined : toQuote(row);
  }

  async findQuotes(quoteIds: readonly string[]): Promise<Quote[]> {
    if (quoteIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('crm_quotes')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('id', 'in', [...new Set(quoteIds)])
      .execute();
    return rows.map(toQuote);
  }

  async listQuotes(query: QuoteQuery = {}): Promise<QuotePage> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    let select = this.db
      .selectFrom('crm_quotes')
      .selectAll('crm_quotes')
      .where('crm_quotes.tenant_id', '=', this.tenantId);
    if (query.text !== undefined && query.text.trim() !== '') {
      const reference = parseSalesReference(query.text);
      if (reference !== undefined) {
        select = select.where('crm_quotes.reference', '=', reference);
      } else {
        const words = prefixQuery(query.text);
        if (words !== undefined) {
          select = select.where((eb) =>
            eb.or([
              eb(
                sql`to_tsvector('simple', crm_quotes.title || ' ' || coalesce(crm_quotes.customer_name, ''))`,
                '@@',
                sql`to_tsquery('simple', ${words})`,
              ),
              eb.exists(
                eb
                  .selectFrom('customers')
                  .select(sql`1`.as('one'))
                  .where('customers.tenant_id', '=', this.tenantId)
                  .whereRef('customers.id', '=', 'crm_quotes.customer_id')
                  .where(sql<boolean>`customers.search @@ to_tsquery('simple', ${words})`),
              ),
            ]),
          );
        }
      }
    }
    if (query.statuses !== undefined && query.statuses.length > 0) {
      select = select.where('crm_quotes.status', 'in', [...query.statuses]);
    }
    if (query.customerId !== undefined) {
      select = select.where('crm_quotes.customer_id', '=', query.customerId);
    }
    if (query.opportunityId !== undefined) {
      select = select.where('crm_quotes.opportunity_id', '=', query.opportunityId);
    }
    if (query.after !== undefined) {
      select = select.where(
        sql<boolean>`(crm_quotes.created_at, crm_quotes.id) < (${query.after.createdAt}, ${query.after.id}::uuid)`,
      );
    }
    const rows = await select
      .orderBy('crm_quotes.created_at', 'desc')
      .orderBy('crm_quotes.id', 'desc')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit).map(toQuote);
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : undefined,
    };
  }

  async quoteLines(quoteId: string): Promise<QuoteLine[]> {
    const { rows } = await sql<LineRow>`
      select l.*, ${LINE_MATH}
        from crm_quote_lines l
       where l.tenant_id = ${this.tenantId} and l.quote_id = ${quoteId}
       order by l.position
    `.execute(this.db);
    return rows.map(toLine);
  }

  async quoteTotals(quoteId: string): Promise<DocumentTotals> {
    return documentTotals(this.db, 'crm_quote_lines', 'quote_id', this.tenantId, quoteId);
  }

  /** Changes a draft, replacing every line when `lines` is given. */
  async updateDraft(
    quoteId: string,
    expectedVersion: number,
    input: Partial<Omit<QuoteInput, 'currencyCode'>>,
    lines: readonly QuoteLineInput[] | undefined,
  ): Promise<Quote | QuoteRefusal | 'not_draft'> {
    const current = await this.lockQuote(quoteId);
    if (current === undefined) {
      return 'not_found';
    }
    if (current.version !== expectedVersion) {
      return 'version_conflict';
    }
    if (current.status !== 'draft') {
      return 'not_draft';
    }
    if (lines !== undefined) {
      await this.db
        .deleteFrom('crm_quote_lines')
        .where('tenant_id', '=', this.tenantId)
        .where('quote_id', '=', quoteId)
        .execute();
      await this.#writeLines(quoteId, lines);
    }
    const row = await this.db
      .updateTable('crm_quotes')
      .set({
        ...(input.customerId === undefined ? {} : { customer_id: input.customerId }),
        ...(input.siteId === undefined ? {} : { site_id: input.siteId }),
        ...(input.contactId === undefined ? {} : { contact_id: input.contactId }),
        ...(input.opportunityId === undefined ? {} : { opportunity_id: input.opportunityId }),
        ...(input.title === undefined ? {} : { title: input.title.trim() }),
        ...(input.validUntil === undefined ? {} : { valid_until: input.validUntil }),
        ...(input.introduction === undefined
          ? {}
          : { introduction: blankToNull(input.introduction) }),
        ...(input.terms === undefined ? {} : { terms: blankToNull(input.terms) }),
        ...(input.internalNotes === undefined
          ? {}
          : { internal_notes: blankToNull(input.internalNotes) }),
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', quoteId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toQuote(row);
  }

  /**
   * Issues a draft: freezes the customer onto it, records who and when, and
   * stores the hash of the customer's link token. The caller checked the
   * status; the pairing constraints check the bookkeeping.
   */
  async issue(
    quoteId: string,
    expectedVersion: number,
    issue: { issuedBy: UserId | string; snapshot: QuoteSnapshot; tokenHash: string },
  ): Promise<Quote | QuoteRefusal> {
    const row = await this.db
      .updateTable('crm_quotes')
      .set({
        status: 'issued',
        issued_by: toUserId(issue.issuedBy),
        issued_at: sql<Date>`now()`,
        customer_name: issue.snapshot.customerName,
        customer_address: sql`${JSON.stringify(issue.snapshot.customerAddress)}::jsonb`,
        contact_name: issue.snapshot.contactName,
        contact_email: issue.snapshot.contactEmail,
        contact_phone: issue.snapshot.contactPhone,
        access_token_hash: issue.tokenHash,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', quoteId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? await this.#refusal(quoteId) : toQuote(row);
  }

  /** Makes a new draft revision under the same reference; the old link dies with the old issue. */
  async revise(quoteId: string, expectedVersion: number): Promise<Quote | QuoteRefusal> {
    const row = await this.db
      .updateTable('crm_quotes')
      .set({
        status: 'draft',
        revision: sql<number>`revision + 1`,
        issued_by: null,
        issued_at: null,
        customer_name: null,
        customer_address: null,
        contact_name: null,
        contact_email: null,
        contact_phone: null,
        access_token_hash: null,
        answered_at: null,
        answered_by: null,
        answered_via: null,
        answered_name: null,
        answered_from: null,
        rejection_reason: null,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', quoteId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? await this.#refusal(quoteId) : toQuote(row);
  }

  /** Records the customer's answer, from the office or through the link. */
  async answer(
    quoteId: string,
    answer: {
      status: 'accepted' | 'rejected';
      via: QuoteAnswerVia;
      /** The seat that recorded it, when the office did. */
      answeredBy: UserId | string | null;
      /** The name the customer gave, or the office typed. */
      name: string | null;
      /** The caller's address, when it came through the link. */
      from: string | null;
      reason: string | null;
    },
    expectedVersion?: number,
  ): Promise<Quote | QuoteRefusal> {
    let update = this.db
      .updateTable('crm_quotes')
      .set({
        status: answer.status,
        answered_at: sql<Date>`now()`,
        answered_by: answer.answeredBy === null ? null : toUserId(answer.answeredBy),
        answered_via: answer.via,
        answered_name: blankToNull(answer.name),
        answered_from: answer.from,
        rejection_reason: answer.status === 'rejected' ? blankToNull(answer.reason) : null,
        // An answered quote's link is spent.
        access_token_hash: null,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', quoteId);
    if (expectedVersion !== undefined) {
      update = update.where('version', '=', expectedVersion);
    }
    const row = await update.returningAll().executeTakeFirst();
    return row === undefined ? await this.#refusal(quoteId) : toQuote(row);
  }

  async markConverted(quoteId: string, orderId: string): Promise<Quote> {
    const row = await this.db
      .updateTable('crm_quotes')
      .set({
        status: 'converted',
        converted_order_id: orderId,
        converted_at: sql<Date>`now()`,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', quoteId)
      .returningAll()
      .executeTakeFirstOrThrow();
    return toQuote(row);
  }

  async cancel(
    quoteId: string,
    expectedVersion: number,
    cancelledBy: UserId | string,
    reason: string | null,
  ): Promise<Quote | QuoteRefusal> {
    const row = await this.db
      .updateTable('crm_quotes')
      .set({
        status: 'cancelled',
        cancelled_by: toUserId(cancelledBy),
        cancelled_at: sql<Date>`now()`,
        cancel_reason: blankToNull(reason),
        access_token_hash: null,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', quoteId)
      .where('version', '=', expectedVersion)
      .returningAll()
      .executeTakeFirst();
    return row === undefined ? await this.#refusal(quoteId) : toQuote(row);
  }

  async #refusal(quoteId: string): Promise<QuoteRefusal> {
    return (await this.findQuote(quoteId)) === undefined ? 'not_found' : 'version_conflict';
  }

  async #writeLines(quoteId: string, lines: readonly QuoteLineInput[]): Promise<void> {
    if (lines.length === 0) {
      return;
    }
    await this.db
      .insertInto('crm_quote_lines')
      .values(
        lines.map((line, index) => ({
          tenant_id: this.tenantId,
          quote_id: quoteId,
          position: index + 1,
          item_id: line.itemId ?? null,
          description: line.description.trim(),
          quantity: line.quantity,
          unit: line.unit ?? 'each',
          unit_price: line.unitPrice,
          discount_bp: line.discountBp ?? 0,
          tax_rate_bp: line.taxRateBp ?? 0,
        })),
      )
      .execute();
  }
}

// ---------------------------------------------------------------------------
// Shared with sales orders
// ---------------------------------------------------------------------------

export interface LineRow {
  id: string;
  position: number;
  item_id: string | null;
  description: string;
  quantity: string;
  unit: Unit;
  unit_price: string;
  discount_bp: number;
  tax_rate_bp: number;
  gross: string;
  discount: string;
  net: string;
  tax: string;
}

export function toLine(row: LineRow): QuoteLine {
  const net = trimDecimal(row.net);
  const tax = trimDecimal(row.tax);
  return {
    id: row.id,
    position: row.position,
    itemId: row.item_id,
    description: row.description,
    quantity: trimDecimal(row.quantity),
    unit: row.unit,
    unitPrice: trimDecimal(row.unit_price),
    discountBp: row.discount_bp,
    taxRateBp: row.tax_rate_bp,
    gross: trimDecimal(row.gross),
    discount: trimDecimal(row.discount),
    net,
    tax,
    total: addDecimals(net, tax),
  };
}

/** `a + b` for decimal strings of up to four places, exactly. */
export function addDecimals(a: string, b: string): string {
  const scale = (text: string) => {
    const negative = text.startsWith('-');
    const [whole = '0', fraction = ''] = text.replace(/^-/u, '').split('.');
    const value = BigInt(whole + fraction.padEnd(4, '0').slice(0, 4));
    return negative ? -value : value;
  };
  const sum = scale(a) + scale(b);
  const digits = (sum < 0n ? -sum : sum).toString().padStart(5, '0');
  const text = `${digits.slice(0, -4)}.${digits.slice(-4)}`.replace(/\.?0+$/u, '');
  return sum < 0n ? `-${text}` : text;
}

/**
 * The document's totals from its lines, summed in SQL. The table and its
 * tenant predicate are written as text, as the balance queries are: the
 * tenant guard reads Kysely nodes, and a `sql.table` with a raw predicate
 * would look to it like an unscoped read.
 */
export async function documentTotals(
  db: TenantScopedRepository['db'],
  table:
    'crm_quote_lines' | 'erp_sales_order_lines' | 'erp_invoice_lines' | 'erp_credit_note_lines',
  parentColumn: 'quote_id' | 'order_id' | 'invoice_id' | 'credit_note_id',
  tenantId: string,
  parentId: string,
): Promise<DocumentTotals> {
  const sources = {
    crm_quote_lines: {
      column: 'quote_id',
      sql: sql`crm_quote_lines l where l.tenant_id = ${tenantId} and l.quote_id = ${parentId}`,
    },
    erp_sales_order_lines: {
      column: 'order_id',
      sql: sql`erp_sales_order_lines l where l.tenant_id = ${tenantId} and l.order_id = ${parentId}`,
    },
    erp_invoice_lines: {
      column: 'invoice_id',
      sql: sql`erp_invoice_lines l where l.tenant_id = ${tenantId} and l.invoice_id = ${parentId}`,
    },
    erp_credit_note_lines: {
      column: 'credit_note_id',
      sql: sql`erp_credit_note_lines l where l.tenant_id = ${tenantId} and l.credit_note_id = ${parentId}`,
    },
  } as const;
  const chosen = sources[table];
  if (chosen.column !== parentColumn) {
    throw new Error('documentTotals: the parent column does not belong to the table');
  }
  const source = chosen.sql;
  const { rows } = await sql<{ gross: string; discount: string; net: string; tax: string }>`
    select coalesce(sum(gross), 0)::text as gross,
           coalesce(sum(discount), 0)::text as discount,
           coalesce(sum(net), 0)::text as net,
           coalesce(sum(tax), 0)::text as tax
      from (select ${LINE_MATH} from ${source}) lines
  `.execute(db);
  const row = rows[0]!;
  const net = trimDecimal(row.net);
  const tax = trimDecimal(row.tax);
  return {
    gross: trimDecimal(row.gross),
    discount: trimDecimal(row.discount),
    net,
    tax,
    total: addDecimals(net, tax),
  };
}

export function blankToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

export function toAddress(value: Record<string, string | null> | null): Address | null {
  if (value === null) {
    return null;
  }
  return {
    line1: value.line1 ?? null,
    line2: value.line2 ?? null,
    city: value.city ?? null,
    region: value.region ?? null,
    postcode: value.postcode ?? null,
    countryCode: value.countryCode ?? null,
  };
}

function toQuote(row: Selectable<CrmQuotesTable>): Quote {
  return {
    id: row.id,
    reference: row.reference,
    revision: row.revision,
    customerId: row.customer_id,
    siteId: row.site_id,
    contactId: row.contact_id,
    opportunityId: row.opportunity_id,
    status: row.status,
    title: row.title,
    currencyCode: row.currency_code,
    validUntil: toDayString(row.valid_until),
    introduction: row.introduction,
    terms: row.terms,
    internalNotes: row.internal_notes,
    customerName: row.customer_name,
    customerAddress: toAddress(row.customer_address),
    contactName: row.contact_name,
    contactEmail: row.contact_email,
    contactPhone: row.contact_phone,
    issuedBy: row.issued_by === null ? null : toUserId(row.issued_by),
    issuedAt: row.issued_at,
    hasToken: row.access_token_hash !== null,
    answeredAt: row.answered_at,
    answeredBy: row.answered_by === null ? null : toUserId(row.answered_by),
    answeredVia: row.answered_via,
    answeredName: row.answered_name,
    answeredFrom: row.answered_from,
    rejectionReason: row.rejection_reason,
    convertedOrderId: row.converted_order_id,
    convertedAt: row.converted_at,
    cancelledBy: row.cancelled_by === null ? null : toUserId(row.cancelled_by),
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    version: row.version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// The customer's link, before any tenant is known
// ---------------------------------------------------------------------------

/**
 * Finds the quote a link token names (ADR-0006). Platform connection: the
 * customer who opens the link has no session and belongs to no company, so
 * the hash is looked up across every company first and the quote is then
 * read on that company's own connection. Only a live token matches: an
 * answered, revised or cancelled quote has none.
 */
export class PublicQuotesLookup {
  constructor(private readonly db: Kysely<Database>) {}

  async byTokenHash(tokenHash: string): Promise<{ tenantId: string; quoteId: string } | undefined> {
    const row = await this.db
      .selectFrom('crm_quotes')
      .innerJoin('tenants', 'tenants.id', 'crm_quotes.tenant_id')
      .select(['crm_quotes.tenant_id', 'crm_quotes.id'])
      .where('crm_quotes.access_token_hash', '=', tokenHash)
      .where('tenants.deleted_at', 'is', null)
      .where('tenants.status', '=', 'active')
      .executeTakeFirst();
    return row === undefined ? undefined : { tenantId: row.tenant_id, quoteId: row.id };
  }
}
