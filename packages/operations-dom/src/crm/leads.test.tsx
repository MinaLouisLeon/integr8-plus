import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Lead, LeadDetail } from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { changedLeadFields, emptyLead, formatAmount, leadDraft, toLeadBody } from './lead-parts.js';
import { LeadListScreen } from './lead-list.js';
import { LeadScreen } from './lead-screen.js';

const LEAD = '00000000-0000-4000-8000-000000000901';
const CUSTOMER = '00000000-0000-4000-8000-000000000301';
const DEE = {
  userId: '00000000-0000-4000-8000-000000000401',
  email: 'd@x.example',
  displayName: 'Dee Dispatcher',
  role: 'dispatcher' as const,
  status: 'active' as const,
  createdAt: '2026-01-01T09:00:00.000Z',
};

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: LEAD,
    displayName: 'Nour Hassan',
    companyName: 'Delta Facilities',
    email: 'nour@delta.example',
    phone: '+20 100 000 0000',
    source: 'referral',
    status: 'new',
    assignedTo: DEE.userId,
    estimatedValue: '1250.5',
    currencyCode: 'EGP',
    notes: null,
    unqualifiedReason: null,
    convertedCustomerId: null,
    convertedContactId: null,
    convertedAt: null,
    version: 3,
    createdBy: DEE.userId,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

function me(permissions: string[]) {
  return {
    body: {
      userId: DEE.userId,
      tenantId: CUSTOMER,
      email: DEE.email,
      displayName: DEE.displayName,
      role: 'dispatcher',
      permissions,
    },
  };
}

const members = () => ({ body: { items: [DEE], nextCursor: null } });

describe('lead form helpers', () => {
  it('sends empty fields as null and upper-cases the currency', () => {
    expect(toLeadBody({ ...emptyLead, displayName: ' Nour ', currencyCode: 'egp' })).toMatchObject({
      displayName: 'Nour',
      companyName: null,
      email: null,
      estimatedValue: null,
      currencyCode: 'EGP',
      unqualifiedReason: null,
    });
  });

  it('sends only what changed', () => {
    const before = leadDraft(lead());
    expect(changedLeadFields(before, { ...before, notes: 'Call back Sunday' })).toEqual({
      notes: 'Call back Sunday',
    });
    expect(changedLeadFields(before, before)).toEqual({});
  });

  it('formats an amount without turning it into a float', () => {
    expect(formatAmount('12345678901234.5678', null, 'en')).toBe('12,345,678,901,234.5678');
    expect(formatAmount('1250.5', 'EGP', 'en')).toContain('1,250.5');
  });
});

// Dialogs typed into key by key, and axe: slow when the whole workspace is testing at once.
describe('the lead list', { timeout: 20_000 }, () => {
  it('lists leads, filters them and adds one with an idempotency key', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': () => me(['crm.read', 'crm.lead.manage']),
      'GET /v1/members': members,
      'GET /v1/crm/leads': () => ({ body: { items: [lead()], nextCursor: null } }),
      'POST /v1/crm/leads': (call) => ({
        status: 201,
        body: lead({ ...(call.body as Partial<Lead>), id: '00000000-0000-4000-8000-000000000902' }),
      }),
    });
    const { navigate, container } = renderScreen(<LeadListScreen />, client);

    const row = await screen.findByRole('link', { name: 'Nour Hassan' });
    expect(row).toHaveAttribute('href', `/crm/leads/${LEAD}`);
    expect(screen.getByText('Delta Facilities · Referral · Dee Dispatcher')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    const filters = screen.getByRole('form', { name: 'Filter leads' });
    await user.selectOptions(within(filters).getByLabelText('Status'), 'qualified');
    await user.selectOptions(within(filters).getByLabelText('Assigned to'), 'none');
    await user.click(within(filters).getByRole('button', { name: 'Apply' }));
    await waitFor(() => {
      const last = calls.filter((call) => call.path === '/v1/crm/leads').at(-1)!;
      expect(last.query.get('status')).toBe('qualified');
      expect(last.query.get('assignedTo')).toBe('none');
    });

    await user.click(screen.getByRole('button', { name: 'New lead' }));
    const dialog = await screen.findByRole('dialog', { name: 'New lead' });
    await user.type(within(dialog).getByLabelText('Name'), 'Omar Said');
    await user.type(within(dialog).getByLabelText('Estimated value'), '900.25');
    await user.click(within(dialog).getByRole('button', { name: 'Add lead' }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/crm/leads/00000000-0000-4000-8000-000000000902'),
    );
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.body).toMatchObject({
      displayName: 'Omar Said',
      estimatedValue: '900.25',
      currencyCode: null,
      status: 'new',
    });
  });

  it('offers no new lead to someone who may only read', async () => {
    const { client } = fakeApi({
      'GET /v1/me': () => me(['crm.read']),
      'GET /v1/members': members,
      'GET /v1/crm/leads': () => ({ body: { items: [], nextCursor: null } }),
    });
    renderScreen(<LeadListScreen />, client);

    expect(
      await screen.findByText('No leads yet. Add the first prospect you are talking to.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New lead' })).not.toBeInTheDocument();
  });
});

describe('a lead', { timeout: 20_000 }, () => {
  const detailOf = (overrides: Partial<Lead> = {}, edit = true): LeadDetail => ({
    lead: lead(overrides),
    can: { edit, convert: edit },
  });

  it('saves only the changed fields with the version it was read at', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/members': members,
      'GET /v1/crm/leads/:id': () => ({ body: detailOf() }),
      'PATCH /v1/crm/leads/:id': (call) => ({
        body: lead({ ...(call.body as Partial<Lead>), version: 4 }),
      }),
    });
    const { container } = renderScreen(<LeadScreen leadId={LEAD} />, client);

    expect(await screen.findByRole('heading', { name: 'Nour Hassan' })).toBeInTheDocument();
    expect(await screen.findByText('Dee Dispatcher')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit' });
    await user.type(within(form).getByLabelText('Notes'), 'Wants a quote for three sites');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({
      expectedVersion: 3,
      notes: 'Wants a quote for three sites',
    });
  });

  it('asks for a reload when somebody else changed the lead first', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/members': members,
      'GET /v1/crm/leads/:id': () => ({ body: detailOf() }),
      'PATCH /v1/crm/leads/:id': () => apiError(409, 'version_conflict', 'Changed'),
    });
    renderScreen(<LeadScreen leadId={LEAD} />, client);

    await user.selectOptions(await screen.findByLabelText('Status'), 'contacted');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Somebody changed this lead');
    expect(within(alert).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('shows a converted lead read-only with a way to its customer', async () => {
    const { client } = fakeApi({
      'GET /v1/members': members,
      'GET /v1/crm/leads/:id': () => ({
        body: detailOf({ status: 'converted', convertedCustomerId: CUSTOMER }),
      }),
    });
    renderScreen(<LeadScreen leadId={LEAD} />, client);

    expect(await screen.findByRole('link', { name: 'Open the customer' })).toHaveAttribute(
      'href',
      `/customers/${CUSTOMER}`,
    );
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Status')).not.toBeInTheDocument();
  });

  it('offers nothing to change to someone who may only read', async () => {
    const { client } = fakeApi({
      'GET /v1/members': members,
      'GET /v1/crm/leads/:id': () => ({ body: detailOf({}, false) }),
    });
    renderScreen(<LeadScreen leadId={LEAD} />, client);

    expect(await screen.findByRole('heading', { name: 'Nour Hassan' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });
});
