import type { Kysely } from 'kysely';
import type { Database } from '../schema.js';

export interface RateLimitDecision {
  allowed: boolean;
  /** Requests counted in the current window, including this one. */
  count: number;
  limit: number;
  /** When the current window ends and the count resets. */
  resetsAt: Date;
}

export interface RateLimitOptions {
  bucketKey: string;
  limit: number;
  windowMs: number;
  now?: Date;
}

/**
 * Fixed-window request counters.
 *
 * Not tenant-scoped, and it cannot be: rate limiting runs before the handler
 * and, for an unauthenticated request, before there is any tenant to scope by.
 * The bucket key carries whatever the limit is keyed on — `ip:198.51.100.4`,
 * `tenant:<uuid>` — so both kinds of limit share one table and one code path.
 *
 * Reached only by `integr8_auth`, the same narrow role that serves the rest of
 * the pre-authentication path.
 *
 * **Fixed windows, not a sliding log.** A sliding window is more accurate at
 * the boundary — a client can send `limit` requests at the end of one window
 * and `limit` more at the start of the next — and costs a row per request to
 * do it. For a limit whose job is to stop abuse rather than to meter billing,
 * one upsert per request is the right trade, and the boundary case is bounded
 * at twice the limit.
 */
export class RateLimitRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Counts this request and says whether it is allowed.
   *
   * One statement: the increment and the read are the same upsert, so two
   * simultaneous requests cannot both read the pre-increment count and both
   * decide they are under the limit.
   */
  async consume(options: RateLimitOptions): Promise<RateLimitDecision> {
    const now = options.now ?? new Date();
    const windowStartedAt = floorToWindow(now, options.windowMs);

    const row = await this.db
      .insertInto('rate_limit_buckets')
      .values({
        bucket_key: options.bucketKey,
        window_started_at: windowStartedAt,
        request_count: 1,
        updated_at: now,
      })
      .onConflict((oc) =>
        oc.columns(['bucket_key', 'window_started_at']).doUpdateSet((eb) => ({
          request_count: eb('rate_limit_buckets.request_count', '+', 1),
          updated_at: now,
        })),
      )
      .returning(['request_count'])
      .executeTakeFirstOrThrow();

    return {
      allowed: row.request_count <= options.limit,
      count: row.request_count,
      limit: options.limit,
      resetsAt: new Date(windowStartedAt.getTime() + options.windowMs),
    };
  }

  /**
   * Removes counters whose window has passed.
   *
   * The only table in this schema that deletes. A rate-limit counter has no
   * evidentiary value once its window is over — unlike a login attempt, which
   * is kept precisely because somebody may need to reconstruct an attack.
   */
  async sweep(olderThan: Date): Promise<number> {
    const result = await this.db
      .deleteFrom('rate_limit_buckets')
      .where('window_started_at', '<', olderThan)
      .executeTakeFirst();

    return Number(result.numDeletedRows ?? 0n);
  }
}

/**
 * The start of the window `now` falls in.
 *
 * Aligned to the epoch rather than to first contact, so every container agrees
 * on where a window begins without coordinating.
 */
export function floorToWindow(now: Date, windowMs: number): Date {
  return new Date(Math.floor(now.getTime() / windowMs) * windowMs);
}
