import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Customer, CustomerDetail, Lead, LeadDetail } from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { CustomerCrmSection } from './customer-crm.js';
import { LeadConvertScreen } from './lead-convert.js';
import { LeadScreen } from './lead-screen.js';

const LEAD = '00000000-0000-4000-8000-000000000901';
const CUSTOMER = '00000000-0000-4000-8000-000000000301';
const CONTACT = '00000000-0000-4000-8000-000000000311';
const NEW_CUSTOMER = '00000000-0000-4000-8000-000000000302';
const USER = '00000000-0000-4000-8000-000000000401';

function lead(overrides: Partial<Lead> = {}): Lead {
  return {
    id: LEAD,
    displayName: 'Hany Fouad',
    companyName: 'Delta Facilities',
    email: 'hany@delta.example',
    phone: null,
    source: 'referral',
    status: 'qualified',
    assignedTo: null,
    estimatedValue: null,
    currencyCode: null,
    notes: null,
    unqualifiedReason: null,
    convertedCustomerId: null,
    convertedContactId: null,
    convertedAt: null,
    version: 2,
    createdBy: USER,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

const detailOf = (overrides: Partial<Lead> = {}, convert = true): LeadDetail => ({
  lead: lead(overrides),
  can: { edit: true, convert },
});

const delta: Customer = {
  id: CUSTOMER,
  name: 'Delta Facilities',
  accountNumber: 'DF-001',
  status: 'active',
  email: 'accounts@delta.example',
  phone: null,
  address: {
    line1: null,
    line2: null,
    city: null,
    region: null,
    postcode: null,
    countryCode: null,
  },
  tags: [],
  notes: null,
  createdAt: '2026-01-01T09:00:00.000Z',
  updatedAt: '2026-01-01T09:00:00.000Z',
};

const deltaDetail = {
  customer: delta,
  contacts: [
    {
      id: CONTACT,
      name: 'Sara Nabil',
      jobTitle: 'Accounts',
      email: 'sara@delta.example',
      phone: null,
      isPrimary: true,
      notes: null,
      archived: false,
    },
  ],
  sites: [],
  attachments: [],
  recentWorkOrders: [],
  can: { edit: true, createWorkOrder: true },
} satisfies CustomerDetail;

const conversion = (customerId: string, contactId: string | null, created: boolean) => ({
  status: 201,
  body: {
    lead: lead({ status: 'converted', convertedCustomerId: customerId, version: 3 }),
    customerId,
    contactId,
    customerCreated: created,
    contactCreated: false,
  },
});

describe('converting a lead', { timeout: 20_000 }, () => {
  it('links a suggested customer and keeps one of its contacts, after a review', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/crm/leads/:id': () => ({ body: detailOf() }),
      'GET /v1/crm/leads/:id/matches': () => ({
        body: { items: [{ customer: delta, reasons: ['email', 'name'] }] },
      }),
      'GET /v1/customers/:id': () => ({ body: deltaDetail }),
      'POST /v1/crm/leads/:id/convert': () => conversion(CUSTOMER, CONTACT, false),
    });
    const { navigate, container } = renderScreen(<LeadConvertScreen leadId={LEAD} />, client);

    expect(await screen.findByRole('heading', { name: 'Convert Hany Fouad' })).toBeInTheDocument();
    const next = screen.getByRole('button', { name: 'Next' });
    expect(next).toBeDisabled();
    await user.click(
      await screen.findByRole('radio', { name: /Delta Facilities.*same email, same name/u }),
    );
    expect(await accessibilityViolations(container)).toEqual([]);
    await user.click(next);

    await user.click(await screen.findByRole('radio', { name: /Keep Sara Nabil/u }));
    await user.click(screen.getByRole('button', { name: 'Next' }));

    const review = screen.getByRole('region', { name: 'Check before converting' });
    expect(review).toHaveTextContent('joins the existing customer Delta Facilities');
    expect(review).toHaveTextContent('Sara Nabil stays the contact.');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    await user.click(within(review).getByRole('button', { name: 'Convert' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/customers/${CUSTOMER}`));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      expectedVersion: 2,
      customer: { mode: 'existing', customerId: CUSTOMER },
      contact: { mode: 'existing', contactId: CONTACT },
    });
  });

  it('adds a new customer filled in from the lead, with the lead as its contact', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/crm/leads/:id': () => ({ body: detailOf() }),
      'GET /v1/crm/leads/:id/matches': () => ({ body: { items: [] } }),
      'POST /v1/crm/leads/:id/convert': () => conversion(NEW_CUSTOMER, null, true),
    });
    const { navigate } = renderScreen(<LeadConvertScreen leadId={LEAD} />, client);

    expect(
      await screen.findByText('No existing customer looks like this lead.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Add a new customer/u }));
    expect(screen.getByLabelText('Customer name')).toHaveValue('Delta Facilities');
    await user.type(screen.getByLabelText('Account number'), 'DF-900');
    await user.click(screen.getByRole('button', { name: 'Next' }));

    // A lead from a company is suggested as the new customer's contact.
    expect(screen.getByRole('radio', { name: /Add the lead as a new contact/u })).toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('region', { name: 'Check before converting' })).toHaveTextContent(
      'A new customer, Delta Facilities, is added.',
    );
    await user.click(screen.getByRole('button', { name: 'Convert' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/customers/${NEW_CUSTOMER}`));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      expectedVersion: 2,
      customer: {
        mode: 'new',
        name: 'Delta Facilities',
        accountNumber: 'DF-900',
        email: 'hany@delta.example',
        phone: null,
      },
      contact: {
        mode: 'new',
        name: 'Hany Fouad',
        jobTitle: null,
        email: 'hany@delta.example',
        phone: null,
        isPrimary: true,
      },
    });
  });

  it('says why when the server refuses, and stays on the review', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/crm/leads/:id': () => ({ body: detailOf() }),
      'GET /v1/crm/leads/:id/matches': () => ({ body: { items: [] } }),
      'POST /v1/crm/leads/:id/convert': () =>
        apiError(409, 'lead_already_converted', 'This lead has already been converted.'),
    });
    const { navigate } = renderScreen(<LeadConvertScreen leadId={LEAD} />, client);

    await user.click(await screen.findByRole('radio', { name: /Add a new customer/u }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Convert' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This lead has already been converted.',
    );
    expect(navigate).not.toHaveBeenCalled();
  });

  it('offers nothing to convert when the lead is already a customer', async () => {
    const { client } = fakeApi({
      'GET /v1/crm/leads/:id': () => ({
        body: detailOf({ status: 'converted', convertedCustomerId: CUSTOMER }, false),
      }),
    });
    renderScreen(<LeadConvertScreen leadId={LEAD} />, client);

    expect(await screen.findByText('This lead has already been converted.')).toHaveAttribute(
      'role',
      'status',
    );
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
  });

  it('starts from the lead, for those who may convert', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/members': () => ({ body: { items: [], nextCursor: null } }),
      'GET /v1/crm/leads/:id': () => ({ body: detailOf() }),
    });
    const { navigate } = renderScreen(<LeadScreen leadId={LEAD} />, client);

    await user.click(await screen.findByRole('button', { name: 'Convert to customer' }));
    expect(navigate).toHaveBeenCalledWith(`/crm/leads/${LEAD}/convert`);
  });
});

