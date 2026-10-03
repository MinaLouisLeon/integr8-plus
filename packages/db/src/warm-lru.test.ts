import { describe, expect, it, vi } from 'vitest';
import { type EvictionReason, WarmLruCache } from './warm-lru.js';

interface Disposal {
  key: string;
  value: string;
  reason: EvictionReason;
}

function build(options: { max?: number; idleMs?: number; now?: () => number } = {}) {
  const disposals: Disposal[] = [];
  const cache = new WarmLruCache<string, string>({
    max: options.max ?? 2,
    idleMs: options.idleMs ?? 60_000,
    ...(options.now === undefined ? {} : { now: options.now }),
    dispose: (value, key, reason) => {
      disposals.push({ key, value, reason });
    },
  });
  return { cache, disposals };
}

describe('capacity', () => {
  it('evicts the least recently used entry', async () => {
    const { cache, disposals } = build({ max: 2 });

    await cache.getOrCreate('a', () => 'A');
    await cache.getOrCreate('b', () => 'B');
    await cache.getOrCreate('c', () => 'C');
    await cache.settled();

    expect(cache.keys()).toEqual(['b', 'c']);
    expect(disposals).toEqual([{ key: 'a', value: 'A', reason: 'capacity' }]);
  });

  it('treats a hit as use, so the untouched entry is the one evicted', async () => {
    const { cache, disposals } = build({ max: 2 });

    await cache.getOrCreate('a', () => 'A');
    await cache.getOrCreate('b', () => 'B');
    await cache.getOrCreate('a', () => 'A2');
    await cache.getOrCreate('c', () => 'C');
    await cache.settled();

    expect(cache.keys()).toEqual(['a', 'c']);
    expect(disposals.map((entry) => entry.key)).toEqual(['b']);
  });

  it('refuses a max below one', () => {
    expect(
      () => new WarmLruCache<string, string>({ max: 0, idleMs: 1, dispose: () => undefined }),
    ).toThrow(/at least 1/u);
  });
});

describe('idle eviction', () => {
  it('evicts entries untouched for longer than idleMs', async () => {
    let clock = 1_000;
    const { cache, disposals } = build({ max: 10, idleMs: 5_000, now: () => clock });

    await cache.getOrCreate('a', () => 'A');
    clock += 3_000;
    await cache.getOrCreate('b', () => 'B');
    clock += 3_000;

    // `a` was last used 6s ago, `b` 3s ago.
    await cache.getOrCreate('c', () => 'C');
    await cache.settled();

    expect(cache.keys()).toEqual(['b', 'c']);
    expect(disposals).toEqual([{ key: 'a', value: 'A', reason: 'idle' }]);
  });

  it('does not evict an entry that is still being used', async () => {
    let clock = 0;
    const { cache, disposals } = build({ max: 10, idleMs: 5_000, now: () => clock });

    await cache.getOrCreate('a', () => 'A');
    for (let i = 0; i < 5; i += 1) {
      clock += 4_000;
      await cache.getOrCreate('a', () => 'A');
    }
    await cache.settled();

    expect(cache.keys()).toEqual(['a']);
    expect(disposals).toEqual([]);
  });
});

describe('single flight', () => {
  it('builds one value for concurrent callers', async () => {
    const { cache } = build({ max: 4 });
    const factory = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      return 'A';
    });

    const results = await Promise.all([
      cache.getOrCreate('a', factory),
      cache.getOrCreate('a', factory),
      cache.getOrCreate('a', factory),
    ]);

    expect(results).toEqual(['A', 'A', 'A']);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('drops a failed entry so the next caller retries', async () => {
    const { cache } = build({ max: 4 });
    const factory = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('connection refused'))
      .mockResolvedValueOnce('A');

    await expect(cache.getOrCreate('a', factory)).rejects.toThrow('connection refused');
    expect(cache.keys()).toEqual([]);

    await expect(cache.getOrCreate('a', factory)).resolves.toBe('A');
    expect(factory).toHaveBeenCalledTimes(2);
  });
});

describe('disposal', () => {
  it('disposes everything on drain and waits for it', async () => {
    const disposed: string[] = [];
    const cache = new WarmLruCache<string, string>({
      max: 10,
      idleMs: 60_000,
      dispose: async (value) => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        disposed.push(value);
      },
    });

    await cache.getOrCreate('a', () => 'A');
    await cache.getOrCreate('b', () => 'B');
    await cache.drain();

    expect(disposed.sort()).toEqual(['A', 'B']);
    expect(cache.size).toBe(0);
  });

  it('reports a failing dispose without failing the caller', async () => {
    const onDisposeError = vi.fn();
    const cache = new WarmLruCache<string, string>({
      max: 1,
      idleMs: 60_000,
      onDisposeError,
      dispose: () => {
        throw new Error('pool.end() failed');
      },
    });

    await cache.getOrCreate('a', () => 'A');
    await expect(cache.getOrCreate('b', () => 'B')).resolves.toBe('B');
    await cache.settled();

    expect(onDisposeError).toHaveBeenCalledOnce();
    expect(onDisposeError.mock.calls[0]?.[1]).toBe('a');
  });

  it('disposes on explicit delete', async () => {
    const { cache, disposals } = build({ max: 4 });

    await cache.getOrCreate('a', () => 'A');
    expect(cache.delete('a')).toBe(true);
    expect(cache.delete('a')).toBe(false);
    await cache.settled();

    expect(disposals).toEqual([{ key: 'a', value: 'A', reason: 'explicit' }]);
  });
});
