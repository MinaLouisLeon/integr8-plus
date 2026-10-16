import { randomUUID } from 'node:crypto';
import { AI_POLICY_OFF, type AiPolicy } from '@integr8/core';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { periodKeysAt } from '../../ai/periods.js';
import { forgetAiPolicy } from '../../ai/policy.js';
import type { RecordingAiProvider } from '../../ai/providers/index.js';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Answers without a model (docs/ai/ADR-0002 D9–D11).
 *
 * A policy that says `library` is answered from the help library: no provider
 * call, no tokens, no money, no share needed; the company's message limits
 * still hold. The platform sets it per plan or per company, sees where the
 * answers come from, and an older dashboard cannot change it by leaving it out.
 *
 * The deployment's budget here is one micro-dollar, which every model answer
 * would pass: library answers never touch it.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let engineer: Member;
let provider: RecordingAiProvider;

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

const LIBRARY: AiPolicy = {
  ...AI_POLICY_OFF,
  // Above Help on purpose: the library serves Help only.
  level: 'agent',
  answerSource: 'library',
  quotaMode: 'daily',
  dailyLimit: 3,
};

interface Answer {
  message: { text: string; sources: { articleKey: string; label: string }[] };
  allowance: { remainingPercent: number | null; exhausted: boolean };
  replayed: boolean;
}

async function setTrialPlan(policy: AiPolicy) {
  const platform = getPlatformDataSource().ai;
  const current = await platform.planPolicy('trial');
  await platform.setPlanPolicy('trial', policy, {
    expectedVersion: current?.version ?? 1,
    updatedBy: null,
  });
  forgetAiPolicy();
}

async function companyUsage() {
  return getPlatformDataSource().ai.tenantUsage(api.tenantId, periodKeysAt(new Date()));
}

