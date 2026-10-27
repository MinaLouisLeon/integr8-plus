import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Contract, ContractDetail } from '../api.js';
import { accessibilityViolations, fakeApi, renderScreen } from '../testing/render.js';
import { ContractScreen, ContractsScreen } from './contracts-screen.js';
import { CustomerContractsSection } from './customer-contracts.js';

const CONTRACT = '00000000-0000-4000-8000-000000000c01';
const OTHER = '00000000-0000-4000-8000-000000000c02';
const RENEWED = '00000000-0000-4000-8000-000000000c03';
const RIVERSIDE = { id: '00000000-0000-4000-8000-000000000301', name: 'Riverside Housing' };
const HARBOUR = { id: '00000000-0000-4000-8000-000000000302', name: 'Harbour Hotels' };
const BLOCK_A = '00000000-0000-4000-8000-000000000201';
const BLOCK_B = '00000000-0000-4000-8000-000000000202';
const BOILER = '00000000-0000-4000-8000-000000000601';
const JOB = '00000000-0000-4000-8000-000000000101';

function contract(overrides: Partial<Contract> = {}): Contract {
  return {
    id: CONTRACT,
    reference: 'CT-000012',
    title: 'Annual servicing',
    customer: RIVERSIDE,
    startsOn: '2026-01-01',
    endsOn: '2026-12-31',
    value: '12000.00',
    notes: null,
    renewalNoticeDays: 60,
    sites: null,
    assets: null,
    jobTypes: [{ id: BOILER, name: 'Boiler service' }],
    includedCallouts: 4,
    calloutsUsed: 1,
    standing: 'ending',
    renewedFrom: null,
    renewedBy: null,
    cancelledOn: null,
    cancelReason: null,
    version: 3,
    createdAt: '2026-01-01T09:00:00.000Z',
    updatedAt: '2026-01-01T09:00:00.000Z',
    ...overrides,
  };
}

const ENDED = contract({
  id: OTHER,
  reference: 'CT-000003',
  title: 'Hotel plant',
  customer: HARBOUR,
  startsOn: '2025-01-01',
  endsOn: '2025-12-31',
  includedCallouts: null,
  calloutsUsed: 0,
  standing: 'ended',
});

function list(manage: boolean, items: Contract[] = [contract(), ENDED]) {
  return { items, defaults: { renewalNoticeDays: 60 }, can: { manage } };
}

function detail(manage: boolean): ContractDetail {
  return {
    contract: contract(),
    contractYear: { from: '2026-01-01', to: '2026-12-31' },
    plans: [
      {
        id: '00000000-0000-4000-8000-000000000d01',
        title: 'Quarterly service',
        asset: { id: '00000000-0000-4000-8000-000000000e01', name: 'Boiler 1' },
        status: 'active',
        nextDueOn: '2027-01-01',
      },
    ],
    jobs: [
      {
        id: JOB,
        reference: 45,
        referenceLabel: 'WO-000045',
        title: 'Boiler breakdown',
        state: 'complete',
        priority: 'high',
        dueFrom: null,
        dueBy: null,
        customer: RIVERSIDE,
        site: { id: BLOCK_A, name: 'Block A', city: 'Leeds' },
        jobType: { id: BOILER, name: 'Boiler service', code: 'BOILER' },
        crew: [],
        revision: 3,
        stateChangedAt: '2026-10-01T09:00:00.000Z',
        createdAt: '2026-10-01T09:00:00.000Z',
        updatedAt: '2026-10-01T09:00:00.000Z',
        coverage: {
          status: 'covered',
          reason: 'contract',
          contract: { id: CONTRACT, reference: 'CT-000012', title: 'Annual servicing' },
        },
        deadline: null,
        maintenance: false,
      },
    ],
    can: { manage },
  };
}

