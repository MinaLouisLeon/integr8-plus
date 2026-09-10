import { type TenantId, type UserId, toTenantId, toUserId } from '@integr8/core';
import type { Selectable } from 'kysely';
import {
  type IdempotencyKeysTable,
  type IdempotencyStatus,
  idempotencyStatusSchema,
} from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface IdempotencyRecord {
  id: string;
  tenantId: TenantId;
  idempotencyKey: string;
  userId: UserId;
  method: string;
  path: string;
  requestFingerprint: string;
  status: IdempotencyStatus;
  responseStatus: number | null;
  responseBody: unknown;
  createdAt: Date;
  completedAt: Date | null;
  expiresAt: Date;
}

export interface ClaimIdempotencyKeyInput {
  idempotencyKey: string;
  userId: UserId | string;
  method: string;
  path: string;
  requestFingerprint: string;
  expiresAt: Date;
}

export type IdempotencyClaim =
  /** This caller owns the request and should execute the handler. */
  | { outcome: 'claimed'; record: IdempotencyRecord }
  /** Somebody already finished it; replay their response verbatim. */
  | { outcome: 'replay'; record: IdempotencyRecord }
  /** Somebody is executing it right now. */
  | { outcome: 'in_progress'; record: IdempotencyRecord }
  /** The same key arrived with a different request. A client bug. */
  | { outcome: 'fingerprint_mismatch'; record: IdempotencyRecord };

/**
 * Idempotency keys for one company.
 *
 * The problem this solves is that a client cannot tell "the request failed"
 * from "the request succeeded and the reply was lost". Both look like a
 * timeout, and the only safe behaviour on the client is to retry — which is
 * exactly what the mobile outbox in P12 does.
 */
export class IdempotencyRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** The one place an `idempotency_keys` read is scoped. */
  #scoped() {
    return this.db
      .selectFrom('idempotency_keys')
      .where('idempotency_keys.tenant_id', '=', this.tenantId);
  }

  /**
   * Takes ownership of a key, or reports who already has it.
   *
   * The insert is the lock. `on conflict do nothing` means exactly one of any
   * number of simultaneous callers inserts a row, and everybody else reads what
   * that one wrote — there is no window between checking and claiming for a
   * second request to slip through.
   */
  async claim(input: ClaimIdempotencyKeyInput): Promise<IdempotencyClaim> {
    // Bounded, because the one path that loops is a row disappearing between
    // the conflict and the read. That can happen once, when the sweeper removes
    // an expired key in the gap; if it happens twice something else is wrong
    // and spinning would make it worse.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const inserted = await this.db
        .insertInto('idempotency_keys')
        .values({
          tenant_id: this.tenantId,
          idempotency_key: input.idempotencyKey,
          user_id: toUserId(input.userId),
          method: input.method,
          path: input.path,
          request_fingerprint: input.requestFingerprint,
          expires_at: input.expiresAt,
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'idempotency_key']).doNothing())
        .returningAll()
        .executeTakeFirst();

      if (inserted !== undefined) {
        return { outcome: 'claimed', record: toDomain(inserted) };
      }

      const existing = await this.find(input.idempotencyKey);
      if (existing === undefined) {
        continue;
      }

      if (existing.requestFingerprint !== input.requestFingerprint) {
        return { outcome: 'fingerprint_mismatch', record: existing };
      }

      return existing.status === 'completed'
        ? { outcome: 'replay', record: existing }
        : { outcome: 'in_progress', record: existing };
    }

    throw new Error(
      `Could not claim idempotency key "${input.idempotencyKey}": it was inserted and removed concurrently.`,
    );
  }

  async find(idempotencyKey: string): Promise<IdempotencyRecord | undefined> {
    const row = await this.#scoped()
      .selectAll()
      .where('idempotency_key', '=', idempotencyKey)
      .executeTakeFirst();

    return row === undefined ? undefined : toDomain(row);
  }

  /**
   * Records the response, so a replay returns the original answer rather than
   * merely avoiding a second effect.
   */
  async complete(
    idempotencyKey: string,
    response: { status: number; body: unknown },
    at: Date = new Date(),
  ): Promise<boolean> {
    const result = await this.db
      .updateTable('idempotency_keys')
      .set({
        status: 'completed',
        response_status: response.status,
        response_body: response.body,
        completed_at: at,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('idempotency_key', '=', idempotencyKey)
      .where('status', '=', 'in_progress')
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }

  /**
   * Releases a claim whose handler failed.
   *
   * A failed request should be retriable with the same key. Leaving the row
   * `in_progress` would lock that key out until it expired, which turns one
   * transient error into an hour of rejections.
   *
   * Expiring rather than deleting: the row stays visible to anybody debugging
   * why a key behaved oddly, and the sweeper removes it on the usual schedule.
   */
  async release(idempotencyKey: string, at: Date = new Date()): Promise<boolean> {
    const result = await this.db
      .updateTable('idempotency_keys')
      .set({ expires_at: at })
      .where('tenant_id', '=', this.tenantId)
      .where('idempotency_key', '=', idempotencyKey)
      .where('status', '=', 'in_progress')
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }
}

function toDomain(row: Selectable<IdempotencyKeysTable>): IdempotencyRecord {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    idempotencyKey: row.idempotency_key,
    userId: toUserId(row.user_id),
    method: row.method,
    path: row.path,
    requestFingerprint: row.request_fingerprint,
    status: idempotencyStatusSchema.parse(row.status),
    responseStatus: row.response_status,
    responseBody: row.response_body,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
  };
}
