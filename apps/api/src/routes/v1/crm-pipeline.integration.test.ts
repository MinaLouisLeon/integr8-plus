import { getPlatformDataSource, withTenant } from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Opportunities, the pipeline, activities and the dashboard (CRM/ERP plan,
 * phase C3) — the MVP's exit: a lead becomes an opportunity and a customer,
 * and somebody follows it up.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let dispatcher: Member;
let engineer: Member;
let viewer: Member;
const tokens = new Map<Member, string>();

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}

const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

interface Stage {
  id: string;
  key: string;
  outcome: string;
  probabilityBp: number;
}

interface OpportunityBody {
  id: string;
  title: string;
  customer: { id: string; name: string } | null;
  lead: { id: string } | null;
  stage: Stage;
  ownerId: string | null;
  amount: string | null;
  currencyCode: string;
  expectedCloseDate: string | null;
  probabilityBp: number;
  status: string;
  lostReason: string | null;
  closedAt: string | null;
  version: number;
}

interface Detail {
  opportunity: OpportunityBody;
  events: { kind: string; fromStage: Stage | null; toStage: Stage | null; reason: string | null }[];
  stages: Stage[];
}

interface ActivityBody {
  id: string;
  kind: string;
  status: string;
  completedBy: string | null;
  version: number;
  leads: { id: string }[];
  opportunities: { id: string }[];
}

async function token(who: Member): Promise<string> {
  let value = tokens.get(who);
  if (value === undefined) {
    value = await api.signIn(who);
    tokens.set(who, value);
  }
  return value;
}

async function call(
  who: Member,
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  payload?: Record<string, unknown>,
) {
  return api.call(await token(who), {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
  });
}

async function customer(name: string): Promise<string> {
  const response = await call(owner, 'POST', '/v1/customers', { name });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ id: string }>(response).id;
}

async function opportunity(payload: Record<string, unknown>): Promise<OpportunityBody> {
  const response = await call(owner, 'POST', '/v1/crm/opportunities', payload);
  expect(response.statusCode, response.body).toBe(201);
  return json<OpportunityBody>(response);
}

let stages: Stage[];
const stage = (key: string) => stages.find((item) => item.key === key)!;

