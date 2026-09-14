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
