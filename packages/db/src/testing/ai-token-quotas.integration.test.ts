import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../connection.js';
import {
  AiMemberLimitsVersionConflictError,
  AiSharesOverTotalError,
} from '../repositories/ai-member-limits.js';
import {
  AiMemberBudgetExceededError,
  AiTokenQuotaExceededError,
} from '../repositories/ai-usage.js';
import {
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  useTestDatabase,
} from './harness.js';

/**
 * Token allowances, members' shares and members' dollar caps (docs/ai/ADR-0002).
 *
 * The properties that matter: a company's shares never pass 100%, however two
 * owners race; simultaneous token holds never pass the company's pool or a
 * member's slice; a call's hold becomes what it used, once; and one company's
 * shares and counters are invisible to another. Everything runs through
 * `withTenant`, so the runtime role and RLS are in play.
 */

const PERIODS = { day: '2026-10-15', month: '2026-10-01' };
let company: TenantFixture;
let other: TenantFixture;
const members: string[] = [];

async function member(tenantId: TenantFixture['id'], name: string): Promise<string> {
  const userId = randomUUID();
  await withTenant(tenantId, (tx) =>
    tx.tenantUsers.create({
      userId,
      email: `${name}-${userId.slice(0, 8)}@example.com`,
      displayName: name,
      role: 'engineer',
    }),
  );
  return userId;
}

async function openRequest(tenantId: TenantFixture['id'], userId: string, cap?: number) {
  return withTenant(tenantId, async (tx) => {
    const conversation = await tx.aiConversations.create({ userId, locale: 'en', level: 'help' });
    const outcome = await tx.aiUsage.reserve({
      userId,
      conversationId: conversation.id,
      clientRequestId: randomUUID(),
      requestFingerprint: 'f'.repeat(64),
      periods: PERIODS,
      limits: { tenantDaily: null, tenantMonthly: null, userDaily: null, userMonthly: null },
      costMicrousd: 1_000,
      costCapMicrousd: null,
      memberCostCapMicrousd: cap ?? null,
      expiresAt: new Date(Date.now() + 60_000),
    });
    return outcome.reservation.id;
  });
}

async function tenantTokens(tenantId: TenantFixture['id'], userId: string) {
  return withTenant(tenantId, (tx) => tx.aiUsage.tokenCounters(userId, PERIODS));
}

beforeAll(async () => {
  useTestDatabase();
  company = await createTenant('ai-tokens');
  other = await createTenant('ai-tokens-other');
  for (const name of ['amal', 'bassem', 'carla', 'dina']) {
    members.push(await member(company.id, name));
  }
});

afterAll(async () => {
  await releaseTestDatabase();
});

describe('shares of the company’s allowance', () => {
  it('total 100% or less, and say how much is left when they would not', async () => {
    const [amal, bassem, carla] = members as [string, string, string];
    const first = await withTenant(company.id, (tx) =>
      tx.aiMemberLimits.set({
        userId: amal,
        sharePercent: 60,
        expectedVersion: null,
        updatedBy: null,
      }),
    );
    expect(first).toMatchObject({ sharePercent: 60, version: 1 });
    await withTenant(company.id, (tx) =>
      tx.aiMemberLimits.set({
        userId: bassem,
        sharePercent: 30,
        expectedVersion: null,
        updatedBy: null,
      }),
    );
    await expect(
      withTenant(company.id, (tx) =>
        tx.aiMemberLimits.set({
          userId: carla,
          sharePercent: 20,
          expectedVersion: null,
          updatedBy: null,
        }),
      ),
    ).rejects.toMatchObject({ availablePercent: 10 });
    expect(await withTenant(company.id, (tx) => tx.aiMemberLimits.assignedPercent())).toBe(90);

    // Lowering one's own share frees room for another.
    await withTenant(company.id, (tx) =>
      tx.aiMemberLimits.set({
        userId: amal,
        sharePercent: 50,
        expectedVersion: 1,
        updatedBy: null,
      }),
    );
    const carlas = await withTenant(company.id, (tx) =>
      tx.aiMemberLimits.set({
        userId: carla,
        sharePercent: 20,
        expectedVersion: null,
        updatedBy: null,
      }),
    );
    expect(carlas.sharePercent).toBe(20);
    expect(await withTenant(company.id, (tx) => tx.aiMemberLimits.assignedPercent())).toBe(100);
  });

  it('never pass 100% when two owners save at once', async () => {
    const own = await createTenant('ai-shares-race');
    const people = await Promise.all(
      Array.from({ length: 8 }, (_, index) => member(own.id, `p${String(index)}`)),
    );
    const attempts = await Promise.allSettled(
      people.map((userId) =>
        withTenant(own.id, (tx) =>
          tx.aiMemberLimits.set({
            userId,
            sharePercent: 30,
            expectedVersion: null,
            updatedBy: null,
          }),
        ),
      ),
    );
    const saved = attempts.filter((attempt) => attempt.status === 'fulfilled');
    const refused = attempts.filter(
      (attempt) =>
        attempt.status === 'rejected' && attempt.reason instanceof AiSharesOverTotalError,
    );
    expect(saved).toHaveLength(3);
    expect(refused).toHaveLength(5);
    expect(await withTenant(own.id, (tx) => tx.aiMemberLimits.assignedPercent())).toBe(90);
  });

  it('refuse a write against a version somebody else has moved on from', async () => {
    const [, , , dina] = members as [string, string, string, string];
    await withTenant(company.id, (tx) =>
      tx.aiMemberLimits.set({
        userId: dina,
        monthlyCostCapMicrousd: 500_000,
        expectedVersion: null,
        updatedBy: null,
      }),
    );
    await expect(
      withTenant(company.id, (tx) =>
        tx.aiMemberLimits.set({
          userId: dina,
          sharePercent: null,
          expectedVersion: null,
          updatedBy: null,
        }),
      ),
    ).rejects.toBeInstanceOf(AiMemberLimitsVersionConflictError);
    // A field left out keeps its value.
    const kept = await withTenant(company.id, (tx) => tx.aiMemberLimits.find(dina));
    expect(kept).toMatchObject({ sharePercent: null, monthlyCostCapMicrousd: 500_000, version: 1 });
  });

  it('are invisible to another company', async () => {
    expect(await withTenant(other.id, (tx) => tx.aiMemberLimits.list())).toEqual([]);
    expect(await withTenant(other.id, (tx) => tx.aiMemberLimits.assignedPercent())).toBe(0);
    const [amal] = members as [string];
    expect(await withTenant(other.id, (tx) => tx.aiMemberLimits.find(amal))).toBeUndefined();
  });
});

