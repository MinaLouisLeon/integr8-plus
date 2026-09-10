import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertRlsEnforced,
  closeDatabase,
  configureDatabase,
  getPlatformDb,
  getTenantDataSource,
  RlsNotEnforcedError,
  withTenant,
} from '../connection.js';
import { loadDatabaseConfig } from '../config.js';
import {
  createTenant,
  releaseTestDatabase,
  requireDisposableDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
} from './harness.js';

/**
 * The real path, end to end: `getTenantDataSource` → transaction → repository →
 * `integr8_app` → RLS.
 *
 * The two isolation suites each disable one control to prove the other is
 * sufficient. This one leaves everything switched on and checks the assembled
 * thing behaves — including the two properties that only appear once a
 * connection pool is involved, and that a single-connection test would never
 * find.
 */

let northwind: TenantFixture;
let southgate: TenantFixture;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();

  northwind = await createTenant('northwind');
  southgate = await createTenant('southgate');

  for (const [tenant, email] of [
    [northwind, 'dana.okafor@northwind.example'],
    [southgate, 'marek.novak@southgate.example'],
  ] as const) {
    await withTenant(tenant.id, (tx) =>
      tx.tenantUsers.create({
        userId: crypto.randomUUID(),
        email,
        displayName: 'Owner',
        role: 'owner',
      }),
    );
  }
});

afterAll(async () => {
  await releaseTestDatabase();
});

describe('the assembled path', () => {
  it('reads and writes through the runtime role', async () => {
    const users = await withTenant(northwind.id, (tx) => tx.tenantUsers.list());

    expect(users).toHaveLength(1);
    expect(users[0]?.tenantId).toBe(northwind.id);
    expect(users[0]?.email).toBe('dana.okafor@northwind.example');
  });

  it('keeps two companies apart', async () => {
    const northwindUsers = await withTenant(northwind.id, (tx) => tx.tenantUsers.list());
    const southgateUsers = await withTenant(southgate.id, (tx) => tx.tenantUsers.list());

    expect(northwindUsers.map((user) => user.email)).toEqual(['dana.okafor@northwind.example']);
    expect(southgateUsers.map((user) => user.email)).toEqual(['marek.novak@southgate.example']);
  });

  it('rolls back a failed transaction', async () => {
    await expect(
      withTenant(northwind.id, async (tx) => {
        await tx.tenantUsers.create({
          userId: crypto.randomUUID(),
          email: 'rolled.back@northwind.example',
          displayName: 'Rolled Back',
          role: 'viewer',
        });
        throw new Error('something went wrong after the insert');
      }),
    ).rejects.toThrow('something went wrong after the insert');

    await expect(withTenant(northwind.id, (tx) => tx.tenantUsers.countActive())).resolves.toBe(1);
  });

  it('rejects a tenant id that is not a uuid before it reaches the database', async () => {
    await expect(getTenantDataSource('northwind')).rejects.toThrow();
  });
});

describe('the warm pool', () => {
  it('returns the same data source for a tenant it has just served', async () => {
    const first = await getTenantDataSource(northwind.id);
    const second = await getTenantDataSource(northwind.id);

    expect(second).toBe(first);
  });

  it('returns different data sources for different tenants', async () => {
    const a = await getTenantDataSource(northwind.id);
    const b = await getTenantDataSource(southgate.id);

    expect(a).not.toBe(b);
    expect(a.tenantId).toBe(northwind.id);
    expect(b.tenantId).toBe(southgate.id);
  });
});

describe('transaction-mode pooling', () => {
  /**
   * The failure this guards against is the one that only appears in production.
   *
   * Supavisor hands the same physical connection to different tenants between
   * transactions. If the tenant context were set at session level, tenant B
   * would inherit tenant A's context and read A's rows — intermittently,
   * proportional to load, and invisibly. Forcing the pool down to one
   * connection makes that certain rather than occasional.
   */
  it('does not leak one tenant context into the next transaction on the same connection', async () => {
    await closeDatabase();
    configureDatabase({ ...loadDatabaseConfig(), DB_POOL_MAX: 1 });

    try {
      for (let i = 0; i < 6; i += 1) {
        const tenant = i % 2 === 0 ? northwind : southgate;
        const expectedEmail =
          tenant === northwind ? 'dana.okafor@northwind.example' : 'marek.novak@southgate.example';

        const users = await withTenant(tenant.id, (tx) => tx.tenantUsers.list());

        expect(users).toHaveLength(1);
        expect(users[0]?.email).toBe(expectedEmail);
      }
    } finally {
      await closeDatabase();
      useTestDatabase();
    }
  });
});

describe('the startup assertion', () => {
  it('accepts the runtime connection', async () => {
    // Reaching this suite at all means it already passed during pool creation;
    // this makes the dependency explicit rather than incidental.
    await expect(
      withTenant(northwind.id, (tx) => tx.tenantUsers.countActive()),
    ).resolves.toBeGreaterThanOrEqual(0);
  });

  it('refuses an owner connection, which would silently bypass every policy', async () => {
    requireDisposableDatabase();

    await expect(assertRlsEnforced(getPlatformDb())).rejects.toThrow(RlsNotEnforcedError);
  });

  it('explains why it refused', async () => {
    const message = await assertRlsEnforced(getPlatformDb()).then(
      () => '',
      (error: unknown) => (error instanceof Error ? error.message : ''),
    );

    expect(message).toMatch(/owns \d+ table/u);
    expect(message).toMatch(/can read platform_users/u);
    expect(message).toMatch(/DATABASE_URL must connect as integr8_app/u);
  });
});
