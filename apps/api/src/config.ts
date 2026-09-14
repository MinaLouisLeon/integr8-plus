import { z } from 'zod';

/**
 * API service configuration.
 *
 * Only what the HTTP layer itself needs. Database and authentication settings
 * are read by `@integr8/db` and `@integr8/auth` from the same environment;
 * duplicating them here would give two places to change one value.
 */

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const apiConfigSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),

  PORT: positiveInt(3000),
  HOST: z.string().min(1).default('0.0.0.0'),

  /**
   * The oldest client build this deployment still serves, returned on every
   * response as `min-supported-client`.
   *
   * The reason this exists at all: a signed desktop binary or an App Store
   * build cannot be force-updated, so at any moment some fraction of traffic
   * comes from software written months ago. Raising this number is how a
   * breaking change is finally allowed — after every client below it has been
   * given a clear, actionable way to update.
   */
  API_MIN_SUPPORTED_CLIENT: z.string().min(1).default('0.1.0'),

  /** Where a client below the minimum is told to go. */
  API_UPDATE_URL: z.string().min(1).default('https://integr8.example/download'),

  /** Requests per window from one IP address, before authentication. */
  API_IP_RATE_LIMIT: positiveInt(300),
  API_IP_RATE_WINDOW_SECONDS: positiveInt(60),

  /** Requests per window from one company, after authentication. */
  API_TENANT_RATE_LIMIT: positiveInt(1200),
  API_TENANT_RATE_WINDOW_SECONDS: positiveInt(60),

  /** How long an idempotency key is remembered, and a replay still answered. */
  API_IDEMPOTENCY_TTL_SECONDS: positiveInt(24 * 60 * 60),

  /** Largest request body accepted, in bytes. */
  API_MAX_BODY_BYTES: positiveInt(1_048_576),

  /**
   * Browser origins allowed to call this API, comma-separated.
   *
   * The web app, the desktop app's dev server and the Tauri webview all run on
   * origins other than the API's. Unset in development means the local ones
   * (see `corsOrigins`); unset anywhere else means none, so a deployment that
   * forgets this fails closed and loudly rather than open.
   */
  API_CORS_ORIGINS: z.string().default(''),

  /**
   * The address clients reach this API at, for links it hands out — such as
   * where to upload a file when media is stored locally. Defaults to localhost.
   */
  API_PUBLIC_URL: z.url().optional(),

  // -------------------------------------------------------------------------
  // Media
  // -------------------------------------------------------------------------

  /**
   * Where uploaded files are kept. `local` writes to disk and signs its own
   * upload and download links, for development and tests. P09 adds `r2`.
   */
  MEDIA_STORAGE: z.enum(['local']).default('local'),
  MEDIA_LOCAL_DIR: z.string().min(1).default('.data/media'),
  /**
   * Signs local upload and download links. Unset means a random secret per
   * process: links stop working on restart, which is fine on a laptop.
   */
  MEDIA_URL_SECRET: z.string().min(32).optional(),
  /** Largest single file accepted, in bytes. */
  MEDIA_MAX_BYTES: positiveInt(25 * 1024 * 1024),

  /**
   * Sentry. Optional: unset means errors are logged and not reported, which is
   * the right default for a developer's machine and the wrong one for
   * production — `assertProductionReady` says so at startup.
   */
  SENTRY_DSN: z.string().optional(),

  /**
   * The release this build is, for Sentry and for the `x-api-release` header.
   * Set by CI from the commit sha; unset locally.
   */
  API_RELEASE: z.string().default('development'),

  /** Fraction of transactions traced. Sampling, because traces are not free. */
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0.1),

  // -------------------------------------------------------------------------
  // Worker
  // -------------------------------------------------------------------------

  /** Jobs claimed per poll. */
  WORKER_BATCH_SIZE: positiveInt(10),
  /** How long to wait when a poll finds nothing. */
  WORKER_IDLE_POLL_MS: positiveInt(2000),
  /**
   * How long a worker's claim on a job lasts.
   *
   * A lease rather than a lock: a worker killed mid-job would otherwise leave
   * its rows claimed forever. Long enough that a slow job is not stolen from
   * under itself, short enough that a crash is recovered from promptly.
   */
  WORKER_LEASE_MS: positiveInt(60_000),
  /** First retry delay; doubles each attempt, with jitter. */
  WORKER_RETRY_BASE_MS: positiveInt(5000),
  WORKER_RETRY_MAX_MS: positiveInt(60 * 60 * 1000),
});

export type ApiConfig = z.infer<typeof apiConfigSchema>;

/** The local origins a developer's browser, desktop dev server and Tauri window use. */
export const DEVELOPMENT_ORIGINS = [
  'http://localhost:3001',
  'http://localhost:3002',
  'tauri://localhost',
  'http://tauri.localhost',
] as const;

/** The origins allowed to call this API from a browser. */
export function corsOrigins(config: ApiConfig): string[] {
  const listed = config.API_CORS_ORIGINS.split(',')
    .map((origin) => origin.trim().replace(/\/+$/u, ''))
    .filter((origin) => origin !== '');
  if (listed.length > 0) {
    return listed;
  }
  return config.APP_ENV === 'development' || config.APP_ENV === 'test'
    ? [...DEVELOPMENT_ORIGINS]
    : [];
}

/** Where this API is reached from outside, without a trailing slash. */
export function publicUrl(config: ApiConfig): string {
  return (config.API_PUBLIC_URL ?? `http://localhost:${String(config.PORT)}`).replace(/\/+$/u, '');
}

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const result = apiConfigSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid API configuration:\n${problems}\n\nSee apps/api/.env.example for the full list.`,
    );
  }
  return result.data;
}

/**
 * Refuses to start a production deployment that is missing something a
 * production deployment needs.
 *
 * Each of these is survivable on a laptop and not in production, and each fails
 * silently rather than loudly — which is exactly the kind of thing that is
 * discovered during the incident it would have helped with.
 */
export function assertProductionReady(config: ApiConfig): void {
  if (config.APP_ENV !== 'production') {
    return;
  }

  const problems: string[] = [];

  if (config.SENTRY_DSN === undefined || config.SENTRY_DSN === '') {
    problems.push('SENTRY_DSN is not set: nothing would report an unhandled error.');
  }
  if (config.MEDIA_STORAGE === 'local') {
    problems.push(
      "MEDIA_STORAGE is local: uploads would live on one container's disk and vanish with it.",
    );
  }
  if (config.API_CORS_ORIGINS.trim() === '') {
    problems.push('API_CORS_ORIGINS is not set: no browser client could call this API.');
  }
  if (config.API_RELEASE === 'development') {
    problems.push('API_RELEASE is not set: reported errors could not be tied to a build.');
  }

  if (problems.length > 0) {
    throw new Error(
      [`Refusing to start in production:`, ...problems.map((problem) => `  - ${problem}`)].join(
        '\n',
      ),
    );
  }
}
