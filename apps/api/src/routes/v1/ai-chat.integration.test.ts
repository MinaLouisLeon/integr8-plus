import { randomUUID } from 'node:crypto';
import { AI_POLICY_OFF, type AiPolicy } from '@integr8/core';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { periodKeysAt } from '../../ai/periods.js';
import { forgetAiPolicy } from '../../ai/policy.js';
import { AiProviderError, type RecordingAiProvider } from '../../ai/providers/index.js';
import { clearProviderPauses } from '../../ai/providers/pause.js';
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
  // Kept for an old-shape policy; members' shares decide now (ADR-0002 D6).
  perUserDailyLimit: 6,
  dailyTokenLimit: 2_000_000,
  monthlyTokenLimit: 20_000_000,
};

/** The owner's share: 10% of 40 messages a day is 4 (ADR-0002 D6). */
const OWNER_SHARE = 10;
const OWNER_DAILY = Math.floor((40 * OWNER_SHARE) / 100);

interface Capabilities {
  level: string;
  blockedBy: string | null;
  channel: string;
  usage: {
    allowance: { remainingPercent: number | null; resetsAt: string | null; exhausted: boolean };
    sharePercent: number | null;
  };
}

/** The company's own counters, as the platform sees them. */
async function companyUsage() {
  return getPlatformDataSource().ai.tenantUsage(api.tenantId, periodKeysAt(new Date()));
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
  // Each member's share of the company's allowance (ADR-0002 D6).
  await withTenant(api.tenantId, async (tx) => {
    await tx.aiMemberLimits.set({
      userId: owner.userId,
      sharePercent: OWNER_SHARE,
      expectedVersion: null,
      updatedBy: null,
    });
    await tx.aiMemberLimits.set({
      userId: engineer.userId,
      sharePercent: 80,
      expectedVersion: null,
      updatedBy: null,
    });
  });
});

afterAll(async () => {
  await api.close();
});

