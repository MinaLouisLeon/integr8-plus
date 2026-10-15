import { randomUUID } from 'node:crypto';
import { AI_POLICY_OFF, type AiPolicy, toUserId } from '@integr8/core';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admitMessage, settleMessage } from '../../ai/admission.js';
import { ApiError } from '../../http/errors.js';
import { forgetAiPolicy } from '../../ai/policy.js';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * The assistant's entitlements over HTTP (docs/ai Phase B; ADR-0001).
 *
 * What the platform sets, a company sees; what a company cannot do is change
 * it. Every plan starts off, a company inherits its plan unless told
 * otherwise, the server's own ceilings cap whatever an admin types, and the
 * admission ledger admits exactly what the policy allows and no more.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let engineer: Member;

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

const HELP_DAILY: AiPolicy = {
  ...AI_POLICY_OFF,
  level: 'help',
  quotaMode: 'daily',
  dailyLimit: 10,
};

beforeAll(async () => {
  api = await startApi({
    env: { AI_ENABLED: 'true', AI_GLOBAL_MONTHLY_BUDGET_MICROUSD: '100000' },
  });
  admin = await api.platformAdmin('ai');
  owner = await api.member('owner', 'ai-owner');
  engineer = await api.member('engineer', 'ai-engineer');
  // Plan policies outlive a test run (nothing truncates them), so start from
  // what a fresh deployment has: every plan off.
  const platform = getPlatformDataSource().ai;
  for (const policy of await platform.planPolicies()) {
    if (policy.level !== 'off') {
      await platform.setPlanPolicy(policy.plan, AI_POLICY_OFF, {
        expectedVersion: policy.version,
        updatedBy: null,
      });
    }
  }
  forgetAiPolicy();
});

afterAll(async () => {
  await api.close();
});

interface PlanPolicyBody {
  plan: string;
  level: string;
  version: number;
  quotaMode: string | null;
  dailyLimit: number | null;
}

async function planPolicies(): Promise<{ items: PlanPolicyBody[]; maxLevelServed: string }> {
  return json(await api.call(admin.accessToken, { method: 'GET', url: '/v1/platform/ai/plans' }));
}

