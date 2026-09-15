import { ApiRequestError } from '@integr8/api-client';
import type { LocalDatabase } from '../database.js';
import { RETENTION, type RetentionPolicy } from '../eviction.js';
import {
  clockOffset,
  type DeviceClock,
  measureOffset,
  saveClockOffset,
  serverNow,
} from './clock.js';
import { type RandomBytes, uuidv7 } from './ids.js';
import {
  adoptUnqueuedForms,
  applyPushResults,
  markBatchUnanswered,
  markSent,
  type PushCounts,
  selectBatch,
} from './outbox.js';
import { IdentityChangedError, pullChanges, refreshRequested } from './pull.js';
import type { ByteTransport, FileSource, SyncApi } from './transport.js';
import { dueUploads, NoConnectionError, uploadOne } from './uploads.js';

/**
 * One sync run: send what the phone did, upload its files, fetch what changed.
 *
 * 1. **Push** changes in order, batch after batch, until none is due.
 * 2. **Upload** queued files, two at a time — unless the battery is low and the
 *    engineer did not ask for this run.
 * 3. **Push again**: forms that were waiting for those files can go now.
 * 4. **Pull** changes from the server, and evict what the phone no longer keeps.
 * 5. **Record** the run, and report it and any unreported runs to the server.
 *
 * With no connection the run stops at the first request and records itself as
 * `offline`; nothing is lost and nothing counts as a failed attempt. Runs never
 * overlap: a trigger that arrives during a run is folded into one more run
 * straight after it.
 */

export type SyncTrigger =
  'launch' | 'foreground' | 'reconnect' | 'background' | 'manual' | 'change';

export interface SyncConditions {
  online: boolean;
  networkType: string | null;
  /** 0 to 1, or null when unknown. */
  batteryLevel: number | null;
  charging: boolean;
}

export type SyncActivity =
  | { phase: 'idle' }
  | { phase: 'sending'; sent: number }
  | { phase: 'uploading'; done: number; total: number }
  | { phase: 'receiving'; pages: number };

export interface SyncRunSummary {
  trigger: SyncTrigger;
  outcome: 'complete' | 'partial' | 'offline' | 'failed';
  pushed: number;
  conflicts: number;
  rejected: number;
  retried: number;
  pulled: number;
  uploadsCompleted: number;
  uploadsFailed: number;
  uploadedBytes: number;
  uploadsPaused: 'low_battery' | null;
  /** Paths of local files evicted, for the app to delete from disk. */
  evictedFiles: string[];
  error: unknown;
}

export interface SyncEngineOptions {
  db: LocalDatabase;
  api: SyncApi;
  files: FileSource;
  transport: ByteTransport;
  clock: DeviceClock;
  random: RandomBytes;
  conditions: () => Promise<SyncConditions>;
  appVersion: string | null;
  policy?: RetentionPolicy;
  uploadConcurrency?: number;
  /** Below this battery level, and not charging, uploads wait unless forced. */
  lowBattery?: number;
}

export class SyncEngine {
  readonly #options: SyncEngineOptions;
  readonly #listeners = new Set<() => void>();
  #activity: SyncActivity = { phase: 'idle' };
  #running: Promise<SyncRunSummary> | undefined;
  #again: { trigger: SyncTrigger; force: boolean } | undefined;

  constructor(options: SyncEngineOptions) {
    this.#options = options;
  }