describe('the CRM on a customer', () => {
  const me = (crm: boolean, permissions: string[]) => () => ({
    body: {
      userId: USER,
      tenantId: CUSTOMER,
      email: 'o@x.example',
      displayName: 'Olu',
      role: 'owner',
      permissions,
      features: { crm },
    },
  });

  it('lists the leads that became the customer', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(true, ['crm.read']),
      'GET /v1/customers/:id/crm': () => ({
        body: {
          leads: [
            lead({
              status: 'converted',
              convertedCustomerId: CUSTOMER,
              convertedAt: '2026-10-02T09:00:00.000Z',
            }),
          ],
        },
      }),
    });
    renderScreen(<CustomerCrmSection customerId={CUSTOMER} />, client);

    expect(await screen.findByRole('link', { name: 'Hany Fouad' })).toHaveAttribute(
      'href',
      `/crm/leads/${LEAD}`,
    );
    expect(screen.getByRole('heading', { name: 'CRM' })).toBeInTheDocument();
  });

  it('shows nothing, and asks nothing, without the module or the permission', async () => {
    for (const routes of [me(false, ['crm.read']), me(true, [])]) {
      const { client, calls } = fakeApi({ 'GET /v1/me': routes });
      const { unmount } = renderScreen(<CustomerCrmSection customerId={CUSTOMER} />, client);
      await waitFor(() => expect(calls.some((call) => call.path === '/v1/me')).toBe(true));
      expect(screen.queryByRole('heading', { name: 'CRM' })).not.toBeInTheDocument();
      expect(calls.some((call) => call.path.endsWith('/crm'))).toBe(false);
      unmount();
    }
  });
});
