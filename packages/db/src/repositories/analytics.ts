import { sql } from 'kysely';
import { trimDecimal } from './crm-leads.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Sales, pipeline and parts figures (eighth round; ADR-0012). Read-only and
 * computed on request from the documents and their history; nothing is
 * stored. Amounts stay in their own currency: figures in different
 * currencies are never added together.
 */

export interface QuoteFigures {
  /** Who issued them; null for all together. */
  issuedBy: string | null;
  issued: number;
  accepted: number;
  declined: number;
  expired: number;
  /** Still waiting for an answer and not past their date. */
  open: number;
  /** Median whole days from issue to acceptance, or null with none accepted. */
  medianDaysToAccept: number | null;
}

export interface PipelineFigures {
  /** The grouping's value: a lead source, an owner, a stage key; null for all together. */
  group: string | null;
  won: number;
  lost: number;
  /** Median whole days from created to closed, over won and lost. */
  medianDaysToClose: number | null;
}

export interface StageValue {
  monthEnd: string;
  stageId: string;
  currency: string;
  count: number;
  amount: string;
  /** The amount times the stage's usual chance. */
  weighted: string;
}

export interface PartsUsage {
  group: string;
  /** The engineer's, customer's or job type's name. */
  label: string;
  /** Part lines used, after returns. */
  lines: number;
  /** Their value at the cost recorded when used. */
  value: string;
}

/** The most rows one export holds; past it the export says it was cut short. */
export const EXPORT_LIMIT = 50_000;

/** Dates are calendar days, inclusive, in `YYYY-MM-DD`. */
export interface ExportFilter {
  from?: string | undefined;
  to?: string | undefined;
  includeArchived?: boolean | undefined;
}

export interface ExportPage<T> {
  rows: T[];
  /** More rows matched than one export holds. */
  truncated: boolean;
}

export interface LeadRow {
  id: string;
  name: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  source: string;
  status: string;
  assignedTo: string | null;
  estimatedValue: string | null;
  currencyCode: string | null;
  createdAt: Date;
  convertedAt: Date | null;
  archivedAt: Date | null;
}

export interface OpportunityRow {
  id: string;
  title: string;
  customer: string | null;
  pipeline: string;
  stageKey: string;
  stage: string;
  status: string;
  owner: string | null;
  amount: string | null;
  currencyCode: string;
  probabilityBp: number;
  expectedCloseDate: string | null;
  lostReason: string | null;
  createdAt: Date;
  closedAt: Date | null;
}

export interface MovementRow {
  id: string;
  occurredAt: Date;
  sku: string;
  item: string;
  unit: string;
  location: string;
  kind: string;
  quantity: string;
  unitCost: string | null;
  reason: string | null;
  actor: string | null;
}

