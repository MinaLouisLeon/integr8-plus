import { randomUUID } from 'node:crypto';
import { AI_POLICY_OFF, type AiPolicy } from '@integr8/core';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetAiPolicy } from '../../ai/policy.js';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * A server with no AI provider at all (`AI_PROVIDER=none`; docs/ai/ADR-0002
 * D11, D12): every company is answered from the help library whatever its
 * policy says, nobody needs a share, and the platform is told there is
 * nothing to fix.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let engineer: Member;

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

/** A plan that asks for model answers at the highest level. */
const AGENT_ON_A_MODEL: AiPolicy = {
  ...AI_POLICY_OFF,
  level: 'agent',
  answerSource: 'model',
  quotaMode: 'daily',
  dailyLimit: 20,
};

beforeAll(async () => {
  api = await startApi({
    env: { AI_ENABLED: 'true', AI_PROVIDER: 'none', APP_ENV: 'test' },
  });
  admin = await api.platformAdmin('ai-none');
  engineer = await api.member('engineer', 'none-engineer');
  const platform = getPlatformDataSource().ai;
  for (const policy of await platform.planPolicies()) {
    await platform.setPlanPolicy(
      policy.plan,
      policy.plan === 'trial' ? AGENT_ON_A_MODEL : AI_POLICY_OFF,
      { expectedVersion: policy.version, updatedBy: null },
    );
  }
  forgetAiPolicy();
  await withTenant(api.tenantId, (tx) => tx.settings.update({ aiDesktopEnabled: true }));
});

afterAll(async () => {
  await api.close();
});

describe('no AI provider', () => {
  it('tells the platform there is no provider by choice, with nothing to fix', async () => {
    const providers = json<{
      active: string;
      ready: boolean;
      libraryOnly: boolean;
      problems: string[];
      servedLevels: string[];
      providers: { id: string }[];
    }>(await api.call(admin.accessToken, { method: 'GET', url: '/v1/platform/ai/providers' }));
    expect(providers).toMatchObject({
      active: 'none',
      ready: false,
      libraryOnly: true,
      problems: [],
      servedLevels: [],
    });
    expect(providers.providers.map((entry) => entry.id)).not.toContain('none');

    const company = json<{
      effective: {
        level: string;
        configuredLevel: string;
        answersFrom: string;
        libraryReason: string | null;
        offReason: string | null;
      };
    }>(
      await api.call(admin.accessToken, {
        method: 'GET',
        url: `/v1/platform/companies/${api.tenantId}/ai`,
      }),
    );
    expect(company.effective).toMatchObject({
      level: 'help',
      configuredLevel: 'agent',
      answersFrom: 'library',
      libraryReason: 'no_provider',
      offReason: null,
    });
  });

  it('answers a company on a model plan from the library, with no share', async () => {
    const token = await api.signIn(engineer);
    expect(
      json<{ level: string; blockedBy: string | null; answerSource: string }>(
        await api.call(token, { method: 'GET', url: '/v1/ai/capabilities' }),
      ),
    ).toMatchObject({ level: 'help', blockedBy: null, answerSource: 'library' });

    const conversation = await api.call(token, {
      method: 'POST',
      url: '/v1/ai/conversations',
      headers: { 'idempotency-key': randomUUID() },
      payload: { locale: 'en' },
    });
    expect(conversation.statusCode, conversation.body).toBe(201);
    const asked = await api.call(token, {
      method: 'POST',
      url: `/v1/ai/conversations/${json<{ id: string }>(conversation).id}/messages`,
      headers: { 'idempotency-key': randomUUID() },
      payload: { message: 'How do I add a customer and a site?', locale: 'en' },
    });
    expect(asked.statusCode, asked.body).toBe(200);
    const answer = json<{ message: { text: string; sources: unknown[] } }>(asked);
    expect(answer.message.sources.length).toBeGreaterThan(0);
    // Not a temporary state: no "for now" line on every answer.
    expect(answer.message.text).not.toMatch(/Right now I can only answer/u);
  });
});
