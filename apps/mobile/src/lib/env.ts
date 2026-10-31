/**
 * Build-time configuration.
 *
 * Expo inlines anything prefixed `EXPO_PUBLIC_` at bundle time. There is no
 * environment to read on somebody's phone, so these are constants in the
 * shipped binary — which also means none of them may be a secret.
 *
 * Each variable is read as a literal `process.env.EXPO_PUBLIC_…` on purpose.
 * Expo's Babel step replaces only that exact form. A computed read, with the
 * name in square brackets, stays in the bundle as written, and only a development
 * build fills `process.env` while the app runs, so a release build would read
 * nothing and quietly fall back to `localhost`. The mobile ESLint config rejects
 * a computed or destructured read anywhere in the app.
 */

export interface PublicEnv {
  apiBaseUrl: string;
  appEnv: string;
  sentryDsn: string | undefined;
  /**
   * The deployment's public verification keys (`AUTH_VERIFICATION_KEYS`, a JSON
   * array of JWKs), so the phone can check its offline grant with no network
   * (docs/auth/offline-access.md). Public by nature: they can check a token,
   * never mint one.
   */
  authVerificationKeys: string | undefined;
}

/** The build was made without a setting it cannot work without. */
export class MissingBuildSettingError extends Error {
  constructor(readonly variable: string) {
    super(
      `${variable} was not set when this build was made. Set it in the build profile ` +
        '(eas.json) or in the shell running `eas update`.',
    );
    this.name = 'MissingBuildSettingError';
  }
}

function present(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Turns what the bundler inlined into the app's settings.
 *
 * Only a development build may fall back to a local server. A release build
 * with no server address refuses to start rather than talk to `localhost`, and
 * one with no environment name counts as production, so the checks that relax
 * in development (the unencrypted-database refusal in `local/device.ts`) stay on.
 */
export function resolvePublicEnv(
  raw: { apiBaseUrl: unknown; appEnv: unknown; sentryDsn: unknown; authVerificationKeys?: unknown },
  development: boolean,
): PublicEnv {
  const apiBaseUrl = present(raw.apiBaseUrl);
  if (apiBaseUrl === undefined && !development) {
    throw new MissingBuildSettingError('EXPO_PUBLIC_API_BASE_URL');
  }
  return {
    apiBaseUrl: apiBaseUrl ?? 'http://localhost:3000',
    appEnv: present(raw.appEnv) ?? (development ? 'development' : 'production'),
    sentryDsn: present(raw.sentryDsn),
    authVerificationKeys: present(raw.authVerificationKeys),
  };
}

// React Native defines `__DEV__`; the unit tests run in plain Node, where it is
// absent and the development defaults are the right ones.
const development = typeof __DEV__ === 'undefined' ? true : __DEV__;

const env = resolvePublicEnv(
  {
    apiBaseUrl: process.env.EXPO_PUBLIC_API_BASE_URL,
    appEnv: process.env.EXPO_PUBLIC_APP_ENV,
    sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN,
    authVerificationKeys: process.env.EXPO_PUBLIC_AUTH_VERIFICATION_KEYS,
  },
  development,
);

export const API_BASE_URL: string = env.apiBaseUrl;

export const APP_ENV: string = env.appEnv;

export const SENTRY_DSN: string | undefined = env.sentryDsn;

export const AUTH_VERIFICATION_KEYS: string | undefined = env.authVerificationKeys;
