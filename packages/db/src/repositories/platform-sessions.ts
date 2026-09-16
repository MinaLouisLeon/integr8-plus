import { type PlatformUserId, toPlatformUserId } from '@integr8/core';
import type { Kysely, Selectable } from 'kysely';
import type {
  Database,
  PlatformSessionRevocationReason,
  PlatformSessionsTable,
} from '../schema.js';

/**
 * Signed-in browsers for super admins, and the refresh tokens that keep them
 * signed in.
 *
 * The same shape as tenant sessions (0003) and for the same reasons: a row per
 * token ever issued, chained, so presenting a spent one is unambiguous theft
 * rather than a race. What differs is the stakes — this session can reach every
 * company — so it is shorter-lived, and nothing here is reachable by the
 * runtime role at all.
 */

export interface PlatformSession {
  id: string;
  platformUserId: PlatformUserId;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: PlatformSessionRevocationReason | null;
}

export interface CreatePlatformSessionInput {
  platformUserId: PlatformUserId | string;
  expiresAt: Date;
  refreshTokenHash: string;
  refreshExpiresAt: Date;
  userAgent?: string | null;
  ipAddress?: string | null;
}

export interface CreatedPlatformSession {
  session: PlatformSession;
  refreshTokenId: string;
}

/** What a presented refresh token turned out to be. */
export type PlatformRefreshLookup =
  | { outcome: 'unknown' }
  /** Already spent: the legitimate holder moved on, so whoever presents it is not them. */
  | { outcome: 'reused'; session: PlatformSession }
  | { outcome: 'expired'; session: PlatformSession }
  | { outcome: 'session_over'; session: PlatformSession }
  | { outcome: 'live'; session: PlatformSession; tokenId: string };

