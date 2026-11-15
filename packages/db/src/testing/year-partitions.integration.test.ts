import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateVolume } from '../volume/generate.js';
import {
  connectAsApp,
  connectAsOwner,
  connectAsPlatform,
  releaseTestDatabase,
  requireDisposableDatabase,
  truncateAll,
  useTestDatabase,
} from './harness.js';

/**
 * The tables split by year (P41): rows land in their year, a year made late
 * takes its rows out of the default partition, and the policies and the
 * append-only rules hold through the parent and cannot be gone around by
 * naming a partition.
 */

let owner: pg.Client;
let company: { id: string };
const ACTOR = '00000000-0000-4000-8000-00000000a001';

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  // A small made-up company, which has work orders to hang events on.
  await generateVolume(requireDisposableDatabase().adminUrl, {
    companies: 1,
    years: 1,
    scale: 0.005,
  });
  const row = await owner.query<{ id: string }>(
    `select id from tenants where slug like 'volume-%'`,
  );
  company = { id: row.rows[0]?.id ?? '' };
}, 120_000);

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

async function partitionOf(table: string, where: string, params: unknown[]): Promise<string[]> {
  const result = await owner.query<{ part: string }>(
    `select tableoid::regclass::text as part from ${table} where ${where}`,
    params,
  );
  return result.rows.map((row) => row.part);
}

describe('year partitions', () => {
  it('puts a row in the partition of its UTC year', async () => {
    const year = new Date().getUTCFullYear();
    await owner.query(
      `insert into audit_log (tenant_id, actor_kind, actor_id, actor_label, action, resource_type)
       values ($1, 'tenant_user', $2, 'Test', 'test.now', 'test')`,
      [company.id, ACTOR],
    );
    expect(await partitionOf('audit_log', `action = 'test.now'`, [])).toEqual([
      `audit_log_y${String(year)}`,
    ]);
  });

  it('keeps an old row in the default partition until its year is made, then moves it, identity and all', async () => {
    await owner.query(
      `insert into audit_log (tenant_id, occurred_at, actor_kind, actor_id, actor_label, action, resource_type)
       values ($1, '2003-05-01', 'tenant_user', $2, 'Test', 'test.old', 'test')`,
      [company.id, ACTOR],
    );
    // work_order_events has an identity column, which the move must keep as it was.
    const order = await owner.query<{ id: string }>(
      `select id from work_orders where tenant_id = $1 limit 1`,
      [company.id],
    );
    const event = await owner.query<{ sequence: string }>(
      `insert into work_order_events (tenant_id, work_order_id, kind, actor_id, occurred_at)
       values ($1, $2, 'updated', $3, '2003-05-01') returning sequence::text`,
      [company.id, order.rows[0]?.id, ACTOR],
    );
    expect(await partitionOf('audit_log', `action = 'test.old'`, [])).toEqual([
      'audit_log_default',
    ]);

    const platform = await connectAsPlatform();
    try {
      const made = await platform.query<{ made: number }>(
        'select ensure_year_partitions() as made',
      );
      expect(made.rows[0]?.made).toBeGreaterThanOrEqual(1);
    } finally {
      await platform.end();
    }

    expect(await partitionOf('audit_log', `action = 'test.old'`, [])).toEqual(['audit_log_y2003']);
    expect(
      await partitionOf('work_order_events', 'sequence = $1', [event.rows[0]?.sequence]),
    ).toEqual(['work_order_events_y2003']);
    const leftOver = await owner.query(`select 1 from audit_log_default`);
    expect(leftOver.rowCount).toBe(0);
  });

  it('keeps the audit log append-only through the parent', async () => {
    await expect(owner.query(`delete from audit_log where action = 'test.now'`)).rejects.toThrow(
      /append-only/u,
    );
  });

  it('lets no role but the owner name a partition, so no policy or trigger can be gone around', async () => {
    const year = new Date().getUTCFullYear();
    const app = await connectAsApp();
    const platform = await connectAsPlatform();
    try {
      await expect(app.query(`select * from audit_log_y${String(year)}`)).rejects.toThrow(
        /permission denied/u,
      );
      await expect(platform.query(`delete from audit_log_y${String(year)}`)).rejects.toThrow(
        /permission denied/u,
      );
    } finally {
      await app.end();
      await platform.end();
    }
  });
});
