import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configDir, type HostInfo, currentHostInfo } from './paths.js';

/**
 * Where a signed-in staff session is kept between runs (P38).
 *
 * In the operating system's keychain (Windows Credential Manager, macOS
 * Keychain, the Secret Service on Linux) under the API's address. A machine
 * without one is refused unless `--file-store` was given at login, which
 * writes a file only the user can read, in the user's configuration folder,
 * and says so. Beside them, `apis.json` lists which APIs have a session and
 * until when, and holds no secret.
 */

export interface StoredSession {
  api: string;
  email: string;
  accessToken: string;
  refreshToken: string;
  sessionExpiresAt: string;
  environment: 'development' | 'test' | 'staging' | 'production';
}

export interface ApiRecord {
  api: string;
  email: string;
  environment: StoredSession['environment'];
  sessionExpiresAt: string;
  store: 'keychain' | 'file';
}

export interface SecretBox {
  readonly kind: 'keychain' | 'file';
  get(api: string): string | undefined;
  set(api: string, secret: string): void;
  delete(api: string): void;
}

const SERVICE = 'integr8-dev-mcp';

/** The keychain, through `@napi-rs/keyring`. Throws when the machine has none. */
export async function keychainBox(): Promise<SecretBox> {
  const { Entry } = await import('@napi-rs/keyring');
  // Proves a keychain answers at all before anything is written.
  new Entry(SERVICE, '__probe__').getPassword();
  return {
    kind: 'keychain',
    get: (api) => new Entry(SERVICE, api).getPassword() ?? undefined,
    set: (api, secret) => {
      new Entry(SERVICE, api).setPassword(secret);
    },
    delete: (api) => {
      try {
        new Entry(SERVICE, api).deletePassword();
      } catch {
        // Nothing stored is the same as deleted.
      }
    },
  };
}

const fileFor = (folder: string, api: string) =>
  join(folder, 'sessions', `${createHash('sha256').update(api).digest('hex').slice(0, 24)}.json`);

/** A file only this user can read, for a machine with no keychain. */
export function fileBox(folder: string = configDir()): SecretBox {
  return {
    kind: 'file',
    get: (api) => {
      const file = fileFor(folder, api);
      return existsSync(file) ? readFileSync(file, 'utf8') : undefined;
    },
    set: (api, secret) => {
      const file = fileFor(folder, api);
      mkdirSync(join(folder, 'sessions'), { recursive: true, mode: 0o700 });
      writeFileSync(file, secret, { mode: 0o600 });
      // A file that already existed keeps its old mode unless told again.
      chmodSync(file, 0o600);
    },
    delete: (api) => {
      rmSync(fileFor(folder, api), { force: true });
    },
  };
}

export class SessionStore {
  readonly #folder: string;

  constructor(host: HostInfo = currentHostInfo()) {
    this.#folder = configDir(host);
  }

  get folder(): string {
    return this.#folder;
  }

  #indexFile(): string {
    return join(this.#folder, 'apis.json');
  }

  list(): ApiRecord[] {
    try {
      return JSON.parse(readFileSync(this.#indexFile(), 'utf8')) as ApiRecord[];
    } catch {
      return [];
    }
  }

  #writeIndex(records: ApiRecord[]): void {
    mkdirSync(this.#folder, { recursive: true, mode: 0o700 });
    writeFileSync(this.#indexFile(), `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  }

  async #box(kind: ApiRecord['store']): Promise<SecretBox> {
    return kind === 'file' ? fileBox(this.#folder) : keychainBox();
  }

  async save(session: StoredSession, kind: ApiRecord['store']): Promise<void> {
    const box = await this.#box(kind);
    box.set(session.api, JSON.stringify(session));
    const records = this.list().filter((record) => record.api !== session.api);
    records.push({
      api: session.api,
      email: session.email,
      environment: session.environment,
      sessionExpiresAt: session.sessionExpiresAt,
      store: kind,
    });
    this.#writeIndex(records);
  }

  async load(api: string): Promise<StoredSession | undefined> {
    const record = this.list().find((candidate) => candidate.api === api);
    if (record === undefined) {
      return undefined;
    }
    const secret = (await this.#box(record.store)).get(api);
    return secret === undefined ? undefined : (JSON.parse(secret) as StoredSession);
  }

  async remove(api: string): Promise<void> {
    const record = this.list().find((candidate) => candidate.api === api);
    if (record !== undefined) {
      (await this.#box(record.store)).delete(api);
    }
    this.#writeIndex(this.list().filter((candidate) => candidate.api !== api));
  }

  /** A box for writing a new session: the keychain, or the file when asked. */
  async boxFor(fileStore: boolean): Promise<ApiRecord['store']> {
    if (fileStore) {
      return 'file';
    }
    await keychainBox();
    return 'keychain';
  }
}
