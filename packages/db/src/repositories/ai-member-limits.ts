import { type UserId, toUserId } from '@integr8/core';
import { type Selectable, sql } from 'kysely';
import type { AiMemberLimitsTable } from '../schema.js';
import { micros } from './ai-usage.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Each member's share of the company's assistant allowance, and the dollar
 * cap the platform may put on them (docs/ai/ADR-0002 D6, D7).
 *
 * A share is a whole percentage of every company allowance, reserved for that
 * member: across a company they total 100 or less. The check and the write
 * happen under one lock per company, taken with a transaction-scoped advisory
 * lock, so two owners saving at once cannot together pass 100. A member with
 * no share has no assistant; removing a member removes their row with them.
 */

export interface AiMemberLimits {
  userId: UserId;
  /** 1–100, or null: no share and so no assistant. */
  sharePercent: number | null;
  /** Set by the platform only; never shown to the company. */
  monthlyCostCapMicrousd: number | null;
  version: number;
  updatedAt: Date;
  updatedBy: string | null;
}

/** The row changed since it was read. */
export class AiMemberLimitsVersionConflictError extends Error {
  constructor(readonly currentVersion: number | null) {
    super('The member’s assistant limits changed since they were read.');
    this.name = 'AiMemberLimitsVersionConflictError';
  }
}

/** The company's shares would total more than 100%. */
export class AiSharesOverTotalError extends Error {
  constructor(readonly availablePercent: number) {
    super(`Only ${String(availablePercent)}% of the company's allowance is unassigned.`);
    this.name = 'AiSharesOverTotalError';
  }
}

export class AiMemberLimitsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async find(userId: UserId | string): Promise<AiMemberLimits | undefined> {
    const row = await this.db
      .selectFrom('ai_member_limits')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('user_id', '=', toUserId(userId))
      .executeTakeFirst();
    return row === undefined ? undefined : toLimits(row);
  }

  async list(): Promise<AiMemberLimits[]> {
    const rows = await this.db
      .selectFrom('ai_member_limits')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .orderBy('user_id')
      .execute();
    return rows.map(toLimits);
  }

  /** The company's shares added up: what is assigned of its 100%. */
  async assignedPercent(): Promise<number> {
    const row = await this.db
      .selectFrom('ai_member_limits')
      .select(sql<string | null>`sum(share_percent)`.as('total'))
      .where('tenant_id', '=', this.tenantId)
      .executeTakeFirst();
    return Number(row?.total ?? 0);
  }

  /**
   * Sets a member's share, their dollar cap, or both. A field left undefined
   * keeps its value. `expectedVersion` is the version last read, or null when
   * the member had no row; anything else is refused with the current one.
   */
  async set(input: {
    userId: UserId | string;
    sharePercent?: number | null;
    monthlyCostCapMicrousd?: number | null;
    expectedVersion: number | null;
    updatedBy: string | null;
  }): Promise<AiMemberLimits> {
    const userId = toUserId(input.userId);
    // One writer per company at a time: the shares are checked as a whole.
    await sql`select pg_advisory_xact_lock(hashtextextended(${`ai_member_limits:${this.tenantId}`}, 0))`.execute(
      this.db,
    );

    const current = await this.db
      .selectFrom('ai_member_limits')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .where('user_id', '=', userId)
      .forUpdate()
      .executeTakeFirst();
    if ((current?.version ?? null) !== input.expectedVersion) {
      throw new AiMemberLimitsVersionConflictError(current?.version ?? null);
    }

    const sharePercent =
      input.sharePercent === undefined ? (current?.share_percent ?? null) : input.sharePercent;
    const monthlyCostCapMicrousd =
      input.monthlyCostCapMicrousd === undefined
        ? current?.monthly_cost_cap_microusd === null || current === undefined
          ? null
          : micros(current.monthly_cost_cap_microusd)
        : input.monthlyCostCapMicrousd;

    if (sharePercent !== null) {
      const others = await this.db
        .selectFrom('ai_member_limits')
        .select(sql<string | null>`sum(share_percent)`.as('total'))
        .where('tenant_id', '=', this.tenantId)
        .where('user_id', '<>', userId)
        .executeTakeFirst();
      const assigned = Number(others?.total ?? 0);
      if (assigned + sharePercent > 100) {
        throw new AiSharesOverTotalError(Math.max(0, 100 - assigned));
      }
    }

    const row =
      current === undefined
        ? await this.db
            .insertInto('ai_member_limits')
            .values({
              tenant_id: this.tenantId,
              user_id: userId,
              share_percent: sharePercent,
              monthly_cost_cap_microusd: monthlyCostCapMicrousd,
              updated_by: input.updatedBy,
            })
            .returningAll()
            .executeTakeFirstOrThrow()
        : await this.db
            .updateTable('ai_member_limits')
            .set((eb) => ({
              share_percent: sharePercent,
              monthly_cost_cap_microusd: monthlyCostCapMicrousd,
              version: eb('version', '+', 1),
              updated_by: input.updatedBy,
              updated_at: sql`now()`,
            }))
            .where('tenant_id', '=', this.tenantId)
            .where('user_id', '=', userId)
            .returningAll()
            .executeTakeFirstOrThrow();
    return toLimits(row);
  }
}

function toLimits(row: Selectable<AiMemberLimitsTable>): AiMemberLimits {
  return {
    userId: toUserId(row.user_id),
    sharePercent: row.share_percent,
    monthlyCostCapMicrousd:
      row.monthly_cost_cap_microusd === null ? null : micros(row.monthly_cost_cap_microusd),
    version: row.version,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}
