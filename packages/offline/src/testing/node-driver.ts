import { DatabaseSync } from 'node:sqlite';
import { LocalDatabase } from '../database.js';
import { migrate, type Migration, MIGRATIONS } from '../migrations.js';
import type { SqlDriver, SqlValue } from '../sql.js';

/**
 * The local database on Node's built-in SQLite, for tests.
 *
 * Real SQLite, with FTS5 and JSON functions, running the same migrations and
 * queries the phone does. What it cannot test is SQLCipher: that needs the
 * native build, and is on the device checklist.
 */
export class NodeSqlDriver implements SqlDriver {
  readonly #database: DatabaseSync;

  constructor(path = ':memory:') {
    this.#database = new DatabaseSync(path);
  }

  exec(sql: string): Promise<void> {
    this.#database.exec(sql);
    return Promise.resolve();
  }

  run(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> {
    const result = this.#database.prepare(sql).run(...params);
    return Promise.resolve({ changes: Number(result.changes) });
  }

  all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return Promise.resolve(this.#database.prepare(sql).all(...params) as T[]);
  }

  get<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | undefined> {
    return Promise.resolve(this.#database.prepare(sql).get(...params) as T | undefined);
  }

  close(): Promise<void> {
    this.#database.close();
    return Promise.resolve();
  }
}

/** A migrated in-memory database. */
export async function openTestDatabase(
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<{ db: LocalDatabase; driver: NodeSqlDriver }> {
  const driver = new NodeSqlDriver();
  await migrate(driver, migrations);
  return { db: new LocalDatabase(driver), driver };
}
