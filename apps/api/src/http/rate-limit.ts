import { getAuthDataSource } from '@integr8/db';
import { tooManyRequests } from './errors.js';
import type { Logger } from './logger.js';

/**
 * Fixed-window rate limits, shared by every container through Postgres.
 *
 * The server keeps one limiter for its per-address and per-company windows; a
 * route that limits something else — the website lookup limits each website
 * key (docs/documents ADR-0001 D10) — makes its own with a different bucket.
 */

export interface ConsumeOptions {
  bucketKey: string;
  limit: number;
  windowMs: number;
  logger: Logger;
}

/**
 * Postgres-backed fixed windows, with an in-memory short circuit.
 *
 * The counter has to be shared, or the effective limit multiplies by the number
 * of containers. But an upsert per request is also a write per request an
 * attacker can force, so once a bucket is known to be over its limit the
 * decision is served from memory until that window ends. The common case costs
 * one cheap upsert; the abusive case costs nothing.
 *
 * If this becomes a contention point, the answer is Redis and it is a P19
 * conversation. It is one class and one interface, which is what makes that
 * swap small.
 */
export function createRateLimiter() {
  const blockedUntil = new Map<string, number>();

  return {
    async consume(options: ConsumeOptions): Promise<void> {
      const now = Date.now();
      const blocked = blockedUntil.get(options.bucketKey);

      if (blocked !== undefined) {
        if (blocked > now) {
          throw tooManyRequests(
            'Too many requests. Slow down and try again shortly.',
            (blocked - now) / 1000,
          );
        }
        blockedUntil.delete(options.bucketKey);
      }

      let decision;
      try {
        const auth = await getAuthDataSource();
        decision = await auth.rateLimits.consume({
          bucketKey: options.bucketKey,
          limit: options.limit,
          windowMs: options.windowMs,
        });
      } catch (error) {
        // Fail open. A rate limiter that rejects everything when its store is
        // unreachable turns a degraded dependency into a full outage, and the
        // thing it protects against is abuse rather than correctness.
        options.logger.warn('Rate limiter unavailable; allowing the request', {
          error: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (!decision.allowed) {
        blockedUntil.set(options.bucketKey, decision.resetsAt.getTime());
        throw tooManyRequests(
          'Too many requests. Slow down and try again shortly.',
          (decision.resetsAt.getTime() - now) / 1000,
        );
      }
    },
  };
}