export class AnalyticsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /**
   * Quotes issued between two days: how many were accepted (or became an
   * order), declined, expired unanswered, or still open, overall and by who
   * issued them. Revisions count as quotes of their own.
   */
  async quoteFigures(from: string, to: string, today: string): Promise<QuoteFigures[]> {
    const { rows } = await sql<{
      issued_by: string | null;
      issued: number;
      accepted: number;
      declined: number;
      expired: number;
      open: number;
      median_days: number | null;
    }>`
      with issued as (
        select q.issued_by, q.status, q.valid_until, q.issued_at, q.answered_at
          from crm_quotes q
         where q.tenant_id = ${this.tenantId} and q.issued_at is not null
           and q.issued_at::date between ${from}::date and ${to}::date
      )
      select issued_by,
             count(*)::int as issued,
             count(*) filter (where status in ('accepted', 'converted'))::int as accepted,
             count(*) filter (where status = 'rejected')::int as declined,
             count(*) filter (where status = 'issued' and valid_until < ${today}::date)::int as expired,
             count(*) filter (where status = 'issued' and (valid_until is null or valid_until >= ${today}::date))::int as open,
             (percentile_disc(0.5) within group (order by
                extract(epoch from (answered_at - issued_at)) / 86400)
                filter (where status in ('accepted', 'converted') and answered_at is not null))::int as median_days
        from issued
       group by grouping sets ((issued_by), ())
       order by issued_by nulls first
    `.execute(this.db);
    return rows.map((row) => ({
      issuedBy: row.issued_by,
      issued: row.issued,
      accepted: row.accepted,
      declined: row.declined,
      expired: row.expired,
      open: row.open,
      medianDaysToAccept: row.median_days,
    }));
  }

  /**
   * Opportunities closed between two days, won and lost, overall and by the
   * source of the lead they came from, by owner, or by the furthest stage
   * they reached before closing.
   */
  async pipelineFigures(
    from: string,
    to: string,
    groupBy: 'source' | 'owner' | 'stage',
  ): Promise<PipelineFigures[]> {
    const group =
      groupBy === 'source'
        ? sql`coalesce(l.source, 'none')`
        : groupBy === 'owner'
          ? sql`coalesce(o.owner_id::text, 'none')`
          : sql`coalesce((
              select s.key from crm_opportunity_events e
                join crm_pipeline_stages s on s.tenant_id = e.tenant_id and s.id = e.to_stage_id
               where e.tenant_id = o.tenant_id and e.opportunity_id = o.id and s.outcome = 'open'
               order by s.position desc limit 1), 'none')`;
    const { rows } = await sql<{
      grp: string | null;
      won: number;
      lost: number;
      median_days: number | null;
    }>`
      with closed as (
        select ${group} as grp, o.status, o.created_at, o.closed_at
          from crm_opportunities o
          left join crm_leads l on l.tenant_id = o.tenant_id and l.id = o.lead_id
         where o.tenant_id = ${this.tenantId} and o.status in ('won', 'lost')
           and o.closed_at::date between ${from}::date and ${to}::date
      )
      select grp,
             count(*) filter (where status = 'won')::int as won,
             count(*) filter (where status = 'lost')::int as lost,
             (percentile_disc(0.5) within group (order by
                extract(epoch from (closed_at - created_at)) / 86400))::int as median_days
        from closed
       group by grouping sets ((grp), ())
       order by grp nulls first
    `.execute(this.db);
    return rows.map((row) => ({
      group: row.grp,
      won: row.won,
      lost: row.lost,
      medianDaysToClose: row.median_days,
    }));
  }

  /**
   * At each month's end, the open opportunities in each stage of a pipeline,
   * where their history put them then, with their amount and the amount
   * weighted by the stage's usual chance. Amounts are today's: changes to an
   * amount are not kept in the history.
   */
  async stageValues(pipelineId: string, monthEnds: readonly string[]): Promise<StageValue[]> {
    if (monthEnds.length === 0) {
      return [];
    }
    const results: StageValue[] = [];
    for (const monthEnd of monthEnds) {
      const { rows: month } = await sql<{
        stage_id: string;
        currency: string;
        count: number;
        amount: string;
        weighted: string;
      }>`
        with placed as (
          select o.id, o.currency_code, coalesce(o.amount, 0) as amount,
                 (select e.to_stage_id from crm_opportunity_events e
                   where e.tenant_id = o.tenant_id and e.opportunity_id = o.id
                     and e.occurred_at < (${monthEnd}::date + 1)
                   order by e.occurred_at desc, e.id desc limit 1) as stage_id
            from crm_opportunities o
           where o.tenant_id = ${this.tenantId} and o.pipeline_id = ${pipelineId}::uuid
             and o.created_at < (${monthEnd}::date + 1)
        )
        select p.stage_id, p.currency_code as currency, count(*)::int as count,
               sum(p.amount)::text as amount,
               round(sum(p.amount * s.probability_bp / 10000.0), 4)::text as weighted
          from placed p
          join crm_pipeline_stages s on s.tenant_id = ${this.tenantId} and s.id = p.stage_id
         where s.outcome = 'open'
         group by p.stage_id, p.currency_code
      `.execute(this.db);
      results.push(
        ...month.map((row) => ({
          monthEnd,
          stageId: row.stage_id,
          currency: row.currency,
          count: row.count,
          amount: trimDecimal(row.amount),
          weighted: trimDecimal(row.weighted),
        })),
      );
    }
    return results;
  }

  /**
   * Parts used on jobs between two days, by the engineer who recorded them,
   * the customer, or the job type: lines and their value at the cost
   * recorded, net of returns, and parts bought from a merchant at what was
   * paid. Cancelled lines are left out.
   */
  async partsUsage(
    from: string,
    to: string,
    groupBy: 'engineer' | 'customer' | 'job_type',
  ): Promise<PartsUsage[]> {
    const group =
      groupBy === 'engineer'
        ? sql`m.recorded_by::text`
        : groupBy === 'customer'
          ? sql`w.customer_id::text`
          : sql`w.job_type_id::text`;
    const label =
      groupBy === 'engineer'
        ? sql`coalesce((select u.display_name from tenant_users u where u.tenant_id = m.tenant_id and u.user_id = m.recorded_by), '')`
        : groupBy === 'customer'
          ? sql`coalesce((select c.name from customers c where c.tenant_id = w.tenant_id and c.id = w.customer_id), '')`
          : sql`coalesce((select j.name from job_types j where j.tenant_id = w.tenant_id and j.id = w.job_type_id), '')`;
    const { rows } = await sql<{ grp: string; label: string; lines: number; value: string }>`
      select ${group} as grp, min(${label}) as label, count(*)::int as lines,
             coalesce(sum(round(m.used * m.cost, 4)), 0)::text as value
        from (
          select tenant_id, work_order_id, recorded_by, occurred_at,
                 quantity - returned_quantity as used, coalesce(unit_cost, 0) as cost
            from erp_work_order_materials
           where tenant_id = ${this.tenantId} and status = 'posted'
          union all
          -- Bought from a merchant for the job, at what was paid (ADR-0012).
          select tenant_id, work_order_id, recorded_by, occurred_at, quantity, unit_price
            from erp_work_order_purchases
           where tenant_id = ${this.tenantId} and cancelled_at is null
        ) m
        join work_orders w on w.tenant_id = m.tenant_id and w.id = m.work_order_id
       where m.occurred_at::date between ${from}::date and ${to}::date
       group by 1
       order by 4 desc, 2
    `.execute(this.db);
    return rows.map((row) => ({
      group: row.grp,
      label: row.label,
      lines: row.lines,
      value: trimDecimal(row.value),
    }));
  }

  /** Leads for a CSV export, oldest first, with who they are assigned to. */
  async leadRows(
    filter: ExportFilter & { statuses?: readonly string[]; sources?: readonly string[] },
  ): Promise<ExportPage<LeadRow>> {
    let select = this.db
      .selectFrom('crm_leads as l')
      .leftJoin('tenant_users as u', (join) =>
        join.onRef('u.tenant_id', '=', 'l.tenant_id').onRef('u.user_id', '=', 'l.assigned_to'),
      )
      .select([
        'l.id',
        'l.display_name as name',
        'l.company_name as company',
        'l.email',
        'l.phone',
        'l.source',
        'l.status',
        'u.display_name as assigned_to',
        'l.estimated_value',
        'l.currency_code',
        'l.created_at',
        'l.converted_at',
        'l.archived_at',
      ])
      .where('l.tenant_id', '=', this.tenantId);
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      select = select.where(sql<boolean>`l.status = any(${[...filter.statuses]}::text[])`);
    }
    if (filter.sources !== undefined && filter.sources.length > 0) {
      select = select.where(sql<boolean>`l.source = any(${[...filter.sources]}::text[])`);
    }
    if (filter.from !== undefined) {
      select = select.where(sql<boolean>`l.created_at::date >= ${filter.from}::date`);
    }
    if (filter.to !== undefined) {
      select = select.where(sql<boolean>`l.created_at::date <= ${filter.to}::date`);
    }
    if (filter.includeArchived !== true) {
      select = select.where('l.archived_at', 'is', null);
    }
    const rows = await select
      .orderBy('l.created_at')
      .orderBy('l.id')
      .limit(EXPORT_LIMIT + 1)
      .execute();
    return {
      truncated: rows.length > EXPORT_LIMIT,
      rows: rows.slice(0, EXPORT_LIMIT).map((row) => ({
        id: row.id,
        name: row.name,
        company: row.company,
        email: row.email,
        phone: row.phone,
        source: row.source,
        status: row.status,
        assignedTo: row.assigned_to,
        estimatedValue: row.estimated_value === null ? null : trimDecimal(row.estimated_value),
        currencyCode: row.currency_code,
        createdAt: row.created_at,
        convertedAt: row.converted_at,
        archivedAt: row.archived_at,
      })),
    };
  }

  /** Opportunities for a CSV export, oldest first, with their pipeline, stage, customer and owner. */
  async opportunityRows(
    filter: ExportFilter & { pipelineId?: string; statuses?: readonly string[] },
  ): Promise<ExportPage<OpportunityRow>> {
    let select = this.db
      .selectFrom('crm_opportunities as o')
      .innerJoin('crm_pipelines as p', (join) =>
        join.onRef('p.tenant_id', '=', 'o.tenant_id').onRef('p.id', '=', 'o.pipeline_id'),
      )
      .innerJoin('crm_pipeline_stages as s', (join) =>
        join.onRef('s.tenant_id', '=', 'o.tenant_id').onRef('s.id', '=', 'o.stage_id'),
      )
      .leftJoin('customers as c', (join) =>
        join.onRef('c.tenant_id', '=', 'o.tenant_id').onRef('c.id', '=', 'o.customer_id'),
      )
      .leftJoin('tenant_users as u', (join) =>
        join.onRef('u.tenant_id', '=', 'o.tenant_id').onRef('u.user_id', '=', 'o.owner_id'),
      )
      .select([
        'o.id',
        'o.title',
        'c.name as customer',
        'p.name as pipeline',
        's.key as stage_key',
        's.label as stage',
        'o.status',
        'u.display_name as owner',
        'o.amount',
        'o.currency_code',
        'o.probability_bp',
        sql<string | null>`o.expected_close_date::text`.as('expected_close_date'),
        'o.lost_reason',
        'o.created_at',
        'o.closed_at',
      ])
      .where('o.tenant_id', '=', this.tenantId);
    if (filter.pipelineId !== undefined) {
      select = select.where('o.pipeline_id', '=', filter.pipelineId);
    }
    if (filter.statuses !== undefined && filter.statuses.length > 0) {
      select = select.where(sql<boolean>`o.status = any(${[...filter.statuses]}::text[])`);
    }
    if (filter.from !== undefined) {
      select = select.where(sql<boolean>`o.created_at::date >= ${filter.from}::date`);
    }
    if (filter.to !== undefined) {
      select = select.where(sql<boolean>`o.created_at::date <= ${filter.to}::date`);
    }
    if (filter.includeArchived !== true) {
      select = select.where('o.archived_at', 'is', null);
    }
    const rows = await select
      .orderBy('o.created_at')
      .orderBy('o.id')
      .limit(EXPORT_LIMIT + 1)
      .execute();
    return {
      truncated: rows.length > EXPORT_LIMIT,
      rows: rows.slice(0, EXPORT_LIMIT).map((row) => ({
        id: row.id,
        title: row.title,
        customer: row.customer,
        pipeline: row.pipeline,
        stageKey: row.stage_key,
        stage: row.stage,
        status: row.status,
        owner: row.owner,
        amount: row.amount === null ? null : trimDecimal(row.amount),
        currencyCode: row.currency_code,
        probabilityBp: row.probability_bp,
        expectedCloseDate: row.expected_close_date,
        lostReason: row.lost_reason,
        createdAt: row.created_at,
        closedAt: row.closed_at,
      })),
    };
  }

  /** Stock movements for a CSV export, oldest first, with the item, place and who. */
  async movementRows(
    filter: ExportFilter & { itemId?: string; locationId?: string; kinds?: readonly string[] },
  ): Promise<ExportPage<MovementRow>> {
    let select = this.db
      .selectFrom('erp_stock_movements as m')
      .innerJoin('erp_items as i', (join) =>
        join.onRef('i.tenant_id', '=', 'm.tenant_id').onRef('i.id', '=', 'm.item_id'),
      )
      .innerJoin('erp_stock_locations as l', (join) =>
        join.onRef('l.tenant_id', '=', 'm.tenant_id').onRef('l.id', '=', 'm.location_id'),
      )
      .leftJoin('tenant_users as u', (join) =>
        join.onRef('u.tenant_id', '=', 'm.tenant_id').onRef('u.user_id', '=', 'm.actor_id'),
      )
      .select([
        'm.id',
        'm.occurred_at',
        'i.sku',
        'i.name as item',
        'i.unit',
        'l.name as location',
        'm.kind',
        'm.quantity',
        'm.unit_cost',
        'm.reason',
        'u.display_name as actor',
      ])
      .where('m.tenant_id', '=', this.tenantId);
    if (filter.itemId !== undefined) {
      select = select.where('m.item_id', '=', filter.itemId);
    }
    if (filter.locationId !== undefined) {
      select = select.where('m.location_id', '=', filter.locationId);
    }
    if (filter.kinds !== undefined && filter.kinds.length > 0) {
      select = select.where(sql<boolean>`m.kind = any(${[...filter.kinds]}::text[])`);
    }
    if (filter.from !== undefined) {
      select = select.where(sql<boolean>`m.occurred_at::date >= ${filter.from}::date`);
    }
    if (filter.to !== undefined) {
      select = select.where(sql<boolean>`m.occurred_at::date <= ${filter.to}::date`);
    }
    const rows = await select
      .orderBy('m.occurred_at')
      .orderBy('m.id')
      .limit(EXPORT_LIMIT + 1)
      .execute();
    return {
      truncated: rows.length > EXPORT_LIMIT,
      rows: rows.slice(0, EXPORT_LIMIT).map((row) => ({
        id: row.id,
        occurredAt: row.occurred_at,
        sku: row.sku,
        item: row.item,
        unit: row.unit,
        location: row.location,
        kind: row.kind,
        quantity: trimDecimal(row.quantity),
        unitCost: row.unit_cost === null ? null : trimDecimal(row.unit_cost),
        reason: row.reason,
        actor: row.actor,
      })),
    };
  }
}
