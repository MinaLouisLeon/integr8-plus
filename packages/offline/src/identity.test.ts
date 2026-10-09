import { describe, expect, it } from 'vitest';
import { identity } from './queries.js';
import { applySnapshot } from './snapshot.js';
import { ENGINEER, me, TENANT } from './testing/fixtures.js';
import { openTestDatabase } from './testing/node-driver.js';

const NOW = new Date('2026-09-14T12:00:00.000Z');

async function download(overrides: Partial<ReturnType<typeof me>['company']>) {
  const { db } = await openTestDatabase();
  const snapshot = me();
  await db.write(['work_orders'], (sql) =>
    applySnapshot(
      sql,
      {
        me: { ...snapshot, company: { ...snapshot.company, ...overrides } },
        workOrders: [],
        customers: [],
        forms: [],
      },
      NOW,
    ),
  );
  return db;
}

describe('identity', () => {
  it('is undefined before anything has been downloaded', async () => {
    const { db } = await openTestDatabase();
    expect(await db.read(identity)).toBeUndefined();
  });

  it('keeps the whole brand the download brought, so the phone wears it offline', async () => {
    const db = await download({
      brandColour: '#1d4ed8',
      shellColour: '#0f172a',
      defaultTheme: 'dark',
      websiteUrl: 'https://northwind.example',
      logoMediaId: 'logo-1',
      appIconMediaId: 'icon-1',
    });
    const who = await db.read(identity);
    expect(who).toMatchObject({
      tenantId: TENANT,
      userId: ENGINEER,
      displayName: 'Ed Engineer',
      company: {
        name: 'Northwind Facilities',
        slug: 'northwind',
        brandColour: '#1d4ed8',
        shellColour: '#0f172a',
        defaultTheme: 'dark',
        websiteUrl: 'https://northwind.example',
        logoMediaId: 'logo-1',
        appIconMediaId: 'icon-1',
      },
      lastDownloadAt: NOW.toISOString(),
    });
  });

  it('turns an absent value back into null, and an unknown theme into following the phone', async () => {
    const db = await download({ brandColour: null, shellColour: null, websiteUrl: null });
    await db.write(['meta'], (sql) =>
      sql.run(`update meta set value = 'sepia' where key = 'default_theme'`),
    );
    const who = await db.read(identity);
    expect(who?.company).toEqual({
      name: 'Northwind Facilities',
      slug: 'northwind',
      brandColour: null,
      shellColour: null,
      defaultTheme: 'system',
      websiteUrl: null,
      logoMediaId: null,
      appIconMediaId: null,
    });
  });
});
