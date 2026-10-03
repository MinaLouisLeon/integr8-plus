import { type UserId, toUserId } from '@integr8/core';
import { sql } from 'kysely';
import type { PushDisabledReason, PushPlatform } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * Where to send a person push notifications (P14): one Expo push token per phone,
 * tied to the session that registered it.
 *
 * A token names a phone, not a person. When somebody else signs in on the same
 * phone it moves to them. A token Expo reports as unregistered is disabled, and a
 * session that is revoked or has expired sends nothing: a phone that was wiped
 * remotely stops hearing about jobs at once.
 */

export interface PushDevice {
  id: string;
  userId: UserId;
  token: string;
  platform: PushPlatform;
}

export class PushDevicesRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  async register(input: {
    userId: UserId | string;
    sessionId: string;
    token: string;
    platform: PushPlatform;
    deviceLabel: string | null;
  }): Promise<PushDevice> {
    const row = await this.db
      .insertInto('push_devices')
      .values({
        tenant_id: this.tenantId,
        user_id: toUserId(input.userId),
        session_id: input.sessionId,
        token: input.token,
        platform: input.platform,
        device_label: input.deviceLabel,
      })
      .onConflict((conflict) =>
        conflict.columns(['tenant_id', 'token']).doUpdateSet({
          user_id: toUserId(input.userId),
          session_id: input.sessionId,
          platform: input.platform,
          device_label: input.deviceLabel,
          last_registered_at: sql<Date>`now()`,
          disabled_at: null,
          disabled_reason: null,
        }),
      )
      .returning(['id', 'user_id', 'token', 'platform'])
      .executeTakeFirstOrThrow();
    return { id: row.id, userId: toUserId(row.user_id), token: row.token, platform: row.platform };
  }

  /** Stops sending to a phone. Only its own person may say so from the phone. */
  async disable(
    token: string,
    reason: PushDisabledReason,
    userId?: UserId | string,
  ): Promise<boolean> {
    let update = this.db
      .updateTable('push_devices')
      .set({ disabled_at: sql<Date>`now()`, disabled_reason: reason })
      .where('tenant_id', '=', this.tenantId)
      .where('token', '=', token)
      .where('disabled_at', 'is', null);
    if (userId !== undefined) {
      update = update.where('user_id', '=', toUserId(userId));
    }
    return (await update.executeTakeFirst()).numUpdatedRows > 0n;
  }

  /** Stops sending to the phones a person signed out of: one session, or all of them. */
  async disableSignedOut(
    input: { sessionId: string } | { userId: UserId | string },
  ): Promise<number> {
    let update = this.db
      .updateTable('push_devices')
      .set({ disabled_at: sql<Date>`now()`, disabled_reason: 'signed_out' })
      .where('tenant_id', '=', this.tenantId)
      .where('disabled_at', 'is', null);
    update =
      'sessionId' in input
        ? update.where('session_id', '=', input.sessionId)
        : update.where('user_id', '=', toUserId(input.userId));
    return Number((await update.executeTakeFirst()).numUpdatedRows);
  }

  /** The phones to send to for these people: enabled, on a session still in force. */
  async activeFor(userIds: readonly (UserId | string)[]): Promise<PushDevice[]> {
    if (userIds.length === 0) {
      return [];
    }
    const rows = await this.db
      .selectFrom('push_devices')
      .innerJoin('sessions', (join) =>
        join
          .onRef('sessions.tenant_id', '=', 'push_devices.tenant_id')
          .onRef('sessions.id', '=', 'push_devices.session_id'),
      )
      .select([
        'push_devices.id',
        'push_devices.user_id',
        'push_devices.token',
        'push_devices.platform',
      ])
      .where('push_devices.tenant_id', '=', this.tenantId)
      .where(
        'push_devices.user_id',
        'in',
        userIds.map((id) => toUserId(id)),
      )
      .where('push_devices.disabled_at', 'is', null)
      .where('sessions.revoked_at', 'is', null)
      .where('sessions.expires_at', '>', sql<Date>`now()`)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      userId: toUserId(row.user_id),
      token: row.token,
      platform: row.platform,
    }));
  }
}
