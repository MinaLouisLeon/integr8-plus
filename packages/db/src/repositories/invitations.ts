import {
  type Role,
  roleSchema,
  type TenantId,
  type UserId,
  toTenantId,
  toUserId,
} from '@integr8/core';
import type { Selectable } from 'kysely';
import type { InvitationsTable } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface Invitation {
  id: string;
  tenantId: TenantId;
  email: string;
  role: Role;
  invitedByUserId: UserId;
  createdAt: Date;
  expiresAt: Date;
  acceptedAt: Date | null;
  acceptedUserId: UserId | null;
  revokedAt: Date | null;
  revokedByUserId: UserId | null;
}

export interface CreateInvitationInput {
  email: string;
  role: Role;
  invitedByUserId: UserId | string;
  tokenHash: string;
  expiresAt: Date;
}

/**
 * Pending memberships.
 *
 * The emailed token is stored only as a SHA-256 hash, so a database dump is not
 * a set of live invitations to somebody else's company. The plaintext exists
 * once, in the email, and is never recoverable from here.
 *
 * A partial unique index in migration 0003 allows one live invitation per
 * address per company, so re-inviting somebody replaces rather than
 * accumulates and "revoke the invitation" is unambiguous.
 */
export class InvitationsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** The one place an `invitations` read is scoped. */
  #scoped() {
    return this.db.selectFrom('invitations').where('invitations.tenant_id', '=', this.tenantId);
  }

  async create(input: CreateInvitationInput): Promise<Invitation> {
    const row = await this.db
      .insertInto('invitations')
      .values({
        tenant_id: this.tenantId,
        email: input.email.trim().toLowerCase(),
        role: roleSchema.parse(input.role),
        token_hash: input.tokenHash,
        invited_by_user_id: toUserId(input.invitedByUserId),
        expires_at: input.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toDomain(row);
  }

  async findByTokenHash(tokenHash: string): Promise<Invitation | undefined> {
    const row = await this.#scoped()
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  async findLiveByEmail(email: string): Promise<Invitation | undefined> {
    const row = await this.#scoped()
      .selectAll()
      .where('email', '=', email.trim().toLowerCase())
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  /** Live invitations, newest first. Expired ones are included and marked by their date. */
  async listPending(limit = 100): Promise<Invitation[]> {
    return (
      await this.#scoped()
        .selectAll()
        .where('accepted_at', 'is', null)
        .where('revoked_at', 'is', null)
        .orderBy('created_at', 'desc')
        .limit(limit)
        .execute()
    ).map(toDomain);
  }

  /**
   * Marks an invitation accepted.
   *
   * The `where` clauses are the acceptance rules, expressed where they cannot
   * be skipped: not already accepted, not revoked, not expired. A caller that
   * checked those in advance and then raced another request still cannot
   * accept twice.
   */
  async markAccepted(
    invitationId: string,
    acceptedUserId: UserId | string,
    at: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('invitations')
      .set({ accepted_at: at, accepted_user_id: toUserId(acceptedUserId) })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', invitationId)
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', at)
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  async revoke(
    invitationId: string,
    revokedByUserId: UserId | string,
    at: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('invitations')
      .set({ revoked_at: at, revoked_by_user_id: toUserId(revokedByUserId) })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', invitationId)
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }
}

function toDomain(row: Selectable<InvitationsTable>): Invitation {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    email: row.email,
    role: roleSchema.parse(row.role),
    invitedByUserId: toUserId(row.invited_by_user_id),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    acceptedUserId: row.accepted_user_id === null ? null : toUserId(row.accepted_user_id),
    revokedAt: row.revoked_at,
    revokedByUserId: row.revoked_by_user_id === null ? null : toUserId(row.revoked_by_user_id),
  };
}
