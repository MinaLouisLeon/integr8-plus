import { randomUUID } from 'node:crypto';
import { AI_POLICY_OFF, type AiPolicy } from '@integr8/core';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetAiPolicy } from '../../ai/policy.js';
import type { RecordingAiProvider } from '../../ai/providers/index.js';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Level 1 over HTTP (docs/ai Phase C; ADR-0001): a member asks, the help
 * library is searched in their language, the fake model answers citing what
 * it was shown, the answer is stored and charged once, and every switch
 * between the plan and the screen can close the door.
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

const HELP: AiPolicy = {
  ...AI_POLICY_OFF,
  level: 'help',
  quotaMode: 'daily_and_monthly',
  dailyLimit: 40,
  monthlyLimit: 100,
  perUserDailyLimit: 6,
};

interface Capabilities {
  level: string;
  blockedBy: string | null;
  usage: { daily: { used: number; reserved: number; remaining: number } | null };
}

async function capabilities(token: string, app: 'web' | 'desktop' | 'mobile' = 'desktop') {
  return json<Capabilities>(
    await api.call(token, {
      method: 'GET',
      url: '/v1/ai/capabilities',
      headers: { 'x-client-app': app },
    }),
  );
}

async function ask(
  token: string,
  conversationId: string,
  message: string,
  options: { key?: string; locale?: 'en' | 'ar'; app?: 'web' | 'desktop' | 'mobile' } = {},
) {
  return api.call(token, {
    method: 'POST',
    url: `/v1/ai/conversations/${conversationId}/messages`,
    headers: {
      'idempotency-key': options.key ?? randomUUID(),
      'x-client-app': options.app ?? 'desktop',
    },
    payload: { message, locale: options.locale ?? 'en' },
  });
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

beforeAll(async () => {
  api = await startApi({
    env: { AI_ENABLED: 'true', AI_GLOBAL_MONTHLY_BUDGET_MICROUSD: '5000000' },
  });
  provider = api.services.ai.provider as RecordingAiProvider;
  admin = await api.platformAdmin('ai-chat');
  owner = await api.member('owner', 'chat-owner');
  engineer = await api.member('engineer', 'chat-engineer');

  const platform = getPlatformDataSource().ai;
  for (const policy of await platform.planPolicies()) {
    await platform.setPlanPolicy(policy.plan, policy.plan === 'trial' ? HELP : AI_POLICY_OFF, {
      expectedVersion: policy.version,
      updatedBy: null,
    });
  }
  forgetAiPolicy();
  // The company's own switches: desktop on, the rest off.
  await withTenant(api.tenantId, (tx) =>
    tx.settings.update({ aiDesktopEnabled: true, aiWebEnabled: false, aiMobileEnabled: false }),
  );
});

afterAll(async () => {
  await api.close();
});

describe('the switches between the plan and the screen', () => {
  it('serve help on the desktop, and say which switch is off elsewhere', async () => {
    const token = await api.signIn(owner);
    expect(await capabilities(token, 'desktop')).toMatchObject({ level: 'help', blockedBy: null });
    expect(await capabilities(token, 'web')).toMatchObject({
      level: 'off',
      blockedBy: 'channel_off',
    });
    expect(await capabilities(token, 'mobile')).toMatchObject({
      level: 'off',
      blockedBy: 'channel_off',
    });

    const conversation = await api.call(token, {
      method: 'POST',
      url: '/v1/ai/conversations',
      headers: { 'idempotency-key': randomUUID(), 'x-client-app': 'web' },
      payload: { locale: 'en' },
    });
    expect(conversation.statusCode).toBe(403);
    expect(code(conversation)).toBe('ai_disabled');
  });

  it('closes for one member when an admin switches them off, and opens again', async () => {
    const ownerToken = await api.signIn(owner);
    const engineerToken = await api.signIn(engineer);
    await api.call(ownerToken, {
      method: 'PATCH',
      url: `/v1/members/${engineer.userId}/ai`,
      payload: { aiEnabled: false },
    });
    expect(await capabilities(engineerToken)).toMatchObject({
      level: 'off',
      blockedBy: 'member_off',
    });
    await api.call(ownerToken, {
      method: 'PATCH',
      url: `/v1/members/${engineer.userId}/ai`,
      payload: { aiEnabled: true },
    });
    expect(await capabilities(engineerToken)).toMatchObject({ level: 'help', blockedBy: null });
  });

  it('closes everywhere when the company override says off, whatever the plan says', async () => {
    const token = await api.signIn(owner);
    const off = await api.call(admin.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/ai`,
      payload: {
        mode: 'custom',
        policy: AI_POLICY_OFF,
        companyDataToProvider: false,
        reason: 'test',
        expectedVersion: null,
      },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(await capabilities(token)).toMatchObject({ level: 'off', blockedBy: 'custom_off' });

    const back = await api.call(admin.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/ai`,
      payload: {
        mode: 'inherit',
        policy: AI_POLICY_OFF,
        companyDataToProvider: false,
        reason: null,
        expectedVersion: 1,
      },
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(await capabilities(token)).toMatchObject({ level: 'help', blockedBy: null });
  });
});

describe('asking', () => {
  it('answers from the help library, cites it, stores both turns and charges one message', async () => {
    const token = await api.signIn(engineer);
    const conversationId = await startConversation(token);
    const before = await capabilities(token);
    const usedBefore = before.usage.daily?.used ?? 0;
    provider.reset();

    const key = randomUUID();
    const asked = await ask(token, conversationId, 'How do I create a work order?', { key });
    expect(asked.statusCode, asked.body).toBe(200);
    const answer = json<{
      message: { text: string; sources: { articleKey: string; label: string }[] };
      usage: { daily: { used: number; reserved: number }; user: { daily: { used: number } } };
      replayed: boolean;
    }>(asked);
    expect(answer.replayed).toBe(false);
    expect(answer.message.sources.length).toBeGreaterThan(0);
    expect(answer.message.text).toContain(answer.message.sources[0]?.label ?? '!');
    expect(answer.message.text).not.toContain('[cite:');
    expect(answer.usage.daily).toMatchObject({ used: usedBefore + 1, reserved: 0 });
    expect(answer.usage.user.daily.used).toBeGreaterThanOrEqual(1);

    // The model was shown the help as reference data, never a secret.
    const shown = provider.calls[0]?.input;
    expect(shown?.system).toContain('REFERENCE ARTICLES');
    expect(shown?.system).toContain(`[ref:${answer.message.sources[0]?.articleKey ?? ''}|`);
    expect(JSON.stringify(shown)).not.toMatch(/Bearer |AI_GROQ_API_KEY|x-api-key/u);

    // The same key replays the stored answer and charges nothing more.
    // Either the request layer answers from its record, or the admission
    // layer answers from the reservation: both say so, neither charges.
    const again = await ask(token, conversationId, 'How do I create a work order?', { key });
    expect(again.statusCode, again.body).toBe(200);
    const replayed = json<{ replayed: boolean; usage: { daily: { used: number } } }>(again);
    expect(again.headers['idempotent-replay'] === 'true' || replayed.replayed).toBe(true);
    expect(replayed.usage.daily.used).toBe(usedBefore + 1);
    expect(provider.calls).toHaveLength(1);
    expect((await capabilities(token)).usage.daily?.used).toBe(usedBefore + 1);

    const transcript = json<{ messages: { role: string; text: string }[] }>(
      await api.call(token, { method: 'GET', url: `/v1/ai/conversations/${conversationId}` }),
    );
    expect(transcript.messages.map((message) => message.role)).toEqual(['user', 'assistant']);

    // Provider calls were recorded against the reservation, costed and settled.
    const usage = await getPlatformDataSource().ai.tenantUsage(api.tenantId, {
      day: new Date().toISOString().slice(0, 10),
      month: `${new Date().toISOString().slice(0, 7)}-01`,
    });
    expect(usage.providerCalls).toBeGreaterThanOrEqual(1);
    expect(usage.cost.spent).toBeGreaterThan(0);
    expect(usage.cost.reserved).toBe(0);
  });

  it('answers in Arabic from the Arabic articles', async () => {
    const token = await api.signIn(engineer);
    const conversationId = await startConversation(token, 'ar');
    provider.reset();
    const asked = await ask(token, conversationId, 'كيف أنشئ أمر عمل جديد؟', { locale: 'ar' });
    expect(asked.statusCode, asked.body).toBe(200);
    const answer = json<{ message: { text: string; sources: { articleKey: string }[] } }>(asked);
    expect(answer.message.sources.length).toBeGreaterThan(0);
    expect(answer.message.text).toMatch(/[؀-ۿ]/u);
    expect(provider.calls[0]?.input.system).toContain('Answer in Arabic');
  });

  it('says it does not know rather than inventing, when nothing matches', async () => {
    const token = await api.signIn(engineer);
    const conversationId = await startConversation(token);
    const asked = await ask(token, conversationId, 'zzqx plorbit flanges?');
    expect(asked.statusCode, asked.body).toBe(200);
    const answer = json<{ message: { text: string; sources: unknown[] } }>(asked);
    expect(answer.message.sources).toEqual([]);
    expect(answer.message.text).toMatch(/not have enough information/u);
  });

  it('refuses past the member’s own daily limit, with the reset time', async () => {
    const token = await api.signIn(owner);
    const conversationId = await startConversation(token);
    // The owner has asked nothing yet today; the policy's per-member cap is theirs.
    for (let index = 0; index < (HELP.perUserDailyLimit ?? 0); index += 1) {
      const response = await ask(token, conversationId, `question ${String(index)}`);
      expect(response.statusCode, response.body).toBe(200);
    }
    const fourth = await ask(token, conversationId, 'one more');
    expect(fourth.statusCode).toBe(429);
    expect(code(fourth)).toBe('ai_daily_quota_exceeded');
    expect(fourth.headers['retry-after']).toBeDefined();
    const body = json<{ error: { details: { params: { resetsAt: string } }[] } }>(fourth);
    expect(body.error.details[0]?.params.resetsAt).toMatch(/T00:00:00\.000Z$/u);
  });

  it('needs an Idempotency-Key, a real conversation of one’s own, and a bounded message', async () => {
    const token = await api.signIn(engineer);
    const other = await api.signIn(owner);
    const conversationId = await startConversation(token);

    const noKey = await api.call(token, {
      method: 'POST',
      url: `/v1/ai/conversations/${conversationId}/messages`,
      payload: { message: 'hello' },
    });
    expect(noKey.statusCode).toBe(400);

    const someoneElses = await ask(other, conversationId, 'hello');
    expect(someoneElses.statusCode).toBe(404);
    expect(code(someoneElses)).toBe('ai_conversation_not_found');
    expect(
      (await api.call(other, { method: 'GET', url: `/v1/ai/conversations/${conversationId}` }))
        .statusCode,
    ).toBe(404);

    const tooLong = await ask(token, conversationId, 'x'.repeat(4001));
    expect(tooLong.statusCode).toBe(422);
  });

  it('gives the slot back when the model fails, and the member can ask again', async () => {
    const token = await api.signIn(engineer);
    const conversationId = await startConversation(token);
    const before = (await capabilities(token)).usage.daily;
    provider.enqueue({ text: '' });
    // A thrown provider error: simulate by a queued generation the orchestrator
    // cannot use is not a failure, so drive a real one through the fake's
    // generate by replacing it for one call.
    const original = provider.generate.bind(provider);
    provider.generate = () =>
      Promise.reject(
        new (class extends Error {
          kind = 'unavailable';
          provider = 'recording';
          retryAfterSeconds = 7;
        })('down'),
      );
    const failed = await ask(token, conversationId, 'anything');
    provider.generate = original;
    provider.reset();
    expect(failed.statusCode).toBe(503);
    expect(code(failed)).toBe('ai_provider_unavailable');

    const after = (await capabilities(token)).usage.daily;
    expect(after?.used).toBe(before?.used);
    expect(after?.reserved).toBe(0);

    const retried = await ask(token, conversationId, 'anything');
    expect(retried.statusCode, retried.body).toBe(200);
  });

  it('lets a member delete their own conversation, and nobody else', async () => {
    const token = await api.signIn(engineer);
    const other = await api.signIn(owner);
    const conversationId = await startConversation(token);
    expect(
      (
        await api.call(other, {
          method: 'DELETE',
          url: `/v1/ai/conversations/${conversationId}`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await api.call(token, {
          method: 'DELETE',
          url: `/v1/ai/conversations/${conversationId}`,
        })
      ).statusCode,
    ).toBe(204);
    const listed = json<{ items: { id: string }[] }>(
      await api.call(token, { method: 'GET', url: '/v1/ai/conversations' }),
    );
    expect(listed.items.some((item) => item.id === conversationId)).toBe(false);
  });
});
