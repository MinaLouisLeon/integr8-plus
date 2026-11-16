import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configDir, type HostInfo, currentHostInfo, INSTALLED } from './paths.js';

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

/**
 * The keychain module's file beside the installed program (P43). A single
 * executable cannot load a native module from inside itself, so the release
 * ships `@napi-rs/keyring`'s file for that computer next to it, under this
 * name, and the installer copies both.
 */
export const KEYRING_FILE = 'integr8-keyring.node';

interface KeyringEntry {
  getPassword(): string | null | undefined;
  setPassword(secret: string): void;
  deletePassword(): unknown;
}

interface KeyringModule {
  Entry: new (service: string, account: string) => KeyringEntry;
}

/** The keychain module: beside the installed program, or the package from a checkout. */
export async function loadKeyring(): Promise<KeyringModule> {
  if (INSTALLED) {
    const file = join(dirname(process.execPath), KEYRING_FILE);
    const loaded: { exports: unknown } = { exports: {} };
    try {
      process.dlopen(loaded, file);
    } catch (error) {
      throw new Error(
        `The keychain module (${KEYRING_FILE}) could not be loaded from beside the program: ${error instanceof Error ? error.message : String(error)}. Install again from the whole download, or sign in with --file-store.`,
        { cause: error },
      );
    }
    return loaded.exports as KeyringModule;
  }
  return import('@napi-rs/keyring');
}

/** The keychain, through `@napi-rs/keyring`. Throws when the machine has none. */
export async function keychainBox(): Promise<SecretBox> {
  const { Entry } = await loadKeyring();
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
      const box = await this.#box(record.store);
      box.delete(api);
      // Signing out forgets the test companies' website keys too (P43).
      box.delete(websiteKeysEntry(api));
    }
    this.#writeIndex(this.list().filter((candidate) => candidate.api !== api));
  }

  /** The website keys kept for an API, in the same box as its session (P43). */
  async websiteKeys(api: string): Promise<WebsiteKeyVault> {
    const record = this.list().find((candidate) => candidate.api === api);
    return boxVault(await this.#box(record?.store ?? 'keychain'), api);
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

/**
 * A test company's website key, as `create_website_key` made it (P43). The
 * secret is kept where the staff session is (keychain, or the file when the
 * session is), so `call_website_api` can send it; it never reaches the AI.
 */
export interface StoredWebsiteKey {
  tenantId: string;
  keyId: string;
  hint: string;
  label: string | null;
  secret: string;
  createdAt: string;
}

export interface WebsiteKeyVault {
  list(tenantId?: string): Promise<StoredWebsiteKey[]>;
  put(key: StoredWebsiteKey): Promise<void>;
  remove(tenantId: string, keyId: string): Promise<void>;
}

/** Keys held for the life of this process only: local mode and the tests. */
export function memoryVault(): WebsiteKeyVault {
  const keys: StoredWebsiteKey[] = [];
  return {
    list: (tenantId) =>
      Promise.resolve(keys.filter((key) => tenantId === undefined || key.tenantId === tenantId)),
    put: (key) => {
      keys.push(key);
      return Promise.resolve();
    },
    remove: (tenantId, keyId) => {
      const at = keys.findIndex((key) => key.tenantId === tenantId && key.keyId === keyId);
      if (at >= 0) {
        keys.splice(at, 1);
      }
      return Promise.resolve();
    },
  };
}

/** The entry an API's website keys are kept under, beside its session. */
export const websiteKeysEntry = (api: string) => `${api}#website-keys`;

/** Every website key for one API, as one entry in a box. */
export function boxVault(box: SecretBox, api: string): WebsiteKeyVault {
  const entry = websiteKeysEntry(api);
  const read = (): StoredWebsiteKey[] => {
    const secret = box.get(entry);
    if (secret === undefined) {
      return [];
    }
    try {
      return JSON.parse(secret) as StoredWebsiteKey[];
    } catch {
      return [];
    }
  };
  const write = (keys: StoredWebsiteKey[]) => {
    if (keys.length === 0) {
      box.delete(entry);
    } else {
      box.set(entry, JSON.stringify(keys));
    }
  };
  return {
    list: (tenantId) =>
      Promise.resolve(read().filter((key) => tenantId === undefined || key.tenantId === tenantId)),
    put: (key) => {
      write([...read().filter((known) => known.keyId !== key.keyId), key]);
      return Promise.resolve();
    },
    remove: (tenantId, keyId) => {
      write(read().filter((key) => !(key.tenantId === tenantId && key.keyId === keyId)));
      return Promise.resolve();
    },
  };
}
