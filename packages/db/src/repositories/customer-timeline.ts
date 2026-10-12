import { sql } from 'kysely';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * One customer's history, newest first, mixing what other screens keep apart
 * (eighth round; ADR-0012): CRM activities, job events, forms submitted on
 * their jobs, and the documents issued to them. Read-only: each entry links
 * to the record it comes from. Which sources are included is the caller's
 * choice, by module and permission.
 */

export const TIMELINE_SOURCES = ['activities', 'jobs', 'submissions', 'sales', 'finance'] as const;
export type TimelineSource = (typeof TIMELINE_SOURCES)[number];

export type TimelineKind =
  | 'activity'
  | 'job_event'
  | 'submission'
  | 'quote_issued'
  | 'quote_answered'
  | 'order_confirmed'
  | 'invoice_issued'
  | 'invoice_voided'
  | 'payment_received';

export interface TimelineEntry {
  kind: TimelineKind;
  at: Date;
  /** The record it comes from: an activity, job, submission, quote, order, invoice or receipt. */
  recordId: string;
  /** Its number, where it has one (job, quote, order, invoice, receipt). */
  reference: number | null;
  /** A title or subject, as written. */
  title: string | null;
  /** What happened: an activity's kind, a job event's kind, a quote's answer, an amount. */
  detail: string | null;
  /** For a submission and a job event, the job; null otherwise. */
  workOrderId: string | null;
  /** A stable key, for paging. */
  key: string;
}

interface Row {
  kind: TimelineKind;
  at: Date;
  record_id: string;
  reference: number | null;
  title: string | null;
  detail: string | null;
  work_order_id: string | null;
  key: string;
}

export class CustomerTimelineRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async entries(
    customerId: string,
    query: {
      sources: readonly TimelineSource[];
      before?: { at: string; key: string } | undefined;
      limit: number;
    },
  ): Promise<{ items: TimelineEntry[]; next?: { at: string; key: string } }> {
    const tenant = this.tenantId;
    const parts = [];
    if (query.sources.includes('activities')) {
      parts.push(sql`
        select 'activity' as kind, coalesce(a.completed_at, a.created_at) as at, a.id as record_id,
               null::int as reference, a.subject as title, a.kind as detail, null::uuid as work_order_id,
               'activity:' || a.id as key
          from crm_activities a
          join crm_activity_customers c on c.tenant_id = a.tenant_id and c.activity_id = a.id
         where a.tenant_id = ${tenant} and c.customer_id = ${customerId}::uuid`);
    }
    if (query.sources.includes('jobs')) {
      parts.push(sql`
        select 'job_event', e.occurred_at, w.id, w.reference, w.title, e.kind, w.id,
               'job_event:' || e.id
          from work_order_events e
          join work_orders w on w.tenant_id = e.tenant_id and w.id = e.work_order_id
         where e.tenant_id = ${tenant} and w.customer_id = ${customerId}::uuid`);
    }
    if (query.sources.includes('submissions')) {
      parts.push(sql`
        select 'submission', s.submitted_at, s.id, w.reference, f.title, null, w.id,
               'submission:' || s.id
          from submissions s
          join work_orders w on w.tenant_id = s.tenant_id and w.id = s.work_order_id
          join forms f on f.tenant_id = s.tenant_id and f.id = s.form_id
         where s.tenant_id = ${tenant} and w.customer_id = ${customerId}::uuid
           and s.submitted_at is not null`);
    }
    if (query.sources.includes('sales')) {
      parts.push(sql`
        select 'quote_issued', q.issued_at, q.id, q.reference, q.title, null, null::uuid,
               'quote_issued:' || q.id
          from crm_quotes q
         where q.tenant_id = ${tenant} and q.customer_id = ${customerId}::uuid and q.issued_at is not null
        union all
        select 'quote_answered', q.answered_at, q.id, q.reference, q.title, q.status, null::uuid,
               'quote_answered:' || q.id
          from crm_quotes q
         where q.tenant_id = ${tenant} and q.customer_id = ${customerId}::uuid and q.answered_at is not null
        union all
        select 'order_confirmed', o.confirmed_at, o.id, o.reference, o.title, null, null::uuid,
               'order_confirmed:' || o.id
          from erp_sales_orders o
         where o.tenant_id = ${tenant} and o.customer_id = ${customerId}::uuid and o.confirmed_at is not null`);
    }
    if (query.sources.includes('finance')) {
      parts.push(sql`
        select 'invoice_issued', i.issued_at, i.id, i.reference, null, i.currency_code, i.work_order_id,
               'invoice_issued:' || i.id
          from erp_invoices i
         where i.tenant_id = ${tenant} and i.customer_id = ${customerId}::uuid and i.issued_at is not null
        union all
        select 'invoice_voided', i.voided_at, i.id, i.reference, null, i.currency_code, i.work_order_id,
               'invoice_voided:' || i.id
          from erp_invoices i
         where i.tenant_id = ${tenant} and i.customer_id = ${customerId}::uuid and i.voided_at is not null
        union all
        select 'payment_received', r.recorded_at, r.id, r.reference, r.payment_reference,
               r.amount::text || ' ' || r.currency_code, null::uuid, 'payment_received:' || r.id
          from erp_payment_receipts r
         where r.tenant_id = ${tenant} and r.customer_id = ${customerId}::uuid`);
    }
    if (parts.length === 0) {
      return { items: [] };
    }
    const unioned = sql.join(parts, sql` union all `);
    const before =
      query.before === undefined
        ? sql`true`
        : sql`(t.at, t.key) < (${query.before.at}::timestamptz, ${query.before.key})`;
    const { rows } = await sql<Row>`
      select t.* from (${unioned}) as t(kind, at, record_id, reference, title, detail, work_order_id, key)
       where ${before}
       order by t.at desc, t.key desc
       limit ${query.limit + 1}
    `.execute(this.db);
    const items = rows.slice(0, query.limit).map((row) => ({
      kind: row.kind,
      at: row.at,
      recordId: row.record_id,
      reference: row.reference,
      title: row.title,
      detail: row.detail,
      workOrderId: row.work_order_id,
      key: row.key,
    }));
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > query.limit && last !== undefined
        ? { next: { at: last.at.toISOString(), key: last.key } }
        : {}),
    };
  }
}
