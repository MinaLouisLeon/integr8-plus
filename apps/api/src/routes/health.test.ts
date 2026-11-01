import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PublicRequestContext } from '../http/routes.js';

const schemaCheck = vi.hoisted(() => vi.fn());

vi.mock('@integr8/db', () => ({ assertSchemaUpToDate: schemaCheck }));

const { readinessRoute, READINESS_CACHE_MS, resetReadinessCache } = await import('./health.js');

/**
 * Readiness is called by Docker every fifteen seconds and by the heartbeat
 * every few minutes. It reads the migration history over the API's own pool,
 * and keeps the answer for ten seconds so a burst of calls is one query.
 */

const context = {
  config: { API_RELEASE: '1.2.2', APP_ENV: 'test' },
} as unknown as PublicRequestContext;

async function ask(): Promise<{ status: number; body: unknown }> {
  return readinessRoute.handler({ params: {}, query: {}, body: {} }, context);
}

beforeEach(() => {
  vi.useFakeTimers();
  resetReadinessCache();
  schemaCheck.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('readiness', () => {
  it('checks once, and reuses the answer for ten seconds', async () => {
    schemaCheck.mockResolvedValue({ aheadOfBuild: [] });

    expect((await ask()).status).toBe(200);
    await ask();
    vi.advanceTimersByTime(READINESS_CACHE_MS - 1);
    await ask();
    expect(schemaCheck).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    await ask();
    expect(schemaCheck).toHaveBeenCalledTimes(2);
  });

  it('keeps a failure for the same ten seconds, then looks again', async () => {
    schemaCheck.mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
    schemaCheck.mockResolvedValue({ aheadOfBuild: [] });

    const failed = await ask();
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).toMatch(/ECONNREFUSED/u);
    expect((await ask()).status).toBe(503);

    vi.advanceTimersByTime(READINESS_CACHE_MS);
    expect((await ask()).status).toBe(200);
  });
});
