import { toUserId, type UserId } from '@integr8/core';
import { sql } from 'kysely';
import type { SyncOutcome, SyncTrigger } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

/**
 * What a phone needs to catch up, and what it reports back (P12).
 *
 * **The horizon.** Every change is logged in `sync_touches` with the id of the
 * transaction that made it. Transaction ids are handed out when a transaction
 * starts writing, not when it commits, so "every touch with an id above my
 * cursor" would miss a slow transaction that started earlier and committed
 * later. A pull therefore reads only up to the oldest transaction still running
 * (`pg_snapshot_xmin`): everything below that line has finished, committed or
 * not, so the next cursor is that line and nothing between two pulls is ever
 * skipped.
 *
 * **The scope** is the person's own work: jobs they are on now, open or closed
 * within the phone's retention window. A change to a job's site, customer or
 * forms counts as a change to the job.
 */

export interface SyncPageQuery {
  userId: UserId | string;
  /** Closed jobs count only if they closed at or after this. */
  closedSince: Date;
  /** Touches from this transaction id on; `null` for everything in scope. */
  since: string | null;
  /** Touches before this transaction id; from {@link SyncRepository.horizon}. */
  horizon: string;
  /** Resume after this job id, for a pull that spans pages. */
  after?: string;
  limit: number;
}

export interface SyncReportInput {
  reportId: string;
  userId: UserId | string;
  startedAt: Date;
  durationMs: number;
  trigger: SyncTrigger;
  outcome: SyncOutcome;
  pushed: number;
  conflicts: number;
  rejected: number;
  retried: number;
  pulled: number;
  uploadsCompleted: number;
  uploadsFailed: number;
  uploadedBytes: number;
  queueDepth: number;
  pendingUploads: number;
  networkType: string | null;
  clockOffsetMs: number | null;
  appVersion: string | null;
}

const CLOSED_STATES = ['complete', 'reviewed', 'cancelled'] as const;

