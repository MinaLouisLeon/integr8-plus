import { type TenantId, type UserId, toTenantId, toUserId } from '@integr8/core';
import type { Selectable } from 'kysely';
import {
  type ClientApp,
  clientAppSchema,
  type RefreshTokensTable,
  type SessionRevocationReason,
  sessionRevocationReasonSchema,
  type SessionsTable,
} from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface Session {
  id: string;
  tenantId: TenantId;
  userId: UserId;
  clientApp: ClientApp;
  deviceLabel: string | null;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: SessionRevocationReason | null;
  impersonationGrantId: string | null;
}

export interface RefreshTokenRecord {
  id: string;
  tenantId: TenantId;
  sessionId: string;
  tokenHash: string;
  issuedAt: Date;
  expiresAt: Date;
  usedAt: Date | null;
  replacedBy: string | null;
}

export interface CreateSessionInput {
  userId: UserId | string;
  clientApp: ClientApp;
  expiresAt: Date;
  deviceLabel?: string | null;
  userAgent?: string | null;
  ipAddress?: string | null;
  impersonationGrantId?: string | null;
}

export interface ListSessionsOptions {
  userId?: UserId | string;
  includeRevoked?: boolean;
  includeExpired?: boolean;
  limit?: number;
}

/**
 * Sessions and their refresh-token chains, for one company.
 *
 * The two live in one repository because they are one aggregate: a refresh
 * token is meaningless without its session, and every interesting operation —
 * rotation, reuse detection, revocation — touches both inside a single
 * transaction. Splitting them would produce two objects that may never be used
 * apart.
 *
 * Nothing here deletes. Revocation sets a timestamp and a reason, because "this
 * session was revoked at 14:02 for refresh_token_reuse" is what an incident
 * needs, and a deleted row cannot say it. The grants in migration 0003 withhold
 * `delete` so the point is not merely stylistic.
 */
