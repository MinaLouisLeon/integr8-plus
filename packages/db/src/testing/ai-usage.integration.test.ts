import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformDataSource, withTenant } from '../connection.js';
import { AiBudgetExceededError, AiQuotaExceededError } from '../repositories/ai-usage.js';
import {
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  useTestDatabase,
} from './harness.js';

/**
 * Admitting and charging assistant messages (docs/ai; ADR-0001).
 *
 * The property that matters: with N slots left, N simultaneous requests are
 * admitted and the rest refused, however they interleave; a retried request
 * is answered from its first reservation; and a slot is charged only when an
 * answer is stored. Everything runs through `withTenant`, so the runtime role,
 * RLS and the query guard are all in play.
 */

let tenant: TenantFixture;
const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';
const PERIODS = { day: '2026-10-15', month: '2026-10-01' };

beforeAll(async () => {
  useTestDatabase();
  tenant = await createTenant('ai-usage');
});

afterAll(async () => {
  await releaseTestDatabase();
});

async function conversation(userId: string): Promise<string> {
  return withTenant(tenant.id, async (tx) => {
    const created = await tx.aiConversations.create({ userId, locale: 'en', level: 'help' });
    return created.id;
  });
}

function reserve(input: {
  userId: string;
  conversationId: string;
  clientRequestId?: string;
  fingerprint?: string;
  tenantDaily?: number | null;
  tenantMonthly?: number | null;
  userDaily?: number | null;
  userMonthly?: number | null;
  cost?: number;
  cap?: number | null;
}) {
  return withTenant(tenant.id, (tx) =>
    tx.aiUsage.reserve({
      userId: input.userId,
      conversationId: input.conversationId,
      clientRequestId: input.clientRequestId ?? randomUUID(),
      requestFingerprint: input.fingerprint ?? 'f'.repeat(64),
      periods: PERIODS,
      limits: {
        tenantDaily: input.tenantDaily ?? null,
        tenantMonthly: input.tenantMonthly ?? null,
        userDaily: input.userDaily ?? null,
        userMonthly: input.userMonthly ?? null,
      },
      costMicrousd: input.cost ?? 1_000,
      costCapMicrousd: input.cap ?? null,
      expiresAt: new Date(Date.now() + 60_000),
    }),
  );
}