describe('the switches between the plan and the screen', () => {
  it('serve help on the desktop, and say which switch is off elsewhere', async () => {
    const token = await api.signIn(owner, 'desktop');
    expect(await capabilities(token, 'desktop')).toMatchObject({ level: 'help', blockedBy: null });
    for (const app of ['web', 'mobile'] as const) {
      const elsewhere = await api.signIn(owner, app);
      expect(await capabilities(elsewhere, app)).toMatchObject({
        level: 'off',
        blockedBy: 'channel_off',
      });
    }

    const web = await api.signIn(owner, 'web');
    const conversation = await api.call(web, {
      method: 'POST',
      url: '/v1/ai/conversations',
      headers: { 'idempotency-key': randomUUID(), 'x-client-app': 'web' },
      payload: { locale: 'en' },
    });
    expect(conversation.statusCode).toBe(403);
    expect(code(conversation)).toBe('ai_disabled');
  });

  it('follow the app the session signed in with, not the header (Low 11)', async () => {
    // A phone session cannot open the desktop's door by saying it is one.
    const phone = await api.signIn(owner, 'mobile');
    expect(await capabilities(phone, 'desktop')).toMatchObject({
      level: 'off',
      blockedBy: 'channel_off',
      channel: 'mobile',
    });
    const asked = await ask(phone, randomUUID(), 'How do I add a site?', { app: 'desktop' });
    expect(asked.statusCode).toBe(403);

    // And a desktop session is not shut out by a header naming the web.
    const desktop = await api.signIn(owner, 'desktop');
    expect(await capabilities(desktop, 'web')).toMatchObject({
      level: 'help',
      blockedBy: null,
      channel: 'desktop',
    });
  });

  it('hold Integr8 staff acting as the company to the web switch', async () => {
    // Staff work in the company's web workspace, whatever app they used to
    // sign in to the dashboard; the web switch is off here.
    const staff = await api.staff(owner);
    expect(await capabilities(staff, 'desktop')).toMatchObject({
      level: 'off',
      blockedBy: 'channel_off',
      channel: 'web',
    });
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
    const before = await companyUsage();
    const usedBefore = before.day.used;
    provider.reset();

    const key = randomUUID();
    const asked = await ask(token, conversationId, 'How do I create a work order?', { key });
    expect(asked.statusCode, asked.body).toBe(200);
    const answer = json<{
      message: { text: string; sources: { articleKey: string; label: string }[] };
      allowance: { remainingPercent: number | null; exhausted: boolean };
      replayed: boolean;
    }>(asked);
    expect(answer.replayed).toBe(false);
    expect(answer.message.sources.length).toBeGreaterThan(0);
    expect(answer.message.text).toContain(answer.message.sources[0]?.label ?? '!');
    expect(answer.message.text).not.toContain('[cite:');
    // One message charged; the call's tokens held, then settled to what it used.
    const after = await companyUsage();
    expect(after.day).toEqual({ used: usedBefore + 1, reserved: 0 });
    expect(after.tokens.day.used).toBeGreaterThan(before.tokens.day.used);
    expect(after.tokens.day.reserved).toBe(0);
    // The member is told a percentage, never a count (ADR-0002 D7).
    expect(answer.allowance.exhausted).toBe(false);
    expect(answer.allowance.remainingPercent).toBeGreaterThan(0);
    expect(asked.body).not.toMatch(/"used"|"limit"/u);

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
    const replayed = json<{ replayed: boolean }>(again);
    expect(again.headers['idempotent-replay'] === 'true' || replayed.replayed).toBe(true);
    expect(provider.calls).toHaveLength(1);
    const afterReplay = await companyUsage();
    expect(afterReplay.day.used).toBe(usedBefore + 1);
    expect(afterReplay.tokens.day.used).toBe(after.tokens.day.used);

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
    // The owner has asked nothing yet today; their share is their cap.
    for (let index = 0; index < OWNER_DAILY; index += 1) {
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
    const before = await companyUsage();
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

    // Nothing charged and nothing held: the slot and the call's tokens came back.
    const after = await companyUsage();
    expect(after.day).toEqual(before.day);
    expect(after.tokens.day).toEqual(before.tokens.day);

    const retried = await ask(token, conversationId, 'anything');
    expect(retried.statusCode, retried.body).toBe(200);
  });

  it('closes for a member with no share, and says why (ADR-0002 D6)', async () => {
    const newcomer = await api.member('dispatcher', 'chat-no-share');
    const token = await api.signIn(newcomer);
    expect(await capabilities(token)).toMatchObject({ level: 'off', blockedBy: 'no_share' });
    const refused = await api.call(token, {
      method: 'POST',
      url: '/v1/ai/conversations',
      headers: { 'idempotency-key': randomUUID(), 'x-client-app': 'desktop' },
      payload: { locale: 'en' },
    });
    expect(refused.statusCode).toBe(403);
    expect(code(refused)).toBe('ai_disabled');
  });

  it('refuses before asking the model when the call would not fit the token allowance', async () => {
    const platform = getPlatformDataSource().ai;
    const current = await platform.tenantPolicy(api.tenantId);
    await platform.setTenantPolicy(api.tenantId, {
      mode: 'custom',
      // 80% of 500 tokens is far below one call's hold.
      policy: { ...HELP, dailyTokenLimit: 500 },
      companyDataToProvider: false,
      reason: 'tiny token allowance',
      expectedVersion: current?.version ?? null,
      updatedBy: null,
    });
    forgetAiPolicy();
    try {
      const token = await api.signIn(engineer);
      const conversationId = await startConversation(token);
      const before = await companyUsage();
      provider.reset();
      const refused = await ask(token, conversationId, 'How do I create a work order?');
      expect(refused.statusCode).toBe(429);
      expect(code(refused)).toBe('ai_daily_token_quota_exceeded');
      expect(refused.headers['retry-after']).toBeDefined();
      // The message, not the whole body: the body's random request id can
      // contain "500".
      const message = (JSON.parse(refused.body) as { error: { message: string } }).error.message;
      expect(message).not.toMatch(/500|tokens? left/u);
      // No model was asked, no message charged, nothing left held.
      expect(provider.calls).toHaveLength(0);
      const after = await companyUsage();
      expect(after.day).toEqual(before.day);
      expect(after.tokens.day).toEqual(before.tokens.day);
    } finally {
      const now = await platform.tenantPolicy(api.tenantId);
      await platform.setTenantPolicy(api.tenantId, {
        mode: 'inherit',
        policy: HELP,
        companyDataToProvider: false,
        reason: null,
        expectedVersion: now?.version ?? null,
        updatedBy: null,
      });
      forgetAiPolicy();
    }
  });

  it('pauses the provider when its credit is spent, charges nobody, and answers from the library meanwhile (ADR-0002 D8, D11)', async () => {
    const token = await api.signIn(engineer);
    const conversationId = await startConversation(token);
    const before = await companyUsage();
    const original = provider.generate.bind(provider);
    let asked = 0;
    provider.generate = () => {
      asked += 1;
      return Promise.reject(
        new AiProviderError('recording', 'credit_exhausted', 'credit spent', undefined, 429),
      );
    };
    try {
      const failed = await ask(token, conversationId, 'How do I create a work order?');
      expect(failed.statusCode).toBe(503);
      // The company is told the assistant is unavailable, not that it ran out.
      expect(code(failed)).toBe('ai_provider_unavailable');
      expect(failed.body).not.toMatch(/credit|quota|billing/iu);

      // Paused: the next question does not reach the provider at all. The
      // help library answers it instead, saying only the guide can answer
      // for now; it counts as a message, but uses no tokens and no money.
      const paused = await ask(token, conversationId, 'How do I create a work order?');
      expect(paused.statusCode, paused.body).toBe(200);
      const fromLibrary = json<{ message: { text: string; sources: unknown[] } }>(paused);
      expect(fromLibrary.message.text).toMatch(/^Right now I can only answer from the help guide/u);
      expect(fromLibrary.message.sources.length).toBeGreaterThan(0);
      expect(asked).toBe(1);

      const after = await companyUsage();
      expect(after.day).toEqual({ used: before.day.used + 1, reserved: before.day.reserved });
      expect(after.tokens.day).toEqual(before.tokens.day);
      expect(after.cost.spent).toBe(before.cost.spent);

      const health = json<{ window: { creditExhausted: number } }>(
        await api.call(admin.accessToken, { method: 'GET', url: '/v1/platform/ai/health' }),
      );
      expect(health.window.creditExhausted).toBeGreaterThanOrEqual(1);
      const providers = json<{ creditPauseSeconds: number | null }>(
        await api.call(admin.accessToken, { method: 'GET', url: '/v1/platform/ai/providers' }),
      );
      expect(providers.creditPauseSeconds).toBeGreaterThan(0);
    } finally {
      provider.generate = original;
      provider.reset();
      clearProviderPauses();
    }
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
