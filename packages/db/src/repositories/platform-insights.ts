import { type Kysely, sql } from 'kysely';
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

/** How long one company took from existing to its first submitted form (P18). */
export interface TimeToFirstSubmission {
  tenantId: string;
  /** From the company being provisioned to `submissions.submitted_at` of its first form. */
  seconds: number;
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

  /**
   * From a company existing to its first submitted form, for every self-serve
   * company created since a moment that has submitted anything (P18).
   *
   * The second P18 exit criterion — *time from landing page to first submitted
   * form* — measured from the earliest moment that can honestly be tied to a
   * company. Page views carry no id and cannot be; the signup request can, and
   * `signup.provisioned` is when the company came to exist. If that event was
   * lost (funnel writes are allowed to fail), `signup.started` on the same
   * request stands in: a few minutes earlier, and still that company's own.
   *
   * Cross-tenant on purpose, which is why it is here and not on a tenant
   * repository: `submissions` is read for every company at once, on the owner
   * connection where RLS does not apply. It returns company ids and seconds —
   * nothing that identifies a person — because that is the funnel table's
   * promise and this query must not be the place it is broken.
   */
  async timeToFirstSubmission(input: {
    since: Date;
    /** The funnel step names, owned by the API's signup service. */
    provisionedStep: string;
    startedStep: string;
    limit?: number;
  }): Promise<TimeToFirstSubmission[]> {
    const rows = await sql<{ tenant_id: string; seconds: string | number }>`
      with started as (
        select
          r.tenant_id,
          coalesce(
            min(e.occurred_at) filter (where e.step = ${input.provisionedStep}),
            min(e.occurred_at) filter (where e.step = ${input.startedStep})
          ) as started_at
        from signup_requests r
        join signup_events e on e.signup_id = r.id
        where r.tenant_id is not null
          and e.step in (${input.provisionedStep}, ${input.startedStep})
        group by r.tenant_id
      ),
      first_form as (
        select tenant_id, min(submitted_at) as submitted_at
        from submissions
        where submitted_at is not null
        group by tenant_id
      )
      select
        s.tenant_id,
        extract(epoch from (f.submitted_at - s.started_at)) as seconds
      from started s
      join first_form f on f.tenant_id = s.tenant_id
      where s.started_at >= ${input.since}
        and f.submitted_at >= s.started_at
      order by s.started_at desc
      limit ${Math.min(Math.max(input.limit ?? 500, 1), 5000)}
    `.execute(this.db);

    return rows.rows.map((row) => ({
      tenantId: row.tenant_id,
      seconds: Math.round(Number(row.seconds)),
    }));
  }
}

export interface SyncTrouble {
  tenantId: string;
  userId: string;
  /** Sync runs this person's phone reported in the window. */
  runs: number;
  failedRuns: number;
  partialRuns: number;
  rejected: number;
  conflicts: number;
  uploadsFailed: number;
  /** From the latest report: what is still waiting on the phone. */
  queueDepth: number;
  pendingUploads: number;
  lastOutcome: string;
  lastReportAt: Date;
  appVersion: string | null;
}

export interface JobHealth {
  /** Jobs that ran out of attempts in the window. */
  deadLettered: number;
  /** Jobs that failed at least once and are waiting to try again. */
  retrying: number;
}

/**
 * The two things the review found failing quietly, surfaced (P19).
 *
 * A phone that cannot get its work to the server, and background work that
 * gave up, both look fine from the office until a customer rings. These read
 * every company's `sync_reports` and `jobs` on the owner connection so the
 * platform can see trouble before a person reports it.
 */
export class PlatformHealthRepository {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Phones whose recent sync runs show trouble, worst first.
   *
   * One row per person per company, over the window: how many runs failed or
   * only partly succeeded, how many changes were refused or conflicted, how
   * many uploads failed, and — from the latest report — how much is still
   * waiting on the phone. A phone with a clean history but a growing queue is
   * included too: nothing has failed yet, but nothing is arriving either.
   *
   * "Latest" goes by when the run started on the phone, not when the report
   * arrived: reports queue up offline and arrive together, in one transaction
   * with one `received_at`, in whatever order the phone sent them.
   */
  async syncTrouble(since: Date, limit = 100): Promise<SyncTrouble[]> {
    const rows = await sql<{
      tenant_id: string;
      user_id: string;
      runs: string;
      failed_runs: string;
      partial_runs: string;
      rejected: string;
      conflicts: string;
      uploads_failed: string;
      last_outcome: string;
      queue_depth: number;
      pending_uploads: number;
      app_version: string | null;
      last_report_at: Date;
    }>`
      with latest as (
        select distinct on (tenant_id, user_id)
               tenant_id, user_id, outcome, queue_depth, pending_uploads, app_version, received_at
          from sync_reports
         where received_at >= ${since}
         order by tenant_id, user_id, started_at desc, received_at desc
      ),
      totals as (
        select tenant_id,
               user_id,
               count(*)                                        as runs,
               count(*) filter (where outcome = 'failed')      as failed_runs,
               count(*) filter (where outcome = 'partial')     as partial_runs,
               coalesce(sum(rejected), 0)                      as rejected,
               coalesce(sum(conflicts), 0)                     as conflicts,
               coalesce(sum(uploads_failed), 0)                as uploads_failed
          from sync_reports
         where received_at >= ${since}
         group by tenant_id, user_id
      )
      select t.tenant_id, t.user_id, t.runs, t.failed_runs, t.partial_runs, t.rejected, t.conflicts,
             t.uploads_failed, l.outcome as last_outcome, l.queue_depth, l.pending_uploads,
             l.app_version, l.received_at as last_report_at
        from totals t
        join latest l on l.tenant_id = t.tenant_id and l.user_id = t.user_id
       where t.failed_runs > 0 or t.partial_runs > 0 or t.rejected > 0 or t.conflicts > 0
          or t.uploads_failed > 0 or l.queue_depth > 0 or l.pending_uploads > 0
       order by l.received_at desc
       limit ${Math.min(Math.max(limit, 1), 500)}
    `.execute(this.db);

    return rows.rows.map((row) => ({
      tenantId: row.tenant_id,
      userId: row.user_id,
      runs: Number(row.runs),
      failedRuns: Number(row.failed_runs),
      partialRuns: Number(row.partial_runs),
      rejected: Number(row.rejected),
      conflicts: Number(row.conflicts),
      uploadsFailed: Number(row.uploads_failed),
      queueDepth: row.queue_depth,
      pendingUploads: row.pending_uploads,
      lastOutcome: row.last_outcome,
      lastReportAt: row.last_report_at,
      appVersion: row.app_version,
    }));
  }

  /** Background work that has given up, or is about to, across every company. */
  async jobs(since: Date): Promise<JobHealth> {
    const dead = await this.db
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('dead_lettered_at', '>=', since)
      .executeTakeFirstOrThrow();
    const retrying = await this.db
      .selectFrom('jobs')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('status', '=', 'pending')
      .where('attempts', '>', 0)
      .where('last_error', 'is not', null)
      .executeTakeFirstOrThrow();

    return { deadLettered: Number(dead.n), retrying: Number(retrying.n) };
  }
}