export class SessionsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** The one place a `sessions` read is scoped. */
  #scopedSessions() {
    return this.db.selectFrom('sessions').where('sessions.tenant_id', '=', this.tenantId);
  }

  /** The one place a `refresh_tokens` read is scoped. */
  #scopedTokens() {
    return this.db
      .selectFrom('refresh_tokens')
      .where('refresh_tokens.tenant_id', '=', this.tenantId);
  }

  async create(input: CreateSessionInput): Promise<Session> {
    const row = await this.db
      .insertInto('sessions')
      .values({
        tenant_id: this.tenantId,
        user_id: toUserId(input.userId),
        client_app: clientAppSchema.parse(input.clientApp),
        device_label: input.deviceLabel ?? null,
        user_agent: input.userAgent ?? null,
        ip_address: input.ipAddress ?? null,
        expires_at: input.expiresAt,
        impersonation_grant_id: input.impersonationGrantId ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toSession(row);
  }

  async findById(sessionId: string): Promise<Session | undefined> {
    const row = await this.#scopedSessions()
      .selectAll()
      .where('id', '=', sessionId)
      .executeTakeFirst();
    return row === undefined ? undefined : toSession(row);
  }

  /**
   * Sessions, newest first.
   *
   * Revoked and expired sessions are excluded by default: "my devices" means
   * the ones that could be used right now. An admin investigating an incident
   * asks for both.
   */
  async list(options: ListSessionsOptions = {}, now: Date = new Date()): Promise<Session[]> {
    let query = this.#scopedSessions().selectAll().orderBy('created_at', 'desc');

    if (options.userId !== undefined) {
      query = query.where('user_id', '=', toUserId(options.userId));
    }
    if (options.includeRevoked !== true) {
      query = query.where('revoked_at', 'is', null);
    }
    if (options.includeExpired !== true) {
      query = query.where('expires_at', '>', now);
    }

    return (await query.limit(options.limit ?? 100).execute()).map(toSession);
  }

  /** Records that a session was used, for the "last seen" column of a device list. */
  async touch(sessionId: string, at: Date = new Date()): Promise<void> {
    await this.db
      .updateTable('sessions')
      .set({ last_seen_at: at })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', sessionId)
      .execute();
  }

  /** Revokes one session. Returns false if it was already revoked or absent. */
  async revoke(
    sessionId: string,
    reason: SessionRevocationReason,
    at: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('sessions')
      .set({ revoked_at: at, revoked_reason: sessionRevocationReasonSchema.parse(reason) })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  /**
   * Revokes every live session for one person in this company.
   *
   * Used by "sign out everywhere", by a password change, and when a membership
   * ends — the last of which matters most: an engineer who leaves on Friday
   * must not still have a working phone on Monday.
   */
  async revokeAllForUser(
    userId: UserId | string,
    reason: SessionRevocationReason,
    options: { except?: string } = {},
    at: Date = new Date(),
  ): Promise<number> {
    let query = this.db
      .updateTable('sessions')
      .set({ revoked_at: at, revoked_reason: sessionRevocationReasonSchema.parse(reason) })
      .where('tenant_id', '=', this.tenantId)
      .where('user_id', '=', toUserId(userId))
      .where('revoked_at', 'is', null);

    if (options.except !== undefined) {
      query = query.where('id', '!=', options.except);
    }

    const result = await query.executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0n);
  }

  // -------------------------------------------------------------------------
  // Refresh tokens
  // -------------------------------------------------------------------------

  async issueRefreshToken(input: {
    sessionId: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<RefreshTokenRecord> {
    const row = await this.db
      .insertInto('refresh_tokens')
      .values({
        tenant_id: this.tenantId,
        session_id: input.sessionId,
        token_hash: input.tokenHash,
        expires_at: input.expiresAt,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toRefreshToken(row);
  }

  /**
   * Finds a token by its hash.
   *
   * Returns spent tokens too, deliberately: a spent token being presented is
   * the signal that one has been stolen, and a lookup that hid it would hide
   * the incident.
   */
  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | undefined> {
    const row = await this.#scopedTokens()
      .selectAll()
      .where('token_hash', '=', tokenHash)
      .executeTakeFirst();

    return row === undefined ? undefined : toRefreshToken(row);
  }

  /**
   * Marks a token spent and names its replacement, in one statement.
   *
   * The `where used_at is null` is the concurrency control: two simultaneous
   * refreshes with the same token both read it as unused, and only one of them
   * updates a row. The loser sees `false` and is treated as a replay, which is
   * the safe reading — a client refreshing twice at once is indistinguishable
   * from a thief racing the real client.
   */
  async markRefreshTokenUsed(
    tokenId: string,
    replacedBy: string,
    at: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('refresh_tokens')
      .set({ used_at: at, replaced_by: replacedBy })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', tokenId)
      .where('used_at', 'is', null)
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  /** Every token issued for a session, oldest first. The chain, for an incident. */
  async listRefreshTokens(sessionId: string): Promise<RefreshTokenRecord[]> {
    return (
      await this.#scopedTokens()
        .selectAll()
        .where('session_id', '=', sessionId)
        .orderBy('issued_at', 'asc')
        .execute()
    ).map(toRefreshToken);
  }
}

function toSession(row: Selectable<SessionsTable>): Session {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    userId: toUserId(row.user_id),
    clientApp: clientAppSchema.parse(row.client_app),
    deviceLabel: row.device_label,
    userAgent: row.user_agent,
    ipAddress: row.ip_address,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason:
      row.revoked_reason === null ? null : sessionRevocationReasonSchema.parse(row.revoked_reason),
    impersonationGrantId: row.impersonation_grant_id,
  };
}

function toRefreshToken(row: Selectable<RefreshTokensTable>): RefreshTokenRecord {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    sessionId: row.session_id,
    tokenHash: row.token_hash,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    replacedBy: row.replaced_by,
  };
}
