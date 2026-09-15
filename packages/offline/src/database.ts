import type { SqlConnection, SqlDriver } from './sql.js';

/** The tables a write can change; a screen names the ones it reads to hear about changes. */
export type LocalTable =
  | 'meta'
  | 'customers'
  | 'sites'
  | 'work_orders'
  | 'forms'
  | 'form_versions'
  | 'drafts'
  | 'files'
  | 'outbox'
  | 'uploads'
  | 'submissions'
  | 'sync_runs';

export class LocalDatabaseClosedError extends Error {
  constructor() {
    super('The local database has been closed.');
    this.name = 'LocalDatabaseClosedError';
  }
}

type Listener = () => void;

/**
 * The phone's database: one connection, one operation at a time, and a signal
 * after every committed write.
 *
 * **One connection.** The database is encrypted, and the key is given to a
 * connection when it opens. `expo-sqlite`'s exclusive transactions open a second
 * connection of their own, which would not have the key, so every transaction
 * here runs on the one keyed connection instead.
 *
 * **One at a time.** With a single connection, two interleaved transactions
 * would be one transaction. Everything — reads too, so a read never sees half a
 * write — goes through the same queue. SQLite answers a phone's queries in
 * microseconds; the queue costs nothing a person could notice.
 *
 * **A signal after commit, not before.** Screens re-read when a table they show
 * changes. Telling them before the commit would let them read the old rows, and
 * telling them about a write that rolled back would make them read for nothing.
 */
export class LocalDatabase {
  readonly #driver: SqlDriver;
  readonly #listeners = new Map<Listener, ReadonlySet<LocalTable>>();
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  constructor(driver: SqlDriver) {
    this.#driver = driver;
  }

  get closed(): boolean {
    return this.#closed;
  }

  read<T>(query: (sql: SqlConnection) => Promise<T>): Promise<T> {
    return this.#enqueue(() => query(this.#driver));
  }

  /**
   * Runs `change` in a transaction, then tells anyone watching `tables`.
   *
   * `BEGIN IMMEDIATE` takes the write lock at the start, so a write cannot fail
   * half-way through for want of it.
   */
  async write<T>(
    tables: readonly LocalTable[],
    change: (sql: SqlConnection) => Promise<T>,
  ): Promise<T> {
    const result = await this.#enqueue(async () => {
      await this.#driver.exec('BEGIN IMMEDIATE');
      try {
        const value = await change(this.#driver);
        await this.#driver.exec('COMMIT');
        return value;
      } catch (error) {
        await this.#driver.exec('ROLLBACK');
        throw error;
      }
    });
    this.#notify(tables);
    return result;
  }

  /** Calls `listener` after each committed write to any of `tables`. Returns the unsubscribe. */
  subscribe(tables: readonly LocalTable[], listener: Listener): () => void {
    this.#listeners.set(listener, new Set(tables));
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /** Waits for anything queued, then closes. Later calls fail rather than reopen. */
  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    await this.#enqueue(async () => {
      this.#closed = true;
      await this.#driver.close();
    });
    this.#listeners.clear();
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(() => {
      if (this.#closed) {
        throw new LocalDatabaseClosedError();
      }
      return operation();
    });
    // The queue carries on after a failure; the failure belongs to its caller.
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #notify(tables: readonly LocalTable[]): void {
    for (const [listener, watched] of this.#listeners) {
      if (tables.some((table) => watched.has(table))) {
        try {
          listener();
        } catch {
          // A screen's failure to refresh is that screen's problem; the write
          // has committed and every other screen still needs to hear about it.
        }
      }
    }
  }
}
