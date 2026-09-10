import { z } from 'zod';

/**
 * Database configuration, read once at startup.
 *
 * Two connection strings, two roles, two very different privilege levels:
 *
 * - `DATABASE_URL` connects as `integr8_app`. Every tenant request uses it.
 *   RLS applies to this role, and {@link assertRlsEnforced} refuses to open a
 *   pool if it turns out not to.
 * - `DATABASE_URL_ADMIN` connects as the schema owner. Migrations, seeds,
 *   company provisioning and super-admin reads use it. RLS does *not* apply, so
 *   nothing that handles a tenant request may touch it.
 */

const connectionString = z
  .string()
  .min(1)
  .refine(
    (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
    'must be a postgres:// or postgresql:// URL',
  );

const positiveInt = (fallback: number) => z.coerce.number().int().positive().default(fallback);

export const databaseConfigSchema = z.object({
  /** Runtime connection, role `integr8_app`. */
  DATABASE_URL: connectionString,

  /**
   * Owner connection. Optional at runtime: an API container that never
   * provisions a company does not need it, and not having it is safer.
   */
  DATABASE_URL_ADMIN: connectionString.optional(),

  /**
   * Physical connections in the shared app pool.
   *
   * Sized against Supavisor's transaction-mode pool, not against Postgres's
   * `max_connections`: the pooler multiplexes, so this is a concurrency budget
   * for this container, and every container in the fleet adds to the total.
   */
  DB_POOL_MAX: positiveInt(10),

  /** How long an idle physical connection is kept before the pool closes it. */
  DB_POOL_IDLE_MS: positiveInt(30_000),

  /** How long a caller waits for a connection before giving up. */
  DB_POOL_ACQUIRE_TIMEOUT_MS: positiveInt(10_000),

  /**
   * `statement_timeout` applied to the app role's connections. A tenant request
   * that has not finished in this long is a bug, and holding a pooled
   * connection open for it starves every other tenant.
   */
  DB_STATEMENT_TIMEOUT_MS: positiveInt(15_000),

  /**
   * How many tenant data sources stay warm. Today every entry is a handle onto
   * the one shared pool, so this bounds bookkeeping. When P35 gives an
   * enterprise tenant its own database, an entry becomes a real pool and this
   * becomes the number of live pools — hence bounded from the start rather than
   * bounded later, in a hurry.
   */
  DB_TENANT_CACHE_MAX: positiveInt(200),

  /** A tenant data source unused for this long is evicted and disposed. */
  DB_TENANT_CACHE_IDLE_MS: positiveInt(300_000),
});

export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;

/**
 * Parses configuration from an environment, throwing a message that names every
 * problem at once rather than one per restart.
 */
export function loadDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const result = databaseConfigSchema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid database configuration:\n${problems}\n\nSee packages/db/.env.example for the full list.`,
    );
  }
  return result.data;
}

/**
 * The admin connection string, or a thrown error naming what to set.
 *
 * Separate from {@link loadDatabaseConfig} so that the common case — an API
 * container with no admin credentials at all — stays legal.
 */
export function requireAdminConnectionString(config: DatabaseConfig): string {
  if (config.DATABASE_URL_ADMIN === undefined) {
    throw new Error(
      'DATABASE_URL_ADMIN is not set. Migrations, seeding and company provisioning need the owner role.',
    );
  }
  return config.DATABASE_URL_ADMIN;
}
