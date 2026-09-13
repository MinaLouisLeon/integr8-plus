/**
 * Build-time configuration.
 *
 * Expo inlines anything prefixed `EXPO_PUBLIC_` at bundle time. There is no
 * environment to read on somebody's phone, so these are constants in the
 * shipped binary — which also means none of them may be a secret.
 *
 * Each is read through a helper rather than directly, because Expo types
 * `process.env` loosely enough that reading it produces `any`, and `any`
 * spreading out of a config module is how a `string | undefined` ends up
 * concatenated into a URL.
 */

function publicEnv(name: string): string | undefined {
  const value: unknown = process.env[name];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

export const API_BASE_URL: string =
  publicEnv('EXPO_PUBLIC_API_BASE_URL') ?? 'http://localhost:3000';

export const APP_ENV: string = publicEnv('EXPO_PUBLIC_APP_ENV') ?? 'development';

export const SENTRY_DSN: string | undefined = publicEnv('EXPO_PUBLIC_SENTRY_DSN');