  readonly activity = (): SyncActivity => this.#activity;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  get running(): boolean {
    return this.#running !== undefined;
  }

  /** Runs now, or once more straight after the run in progress. */
  run(options: { trigger: SyncTrigger; force?: boolean }): Promise<SyncRunSummary> {
    const force = options.force ?? false;
    if (this.#running !== undefined) {
      this.#again = {
        trigger: options.trigger,
        force: force || (this.#again?.force ?? false),
      };
      return this.#running;
    }
    this.#running = this.#run(options.trigger, force).finally(() => {
      this.#running = undefined;
      this.#setActivity({ phase: 'idle' });
      const again = this.#again;
      this.#again = undefined;
      if (again !== undefined) {
        void this.run(again);
      }
    });
    return this.#running;
  }

  async #run(trigger: SyncTrigger, force: boolean): Promise<SyncRunSummary> {
    const { db, clock } = this.#options;
    const started = clock.now();
    const summary: SyncRunSummary = {
      trigger,
      outcome: 'complete',
      pushed: 0,
      conflicts: 0,
      rejected: 0,
      retried: 0,
      pulled: 0,
      uploadsCompleted: 0,
      uploadsFailed: 0,
      uploadedBytes: 0,
      uploadsPaused: null,
      evictedFiles: [],
      error: undefined,
    };
    const conditions = await this.#options.conditions();

    if (!conditions.online) {
      summary.outcome = 'offline';
    } else {
      try {
        await adoptUnqueuedForms(this.#options);
        await this.#pushAll(summary);
        await this.#uploadAll(summary, conditions, force);
        await this.#pushAll(summary);
        this.#setActivity({ phase: 'receiving', pages: 0 });
        const pulled = await pullChanges(
          db,
          this.#options.api,
          clock,
          this.#options.policy ?? RETENTION,
        );
        summary.pulled = pulled.workOrders + (await refreshRequested(db, this.#options.api));
        summary.evictedFiles = pulled.evicted.filePaths;
        await db.write(['meta'], async (sql) => {
          await sql.run(
            `insert into meta (key, value) values ('last_sync_success_at', ?)
             on conflict (key) do update set value = excluded.value`,
            [serverNow(clock.now(), await clockOffset(sql)).toISOString()],
          );
        });
        const remaining = await db.read((sql) =>
          sql.get<{ n: number }>(
            `select (select count(*) from outbox where state <> 'done')
                  + (select count(*) from uploads where state <> 'confirmed') as n`,
          ),
        );
        summary.outcome = (remaining?.n ?? 0) === 0 ? 'complete' : 'partial';
      } catch (error) {
        if (error instanceof IdentityChangedError) {
          throw error;
        }
        summary.error = error;
        summary.outcome = isNoConnection(error)
          ? summary.pushed + summary.uploadsCompleted > 0
            ? 'partial'
            : 'offline'
          : 'failed';
      }
    }

    await this.#record(summary, started, conditions);
    if (summary.outcome !== 'offline') {
      await this.#report().catch(() => undefined);
    }
    return summary;
  }

  async #pushAll(summary: SyncRunSummary): Promise<void> {
    const { db, api, clock } = this.#options;
    // A batch the server cannot read at all is sent again one change at a time,
    // so a single change it refuses to parse cannot hold up every other one.
    let batchSize = 50;
    for (let round = 0; round < 100; round += 1) {
      // Chosen and marked as sent in one write, so an autosave made while this
      // batch is on the wire becomes a change of its own instead of being folded
      // into one the server may already have applied.
      const { rows, mutations } = await db.write(['outbox'], async (sql) => {
        const batch = await selectBatch(sql, clock.now(), batchSize);
        await markSent(sql, batch.rows, clock.now());
        return batch;
      });
      if (mutations.length === 0) {
        return;
      }
      this.#setActivity({ phase: 'sending', sent: summary.pushed });
      const sentAt = clock.now();
      let response;
      try {
        response = await api.push({ sentAt: sentAt.toISOString(), mutations });
      } catch (error) {
        if (isNoConnection(error)) {
          throw new NoConnectionError(error);
        }
        if (error instanceof ApiRequestError && (error.status >= 500 || error.status === 429)) {
          await db.write(['outbox'], (sql) =>
            markBatchUnanswered(sql, rows, clock.now(), 'server_error'),
          );
          summary.retried += rows.length;
          return;
        }
        if (error instanceof ApiRequestError && UNREADABLE_BATCH.has(error.status)) {
          if (rows.length > 1) {
            batchSize = 1;
            continue;
          }
          summary.rejected += rows.length;
          await db.write(['outbox', 'submissions', 'meta', 'work_orders'], (sql) =>
            applyPushResults(
              sql,
              rows,
              rows.map((row) => ({
                id: row.id,
                outcome: 'rejected' as const,
                replayed: false,
                code: 'unreadable_change',
                message: error.message,
                details: error.details,
              })),
              clock.now(),
            ),
          );
          continue;
        }
        throw error;
      }
      const receivedAt = clock.now();
      const counts: PushCounts = await db.write(
        ['outbox', 'submissions', 'meta', 'work_orders'],
        async (sql) => {
          await saveClockOffset(sql, measureOffset(response.serverTime, sentAt, receivedAt));
          return applyPushResults(sql, rows, response.results, receivedAt);
        },
      );
      summary.pushed += counts.pushed;
      summary.conflicts += counts.conflicts;
      summary.rejected += counts.rejected;
      summary.retried += counts.retried;
      if (counts.pushed === 0) {
        // Nothing moved: what is left is waiting for time, a file, or a person.
        return;
      }
    }
  }

  async #uploadAll(
    summary: SyncRunSummary,
    conditions: SyncConditions,
    force: boolean,
  ): Promise<void> {
    const { db, api, files, transport, clock } = this.#options;
    const threshold = this.#options.lowBattery ?? 0.15;
    const queued = await dueUploads(db, clock.now(), 100);
    if (queued.length === 0) {
      return;
    }
    if (
      !force &&
      !conditions.charging &&
      conditions.batteryLevel !== null &&
      conditions.batteryLevel < threshold
    ) {
      summary.uploadsPaused = 'low_battery';
      return;
    }

    let next = 0;
    let offline = false;
    let done = 0;
    this.#setActivity({ phase: 'uploading', done, total: queued.length });
    const worker = async () => {
      while (!offline && next < queued.length) {
        const upload = queued[next]!;
        next += 1;
        const outcome = await uploadOne(db, api, files, transport, clock, upload);
        summary.uploadedBytes += outcome.bytesSent;
        switch (outcome.outcome) {
          case 'confirmed':
            summary.uploadsCompleted += 1;
            break;
          case 'failed':
            summary.uploadsFailed += 1;
            break;
          case 'offline':
            offline = true;
            break;
          case 'retry':
            break;
        }
        done += 1;
        this.#setActivity({ phase: 'uploading', done, total: queued.length });
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(this.#options.uploadConcurrency ?? 2, queued.length) }, worker),
    );
    if (offline) {
      throw new NoConnectionError();
    }
  }

  async #record(summary: SyncRunSummary, started: Date, conditions: SyncConditions): Promise<void> {
    const { db, clock, random } = this.#options;
    const finished = clock.now();
    await db.write(['sync_runs'], async (sql) => {
      const offset = await clockOffset(sql);
      const depth = await sql.get<{ changes: number; uploads: number }>(
        `select (select count(*) from outbox where state <> 'done') as changes,
                (select count(*) from uploads where state <> 'confirmed') as uploads`,
      );
      await sql.run(
        `insert into sync_runs (id, started_at, duration_ms, trigger, outcome, pushed, conflicts, rejected, retried,
                                pulled, uploads_completed, uploads_failed, uploaded_bytes, queue_depth,
                                pending_uploads, network_type, clock_offset_ms)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv7(started.getTime(), random),
          serverNow(started, offset).toISOString(),
          Math.max(0, finished.getTime() - started.getTime()),
          summary.trigger,
          summary.outcome,
          summary.pushed,
          summary.conflicts,
          summary.rejected,
          summary.retried,
          summary.pulled,
          summary.uploadsCompleted,
          summary.uploadsFailed,
          summary.uploadedBytes,
          depth?.changes ?? 0,
          depth?.uploads ?? 0,
          conditions.networkType,
          offset,
        ],
      );
    });
  }

  /** Sends runs not yet reported, and forgets reported ones after a week. */
  async #report(): Promise<void> {
    const { db, api, clock } = this.#options;
    const runs = await db.read((sql) =>
      sql.all<{
        id: string;
        started_at: string;
        duration_ms: number;
        trigger: SyncTrigger;
        outcome: SyncRunSummary['outcome'];
        pushed: number;
        conflicts: number;
        rejected: number;
        retried: number;
        pulled: number;
        uploads_completed: number;
        uploads_failed: number;
        uploaded_bytes: number;
        queue_depth: number;
        pending_uploads: number;
        network_type: string | null;
        clock_offset_ms: number | null;
      }>(`select * from sync_runs where reported = 0 order by started_at limit 100`),
    );
    if (runs.length === 0) {
      return;
    }
    await api.reports(
      runs.map((run) => ({
        reportId: run.id,
        startedAt: run.started_at,
        durationMs: run.duration_ms,
        trigger: run.trigger,
        outcome: run.outcome,
        pushed: run.pushed,
        conflicts: run.conflicts,
        rejected: run.rejected,
        retried: run.retried,
        pulled: run.pulled,
        uploadsCompleted: run.uploads_completed,
        uploadsFailed: run.uploads_failed,
        uploadedBytes: run.uploaded_bytes,
        queueDepth: run.queue_depth,
        pendingUploads: run.pending_uploads,
        networkType: run.network_type,
        clockOffsetMs: run.clock_offset_ms,
        appVersion: this.#options.appVersion,
      })),
    );
    const week = new Date(clock.now().getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    await db.write(['sync_runs'], async (sql) => {
      await sql.run(
        `update sync_runs set reported = 1 where id in (select value from json_each(?))`,
        [JSON.stringify(runs.map((run) => run.id))],
      );
      await sql.run(`delete from sync_runs where reported = 1 and started_at < ?`, [week]);
    });
  }

  #setActivity(activity: SyncActivity): void {
    this.#activity = activity;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/** Answers to a push that mean the request itself could not be read. */
const UNREADABLE_BATCH = new Set([400, 413, 422]);

export function isNoConnection(error: unknown): boolean {
  return error instanceof NoConnectionError || error instanceof TypeError;
}
