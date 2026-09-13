import { describe, expect, it } from 'vitest';
import { retryDelayMs } from './worker.js';

const options = { baseMs: 5000, maxMs: 3_600_000 };

describe('retry backoff', () => {
  it('doubles with each attempt', () => {
    // `random: () => 1` picks the top of the jitter range, which is the
    // exponential value itself.
    const ceiling = (attempt: number) => retryDelayMs(attempt, { ...options, random: () => 1 });

    expect(ceiling(1)).toBe(5000);
    expect(ceiling(2)).toBe(10_000);
    expect(ceiling(3)).toBe(20_000);
    expect(ceiling(4)).toBe(40_000);
  });

  it('stops doubling at the ceiling', () => {
    // Otherwise attempt 30 schedules a retry in the year 2200.
    expect(retryDelayMs(30, { ...options, random: () => 1 })).toBe(3_600_000);
  });

  it('never returns a negative delay, whatever attempt number arrives', () => {
    for (const attempt of [0, -1, 1]) {
      expect(retryDelayMs(attempt, { ...options, random: () => 1 })).toBeGreaterThanOrEqual(0);
    }
  });

  it('applies full jitter, not a fixed delay', () => {
    /**
     * Doubling alone synchronises retries: everything that failed during a
     * two-minute outage retries together the moment it ends, which is how a
     * recovering dependency gets knocked over a second time.
     *
     * Full jitter — a random point in `[0, delay]` rather than `delay ± a bit`
     * — spreads the earliest retries widest, and the earliest retries are the
     * ones that arrive while the dependency is still fragile.
     */
    const delays = Array.from({ length: 200 }, () => retryDelayMs(4, options));

    expect(Math.min(...delays)).toBeLessThan(10_000);
    expect(Math.max(...delays)).toBeGreaterThan(30_000);
    expect(new Set(delays).size).toBeGreaterThan(50);
  });

  it('keeps every jittered delay inside the exponential bound', () => {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const bound = Math.min(options.baseMs * 2 ** (attempt - 1), options.maxMs);
      for (let sample = 0; sample < 50; sample += 1) {
        const delay = retryDelayMs(attempt, options);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(bound);
      }
    }
  });

  it('returns whole milliseconds', () => {
    // The value becomes a timestamp; a fractional millisecond is noise.
    expect(Number.isInteger(retryDelayMs(3, options))).toBe(true);
  });
});
