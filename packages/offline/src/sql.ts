/**
 * The smallest contract the local database needs from SQLite.
 *
 * On a phone it is `expo-sqlite` over SQLCipher (`device.ts`); in tests it is
 * Node's own SQLite (`testing/node-driver.ts`). Everything above this line —
 * migrations, repositories, the download, eviction, search — runs unchanged on
 * both, which is how the parts that decide whether an engineer's work survives
 * are tested against a real SQLite rather than a mock.
 */

export type SqlValue = string | number | null;

export interface SqlConnection {
  /** Runs one or more statements with no parameters and no result. */
  exec(sql: string): Promise<void>;
  run(sql: string, params?: readonly SqlValue[]): Promise<{ changes: number }>;
  all<T>(sql: string, params?: readonly SqlValue[]): Promise<T[]>;
  get<T>(sql: string, params?: readonly SqlValue[]): Promise<T | undefined>;
}

export interface SqlDriver extends SqlConnection {
  close(): Promise<void>;
}
