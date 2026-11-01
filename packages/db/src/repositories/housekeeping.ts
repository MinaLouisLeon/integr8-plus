import { type Kysely, sql } from 'kysely';
import type { Database } from '../schema.js';

/** How many rows one delete statement removes. */
export const HOUSEKEEPING_BATCH_SIZE = 5_000;

/** The most batches one table gets per run, so a backlog is worked off over several nights. */
export const HOUSEKEEPING_MAX_BATCHES = 200;

export interface HousekeepingCutoffs {
  /** Rate-limit counters whose window started before this. */
  rateLimitWindowsBefore: Date;
  /** Idempotency records whose own `expires_at` is before this. */
  idempotencyExpiredBefore: Date;
  /** Login attempts made before this. */
  loginAttemptsBefore: Date;
}

export interface HousekeepingReport {
  rateLimitBuckets: number;
  idempotencyKeys: number;
  loginAttempts: number;
}

/**
 * Deleting what three ever-growing tables no longer need, across every company.
 *
 * As the schema owner: `idempotency_keys` is tenant-scoped and the runtime role
 * holds no delete on it, and the other two are reached by no tenant at all.
 *
 * Each table is emptied in batches of {@link HOUSEKEEPING_BATCH_SIZE} rows, one
 * statement each, so no single delete holds locks across a whole backlog or
 * writes one enormous transaction to the log. The first run on a deployment
 * that has never been swept is the large one.
 */
export class HousekeepingRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async sweep(
    cutoffs: HousekeepingCutoffs,
    options: { batchSize?: number; maxBatches?: number } = {},
  ): Promise<HousekeepingReport> {
    const batchSize = options.batchSize ?? HOUSEKEEPING_BATCH_SIZE;
    const maxBatches = options.maxBatches ?? HOUSEKEEPING_MAX_BATCHES;

    return {
      rateLimitBuckets: await this.#inBatches(batchSize, maxBatches, (limit) =>
        sql`
          delete from rate_limit_buckets
          where ctid in (
            select ctid from rate_limit_buckets
            where window_started_at < ${cutoffs.rateLimitWindowsBefore}
            limit ${limit}
          )
        `.execute(this.db),
      ),
      idempotencyKeys: await this.#inBatches(batchSize, maxBatches, (limit) =>
        sql`
          delete from idempotency_keys
          where ctid in (
            select ctid from idempotency_keys
            where expires_at < ${cutoffs.idempotencyExpiredBefore}
            limit ${limit}
          )
        `.execute(this.db),
      ),
      loginAttempts: await this.#inBatches(batchSize, maxBatches, (limit) =>
        sql`
          delete from login_attempts
          where ctid in (
            select ctid from login_attempts
            where occurred_at < ${cutoffs.loginAttemptsBefore}
            limit ${limit}
          )
        `.execute(this.db),
      ),
    };
  }

  async #inBatches(
    batchSize: number,
    maxBatches: number,
    deleteBatch: (limit: number) => Promise<{ numAffectedRows?: bigint }>,
  ): Promise<number> {
    let total = 0;
    for (let batch = 0; batch < maxBatches; batch += 1) {
      const deleted = Number((await deleteBatch(batchSize)).numAffectedRows ?? 0n);
      total += deleted;
      if (deleted < batchSize) {
        break;
      }
    }
    return total;
  }
}
