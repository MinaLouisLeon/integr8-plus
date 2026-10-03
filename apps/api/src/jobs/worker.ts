import { type ClaimedJob, getPlatformDataSource, withTenant } from '@integr8/db';
import type { ApiConfig } from '../config.js';
import type { Logger } from '../http/logger.js';
import { captureException } from '../observability/sentry.js';

/**
 * The background worker.
 *
 * Claims jobs across every company, runs each one inside its own tenant
 * transaction, and decides what to do when one fails. The claim is the only
 * privileged step — see `claimJobs` in `@integr8/db` for why it has to be.
 */

export interface JobContext {
  /** The company this job belongs to. Already scoped by the caller. */
  tenantId: string;
  jobId: string;
  attempt: number;
  logger: Logger;
}

export type JobHandler = (payload: Record<string, unknown>, context: JobContext) => Promise<void>;

export type JobHandlers = Readonly<Record<string, JobHandler>>;

export interface WorkerOptions {
  config: ApiConfig;
  logger: Logger;
  handlers: JobHandlers;
  workerId?: string;
  now?: () => Date;
}

/**
 * Exponential backoff with full jitter.
 *
 * Doubling alone synchronises retries: everything that failed during a
 * two-minute outage retries together the moment it ends, which is how a
 * recovering dependency is knocked over a second time. Jitter spreads them.
 *
 * "Full" jitter — a random point in `[0, delay]` rather than `delay ± a bit` —
 * because it spreads the earliest retries widest, and the earliest retries are
 * the ones that arrive while the dependency is still fragile.
 */
export function retryDelayMs(
  attempt: number,
  options: { baseMs: number; maxMs: number; random?: () => number },
): number {
  const exponential = Math.min(options.baseMs * 2 ** Math.max(0, attempt - 1), options.maxMs);
  return Math.floor((options.random ?? Math.random)() * exponential);
}

export interface WorkerRunResult {
  claimed: number;
  succeeded: number;
  retrying: number;
  dead: number;
  /** Finished after the lease had been taken over; the result went nowhere. */
  lost: number;
}

export class Worker {
  readonly #config: ApiConfig;
  readonly #logger: Logger;
  readonly #handlers: JobHandlers;
  readonly #workerId: string;
  /**
   * A test's clock, or nothing.
   *
   * Nothing is the production case, and it matters that it stays nothing: the
   * queue compares `available_at` and leases against the database's `now()`
   * when it is given no time, and against this process's when it is. Passing
   * `new Date()` here would put two clocks on either side of every comparison,
   * which is the bug `claimJobs` describes — and which this worker reintroduced
   * for a while by always handing one over.
   */
  readonly #now: (() => Date) | undefined;
  #running = false;

  constructor(options: WorkerOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#handlers = options.handlers;
    this.#workerId = options.workerId ?? `worker-${process.pid.toString()}`;
    this.#now = options.now;
  }

