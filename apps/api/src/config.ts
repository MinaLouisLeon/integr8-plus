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

  /**
   * How long a phone's synced change is remembered, so resending it changes
   * nothing (P12). Far longer than a request's idempotency window: a phone can be
   * offline for a week, signed out for another, and still have the change queued.
   */
  SYNC_REPLAY_DAYS: positiveInt(90),

  /**
   * How long the sync change log keeps its entries. A phone that has not pulled
   * for longer downloads everything again, which is slower but misses nothing.
   */
  SYNC_LOG_RETENTION_DAYS: positiveInt(45),

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
   * Where uploaded files are kept. `r2` is Cloudflare R2, one bucket per
   * company. `local` writes to disk and signs its own links, for development
   * and tests; production refuses it.
   */
  MEDIA_STORAGE: z.enum(['local', 'r2']).default('local'),
  MEDIA_LOCAL_DIR: z.string().min(1).default('.data/media'),
  /**
   * Signs local upload and download links. Unset means a random secret per
   * process: links stop working on restart, which is fine on a laptop.
   */
  MEDIA_URL_SECRET: z.string().min(32).optional(),
  /** Largest single file accepted, in bytes. */
  MEDIA_MAX_BYTES: positiveInt(25 * 1024 * 1024),
  /** How long a deleted file can be restored before its bytes are removed. */
  MEDIA_RESTORE_DAYS: positiveInt(30),
  /** How often the worker sweeps abandoned uploads and purges deleted files. */
  MEDIA_MAINTENANCE_INTERVAL_SECONDS: positiveInt(15 * 60),

  /** The Cloudflare account the R2 buckets belong to. */
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  /** An account-level R2 token (Admin Read & Write): it creates and deletes buckets. */
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  /**
   * The start of every bucket name, before the company id. Unset means
   * `integr8-<APP_ENV>`, so staging and production never share a bucket.
   */
  R2_BUCKET_PREFIX: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,24}$/u)
    .optional(),
  /** Overrides the account endpoint, for a jurisdiction-restricted account. */
  R2_ENDPOINT: z.url().optional(),
  /**
   * Reads R2 storage analytics (Account Analytics: Read), to check the ledger
   * against what Cloudflare bills. Only the verification command needs it.
   */
  CLOUDFLARE_API_TOKEN: z.string().optional(),

  // -------------------------------------------------------------------------
  // Geocoding
  // -------------------------------------------------------------------------

  /**
   * Who turns site addresses into coordinates. `fake` derives stable
   * coordinates from the address text, for development and tests; production
   * refuses it.
   */
  GEOCODER: z.enum(['fake', 'mapbox']).default('fake'),
  /** A secret Mapbox token with geocoding scope. Server-side only. */
  MAPBOX_ACCESS_TOKEN: z.string().optional(),

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

/** The R2 settings, or the names of the ones missing. */
export function r2Settings(config: ApiConfig):
  | { missing: string[] }
  | {
      missing: [];
      settings: {
        accountId: string;
        accessKeyId: string;
        secretAccessKey: string;
        bucketPrefix: string;
        endpoint?: string;
      };
    } {
  const accountId = config.CLOUDFLARE_ACCOUNT_ID ?? '';
  const accessKeyId = config.R2_ACCESS_KEY_ID ?? '';
  const secretAccessKey = config.R2_SECRET_ACCESS_KEY ?? '';
  const missing = Object.entries({
    CLOUDFLARE_ACCOUNT_ID: accountId,
    R2_ACCESS_KEY_ID: accessKeyId,
    R2_SECRET_ACCESS_KEY: secretAccessKey,
  })
    .filter(([, value]) => value === '')
    .map(([name]) => name);
  if (missing.length > 0) {
    return { missing };
  }
  return {
    missing: [],
    settings: {
      accountId,
      accessKeyId,
      secretAccessKey,
      bucketPrefix: config.R2_BUCKET_PREFIX ?? `integr8-${config.APP_ENV}`,
      ...(config.R2_ENDPOINT === undefined ? {} : { endpoint: config.R2_ENDPOINT }),
    },
  };
}

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
  if (
    result.success &&
    result.data.GEOCODER === 'mapbox' &&
    (result.data.MAPBOX_ACCESS_TOKEN ?? '') === ''
  ) {
    throw new Error(
      'Invalid API configuration:\n  GEOCODER is mapbox but MAPBOX_ACCESS_TOKEN is not set.\n\nSee apps/api/.env.example for the full list.',
    );
  }
  if (result.success && result.data.MEDIA_STORAGE === 'r2') {
    const { missing } = r2Settings(result.data);
    if (missing.length > 0) {
      throw new Error(
        `Invalid API configuration:\n  MEDIA_STORAGE is r2 but ${missing.join(', ')} not set.\n\nSee apps/api/.env.example for the full list.`,
      );
    }
  }
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
  if (config.GEOCODER === 'fake') {
    problems.push('GEOCODER is fake: every site would be placed somewhere invented.');
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
