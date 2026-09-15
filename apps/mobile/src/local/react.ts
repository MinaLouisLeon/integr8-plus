import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  type LocalTable,
  type QueryState,
  type SqlConnection,
  type SyncActivity,
  watchQuery,
} from '@integr8/offline';
import { localData, type LocalStatus, type SyncState } from './local-data';

export function useLocalStatus(): LocalStatus {
  return useSyncExternalStore(localData.subscribe, localData.status);
}

export function useSyncState(): SyncState {
  return useSyncExternalStore(localData.subscribe, localData.syncState);
}

const IDLE: SyncActivity = { phase: 'idle' };

/** What the sync engine is doing this moment. */
export function useSyncActivity(): SyncActivity {
  return useSyncExternalStore(localData.subscribe, () => {
    const status = localData.status();
    return status.phase === 'open' ? status.engine.activity() : IDLE;
  });
}

/**
 * A query against the phone's database that stays current.
 *
 * `key` names everything the query depends on (an id, the search text); the
 * query runs again when it changes, and after every committed write to `tables`.
 * While the first result is on its way — a few milliseconds from SQLite — the
 * state is `pending`, and screens show nothing rather than a spinner: there is no
 * network to wait for.
 */
export function useLocalQuery<T>(
  key: string,
  tables: readonly LocalTable[],
  query: (sql: SqlConnection) => Promise<T>,
): QueryState<T> {
  const status = useLocalStatus();
  const db = status.phase === 'open' ? status.db : undefined;
  const latest = useRef(query);
  useEffect(() => {
    latest.current = query;
  });
  const tableKey = tables.join(',');
  const [state, setState] = useState<{ key: string; state: QueryState<T> }>({
    key,
    state: { status: 'pending' },
  });

  useEffect(() => {
    if (db === undefined) {
      return undefined;
    }
    return watchQuery(
      db,
      tableKey.split(',') as LocalTable[],
      (sql) => latest.current(sql),
      (next) => setState({ key, state: next }),
    );
  }, [db, key, tableKey]);

  // A result for the previous key is never shown for the new one.
  return state.key === key ? state.state : { status: 'pending' };
}
