import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformDataSource, withTenant } from '../connection.js';
import {
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
} from './harness.js';

/**
 * The job queue's claim, against a real database, for a worker that dies.
 *
 * Found in P09: a job whose worker stopped during its final attempt came back
 * when its lease ran out, and claiming it again pushed its attempt count past
 * the limit `jobs_attempts_sane` enforces. The refusal failed the whole claim —
 * so no job, for any company, could be claimed again.
 */

let tenant: TenantFixture;
const queue = () => getPlatformDataSource().jobs;
const MINUTE = 60_000;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  tenant = await createTenant('jobs');
});

afterAll(async () => {
  await releaseTestDatabase();
});

describe('claiming jobs', () => {
  it('dead-letters a job whose worker died on its last attempt, and carries on with the rest', async () => {
    const start = new Date();
    const doomed = await withTenant(tenant.id, (tx) =>
      tx.jobs.enqueue({
        queue: 'media.thumbnail',
        payload: { n: 1 },
        availableAt: start,
        maxAttempts: 2,
      }),
    );

    // Two attempts, each abandoned: the worker is killed and never reports back.
    for (const offset of [0, 2]) {
      const claimed = await queue().claim({
        workerId: `doomed-${String(offset)}`,
        leaseMs: MINUTE,
        now: new Date(start.getTime() + offset * MINUTE),
      });
      expect(claimed.map((job) => job.id)).toEqual([doomed.id]);
    }

    const healthy = await withTenant(tenant.id, (tx) =>
      tx.jobs.enqueue({ queue: 'audit.record', availableAt: start }),
    );

    const later = new Date(start.getTime() + 10 * MINUTE);
    const claimed = await queue().claim({ workerId: 'survivor', now: later });
    expect(claimed.map((job) => job.id)).toEqual([healthy.id]);
    await queue().complete(healthy.id);

    const dead = await withTenant(tenant.id, (tx) => tx.jobs.findById(doomed.id));
    expect(dead).toMatchObject({
      status: 'dead',
      attempts: 2,
      lockedBy: null,
      lastError: 'The worker stopped during the final attempt.',
    });
    expect(dead?.deadLetteredAt).toEqual(later);
  });

  /**
   * The path a real worker takes: no injected clock.
   *
   * Every other test here hands `claim` a `now`, which is exactly why this bug
   * lived so long — the injected path was covered and the production one was
   * not. A job enqueued with no `availableAt` takes Postgres's `now()`, and the
   * claim has to judge it against the same clock. When it used this process's
   * instead, a job could be written a fraction into its own future and sit
   * there until the two clocks agreed.
   *
   * This asserts the behaviour rather than reproducing the race: the skew is
   * sub-millisecond and cannot be created on demand. What it does guarantee is
   * that the production path is exercised at all, and that a job enqueued a
   * moment ago is claimable now.
   */
  it('claims a job enqueued a moment ago, using the database’s clock and not this one', async () => {
    const job = await withTenant(tenant.id, (tx) =>
      // No `availableAt`: the column takes `now()` from Postgres, which is the
      // whole point — the two sides of the comparison must be one clock.
      tx.jobs.enqueue({ queue: 'audit.record', payload: { immediate: true } }),
    );

    const claimed = await queue().claim({ workerId: 'no-injected-clock' });

    expect(claimed.map((row) => row.id)).toContain(job.id);
    await queue().complete(job.id);
  });

  it('writes a lease from the database’s clock, and reports the one it wrote', async () => {
    const job = await withTenant(tenant.id, (tx) =>
      tx.jobs.enqueue({ queue: 'audit.record', payload: { lease: true } }),
    );

    const [claimed] = await queue().claim({ workerId: 'leases', leaseMs: MINUTE });
    expect(claimed?.id).toBe(job.id);

    // What the worker is told is what the row says. A worker honouring its own
    // idea of the lease would renew or abandon at a different moment from the
    // one another worker reads off the row when deciding whether to steal it.
    const stored = await withTenant(tenant.id, (tx) => tx.jobs.findById(job.id));
    expect(claimed?.lockedUntil).toEqual(stored?.lockedUntil);

    // And it is a minute away from when the database claimed it, not from when
    // this process asked.
    const gap = (claimed?.lockedUntil.getTime() ?? 0) - (stored?.updatedAt.getTime() ?? 0);
    expect(gap).toBe(MINUTE);

    await queue().complete(job.id);
  });

  it('ignores a completion or a failure from a worker whose lease has been taken over', async () => {
    const start = new Date(Date.now() + 60 * MINUTE);
    const job = await withTenant(tenant.id, (tx) =>
      tx.jobs.enqueue({ queue: 'media.thumbnail', availableAt: start, maxAttempts: 3 }),
    );
    await queue().claim({ workerId: 'slow', now: start, leaseMs: MINUTE });
    const [taken] = await queue().claim({
      workerId: 'fast',
      now: new Date(start.getTime() + 2 * MINUTE),
    });
    expect(taken?.id).toBe(job.id);

    // The slow worker finishes late. Whatever it says, the row is no longer
    // its to say it about: a "succeeded" would hide the run in progress, and a
    // "pending" would hand the job to a third worker while the second has it.
    expect(await queue().complete(job.id, { workerId: 'slow' })).toBe(false);
    expect(await queue().fail(job.id, { workerId: 'slow', error: 'late', retryAt: start })).toBe(
      'lost',
    );

    const stored = await withTenant(tenant.id, (tx) => tx.jobs.findById(job.id));
    expect(stored).toMatchObject({ status: 'running', lockedBy: 'fast', attempts: 2 });

    // The holder's word still counts.
    expect(await queue().complete(job.id, { workerId: 'fast' })).toBe(true);
  });

  it('decides exhaustion and the failure in one statement', async () => {
    const job = await withTenant(tenant.id, (tx) =>
      tx.jobs.enqueue({ queue: 'media.thumbnail', maxAttempts: 1 }),
    );
    const [claimed] = await queue().claim({ workerId: 'once' });
    expect(claimed?.id).toBe(job.id);

    expect(
      await queue().fail(job.id, { workerId: 'once', error: 'no good', retryAt: new Date() }),
    ).toBe('dead');

    const stored = await withTenant(tenant.id, (tx) => tx.jobs.findById(job.id));
    expect(stored).toMatchObject({ status: 'dead', lockedBy: null, lastError: 'no good' });
    expect(stored?.deadLetteredAt).not.toBeNull();
  });

  it('still reclaims a job whose worker died with attempts to spare', async () => {
    const start = new Date(Date.now() + 60 * MINUTE);
    const job = await withTenant(tenant.id, (tx) =>
      tx.jobs.enqueue({ queue: 'media.thumbnail', availableAt: start, maxAttempts: 3 }),
    );
    await queue().claim({ workerId: 'first', now: start, leaseMs: MINUTE });
    const again = await queue().claim({
      workerId: 'second',
      now: new Date(start.getTime() + 2 * MINUTE),
    });
    expect(again.map((claimed) => [claimed.id, claimed.attempts])).toEqual([[job.id, 2]]);
  });
});
