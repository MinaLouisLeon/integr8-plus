import { randomUUID } from 'node:crypto';
import { AI_POLICY_OFF, type AiPolicy } from '@integr8/core';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { periodKeysAt } from '../../ai/periods.js';
import { forgetAiPolicy } from '../../ai/policy.js';
import type { RecordingAiProvider } from '../../ai/providers/index.js';
import { type ApiHarness, type Member, startApi } from '../../testing/api-harness.js';

/**
 * Levels 2 and 3 over HTTP (docs/ai Phases D and E; ADR-0001 D4, D5).
 *
 * The fake model is driven by name (`/tool …`), so what is tested is
 * everything around it: which tools a seat is offered, that a tool answers
 * only what the seat may see, that a prepared action waits for the member's
 * own confirmation, runs once through the domain code, and is refused when
 * anything between proposal and confirmation changed.
 */

let api: ApiHarness;
let owner: Member;
let engineer: Member;
let viewer: Member;
let provider: RecordingAiProvider;
let jobTypeId: string;

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

const AGENT: AiPolicy = {
  ...AI_POLICY_OFF,
  level: 'agent',
  quotaMode: 'monthly',
  monthlyLimit: 1000,
  maxToolSteps: 3,
  maxProviderCalls: 3,
};

interface Proposal {
  id: string;
  state: string;
  preview: { title: string; fields: { label: string; value: string }[]; warnings: string[] };
  result: { resourceType: string; resourceId: string; summary: string; appRoute: string } | null;
}

