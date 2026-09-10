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
}

export class Worker {
  readonly #config: ApiConfig;
  readonly #logger: Logger;
  readonly #handlers: JobHandlers;
  readonly #workerId: string;
  readonly #now: () => Date;
  #running = false;

  constructor(options: WorkerOptions) {
    this.#config = options.config;
    this.#logger = options.logger;
    this.#handlers = options.handlers;
    this.#workerId = options.workerId ?? `worker-${process.pid.toString()}`;
    this.#now = options.now ?? (() => new Date());
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
      now: this.#now(),
    });

    const result: WorkerRunResult = {
      claimed: jobs.length,
      succeeded: 0,
      retrying: 0,
      dead: 0,
    };

    for (const job of jobs) {
      const outcome = await this.#execute(job);
      if (outcome === 'succeeded') {
        result.succeeded += 1;
      } else if (outcome === 'retrying') {
        result.retrying += 1;
      } else {
        result.dead += 1;
      }
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

  async #execute(job: ClaimedJob): Promise<'succeeded' | 'retrying' | 'dead'> {
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
      await platform.jobs.fail(job.id, {
        error: `No handler registered for queue "${job.queue}"`,
        retryAt: this.#now(),
        now: this.#now(),
      });
      return 'dead';
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

      await platform.jobs.complete(job.id, this.#now());
      logger.info('Job completed');
      return 'succeeded';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = await platform.jobs.fail(job.id, {
        error: message,
        retryAt: new Date(
          this.#now().getTime() +
            retryDelayMs(job.attempts, {
              baseMs: this.#config.WORKER_RETRY_BASE_MS,
              maxMs: this.#config.WORKER_RETRY_MAX_MS,
            }),
        ),
        now: this.#now(),
      });

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