export class PlatformSessionsRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async create(input: CreatePlatformSessionInput): Promise<CreatedPlatformSession> {
    return this.db.transaction().execute(async (trx) => {
      const session = await trx
        .insertInto('platform_sessions')
        .values({
          platform_user_id: toPlatformUserId(input.platformUserId),
          expires_at: input.expiresAt,
          user_agent: input.userAgent ?? null,
          ip_address: input.ipAddress ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();

      const token = await trx
        .insertInto('platform_refresh_tokens')
        .values({
          session_id: session.id,
          token_hash: input.refreshTokenHash,
          expires_at: input.refreshExpiresAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      return { session: toSession(session), refreshTokenId: token.id };
    });
  }

  async find(sessionId: string): Promise<PlatformSession | undefined> {
    const row = await this.db
      .selectFrom('platform_sessions')
      .selectAll()
      .where('id', '=', sessionId)
      .executeTakeFirst();

    return row === undefined ? undefined : toSession(row);
  }

  async listFor(platformUserId: PlatformUserId | string): Promise<PlatformSession[]> {
    return (
      await this.db
        .selectFrom('platform_sessions')
        .selectAll()
        .where('platform_user_id', '=', toPlatformUserId(platformUserId))
        .orderBy('created_at', 'desc')
        .execute()
    ).map(toSession);
  }

  /** What this refresh token is now: live, spent, expired, or from a session that is over. */
  async lookupRefreshToken(hash: string, now = new Date()): Promise<PlatformRefreshLookup> {
    const row = await this.db
      .selectFrom('platform_refresh_tokens')
      .innerJoin('platform_sessions', 'platform_sessions.id', 'platform_refresh_tokens.session_id')
      .selectAll('platform_sessions')
      .select([
        'platform_refresh_tokens.id as token_id',
        'platform_refresh_tokens.used_at as token_used_at',
        'platform_refresh_tokens.expires_at as token_expires_at',
      ])
      .where('platform_refresh_tokens.token_hash', '=', hash)
      .executeTakeFirst();

    if (row === undefined) {
      return { outcome: 'unknown' };
    }
    const session = toSession(row);
    if (row.token_used_at !== null) {
      return { outcome: 'reused', session };
    }
    if (session.revokedAt !== null || session.expiresAt <= now) {
      return { outcome: 'session_over', session };
    }
    if (row.token_expires_at <= now) {
      return { outcome: 'expired', session };
    }
    return { outcome: 'live', session, tokenId: row.token_id };
  }

  /**
   * Spends one refresh token and issues its replacement, in one transaction.
   *
   * Returns `undefined` when the token had already been spent, which is the
   * concurrency control and not an edge case: two refreshes racing with the
   * same token both read it as live, and the `where used_at is null` lets
   * exactly one of them change a row. The loser is told so and its caller
   * treats it as a replay — a client refreshing twice at once is
   * indistinguishable from a thief racing the real client, and the safe
   * reading of the pair is theft.
   *
   * `numUpdatedRows` rather than `executeTakeFirstOrThrow`: an update with no
   * `returning` resolves to an `UpdateResult` even when it changed nothing, so
   * "throw if it did not match" is not something that method can express here.
   */
  async rotate(input: {
    tokenId: string;
    sessionId: string;
    refreshTokenHash: string;
    refreshExpiresAt: Date;
    sessionExpiresAt: Date;
    now?: Date;
  }): Promise<{ refreshTokenId: string } | undefined> {
    const now = input.now ?? new Date();
    try {
      return await this.#rotate(input, now);
    } catch (error) {
      if (error instanceof PlatformRefreshRaceLost) {
        return undefined;
      }
      throw error;
    }
  }

  async #rotate(
    input: {
      tokenId: string;
      sessionId: string;
      refreshTokenHash: string;
      refreshExpiresAt: Date;
      sessionExpiresAt: Date;
    },
    now: Date,
  ): Promise<{ refreshTokenId: string }> {
    return this.db.transaction().execute(async (trx) => {
      const replacement = await trx
        .insertInto('platform_refresh_tokens')
        .values({
          session_id: input.sessionId,
          token_hash: input.refreshTokenHash,
          expires_at: input.refreshExpiresAt,
        })
        .returning('id')
        .executeTakeFirstOrThrow();

      const spent = await trx
        .updateTable('platform_refresh_tokens')
        .set({ used_at: now, replaced_by: replacement.id })
        .where('id', '=', input.tokenId)
        .where('used_at', 'is', null)
        .executeTakeFirst();

      if ((spent.numUpdatedRows ?? 0n) === 0n) {
        // Somebody else spent it first. Undo the replacement we just issued, so
        // the chain has one successor rather than two and the loser's token
        // never existed.
        throw new PlatformRefreshRaceLost();
      }

      await trx
        .updateTable('platform_sessions')
        .set({ last_seen_at: now, expires_at: input.sessionExpiresAt })
        .where('id', '=', input.sessionId)
        .execute();

      return { refreshTokenId: replacement.id };
    });
  }

  async touch(sessionId: string, now = new Date()): Promise<void> {
    await this.db
      .updateTable('platform_sessions')
      .set({ last_seen_at: now })
      .where('id', '=', sessionId)
      .execute();
  }

  async revoke(
    sessionId: string,
    reason: PlatformSessionRevocationReason,
    now = new Date(),
  ): Promise<void> {
    await this.db
      .updateTable('platform_sessions')
      .set({ revoked_at: now, revoked_reason: reason })
      .where('id', '=', sessionId)
      .where('revoked_at', 'is', null)
      .execute();
  }

  /** Every live session of one person: used when a password changes or an account is disabled. */
  async revokeAllFor(
    platformUserId: PlatformUserId | string,
    reason: PlatformSessionRevocationReason,
    now = new Date(),
  ): Promise<number> {
    const result = await this.db
      .updateTable('platform_sessions')
      .set({ revoked_at: now, revoked_reason: reason })
      .where('platform_user_id', '=', toPlatformUserId(platformUserId))
      .where('revoked_at', 'is', null)
      .executeTakeFirst();

    return Number(result.numUpdatedRows);
  }
}

/**
 * Thrown inside the rotation transaction to roll it back, and never seen
 * outside this module: `rotate` turns it into `undefined`.
 */
class PlatformRefreshRaceLost extends Error {
  constructor() {
    super('This refresh token was spent by another request');
    this.name = 'PlatformRefreshRaceLost';
  }
}

function toSession(row: Selectable<PlatformSessionsTable>): PlatformSession {
  return {
    id: row.id,
    platformUserId: toPlatformUserId(row.platform_user_id),
    userAgent: row.user_agent,
    ipAddress: row.ip_address,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}
