import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformDataSource } from '../connection.js';
import {
  asTenant,
  connectAsApp,
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
} from './harness.js';

/**
 * Test companies and limited staff sessions (0077, P38), against a real
 * database. The claims: a company's test mark is fixed at creation in both
 * directions, a staff session carries its scope, and a test company's outbox
 * is isolated like any company table.
 */

let owner: pg.Client;
let app: pg.Client;
let northwind: TenantFixture;
let contoso: TenantFixture;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  app = await connectAsApp();
  northwind = await createTenant('northwind');
  contoso = await createTenant('contoso');
});

afterAll(async () => {
  await owner.end();
  await app.end();
  await releaseTestDatabase();
});

describe('the test mark', () => {
  it('is false for an ordinary company and set only by the insert', async () => {
    const platform = getPlatformDataSource();
    expect((await platform.tenants.findById(northwind.id))?.isTest).toBe(false);
    const made = await platform.tenants.create({
      slug: `test-${crypto.randomUUID().slice(0, 8)}`,
      name: 'Test company',
      isTest: true,
    });
    expect(made.isTest).toBe(true);
  });

  it('cannot turn a real company into a test company', async () => {
    await expect(
      owner.query('update tenants set is_test = true where id = $1', [northwind.id]),
    ).rejects.toThrow(/cannot change/u);
  });

  it('cannot turn a test company into a real one', async () => {
    const made = await getPlatformDataSource().tenants.create({
      slug: `test-${crypto.randomUUID().slice(0, 8)}`,
      name: 'Another test company',
      isTest: true,
    });
    await expect(
      owner.query('update tenants set is_test = false where id = $1', [made.id]),
    ).rejects.toThrow(/cannot change/u);
  });

  it('lets every other column of a test company change', async () => {
    const made = await getPlatformDataSource().tenants.create({
      slug: `test-${crypto.randomUUID().slice(0, 8)}`,
      name: 'Renamed later',
      isTest: true,
    });
    await owner.query("update tenants set name = 'Renamed', is_test = true where id = $1", [
      made.id,
    ]);
    expect((await getPlatformDataSource().tenants.findById(made.id))?.name).toBe('Renamed');
  });
});

describe('staff session scope', () => {
  it('is full unless asked, and refuses anything unknown', async () => {
    const { rows } = await owner.query<{ id: string }>(
      `insert into platform_users (email, display_name) values ($1, 'Developer') returning id`,
      [`dev-${crypto.randomUUID().slice(0, 8)}@example.com`],
    );
    const platformUserId = rows[0]!.id;
    const sessions = getPlatformDataSource().platformSessions;
    const later = new Date(Date.now() + 3_600_000);
    const full = await sessions.create({
      platformUserId,
      expiresAt: later,
      refreshTokenHash: crypto.randomUUID(),
      refreshExpiresAt: later,
    });
    expect(full.session.scope).toBe('full');
    const limited = await sessions.create({
      platformUserId,
      expiresAt: later,
      refreshTokenHash: crypto.randomUUID(),
      refreshExpiresAt: later,
      scope: 'test_companies',
    });
    expect((await sessions.find(limited.session.id))?.scope).toBe('test_companies');
    await expect(
      owner.query("update platform_sessions set scope = 'everything' where id = $1", [
        full.session.id,
      ]),
    ).rejects.toThrow(/platform_sessions_scope_known/u);
  });
});

describe('the test outbox', () => {
  it('keeps what a company would have sent, newest first, and forgets old entries', async () => {
    const outbox = getPlatformDataSource().testOutbox;
    await outbox.record({
      tenantId: northwind.id,
      channel: 'email',
      recipient: 'customer@example.com',
      subject: 'Your invoice',
      body: 'Please find it attached.',
      details: { attachments: [{ filename: 'INV-1.pdf' }] },
    });
    await outbox.record({
      tenantId: northwind.id,
      channel: 'push',
      recipient: 'device',
      body: 'New job',
    });
    const entries = await outbox.list(northwind.id);
    expect(entries.map((entry) => entry.channel)).toEqual(['push', 'email']);
    expect(await outbox.list(contoso.id)).toEqual([]);
    expect(await outbox.deleteOlderThan(new Date(Date.now() + 1000))).toBeGreaterThanOrEqual(2);
  });

  it('is isolated by company for the runtime role', async () => {
    await getPlatformDataSource().testOutbox.record({
      tenantId: contoso.id,
      channel: 'email',
      recipient: 'someone@example.com',
      body: 'Hello',
    });
    const seen = await asTenant(app, northwind.id, async () => {
      const { rows } = await app.query<{ n: number }>('select count(*)::int as n from test_outbox');
      return rows[0]!.n;
    });
    expect(seen).toBe(0);
    await expect(
      asTenant(app, contoso.id, () =>
        app.query(
          `insert into test_outbox (tenant_id, channel, recipient, body) values ($1, 'email', 'x', 'y')`,
          [contoso.id],
        ),
      ),
    ).rejects.toThrow(/permission denied/u);
  });
});