async function conversation(token: string): Promise<string> {
  const response = await api.call(token, {
    method: 'POST',
    url: '/v1/ai/conversations',
    headers: { 'idempotency-key': randomUUID() },
    payload: { locale: 'en' },
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ id: string }>(response).id;
}

async function ask(token: string, conversationId: string, message: string) {
  return api.call(token, {
    method: 'POST',
    url: `/v1/ai/conversations/${conversationId}/messages`,
    headers: { 'idempotency-key': randomUUID() },
    payload: { message, locale: 'en' },
  });
}

async function confirm(token: string, proposalId: string, key = randomUUID()) {
  return api.call(token, {
    method: 'POST',
    url: `/v1/ai/actions/${proposalId}/confirm`,
    headers: { 'idempotency-key': key },
  });
}

beforeAll(async () => {
  api = await startApi({
    env: { AI_ENABLED: 'true', AI_GLOBAL_MONTHLY_BUDGET_MICROUSD: '5000000' },
  });
  provider = api.services.ai.provider as RecordingAiProvider;
  owner = await api.member('owner', 'act-owner');
  engineer = await api.member('engineer', 'act-engineer');
  viewer = await api.member('viewer', 'act-viewer');

  const platform = getPlatformDataSource().ai;
  for (const policy of await platform.planPolicies()) {
    await platform.setPlanPolicy(policy.plan, policy.plan === 'trial' ? AGENT : AI_POLICY_OFF, {
      expectedVersion: policy.version,
      updatedBy: null,
    });
  }
  await platform.setTenantPolicy(api.tenantId, {
    mode: 'inherit',
    policy: AGENT,
    companyDataToProvider: true,
    reason: 'test',
    expectedVersion: null,
    updatedBy: null,
  });
  forgetAiPolicy();
  await withTenant(api.tenantId, async (tx) => {
    await tx.settings.update({ aiDesktopEnabled: true });
    // Each seat's share of the company's allowance (ADR-0002 D6); 1% is left
    // for the member whose allowance runs out mid-answer, below.
    for (const [member, sharePercent] of [
      [owner, 40],
      [engineer, 30],
      [viewer, 29],
    ] as const) {
      await tx.aiMemberLimits.set({
        userId: member.userId,
        sharePercent,
        expectedVersion: null,
        updatedBy: null,
      });
    }
  });
  // Job types are Integr8's to manage: staff define the one the tests name.
  const type = await api.call(await api.staff(owner), {
    method: 'POST',
    url: '/v1/job-types',
    payload: { name: 'Repair', code: 'repair' },
  });
  expect(type.statusCode, type.body).toBe(201);
  jobTypeId = json<{ id: string }>(type).id;
});

afterAll(async () => {
  await api.close();
});

describe('the model each level runs on (ADR-0002 D3)', () => {
  it('is the level’s own model on every call, never the Help model for all', async () => {
    const token = await api.signIn(owner);
    const platform = getPlatformDataSource().ai;
    const modelsAt = async (level: 'help' | 'insights' | 'agent') => {
      const current = (await platform.tenantPolicy(api.tenantId))!;
      await platform.setTenantPolicy(api.tenantId, {
        mode: 'custom',
        policy: { ...AGENT, level },
        companyDataToProvider: true,
        reason: `model for ${level}`,
        expectedVersion: current.version,
        updatedBy: null,
      });
      forgetAiPolicy();
      const conversationId = await conversation(token);
      provider.reset();
      // A tool round at the higher levels, so more than one call is checked.
      const asked = await ask(
        token,
        conversationId,
        level === 'help' ? 'How do I create a work order?' : '/tool get_work_order_summary {}',
      );
      expect(asked.statusCode, asked.body).toBe(200);
      return [...new Set(provider.calls.map((call) => call.input.model))];
    };

    expect(await modelsAt('help')).toEqual(['recording-help']);
    expect(await modelsAt('insights')).toEqual(['recording-insights']);
    expect(await modelsAt('agent')).toEqual(['recording-agent']);

    const current = (await platform.tenantPolicy(api.tenantId))!;
    await platform.setTenantPolicy(api.tenantId, {
      mode: 'inherit',
      policy: AGENT,
      companyDataToProvider: true,
      reason: null,
      expectedVersion: current.version,
      updatedBy: null,
    });
    forgetAiPolicy();
  });

  it('is told what its level can do, and nothing it cannot', async () => {
    const token = await api.signIn(owner);
    const platform = getPlatformDataSource().ai;
    const promptAt = async (level: 'help' | 'insights' | 'agent') => {
      const current = (await platform.tenantPolicy(api.tenantId))!;
      await platform.setTenantPolicy(api.tenantId, {
        mode: 'custom',
        policy: { ...AGENT, level },
        companyDataToProvider: true,
        reason: `prompt for ${level}`,
        expectedVersion: current.version,
        updatedBy: null,
      });
      forgetAiPolicy();
      provider.reset();
      const asked = await ask(token, await conversation(token), 'How do I create a work order?');
      expect(asked.statusCode, asked.body).toBe(200);
      return provider.calls[0]?.input.system ?? '';
    };

    // ADR-0001, 2026-10-31 addendum: the help prompt said "you cannot read
    // company data" to calls that carried the tools that read it.
    const help = await promptAt('help');
    expect(help).toContain('You cannot read or change any company data');
    const insights = await promptAt('insights');
    expect(insights).not.toContain('cannot read');
    expect(insights).toContain('call a tool and answer from its result');
    expect(insights).toContain('You cannot change any company data.');
    const agent = await promptAt('agent');
    expect(agent).toContain('the change happens only if they confirm it there');
    expect(agent).not.toContain('You cannot change any company data.');

    const current = (await platform.tenantPolicy(api.tenantId))!;
    await platform.setTenantPolicy(api.tenantId, {
      mode: 'inherit',
      policy: AGENT,
      companyDataToProvider: true,
      reason: null,
      expectedVersion: current.version,
      updatedBy: null,
    });
    forgetAiPolicy();
  });
});

describe('a token allowance that runs out mid-answer (ADR-0002 D5)', () => {
  it('stops before the next model call, answers, charges what was used, then refuses', async () => {
    const member = await api.member('dispatcher', 'act-one-percent');
    await withTenant(api.tenantId, (tx) =>
      tx.aiMemberLimits.set({
        userId: member.userId,
        sharePercent: 1,
        expectedVersion: null,
        updatedBy: null,
      }),
    );
    // 1% of five million is fifty thousand: room for the first call's hold,
    // and not for a second once the first reports fifty thousand used.
    const platform = getPlatformDataSource().ai;
    const current = (await platform.tenantPolicy(api.tenantId))!;
    await platform.setTenantPolicy(api.tenantId, {
      mode: 'custom',
      policy: { ...AGENT, dailyTokenLimit: 5_000_000 },
      companyDataToProvider: true,
      reason: 'token allowance',
      expectedVersion: current.version,
      updatedBy: null,
    });
    forgetAiPolicy();
    try {
      const token = await api.signIn(member);
      const conversationId = await conversation(token);
      provider.reset();
      provider.enqueue({
        text: '',
        toolRequests: [{ id: 'call_1', name: 'get_work_order_summary', arguments: {} }],
        usage: { inputTokens: 49_000, outputTokens: 1_000, estimated: false },
        finishReason: 'tool',
      });
      const asked = await ask(token, conversationId, 'How many open jobs?');
      expect(asked.statusCode, asked.body).toBe(200);
      const answer = json<{
        message: { text: string; toolSummaries: { tool: string }[] };
        allowance: { exhausted: boolean; remainingPercent: number | null };
      }>(asked);
      // One call, its tool ran, and the model was not asked again.
      expect(provider.calls).toHaveLength(1);
      expect(answer.message.toolSummaries.map((summary) => summary.tool)).toContain(
        'get_work_order_summary',
      );
      expect(answer.message.text).toMatch(/allowance ran out/u);
      expect(answer.allowance).toMatchObject({ exhausted: true, remainingPercent: 0 });

      const counters = await withTenant(api.tenantId, (tx) =>
        tx.aiUsage.tokenCounters(member.userId, periodKeysAt(new Date())),
      );
      const own = counters.find((row) => row.subject === 'user' && row.period === 'day');
      expect(own).toMatchObject({ used: 50_000, reserved: 0 });

      // The next question is refused before any model is asked.
      provider.reset();
      const refused = await ask(token, conversationId, 'And overdue?');
      expect(refused.statusCode).toBe(429);
      expect(code(refused)).toBe('ai_daily_token_quota_exceeded');
      expect(provider.calls).toHaveLength(0);
    } finally {
      const now = (await platform.tenantPolicy(api.tenantId))!;
      await platform.setTenantPolicy(api.tenantId, {
        mode: 'inherit',
        policy: AGENT,
        companyDataToProvider: true,
        reason: null,
        expectedVersion: now.version,
        updatedBy: null,
      });
      forgetAiPolicy();
    }
  });
});

describe('what a seat is offered', () => {
  it('lists the tools by the seat’s permissions and the company’s modules', async () => {
    const ownerTools = json<{ level: string; tools: string[] }>(
      await api.call(await api.signIn(owner), { method: 'GET', url: '/v1/ai/capabilities' }),
    );
    expect(ownerTools.level).toBe('agent');
    expect(ownerTools.tools).toContain('get_work_order_summary');
    expect(ownerTools.tools).toContain('get_customer_summary');
    expect(ownerTools.tools).toContain('prepare_create_customer');
    expect(ownerTools.tools).toContain('prepare_create_work_order');
    // No CRM module: nothing of the CRM is even named.
    expect(ownerTools.tools).not.toContain('get_crm_pipeline_summary');
    expect(ownerTools.tools).not.toContain('prepare_create_crm_activity');
    // Finance needs the finance module and the provider's approval for financial data.
    expect(ownerTools.tools).not.toContain('get_invoice_summary');

    const viewerTools = json<{ tools: string[] }>(
      await api.call(await api.signIn(viewer), { method: 'GET', url: '/v1/ai/capabilities' }),
    );
    expect(viewerTools.tools).toContain('get_work_order_summary');
    expect(viewerTools.tools).not.toContain('prepare_create_customer');
    expect(viewerTools.tools).not.toContain('prepare_create_work_order');
  });
});

describe('insight tools', () => {
  it('answer only what the seat may see: an engineer’s jobs are their own', async () => {
    const ownerToken = await api.signIn(owner);
    // Two jobs: one assigned to the engineer, one not.
    const customer = json<{ id: string }>(
      await api.call(ownerToken, {
        method: 'POST',
        url: '/v1/customers',
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Assistant Test Co' },
      }),
    );
    const site = json<{ id: string }>(
      await api.call(ownerToken, {
        method: 'POST',
        url: `/v1/customers/${customer.id}/sites`,
        headers: { 'idempotency-key': randomUUID() },
        payload: { name: 'Main site', address: { line1: '1 Test St' } },
      }),
    );
    for (const crew of [[engineer.userId], []]) {
      const made = await api.call(ownerToken, {
        method: 'POST',
        url: '/v1/work-orders',
        headers: { 'idempotency-key': randomUUID() },
        payload: {
          customerId: customer.id,
          siteId: site.id,
          jobTypeId,
          title: crew.length === 0 ? 'Unassigned job' : 'Engineer job',
          crew: crew.map((userId) => ({ userId, lead: true })),
        },
      });
      expect(made.statusCode, made.body).toBe(201);
    }

    const engineerToken = await api.signIn(engineer);
    const conversationId = await conversation(engineerToken);
    provider.reset();
    const asked = await ask(engineerToken, conversationId, '/tool get_work_order_summary {}');
    expect(asked.statusCode, asked.body).toBe(200);
    const answer = json<{ message: { toolSummaries: { tool: string; result: string }[] } }>(asked);
    expect(answer.message.toolSummaries[0]?.tool).toBe('get_work_order_summary');
    // The tool's answer went back to the model as the engineer's own jobs: one.
    const toolTurn = provider.calls[1]?.input.messages.find((turn) => turn.role === 'tool');
    expect(toolTurn?.content).toContain('"scope":"mine"');
    expect(toolTurn?.content).toContain('"open":1');

    // The owner sees both.
    const ownerConversation = await conversation(ownerToken);
    provider.reset();
    await ask(ownerToken, ownerConversation, '/tool get_work_order_summary {}');
    const ownerTurn = provider.calls[1]?.input.messages.find((turn) => turn.role === 'tool');
    expect(ownerTurn?.content).toContain('"scope":"company"');
    expect(ownerTurn?.content).toContain('"open":2');
  });

  it('refuses a tool the seat was not offered without running it', async () => {
    const viewerToken = await api.signIn(viewer);
    const conversationId = await conversation(viewerToken);
    provider.reset();
    provider.enqueue({
      text: '',
      toolRequests: [
        { id: 'c1', name: 'prepare_create_customer', arguments: { name: 'Nope Ltd' } },
      ],
      finishReason: 'tool',
      // The provider's own record of the turn (Anthropic's thinking blocks):
      // it must reach the next call unchanged.
      providerContent: [{ type: 'thinking', thinking: '', signature: 'sig-1' }],
    });
    const asked = await ask(viewerToken, conversationId, 'add a customer called Nope Ltd');
    expect(asked.statusCode, asked.body).toBe(200);
    const toolTurn = provider.calls[1]?.input.messages.find((turn) => turn.role === 'tool');
    expect(toolTurn?.content).toContain('not_allowed');
    const askedTurn = provider.calls[1]?.input.messages.find((turn) => turn.role === 'assistant');
    expect(askedTurn?.providerContent).toEqual([
      { type: 'thinking', thinking: '', signature: 'sig-1' },
    ]);
    const customers = json<{ items: { name: string }[] }>(
      await api.call(await api.signIn(owner), { method: 'GET', url: '/v1/customers?q=Nope' }),
    );
    expect(customers.items.some((item) => item.name === 'Nope Ltd')).toBe(false);
  });
});

describe('prepared actions', () => {
  it('prepare, wait for the member, run once on confirmation, and refuse a second confirmation', async () => {
    const token = await api.signIn(owner);
    const conversationId = await conversation(token);
    provider.reset();
    const asked = await ask(
      token,
      conversationId,
      '/tool prepare_create_customer {"name":"North Star Services","city":"Cairo"}',
    );
    expect(asked.statusCode, asked.body).toBe(200);
    const answer = json<{ message: { actionProposal: Proposal | null } }>(asked);
    const proposal = answer.message.actionProposal;
    expect(proposal?.state).toBe('pending');
    expect(proposal?.preview.title).toContain('North Star Services');

    // Nothing saved yet.
    const before = json<{ items: { name: string }[] }>(
      await api.call(token, { method: 'GET', url: '/v1/customers?q=North%20Star' }),
    );
    expect(before.items).toHaveLength(0);

    // Somebody else cannot confirm it, nor even see it.
    const other = await api.signIn(engineer);
    expect((await confirm(other, proposal!.id)).statusCode).toBe(404);
    expect(
      (await api.call(other, { method: 'GET', url: `/v1/ai/actions/${proposal!.id}` })).statusCode,
    ).toBe(404);

    const done = await confirm(token, proposal!.id);
    expect(done.statusCode, done.body).toBe(200);
    const completed = json<Proposal>(done);
    expect(completed.state).toBe('completed');
    expect(completed.result?.resourceType).toBe('customer');

    const after = json<{ items: { name: string; id: string }[] }>(
      await api.call(token, { method: 'GET', url: '/v1/customers?q=North%20Star' }),
    );
    expect(after.items).toHaveLength(1);
    expect(after.items[0]?.id).toBe(completed.result?.resourceId);

    // Twice is once.
    const again = await confirm(token, proposal!.id);
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('ai_action_already_executed');
    expect(
      json<{ items: unknown[] }>(
        await api.call(token, { method: 'GET', url: '/v1/customers?q=North%20Star' }),
      ).items,
    ).toHaveLength(1);

    // The audit log names the member, and the assistant as the source.
    const entries = await withTenant(api.tenantId, (tx) =>
      tx.auditLog.list({
        resourceType: 'customer',
        resourceId: completed.result?.resourceId ?? '',
      }),
    );
    const entry = entries.find(
      (item) =>
        item.action === 'customer.created' &&
        (item.metadata as { source?: string }).source === 'ai_assistant',
    );
    expect(entry).toBeDefined();
    expect(entry?.actorId).toBe(owner.userId);
  });

  it('can be declined, and a declined one cannot be confirmed', async () => {
    const token = await api.signIn(owner);
    const conversationId = await conversation(token);
    provider.reset();
    const asked = await ask(
      token,
      conversationId,
      '/tool prepare_create_customer {"name":"Declined Ltd"}',
    );
    const proposal = json<{ message: { actionProposal: Proposal } }>(asked).message.actionProposal;
    const rejected = await api.call(token, {
      method: 'POST',
      url: `/v1/ai/actions/${proposal.id}/reject`,
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(json<Proposal>(rejected).state).toBe('rejected');
    const confirmed = await confirm(token, proposal.id);
    expect(confirmed.statusCode).toBe(409);
    expect(code(confirmed)).toBe('ai_action_expired');
  });

  it('is refused once the company no longer has the agent level', async () => {
    const token = await api.signIn(owner);
    const conversationId = await conversation(token);
    provider.reset();
    const asked = await ask(
      token,
      conversationId,
      '/tool prepare_create_customer {"name":"Late Ltd"}',
    );
    const proposal = json<{ message: { actionProposal: Proposal } }>(asked).message.actionProposal;

    const platform = getPlatformDataSource().ai;
    const current = (await platform.tenantPolicy(api.tenantId))!;
    await platform.setTenantPolicy(api.tenantId, {
      mode: 'custom',
      policy: { ...AGENT, level: 'insights' },
      companyDataToProvider: true,
      reason: 'downgrade',
      expectedVersion: current.version,
      updatedBy: null,
    });
    forgetAiPolicy();
    const refused = await confirm(token, proposal.id);
    expect(refused.statusCode).toBe(403);
    expect(code(refused)).toBe('ai_disabled');

    await platform.setTenantPolicy(api.tenantId, {
      mode: 'inherit',
      policy: AGENT,
      companyDataToProvider: true,
      reason: null,
      expectedVersion: current.version + 1,
      updatedBy: null,
    });
    forgetAiPolicy();
  });

  it('creates a job through the same checks as the screen, and refuses when the record changed', async () => {
    const token = await api.signIn(owner);
    const conversationId = await conversation(token);
    provider.reset();
    const asked = await ask(
      token,
      conversationId,
      '/tool prepare_create_work_order {"customerName":"Assistant Test Co","jobTypeName":"Repair","title":"Boiler check","dueBy":"2030-01-15"}',
    );
    expect(asked.statusCode, asked.body).toBe(200);
    const proposal = json<{ message: { actionProposal: Proposal | null } }>(asked).message
      .actionProposal;
    expect(proposal?.state).toBe('pending');
    expect(proposal?.preview.fields.some((field) => field.value === 'Repair')).toBe(true);

    // The customer is put on hold between proposal and confirmation: the
    // proposal was made against an active customer, so it no longer stands.
    const customers = json<{ items: { id: string }[] }>(
      await api.call(token, { method: 'GET', url: '/v1/customers?q=Assistant%20Test' }),
    );
    const customerId = customers.items[0]!.id;
    const held = await api.call(token, {
      method: 'PATCH',
      url: `/v1/customers/${customerId}`,
      payload: { status: 'on_hold' },
    });
    expect(held.statusCode, held.body).toBe(200);
    const refused = await confirm(token, proposal!.id);
    expect(refused.statusCode).toBe(409);
    expect(code(refused)).toBe('ai_action_expired');
    await api.call(token, {
      method: 'PATCH',
      url: `/v1/customers/${customerId}`,
      payload: { status: 'active' },
    });

    // A fresh proposal goes through.
    provider.reset();
    const retried = await ask(
      token,
      conversationId,
      '/tool prepare_create_work_order {"customerName":"Assistant Test Co","jobTypeName":"Repair","title":"Boiler check"}',
    );
    const fresh = json<{ message: { actionProposal: Proposal } }>(retried).message.actionProposal;
    const done = await confirm(token, fresh.id);
    expect(done.statusCode, done.body).toBe(200);
    const result = json<Proposal>(done).result;
    expect(result?.resourceType).toBe('work_order');
    const job = await api.call(token, {
      method: 'GET',
      url: `/v1/work-orders/${result?.resourceId}`,
    });
    expect(job.statusCode).toBe(200);
    expect(json<{ workOrder: { title: string } }>(job).workOrder.title).toBe('Boiler check');
  });
});
