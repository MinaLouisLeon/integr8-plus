import { getPlatformDataSource } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, startApi } from '../testing/api-harness.js';
import { runTableHousekeeping, TABLE_HOUSEKEEPING_TASK } from './table-housekeeping.js';

/**
 * The worker step: a turn claimed once a night, so several workers make one run.
 * What it deletes is proven in `@integr8/db`'s housekeeping suite.
 */

let api: ApiHarness;
const logger = { info: () => undefined };

beforeAll(async () => {
  api = await startApi();
});

afterAll(async () => {
  await api.close();
});

describe('table housekeeping', () => {
  it('runs once per night however many workers ask', async () => {
    // A forced run (the way an operator would run it by hand) skips the turn.
    await runTableHousekeeping({ logger, workerId: 'test-a', force: true });

    // The first ordinary call takes tonight's turn, unless a run of this suite
    // in the last twenty hours already did; the second finds it taken either way.
    await runTableHousekeeping({ logger, workerId: 'test-a' });
    const second = await runTableHousekeeping({ logger, workerId: 'test-b' });
    expect(second).toEqual({ rateLimitBuckets: 0, idempotencyKeys: 0, loginAttempts: 0 });

    const runs = await getPlatformDataSource().metering.taskRuns();
    const run = runs.find((entry) => entry.task === TABLE_HOUSEKEEPING_TASK);
    expect(run).toBeDefined();
    expect(run?.lastError).toBeNull();
  });
});