async function startConversation(token: string, locale: 'en' | 'ar' = 'en'): Promise<string> {
  const response = await api.call(token, {
    method: 'POST',
    url: '/v1/ai/conversations',
    headers: { 'idempotency-key': randomUUID() },
    payload: { locale },
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ id: string }>(response).id;
}

async function ask(
  token: string,
  conversationId: string,
  message: string,
  options: { key?: string; locale?: 'en' | 'ar' } = {},
) {
  return api.call(token, {
    method: 'POST',
    url: `/v1/ai/conversations/${conversationId}/messages`,
    headers: { 'idempotency-key': options.key ?? randomUUID() },
    payload: { message, locale: options.locale ?? 'en' },
  });
}

beforeAll(async () => {
  api = await startApi({ env: { AI_ENABLED: 'true', AI_GLOBAL_MONTHLY_BUDGET_MICROUSD: '1' } });
  provider = api.services.ai.provider as RecordingAiProvider;
  admin = await api.platformAdmin('ai-library');
  owner = await api.member('owner', 'library-owner');
  engineer = await api.member('engineer', 'library-engineer');

  const platform = getPlatformDataSource().ai;
  for (const policy of await platform.planPolicies()) {
    await platform.setPlanPolicy(policy.plan, policy.plan === 'trial' ? LIBRARY : AI_POLICY_OFF, {
      expectedVersion: policy.version,
      updatedBy: null,
    });
  }
  forgetAiPolicy();
  await withTenant(api.tenantId, (tx) =>
    tx.settings.update({ aiDesktopEnabled: true, aiWebEnabled: true, aiMobileEnabled: true }),
  );
  provider.reset();
});

afterAll(async () => {
  await api.close();
});

describe('a company answered from the library', () => {
  it('answers a member with no share, at Help, without asking any model or spending anything', async () => {
    const token = await api.signIn(engineer);
    const capabilities = json<{
      level: string;
      blockedBy: string | null;
      answerSource: string;
      tools: string[];
      usage: { sharePercent: number | null };
    }>(await api.call(token, { method: 'GET', url: '/v1/ai/capabilities' }));
    expect(capabilities).toMatchObject({
      level: 'help',
      blockedBy: null,
      answerSource: 'library',
      tools: [],
      usage: { sharePercent: null },
    });

    const before = await companyUsage();
    const conversationId = await startConversation(token);
    const asked = await ask(token, conversationId, 'How do I create a work order?');
    expect(asked.statusCode, asked.body).toBe(200);
    const answer = json<Answer>(asked);
    expect(answer.replayed).toBe(false);
    expect(answer.message.sources.length).toBeGreaterThan(0);
    expect(answer.message.sources.length).toBeLessThanOrEqual(3);
    // The answer is the library's own words: the best article's title first.
    expect(answer.message.text.startsWith(answer.message.sources[0]?.label ?? '!')).toBe(true);
    expect(answer.message.text).not.toMatch(/Right now I can only answer/u);
    expect(provider.calls).toHaveLength(0);

    // One message counted against the company's three a day; nothing else.
    const after = await companyUsage();
    expect(after.day).toEqual({ used: before.day.used + 1, reserved: 0 });
    expect(after.tokens).toEqual(before.tokens);
    expect(after.cost).toEqual(before.cost);
    expect(after.providerCalls).toBe(before.providerCalls);
    // The member sees the company's messages left, as a percentage.
    expect(answer.allowance).toMatchObject({ remainingPercent: 66, exhausted: false });
  });

  it('replays a retried question for nothing, and holds the company to its message limit', async () => {
    const token = await api.signIn(owner);
    const conversationId = await startConversation(token);
    const key = randomUUID();
    const first = await ask(token, conversationId, 'How do I invite people?', { key });
    expect(first.statusCode, first.body).toBe(200);
    const again = await ask(token, conversationId, 'How do I invite people?', { key });
    expect(again.statusCode, again.body).toBe(200);
    expect(again.headers['idempotent-replay'] === 'true' || json<Answer>(again).replayed).toBe(
      true,
    );
    expect((await companyUsage()).day.used).toBe(2);

    expect((await ask(token, conversationId, 'What is a job type?')).statusCode).toBe(200);
    const refused = await ask(token, conversationId, 'And sites?');
    expect(refused.statusCode).toBe(429);
    expect(code(refused)).toBe('ai_daily_quota_exceeded');
  });

  it('answers in Arabic from the Arabic articles, and says so when nothing matches', async () => {
    await setTrialPlan({ ...LIBRARY, dailyLimit: 100 });
    const token = await api.signIn(engineer);
    const arabic = await startConversation(token, 'ar');
    const asked = await ask(token, arabic, 'كيف أنشئ أمر عمل؟', { locale: 'ar' });
    expect(asked.statusCode, asked.body).toBe(200);
    const answer = json<Answer>(asked);
    expect(answer.message.sources.length).toBeGreaterThan(0);
    expect(answer.message.text).toMatch(/[؀-ۿ]/u);

    const english = await startConversation(token);
    const nothing = json<Answer>(await ask(token, english, 'zzqx flurbington'));
    expect(nothing.message.text).toMatch(/could not find anything about that in the help guide/u);
    expect(nothing.message.sources).toEqual([]);
    expect(provider.calls).toHaveLength(0);
  });

  it('shows owners the company’s messages left and says shares decide nothing for now', async () => {
    const token = await api.signIn(owner);
    const shares = json<{
      company: { answerSource: string; allowance: { remainingPercent: number | null } };
      items: { userId: string; allowance: { remainingPercent: number | null } }[];
    }>(await api.call(token, { method: 'GET', url: '/v1/ai/shares' }));
    expect(shares.company.answerSource).toBe('library');
    const engineerRow = shares.items.find((row) => row.userId === engineer.userId);
    expect(engineerRow?.allowance.remainingPercent).toBe(shares.company.allowance.remainingPercent);
  });
});

describe('the platform choosing where answers come from', () => {
  it('lets a library plan be unlimited without a cost cap, but not a model plan', async () => {
    const plans = json<{ items: { plan: string; version: number }[] }>(
      await api.call(admin.accessToken, { method: 'GET', url: '/v1/platform/ai/plans' }),
    );
    const trial = plans.items.find((plan) => plan.plan === 'trial');
    const unlimited = {
      ...AI_POLICY_OFF,
      level: 'help',
      unlimitedMessages: true,
      quotaMode: null,
      monthlyCostCapMicrousd: null,
    };
    const asModel = await api.call(admin.accessToken, {
      method: 'PUT',
      url: '/v1/platform/ai/plans/trial',
      payload: {
        policy: { ...unlimited, answerSource: 'model' },
        expectedVersion: trial?.version,
      },
    });
    expect(asModel.statusCode).toBe(422);
    expect(code(asModel)).toBe('ai_policy_invalid');

    const asLibrary = await api.call(admin.accessToken, {
      method: 'PUT',
      url: '/v1/platform/ai/plans/trial',
      payload: {
        policy: { ...unlimited, answerSource: 'library' },
        expectedVersion: trial?.version,
        reason: 'help guide for everybody',
      },
    });
    expect(asLibrary.statusCode, asLibrary.body).toBe(200);
    expect(json<{ answerSource: string }>(asLibrary).answerSource).toBe('library');
  });

  it('switches one company to model answers, which need a share and a budget', async () => {
    const company = await api.call(admin.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/ai`,
      payload: {
        mode: 'custom',
        policy: {
          ...AI_POLICY_OFF,
          level: 'help',
          answerSource: 'model',
          quotaMode: 'daily',
          dailyLimit: 100,
        },
        companyDataToProvider: false,
        reason: 'pilot of model answers',
        expectedVersion: null,
      },
    });
    expect(company.statusCode, company.body).toBe(200);
    const view = json<{
      override: { answerSource: string; version: number };
      effective: { answersFrom: string; libraryReason: string | null; level: string };
    }>(company);
    expect(view.effective).toMatchObject({ answersFrom: 'model', libraryReason: null });

    const token = await api.signIn(engineer);
    expect(
      json<{ blockedBy: string | null; answerSource: string }>(
        await api.call(token, { method: 'GET', url: '/v1/ai/capabilities' }),
      ),
    ).toMatchObject({ blockedBy: 'no_share', answerSource: 'model' });

    await withTenant(api.tenantId, (tx) =>
      tx.aiMemberLimits.set({
        userId: engineer.userId,
        sharePercent: 50,
        expectedVersion: null,
        updatedBy: null,
      }),
    );
    forgetAiPolicy();
    // With a share, a model answer is admitted against the deployment's
    // budget, which one micro-dollar cannot cover.
    const conversationId = await startConversation(token);
    const refused = await ask(token, conversationId, 'How do I create a work order?');
    expect(refused.statusCode).toBe(503);
    expect(code(refused)).toBe('ai_budget_unavailable');
    expect(provider.calls).toHaveLength(0);

    // Back to the library, by an older dashboard that sends no answer
    // source: it keeps the stored one, so the company stays on model answers.
    const oldShape = { ...AI_POLICY_OFF, level: 'help', quotaMode: 'daily', dailyLimit: 50 };
    delete (oldShape as Partial<AiPolicy>).answerSource;
    const kept = json<{ override: { answerSource: string } }>(
      await api.call(admin.accessToken, {
        method: 'PUT',
        url: `/v1/platform/companies/${api.tenantId}/ai`,
        payload: {
          mode: 'custom',
          policy: oldShape,
          companyDataToProvider: false,
          reason: null,
          expectedVersion: view.override.version,
        },
      }),
    );
    expect(kept.override.answerSource).toBe('model');

    const library = json<{
      effective: { answersFrom: string; libraryReason: string | null; level: string };
    }>(
      await api.call(admin.accessToken, {
        method: 'PUT',
        url: `/v1/platform/companies/${api.tenantId}/ai`,
        payload: {
          mode: 'custom',
          policy: { ...oldShape, answerSource: 'library' },
          companyDataToProvider: false,
          reason: 'back to the guide',
          expectedVersion: view.override.version + 1,
        },
      }),
    );
    expect(library.effective).toMatchObject({
      answersFrom: 'library',
      libraryReason: 'policy',
      level: 'help',
    });
    const answered = await ask(token, conversationId, 'How do I create a work order?');
    expect(answered.statusCode, answered.body).toBe(200);
    expect(provider.calls).toHaveLength(0);
  });
});