describe('admission at the quota boundary', () => {
  it('admits exactly the slots left under many simultaneous requests', async () => {
    const own = await createTenant('ai-race');
    const conv = await withTenant(own.id, async (tx) => {
      const created = await tx.aiConversations.create({
        userId: USER_A,
        locale: 'en',
        level: 'help',
      });
      return created.id;
    });
    const LIMIT = 10;
    const attempts = await Promise.allSettled(
      Array.from({ length: 60 }, () =>
        withTenant(own.id, (tx) =>
          tx.aiUsage.reserve({
            userId: USER_A,
            conversationId: conv,
            clientRequestId: randomUUID(),
            requestFingerprint: 'f'.repeat(64),
            periods: PERIODS,
            limits: { tenantDaily: LIMIT, tenantMonthly: 1000, userDaily: null, userMonthly: null },
            costMicrousd: 1,
            costCapMicrousd: null,
            expiresAt: new Date(Date.now() + 60_000),
          }),
        ),
      ),
    );
    const admitted = attempts.filter(
      (result) => result.status === 'fulfilled' && result.value.outcome === 'claimed',
    );
    const refused = attempts.filter(
      (result) => result.status === 'rejected' && result.reason instanceof AiQuotaExceededError,
    );
    expect(admitted).toHaveLength(LIMIT);
    expect(refused).toHaveLength(60 - LIMIT);

    const counters = await withTenant(own.id, (tx) => tx.aiUsage.counters(USER_A, PERIODS));
    const tenantDay = counters.find((row) => row.subject === 'tenant' && row.period === 'day');
    expect(tenantDay).toMatchObject({ used: 0, reserved: LIMIT });
    // A refused request leaves nothing behind.
    const userMonth = counters.find((row) => row.subject === 'user' && row.period === 'month');
    expect(userMonth).toMatchObject({ used: 0, reserved: LIMIT });
  });

  it('refuses on the member’s own limit without touching the company’s', async () => {
    const own = await createTenant('ai-user-cap');
    const conv = await withTenant(own.id, async (tx) => {
      const created = await tx.aiConversations.create({
        userId: USER_B,
        locale: 'ar',
        level: 'help',
      });
      return created.id;
    });
    const call = () =>
      withTenant(own.id, (tx) =>
        tx.aiUsage.reserve({
          userId: USER_B,
          conversationId: conv,
          clientRequestId: randomUUID(),
          requestFingerprint: 'f'.repeat(64),
          periods: PERIODS,
          limits: { tenantDaily: 100, tenantMonthly: null, userDaily: 2, userMonthly: null },
          costMicrousd: 1,
          costCapMicrousd: null,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      );
    expect((await call()).outcome).toBe('claimed');
    expect((await call()).outcome).toBe('claimed');
    await expect(call()).rejects.toMatchObject({ axis: 'day', subject: 'user' });
  });

  it('refuses past the month’s cost ceiling and takes the reservation row with it', async () => {
    const own = await createTenant('ai-budget');
    const conv = await withTenant(own.id, async (tx) => {
      const created = await tx.aiConversations.create({
        userId: USER_A,
        locale: 'en',
        level: 'help',
      });
      return created.id;
    });
    const key = randomUUID();
    await expect(
      withTenant(own.id, (tx) =>
        tx.aiUsage.reserve({
          userId: USER_A,
          conversationId: conv,
          clientRequestId: key,
          requestFingerprint: 'f'.repeat(64),
          periods: PERIODS,
          limits: { tenantDaily: null, tenantMonthly: 10, userDaily: null, userMonthly: null },
          costMicrousd: 2_000_000,
          costCapMicrousd: 1_000_000,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      ),
    ).rejects.toBeInstanceOf(AiBudgetExceededError);
    expect(await withTenant(own.id, (tx) => tx.aiUsage.findByRequest(USER_A, key))).toBeUndefined();
    expect(await withTenant(own.id, (tx) => tx.aiUsage.costPeriod(PERIODS.month))).toEqual({
      reserved: 0,
      spent: 0,
      unknown: 0,
    });
  });
});

describe('one request, one charge', () => {
  it('answers a retry from the first reservation, and a changed retry with a mismatch', async () => {
    const conv = await conversation(USER_A);
    const key = randomUUID();
    const first = await reserve({ userId: USER_A, conversationId: conv, clientRequestId: key });
    expect(first.outcome).toBe('claimed');

    const again = await reserve({ userId: USER_A, conversationId: conv, clientRequestId: key });
    expect(again.outcome).toBe('in_progress');
    expect(again.reservation.id).toBe(first.reservation.id);

    const changed = await reserve({
      userId: USER_A,
      conversationId: conv,
      clientRequestId: key,
      fingerprint: 'e'.repeat(64),
    });
    expect(changed.outcome).toBe('fingerprint_mismatch');

    // The same key from another member is another request.
    const other = await reserve({ userId: USER_B, conversationId: conv, clientRequestId: key });
    expect(other.outcome).toBe('claimed');
  });

  it('charges a slot only when the answer is stored, and gives it back otherwise', async () => {
    const own = await createTenant('ai-settle');
    const conv = await withTenant(own.id, async (tx) => {
      const created = await tx.aiConversations.create({
        userId: USER_A,
        locale: 'en',
        level: 'help',
      });
      return created.id;
    });
    const claim = () =>
      withTenant(own.id, (tx) =>
        tx.aiUsage.reserve({
          userId: USER_A,
          conversationId: conv,
          clientRequestId: randomUUID(),
          requestFingerprint: 'f'.repeat(64),
          periods: PERIODS,
          limits: { tenantDaily: 5, tenantMonthly: null, userDaily: null, userMonthly: null },
          costMicrousd: 5_000,
          costCapMicrousd: 100_000,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      );

    const completed = await claim();
    const released = await claim();
    if (completed.outcome !== 'claimed' || released.outcome !== 'claimed') {
      throw new Error('expected two claims');
    }

    const answer = await withTenant(own.id, (tx) =>
      tx.aiConversations.appendMessage({
        conversationId: conv,
        userId: null,
        role: 'assistant',
        content: 'Here is how.',
        usageReservationId: completed.reservation.id,
      }),
    );
    const settled = await withTenant(own.id, (tx) =>
      tx.aiUsage.settle({
        reservationId: completed.reservation.id,
        outcome: 'completed',
        responseMessageId: answer.id,
        spentMicrousd: 1_200,
      }),
    );
    expect(settled?.state).toBe('completed');
    expect(settled?.responseMessageId).toBe(answer.id);

    await withTenant(own.id, (tx) =>
      tx.aiUsage.settle({
        reservationId: released.reservation.id,
        outcome: 'released',
        spentMicrousd: 0,
        errorCode: 'ai_provider_unavailable',
      }),
    );

    const counters = await withTenant(own.id, (tx) => tx.aiUsage.counters(USER_A, PERIODS));
    for (const counter of counters) {
      expect(counter).toMatchObject({ used: 1, reserved: 0 });
    }
    expect(await withTenant(own.id, (tx) => tx.aiUsage.costPeriod(PERIODS.month))).toEqual({
      reserved: 0,
      spent: 1_200,
      unknown: 0,
    });

    // Settling twice changes nothing.
    const twice = await withTenant(own.id, (tx) =>
      tx.aiUsage.settle({
        reservationId: completed.reservation.id,
        outcome: 'released',
        spentMicrousd: 999,
      }),
    );
    expect(twice?.state).toBe('completed');
    expect(await withTenant(own.id, (tx) => tx.aiUsage.costPeriod(PERIODS.month))).toEqual({
      reserved: 0,
      spent: 1_200,
      unknown: 0,
    });

    // A completed reservation replays rather than reserving again.
    const replay = await withTenant(own.id, (tx) =>
      tx.aiUsage.reserve({
        userId: USER_A,
        conversationId: conv,
        clientRequestId: completed.reservation.clientRequestId,
        requestFingerprint: 'f'.repeat(64),
        periods: PERIODS,
        limits: { tenantDaily: 5, tenantMonthly: null, userDaily: null, userMonthly: null },
        costMicrousd: 5_000,
        costCapMicrousd: 100_000,
        expiresAt: new Date(Date.now() + 60_000),
      }),
    );
    expect(replay.outcome).toBe('replay');
  });

  it('keeps an uncertain reservation counted until the reconciler decides', async () => {
    const own = await createTenant('ai-uncertain');
    const conv = await withTenant(own.id, async (tx) => {
      const created = await tx.aiConversations.create({
        userId: USER_A,
        locale: 'en',
        level: 'help',
      });
      return created.id;
    });
    const claimed = await withTenant(own.id, (tx) =>
      tx.aiUsage.reserve({
        userId: USER_A,
        conversationId: conv,
        clientRequestId: randomUUID(),
        requestFingerprint: 'f'.repeat(64),
        periods: PERIODS,
        limits: { tenantDaily: 5, tenantMonthly: null, userDaily: null, userMonthly: null },
        costMicrousd: 5_000,
        costCapMicrousd: null,
        expiresAt: new Date(Date.now() - 1),
      }),
    );
    if (claimed.outcome !== 'claimed') {
      throw new Error('expected a claim');
    }
    await withTenant(own.id, (tx) =>
      tx.aiUsage.settle({
        reservationId: claimed.reservation.id,
        outcome: 'uncertain',
        spentMicrousd: 0,
        unknownMicrousd: 5_000,
        errorCode: 'timeout',
      }),
    );
    const counters = await withTenant(own.id, (tx) => tx.aiUsage.counters(USER_A, PERIODS));
    expect(counters[0]).toMatchObject({ used: 0, reserved: 1 });
    expect(await withTenant(own.id, (tx) => tx.aiUsage.costPeriod(PERIODS.month))).toEqual({
      reserved: 0,
      spent: 0,
      unknown: 5_000,
    });
    const stale = await withTenant(own.id, (tx) => tx.aiUsage.listStale(new Date()));
    expect(stale.map((row) => row.id)).toContain(claimed.reservation.id);
    expect((await getPlatformDataSource().ai.staleReservations(new Date())).count).toBeGreaterThan(
      0,
    );

    // The reconciler finds no stored answer and releases it: the slot and the
    // unknown money come back.
    await withTenant(own.id, (tx) =>
      tx.aiUsage.settle({
        reservationId: claimed.reservation.id,
        outcome: 'released',
        spentMicrousd: 0,
      }),
    );
    const after = await withTenant(own.id, (tx) => tx.aiUsage.counters(USER_A, PERIODS));
    expect(after[0]).toMatchObject({ used: 0, reserved: 0 });
    expect(await withTenant(own.id, (tx) => tx.aiUsage.costPeriod(PERIODS.month))).toEqual({
      reserved: 0,
      spent: 0,
      unknown: 0,
    });
  });
});

describe('the platform’s side', () => {
  it('starts every plan off, and refuses a stale write', async () => {
    const platform = getPlatformDataSource().ai;
    const plans = await platform.planPolicies();
    expect(plans.map((plan) => plan.plan)).toEqual(['enterprise', 'standard', 'starter', 'trial']);
    expect(plans.every((plan) => plan.level === 'off')).toBe(true);

    const trial = plans.find((plan) => plan.plan === 'trial');
    if (trial === undefined) {
      throw new Error('no trial policy');
    }
    const written = await platform.setPlanPolicy(
      'trial',
      { ...trial, level: 'help', quotaMode: 'daily', dailyLimit: 10 },
      { expectedVersion: trial.version, updatedBy: null },
    );
    expect(written.version).toBe(trial.version + 1);
    await expect(
      platform.setPlanPolicy('trial', trial, { expectedVersion: trial.version, updatedBy: null }),
    ).rejects.toMatchObject({ currentVersion: trial.version + 1 });
    // Back to off, for the suites that follow.
    await platform.setPlanPolicy('trial', trial, {
      expectedVersion: written.version,
      updatedBy: null,
    });
  });

  it('reserves the deployment’s budget first and refuses past the cap', async () => {
    const platform = getPlatformDataSource().ai;
    const month = '2031-01-01';
    expect(await platform.reserveGlobalBudget(month, 600, 1_000)).toBe(true);
    expect(await platform.reserveGlobalBudget(month, 600, 1_000)).toBe(false);
    await platform.settleGlobalBudget(month, { reserved: 600, spent: 250, unknown: 0 });
    expect(await platform.globalBudget(month)).toEqual({ reserved: 0, spent: 250, unknown: 0 });
    expect(await platform.reserveGlobalBudget(month, 600, 1_000)).toBe(true);
  });

  it('writes a company override once per version, and reports its usage', async () => {
    const platform = getPlatformDataSource().ai;
    const policy = {
      level: 'insights' as const,
      quotaMode: 'daily_and_monthly' as const,
      dailyLimit: 50,
      monthlyLimit: 1000,
      perUserDailyLimit: 10,
      perUserMonthlyLimit: null,
      unlimitedMessages: false,
      monthlyCostCapMicrousd: 5_000_000,
      maxInputTokens: 4000,
      maxOutputTokens: 600,
      maxToolSteps: 3,
      maxProviderCalls: 3,
      allowHistory: true,
      retentionDays: 30,
    };
    const first = await platform.setTenantPolicy(tenant.id, {
      mode: 'custom',
      policy,
      companyDataToProvider: false,
      reason: 'pilot',
      expectedVersion: null,
      updatedBy: null,
    });
    expect(first.version).toBe(1);
    await expect(
      platform.setTenantPolicy(tenant.id, {
        mode: 'inherit',
        policy,
        companyDataToProvider: false,
        reason: null,
        expectedVersion: null,
        updatedBy: null,
      }),
    ).rejects.toMatchObject({ currentVersion: 1 });
    const second = await platform.setTenantPolicy(tenant.id, {
      mode: 'inherit',
      policy,
      companyDataToProvider: true,
      reason: null,
      expectedVersion: 1,
      updatedBy: null,
    });
    expect(second).toMatchObject({ mode: 'inherit', version: 2, companyDataToProvider: true });

    const usage = await platform.tenantUsage(tenant.id, PERIODS);
    expect(usage.day.reserved).toBeGreaterThan(0);
    const report = await platform.usageByTenant(PERIODS.month);
    expect(report.some((row) => row.tenantId === tenant.id)).toBe(true);
  });
});
