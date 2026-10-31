import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformDataSource } from '../connection.js';
import {
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  useTestDatabase,
} from './harness.js';

/**
 * The worker's nightly delete of three ever-growing tables (0065).
 *
 * What matters is the boundary: rows past their cutoff go, rows inside it stay,
 * and a backlog bigger than one batch is worked through rather than trimmed by
 * one batch a night.
 */

let tenant: TenantFixture;
let owner: pg.Client;

beforeAll(async () => {
  useTestDatabase();
  tenant = await createTenant('housekeeping');
  owner = await connectAsOwner();
});

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

const DAY = 24 * 60 * 60 * 1000;

async function count(sqlText: string, values: unknown[]): Promise<number> {
  const result = await owner.query<{ n: string }>(sqlText, values);
  return Number(result.rows[0]?.n ?? 0);
}

describe('table housekeeping', () => {
  it('deletes what is past its cutoff, in batches, and keeps the rest', async () => {
    const tag = randomUUID().slice(0, 8);
    const now = new Date();

    // Rate-limit counters: seven from three days ago, one from an hour ago.
    for (let i = 0; i < 7; i += 1) {
      await owner.query(
        `insert into rate_limit_buckets (bucket_key, window_started_at, request_count)
         values ($1, $2, 1)`,
        [`hk:${tag}:${i}`, new Date(now.getTime() - 3 * DAY - i * 60_000)],
      );
    }
    await owner.query(
      `insert into rate_limit_buckets (bucket_key, window_started_at, request_count)
       values ($1, $2, 1)`,
      [`hk:${tag}:recent`, new Date(now.getTime() - 60 * 60 * 1000)],
    );

    // Login attempts: one from 100 days ago, one from yesterday.
    await owner.query(
      `insert into login_attempts (email, outcome, occurred_at) values ($1, 'bad_credentials', $2)`,
      [`old.${tag}@test.integr8.example`, new Date(now.getTime() - 100 * DAY)],
    );
    await owner.query(
      `insert into login_attempts (email, outcome, occurred_at) values ($1, 'bad_credentials', $2)`,
      [`new.${tag}@test.integr8.example`, new Date(now.getTime() - DAY)],
    );

    // Idempotency records: one whose window closed yesterday, one still open.
    const userId = '00000000-0000-4000-8000-00000000a201';
    await owner.query(
      `insert into idempotency_keys
         (tenant_id, idempotency_key, user_id, method, path, request_fingerprint, created_at, expires_at)
       values ($1, $2, $3, 'POST', '/v1/x', $4, now() - interval '2 days', now() - interval '1 day')`,
      [tenant.id, `hk-old-${tag}`, userId, 'a'.repeat(64)],
    );
    await owner.query(
      `insert into idempotency_keys
         (tenant_id, idempotency_key, user_id, method, path, request_fingerprint, expires_at)
       values ($1, $2, $3, 'POST', '/v1/x', $4, now() + interval '1 day')`,
      [tenant.id, `hk-live-${tag}`, userId, 'b'.repeat(64)],
    );

    const report = await getPlatformDataSource().housekeeping.sweep(
      {
        rateLimitWindowsBefore: new Date(now.getTime() - DAY),
        idempotencyExpiredBefore: now,
        loginAttemptsBefore: new Date(now.getTime() - 90 * DAY),
      },
      // Smaller than the backlog, so the loop has to go round.
      { batchSize: 3 },
    );

    expect(report.rateLimitBuckets).toBeGreaterThanOrEqual(7);
    expect(report.loginAttempts).toBeGreaterThanOrEqual(1);
    expect(report.idempotencyKeys).toBeGreaterThanOrEqual(1);

    expect(
      await count(`select count(*) as n from rate_limit_buckets where bucket_key like $1`, [
        `hk:${tag}:%`,
      ]),
    ).toBe(1);
    expect(
      await count(`select count(*) as n from login_attempts where email like $1`, [`%.${tag}@%`]),
    ).toBe(1);
    expect(
      await count(
        `select count(*) as n from idempotency_keys where tenant_id = $1 and idempotency_key like $2`,
        [tenant.id, `hk-%-${tag}`],
      ),
    ).toBe(1);
    expect(
      await count(`select count(*) as n from idempotency_keys where idempotency_key = $1`, [
        `hk-live-${tag}`,
      ]),
    ).toBe(1);
  });

  it('stops after its batch allowance, leaving the rest for the next night', async () => {
    const tag = randomUUID().slice(0, 8);
    const old = new Date(Date.now() - 5 * DAY);
    for (let i = 0; i < 5; i += 1) {
      await owner.query(
        `insert into rate_limit_buckets (bucket_key, window_started_at, request_count)
         values ($1, $2, 1)`,
        [`hk2:${tag}:${i}`, new Date(old.getTime() - i * 60_000)],
      );
    }

    const report = await getPlatformDataSource().housekeeping.sweep(
      {
        rateLimitWindowsBefore: new Date(Date.now() - DAY),
        idempotencyExpiredBefore: new Date(0),
        loginAttemptsBefore: new Date(0),
      },
      { batchSize: 2, maxBatches: 1 },
    );

    expect(report.rateLimitBuckets).toBe(2);
  });
});
