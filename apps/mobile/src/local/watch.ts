import type { LocalDatabase, LocalTable } from './database';
import type { SqlConnection } from './sql';

export type QueryState<T> =
  { status: 'pending' } | { status: 'ready'; data: T } | { status: 'error'; error: unknown };

/**
 * Runs a query now and again after every committed write to the tables it reads.
 *
 * A change that arrives while the query is running is not lost and not piled
 * up: the query runs once more when it finishes, however many changes came in.
 * Results that arrive after `stop` are dropped, so a screen that has gone never
 * receives state.
 */
export function watchQuery<T>(
  db: LocalDatabase,
  tables: readonly LocalTable[],
  query: (sql: SqlConnection) => Promise<T>,
  onState: (state: QueryState<T>) => void,
): () => void {
  let stopped = false;
  let running = false;
  let dirty = false;

  const run = async () => {
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    do {
      dirty = false;
      try {
        const data = await db.read(query);
        if (!stopped) {
          onState({ status: 'ready', data });
        }
      } catch (error) {
        if (!stopped) {
          onState({ status: 'error', error });
        }
      }
    } while (dirty && !stopped);
    running = false;
  };

  const unsubscribe = db.subscribe(tables, () => {
    void run();
  });
  void run();

  return () => {
    stopped = true;
    unsubscribe();
  };
}
