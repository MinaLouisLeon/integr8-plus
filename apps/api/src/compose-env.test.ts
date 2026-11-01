import { readFileSync } from 'node:fs';
import { authConfigSchema } from '@integr8/auth';
import { databaseConfigSchema } from '@integr8/db';
import { describe, expect, it } from 'vitest';
import { apiConfigSchema } from './config.js';

/**
 * deploy/compose.yml hands the API and the worker a list of setting names, not
 * the whole env file, so neither holds the database owner's or Auth's secrets.
 * The cost of a list is forgetting to add to it: a new setting would be read as
 * unset in a deployment while working everywhere else. This keeps the list and
 * the settings the code reads in step, and the secrets out.
 */

const compose = readFileSync(new URL('../../../deploy/compose.yml', import.meta.url), 'utf8');

/** The names under `x-api-env`'s `environment:`, up to the next top-level key. */
function apiEnvironmentNames(): string[] {
  const start = compose.indexOf('x-api-env: &api-env');
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = compose.slice(start).split('\n').slice(1);
  const end = rest.findIndex((line) => /^\S/u.test(line));
  return (end === -1 ? rest : rest.slice(0, end))
    .map((line) => /^ {4}([A-Z][A-Z0-9_]*):/u.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

/** Set in the image or by compose itself, not from the env file. */
const FROM_THE_IMAGE = ['PDF_CHROMIUM_PATH'];

/** Read by the API and worker outside the three schemas. */
const ALSO_READ = ['SUPABASE_AUTH_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_URL'];

/** Secrets of the database owner, the bootstrap and the Auth container. */
const NEVER = [
  'POSTGRES_PASSWORD',
  'DATABASE_URL_ADMIN',
  'INTEGR8_APP_PASSWORD',
  'INTEGR8_AUTH_PASSWORD',
  'INTEGR8_PLATFORM_PASSWORD',
  'SUPABASE_AUTH_JWT_SECRET',
  'SUPABASE_AUTH_DB_PASSWORD',
];

describe('the settings compose gives the API and the worker', () => {
  it('names every setting the API, database and token code read', () => {
    const named = new Set(apiEnvironmentNames());
    const read = [
      ...Object.keys(apiConfigSchema.shape),
      ...Object.keys(databaseConfigSchema.shape),
      ...Object.keys(authConfigSchema.shape),
      ...ALSO_READ,
    ].filter((name) => !NEVER.includes(name) && !FROM_THE_IMAGE.includes(name));

    expect(read.filter((name) => !named.has(name))).toEqual([]);
  });

  it('names none of the owner’s or Auth’s secrets', () => {
    const named = apiEnvironmentNames();
    expect(named.filter((name) => NEVER.includes(name))).toEqual([]);
    expect(compose).not.toMatch(/env_file/u);
  });
});
