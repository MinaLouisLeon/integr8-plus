import { z } from 'zod';

export const APP_ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const;

export const appEnvironmentSchema = z.enum(APP_ENVIRONMENTS);
export type AppEnvironment = z.infer<typeof appEnvironmentSchema>;

/** Environments where destructive shortcuts and seed data are permitted. */
export function isProductionLike(environment: AppEnvironment): boolean {
  return environment === 'staging' || environment === 'production';
}

/**
 * Reads a required environment variable, failing loudly at startup rather than
 * producing `undefined` somewhere deep in a request handler.
 */
export function requireEnv(name: string, source: NodeJS.ProcessEnv = process.env): string {
  const value = source[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `Missing required environment variable: ${name}. See the app's .env.example for the full list.`,
    );
  }
  return value;
}

/** Reads an optional environment variable, falling back to `fallback`. */
export function optionalEnv(
  name: string,
  fallback: string,
  source: NodeJS.ProcessEnv = process.env,
): string {
  const value = source[name];
  return value === undefined || value.trim() === '' ? fallback : value;
}

// ---------------------------------------------------------------------------
// Example values a deployment must not run on
// ---------------------------------------------------------------------------

/**
 * The word `deploy/.env.example` puts in every password an operator has to
 * replace. A production server that still holds one is running on a password
 * printed in a public repository.
 */
export const EXAMPLE_VALUE_MARKER = 'change-me';

/**
 * The shortest database password production accepts. The setup guide makes
 * 48 characters; sixteen leaves room for a password manager's own and still
 * refuses a word somebody typed.
 */
export const MIN_DATABASE_PASSWORD_LENGTH = 16;

/**
 * Settings holding a password, a key, a token or a secret, by name:
 * `POSTGRES_PASSWORD`, `PLATFORM_SECRET_KEY`, `HR_DATA_KEYS_PREVIOUS`.
 */
const SECRET_SETTING = /PASSWORD|SECRET|TOKEN|KEY/u;

/**
 * Settings holding one address or a comma-separated list of them, by name:
 * `WEB_APP_URL`, `DATABASE_URL_ADMIN`, `API_CORS_ORIGINS`, `AUTH_ISSUER`.
 */
const ADDRESS_SETTING = /URL|ORIGINS|ISSUER|DSN/u;

/** The database passwords, as their own settings. */
const DATABASE_PASSWORDS = [
  'POSTGRES_PASSWORD',
  'INTEGR8_APP_PASSWORD',
  'INTEGR8_AUTH_PASSWORD',
  'INTEGR8_PLATFORM_PASSWORD',
  'SUPABASE_AUTH_DB_PASSWORD',
] as const;

/** The database connections, whose password is inside the address. */
const DATABASE_URLS = [
  'DATABASE_URL',
  'DATABASE_URL_ADMIN',
  'DATABASE_URL_AUTH',
  'DATABASE_URL_PLATFORM',
] as const;

/**
 * The host of `scheme://[user[:password]@]host[:port]/…`, lower-cased, or
 * undefined for anything else. By hand rather than with `URL`, so a value that
 * is not quite an address is still looked at, and so the password before the
 * `@` is never mistaken for part of the host.
 */
function hostOf(address: string): string | undefined {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?(\[[^\]]*\]|[^:/?#]*)/iu.exec(address.trim());
  const host = match?.[1];
  return host === undefined || host === '' ? undefined : host.toLowerCase();
}

/**
 * Whether a host is a placeholder: under `.example` (`api.your-domain.example`,
 * the template's) or `.local` (`api.integr8.local`, the sign-in issuer's old
 * default). Neither can be a public address, so a production server that names
 * one is pointing people somewhere that does not exist.
 */
export function isExampleHost(host: string): boolean {
  return /(?:^|\.)(?:example|local)\.?$/u.test(host.toLowerCase());
}

/** Whether an address, or any address in a comma-separated list, is a placeholder. */
export function hasExampleAddress(value: string): boolean {
  return value
    .split(',')
    .map(hostOf)
    .some((host) => host !== undefined && isExampleHost(host));
}

/** The password inside a `postgres://user:password@host/db` address, if it has one. */
export function connectionPassword(address: string): string | undefined {
  const match = /^[a-z][a-z0-9+.-]*:\/\/[^:@/?#]*:([^@/?#]*)@/iu.exec(address.trim());
  if (match?.[1] === undefined || match[1] === '') {
    return undefined;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

/**
 * Which settings still hold a value from `deploy/.env.example`, and why.
 *
 * - a password, key, token, secret or address containing `change-me`;
 * - an address whose host is a placeholder (`.example`, `.local`);
 * - a database password shorter than {@link MIN_DATABASE_PASSWORD_LENGTH},
 *   whether set on its own or inside a connection address.
 *
 * Each problem names the setting and never its value, so the list can go to a
 * log. Read from the environment rather than a parsed configuration because the
 * API, the worker and the database commands each read a different part of it,
 * and every one of them should refuse the same mistakes. Production refuses to
 * start over any of them; staging only says so.
 */
export function exampleValueProblems(env: NodeJS.ProcessEnv): string[] {
  const problems: string[] = [];
  const names = Object.keys(env).sort();

  for (const name of names) {
    const value = env[name] ?? '';
    if (value.trim() === '') {
      continue;
    }
    const secret = SECRET_SETTING.test(name);
    const address = ADDRESS_SETTING.test(name);
    if ((secret || address) && value.toLowerCase().includes(EXAMPLE_VALUE_MARKER)) {
      problems.push(
        `${name} still holds the "${EXAMPLE_VALUE_MARKER}" example value from deploy/.env.example: replace it with a real one.`,
      );
      continue;
    }
    if (address && hasExampleAddress(value)) {
      problems.push(
        `${name} names an example address (a .example or .local host), which nothing can reach: set the real one.`,
      );
    }
  }

  for (const name of DATABASE_PASSWORDS) {
    const value = env[name] ?? '';
    if (value !== '' && value.length < MIN_DATABASE_PASSWORD_LENGTH) {
      problems.push(
        `${name} is shorter than ${String(MIN_DATABASE_PASSWORD_LENGTH)} characters: make a longer one with "openssl rand -hex 24".`,
      );
    }
  }
  for (const name of DATABASE_URLS) {
    const password = connectionPassword(env[name] ?? '');
    if (password !== undefined && password.length < MIN_DATABASE_PASSWORD_LENGTH) {
      problems.push(
        `The password in ${name} is shorter than ${String(MIN_DATABASE_PASSWORD_LENGTH)} characters: make a longer one with "openssl rand -hex 24".`,
      );
    }
  }

  return problems;
}
