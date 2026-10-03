import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../connection.js';
import type { ClaimIdempotencyKeyInput } from '../repositories/idempotency.js';
import {
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  useTestDatabase,
} from './harness.js';

/**
 * Idempotency keys: what "released" and "expired" have to mean in practice.
 *
 * These exist because both used to mean nothing. `claim` never read
 * `expires_at`, so a released claim and a lapsed replay window behaved exactly
 * like a live one until the sweeper deleted the row — a request that failed once
 * answered 409 to every retry. And `release` stamped `expires_at` from the
 * application's clock, which could land before the database's `created_at` and
 * violate a check constraint, a failure the caller swallowed on purpose.
 *
 * Run through `withTenant`, so the runtime role and RLS are both in play — this
 * is the path the API takes.
 */

let tenant: TenantFixture;
let owner: pg.Client;

beforeAll(async () => {
  useTestDatabase();
  tenant = await createTenant('idempotency');
  owner = await connectAsOwner();
});

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

function claimInput(
  key: string,
  overrides: Partial<ClaimIdempotencyKeyInput> = {},
): ClaimIdempotencyKeyInput {
  return {
    idempotencyKey: key,
    userId: '00000000-0000-4000-8000-00000000a101',
    method: 'POST',
    path: '/v1/members/invitations',
    requestFingerprint: 'a'.repeat(64),
    expiresAt: new Date(Date.now() + 86_400_000),
    ...overrides,
  };
}

const claim = (input: ClaimIdempotencyKeyInput) =>
  withTenant(tenant.id, (tx) => tx.idempotency.claim(input));

/** Moves a row's window into the past, as the passage of a day would. */
async function lapse(key: string): Promise<void> {
  await owner.query(
    `update idempotency_keys
        set created_at = now() - interval '2 days',
            expires_at = now() - interval '1 day'
      where tenant_id = $1 and idempotency_key = $2`,
    [tenant.id, key],
  );
}

describe('a live key', () => {
  it('is claimed once, and reported in progress to everybody after', async () => {
    const key = randomUUID();

    expect((await claim(claimInput(key))).outcome).toBe('claimed');
    expect((await claim(claimInput(key))).outcome).toBe('in_progress');
  });

  it('replays a completed response while its window is open', async () => {
    const key = randomUUID();
    await claim(claimInput(key));
    await withTenant(tenant.id, (tx) =>
      tx.idempotency.complete(key, { status: 201, body: { id: 'first' } }),
    );

    const again = await claim(claimInput(key));

    expect(again.outcome).toBe('replay');
    expect(again.record.responseBody).toEqual({ id: 'first' });
  });

  it('refuses the same key with a different request', async () => {
    const key = randomUUID();
    await claim(claimInput(key));

    const other = await claim(claimInput(key, { requestFingerprint: 'b'.repeat(64) }));

    expect(other.outcome).toBe('fingerprint_mismatch');
  });
});

describe('a released key', () => {
  it('can be claimed again straight away', async () => {
    const key = randomUUID();
    await claim(claimInput(key));

    const released = await withTenant(tenant.id, (tx) => tx.idempotency.release(key));
    expect(released).toBe(true);

    const retried = await claim(claimInput(key));
    expect(retried.outcome).toBe('claimed');
    expect(retried.record.status).toBe('in_progress');
  });

  it('releases a key claimed an instant earlier', async () => {
    // Claim and release back to back is what a handler that throws immediately
    // produces. Worth being plain about what this does *not* prove: the clock
    // defect needed the application's clock to trail the database's, and here
    // both run on one machine, so this passes against the old code too. What
    // closes that defect is `release` no longer taking a timestamp from the
    // application at all.
    const key = randomUUID();
    await claim(claimInput(key));

    await expect(withTenant(tenant.id, (tx) => tx.idempotency.release(key))).resolves.toBe(true);
  });
});

describe('an expired key', () => {
  it('is not replayed once its window has closed', async () => {
    const key = randomUUID();
    await claim(claimInput(key));
    await withTenant(tenant.id, (tx) =>
      tx.idempotency.complete(key, { status: 201, body: { id: 'stale' } }),
    );
    await lapse(key);

    const fresh = await claim(claimInput(key));

    expect(fresh.outcome).toBe('claimed');
    expect(fresh.record.responseBody).toBeNull();
    expect(fresh.record.responseStatus).toBeNull();
  });

  it('may be taken over with a different request, since the old one is gone', async () => {
    const key = randomUUID();
    await claim(claimInput(key));
    await lapse(key);

    const takeover = await claim(claimInput(key, { requestFingerprint: 'c'.repeat(64) }));

    expect(takeover.outcome).toBe('claimed');
    expect(takeover.record.requestFingerprint).toBe('c'.repeat(64));
  });

  it('is taken over by exactly one of several simultaneous claims', async () => {
    const key = randomUUID();
    await claim(claimInput(key));
    await lapse(key);

    const outcomes = await Promise.all(
      Array.from({ length: 6 }, () => claim(claimInput(key)).then((result) => result.outcome)),
    );

    expect(outcomes.filter((outcome) => outcome === 'claimed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'in_progress')).toHaveLength(5);
  });
});
