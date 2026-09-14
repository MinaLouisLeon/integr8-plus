import * as Crypto from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';
import { deleteDatabaseAsync, openDatabaseAsync, type SQLiteDatabase } from 'expo-sqlite';
import { APP_ENV } from '~/lib/env';
import { LocalDatabase } from './database';
import { evict } from './eviction';
import { migrate } from './migrations';
import type { SqlDriver, SqlValue } from './sql';
import type { WipeSteps } from './wipe';

/**
 * The local database on the phone: SQLCipher, with its key in the keychain.
 *
 * **The key** is 32 random bytes made on first use and kept in SecureStore —
 * the iOS Keychain, or the Android Keystore — readable only by this app, only
 * on this device (`THIS_DEVICE_ONLY`, so it is never restored onto another
 * phone from a backup), and only after the phone has been unlocked once since it
 * started. It is given to SQLCipher as a raw key (`x'…'`), so there is no slow
 * password derivation on every launch.
 *
 * **Refusing to run unencrypted.** SQLCipher is compiled in by the config plugin
 * (`app.json`), which needs a development or release build; Expo Go has plain
 * SQLite. Outside development, a database without a cipher is refused rather
 * than silently written in the clear.
 *
 * **A key that no longer opens the file** — the keychain entry lost, the file
 * restored from somewhere — means the file is unreadable to anyone. It is
 * deleted and the phone starts again; there is nothing in it to save.
 */

const DATABASE_NAME = 'integr8-local.db';
const KEY_NAME = 'integr8.local-database-key';
const FILES_DIRECTORY = 'integr8-files';

const KEY_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

export class LocalDatabaseNotEncryptedError extends Error {
  constructor() {
    super('This build has no SQLCipher, and will not store company data unencrypted.');
    this.name = 'LocalDatabaseNotEncryptedError';
  }
}

class ExpoSqlDriver implements SqlDriver {
  constructor(private readonly database: SQLiteDatabase) {}

  exec(sql: string): Promise<void> {
    return this.database.execAsync(sql);
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<{ changes: number }> {
    const result = await this.database.runAsync(sql, [...params]);
    return { changes: result.changes };
  }

  all<T>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.database.getAllAsync<T>(sql, [...params]);
  }

  async get<T>(sql: string, params: readonly SqlValue[] = []): Promise<T | undefined> {
    return (await this.database.getFirstAsync<T>(sql, [...params])) ?? undefined;
  }

  close(): Promise<void> {
    return this.database.closeAsync();
  }
}

async function databaseKey(): Promise<string> {
  const existing = await SecureStore.getItemAsync(KEY_NAME, KEY_OPTIONS);
  if (existing !== null && /^[0-9a-f]{64}$/u.test(existing)) {
    return existing;
  }
  const bytes = await Crypto.getRandomBytesAsync(32);
  const key = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  await SecureStore.setItemAsync(KEY_NAME, key, KEY_OPTIONS);
  return key;
}

async function openKeyed(
  key: string,
): Promise<{ database: SQLiteDatabase; cipherVersion: string }> {
  const database = await openDatabaseAsync(DATABASE_NAME);
  // Must be the first statement on the connection.
  await database.execAsync(`PRAGMA key = "x'${key}'"`);
  const cipher = await database.getFirstAsync<{ cipher_version: string }>('PRAGMA cipher_version');
  const cipherVersion = cipher?.cipher_version ?? '';
  if (cipherVersion === '' && APP_ENV !== 'development') {
    await database.closeAsync();
    throw new LocalDatabaseNotEncryptedError();
  }
  // Fails with "file is not a database" when the key does not match the file.
  await database.getFirstAsync('select count(*) from sqlite_master');
  return { database, cipherVersion };
}

/** Opens, and if need be creates and upgrades, the phone's database. */
export interface OpenedDatabase {
  db: LocalDatabase;
  /** SQLCipher's version, or empty when the build has plain SQLite (development only). */
  cipherVersion: string;
}

export async function openDeviceDatabase(): Promise<OpenedDatabase> {
  const key = await databaseKey();
  let opened: { database: SQLiteDatabase; cipherVersion: string };
  try {
    opened = await openKeyed(key);
  } catch (error) {
    // Only a key that does not open the file justifies deleting it. Anything
    // else — a full disk, a locked file — may pass, and the work in it with it.
    if (!(error instanceof Error) || !/not a database/iu.test(error.message)) {
      throw error;
    }
    await deleteDatabaseAsync(DATABASE_NAME);
    opened = await openKeyed(key);
  }

  const driver = new ExpoSqlDriver(opened.database);
  await driver.exec('PRAGMA journal_mode = WAL');
  // A failed migration leaves the database as it was and is reported; it is
  // never a reason to delete unsent work.
  await migrate(driver);

  const db = new LocalDatabase(driver);
  const evicted = await db.write(
    ['work_orders', 'customers', 'sites', 'forms', 'form_versions', 'files'],
    (sql) => evict(sql, new Date()),
  );
  deleteLocalFiles(evicted.filePaths);
  return { db, cipherVersion: opened.cipherVersion };
}

export function filesDirectory(): Directory {
  return new Directory(Paths.document, FILES_DIRECTORY);
}

/** Removes files whose rows have gone. A file already missing is not an error. */
export function deleteLocalFiles(paths: readonly string[]): void {
  for (const path of paths) {
    try {
      const file = new File(Paths.document, FILES_DIRECTORY, path);
      if (file.exists) {
        file.delete();
      }
    } catch {
      // Best effort: an orphaned file is found and removed on the next wipe.
    }
  }
}

/** What a wipe does on this device. */
export function deviceWipeSteps(database: LocalDatabase | undefined): WipeSteps {
  return {
    closeDatabase: async () => {
      await database?.close();
    },
    forgetKey: () => SecureStore.deleteItemAsync(KEY_NAME, KEY_OPTIONS),
    deleteDatabase: () => deleteDatabaseAsync(DATABASE_NAME),
    deleteFiles: () => {
      const directory = filesDirectory();
      if (directory.exists) {
        directory.delete();
      }
      return Promise.resolve();
    },
  };
}
