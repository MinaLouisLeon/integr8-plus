import type { LeadStatus } from '@integr8/core';
import { sql } from 'kysely';
import { trimDecimal } from './crm-leads.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * The CRM dashboard's figures (CRM/ERP plan, phase C3), read as the company.
 *
 * Amounts are summed in the database as `numeric` and come back as decimal
 * strings, one total per currency: nothing adds EGP to USD, and nothing passes
 * through a float. A "weighted" total is each open amount times its chance of
 * winning — a forecast, not revenue.
 */

export interface CurrencyTotal {
  currencyCode: string;
  /** A decimal string. */
  total: string;
  /** A decimal string: the total weighted by each opportunity's chance. */
  weighted: string;
  count: number;
}

export interface StageSummary {
  stageId: string;
  count: number;
  totals: CurrencyTotal[];
}

export interface CrmDashboard {
  leadsByStatus: Record<LeadStatus, number>;
  openByStage: StageSummary[];
  openTotals: CurrencyTotal[];
  wonSince: CurrencyTotal[];
  lostSinceCount: number;
}

export class CrmReportsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** Lead counts, the open pipeline by stage and currency, and wins and losses since `since`. */
  async dashboard(since: Date): Promise<CrmDashboard> {
    const leads = await this.db
      .selectFrom('crm_leads')
      .select(['status', sql<string>`count(*)`.as('count')])
      .where('tenant_id', '=', this.tenantId)
      .where('archived_at', 'is', null)
      .groupBy('status')
      .execute();
    const leadsByStatus: Record<LeadStatus, number> = {
      new: 0,
      contacted: 0,
      qualified: 0,
      unqualified: 0,
      converted: 0,
    };
    for (const row of leads) {
      leadsByStatus[row.status] = Number(row.count);
    }

    const open = await this.db
      .selectFrom('crm_opportunities')
      .select([
        'stage_id',
        'currency_code',
        sql<string>`count(*)`.as('count'),
        sql<string>`coalesce(sum(amount), 0)::text`.as('total'),
        sql<string>`round(coalesce(sum(amount * probability_bp / 10000.0), 0), 4)::text`.as(
          'weighted',
        ),
      ])
      .where('tenant_id', '=', this.tenantId)
      .where('status', '=', 'open')
      .where('archived_at', 'is', null)
      .groupBy(['stage_id', 'currency_code'])
      .orderBy('currency_code')
      .execute();

    const byStage = new Map<string, StageSummary>();
    for (const row of open) {
      const total: CurrencyTotal = {
        currencyCode: row.currency_code,
        total: trimDecimal(row.total),
        weighted: trimDecimal(row.weighted),
        count: Number(row.count),
      };
      const stage = byStage.get(row.stage_id) ?? { stageId: row.stage_id, count: 0, totals: [] };
      stage.count += total.count;
      stage.totals.push(total);
      byStage.set(row.stage_id, stage);
    }

    // Per-currency totals across stages, summed by the database too.
    const openTotals = await this.db
      .selectFrom('crm_opportunities')
      .select([
        'currency_code',
        sql<string>`count(*)`.as('count'),
        sql<string>`coalesce(sum(amount), 0)::text`.as('total'),
        sql<string>`round(coalesce(sum(amount * probability_bp / 10000.0), 0), 4)::text`.as(
          'weighted',
        ),
      ])
      .where('tenant_id', '=', this.tenantId)
      .where('status', '=', 'open')
      .where('archived_at', 'is', null)
      .groupBy('currency_code')
      .orderBy('currency_code')
      .execute();

    const won = await this.db
      .selectFrom('crm_opportunities')
      .select([
        'currency_code',
        sql<string>`count(*)`.as('count'),
        sql<string>`coalesce(sum(amount), 0)::text`.as('total'),
      ])
      .where('tenant_id', '=', this.tenantId)
      .where('status', '=', 'won')
      .where('closed_at', '>=', since)
      .groupBy('currency_code')
      .orderBy('currency_code')
      .execute();

    const lost = await this.db
      .selectFrom('crm_opportunities')
      .select(sql<string>`count(*)`.as('count'))
      .where('tenant_id', '=', this.tenantId)
      .where('status', '=', 'lost')
      .where('closed_at', '>=', since)
      .executeTakeFirstOrThrow();

    return {
      leadsByStatus,
      openByStage: [...byStage.values()],
      openTotals: openTotals.map((row) => ({
        currencyCode: row.currency_code,
        total: trimDecimal(row.total),
        weighted: trimDecimal(row.weighted),
        count: Number(row.count),
      })),
      wonSince: won.map((row) => ({
        currencyCode: row.currency_code,
        total: trimDecimal(row.total),
        weighted: trimDecimal(row.total),
        count: Number(row.count),
      })),
      lostSinceCount: Number(lost.count),
    };
  }
}
