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
