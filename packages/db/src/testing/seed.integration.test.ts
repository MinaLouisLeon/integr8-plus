import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformDataSource, withTenant } from '../connection.js';
import { NORTHWIND, SHARED_USER_ID, SOUTHGATE } from '../seed/demo-data.js';
import { seedDemoData } from '../seed/seed.js';
import { releaseTestDatabase, truncateAll, useTestDatabase } from './harness.js';

/**
 * The demo seed.
 *
 * Worth an integration test for two reasons beyond "it runs": it is the only
 * code that writes memberships through the *tenant* data source at startup, so
 * it exercises the RLS grants end to end; and the overlap it creates — one
 * person in both companies, under one auth identity — is the fixture every
 * future phase will reach for when it needs to prove isolation.
 */

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  await seedDemoData({ env: { APP_ENV: 'test' } });
});

afterAll(async () => {
  await releaseTestDatabase();
});

describe('what it creates', () => {
  it('creates both companies', async () => {
    const tenants = await getPlatformDataSource().tenants.list();
    const slugs = tenants.map((tenant) => tenant.slug);

    expect(slugs).toContain(NORTHWIND.slug);
    expect(slugs).toContain(SOUTHGATE.slug);
  });

  it('creates a super admin who belongs to no company', async () => {
    const platform = getPlatformDataSource();
    const superAdmin = await platform.platformUsers.findByEmail('super.admin@integr8.example');

    expect(superAdmin).toBeDefined();

    for (const demo of [NORTHWIND, SOUTHGATE]) {
      await expect(
        withTenant(demo.id, (tx) => tx.tenantUsers.findByUserId(superAdmin?.id ?? '')),
      ).resolves.toBeUndefined();
    }
  });

  it('gives each company its own members', async () => {
    const northwind = await withTenant(NORTHWIND.id, (tx) => tx.tenantUsers.list());
    const southgate = await withTenant(SOUTHGATE.id, (tx) => tx.tenantUsers.list());

    expect(northwind).toHaveLength(NORTHWIND.members.length);
    expect(southgate).toHaveLength(SOUTHGATE.members.length);
    expect(northwind.every((user) => user.tenantId === NORTHWIND.id)).toBe(true);
    expect(southgate.every((user) => user.tenantId === SOUTHGATE.id)).toBe(true);
  });

  it('puts the same person in both companies with different roles', async () => {
    const inNorthwind = await withTenant(NORTHWIND.id, (tx) =>
      tx.tenantUsers.findByUserId(SHARED_USER_ID),
    );
    const inSouthgate = await withTenant(SOUTHGATE.id, (tx) =>
      tx.tenantUsers.findByUserId(SHARED_USER_ID),
    );

    expect(inNorthwind?.email).toBe(inSouthgate?.email);
    expect(inNorthwind?.userId).toBe(inSouthgate?.userId);
    expect(inNorthwind?.role).toBe('engineer');
    expect(inSouthgate?.role).toBe('admin');
    expect(inNorthwind?.id).not.toBe(inSouthgate?.id);
  });

  it('writes audit entries under each company separately', async () => {
    const northwind = await withTenant(NORTHWIND.id, (tx) => tx.auditLog.list());
    const southgate = await withTenant(SOUTHGATE.id, (tx) => tx.auditLog.list());

    expect(northwind.length).toBeGreaterThan(0);
    expect(southgate.length).toBeGreaterThan(0);
    expect(northwind.every((entry) => entry.tenantId === NORTHWIND.id)).toBe(true);
    expect(southgate.every((entry) => entry.tenantId === SOUTHGATE.id)).toBe(true);
  });
});

describe('running it twice', () => {
  it('adds nothing the second time', async () => {
    const before = await withTenant(NORTHWIND.id, (tx) => tx.tenantUsers.countActive());
    await seedDemoData({ env: { APP_ENV: 'test' } });
    const after = await withTenant(NORTHWIND.id, (tx) => tx.tenantUsers.countActive());

    expect(after).toBe(before);
  });
});

describe('where it refuses to run', () => {
  it('refuses in staging', async () => {
    await expect(seedDemoData({ env: { APP_ENV: 'staging' } })).rejects.toThrow(
      /Refusing to seed/u,
    );
  });

  it('refuses in production', async () => {
    await expect(seedDemoData({ env: { APP_ENV: 'production' } })).rejects.toThrow(
      /Refusing to seed/u,
    );
  });
});
