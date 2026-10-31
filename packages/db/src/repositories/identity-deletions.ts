import { sql, type Kysely } from 'kysely';
import type { Database } from '../schema.js';

/** A sign-in account waiting to be deleted from Auth (0054). */
export interface PendingIdentityDeletion {
  userId: string;
  queuedAt: Date;
  attempts: number;
  lastError: string | null;
}

/**
 * Sign-in accounts to delete after a company purge (P36).
 *
 * The purge removes every row that said who a company's people were, so their
 * ids are read first, written here, and worked through once the rows are gone.
 * A delete that fails stays pending and is tried again on the next purge run.
 *
 * Platform only: reached through the owner connection, which RLS does not
 * filter. That is also what lets {@link hasMembership} look across every
 * company at once.
 */
export class IdentityDeletionsRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Everyone who has ever been a member of one company, removed members
   * included. Read before the company is purged: afterwards nothing is left
   * to read it from.
   */
  async membersOf(tenantId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('tenant_users')
      .select('user_id')
      .distinct()
      .where('tenant_id', '=', tenantId)
      .execute();
    return rows.map((row) => row.user_id);
  }

  /**
   * Queues ids for deletion. One already queued stays queued; one already
   * deleted is queued again, since Auth hands out a new id to an address that
   * comes back, and the old one may have been reused here meanwhile.
   */
  async queue(userIds: readonly string[], at: Date = new Date()): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    await this.db
      .insertInto('identity_deletions')
      .values(userIds.map((userId) => ({ user_id: userId, queued_at: at })))
      .onConflict((oc) =>
        oc.column('user_id').doUpdateSet({ completed_at: null, last_error: null }),
      )
      .execute();
  }

  /** What is still to do, oldest first. */
  async pending(limit = 200): Promise<PendingIdentityDeletion[]> {
    const rows = await this.db
      .selectFrom('identity_deletions')
      .selectAll()
      .where('completed_at', 'is', null)
      .orderBy('queued_at', 'asc')
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      userId: row.user_id,
      queuedAt: row.queued_at,
      attempts: row.attempts,
      lastError: row.last_error,
    }));
  }

  /**
   * Whether this person still belongs to any company. Checked just before each
   * delete, not when the id was queued: somebody invited elsewhere while a
   * delete was failing must keep their account.
   */
  async hasMembership(userId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom('tenant_users')
      .select(sql<number>`1`.as('one'))
      .where('user_id', '=', userId)
      .where('deleted_at', 'is', null)
      .limit(1)
      .executeTakeFirst();
    return row !== undefined;
  }

  async markDone(userId: string, at: Date = new Date()): Promise<void> {
    await this.db
      .updateTable('identity_deletions')
      .set((eb) => ({
        completed_at: at,
        last_attempt_at: at,
        last_error: null,
        attempts: eb('attempts', '+', 1),
      }))
      .where('user_id', '=', userId)
      .execute();
  }

  async markFailed(userId: string, error: string, at: Date = new Date()): Promise<void> {
    await this.db
      .updateTable('identity_deletions')
      .set((eb) => ({
        last_attempt_at: at,
        last_error: error.slice(0, 500),
        attempts: eb('attempts', '+', 1),
      }))
      .where('user_id', '=', userId)
      .execute();
  }
}