function move(
  who: Member,
  item: { id: string; version: number },
  key: string,
  lostReason?: string,
) {
  return call(who, 'POST', `/v1/crm/opportunities/${item.id}/transitions`, {
    expectedVersion: item.version,
    stageId: stage(key).id,
    ...(lostReason === undefined ? {} : { lostReason }),
  });
}

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin('pipe-staff');
  owner = await api.member('owner', 'pipe-owner');
  dispatcher = await api.member('dispatcher', 'pipe-dispatcher');
  engineer = await api.member('engineer', 'pipe-engineer');
  viewer = await api.member('viewer', 'pipe-viewer');
  const response = await api.call(admin.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/crm`,
    payload: { enabled: true },
  });
  expect(response.statusCode, response.body).toBe(200);
});

afterAll(async () => {
  await api.close();
});

describe('the pipeline', () => {
  it('gives every company the standard stages, readable by viewers and not engineers', async () => {
    const response = await call(viewer, 'GET', '/v1/crm/pipelines');
    expect(response.statusCode, response.body).toBe(200);
    const [pipeline] = json<{ items: { isDefault: boolean; stages: Stage[] }[] }>(response).items;
    expect(pipeline?.isDefault).toBe(true);
    stages = pipeline!.stages;
    expect(stages.map((item) => [item.key, item.outcome, item.probabilityBp])).toEqual([
      ['new', 'open', 1000],
      ['qualified', 'open', 2500],
      ['proposal', 'open', 5000],
      ['negotiation', 'open', 7500],
      ['won', 'won', 10000],
      ['lost', 'lost', 0],
    ]);

    const refused = await call(engineer, 'GET', '/v1/crm/pipelines');
    expect(refused.statusCode).toBe(403);
    expect(code(refused)).toBe('forbidden');
  });
});

describe('opportunities', () => {
  it('opens at the first stage, in the company currency, with an exact amount', async () => {
    const customerId = await customer(`Pyramid Hotels ${randomUUID().slice(0, 6)}`);
    const created = await opportunity({
      title: 'Chiller maintenance contract',
      customerId,
      amount: '250000.75',
      expectedCloseDate: '2026-12-15',
      ownerId: dispatcher.userId,
    });
    expect(created).toMatchObject({
      stage: { key: 'new' },
      status: 'open',
      currencyCode: 'EGP',
      amount: '250000.75',
      probabilityBp: 1000,
      expectedCloseDate: '2026-12-15',
      ownerId: dispatcher.userId,
    });

    const audit = await withTenant(api.tenantId, (tx) =>
      tx.auditLog.list({ resourceType: 'crm_opportunity', resourceId: created.id }),
    );
    expect(audit.map((entry) => entry.action)).toContain('crm_opportunity.created');
  });

  it('needs a customer or a lead, of this company', async () => {
    const none = await call(owner, 'POST', '/v1/crm/opportunities', { title: 'Nobody’s' });
    expect(none.statusCode).toBe(422);
    expect(code(none)).toBe('party_required');

    const elsewhere = await getPlatformDataSource().tenants.create({
      slug: `pipe-other-${randomUUID().slice(0, 8)}`,
      name: 'Elsewhere Ltd',
    });
    const theirs = await withTenant(elsewhere.id, (tx) =>
      tx.customers.create({ name: 'Elsewhere Customer' }, randomUUID()),
    );
    const cross = await call(owner, 'POST', '/v1/crm/opportunities', {
      title: 'Cross',
      customerId: theirs.id,
    });
    expect(cross.statusCode).toBe(404);
    expect(code(cross)).toBe('customer_not_found');
  });

  it('starts only at an open stage', async () => {
    const customerId = await customer(`Shortcut ${randomUUID().slice(0, 6)}`);
    const response = await call(owner, 'POST', '/v1/crm/opportunities', {
      title: 'Already won',
      customerId,
      stageId: stage('won').id,
    });
    expect(response.statusCode).toBe(422);
    expect(code(response)).toBe('stage_not_open');
  });

  it('moves forward, is lost with a reason, reopened and won, and keeps the history', async () => {
    const customerId = await customer(`Mover ${randomUUID().slice(0, 6)}`);
    const created = await opportunity({ title: 'Lift refurbishment', customerId, amount: '90000' });

    const proposal = await move(dispatcher, created, 'proposal');
    expect(proposal.statusCode, proposal.body).toBe(200);
    let detail = json<Detail>(proposal);
    expect(detail.opportunity).toMatchObject({ status: 'open', probabilityBp: 5000, version: 2 });

    const noReason = await move(dispatcher, detail.opportunity, 'lost');
    expect(noReason.statusCode).toBe(422);
    expect(code(noReason)).toBe('lost_reason_required');

    detail = json<Detail>(await move(dispatcher, detail.opportunity, 'lost', 'Budget frozen'));
    expect(detail.opportunity).toMatchObject({ status: 'lost', lostReason: 'Budget frozen' });
    expect(detail.opportunity.closedAt).not.toBeNull();

    detail = json<Detail>(await move(dispatcher, detail.opportunity, 'negotiation'));
    expect(detail.opportunity).toMatchObject({ status: 'open', lostReason: null, closedAt: null });

    detail = json<Detail>(await move(dispatcher, detail.opportunity, 'won'));
    expect(detail.opportunity).toMatchObject({ status: 'won', probabilityBp: 10000 });
    expect(detail.events.map((event) => event.kind)).toEqual([
      'won',
      'reopened',
      'lost',
      'stage_changed',
      'created',
    ]);
    expect(detail.events[2]).toMatchObject({ reason: 'Budget frozen', toStage: { key: 'lost' } });

    const same = await move(dispatcher, detail.opportunity, 'won');
    expect(same.statusCode).toBe(422);
    expect(code(same)).toBe('invalid_transition');

    const stale = await move(dispatcher, created, 'qualified');
    expect(stale.statusCode).toBe(409);
    expect(code(stale)).toBe('version_conflict');
  });

  it('refuses a stage from another company’s pipeline', async () => {
    const elsewhere = await getPlatformDataSource().tenants.create({
      slug: `pipe-stage-${randomUUID().slice(0, 8)}`,
      name: 'Other Pipeline Ltd',
    });
    const theirs = await withTenant(elsewhere.id, (tx) => tx.crmPipelines.ensureDefault());
    const customerId = await customer(`Stage Thief ${randomUUID().slice(0, 6)}`);
    const created = await opportunity({ title: 'Mine', customerId });
    const response = await call(owner, 'POST', `/v1/crm/opportunities/${created.id}/transitions`, {
      expectedVersion: created.version,
      stageId: theirs.stages[1]!.id,
    });
    expect(response.statusCode).toBe(422);
    expect(code(response)).toBe('invalid_transition');
  });

  it('edits details against a version, keeps a party, and archives', async () => {
    const customerId = await customer(`Editable ${randomUUID().slice(0, 6)}`);
    const created = await opportunity({ title: 'Editable', customerId });

    const edited = await call(owner, 'PATCH', `/v1/crm/opportunities/${created.id}`, {
      expectedVersion: created.version,
      amount: '1500.0000',
      currencyCode: 'USD',
      probabilityBp: 3300,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    expect(json<OpportunityBody>(edited)).toMatchObject({
      amount: '1500',
      currencyCode: 'USD',
      probabilityBp: 3300,
      version: 2,
    });

    const stale = await call(owner, 'PATCH', `/v1/crm/opportunities/${created.id}`, {
      expectedVersion: created.version,
      title: 'Lost update',
    });
    expect(stale.statusCode).toBe(409);

    const orphan = await call(owner, 'PATCH', `/v1/crm/opportunities/${created.id}`, {
      expectedVersion: 2,
      customerId: null,
    });
    expect(orphan.statusCode).toBe(422);
    expect(code(orphan)).toBe('party_required');

    const float = await call(owner, 'PATCH', `/v1/crm/opportunities/${created.id}`, {
      expectedVersion: 2,
      amount: 1500.5,
    });
    expect(float.statusCode).toBe(422);

    const archived = await call(owner, 'PATCH', `/v1/crm/opportunities/${created.id}`, {
      expectedVersion: 2,
      archived: true,
    });
    expect(archived.statusCode).toBe(200);
    const frozen = await move(owner, { id: created.id, version: 3 }, 'qualified');
    expect(frozen.statusCode).toBe(422);
    expect(code(frozen)).toBe('opportunity_archived');
  });

  it('lets viewers read and not change, and dispatchers do both', async () => {
    const customerId = await customer(`Roles ${randomUUID().slice(0, 6)}`);
    const created = await opportunity({ title: 'Roles', customerId });

    expect((await call(viewer, 'GET', `/v1/crm/opportunities/${created.id}`)).statusCode).toBe(200);
    const write = await call(viewer, 'POST', '/v1/crm/opportunities', {
      title: 'Viewer’s',
      customerId,
    });
    expect(write.statusCode).toBe(403);
    expect((await move(viewer, created, 'qualified')).statusCode).toBe(403);

    expect((await move(dispatcher, created, 'qualified')).statusCode).toBe(200);
  });

  it('lists by stage, status, owner and customer, and pages', async () => {
    const tag = randomUUID().slice(0, 6);
    const customerId = await customer(`Listed ${tag}`);
    for (let index = 0; index < 3; index += 1) {
      await opportunity({ title: `Listed ${tag} ${index}`, customerId, ownerId: owner.userId });
    }
    const first = json<{ items: OpportunityBody[]; nextCursor: string | null }>(
      await call(owner, 'GET', `/v1/crm/opportunities?customerId=${customerId}&limit=2`),
    );
    expect(first.items).toHaveLength(2);
    const second = json<{ items: OpportunityBody[]; nextCursor: string | null }>(
      await call(
        owner,
        'GET',
        `/v1/crm/opportunities?customerId=${customerId}&limit=2&cursor=${first.nextCursor!}`,
      ),
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const mine = json<{ items: OpportunityBody[] }>(
      await call(owner, 'GET', `/v1/crm/opportunities?ownerId=me&q=${tag}&status=open`),
    );
    expect(mine.items).toHaveLength(3);
    const atNew = json<{ items: OpportunityBody[] }>(
      await call(owner, 'GET', `/v1/crm/opportunities?stageId=${stage('new').id}&q=${tag}`),
    );
    expect(atNew.items).toHaveLength(3);
  });
});

describe('activities', () => {
  it('sets a follow-up on a lead and an opportunity, lists it as overdue, and completes it', async () => {
    const lead = json<{ id: string }>(
      await call(owner, 'POST', '/v1/crm/leads', { displayName: `Follow Me ${randomUUID()}` }),
    );
    const customerId = await customer(`Follow ${randomUUID().slice(0, 6)}`);
    const deal = await opportunity({ title: 'Follow deal', customerId, leadId: lead.id });

    const created = await call(dispatcher, 'POST', '/v1/crm/activities', {
      kind: 'follow_up',
      subject: 'Send the revised quote',
      dueAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
      assignedTo: dispatcher.userId,
      leadIds: [lead.id],
      opportunityIds: [deal.id],
    });
    expect(created.statusCode, created.body).toBe(201);
    const activity = json<ActivityBody>(created);
    expect(activity).toMatchObject({
      status: 'open',
      leads: [{ id: lead.id }],
      opportunities: [{ id: deal.id }],
    });

    const overdue = json<{ items: ActivityBody[] }>(
      await call(dispatcher, 'GET', '/v1/crm/activities?due=overdue&assignedTo=me&status=open'),
    );
    expect(overdue.items.map((item) => item.id)).toContain(activity.id);
    const forDeal = json<{ items: ActivityBody[] }>(
      await call(viewer, 'GET', `/v1/crm/activities?opportunityId=${deal.id}&order=recent`),
    );
    expect(forDeal.items.map((item) => item.id)).toEqual([activity.id]);

    const done = await call(dispatcher, 'PATCH', `/v1/crm/activities/${activity.id}`, {
      expectedVersion: activity.version,
      status: 'done',
      outcome: 'Quote sent, they will reply on Sunday',
    });
    expect(done.statusCode, done.body).toBe(200);
    expect(json<ActivityBody>(done)).toMatchObject({
      status: 'done',
      completedBy: dispatcher.userId,
    });

    const stale = await call(dispatcher, 'PATCH', `/v1/crm/activities/${activity.id}`, {
      expectedVersion: activity.version,
      status: 'cancelled',
    });
    expect(stale.statusCode).toBe(409);
  });

  it('writes notes as done, and links every activity to something of this company', async () => {
    const customerId = await customer(`Noted ${randomUUID().slice(0, 6)}`);
    const note = await call(owner, 'POST', '/v1/crm/activities', {
      kind: 'note',
      subject: 'Prefers calls after 4pm',
      customerIds: [customerId],
    });
    expect(json<ActivityBody>(note)).toMatchObject({ status: 'done', completedBy: owner.userId });

    const nothing = await call(owner, 'POST', '/v1/crm/activities', {
      kind: 'call',
      subject: 'About nothing',
    });
    expect(nothing.statusCode).toBe(422);
    expect(code(nothing)).toBe('link_required');

    const elsewhere = await getPlatformDataSource().tenants.create({
      slug: `pipe-link-${randomUUID().slice(0, 8)}`,
      name: 'Link Elsewhere',
    });
    const theirs = await withTenant(elsewhere.id, (tx) =>
      tx.crmLeads.create({ displayName: 'Their Lead' }, randomUUID()),
    );
    const cross = await call(owner, 'POST', '/v1/crm/activities', {
      kind: 'call',
      subject: 'Cross',
      leadIds: [theirs.id],
    });
    expect(cross.statusCode).toBe(404);
    expect(code(cross)).toBe('link_not_found');

    const viewerWrite = await call(viewer, 'POST', '/v1/crm/activities', {
      kind: 'note',
      subject: 'Viewer',
      customerIds: [customerId],
    });
    expect(viewerWrite.statusCode).toBe(403);
  });
});

describe('Lead → Opportunity → Customer → follow-up', () => {
  it('converts a lead with its opportunity, and the customer shows the whole story', async () => {
    const name = `Story Ltd ${randomUUID().slice(0, 6)}`;
    const lead = json<{ id: string; version: number }>(
      await call(owner, 'POST', '/v1/crm/leads', {
        displayName: 'Rania Saleh',
        companyName: name,
        assignedTo: dispatcher.userId,
      }),
    );
    // An opportunity worked before the lead was a customer.
    const early = await opportunity({ title: 'Early talks', leadId: lead.id });
    expect(early.customer).toBeNull();

    const converted = await api.call(await token(dispatcher), {
      method: 'POST',
      url: `/v1/crm/leads/${lead.id}/convert`,
      headers: { 'idempotency-key': randomUUID() },
      payload: {
        expectedVersion: lead.version,
        customer: { mode: 'new', name },
        opportunity: {
          title: 'Annual service plan',
          amount: '48000',
          expectedCloseDate: '2027-01-31',
        },
      },
    });
    expect(converted.statusCode, converted.body).toBe(201);
    const result = json<{ customerId: string; opportunityId: string }>(converted);

    await call(dispatcher, 'POST', '/v1/crm/activities', {
      kind: 'follow_up',
      subject: 'Kick-off visit',
      dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      customerIds: [result.customerId],
      opportunityIds: [result.opportunityId],
    });

    const summary = json<{
      leads: { id: string }[];
      opportunities: OpportunityBody[];
      activities: ActivityBody[];
    }>(await call(viewer, 'GET', `/v1/customers/${result.customerId}/crm`));
    expect(summary.leads.map((item) => item.id)).toEqual([lead.id]);
    expect(summary.opportunities.map((item) => item.title).sort()).toEqual([
      'Annual service plan',
      'Early talks',
    ]);
    const plan = summary.opportunities.find((item) => item.title === 'Annual service plan')!;
    expect(plan).toMatchObject({
      amount: '48000',
      ownerId: dispatcher.userId,
      lead: { id: lead.id },
      expectedCloseDate: '2027-01-31',
    });
    expect(summary.activities).toHaveLength(1);
  });
});

describe('the dashboard', () => {
  it('totals the open pipeline per currency, weighted by chance, and counts follow-ups', async () => {
    const customerId = await customer(`Dashboard ${randomUUID().slice(0, 6)}`);
    const read = async () =>
      json<{
        currency: string;
        openTotals: { currencyCode: string; total: string; weighted: string; count: number }[];
        won: { currencyCode: string; total: string }[];
        pipeline: { stages: { key: string; count: number }[] };
        activities: { overdue: number };
      }>(await call(viewer, 'GET', '/v1/crm/dashboard'));

    // A currency nothing else in this suite uses, so its totals are this test's alone.
    await opportunity({ title: 'Yen A', customerId, amount: '0.1', currencyCode: 'JPY' });
    const second = await opportunity({
      title: 'Yen B',
      customerId,
      amount: '0.2',
      currencyCode: 'JPY',
    });
    await move(owner, second, 'proposal');

    const dashboard = await read();
    expect(dashboard.currency).toBe('EGP');
    expect(dashboard.openTotals.find((total) => total.currencyCode === 'JPY')).toEqual({
      currencyCode: 'JPY',
      total: '0.3',
      weighted: '0.11',
      count: 2,
    });
    expect(dashboard.pipeline.stages.map((item) => item.key)).toEqual([
      'new',
      'qualified',
      'proposal',
      'negotiation',
    ]);

    const refused = await call(engineer, 'GET', '/v1/crm/dashboard');
    expect(refused.statusCode).toBe(403);
  });
});
