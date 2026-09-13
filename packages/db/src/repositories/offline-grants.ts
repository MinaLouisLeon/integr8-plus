import { type TenantId, type UserId, toTenantId, toUserId } from '@integr8/core';
import type { Selectable } from 'kysely';
import {
  type OfflineGrantRevocationReason,
  offlineGrantRevocationReasonSchema,
  type OfflineGrantsTable,
} from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface OfflineGrant {
  id: string;
  tenantId: TenantId;
  sessionId: string;
  userId: UserId;
  deviceLabel: string | null;
  issuedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: OfflineGrantRevocationReason | null;
}

export interface CreateOfflineGrantInput {
  sessionId: string;
  userId: UserId | string;
  expiresAt: Date;
  deviceLabel?: string | null;
}

/**
 * The record behind a grant that lets the mobile app open with no network.
 *
 * The grant a phone holds is a signed token it verifies locally; this row is
 * not consulted when the phone is offline, and cannot be. What it is for is
 * revocation — and revoking one only takes effect the next time that device has
 * signal.
 *
 * That gap is not a defect to be engineered away; it is the price of working in
 * a basement, and it is why the lifetime is a configured number rather than a
 * constant. The reasoning is written up in docs/auth/offline-access.md.
 */
export class OfflineGrantsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** The one place an `offline_grants` read is scoped. */
  #scoped() {
    return this.db
      .selectFrom('offline_grants')
      .where('offline_grants.tenant_id', '=', this.tenantId);
  }

  async create(input: CreateOfflineGrantInput): Promise<OfflineGrant> {
    const row = await this.db
      .insertInto('offline_grants')
      .values({
        tenant_id: this.tenantId,
        session_id: input.sessionId,
        user_id: toUserId(input.userId),
        device_label: input.deviceLabel ?? null,
        expires_at: input.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toDomain(row);
  }

  async findById(grantId: string): Promise<OfflineGrant | undefined> {
    const row = await this.#scoped().selectAll().where('id', '=', grantId).executeTakeFirst();
    return row === undefined ? undefined : toDomain(row);
  }

  /** Live grants for one person: the list a phone-loss conversation works from. */
  async listLiveForUser(userId: UserId | string, now: Date = new Date()): Promise<OfflineGrant[]> {
    return (
      await this.#scoped()
        .selectAll()
        .where('user_id', '=', toUserId(userId))
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', now)
        .orderBy('issued_at', 'desc')
        .execute()
    ).map(toDomain);
  }

  async revoke(
    grantId: string,
    reason: OfflineGrantRevocationReason,
    at: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('offline_grants')
      .set({ revoked_at: at, revoked_reason: offlineGrantRevocationReasonSchema.parse(reason) })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', grantId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  /**
   * Revokes every grant tied to a session.
   *
   * Called whenever a session is revoked. Without it, revoking a session would
   * log the device out of the API while leaving it able to open and work
   * offline for another week — the exact opposite of what "revoke" means to
   * the admin who clicked it.
   */
  async revokeForSession(
    sessionId: string,
    reason: OfflineGrantRevocationReason = 'session_revoked',
    at: Date = new Date(),
  ): Promise<number> {
    const result = await this.db
      .updateTable('offline_grants')
      .set({ revoked_at: at, revoked_reason: offlineGrantRevocationReasonSchema.parse(reason) })
      .where('tenant_id', '=', this.tenantId)
      .where('session_id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows ?? 0n);
  }
}

function toDomain(row: Selectable<OfflineGrantsTable>): OfflineGrant {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    sessionId: row.session_id,
    userId: toUserId(row.user_id),
    deviceLabel: row.device_label,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason:
      row.revoked_reason === null
        ? null
        : offlineGrantRevocationReasonSchema.parse(row.revoked_reason),
  };
}