describe('service contracts', { timeout: 20_000 }, () => {
  it('lists contracts with their standing, ending and ended ones marked, read-only for a viewer', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({ 'GET /v1/contracts': () => ({ body: list(false) }) });
    const { container } = renderScreen(<ContractsScreen />, client);

    const table = await screen.findByRole('table', { name: 'Service contracts' });
    expect(screen.getByText('You can see contracts but not change them.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a contract' })).not.toBeInTheDocument();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('Ending soon');
    expect(rows[0]).toHaveTextContent('1 of 4 used');
    expect(rows[1]).toHaveTextContent('Ended');
    expect(rows[1]).toHaveTextContent('No limit');
    expect(
      within(rows[0]!).getByRole('link', { name: 'CT-000012 Annual servicing' }),
    ).toHaveAttribute('href', `/contracts/${CONTRACT}`);
    expect(await accessibilityViolations(container)).toEqual([]);

    // The customer filter offers the customers listed.
    await user.selectOptions(screen.getByLabelText('Customer'), HARBOUR.id);
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(1);
    expect(within(table).getByText('Hotel plant')).toBeInTheDocument();

    // Search and cancelled ones go to the server.
    await user.type(screen.getByLabelText('Search by title or reference'), 'CT-12');
    await user.click(screen.getByRole('checkbox', { name: 'Show cancelled contracts' }));
    await waitFor(() => {
      const last = calls.filter((call) => call.path === '/v1/contracts').at(-1)!;
      expect(last.query.get('q')).toBe('CT-12');
      expect(last.query.get('includeCancelled')).toBe('true');
    });
  });

  it('shows what a contract covers, its call-outs, plans and jobs', async () => {
    const { client } = fakeApi({
      'GET /v1/contracts/:id': () => ({ body: detail(false) }),
    });
    const { container } = renderScreen(<ContractScreen contractId={CONTRACT} />, client);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Annual servicing' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/ends on .* and has not been renewed yet/u)).toBeInTheDocument();
    const covers = screen.getByRole('region', { name: 'What it covers' });
    expect(within(covers).getByText('All the customer’s sites')).toBeInTheDocument();
    expect(within(covers).getByText('All assets at the covered sites')).toBeInTheDocument();
    expect(within(covers).getByText('Boiler service')).toBeInTheDocument();
    const details = screen.getByRole('region', { name: 'Details' });
    expect(within(details).getByText('1 of 4 used')).toBeInTheDocument();
    expect(within(details).getByText(/^This contract year: /u)).toBeInTheDocument();
    expect(within(details).getByText(/^Contract managers are emailed on /u)).toBeInTheDocument();

    expect(screen.getByText('Quarterly service')).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'WO-000045 · Boiler breakdown' })).toHaveAttribute(
      'href',
      `/work-orders/${JOB}`,
    );
    expect(screen.getByText('Covered · CT-000012')).toBeInTheDocument();
    // A viewer changes nothing.
    expect(screen.queryByRole('button', { name: 'Renew' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit contract' })).not.toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('adds a contract for a customer, covering chosen sites only', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/contracts': () => ({ body: list(true, []) }),
      'GET /v1/customers': () => ({
        body: {
          items: [
            {
              ...RIVERSIDE,
              accountNumber: 'RH-001',
              email: null,
              phone: null,
              status: 'active',
              tags: [],
              siteCount: 2,
              createdAt: '2026-01-01T09:00:00.000Z',
              updatedAt: '2026-01-01T09:00:00.000Z',
            },
          ],
          nextCursor: null,
        },
      }),
      'GET /v1/sites': () => ({
        body: {
          items: [
            { id: BLOCK_A, name: 'Block A', customerName: RIVERSIDE.name },
            { id: BLOCK_B, name: 'Block B', customerName: RIVERSIDE.name },
          ],
          nextCursor: null,
        },
      }),
      'POST /v1/contracts': () => ({ status: 201, body: contract({ id: RENEWED }) }),
    });
    const { navigate } = renderScreen(<ContractsScreen />, client);

    expect(await screen.findByText('No contracts yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add a contract' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a contract' });
    const save = within(dialog).getByRole('button', { name: 'Save contract' });
    expect(save).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Customer'), 'River');
    await user.click(within(dialog).getByRole('button', { name: 'Search' }));
    await user.click(await within(dialog).findByRole('button', { name: /Riverside Housing/u }));

    await user.type(within(dialog).getByLabelText('Title'), 'Annual servicing');
    await user.type(within(dialog).getByLabelText('Starts on'), '2026-01-01');
    await user.type(within(dialog).getByLabelText('Ends on'), '2026-12-31');
    await user.type(within(dialog).getByLabelText('Included call-outs a year'), '4');
    expect(within(dialog).getByLabelText('Remind this many days before the end')).toHaveValue(60);

    const sites = within(dialog).getByRole('group', { name: 'Sites' });
    await user.click(within(sites).getByRole('radio', { name: 'Only these' }));
    expect(within(sites).getByText('Choose at least one, or cover all.')).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.click(await within(sites).findByRole('checkbox', { name: 'Block B' }));
    await user.click(save);

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      customerId: RIVERSIDE.id,
      title: 'Annual servicing',
      startsOn: '2026-01-01',
      endsOn: '2026-12-31',
      value: null,
      notes: null,
      renewalNoticeDays: 60,
      siteIds: [BLOCK_B],
      assetIds: null,
      jobTypeIds: null,
      includedCallouts: 4,
    });
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/contracts/${RENEWED}`));
  });

  it('renews a contract for the next term, and cancels one only with a reason', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/contracts/:id': () => ({ body: detail(true) }),
      'POST /v1/contracts/:id/renew': () => ({
        status: 201,
        body: contract({ id: RENEWED, reference: 'CT-000013', standing: 'upcoming' }),
      }),
      'POST /v1/contracts/:id/cancel': () => ({
        body: contract({ standing: 'cancelled', version: 4 }),
      }),
    });
    const { navigate } = renderScreen(<ContractScreen contractId={CONTRACT} />, client);

    await user.click(await screen.findByRole('button', { name: 'Renew' }));
    const renew = await screen.findByRole('dialog', { name: 'Renew CT-000012' });
    expect(within(renew).getByLabelText('Starts on')).toHaveValue('2027-01-01');
    expect(within(renew).getByLabelText('Ends on')).toHaveValue('2027-12-31');
    expect(within(renew).getByLabelText('Value')).toHaveValue('12000.00');
    await user.click(within(renew).getByRole('button', { name: 'Renew contract' }));
    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith('/renew'))?.body).toEqual({
        expectedVersion: 3,
        title: 'Annual servicing',
        startsOn: '2027-01-01',
        endsOn: '2027-12-31',
        value: '12000.00',
      }),
    );
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/contracts/${RENEWED}`));

    await user.click(screen.getByRole('button', { name: 'Cancel contract' }));
    const cancel = await screen.findByRole('dialog', { name: 'Cancel CT-000012' });
    const confirm = within(cancel).getByRole('button', { name: 'Cancel it' });
    expect(confirm).toBeDisabled();
    await user.type(within(cancel).getByLabelText('Reason'), 'Customer sold the building');
    await user.click(confirm);
    await waitFor(() => expect(calls.some((call) => call.path.endsWith('/cancel'))).toBe(true));
    expect(calls.find((call) => call.path.endsWith('/cancel'))!.body).toEqual({
      expectedVersion: 3,
      cancelledOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u) as unknown,
      reason: 'Customer sold the building',
    });
  });

  it('lists a customer’s contracts on the customer, with a way to add one', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/contracts': () => ({ body: list(true, [contract()]) }),
    });
    renderScreen(
      <CustomerContractsSection customerId={RIVERSIDE.id} customerName={RIVERSIDE.name} />,
      client,
      { permissions: ['contract.read', 'contract.manage'] },
    );

    const section = await screen.findByRole('region', { name: 'Service contracts' });
    expect(await within(section).findByRole('link', { name: /CT-000012/u })).toHaveAttribute(
      'href',
      `/contracts/${CONTRACT}`,
    );
    expect(within(section).getByText('Ending soon')).toBeInTheDocument();
    const call = calls.find((entry) => entry.path === '/v1/contracts')!;
    expect(call.query.get('customerId')).toBe(RIVERSIDE.id);
    expect(call.query.get('includeCancelled')).toBe('true');

    await user.click(within(section).getByRole('button', { name: 'Add a contract' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a contract' });
    // The customer is the one on screen, not chosen again.
    expect(within(dialog).getByText(RIVERSIDE.name)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();
  });

  it('shows nothing on the customer to someone who may not read contracts', () => {
    const { client, calls } = fakeApi({});
    const { container } = renderScreen(
      <CustomerContractsSection customerId={RIVERSIDE.id} customerName={RIVERSIDE.name} />,
      client,
      { permissions: ['customer.read'] },
    );
    expect(container).toBeEmptyDOMElement();
    expect(calls).toHaveLength(0);
  });

  it('reads in Arabic', async () => {
    const { client } = fakeApi({ 'GET /v1/contracts': () => ({ body: list(false) }) });
    renderScreen(<ContractsScreen />, client, { locale: 'ar' });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'عقود الخدمة' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('ينتهي قريبًا')).toBeInTheDocument();
    expect(screen.getByText('استُخدم 1 من 4')).toBeInTheDocument();
  });
});