  /** The injected clock as a `now` option, or no option at all. */
  #injectedNow(): { now?: Date } {
    return this.#now === undefined ? {} : { now: this.#now() };
  }

  #clock(): Date {
    return this.#now?.() ?? new Date();
  }

  /**
   * Who this worker is, in the `locked_by` column and in a claimed task's row.
   *
   * Exposed because the housekeeping that runs beside the queue claims its turn
   * under the same name, so one worker's two kinds of work are traceable to one
   * process.
   */
  get id(): string {
    return this.#workerId;
  }

  /**
   * Claims one batch and works through it.
   *
   * Exposed separately from {@link run} so the integration suite can drive the
   * worker a batch at a time instead of racing a polling loop.
   */
  async runOnce(): Promise<WorkerRunResult> {
    const platform = getPlatformDataSource();
    const jobs = await platform.jobs.claim({
      workerId: this.#workerId,
      limit: this.#config.WORKER_BATCH_SIZE,
      leaseMs: this.#config.WORKER_LEASE_MS,
      ...this.#injectedNow(),
    });

    const result: WorkerRunResult = {
      claimed: jobs.length,
      succeeded: 0,
      retrying: 0,
      dead: 0,
      lost: 0,
    };

    for (const job of jobs) {
      const outcome = await this.#execute(job);
      result[outcome] += 1;
    }

    return result;
  }

  /** Polls until {@link stop} is called. */
  async run(): Promise<void> {
    this.#running = true;
    this.#logger.info('Worker started', {
      workerId: this.#workerId,
      queues: Object.keys(this.#handlers),
    });

    while (this.#running) {
      try {
        const result = await this.runOnce();
        if (result.claimed === 0) {
          await sleep(this.#config.WORKER_IDLE_POLL_MS);
        }
      } catch (error) {
        // A failure to *claim* is different from a failure to run a job: the
        // queue itself is unreachable. Back off rather than spinning against a
        // database that is already having a bad time.
        this.#logger.error('Worker poll failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        captureException(error, { workerId: this.#workerId });
        await sleep(this.#config.WORKER_IDLE_POLL_MS);
      }
    }

    this.#logger.info('Worker stopped', { workerId: this.#workerId });
  }

  stop(): void {
    this.#running = false;
  }

  async #execute(job: ClaimedJob): Promise<'succeeded' | 'retrying' | 'dead' | 'lost'> {
    const platform = getPlatformDataSource();
    const logger = this.#logger.child({
      jobId: job.id,
      tenantId: job.tenantId,
      queue: job.queue,
      attempt: job.attempts,
    });

    const handler = this.#handlers[job.queue];
    if (handler === undefined) {
      // A job for a queue this build does not know. Dead-lettering rather than
      // retrying is right: another attempt will not teach this process a
      // handler, and the payload is preserved for whoever deploys the version
      // that has one.
      logger.error('No handler for queue');
      const outcome = await platform.jobs.fail(job.id, {
        error: `No handler registered for queue "${job.queue}"`,
        retryAt: this.#clock(),
        workerId: this.#workerId,
        ...this.#injectedNow(),
      });
      return outcome === 'lost' ? 'lost' : 'dead';
    }

    try {
      // The job runs inside a tenant transaction, so RLS is armed and the
      // handler reaches the same repositories a request would. The privilege
      // used to claim it stops here.
      await withTenant(job.tenantId, async () => {
        await handler(job.payload, {
          tenantId: job.tenantId,
          jobId: job.id,
          attempt: job.attempts,
          logger,
        });
      });

      const completed = await platform.jobs.complete(job.id, {
        workerId: this.#workerId,
        ...(this.#now === undefined ? {} : { at: this.#now() }),
      });
      if (!completed) {
        // The handler took longer than the lease, and another worker has the
        // job now. Whatever this one did is done; the row is not ours to mark,
        // and marking it would hide a second run of the same job.
        logger.warn('Job finished after its lease was taken over', { attempts: job.attempts });
        return 'lost';
      }
      logger.info('Job completed');
      return 'succeeded';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = await platform.jobs.fail(job.id, {
        error: message,
        retryAt: new Date(
          this.#clock().getTime() +
            retryDelayMs(job.attempts, {
              baseMs: this.#config.WORKER_RETRY_BASE_MS,
              maxMs: this.#config.WORKER_RETRY_MAX_MS,
            }),
        ),
        workerId: this.#workerId,
        ...this.#injectedNow(),
      });

      if (outcome === 'lost') {
        logger.warn('Job failed after its lease was taken over', {
          error: message,
          attempts: job.attempts,
        });
        return 'lost';
      }

      if (outcome === 'dead') {
        // The dead-letter queue is a status, not a second table, so the payload
        // and the last error stay with the job for whoever looks at it.
        logger.error('Job dead-lettered', { error: message, attempts: job.attempts });
        captureException(error, { jobId: job.id, tenantId: job.tenantId, queue: job.queue });
      } else {
        logger.warn('Job failed; will retry', { error: message, attempts: job.attempts });
      }

      return outcome;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
