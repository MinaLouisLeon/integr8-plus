import { chmodSync, existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';

/**
 * Writing a website key into the website's own environment file (P43).
 *
 * The key never reaches the AI tool: the website guide says so, and this
 * server hides every secret it sees. So instead of showing it, the server
 * writes it where Next.js reads it, a `.env*.local` file that Next.js keeps
 * out of git, and says only which file and which names it set.
 */

/** Names the website guide uses (apps/forms-ai/src/website/guide.ts). */
export const ENV_WEBSITE_KEY = 'INTEGR8_WEBSITE_KEY';
export const ENV_API_URL = 'INTEGR8_API_URL';

const LOCAL_ENV_FILE = /^\.env(\.[a-z0-9_-]+)?\.local$/iu;
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;

/** Why a path cannot take a key, or undefined when it can. */
export function envFileProblem(path: string): string | undefined {
  if (!isAbsolute(path)) {
    return 'Give the absolute path of the website’s .env.local file.';
  }
  if (!LOCAL_ENV_FILE.test(basename(path))) {
    return 'Only a .env.local (or .env.<name>.local) file takes the key: Next.js keeps those out of git. Never .env or .env.example.';
  }
  if (existsSync(path)) {
    const found = lstatSync(path);
    if (!found.isFile() || found.isSymbolicLink()) {
      return `${path} is not a plain file.`;
    }
  }
  return undefined;
}

export function envNameProblem(name: string): string | undefined {
  return ENV_NAME.test(name)
    ? undefined
    : 'An environment name is upper-case letters, digits and underscores.';
}

/** A value as a .env line keeps it: quoted when it has anything but plain characters. */
function quoted(value: string): string {
  return /^[\w./:@-]*$/u.test(value) ? value : JSON.stringify(value);
}

/**
 * Sets `values` in the file, replacing a line that already names one and
 * adding the rest at the end; every other line is kept as it was. The file
 * is left readable by its owner only.
 */
export function writeEnvValues(path: string, values: Record<string, string>): void {
  const before = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const pending = new Map(Object.entries(values));
  const lines = before === '' ? [] : before.replace(/\r?\n$/u, '').split(/\r?\n/u);
  const kept = lines.map((line) => {
    const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line)?.[1];
    if (name === undefined || !pending.has(name)) {
      return line;
    }
    const value = pending.get(name) ?? '';
    pending.delete(name);
    return `${name}=${quoted(value)}`;
  });
  for (const [name, value] of pending) {
    kept.push(`${name}=${quoted(value)}`);
  }
  writeFileSync(path, `${kept.join('\n')}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