describe('plan policies', () => {
  it('start off for every plan, and say what this build serves', async () => {
    const body = await planPolicies();
    expect(body.items.map((item) => item.plan)).toEqual([
      'enterprise',
      'standard',
      'starter',
      'trial',
    ]);
    expect(body.items.every((item) => item.level === 'off')).toBe(true);
    expect(body.maxLevelServed).toBe('off');
  });

  it('are set whole, version-checked, and refused when inconsistent', async () => {
    const trial = (await planPolicies()).items.find((item) => item.plan === 'trial')!;

    const inconsistent = await api.call(admin.accessToken, {
      method: 'PUT',
      url: '/v1/platform/ai/plans/trial',
      payload: { policy: { ...AI_POLICY_OFF, level: 'help' }, expectedVersion: trial.version },
    });
    expect(inconsistent.statusCode, inconsistent.body).toBe(422);
    expect(code(inconsistent)).toBe('ai_policy_invalid');

    const saved = await api.call(admin.accessToken, {
      method: 'PUT',
      url: '/v1/platform/ai/plans/trial',
      payload: { policy: HELP_DAILY, expectedVersion: trial.version, reason: 'pilot' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(json<PlanPolicyBody>(saved)).toMatchObject({
      level: 'help',
      dailyLimit: 10,
      version: trial.version + 1,
    });

    const stale = await api.call(admin.accessToken, {
      method: 'PUT',
      url: '/v1/platform/ai/plans/trial',
      payload: { policy: HELP_DAILY, expectedVersion: trial.version },
    });
    expect(stale.statusCode).toBe(409);
    expect(code(stale)).toBe('ai_policy_changed');

    // Audited, with before and after.
    const audit = json<{ entries: { action: string; metadata: { after: { level: string } } }[] }>(
      await api.call(admin.accessToken, {
        method: 'GET',
        url: '/v1/platform/audit?action=ai.plan_policy_changed',
      }),
    );
    const entry = audit.entries.find((item) => item.action === 'ai.plan_policy_changed');
    expect(entry?.metadata.after.level).toBe('help');
  });

  it('are refused to a company token', async () => {
    const token = await api.signIn(owner);
    expect(
      (await api.call(token, { method: 'GET', url: '/v1/platform/ai/plans' })).statusCode,
    ).toBe(401);
  });
});

describe('what a company sees', () => {
  it('shows the level this build serves, never one above it, and the usage shape', async () => {
    const token = await api.signIn(owner);
    const capabilities = json<{
      level: string;
      blockedBy: string | null;
      channel: string;
      tools: string[];
      usage: { daily: { limit: number; remaining: number } | null; monthly: unknown; user: object };
    }>(await api.call(token, { method: 'GET', url: '/v1/ai/capabilities' }));
    // The trial plan now says help, but this build serves nothing yet.
    expect(capabilities.level).toBe('off');
    expect(capabilities.blockedBy).toBe('not_served');
    expect(capabilities.channel).toBe('desktop');
    expect(capabilities.tools).toEqual([]);
    expect(capabilities.usage.daily).toMatchObject({ limit: 10, remaining: 10 });
    expect(capabilities.usage.monthly).toBeNull();

    const usage = json<{ user: { daily: { used: number } } }>(
      await api.call(token, { method: 'GET', url: '/v1/ai/usage' }),
    );
    expect(usage.user.daily.used).toBe(0);
  });

  it('never names a provider, a key or a budget to the company', async () => {
    const token = await api.signIn(engineer);
    const body = (await api.call(token, { method: 'GET', url: '/v1/ai/capabilities' })).body;
    expect(body).not.toMatch(/groq|gemini|anthropic|api_key|microusd|budget/iu);
  });
});

describe('a company override', () => {
  it('inherits the plan until told otherwise, then follows its own, then resets', async () => {
    interface CompanyAiBody {
      plan: string;
      override: { mode: string; version: number } | null;
      effective: {
        level: string;
        source: string;
        configuredLevel: string;
        offReason: string | null;
      };
      usage: { day: { used: number; reserved: number }; cost: { spent: number } };
    }

    const before = await (async () => {
      const response = await api.call(admin.accessToken, {
        method: 'GET',
        url: `/v1/platform/companies/${api.tenantId}/ai`,
      });
      expect(response.statusCode, response.body).toBe(200);
      return json<CompanyAiBody>(response);
    })();
    expect(before.override).toBeNull();
    expect(before.effective).toMatchObject({ source: 'plan', configuredLevel: 'help' });

    const custom = await api.call(admin.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/ai`,
      payload: {
        mode: 'custom',
        policy: {
          ...HELP_DAILY,
          level: 'agent',
          quotaMode: 'daily_and_monthly',
          dailyLimit: 50,
          monthlyLimit: 1000,
          perUserDailyLimit: 5,
          maxInputTokens: 999_999,
        },
        companyDataToProvider: true,
        reason: 'pilot company',
        expectedVersion: null,
      },
    });
    expect(custom.statusCode, custom.body).toBe(200);
    const afterCustom = json<CompanyAiBody>(custom);
    expect(afterCustom.override).toMatchObject({ mode: 'custom', version: 1 });
    expect(afterCustom.effective).toMatchObject({
      source: 'custom',
      configuredLevel: 'agent',
      level: 'off',
      offReason: 'not_served',
    });

    // The server's ceiling wins over what the admin typed, and the member's
    // view shows the override's limits, with their own cap beside them.
    const token = await api.signIn(owner);
    const capabilities = json<{
      usage: {
        daily: { limit: number };
        monthly: { limit: number };
        user: { daily: { limit: number } };
      };
      companyDataToProvider: boolean;
    }>(await api.call(token, { method: 'GET', url: '/v1/ai/capabilities' }));
    expect(capabilities.usage.daily.limit).toBe(50);
    expect(capabilities.usage.monthly.limit).toBe(1000);
    expect(capabilities.usage.user.daily.limit).toBe(5);
    expect(capabilities.companyDataToProvider).toBe(true);

    const stale = await api.call(admin.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/ai`,
      payload: {
        mode: 'inherit',
        policy: HELP_DAILY,
        companyDataToProvider: false,
        reason: null,
        expectedVersion: null,
      },
    });
    expect(stale.statusCode).toBe(409);

    const reset = await api.call(admin.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/ai`,
      payload: {
        mode: 'inherit',
        policy: HELP_DAILY,
        companyDataToProvider: false,
        reason: 'back to plan',
        expectedVersion: 1,
      },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect(json<CompanyAiBody>(reset).effective).toMatchObject({
      source: 'plan',
      configuredLevel: 'help',
    });
  });

  it('is refused for a company that does not exist', async () => {
    const response = await api.call(admin.accessToken, {
      method: 'GET',
      url: `/v1/platform/companies/${randomUUID()}/ai`,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('the company’s own switches', () => {
  it('are chosen at onboarding and shown on the company', async () => {
    const name = `ai-${randomUUID().slice(0, 8)}`;
    const onboarded = await api.call(admin.accessToken, {
      method: 'POST',
      url: '/v1/platform/companies',
      payload: {
        slug: name,
        name: 'Assisted Ltd',
        plan: 'trial',
        seats: null,
        ownerEmail: `owner@${name}.example`,
        aiChannels: { web: true, desktop: false, mobile: true },
      },
    });
    expect(onboarded.statusCode, onboarded.body).toBe(201);
    const { company } = json<{ company: { id: string } }>(onboarded);
    const detail = json<{
      settings: { aiWebEnabled: boolean; aiDesktopEnabled: boolean; aiMobileEnabled: boolean };
    }>(
      await api.call(admin.accessToken, {
        method: 'GET',
        url: `/v1/platform/companies/${company.id}`,
      }),
    );
    expect(detail.settings).toMatchObject({
      aiWebEnabled: true,
      aiDesktopEnabled: false,
      aiMobileEnabled: true,
    });

    // And changed later from the dashboard.
    const changed = await api.call(admin.accessToken, {
      method: 'PATCH',
      url: `/v1/platform/companies/${company.id}/settings`,
      payload: { aiDesktopEnabled: true },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(json<{ aiDesktopEnabled: boolean }>(changed).aiDesktopEnabled).toBe(true);
  });

  it('are the owner’s to change in company settings, and not an engineer’s', async () => {
    const ownerToken = await api.signIn(owner);
    const changed = await api.call(ownerToken, {
      method: 'PATCH',
      url: '/v1/settings',
      payload: { aiWebEnabled: true, aiDesktopEnabled: true },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(json<{ aiWebEnabled: boolean; aiMobileEnabled: boolean }>(changed)).toMatchObject({
      aiWebEnabled: true,
      aiMobileEnabled: false,
    });

    const engineerToken = await api.signIn(engineer);
    expect(
      (
        await api.call(engineerToken, {
          method: 'PATCH',
          url: '/v1/settings',
          payload: { aiMobileEnabled: true },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('let an admin switch one member off and on, and nobody switch their superior', async () => {
    const ownerToken = await api.signIn(owner);
    const off = await api.call(ownerToken, {
      method: 'PATCH',
      url: `/v1/members/${engineer.userId}/ai`,
      payload: { aiEnabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(json<{ aiEnabled: boolean }>(off).aiEnabled).toBe(false);

    const members = json<{ items: { userId: string; aiEnabled: boolean }[] }>(
      await api.call(ownerToken, { method: 'GET', url: '/v1/members' }),
    );
    expect(members.items.find((item) => item.userId === engineer.userId)?.aiEnabled).toBe(false);

    const engineerToken = await api.signIn(engineer);
    expect(
      (
        await api.call(engineerToken, {
          method: 'PATCH',
          url: `/v1/members/${owner.userId}/ai`,
          payload: { aiEnabled: false },
        })
      ).statusCode,
    ).toBe(403);

    const on = await api.call(ownerToken, {
      method: 'PATCH',
      url: `/v1/members/${engineer.userId}/ai`,
      payload: { aiEnabled: true },
    });
    expect(json<{ aiEnabled: boolean }>(on).aiEnabled).toBe(true);
  });
});

describe('admission', () => {
  const principalOf = (member: Member) => ({
    userId: toUserId(member.userId),
    tenantId: api.tenantId as never,
    role: member.role,
    grants: [],
    sessionId: randomUUID(),
    tokenId: randomUUID(),
    expiresAt: new Date(Date.now() + 60_000),
  });

  async function conversation(member: Member): Promise<string> {
    return withTenant(api.tenantId, async (tx) => {
      const created = await tx.aiConversations.create({
        userId: member.userId,
        locale: 'en',
        level: 'help',
      });
      return created.id;
    });
  }

  it('admits up to the limit, answers a retry from its reservation, and refuses past it', async () => {
    const month = `${new Date().toISOString().slice(0, 7)}-01`;
    const base = await getPlatformDataSource().ai.globalBudget(month);
    const conversationId = await conversation(engineer);
    const policy: AiPolicy = { ...HELP_DAILY, dailyLimit: 2 };
    const admit = (clientRequestId: string, fingerprint = 'f'.repeat(64)) =>
      admitMessage({
        principal: principalOf(engineer),
        conversationId,
        clientRequestId,
        requestFingerprint: fingerprint,
        policy,
        worstCaseCostMicrousd: 1_000,
        config: api.config,
      });

    const first = await admit('req-1');
    expect(first.outcome).toBe('claimed');
    await expect(admit('req-1')).rejects.toMatchObject({ code: 'ai_request_in_progress' });
    await expect(admit('req-1', 'e'.repeat(64))).rejects.toMatchObject({
      code: 'ai_request_in_progress',
    });

    const second = await admit('req-2');
    expect(second.outcome).toBe('claimed');

    const third = admit('req-3');
    await expect(third).rejects.toBeInstanceOf(ApiError);
    await expect(third).rejects.toMatchObject({ status: 429, code: 'ai_daily_quota_exceeded' });

    // Released slots come back; a stored answer is charged and replayed.
    await settleMessage({
      tenantId: api.tenantId,
      reservationId: second.reservation.id,
      outcome: 'released',
      spentMicrousd: 0,
      errorCode: 'ai_provider_unavailable',
    });
    const answer = await withTenant(api.tenantId, (tx) =>
      tx.aiConversations.appendMessage({
        conversationId,
        userId: null,
        role: 'assistant',
        content: 'Open the work orders screen.',
        usageReservationId: first.reservation.id,
      }),
    );
    await settleMessage({
      tenantId: api.tenantId,
      reservationId: first.reservation.id,
      outcome: 'completed',
      responseMessageId: answer.id,
      spentMicrousd: 400,
    });
    const replay = await admit('req-1');
    expect(replay.outcome).toBe('replay');
    expect(replay.reservation.responseMessageId).toBe(answer.id);

    const fourth = await admit('req-4');
    expect(fourth.outcome).toBe('claimed');

    // The deployment's budget shows the settled figure, not the reservation.
    const global = await getPlatformDataSource().ai.globalBudget(month);
    expect(global.spent - base.spent).toBe(400);
    expect(global.reserved - base.reserved).toBe(1_000);
  });

  it('refuses when the deployment’s own budget is spent, without a figure', async () => {
    const conversationId = await conversation(owner);
    const refused = admitMessage({
      principal: principalOf(owner),
      conversationId,
      clientRequestId: 'budget-1',
      requestFingerprint: 'f'.repeat(64),
      policy: { ...HELP_DAILY, dailyLimit: 100 },
      worstCaseCostMicrousd: 10_000_000,
      config: api.config,
    });
    await expect(refused).rejects.toMatchObject({ status: 503, code: 'ai_budget_unavailable' });
    expect(
      await withTenant(api.tenantId, (tx) => tx.aiUsage.findByRequest(owner.userId, 'budget-1')),
    ).toBeUndefined();
  });
});
