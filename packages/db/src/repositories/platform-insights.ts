import type { Kysely } from 'kysely';
import type { Database } from '../schema.js';

/**
 * What the platform can see across every company (P15).
 *
 * Two questions the dashboard asks that no tenant-scoped repository can answer,
 * because both are about the platform rather than about one customer: which app
 * versions are actually in the field, and what has been failing lately.
 *
 * Both run on the owner connection, where RLS does not apply. That is exactly
 * the privilege that makes them possible and exactly why they live here, behind
 * the platform data source, rather than anywhere a tenant request could reach.
 */

export interface ReleaseInField {
  clientApp: 'mobile';
  version: string;
  /** How many distinct people have reported from this version in the window. */
  devices: number;
  lastSeenAt: Date;
}

export interface RecentFailure {
  id: string;
  tenantId: string;
  queue: string;
  attempts: number;
  lastError: string | null;
  failedAt: Date;
  deadLettered: boolean;
}

export class PlatformInsightsRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Which app versions are in use, from what the phones themselves report.
   *
   * `sync_reports.app_version` is the only place a client's version is kept:
   * every other client sends `x-client-version` on each request and nothing
   * writes it down. So this answers the question for mobile honestly and says
   * nothing about desktop or web rather than guessing — and if the release view
   * needs those, the fix is to record them, not to infer them here.
   */
  async releases(since: Date): Promise<ReleaseInField[]> {
    const rows = await this.db
      .selectFrom('sync_reports')
      .select((eb) => [
        'app_version',
        eb.fn.count<string>('user_id').distinct().as('devices'),
        eb.fn.max<Date>('received_at').as('last_seen_at'),
      ])
      .where('app_version', 'is not', null)
      .where('received_at', '>=', since)
      .groupBy('app_version')
      .orderBy('last_seen_at', 'desc')
      .execute();

    return rows.map((row) => ({
      clientApp: 'mobile' as const,
      version: row.app_version ?? 'unknown',
      devices: Number(row.devices),
      lastSeenAt: row.last_seen_at,
    }));
  }

  /**
   * What has been failing for one company, newest first.
   *
   * Jobs rather than HTTP errors: request failures go to Sentry, which is where
   * they belong and where nothing here could add to them. What a support
   * engineer cannot see in Sentry is the background work that quietly gave up —
   * an import, a thumbnail, a push — and that is what this shows.
   */
  async recentFailures(tenantId: string, limit = 50): Promise<RecentFailure[]> {
    const rows = await this.db
      .selectFrom('jobs')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where((where) =>
        where.or([where('status', '=', 'failed'), where('dead_lettered_at', 'is not', null)]),
      )
      .orderBy('updated_at', 'desc')
      .limit(Math.min(Math.max(limit, 1), 200))
      .execute();

    return rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      queue: row.queue,
      attempts: row.attempts,
      lastError: row.last_error,
      failedAt: row.dead_lettered_at ?? row.updated_at,
      deadLettered: row.dead_lettered_at !== null,
    }));
  }
}
