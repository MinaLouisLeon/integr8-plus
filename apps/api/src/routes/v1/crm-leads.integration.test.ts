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
 * Leads (CRM/ERP plan, phase C1), and the module gate every CRM route sits behind.
 *
 * - With the CRM switched off, every CRM route refuses with `feature_disabled`,
 *   whatever the seat's role; switched on, the permission decides.
 * - Owners, admins and dispatchers manage leads; viewers read them; engineers
 *   see nothing.
 * - A lead belongs to one company: another company cannot read or change it by id.
 * - An edit against a version somebody already changed is refused, not merged.
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

interface LeadBody {
  id: string;
  displayName: string;
  status: string;
  source: string;
  assignedTo: string | null;
  estimatedValue: string | null;
  currencyCode: string | null;
  version: number;
  archivedAt: string | null;
}

async function token(who: Member): Promise<string> {
  let value = tokens.get(who);
  if (value === undefined) {
    value = await api.signIn(who);
    tokens.set(who, value);
  }
  return value;
}

async function setCrm(enabled: boolean, tenantId = api.tenantId): Promise<void> {
  const response = await api.call(admin.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${tenantId}/flags/crm`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function createLead(
  who: Member,
  payload: Record<string, unknown>,
  key: string = randomUUID(),
): Promise<{ statusCode: number; body: string }> {
  return api.call(await token(who), {
    method: 'POST',
    url: '/v1/crm/leads',
    headers: { 'idempotency-key': key },
    payload,
  });
}

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin('crm-staff');
  owner = await api.member('owner', 'crm-owner');
  dispatcher = await api.member('dispatcher', 'crm-dispatcher');
  engineer = await api.member('engineer', 'crm-engineer');
  viewer = await api.member('viewer', 'crm-viewer');
});

afterAll(async () => {
  await api.close();
});

describe('the CRM module switch', () => {
  it('refuses every CRM route while the company does not have it, owner included', async () => {
    const list = await api.call(await token(owner), { method: 'GET', url: '/v1/crm/leads' });
    expect(list.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(list).error.code).toBe('feature_disabled');

    const create = await createLead(owner, { displayName: 'Too early' });
    expect(create.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(create).error.code).toBe('feature_disabled');
  });

  it('opens once Integr8 switches it on, and says so on /v1/me', async () => {
    await setCrm(true);
    const me = json<{ features: Record<string, boolean>; permissions: string[] }>(
      await api.call(await token(owner), { method: 'GET', url: '/v1/me' }),
    );
    expect(me.features.crm).toBe(true);
    expect(me.permissions).toContain('crm.lead.convert');

    const list = await api.call(await token(owner), { method: 'GET', url: '/v1/crm/leads' });
    expect(list.statusCode, list.body).toBe(200);
  });

  it('checks the permission first: an engineer is refused for the role, not the module', async () => {
    const response = await api.call(await token(engineer), { method: 'GET', url: '/v1/crm/leads' });
    expect(response.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(response).error.code).toBe('forbidden');
  });
});

describe('leads', () => {
  it('creates a lead, never a customer, and records who did it', async () => {
    const response = await createLead(owner, {
      displayName: 'Ada Prospect',
      companyName: 'Analytical Engines',
      email: 'ada@engines.example',
      source: 'referral',
      assignedTo: dispatcher.userId,
      estimatedValue: '1250.50',
    });
    expect(response.statusCode, response.body).toBe(201);
    const lead = json<LeadBody>(response);
    expect(lead).toMatchObject({
      displayName: 'Ada Prospect',
      status: 'new',
      source: 'referral',
      assignedTo: dispatcher.userId,
      estimatedValue: '1250.5',
      // No currency sent: the company's, which is EGP for every company.
      currencyCode: 'EGP',
      version: 1,
    });

    const customers = await withTenant(api.tenantId, (tx) =>
      tx.customers.findByName('Ada Prospect'),
    );
    expect(customers).toEqual([]);

    const audit = await withTenant(api.tenantId, (tx) =>
      tx.auditLog.list({ resourceType: 'crm_lead', resourceId: lead.id }),
    );
    expect(audit.map((entry) => entry.action)).toContain('crm_lead.created');
  });

  it('creates once for one idempotency key', async () => {
    const key = randomUUID();
    const first = json<LeadBody>(await createLead(owner, { displayName: 'Retry Ltd' }, key));
    const second = json<LeadBody>(await createLead(owner, { displayName: 'Retry Ltd' }, key));
    expect(second.id).toBe(first.id);
  });

  it('lets a viewer read leads and change nothing', async () => {
    const list = await api.call(await token(viewer), { method: 'GET', url: '/v1/crm/leads' });
    expect(list.statusCode).toBe(200);
    expect(json<{ items: LeadBody[] }>(list).items.length).toBeGreaterThan(0);

    const create = await createLead(viewer, { displayName: 'Viewer Lead' });
    expect(create.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(create).error.code).toBe('forbidden');
  });

  it('lets a dispatcher manage leads', async () => {
    const response = await createLead(dispatcher, { displayName: 'Dispatcher Lead' });
    expect(response.statusCode, response.body).toBe(201);
  });

  it('refuses an assignee who is not an active member of the company', async () => {
    const response = await createLead(owner, {
      displayName: 'Nobody Assigned',
      assignedTo: randomUUID(),
    });
    expect(response.statusCode).toBe(422);
    expect(json<{ error: { code: string } }>(response).error.code).toBe('assignee_not_member');
  });

  it('refuses a value that is not an exact decimal string', async () => {
    for (const estimatedValue of [1250.5, '1.23456', '-3']) {
      const response = await createLead(owner, { displayName: 'Bad Value', estimatedValue });
      expect(response.statusCode, String(estimatedValue)).toBe(422);
    }
  });

  it('qualifies a lead, and refuses an edit made against an older version', async () => {
    const lead = json<LeadBody>(await createLead(owner, { displayName: 'Versioned Ltd' }));
    const auth = await token(owner);

    const qualified = await api.call(auth, {
      method: 'PATCH',
      url: `/v1/crm/leads/${lead.id}`,
      payload: { expectedVersion: 1, status: 'qualified' },
    });
    expect(qualified.statusCode, qualified.body).toBe(200);
    expect(json<LeadBody>(qualified)).toMatchObject({ status: 'qualified', version: 2 });

    const stale = await api.call(auth, {
      method: 'PATCH',
      url: `/v1/crm/leads/${lead.id}`,
      payload: { expectedVersion: 1, status: 'contacted' },
    });
    expect(stale.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(stale).error.code).toBe('version_conflict');

    const audit = await withTenant(api.tenantId, (tx) =>
      tx.auditLog.list({ resourceType: 'crm_lead', resourceId: lead.id }),
    );
    expect(audit.map((entry) => entry.action)).toContain('crm_lead.status_changed');
  });

  it('keeps a currency on a lead that has a value', async () => {
    const lead = json<LeadBody>(
      await createLead(owner, {
        displayName: 'Priced Ltd',
        estimatedValue: '10',
        currencyCode: 'USD',
      }),
    );
    const cleared = await api.call(await token(owner), {
      method: 'PATCH',
      url: `/v1/crm/leads/${lead.id}`,
      payload: { expectedVersion: 1, currencyCode: null },
    });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(json<LeadBody>(cleared)).toMatchObject({ estimatedValue: '10', currencyCode: 'EGP' });

    const priced = json<LeadBody>(await createLead(owner, { displayName: 'Unpriced Ltd' }));
    const valued = await api.call(await token(owner), {
      method: 'PATCH',
      url: `/v1/crm/leads/${priced.id}`,
      payload: { expectedVersion: 1, estimatedValue: '99.9900' },
    });
    expect(valued.statusCode, valued.body).toBe(200);
    expect(json<LeadBody>(valued)).toMatchObject({ estimatedValue: '99.99', currencyCode: 'EGP' });
  });

  it('never reaches converted by an edit', async () => {
    const lead = json<LeadBody>(await createLead(owner, { displayName: 'Shortcut Ltd' }));
    const response = await api.call(await token(owner), {
      method: 'PATCH',
      url: `/v1/crm/leads/${lead.id}`,
      payload: { expectedVersion: 1, status: 'converted' },
    });
    expect(response.statusCode).toBe(422);
  });

  it('archives a lead out of the default list and restores it', async () => {
    const lead = json<LeadBody>(await createLead(owner, { displayName: 'Archivable Ltd' }));
    const auth = await token(owner);
    const archived = await api.call(auth, {
      method: 'PATCH',
      url: `/v1/crm/leads/${lead.id}`,
      payload: { expectedVersion: 1, archived: true },
    });
    expect(json<LeadBody>(archived).archivedAt).not.toBeNull();

    const ids = async (query: string) =>
      json<{ items: LeadBody[] }>(
        await api.call(auth, { method: 'GET', url: `/v1/crm/leads?limit=100${query}` }),
      ).items.map((item) => item.id);
    expect(await ids('')).not.toContain(lead.id);
    expect(await ids('&includeArchived=true')).toContain(lead.id);

    const restored = await api.call(auth, {
      method: 'PATCH',
      url: `/v1/crm/leads/${lead.id}`,
      payload: { expectedVersion: 2, archived: false },
    });
    expect(json<LeadBody>(restored).archivedAt).toBeNull();
  });

  it('filters by status, source, assignee and words, and pages with a cursor', async () => {
    const auth = await token(owner);
    const tag = randomUUID().slice(0, 8);
    for (let index = 0; index < 3; index += 1) {
      await createLead(owner, { displayName: `Paged ${tag} ${String(index)}`, source: 'web' });
    }
    const first = json<{ items: LeadBody[]; nextCursor: string | null }>(
      await api.call(auth, { method: 'GET', url: `/v1/crm/leads?q=${tag}&limit=2` }),
    );
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = json<{ items: LeadBody[]; nextCursor: string | null }>(
      await api.call(auth, {
        method: 'GET',
        url: `/v1/crm/leads?q=${tag}&limit=2&cursor=${first.nextCursor ?? ''}`,
      }),
    );
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const web = json<{ items: LeadBody[] }>(
      await api.call(auth, { method: 'GET', url: `/v1/crm/leads?source=web&q=${tag}` }),
    );
    expect(web.items).toHaveLength(3);

    const mine = json<{ items: LeadBody[] }>(
      await api.call(await token(dispatcher), {
        method: 'GET',
        url: '/v1/crm/leads?assignedTo=me',
      }),
    );
    expect(mine.items.every((item) => item.assignedTo === dispatcher.userId)).toBe(true);
    expect(mine.items.length).toBeGreaterThan(0);
  });

  it('keeps another company’s lead out of reach, by id and by search', async () => {
    // A second company with the CRM on and a lead of its own, written directly.
    const southgate = await getPlatformDataSource().tenants.create({
      slug: `crm-other-${randomUUID().slice(0, 8)}`,
      name: 'Southgate Ltd',
    });
    await setCrm(true, southgate.id);
    const theirs = await withTenant(southgate.id, (tx) =>
      tx.crmLeads.create({ displayName: 'Southgate Private Prospect' }, randomUUID()),
    );

    const auth = await token(owner);
    const read = await api.call(auth, { method: 'GET', url: `/v1/crm/leads/${theirs.id}` });
    expect(read.statusCode).toBe(404);

    const write = await api.call(auth, {
      method: 'PATCH',
      url: `/v1/crm/leads/${theirs.id}`,
      payload: { expectedVersion: 1, displayName: 'Taken' },
    });
    expect(write.statusCode).toBe(404);

    const list = json<{ items: LeadBody[] }>(
      await api.call(auth, {
        method: 'GET',
        url: '/v1/crm/leads?q=Southgate&includeArchived=true',
      }),
    );
    expect(list.items.map((item) => item.id)).not.toContain(theirs.id);

    const untouched = await withTenant(southgate.id, (tx) => tx.crmLeads.find(theirs.id));
    expect(untouched?.displayName).toBe('Southgate Private Prospect');
  });

  it('shuts again when Integr8 switches the CRM off', async () => {
    await setCrm(false);
    const response = await api.call(await token(owner), { method: 'GET', url: '/v1/crm/leads' });
    expect(response.statusCode).toBe(403);
    expect(json<{ error: { code: string } }>(response).error.code).toBe('feature_disabled');
    await setCrm(true);
  });
});
