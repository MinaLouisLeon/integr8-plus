/**
 * A bounded, idle-evicting LRU of expensive-to-build, expensive-to-discard
 * things — in this package, one entry per tenant data source.
 *
 * Three properties that a plain `Map` does not give and this code depends on:
 *
 * - **Bounded.** Tenant count grows with sales. An unbounded cache of
 *   connection pools is a file-descriptor exhaustion waiting for the month the
 *   product does well.
 * - **Disposing.** Eviction must close what it evicts. Today a tenant entry
 *   holds a handle onto the shared pool and disposal is free; after P35 an
 *   entry may own a real pool, and dropping the reference without closing it
 *   leaks connections until Postgres refuses new ones.
 * - **Single-flight.** Two concurrent requests for the same cold tenant must
 *   build one pool, not two. The in-flight promise is stored, not the resolved
 *   value.
 *
 * Idle entries are swept on access rather than on a timer, so an idle process
 * has nothing scheduled keeping it alive.
 */

export type EvictionReason = 'capacity' | 'idle' | 'explicit' | 'shutdown';

export interface WarmLruOptions<K, V> {
  /** Maximum live entries. The least recently used is evicted beyond this. */
  max: number;
  /** An entry untouched for this long is evicted on the next access. */
  idleMs: number;
  /** Called for every entry that leaves the cache, for any reason. */
  dispose: (value: V, key: K, reason: EvictionReason) => Promise<void> | void;
  /** Injectable clock. Tests use it; production does not pass it. */
  now?: () => number;
  /**
   * Called when `dispose` throws. Closing a pool failing must not take down the
   * request that happened to trigger the eviction.
   */
  onDisposeError?: (error: unknown, key: K, reason: EvictionReason) => void;
}

interface Entry<V> {
  value: Promise<V>;
  lastUsedAt: number;
}

export class WarmLruCache<K, V> {
  readonly #entries = new Map<K, Entry<V>>();
  readonly #pending = new Set<Promise<void>>();
  readonly #max: number;
  readonly #idleMs: number;
  readonly #dispose: WarmLruOptions<K, V>['dispose'];
  readonly #now: () => number;
  readonly #onDisposeError: (error: unknown, key: K, reason: EvictionReason) => void;

  constructor(options: WarmLruOptions<K, V>) {
    if (options.max < 1) {
      throw new Error(`WarmLruCache max must be at least 1, received ${String(options.max)}`);
    }
    this.#max = options.max;
    this.#idleMs = options.idleMs;
    this.#dispose = options.dispose;
    this.#now = options.now ?? Date.now;
    this.#onDisposeError =
      options.onDisposeError ??
      ((error, key, reason) => {
        console.error(`Failed to dispose cache entry ${String(key)} (${reason})`, error);
      });
  }

  get size(): number {
    return this.#entries.size;
  }

  /** Keys, least recently used first. Exposed for tests and diagnostics. */
  keys(): K[] {
    return [...this.#entries.keys()];
  }

  has(key: K): boolean {
    this.#sweepIdle();
    return this.#entries.has(key);
  }

  /**
   * Returns the cached value, building it with `factory` if absent.
   *
   * Concurrent calls for the same absent key share one `factory` invocation. If
   * `factory` rejects, the entry is removed so the next caller retries rather
   * than inheriting a permanently poisoned slot.
   */
  async getOrCreate(key: K, factory: (key: K) => Promise<V> | V): Promise<V> {
    this.#sweepIdle();

    const existing = this.#entries.get(key);
    if (existing !== undefined) {
      existing.lastUsedAt = this.#now();
      // Re-inserting moves the key to the most-recent end of the Map's order.
      this.#entries.delete(key);
      this.#entries.set(key, existing);
      return existing.value;
    }

    const value = (async () => factory(key))();
    this.#entries.set(key, { value, lastUsedAt: this.#now() });
    this.#evictToCapacity();

    try {
      return await value;
    } catch (error) {
      // Only drop the entry if it is still the one that failed: a retry may
      // already have replaced it.
      if (this.#entries.get(key)?.value === value) {
        this.#entries.delete(key);
      }
      throw error;
    }
  }

  /** Removes one entry and disposes it. Returns true if it was present. */
  delete(key: K): boolean {
    return this.#remove(key, 'explicit');
  }

  /**
   * Disposes every entry and waits for the disposals to finish.
   *
   * Used on shutdown, where the process must not exit while connections are
   * still being closed, and between tests.
   */
  async drain(): Promise<void> {
    for (const key of [...this.#entries.keys()]) {
      this.#remove(key, 'shutdown');
    }
    await this.settled();
  }

  /** Resolves once every disposal started so far has finished. */
  async settled(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending]);
    }
  }

  #remove(key: K, reason: EvictionReason): boolean {
    const entry = this.#entries.get(key);
    if (entry === undefined) {
      return false;
    }
    this.#entries.delete(key);
    this.#track(entry.value, key, reason);
    return true;
  }

  #track(value: Promise<V>, key: K, reason: EvictionReason): void {
    const task = (async () => {
      try {
        await this.#dispose(await value, key, reason);
      } catch (error) {
        this.#onDisposeError(error, key, reason);
      }
    })();
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
  }

  #evictToCapacity(): void {
    while (this.#entries.size > this.#max) {
      // Map iteration order is insertion order, and `getOrCreate` re-inserts on
      // hit, so the first key is the least recently used.
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.#remove(oldest.value, 'capacity');
    }
  }

  #sweepIdle(): void {
    if (this.#entries.size === 0) {
      return;
    }
    const cutoff = this.#now() - this.#idleMs;
    for (const [key, entry] of [...this.#entries]) {
      if (entry.lastUsedAt <= cutoff) {
        this.#remove(key, 'idle');
      }
    }
  }
}
