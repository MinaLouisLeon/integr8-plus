import pg from 'pg';
import { readCompany, type TableHeader, type WriteReport, writeCompany } from './company.js';
import type { TransferTable } from './tables.js';

export {
  schemaVersion,
  TRANSFER_FORMAT_VERSION,
  TransferRefusedError,
  type TableHeader,
  type WriteReport,
} from './company.js';
export { NOT_TRANSFERRED, type TransferTable } from './tables.js';

/**
 * The transfer's entry points for the API's command (P41), each on its own
 * owner connection, since nothing outside this package may hold one.
 */

/** Reads one company's rows; see {@link readCompany}. */
export async function exportCompanyRows(
  adminConnectionString: string,
  tenantId: string,
  each: (table: TransferTable, lines: string[]) => Promise<void>,
  onTables?: (tables: TransferTable[]) => Promise<void>,
): Promise<{ tables: TransferTable[]; counts: Record<string, number> }> {
  return withOwner(adminConnectionString, (client) =>
    readCompany(client, tenantId, each, onTables),
  );
}

/** Writes one company's rows, all or nothing; see {@link writeCompany}. */
export async function importCompanyRows(
  adminConnectionString: string,
  source: {
    tenantId: string;
    tables: readonly TableHeader[];
    rows: (table: TableHeader) => AsyncIterable<string[]>;
  },
): Promise<WriteReport> {
  return withOwner(adminConnectionString, (client) => writeCompany(client, source));
}

export interface SignInAccount {
  userId: string;
  email: string;
  /** The Auth container's bcrypt hash; null for someone who signs in with codes only. */
  passwordHash: string | null;
}

/**
 * The company's people as the Auth container keeps them, password hashes
 * included, for a transfer that keeps their passwords.
 *
 * Read from Auth's own `auth` schema as the owner: none of the application's
 * roles holds anything there, on purpose, and the Auth container's admin API
 * never returns a hash. Empty when the database has no Auth schema (a
 * development database without the container).
 */
export async function readSignInAccounts(
  adminConnectionString: string,
  tenantId: string,
): Promise<SignInAccount[]> {
  return withOwner(adminConnectionString, async (client) => {
    const present = await client.query<{ present: boolean }>(
      `select to_regclass('auth.users') is not null as present`,
    );
    if (present.rows[0]?.present !== true) {
      return [];
    }
    const result = await client.query<{ id: string; email: string; hash: string | null }>(
      `select u.id::text as id, u.email::text as email, nullif(u.encrypted_password, '') as hash
         from auth.users u
        where u.id in (select tu.user_id from tenant_users tu where tu.tenant_id = $1)
        order by u.id`,
      [tenantId],
    );
    return result.rows.map((row) => ({
      userId: row.id,
      email: row.email,
      passwordHash: row.hash,
    }));
  });
}

/** The ids of people who already have a sign-in account here, of those given. */
export async function existingSignInAccounts(
  adminConnectionString: string,
  userIds: readonly string[],
): Promise<string[]> {
  return withOwner(adminConnectionString, async (client) => {
    const present = await client.query<{ present: boolean }>(
      `select to_regclass('auth.users') is not null as present`,
    );
    if (present.rows[0]?.present !== true) {
      return [];
    }
    const result = await client.query<{ id: string }>(
      `select id::text as id from auth.users where id = any ($1::uuid[])`,
      [userIds],
    );
    return result.rows.map((row) => row.id);
  });
}

async function withOwner<T>(
  connectionString: string,
  body: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString, application_name: 'integr8-transfer' });
  await client.connect();
  try {
    await client.query('set statement_timeout = 0');
    return await body(client);
  } finally {
    await client.end();
  }
}
