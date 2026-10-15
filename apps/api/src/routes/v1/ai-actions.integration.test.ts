import { randomUUID } from 'node:crypto';
import { AI_POLICY_OFF, type AiPolicy } from '@integr8/core';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
    });
    const asked = await ask(viewerToken, conversationId, 'add a customer called Nope Ltd');
    expect(asked.statusCode, asked.body).toBe(200);
    const toolTurn = provider.calls[1]?.input.messages.find((turn) => turn.role === 'tool');
    expect(toolTurn?.content).toContain('not_allowed');
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
