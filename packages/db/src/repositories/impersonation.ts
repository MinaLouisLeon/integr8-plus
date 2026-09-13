import {
  type PlatformUserId,
  type TenantId,
  type UserId,
  toPlatformUserId,
  toTenantId,
  toUserId,
} from '@integr8/core';
import type { Selectable } from 'kysely';
import {
  type ImpersonationEndReason,
  impersonationEndReasonSchema,
  type ImpersonationGrantsTable,
} from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface ImpersonationGrant {
  id: string;
  tenantId: TenantId;
  platformUserId: PlatformUserId;
  targetUserId: UserId;
  reason: string;
  auditLogId: string;
  createdAt: Date;
  expiresAt: Date;
  endedAt: Date | null;
  endedReason: ImpersonationEndReason | null;
}

export interface CreateImpersonationGrantInput {
  platformUserId: PlatformUserId | string;
  targetUserId: UserId | string;
  reason: string;
  /**
   * The `audit_log` row recording that this was about to happen.
   *
   * Required, and a foreign key. There is no ordering in which a grant exists
   * without its audit entry, because the insert would fail — which is what P03
   * means by "audit entry written before access is granted".
   */
  auditLogId: string;
  expiresAt: Date;
}

/**
 * Super admins acting as somebody else, on record.
 *
 * Three properties, none of which is enforced by convention:
 *
 * - **Time-limited.** `expires_at` is not null and the token minted from a
 *   grant never outlives it.
 * - **Reasoned.** A check constraint requires ten characters. Low bar, high
 *   value: it stops the reflex of typing "test".
 * - **Audited before the fact.** See `auditLogId` above.
 */
export class ImpersonationRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** The one place an `impersonation_grants` read is scoped. */
  #scoped() {
    return this.db
      .selectFrom('impersonation_grants')
      .where('impersonation_grants.tenant_id', '=', this.tenantId);
  }

  async create(input: CreateImpersonationGrantInput): Promise<ImpersonationGrant> {
    const row = await this.db
      .insertInto('impersonation_grants')
      .values({
        tenant_id: this.tenantId,
        platform_user_id: toPlatformUserId(input.platformUserId),
        target_user_id: toUserId(input.targetUserId),
        reason: input.reason.trim(),
        audit_log_id: input.auditLogId,
        expires_at: input.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toDomain(row);
  }

  async findById(grantId: string): Promise<ImpersonationGrant | undefined> {
    const row = await this.#scoped().selectAll().where('id', '=', grantId).executeTakeFirst();
    return row === undefined ? undefined : toDomain(row);
  }

  /**
   * A grant that is still usable right now.
   *
   * Checked on every request made under an impersonation token rather than
   * trusted from the token's own expiry, so that ending a session takes effect
   * immediately instead of when the token happens to lapse.
   */
  async findLive(grantId: string, now: Date = new Date()): Promise<ImpersonationGrant | undefined> {
    const row = await this.#scoped()
      .selectAll()
      .where('id', '=', grantId)
      .where('ended_at', 'is', null)
      .where('expires_at', '>', now)
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  /** Every grant against this company, newest first — what an owner is owed on request. */
  async list(limit = 100): Promise<ImpersonationGrant[]> {
    return (
      await this.#scoped().selectAll().orderBy('created_at', 'desc').limit(limit).execute()
    ).map(toDomain);
  }

  async end(
    grantId: string,
    reason: ImpersonationEndReason,
    at: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('impersonation_grants')
      .set({ ended_at: at, ended_reason: impersonationEndReasonSchema.parse(reason) })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', grantId)
      .where('ended_at', 'is', null)
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }
}

function toDomain(row: Selectable<ImpersonationGrantsTable>): ImpersonationGrant {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    platformUserId: toPlatformUserId(row.platform_user_id),
    targetUserId: toUserId(row.target_user_id),
    reason: row.reason,
    auditLogId: row.audit_log_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
    endedReason:
      row.ended_reason === null ? null : impersonationEndReasonSchema.parse(row.ended_reason),
  };
}
