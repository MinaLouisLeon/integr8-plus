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
 * Converting a lead into a customer (CRM/ERP plan, phase C2, ADR-0002).
 *
 * - A lead converts once: into an existing customer or exactly one new one,
 *   with an optional contact, in one transaction.
 * - The same request retried returns the first answer; two different requests
 *   racing for the same lead create one customer between them.
 * - Another company's customer cannot be the target, and nothing about it leaks.
 * - Linking an existing customer leaves the customer's own details alone.
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

interface LeadBody {
  id: string;
  status: string;
  version: number;
  convertedCustomerId: string | null;
  convertedContactId: string | null;
  convertedAt: string | null;
}

interface Conversion {
  lead: LeadBody;
  customerId: string;
  contactId: string | null;
  customerCreated: boolean;
  contactCreated: boolean;
}

async function token(who: Member): Promise<string> {
  let value = tokens.get(who);
  if (value === undefined) {
    value = await api.signIn(who);
    tokens.set(who, value);
  }
  return value;
}

async function newLead(payload: Record<string, unknown>): Promise<LeadBody> {
  const response = await api.call(await token(owner), {
    method: 'POST',
    url: '/v1/crm/leads',
    payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<LeadBody>(response);
}

async function newCustomer(payload: Record<string, unknown>): Promise<{ id: string }> {
  const response = await api.call(await token(owner), {
    method: 'POST',
    url: '/v1/customers',
    payload,
  });
  expect(response.statusCode, response.body).toBe(201);
  return json<{ id: string }>(response);
}

function convert(
  who: Member | string,
  leadId: string,
  payload: Record<string, unknown>,
  key: string | null = randomUUID(),
) {
  return (async () =>
    api.call(typeof who === 'string' ? who : await token(who), {
      method: 'POST',
      url: `/v1/crm/leads/${leadId}/convert`,
      ...(key === null ? {} : { headers: { 'idempotency-key': key } }),
      payload,
    }))();
}

const customersNamed = (name: string) =>
  withTenant(api.tenantId, (tx) => tx.customers.findByName(name));

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin('conv-staff');
  owner = await api.member('owner', 'conv-owner');
  dispatcher = await api.member('dispatcher', 'conv-dispatcher');
  engineer = await api.member('engineer', 'conv-engineer');
  viewer = await api.member('viewer', 'conv-viewer');
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

describe('converting into a new customer', () => {
  it('creates exactly one customer and contact, links the lead and records who did it', async () => {
    const name = `Nile Towers ${randomUUID().slice(0, 6)}`;
    const lead = await newLead({ displayName: 'Mona Adel', companyName: name });

    const response = await convert(dispatcher, lead.id, {
      expectedVersion: lead.version,
      customer: { mode: 'new', name, email: 'ops@niletowers.example' },
      contact: { mode: 'new', name: 'Mona Adel', jobTitle: 'Facilities', isPrimary: true },
    });
    expect(response.statusCode, response.body).toBe(201);
    const result = json<Conversion>(response);
    expect(result).toMatchObject({ customerCreated: true, contactCreated: true });
    expect(result.lead).toMatchObject({
      status: 'converted',
      convertedCustomerId: result.customerId,
      convertedContactId: result.contactId,
      version: lead.version + 1,
    });

    const customer = await api.call(await token(owner), {
      method: 'GET',
      url: `/v1/customers/${result.customerId}`,
    });
    expect(customer.statusCode).toBe(200);
    expect(
      json<{ customer: { name: string }; contacts: { id: string; isPrimary: boolean }[] }>(
        customer,
      ),
    ).toMatchObject({
      customer: { name },
      contacts: [{ id: result.contactId, isPrimary: true }],
    });

    const audit = await withTenant(api.tenantId, (tx) =>
      tx.auditLog.list({ resourceType: 'crm_lead', resourceId: lead.id }),
    );
    const converted = audit.find((entry) => entry.action === 'crm_lead.converted');
    expect(converted?.actorId).toBe(dispatcher.userId);
    expect(converted?.metadata).toMatchObject({
      customerId: result.customerId,
      customerCreated: true,
    });
    const created = await withTenant(api.tenantId, (tx) =>
      tx.auditLog.list({ resourceType: 'customer', resourceId: result.customerId }),
    );
    expect(created.map((entry) => entry.action)).toContain('customer.created');
  });

  it('shows the lead on the customer’s CRM summary, to those who may read the CRM', async () => {
    const name = `Summary Co ${randomUUID().slice(0, 6)}`;
    const lead = await newLead({ displayName: name });
    const result = json<Conversion>(
      await convert(owner, lead.id, { expectedVersion: 1, customer: { mode: 'new', name } }),
    );

    const summary = await api.call(await token(viewer), {
      method: 'GET',
      url: `/v1/customers/${result.customerId}/crm`,
    });
    expect(summary.statusCode, summary.body).toBe(200);
    expect(json<{ leads: LeadBody[] }>(summary).leads.map((item) => item.id)).toEqual([lead.id]);

    // An engineer reads the customer for their jobs, but not its CRM data.
    const hidden = await api.call(await token(engineer), {
      method: 'GET',
      url: `/v1/customers/${result.customerId}/crm`,
    });
    expect(hidden.statusCode).toBe(403);
    expect(code(hidden)).toBe('forbidden');
  });
});

describe('converting exactly once', () => {
  it('needs an idempotency key', async () => {
    const lead = await newLead({ displayName: 'Keyless' });
    const response = await convert(
      owner,
      lead.id,
      { expectedVersion: 1, customer: { mode: 'new', name: 'Keyless' } },
      null,
    );
    expect(response.statusCode).toBe(400);
    expect(code(response)).toBe('idempotency_key_required');
  });

  it('answers a retried request with the first answer and creates nothing more', async () => {
    const name = `Replay Ltd ${randomUUID().slice(0, 6)}`;
    const lead = await newLead({ displayName: name });
    const key = randomUUID();
    const payload = { expectedVersion: 1, customer: { mode: 'new', name } };

    const first = await convert(owner, lead.id, payload, key);
    const again = await convert(owner, lead.id, payload, key);
    expect(first.statusCode, first.body).toBe(201);
    expect(again.statusCode).toBe(201);
    expect(again.headers['idempotent-replay']).toBe('true');
    expect(json<Conversion>(again).customerId).toBe(json<Conversion>(first).customerId);
    expect(await customersNamed(name)).toHaveLength(1);

    const reused = await convert(
      owner,
      lead.id,
      { ...payload, customer: { mode: 'new', name: `${name} 2` } },
      key,
    );
    expect(reused.statusCode).toBe(409);
    expect(code(reused)).toBe('idempotency_key_reused');
  });

  it('refuses a second conversion under a new key', async () => {
    const name = `Twice Ltd ${randomUUID().slice(0, 6)}`;
    const lead = await newLead({ displayName: name });
    expect(
      (await convert(owner, lead.id, { expectedVersion: 1, customer: { mode: 'new', name } }))
        .statusCode,
    ).toBe(201);

    const second = await convert(owner, lead.id, {
      expectedVersion: 2,
      customer: { mode: 'new', name },
    });
    expect(second.statusCode).toBe(409);
    expect(code(second)).toBe('lead_already_converted');
    expect(await customersNamed(name)).toHaveLength(1);

    const edit = await api.call(await token(owner), {
      method: 'PATCH',
      url: `/v1/crm/leads/${lead.id}`,
      payload: { expectedVersion: 2, displayName: 'Renamed' },
    });
    expect(edit.statusCode).toBe(409);
    expect(code(edit)).toBe('lead_already_converted');
  });

  it('creates one customer when two different conversions race', async () => {
    const name = `Race Ltd ${randomUUID().slice(0, 6)}`;
    const lead = await newLead({ displayName: name });
    const [ownerToken, dispatcherToken] = [await token(owner), await token(dispatcher)];

    const responses = await Promise.all([
      convert(ownerToken, lead.id, { expectedVersion: 1, customer: { mode: 'new', name } }),
      convert(dispatcherToken, lead.id, { expectedVersion: 1, customer: { mode: 'new', name } }),
    ]);
    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([201, 409]);
    expect(code(responses.find((response) => response.statusCode === 409)!)).toBe(
      'lead_already_converted',
    );
    expect(await customersNamed(name)).toHaveLength(1);
  });

  it('refuses a conversion made against an older version of the lead', async () => {
    const lead = await newLead({ displayName: 'Moving Target' });
    await api.call(await token(owner), {
      method: 'PATCH',
      url: `/v1/crm/leads/${lead.id}`,
      payload: { expectedVersion: 1, status: 'qualified' },
    });
    const response = await convert(owner, lead.id, {
      expectedVersion: 1,
      customer: { mode: 'new', name: 'Moving Target' },
    });
    expect(response.statusCode).toBe(409);
    expect(code(response)).toBe('version_conflict');
    expect(await customersNamed('Moving Target')).toHaveLength(0);
  });

  it('refuses a lead that was ruled out or archived', async () => {
    const ruledOut = await newLead({ displayName: 'Ruled Out', status: 'unqualified' });
    const response = await convert(owner, ruledOut.id, {
      expectedVersion: 1,
      customer: { mode: 'new', name: 'Ruled Out' },
    });
    expect(response.statusCode).toBe(422);
    expect(code(response)).toBe('lead_not_convertible');

    const shelved = await newLead({ displayName: 'Shelved' });
    await api.call(await token(owner), {
      method: 'PATCH',
      url: `/v1/crm/leads/${shelved.id}`,
      payload: { expectedVersion: 1, archived: true },
    });
    const archived = await convert(owner, shelved.id, {
      expectedVersion: 2,
      customer: { mode: 'new', name: 'Shelved' },
    });
    expect(archived.statusCode).toBe(422);
    expect(code(archived)).toBe('lead_not_convertible');
  });
});

describe('converting into an existing customer', () => {
  it('suggests customers by email, phone or name, and links one without changing it', async () => {
    const tag = randomUUID().slice(0, 6);
    const existing = await newCustomer({
      name: `Delta Facilities ${tag}`,
      email: `Accounts-${tag}@Delta.example`,
    });
    const digits = String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
    const byPhone = await newCustomer({
      name: `Phone Only ${tag}`,
      phone: `+20 1${digits.slice(0, 3)} ${digits.slice(3)}`,
    });
    const before = await withTenant(api.tenantId, (tx) => tx.customers.find(existing.id));
    const lead = await newLead({
      displayName: 'Hany Fouad',
      email: `accounts-${tag}@delta.EXAMPLE`,
      companyName: `delta facilities ${tag}`,
      phone: `(201) ${digits.slice(0, 3)}-${digits.slice(3)}`,
    });

    const matches = await api.call(await token(dispatcher), {
      method: 'GET',
      url: `/v1/crm/leads/${lead.id}/matches`,
    });
    expect(matches.statusCode, matches.body).toBe(200);
    const items = json<{ items: { customer: { id: string }; reasons: string[] }[] }>(matches).items;
    expect(items.find((item) => item.customer.id === existing.id)?.reasons).toEqual([
      'email',
      'name',
    ]);
    expect(items.find((item) => item.customer.id === byPhone.id)?.reasons).toEqual(['phone']);

    const response = await convert(dispatcher, lead.id, {
      expectedVersion: 1,
      customer: { mode: 'existing', customerId: existing.id },
      contact: { mode: 'new', name: 'Hany Fouad', email: `hany-${tag}@delta.example` },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(json<Conversion>(response)).toMatchObject({
      customerId: existing.id,
      customerCreated: false,
      contactCreated: true,
    });

    const after = await withTenant(api.tenantId, (tx) => tx.customers.find(existing.id));
    expect(after).toEqual(before);
  });

  it('keeps an existing contact rather than adding a duplicate', async () => {
    const tag = randomUUID().slice(0, 6);
    const customer = await newCustomer({ name: `Contacts Co ${tag}` });
    const contact = json<{ id: string }>(
      await api.call(await token(owner), {
        method: 'POST',
        url: `/v1/customers/${customer.id}/contacts`,
        payload: { name: 'Sara Nabil', email: `sara-${tag}@contacts.example` },
      }),
    );

    const lead = await newLead({ displayName: 'Sara Nabil' });
    const duplicate = await convert(owner, lead.id, {
      expectedVersion: 1,
      customer: { mode: 'existing', customerId: customer.id },
      contact: { mode: 'new', name: 'Sara N.', email: `SARA-${tag}@contacts.example` },
    });
    expect(duplicate.statusCode).toBe(409);
    expect(code(duplicate)).toBe('duplicate_contact');
    expect(
      json<{ error: { details: { params?: Record<string, string> }[] } }>(duplicate).error
        .details[0]?.params?.contactId,
    ).toBe(contact.id);

    const kept = await convert(owner, lead.id, {
      expectedVersion: 1,
      customer: { mode: 'existing', customerId: customer.id },
      contact: { mode: 'existing', contactId: contact.id },
    });
    expect(kept.statusCode, kept.body).toBe(201);
    expect(json<Conversion>(kept)).toMatchObject({ contactId: contact.id, contactCreated: false });
  });

  it('refuses a contact that belongs to another customer, and a closed customer', async () => {
    const tag = randomUUID().slice(0, 6);
    const mine = await newCustomer({ name: `Mine ${tag}` });
    const other = await newCustomer({ name: `Other ${tag}` });
    const theirContact = json<{ id: string }>(
      await api.call(await token(owner), {
        method: 'POST',
        url: `/v1/customers/${other.id}/contacts`,
        payload: { name: 'Not Mine' },
      }),
    );
    const lead = await newLead({ displayName: `Picky ${tag}` });

    const wrongContact = await convert(owner, lead.id, {
      expectedVersion: 1,
      customer: { mode: 'existing', customerId: mine.id },
      contact: { mode: 'existing', contactId: theirContact.id },
    });
    expect(wrongContact.statusCode).toBe(422);
    expect(code(wrongContact)).toBe('contact_not_found');

    const closed = await newCustomer({ name: `Closed ${tag}`, status: 'closed' });
    const toClosed = await convert(owner, lead.id, {
      expectedVersion: 1,
      customer: { mode: 'existing', customerId: closed.id },
    });
    expect(toClosed.statusCode).toBe(422);
    expect(code(toClosed)).toBe('customer_closed');

    const untouched = await withTenant(api.tenantId, (tx) => tx.crmLeads.find(lead.id));
    expect(untouched).toMatchObject({ status: 'new', version: 1 });
  });

  it('treats another company’s customer as one that does not exist', async () => {
    const elsewhere = await getPlatformDataSource().tenants.create({
      slug: `conv-other-${randomUUID().slice(0, 8)}`,
      name: 'Elsewhere Ltd',
    });
    const theirs = await withTenant(elsewhere.id, (tx) =>
      tx.customers.create({ name: 'Elsewhere Customer' }, randomUUID()),
    );
    const lead = await newLead({ displayName: 'Cross Company' });

    const response = await convert(owner, lead.id, {
      expectedVersion: 1,
      customer: { mode: 'existing', customerId: theirs.id },
    });
    expect(response.statusCode).toBe(404);
    expect(code(response)).toBe('customer_not_found');

    const summary = await api.call(await token(owner), {
      method: 'GET',
      url: `/v1/customers/${theirs.id}/crm`,
    });
    expect(summary.statusCode).toBe(404);

    const unchanged = await withTenant(api.tenantId, (tx) => tx.crmLeads.find(lead.id));
    expect(unchanged).toMatchObject({ status: 'new', convertedCustomerId: null });
  });
});

describe('who may convert', () => {
  it('refuses a viewer, who may read leads but not convert them', async () => {
    const lead = await newLead({ displayName: 'Viewer Attempt' });
    const auth = await token(viewer);
    const matches = await api.call(auth, {
      method: 'GET',
      url: `/v1/crm/leads/${lead.id}/matches`,
    });
    expect(matches.statusCode).toBe(403);

    const response = await convert(auth, lead.id, {
      expectedVersion: 1,
      customer: { mode: 'new', name: 'Viewer Attempt' },
    });
    expect(response.statusCode).toBe(403);
    expect(code(response)).toBe('forbidden');
    expect(await customersNamed('Viewer Attempt')).toHaveLength(0);
  });
});
