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
 * Dividing the company's assistant allowance (docs/ai/ADR-0002 D6, D7).
 *
 * Owners and admins hand out shares as percentages that total 100 or less;
 * staff cannot; the platform sees the numbers and alone sets a member's dollar
 * cap; and nothing the company is shown carries a count or a price.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let companyAdmin: Member;
let engineer: Member;
let viewer: Member;

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

const HELP: AiPolicy = {
  ...AI_POLICY_OFF,
  level: 'help',
  quotaMode: 'daily',
  dailyLimit: 100,
  dailyTokenLimit: 5_000_000,
};

interface ShareRow {
  userId: string;
  sharePercent: number | null;
  version: number | null;
  allowance: { remainingPercent: number | null; exhausted: boolean };
}

async function setShare(
  token: string,
  userId: string,
  sharePercent: number | null,
  expectedVersion: number | null,
) {
  return api.call(token, {
    method: 'PUT',
    url: `/v1/ai/shares/${userId}`,
    payload: { sharePercent, expectedVersion },
  });
}

beforeAll(async () => {
  api = await startApi({
    env: { AI_ENABLED: 'true', AI_GLOBAL_MONTHLY_BUDGET_MICROUSD: '1000000000' },
  });
  admin = await api.platformAdmin('ai-shares');
  owner = await api.member('owner', 'shares-owner');
  companyAdmin = await api.member('admin', 'shares-admin');
  engineer = await api.member('engineer', 'shares-engineer');
  viewer = await api.member('viewer', 'shares-viewer');

  const platform = getPlatformDataSource().ai;
  for (const policy of await platform.planPolicies()) {
    await platform.setPlanPolicy(policy.plan, policy.plan === 'trial' ? HELP : AI_POLICY_OFF, {
      expectedVersion: policy.version,
      updatedBy: null,
    });
  }
  forgetAiPolicy();
  await withTenant(api.tenantId, (tx) => tx.settings.update({ aiDesktopEnabled: true }));
});

afterAll(async () => {
  await api.close();
});

describe('an owner dividing the allowance', () => {
  it('sees every member, with percentages and nothing else', async () => {
    const token = await api.signIn(owner);
    const listed = await api.call(token, { method: 'GET', url: '/v1/ai/shares' });
    expect(listed.statusCode, listed.body).toBe(200);
    const body = json<{
      company: { allowance: { remainingPercent: number | null }; assignedPercent: number };
      items: ShareRow[];
    }>(listed);
    expect(body.company).toMatchObject({
      assignedPercent: 0,
      allowance: { remainingPercent: 100 },
    });
    expect(body.items.map((row) => row.userId)).toEqual(
      expect.arrayContaining([owner.userId, engineer.userId, viewer.userId]),
    );
    expect(body.items.every((row) => row.sharePercent === null)).toBe(true);
    expect(listed.body).not.toMatch(/Microusd|"used"|"limit"|5000000/u);
  });

  it('gives shares up to 100% and says how much is left past it', async () => {
    const token = await api.signIn(owner);
    const given = await setShare(token, engineer.userId, 60, null);
    expect(given.statusCode, given.body).toBe(200);
    expect(json<ShareRow>(given)).toMatchObject({
      sharePercent: 60,
      version: 1,
      allowance: { remainingPercent: 100, exhausted: false },
    });

    const tooMuch = await setShare(token, viewer.userId, 50, null);
    expect(tooMuch.statusCode).toBe(422);
    expect(code(tooMuch)).toBe('ai_shares_over_total');
    expect(
      json<{ error: { details: { params: { availablePercent: string } }[] } }>(tooMuch).error
        .details[0]?.params.availablePercent,
    ).toBe('40');

    expect((await setShare(token, viewer.userId, 40, null)).statusCode).toBe(200);

    // A save against an old version is refused with the current one.
    const stale = await setShare(token, engineer.userId, 50, null);
    expect(stale.statusCode).toBe(409);
    expect(code(stale)).toBe('ai_member_limits_changed');

    // The change is in the company's own audit log, with before and after.
    const entries = await withTenant(api.tenantId, (tx) =>
      tx.auditLog.list({ resourceType: 'tenant_user', resourceId: engineer.userId }),
    );
    const entry = entries.find((row) => row.action === 'member.ai_share_changed');
    expect(entry?.actorId).toBe(owner.userId);
    expect(entry?.metadata).toMatchObject({ before: null, after: 60 });
  });

  it('opens the assistant to a member with a share, and closes it when it is taken away', async () => {
    const ownerToken = await api.signIn(owner);
    const viewerToken = await api.signIn(viewer);
    const capabilities = async () =>
      json<{ level: string; blockedBy: string | null; usage: { sharePercent: number | null } }>(
        await api.call(viewerToken, { method: 'GET', url: '/v1/ai/capabilities' }),
      );
    expect(await capabilities()).toMatchObject({
      level: 'help',
      blockedBy: null,
      usage: { sharePercent: 40 },
    });
    const rows = json<{ items: ShareRow[] }>(
      await api.call(ownerToken, { method: 'GET', url: '/v1/ai/shares' }),
    ).items;
    const viewerRow = rows.find((row) => row.userId === viewer.userId);
    expect(
      (await setShare(ownerToken, viewer.userId, null, viewerRow?.version ?? null)).statusCode,
    ).toBe(200);
    expect(await capabilities()).toMatchObject({ level: 'off', blockedBy: 'no_share' });
  });

  it('is not for staff, and not over somebody ranked higher', async () => {
    const engineerToken = await api.signIn(engineer);
    expect(
      (await api.call(engineerToken, { method: 'GET', url: '/v1/ai/shares' })).statusCode,
    ).toBe(403);
    expect((await setShare(engineerToken, engineer.userId, 100, 1)).statusCode).toBe(403);

    const adminToken = await api.signIn(companyAdmin);
    const overOwner = await setShare(adminToken, owner.userId, 10, null);
    expect(overOwner.statusCode).toBe(403);
  });
});

