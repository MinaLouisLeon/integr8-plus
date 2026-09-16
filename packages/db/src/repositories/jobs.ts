import { type TenantId, toTenantId } from '@integr8/core';
import { type Kysely, type Selectable, sql } from 'kysely';
import { type Database, type JobStatus, type JobsTable, jobStatusSchema } from '../schema.js';
import { TenantScopedRepository, type TenantScope } from './tenant-scope.js';

export interface Job {
  id: string;
  tenantId: TenantId;
  queue: string;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  availableAt: Date;
  lockedBy: string | null;
  lockedUntil: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
  deadLetteredAt: Date | null;
}

export interface EnqueueJobInput {
  queue: string;
  payload?: Record<string, unknown>;
  /** Delay before the job first becomes eligible. */
  availableAt?: Date;
  maxAttempts?: number;
}

/**
 * Background work for one company.
 *
 * Enqueuing is an ordinary tenant operation: it happens inside the same
 * transaction as whatever caused it, so a job cannot outlive a rolled-back
 * change. Claiming is not — see {@link claimJobs}.
 */
export class JobsRepository extends TenantScopedRepository {
  constructor(scope: TenantScope) {
    super(scope);
  }

  /** The one place a `jobs` read is scoped. */
  #scoped() {
    return this.db.selectFrom('jobs').where('jobs.tenant_id', '=', this.tenantId);
  }

  async enqueue(input: EnqueueJobInput): Promise<Job> {
    const row = await this.db
      .insertInto('jobs')
      .values({
        tenant_id: this.tenantId,
        queue: input.queue,
        payload: input.payload ?? {},
        ...(input.availableAt === undefined ? {} : { available_at: input.availableAt }),
        ...(input.maxAttempts === undefined ? {} : { max_attempts: input.maxAttempts }),
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toDomain(row);
  }

  async findById(jobId: string): Promise<Job | undefined> {
    const row = await this.#scoped().selectAll().where('id', '=', jobId).executeTakeFirst();
    return row === undefined ? undefined : toDomain(row);
  }

  async list(options: { status?: JobStatus; queue?: string; limit?: number } = {}): Promise<Job[]> {
    let query = this.#scoped().selectAll().orderBy('created_at', 'desc');

    if (options.status !== undefined) {
      query = query.where('status', '=', jobStatusSchema.parse(options.status));
    }
    if (options.queue !== undefined) {
      query = query.where('queue', '=', options.queue);
    }

    return (await query.limit(options.limit ?? 100).execute()).map(toDomain);
  }

  /** The dead-letter queue: work that exhausted its attempts and needs a person. */
  async listDeadLettered(limit = 100): Promise<Job[]> {
    return (
      await this.#scoped()
        .selectAll()
        .where('status', '=', 'dead')
        .orderBy('dead_lettered_at', 'desc')
        .limit(limit)
        .execute()
    ).map(toDomain);
  }

  /**
   * Puts a dead job back on the queue with its attempt count reset.
   *
   * The usual reason a job dies is a bug or an outage rather than bad data, so
   * the operation that matters after a fix is "run these again".
   */
  async requeue(jobId: string, at: Date = new Date()): Promise<boolean> {
    const result = await this.db
      .updateTable('jobs')
      .set({
        status: 'pending',
        attempts: 0,
        available_at: at,
        locked_by: null,
        locked_until: null,
        dead_lettered_at: null,
      })
      .where('tenant_id', '=', this.tenantId)
      .where('id', '=', jobId)
      .where('status', '=', 'dead')
      .executeTakeFirst();

    return (result.numUpdatedRows ?? 0n) > 0n;
  }
}

// ---------------------------------------------------------------------------
// The worker side
// ---------------------------------------------------------------------------

export interface ClaimedJob extends Job {
  /** The lease this worker holds. Renew or finish before it lapses. */
  lockedUntil: Date;
}

/**
 * Claims jobs across every company.
 *
 * This is the one operation in the queue that cannot be tenant-scoped: a worker
 * polls for whatever work exists, and "whatever exists" spans companies. It
 * therefore runs on the **owner** connection, where RLS does not apply — and
 * each job it returns is executed inside a tenant transaction for that job's
 * own `tenant_id`, so the privilege stops at the claim.
 *
 * `for update skip locked` is what makes several workers safe together: each
 * takes rows nobody else has locked instead of queueing behind them.
 *
 * The lock is a lease with an expiry, not a lock held for the duration. A
 * worker that is killed mid-job would otherwise leave its rows locked forever;
 * the lease lapsing is what lets another worker pick them up.
 */
export async function claimJobs(
  db: Kysely<Database>,
  options: { workerId: string; limit?: number; leaseMs?: number; now?: Date },
): Promise<ClaimedJob[]> {
  const leaseMs = options.leaseMs ?? 60_000;

  // The database's clock, unless a test injects one.
  //
  // `available_at` is filled by Postgres — `now()` is its default, and every
  // enqueue takes it — so comparing it against a `Date` from this process
  // compares two clocks that are not the same clock. Measured against the test
  // database, Postgres can read a millisecond ahead of Node *after* the round
  // trip, which is enough that a job enqueued a moment ago is not yet
  // claimable. That is how this surfaced: a push notification that
  // intermittently never arrived, because the job to send it had been written
  // into the future.
  //
  // Every timestamp in the statement comes from the same clock for the same
  // reason. A lease written from one worker's clock and judged expired by
  // another's is the same bug wearing a different hat, and with several workers
  // it decides whether a job is stolen mid-flight or left stuck.
  const now = options.now === undefined ? sql<Date>`now()` : sql<Date>`${options.now}::timestamptz`;
  const leaseUntil =
    options.now === undefined
      ? sql<Date>`now() + make_interval(secs => ${leaseMs / 1000})`
      : sql<Date>`${new Date(options.now.getTime() + leaseMs)}::timestamptz`;

  // A job whose lease ran out on its final attempt was never failed — its
  // worker died holding it — so it is dead-lettered here rather than claimed.
  // Claimed, its attempt count would pass the limit the table enforces, and that
  // refusal would fail the whole statement: one such job would stop every
  // company's queue.
  const result = await sql<Selectable<JobsTable>>`
    with exhausted as (
      update jobs
         set status           = 'dead',
             last_error       = coalesce(jobs.last_error, 'The worker stopped during the final attempt.'),
             locked_by        = null,
             locked_until     = null,
             dead_lettered_at = ${now},
             updated_at       = ${now}
       where status = 'running'
         and locked_until <= ${now}
         and attempts >= max_attempts
      returning id
    ),
    claimable as (
      select id
      from jobs
      where status in ('pending', 'running')
        and available_at <= ${now}
        and (locked_until is null or locked_until <= ${now})
        and attempts < max_attempts
      order by available_at, created_at
      limit ${options.limit ?? 10}
      for update skip locked
    )
    update jobs
       set status       = 'running',
           attempts     = jobs.attempts + 1,
           locked_by    = ${options.workerId},
           locked_until = ${leaseUntil},
           updated_at   = ${now}
      from claimable
     where jobs.id = claimable.id
    returning jobs.*
  `.execute(db);

  return result.rows.map(toClaimed);
}

function toClaimed(row: Selectable<JobsTable>): ClaimedJob {
  const job = toDomain(row);
  if (job.lockedUntil === null) {
    // Cannot happen: the statement above sets a lease on every row it returns.
    // If it ever does, the statement has changed and this type is a lie, which
    // is worth a loud failure rather than a worker holding a lease of `null`.
    throw new Error(`Job ${job.id} was claimed without a lease`);
  }

  // Read back from the row rather than recomputed here, because the database
  // worked it out. A worker that honoured its own idea of the lease would renew
  // or abandon at a different moment from the one the row says.
  return { ...job, lockedUntil: job.lockedUntil };
}

/** Marks a claimed job done. Runs on the owner connection, like the claim. */
export async function completeJob(
  db: Kysely<Database>,
  jobId: string,
  at: Date = new Date(),
): Promise<void> {
  await db
    .updateTable('jobs')
    .set({
      status: 'succeeded',
      completed_at: at,
      locked_by: null,
      locked_until: null,
      last_error: null,
    })
    .where('id', '=', jobId)
    .execute();
}

export interface FailJobOptions {
  error: string;
  /** When to try again. Computed by the worker's backoff policy. */
  retryAt: Date;
  now?: Date;
}

/**
 * Records a failed attempt, and either schedules a retry or dead-letters it.
 *
 * The decision is made here rather than by the caller so that "attempts
 * exhausted" is one rule in one place, and so a worker that crashes between
 * failing and rescheduling leaves the row in a state the next poll understands.
 */
export async function failJob(
  db: Kysely<Database>,
  jobId: string,
  options: FailJobOptions,
): Promise<'retrying' | 'dead'> {
  const now = options.now ?? new Date();

  const job = await db
    .selectFrom('jobs')
    .select(['attempts', 'max_attempts'])
    .where('id', '=', jobId)
    .executeTakeFirst();

  const exhausted = job === undefined || job.attempts >= job.max_attempts;

  await db
    .updateTable('jobs')
    .set({
      status: exhausted ? 'dead' : 'pending',
      last_error: options.error.slice(0, 4000),
      locked_by: null,
      locked_until: null,
      available_at: options.retryAt,
      dead_lettered_at: exhausted ? now : null,
    })
    .where('id', '=', jobId)
    .execute();

  return exhausted ? 'dead' : 'retrying';
}

function toDomain(row: Selectable<JobsTable>): Job {
  return {
    id: row.id,
    tenantId: toTenantId(row.tenant_id),
    queue: row.queue,
    payload: row.payload,
    status: jobStatusSchema.parse(row.status),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    availableAt: row.available_at,
    lockedBy: row.locked_by,
    lockedUntil: row.locked_until,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    deadLetteredAt: row.dead_lettered_at,
  };
}
