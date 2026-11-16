import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { getAsset, isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

/**
 * Where the server finds what it describes, run two ways (P43):
 *
 * - **From a checkout** (`pnpm dev-mcp …`): the repository it runs from, for
 *   `apps/api/openapi.json`, the versions and `plan/requests/`.
 * - **As the installed program** (a Node single executable): the OpenAPI
 *   document and versions it was built with are inside it, and
 *   `plan/requests/` is in the integr8-plus folder the person names once
 *   (`settings.json`'s `repository`), when they have one.
 */

declare const __DEV_MCP_VERSION__: string | undefined;
declare const __DEV_MCP_PRODUCT_VERSION__: string | undefined;

/** Whether this run is the installed single executable. */
export const INSTALLED: boolean = isSea();

/** The repository this runs from; in the installed program, meaningless (see `repositoryRoot`). */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const OPENAPI_FILE = join(REPO_ROOT, 'apps', 'api', 'openapi.json');

/** The key the OpenAPI document is stored under in the executable. */
export const OPENAPI_ASSET = 'openapi.json';

/** The API's OpenAPI document, from the checkout or from inside the executable. */
export function readOpenApi(): string {
  return INSTALLED
    ? Buffer.from(getAsset(OPENAPI_ASSET)).toString('utf8')
    : readFileSync(OPENAPI_FILE, 'utf8');
}

/** The version sent as `x-client-version`: the product's (the root package.json's). */
export function repoVersion(): string {
  if (typeof __DEV_MCP_PRODUCT_VERSION__ === 'string') {
    return __DEV_MCP_PRODUCT_VERSION__;
  }
  try {
    return (
      JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
    ).version;
  } catch {
    return '0.0.0';
  }
}

/**
 * This server's own version, from apps/dev-mcp/package.json: the one place
 * it is written (the build writes it into the executable), so the MCP
 * handshake cannot drift from the package.
 */
export function serverVersion(): string {
  if (typeof __DEV_MCP_VERSION__ === 'string') {
    return __DEV_MCP_VERSION__;
  }
  try {
    return (
      JSON.parse(readFileSync(join(REPO_ROOT, 'apps', 'dev-mcp', 'package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
  } catch {
    return '0.0.0';
  }
}

export interface HostInfo {
  platform: NodeJS.Platform;
  home: string;
  env: Readonly<Record<string, string | undefined>>;
}

export const currentHostInfo = (): HostInfo => ({
  platform: process.platform,
  home: homedir(),
  env: process.env,
});

/**
 * The user's configuration folder for this tool: where the list of signed-in
 * APIs (no secrets) and, with `--file-store` only, the sessions themselves are
 * kept. `INTEGR8_DEV_MCP_HOME` moves it (tests).
 */
export function configDir(host: HostInfo = currentHostInfo()): string {
  const override = host.env.INTEGR8_DEV_MCP_HOME;
  if (override !== undefined && override !== '') {
    return override;
  }
  switch (host.platform) {
    case 'win32':
      return win32.join(
        host.env.APPDATA ?? win32.join(host.home, 'AppData', 'Roaming'),
        'Integr8',
        'dev-mcp',
      );
    case 'darwin':
      return posix.join(host.home, 'Library', 'Application Support', 'Integr8', 'dev-mcp');
    default: {
      const base = host.env.XDG_CONFIG_HOME?.startsWith('/')
        ? host.env.XDG_CONFIG_HOME
        : posix.join(host.home, '.config');
      return posix.join(base, 'integr8', 'dev-mcp');
    }
  }
}

/** One spelling per API: lower-case scheme and host, no trailing slash. */
export function normaliseApi(address: string): string {
  const url = new URL(address);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`${address} is not an http(s) address.`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol === 'http:' && !local) {
    throw new Error('A remote API must be reached over https.');
  }
  return `${url.protocol}//${url.host}`.toLowerCase();
}

/** The program's own settings, beside the APIs it is signed in to (no secrets). */
export interface DevSettings {
  /** The integr8-plus folder, for plan/requests/ when this is the installed program. */
  repository?: string;
}

export function settingsFile(host: HostInfo = currentHostInfo()): string {
  return join(configDir(host), 'settings.json');
}

export function readSettings(host: HostInfo = currentHostInfo()): DevSettings {
  try {
    return JSON.parse(readFileSync(settingsFile(host), 'utf8')) as DevSettings;
  } catch {
    return {};
  }
}

/** Whether a folder is an integr8-plus checkout: it has plan/requests/ and the API's OpenAPI document. */
export function isRepository(folder: string): boolean {
  return (
    existsSync(join(folder, 'plan', 'requests')) &&
    existsSync(join(folder, 'apps', 'api', 'openapi.json'))
  );
}

/** The integr8-plus folder: the checkout this runs from, or the one named in the settings. */
export function repositoryRoot(host: HostInfo = currentHostInfo()): string | undefined {
  if (!INSTALLED) {
    return REPO_ROOT;
  }
  const named = readSettings(host).repository;
  return named !== undefined && isRepository(named) ? named : undefined;
}

export function writeSettings(settings: DevSettings, host: HostInfo = currentHostInfo()): void {
  mkdirSync(configDir(host), { recursive: true, mode: 0o700 });
  writeFileSync(settingsFile(host), `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
}
