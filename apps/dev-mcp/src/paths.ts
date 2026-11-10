import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The repository this runs from: the server reads its OpenAPI document and version. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const OPENAPI_FILE = join(REPO_ROOT, 'apps', 'api', 'openapi.json');

/** The version sent as `x-client-version`: the repository's own. */
export function repoVersion(): string {
  try {
    return (
      JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { version: string }
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