export class SyncRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** The oldest transaction still running: every touch below it is final. */
  async horizon(): Promise<string> {
    const row = await sql<{ horizon: string }>`
      select pg_snapshot_xmin(pg_current_snapshot())::text as horizon
    `.execute(this.db);
    return row.rows[0]!.horizon;
  }

  /** Touches before this have been pruned; a cursor older than it must start again. */
  async prunedBefore(): Promise<string | undefined> {
    const row = await this.db
      .selectFrom('sync_log_marks')
      .select('pruned_before')
      .where('tenant_id', '=', this.tenantId)
      .executeTakeFirst();
    return row?.pruned_before;
  }

  /**
   * The ids of the person's jobs that changed in the window, a page at a time,
   * in id order. With no `since`, every job in scope.
   */
  async changedWorkOrderIds(query: SyncPageQuery): Promise<{ ids: string[]; more: boolean }> {
    const tenant = this.tenantId;
    const user = toUserId(query.userId);
    let select = this.db
      .selectFrom('work_orders')
      .select('work_orders.id')
      .where('work_orders.tenant_id', '=', tenant)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('work_order_assignments')
            .select(sql`1`.as('one'))
            .where('work_order_assignments.tenant_id', '=', tenant)
            .whereRef('work_order_assignments.work_order_id', '=', 'work_orders.id')
            .where('work_order_assignments.user_id', '=', user)
            .where('work_order_assignments.unassigned_at', 'is', null),
        ),
      )
      .where((eb) =>
        eb.or([
          eb('work_orders.state', 'not in', CLOSED_STATES),
          eb(
            sql<Date>`coalesce(work_orders.completed_at, work_orders.cancelled_at)`,
            '>=',
            query.closedSince,
          ),
        ]),
      );

    if (query.since !== null) {
      const since = query.since;
      const horizon = query.horizon;
      select = select.where((eb) =>
        eb.exists(
          eb
            .selectFrom('sync_touches')
            .select(sql`1`.as('one'))
            .where('sync_touches.tenant_id', '=', tenant)
            .where(sql<boolean>`sync_touches.xid >= ${since}::xid8`)
            .where(sql<boolean>`sync_touches.xid < ${horizon}::xid8`)
            .where((touched) =>
              touched.or([
                touched.and([
                  touched('sync_touches.entity_kind', '=', 'work_order'),
                  touched('sync_touches.entity_id', '=', touched.ref('work_orders.id')),
                ]),
                touched.and([
                  touched('sync_touches.entity_kind', '=', 'site'),
                  touched('sync_touches.entity_id', '=', touched.ref('work_orders.site_id')),
                ]),
                touched.and([
                  touched('sync_touches.entity_kind', '=', 'customer'),
                  touched('sync_touches.entity_id', '=', touched.ref('work_orders.customer_id')),
                ]),
                touched.and([
                  touched('sync_touches.entity_kind', '=', 'form'),
                  touched(
                    'sync_touches.entity_id',
                    'in',
                    touched
                      .selectFrom('work_order_forms')
                      .select('work_order_forms.form_id')
                      .where('work_order_forms.tenant_id', '=', tenant)
                      .whereRef('work_order_forms.work_order_id', '=', 'work_orders.id'),
                  ),
                ]),
              ]),
            ),
        ),
      );
    }

    if (query.after !== undefined) {
      select = select.where('work_orders.id', '>', query.after);
    }

    const rows = await select
      .orderBy('work_orders.id')
      .limit(query.limit + 1)
      .execute();
    return {
      ids: rows.slice(0, query.limit).map((row) => row.id),
      more: rows.length > query.limit,
    };
  }

  /**
   * Jobs touched in the window that the person used to be on and is not now:
   * the phone removes them. A job they were never on is not listed, so the pull
   * reveals nothing about other people's work.
   */
  async removedWorkOrderIds(query: {
    userId: UserId | string;
    since: string;
    horizon: string;
  }): Promise<string[]> {
    const tenant = this.tenantId;
    const user = toUserId(query.userId);
    const rows = await this.db
      .selectFrom('sync_touches')
      .select('sync_touches.entity_id')
      .distinct()
      .where('sync_touches.tenant_id', '=', tenant)
      .where('sync_touches.entity_kind', '=', 'work_order')
      .where(sql<boolean>`sync_touches.xid >= ${query.since}::xid8`)
      .where(sql<boolean>`sync_touches.xid < ${query.horizon}::xid8`)
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('work_order_assignments')
            .select(sql`1`.as('one'))
            .where('work_order_assignments.tenant_id', '=', tenant)
            .whereRef('work_order_assignments.work_order_id', '=', 'sync_touches.entity_id')
            .where('work_order_assignments.user_id', '=', user),
        ),
      )
      .where((eb) =>
        eb.not(
          eb.exists(
            eb
              .selectFrom('work_order_assignments')
              .select(sql`1`.as('one'))
              .where('work_order_assignments.tenant_id', '=', tenant)
              .whereRef('work_order_assignments.work_order_id', '=', 'sync_touches.entity_id')
              .where('work_order_assignments.user_id', '=', user)
              .where('work_order_assignments.unassigned_at', 'is', null),
          ),
        ),
      )
      .orderBy('sync_touches.entity_id')
      .execute();
    return rows.map((row) => row.entity_id);
  }

  /** Removes touches older than `days`; phones behind that start again. */
  async prune(days: number): Promise<number> {
    const row = await sql<{ removed: string }>`
      select prune_sync_touches(${this.tenantId}::uuid, make_interval(days => ${days}))::text as removed
    `.execute(this.db);
    return Number(row.rows[0]!.removed);
  }

  /** Stores a phone's report of a sync run. Sent twice, it is stored once. */
  async recordReport(input: SyncReportInput): Promise<'recorded' | 'duplicate'> {
    const inserted = await this.db
      .insertInto('sync_reports')
      .values({
        tenant_id: this.tenantId,
        user_id: toUserId(input.userId),
        report_id: input.reportId,
        started_at: input.startedAt,
        duration_ms: input.durationMs,
        trigger: input.trigger,
        outcome: input.outcome,
        pushed: input.pushed,
        conflicts: input.conflicts,
        rejected: input.rejected,
        retried: input.retried,
        pulled: input.pulled,
        uploads_completed: input.uploadsCompleted,
        uploads_failed: input.uploadsFailed,
        uploaded_bytes: input.uploadedBytes,
        queue_depth: input.queueDepth,
        pending_uploads: input.pendingUploads,
        network_type: input.networkType,
        clock_offset_ms: input.clockOffsetMs,
        app_version: input.appVersion,
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'report_id']).doNothing())
      .returning('id')
      .executeTakeFirst();
    return inserted === undefined ? 'duplicate' : 'recorded';
  }

  /** Recent reports, newest first. */
  async listReports(options: { userId?: UserId | string; limit?: number } = {}) {
    let select = this.db
      .selectFrom('sync_reports')
      .selectAll()
      .where('tenant_id', '=', this.tenantId);
    if (options.userId !== undefined) {
      select = select.where('user_id', '=', toUserId(options.userId));
    }
    return select
      .orderBy('started_at', 'desc')
      .limit(options.limit ?? 100)
      .execute();
  }
}
