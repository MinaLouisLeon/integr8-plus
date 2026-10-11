import {
  type OpportunityEventKind,
  type OpportunityStatus,
  type TenantId,
  type UserId,
  toTenantId,
  toUserId,
} from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { CrmOpportunitiesTable, CrmOpportunityEventsTable } from '../schema.js';
import { trimDecimal } from './crm-leads.js';
import type { PipelineStage } from './crm-pipelines.js';
import { prefixQuery } from './customers.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Deals being worked on (CRM/ERP plan, phase C3).
 *
 * An opportunity is for a customer, a lead, or both. Its amount is an estimate
 * in its own currency, kept as a decimal string end to end; winning one books
 * nothing. Edits name the version they read. Every move between stages is a
 * row in `crm_opportunity_events`, written in the same statement batch as the
 * move, and the database checks that the status is the stage's outcome.
 */

export interface Opportunity {
  id: string;
  tenantId: TenantId;
  title: string;
  customerId: string | null;
  leadId: string | null;
  pipelineId: string;
  stageId: string;
  ownerId: UserId | null;
  /** A decimal string without trailing zeros, or null. Never a JavaScript number. */
  amount: string | null;
  currencyCode: string;
  /** `YYYY-MM-DD`, a calendar date with no time zone. */
  expectedCloseDate: string | null;
  probabilityBp: number;
  status: OpportunityStatus;
  lostReason: string | null;
  description: string | null;
  closedAt: Date | null;
  version: number;
  createdBy: UserId;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface OpportunityInput {
  title: string;
  customerId?: string | null;
  leadId?: string | null;
  ownerId?: UserId | string | null;
  amount?: string | null;
  currencyCode?: string;
  expectedCloseDate?: string | null;
  probabilityBp?: number;
  description?: string | null;
}

export interface OpportunityEvent {
  id: string;
  kind: OpportunityEventKind;
  fromStageId: string | null;
  toStageId: string | null;
  fromStatus: OpportunityStatus | null;
  toStatus: OpportunityStatus | null;
  reason: string | null;
  actorId: UserId;
  occurredAt: Date;
}

export interface OpportunityQuery {
  /** Words from the title or description. Prefixes match. */
  text?: string;
  statuses?: readonly OpportunityStatus[];
  stageId?: string;
  /** One member's; `null` for those nobody owns. */
  ownerId?: UserId | string | null;
  customerId?: string;
  leadId?: string;
  includeArchived?: boolean;
  after?: { createdAt: Date; id: string };
  limit?: number;
}

export interface OpportunityPage {
  items: Opportunity[];
  next: { createdAt: Date; id: string } | undefined;
}

export type OpportunityRefusal = 'not_found' | 'version_conflict';

/** Every column, with the close date read as text so no time zone can move it. */
const COLUMNS = [
  'id',
  'tenant_id',
  'title',
  'customer_id',
  'lead_id',
  'pipeline_id',
  'stage_id',
  'owner_id',
  'amount',
  'currency_code',
  sql<string | null>`expected_close_date::text`.as('expected_close_date'),
  'probability_bp',
  'status',
  'lost_reason',
  'description',
  'closed_at',
  'version',
  'created_by',
  'created_at',
  'updated_at',
  'archived_at',
] as const;

type Row = Omit<Selectable<CrmOpportunitiesTable>, 'search'>;

export class CrmOpportunitiesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  #opportunities() {
    return this.db
      .selectFrom('crm_opportunities')
      .where('crm_opportunities.tenant_id', '=', this.tenantId);
  }

  /** A new open opportunity at `stage`, and its first history entry. */
  async create(
    input: OpportunityInput & { currencyCode: string },
    stage: PipelineStage,
    createdBy: UserId | string,
  ): Promise<Opportunity> {
    const row = await this.db
      .insertInto('crm_opportunities')
      .values({
        tenant_id: this.tenantId,
        created_by: toUserId(createdBy),
        ...columns(input),
        title: input.title.trim(),
        currency_code: input.currencyCode,
        pipeline_id: stage.pipelineId,
        stage_id: stage.id,
        status: stage.outcome,
        probability_bp: input.probabilityBp ?? stage.probabilityBp,
        ...(stage.outcome === 'open' ? {} : { closed_at: sql<Date>`now()` }),
      })
      .returning(COLUMNS)
      .executeTakeFirstOrThrow();
    await this.#record(row.id, {
      kind: 'created',
      fromStageId: null,
      toStageId: stage.id,
      fromStatus: null,
      toStatus: stage.outcome,
      reason: null,
      actorId: createdBy,
    });
    return toOpportunity(row);
  }

  async find(opportunityId: string): Promise<Opportunity | undefined> {
    const row = await this.#opportunities()
      .select(COLUMNS)
      .where('id', '=', opportunityId)
      .executeTakeFirst();
    return row === undefined ? undefined : toOpportunity(row);
  }

  async findMany(opportunityIds: readonly string[]): Promise<Opportunity[]> {
    if (opportunityIds.length === 0) {
      return [];
    }
    return (
      await this.#opportunities()
        .select(COLUMNS)
        .where('id', 'in', [...new Set(opportunityIds)])
        .execute()
    ).map(toOpportunity);
  }

  /** Changes the details, provided nobody has changed the opportunity since `expectedVersion`. */
  async update(
    opportunityId: string,
    expectedVersion: number,
    input: Partial<OpportunityInput> & { archived?: boolean },
  ): Promise<Opportunity | OpportunityRefusal> {
    const row = await this.db
      .updateTable('crm_opportunities')
      .set({
        ...columns(input),
        ...(input.archived === undefined
          ? {}
          : { archived_at: input.archived ? sql<Date>`coalesce(archived_at, now())` : null }),
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', opportunityId)
      .where('version', '=', expectedVersion)
      .returning(COLUMNS)
      .executeTakeFirst();
    if (row !== undefined) {
      return toOpportunity(row);
    }
    return (await this.find(opportunityId)) === undefined ? 'not_found' : 'version_conflict';
  }

  /**
   * Moves an opportunity to another stage of its pipeline: its status becomes
   * the stage's outcome, its chance the stage's usual one, and the move is
   * written to its history. Losing keeps the reason; anything else clears it.
   */
  async move(
    opportunityId: string,
    expectedVersion: number,
    move: {
      from: PipelineStage;
      to: PipelineStage;
      kind: OpportunityEventKind;
      lostReason: string | null;
      actorId: UserId | string;
    },
  ): Promise<Opportunity | OpportunityRefusal> {
    const row = await this.db
      .updateTable('crm_opportunities')
      .set({
        stage_id: move.to.id,
        status: move.to.outcome,
        probability_bp: move.to.probabilityBp,
        lost_reason: move.to.outcome === 'lost' ? move.lostReason : null,
        closed_at:
          move.to.outcome === 'open'
            ? null
            : move.from.outcome === move.to.outcome
              ? sql<Date>`closed_at`
              : sql<Date>`now()`,
        version: sql<number>`version + 1`,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', opportunityId)
      .where('version', '=', expectedVersion)
      .where('stage_id', '=', move.from.id)
      .returning(COLUMNS)
      .executeTakeFirst();
    if (row === undefined) {
      return (await this.find(opportunityId)) === undefined ? 'not_found' : 'version_conflict';
    }
    await this.#record(opportunityId, {
      kind: move.kind,
      fromStageId: move.from.id,
      toStageId: move.to.id,
      fromStatus: move.from.outcome,
      toStatus: move.to.outcome,
      reason: move.to.outcome === 'lost' ? move.lostReason : null,
      actorId: move.actorId,
    });
    return toOpportunity(row);
  }

  /**
   * Gives a lead's opportunities the customer the lead became, where they have
   * none yet. Part of converting a lead.
   */
  async attachCustomerForLead(leadId: string, customerId: string): Promise<number> {
    const result = await this.db
      .updateTable('crm_opportunities')
      .set({ customer_id: customerId, version: sql<number>`version + 1` })
      .where('tenant_id', '=', this.tenantId)
      .where('lead_id', '=', leadId)
      .where('customer_id', 'is', null)
      .executeTakeFirst();
    return Number(result.numUpdatedRows);
  }

  /** Newest first, a page at a time. */
  async list(query: OpportunityQuery = {}): Promise<OpportunityPage> {
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    let select = this.#opportunities().select(COLUMNS);

    const words = query.text === undefined ? undefined : prefixQuery(query.text);
    if (words !== undefined) {
      select = select.where(sql<boolean>`search @@ to_tsquery('simple', ${words})`);
    }
    if (query.statuses !== undefined && query.statuses.length > 0) {
      select = select.where('status', 'in', [...query.statuses]);
    }
    if (query.stageId !== undefined) {
      select = select.where('stage_id', '=', query.stageId);
    }
    if (query.ownerId === null) {
      select = select.where('owner_id', 'is', null);
    } else if (query.ownerId !== undefined) {
      select = select.where('owner_id', '=', toUserId(query.ownerId));
    }
    if (query.customerId !== undefined) {
      select = select.where('customer_id', '=', query.customerId);
    }
    if (query.leadId !== undefined) {
      select = select.where('lead_id', '=', query.leadId);
    }
    if (query.includeArchived !== true) {
      select = select.where('archived_at', 'is', null);
    }
    // Millisecond precision, as for leads: a cursor carries a JavaScript date.
    if (query.after !== undefined) {
      select = select.where(
        sql<boolean>`(date_trunc('milliseconds', created_at), id) < (${query.after.createdAt}::timestamptz, ${query.after.id}::uuid)`,
      );
    }

    const rows = await select
      .orderBy(sql`date_trunc('milliseconds', created_at)`, 'desc')
      .orderBy('id', 'desc')
      .limit(limit + 1)
      .execute();
    const items = rows.slice(0, limit).map(toOpportunity);
    const last = items.at(-1);
    return {
      items,
      next:
        rows.length > limit && last !== undefined
          ? { createdAt: last.createdAt, id: last.id }
          : undefined,
    };
  }

  /** An opportunity's history, newest first. */
  async events(opportunityId: string, limit = 100): Promise<OpportunityEvent[]> {
    return (
      await this.db
        .selectFrom('crm_opportunity_events')
        .selectAll()
        .where('tenant_id', '=', this.tenantId)
        .where('opportunity_id', '=', opportunityId)
        .orderBy('occurred_at', 'desc')
        .orderBy('id', 'desc')
        .limit(Math.min(Math.max(limit, 1), 500))
        .execute()
    ).map(toEvent);
  }

  async #record(
    opportunityId: string,
    event: Omit<OpportunityEvent, 'id' | 'occurredAt' | 'actorId'> & { actorId: UserId | string },
  ): Promise<void> {
    await this.db
      .insertInto('crm_opportunity_events')
      .values({
        tenant_id: this.tenantId,
        opportunity_id: opportunityId,
        kind: event.kind,
        from_stage_id: event.fromStageId,
        to_stage_id: event.toStageId,
        from_status: event.fromStatus,
        to_status: event.toStatus,
        reason: event.reason,
        actor_id: toUserId(event.actorId),
      })
      .execute();
  }
}

function blankToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function columns(input: Partial<OpportunityInput>) {
  return {
    ...(input.title === undefined ? {} : { title: input.title.trim() }),
    ...(input.customerId === undefined ? {} : { customer_id: input.customerId }),
    ...(input.leadId === undefined ? {} : { lead_id: input.leadId }),
    ...(input.ownerId === undefined
      ? {}
      : { owner_id: input.ownerId === null ? null : toUserId(input.ownerId) }),
    ...(input.amount === undefined ? {} : { amount: blankToNull(input.amount) }),
    ...(input.currencyCode === undefined
      ? {}
      : { currency_code: input.currencyCode.trim().toUpperCase() }),
    ...(input.expectedCloseDate === undefined
      ? {}
      : { expected_close_date: input.expectedCloseDate }),
    ...(input.probabilityBp === undefined ? {} : { probability_bp: input.probabilityBp }),
    ...(input.description === undefined ? {} : { description: blankToNull(input.description) }),
  };
}

function toOpportunity(row: Row): Opportunity {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    title: row.title,
    customerId: row.customer_id,
    leadId: row.lead_id,
    pipelineId: row.pipeline_id,
    stageId: row.stage_id,
    ownerId: row.owner_id === null ? null : toUserId(row.owner_id),
    amount: row.amount === null ? null : trimDecimal(row.amount),
    currencyCode: row.currency_code,
    expectedCloseDate: row.expected_close_date,
    probabilityBp: row.probability_bp,
    status: row.status,
    lostReason: row.lost_reason,
    description: row.description,
    closedAt: row.closed_at,
    version: row.version,
    createdBy: toUserId(row.created_by),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function toEvent(row: Selectable<CrmOpportunityEventsTable>): OpportunityEvent {
  return {
    id: row.id,
    kind: row.kind,
    fromStageId: row.from_stage_id,
    toStageId: row.to_stage_id,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    reason: row.reason,
    actorId: toUserId(row.actor_id),
    occurredAt: row.occurred_at,
  };
}