describe('the platform', () => {
  it('sees the numbers behind the percentages, and alone sets a member’s dollar cap', async () => {
    const listed = await api.call(admin.accessToken, {
      method: 'GET',
      url: `/v1/platform/companies/${api.tenantId}/ai/members`,
    });
    expect(listed.statusCode, listed.body).toBe(200);
    const engineerRow = json<{
      items: { userId: string; sharePercent: number | null; version: number | null }[];
    }>(listed).items.find((row) => row.userId === engineer.userId);
    expect(engineerRow).toMatchObject({ sharePercent: 60 });

    const capped = await api.call(admin.accessToken, {
      method: 'PUT',
      url: `/v1/platform/companies/${api.tenantId}/ai/members/${engineer.userId}`,
      payload: {
        monthlyCostCapMicrousd: 1,
        expectedVersion: engineerRow?.version ?? null,
        reason: 'pilot cap',
      },
    });
    expect(capped.statusCode, capped.body).toBe(200);
    // Left out, the share is kept.
    expect(json<{ sharePercent: number; monthlyCostCapMicrousd: number }>(capped)).toMatchObject({
      sharePercent: 60,
      monthlyCostCapMicrousd: 1,
    });

    const audit = json<{ entries: { action: string; targetId: string | null }[] }>(
      await api.call(admin.accessToken, {
        method: 'GET',
        url: '/v1/platform/audit?action=ai.member_limits_changed',
      }),
    );
    expect(audit.entries.some((entry) => entry.targetId === engineer.userId)).toBe(true);

    // The company's own list never shows the cap.
    const ownerList = await api.call(await api.signIn(owner), {
      method: 'GET',
      url: '/v1/ai/shares',
    });
    expect(ownerList.body).not.toMatch(/Microusd|monthlyCostCap/u);
  });

  it('refuses a member past their own dollar cap, without the amount', async () => {
    const token = await api.signIn(engineer);
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
      payload: { message: 'How do I create a work order?', locale: 'en' },
    });
    expect(asked.statusCode).toBe(429);
    expect(code(asked)).toBe('ai_member_budget_exceeded');
    expect(asked.body).not.toMatch(/micro|\$|USD/iu);
  });

  it('reports each company’s tokens with its messages and spend', async () => {
    const report = json<{ items: { tenantId: string; tokensUsed: number }[] }>(
      await api.call(admin.accessToken, { method: 'GET', url: '/v1/platform/ai/usage' }),
    );
    for (const row of report.items) {
      expect(typeof row.tokensUsed).toBe('number');
    }
  });
});