describe('token holds', () => {
  it('never pass the company’s pool under simultaneous holds from two members', async () => {
    const own = await createTenant('ai-token-race');
    const [first, second] = await Promise.all([member(own.id, 'one'), member(own.id, 'two')]);
    const requests = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        openRequest(own.id, index % 2 === 0 ? first : second),
      ),
    );
    const limits = { tenantDaily: 10_000, tenantMonthly: null, userDaily: null, userMonthly: null };
    const attempts = await Promise.allSettled(
      requests.map((reservationId) =>
        withTenant(own.id, (tx) => tx.aiUsage.holdTokens({ reservationId, tokens: 1_000, limits })),
      ),
    );
    expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(10);
    expect(
      attempts.filter(
        (attempt) =>
          attempt.status === 'rejected' && attempt.reason instanceof AiTokenQuotaExceededError,
      ),
    ).toHaveLength(10);
    const counters = await tenantTokens(own.id, first);
    const day = counters.find((row) => row.subject === 'tenant' && row.period === 'day');
    expect(day).toMatchObject({ used: 0, reserved: 10_000 });
  });

  it('hold a member to their slice even with the company pool to spare', async () => {
    const own = await createTenant('ai-token-slice');
    const userId = await member(own.id, 'slice');
    const reservationId = await openRequest(own.id, userId);
    const limits = {
      tenantDaily: 100_000,
      tenantMonthly: null,
      userDaily: 2_000,
      userMonthly: null,
    };
    await withTenant(own.id, (tx) =>
      tx.aiUsage.holdTokens({ reservationId, tokens: 1_500, limits }),
    );
    await expect(
      withTenant(own.id, (tx) => tx.aiUsage.holdTokens({ reservationId, tokens: 1_000, limits })),
    ).rejects.toMatchObject({ axis: 'day', subject: 'user' });
  });

  it('turn a hold into what was used, once, and never go negative', async () => {
    const own = await createTenant('ai-token-settle');
    const userId = await member(own.id, 'settle');
    const reservationId = await openRequest(own.id, userId);
    const limits = { tenantDaily: null, tenantMonthly: null, userDaily: null, userMonthly: null };
    await withTenant(own.id, (tx) =>
      tx.aiUsage.holdTokens({ reservationId, tokens: 9_500, limits }),
    );
    await withTenant(own.id, (tx) =>
      tx.aiUsage.settleTokens({ reservationId, held: 9_500, used: 1_234 }),
    );
    // A second settlement of the same hold finds nothing held and adds only its use.
    await withTenant(own.id, (tx) =>
      tx.aiUsage.settleTokens({ reservationId, held: 9_500, used: 0 }),
    );

    for (const row of await tenantTokens(own.id, userId)) {
      expect(row).toMatchObject({ used: 1_234, reserved: 0 });
    }
    const reservation = await withTenant(own.id, (tx) => tx.aiUsage.find(reservationId));
    expect(reservation).toMatchObject({ reservedTokens: 0, usedTokens: 1_234 });
  });

  it('keep one company’s counters from another', async () => {
    const [amal] = members as [string];
    const reservationId = await openRequest(company.id, amal);
    await withTenant(company.id, (tx) =>
      tx.aiUsage.holdTokens({
        reservationId,
        tokens: 777,
        limits: { tenantDaily: null, tenantMonthly: null, userDaily: null, userMonthly: null },
      }),
    );
    const seenByOther = await withTenant(other.id, (tx) => tx.aiUsage.tokenCounters(amal, PERIODS));
    expect(seenByOther.every((row) => row.used === 0 && row.reserved === 0)).toBe(true);
    await expect(
      withTenant(other.id, (tx) =>
        tx.aiUsage.holdTokens({
          reservationId,
          tokens: 1,
          limits: { tenantDaily: null, tenantMonthly: null, userDaily: null, userMonthly: null },
        }),
      ),
    ).rejects.toThrow(/no open reservation/u);
  });
});

describe('a member’s own dollar cap', () => {
  it('refuses a request that would pass it, and attributes spend either way', async () => {
    const own = await createTenant('ai-member-cap');
    const userId = await member(own.id, 'capped');
    await openRequest(own.id, userId, 1_500);
    await expect(openRequest(own.id, userId, 1_500)).rejects.toBeInstanceOf(
      AiMemberBudgetExceededError,
    );
    const ledger = await withTenant(own.id, (tx) =>
      tx.aiUsage.memberCostPeriod(userId, PERIODS.month),
    );
    expect(ledger).toEqual({ reserved: 1_000, spent: 0, unknown: 0 });
  });
});
