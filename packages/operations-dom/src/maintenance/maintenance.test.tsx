import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { MaintenanceItem, MaintenancePlan } from '../api.js';
import { accessibilityViolations, fakeApi, renderScreen } from '../testing/render.js';
import { AssetPlansSection } from './asset-plans.js';
import { MaintenanceScreen } from './maintenance-screen.js';

const RIVERSIDE = { id: '00000000-0000-4000-8000-000000000301', name: 'Riverside Housing' };
const HARBOUR = { id: '00000000-0000-4000-8000-000000000302', name: 'Harbour Hotels' };
const BLOCK_A = { id: '00000000-0000-4000-8000-000000000201', name: 'Block A' };
const LOBBY = { id: '00000000-0000-4000-8000-000000000202', name: 'Lobby' };
const BOILER = { id: '00000000-0000-4000-8000-000000000601', name: 'Boiler service' };
const AC = { id: '00000000-0000-4000-8000-000000000602', name: 'AC service' };
const ASSET = {
  id: '00000000-0000-4000-8000-000000000e01',
  name: 'Boiler 1',
  reference: 'AS-000007',
};
const PLAN = '00000000-0000-4000-8000-000000000d01';
const CONTRACT = '00000000-0000-4000-8000-000000000c01';
const JOB = '00000000-0000-4000-8000-000000000101';

function item(
  key: string,
  dueOn: string,
  standing: MaintenanceItem['standing'],
  overrides: Partial<MaintenanceItem> = {},
): MaintenanceItem {
  return {
    key,
    plan: { id: PLAN, title: 'Quarterly service' },
    asset: ASSET,
    customer: RIVERSIDE,
    site: BLOCK_A,
    jobType: BOILER,
    dueOn,
    standing,
    skipReason: null,
    workOrder: null,
    ...overrides,
  };
}

const ITEMS: MaintenanceItem[] = [
  item('a', '2026-11-15', 'upcoming'),
  item('b', '2026-10-01', 'overdue', {
    workOrder: { id: JOB, reference: 'WO-000045', state: 'scheduled', completedAt: null },
  }),
  item('c', '2026-09-20', 'completed', {
    customer: HARBOUR,
    site: LOBBY,
    jobType: AC,
    plan: { id: PLAN, title: 'Chiller check' },
    workOrder: {
      id: '00000000-0000-4000-8000-000000000102',
      reference: 'WO-000040',
      state: 'complete',
      completedAt: '2026-09-21T10:00:00.000Z',
    },
  }),
  item('d', '2026-10-20', 'created', {
    customer: HARBOUR,
    site: LOBBY,
    jobType: AC,
    plan: { id: PLAN, title: 'Chiller check' },
    workOrder: {
      id: '00000000-0000-4000-8000-000000000103',
      reference: 'WO-000050',
      state: 'scheduled',
      completedAt: null,
    },
  }),
];

function plan(overrides: Partial<MaintenancePlan> = {}): MaintenancePlan {
  return {
    id: PLAN,
    title: 'Quarterly service',
    instructions: null,
    asset: { ...ASSET, status: 'active' },
    customer: RIVERSIDE,
    site: BLOCK_A,
    jobType: BOILER,
    contract: { id: CONTRACT, reference: 'CT-000012', title: 'Annual servicing' },
    intervalCount: 3,
    intervalUnit: 'month',
    counting: 'calendar',
    startsOn: '2026-01-01',
    endsOn: null,
    windowBeforeDays: 7,
    windowAfterDays: 7,
    leadDays: 30,
    canShare: true,
    status: 'active',
    nextDueOn: '2027-01-01',
    upcoming: ['2027-01-01', '2027-04-01'],
    last: {
      dueOn: '2026-10-01',
      workOrder: { id: JOB, reference: 'WO-000045', state: 'scheduled' },
    },
    version: 2,
    createdAt: '2026-01-01T09:00:00.000Z',
    endedAt: null,
    failure: null,
    ...overrides,
  };
}

const ASSET_ON_SCREEN = {
  id: ASSET.id,
  status: 'active' as const,
  customer: RIVERSIDE,
};

describe('maintenance', { timeout: 20_000 }, () => {
  it('lists what is due a month at a time, overdue marked, and filters it', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/maintenance': () => ({
        body: { items: ITEMS, from: '2026-09-01', to: '2026-12-31', today: '2026-10-27' },
      }),
    });
    const { container } = renderScreen(<MaintenanceScreen />, client);

    const table = await screen.findByRole('table', { name: 'Maintenance' });
    const groups = within(table)
      .getAllByRole('rowheader')
      .map((header) => header.textContent);
    expect(groups).toEqual(['September 2026', 'October 2026', 'November 2026']);
    const rows = within(table)
      .getAllByRole('row')
      .filter((row) => within(row).queryAllByRole('cell').length > 0);
    // Earliest first.
    expect(rows.map((row) => within(row).getAllByRole('cell')[0]!.textContent)).toEqual([
      'September 20, 2026',
      'October 1, 2026',
      'October 20, 2026',
      'November 15, 2026',
    ]);
    expect(rows[1]).toHaveTextContent('Overdue');
    expect(within(rows[1]!).getByRole('link', { name: 'WO-000045' })).toHaveAttribute(
      'href',
      `/work-orders/${JOB}`,
    );
    expect(rows[3]).toHaveTextContent('Not made yet');
    expect(within(rows[0]!).getByRole('link', { name: 'AS-000007 Boiler 1' })).toHaveAttribute(
      'href',
      `/assets/${ASSET.id}`,
    );
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.selectOptions(screen.getByLabelText('Customer'), HARBOUR.id);
    expect(
      within(table)
        .getAllByRole('row')
        .filter((row) => within(row).queryAllByRole('cell').length > 0),
    ).toHaveLength(2);
    expect(
      within(screen.getByLabelText('Site'))
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['All sites', 'Lobby']);

    await user.selectOptions(screen.getByLabelText('Customer'), '');
    await user.selectOptions(screen.getByLabelText('Status'), 'overdue');
    const overdue = within(table)
      .getAllByRole('row')
      .filter((row) => within(row).queryAllByRole('cell').length > 0);
    expect(overdue).toHaveLength(1);
    expect(overdue[0]).toHaveTextContent('Quarterly service');

    // The period is the server's.
    const from = screen.getByLabelText('From');
    expect(from).toHaveValue('2026-09-01');
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2027-03-31' } });
    await waitFor(() => {
      const last = calls.filter((call) => call.path === '/v1/maintenance').at(-1)!;
      expect(last.query.get('from')).toBe('2026-09-01');
      expect(last.query.get('to')).toBe('2027-03-31');
    });
  });

  it('shows an asset’s plans, and adds one counted from the last completion', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/maintenance-plans': () => ({
        body: { items: [plan()], defaults: { leadDays: 30, windowDays: 7 }, can: { manage: true } },
      }),
      'GET /v1/job-types': () => ({
        body: {
          items: [
            { ...BOILER, code: 'BOILER', archived: false },
            { ...AC, code: 'AC', archived: false },
          ],
        },
      }),
      'GET /v1/contracts': () => ({
        body: {
          items: [
            {
              id: CONTRACT,
              reference: 'CT-000012',
              title: 'Annual servicing',
              customer: RIVERSIDE,
              startsOn: '2026-01-01',
              endsOn: '2026-12-31',
              value: null,
              notes: null,
              renewalNoticeDays: 60,
              sites: null,
              assets: null,
              jobTypes: null,
              includedCallouts: null,
              calloutsUsed: 0,
              standing: 'active',
              renewedFrom: null,
              renewedBy: null,
              cancelledOn: null,
              cancelReason: null,
              version: 1,
              createdAt: '2026-01-01T09:00:00.000Z',
              updatedAt: '2026-01-01T09:00:00.000Z',
            },
          ],
          defaults: { renewalNoticeDays: 60 },
          can: { manage: false },
        },
      }),
      'POST /v1/maintenance-plans': () => ({ status: 201, body: plan() }),
    });
    const { container } = renderScreen(<AssetPlansSection asset={ASSET_ON_SCREEN} />, client);

    const section = await screen.findByRole('region', { name: 'Maintenance plans' });
    expect(
      await within(section).findByText('Every 3 months, from the start date'),
    ).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: 'CT-000012' })).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: /WO-000045/u })).toHaveAttribute(
      'href',
      `/work-orders/${JOB}`,
    );
    expect(
      within(section).getByText('Can share a job with other plans at the same site.'),
    ).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(within(section).getByRole('button', { name: 'Add a plan' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a plan' });
    await user.type(within(dialog).getByLabelText('Title'), 'Annual inspection');
    await user.selectOptions(
      within(dialog).getByLabelText('Job type'),
      await within(dialog).findByRole('option', { name: 'AC service' }),
    );
    const every = within(dialog).getByLabelText('Every');
    await user.clear(every);
    await user.type(every, '1');
    await user.selectOptions(within(dialog).getByLabelText('Unit'), 'year');
    await user.click(within(dialog).getByRole('radio', { name: 'From the last completion' }));
    const starts = within(dialog).getByLabelText('Starts on');
    await user.clear(starts);
    await user.type(starts, '2026-11-01');
    expect(within(dialog).getByLabelText('Days ahead the job is made')).toHaveValue(30);
    await user.click(within(dialog).getByRole('checkbox', { name: 'Can share a job' }));
    await user.selectOptions(
      within(dialog).getByLabelText('Contract'),
      await within(dialog).findByRole('option', { name: 'CT-000012 · Annual servicing' }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Save plan' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      assetId: ASSET.id,
      title: 'Annual inspection',
      jobTypeId: AC.id,
      contractId: CONTRACT,
      instructions: null,
      intervalCount: 1,
      intervalUnit: 'year',
      counting: 'completion',
      startsOn: '2026-11-01',
      endsOn: null,
      windowBeforeDays: 7,
      windowAfterDays: 7,
      leadDays: 30,
      canShare: false,
    });
  });

  it('pauses a plan, and ends one only after asking', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/maintenance-plans': () => ({
        body: { items: [plan()], defaults: { leadDays: 30, windowDays: 7 }, can: { manage: true } },
      }),
      'POST /v1/maintenance-plans/:id/status': (call) => ({
        body: plan({ status: (call.body as { status: MaintenancePlan['status'] }).status }),
      }),
    });
    renderScreen(<AssetPlansSection asset={ASSET_ON_SCREEN} />, client);

    await user.click(await screen.findByRole('button', { name: 'Pause Quarterly service' }));
    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith('/status'))?.body).toEqual({
        expectedVersion: 2,
        status: 'paused',
      }),
    );

    await user.click(screen.getByRole('button', { name: 'End Quarterly service' }));
    const dialog = await screen.findByRole('dialog', { name: 'End Quarterly service?' });
    expect(calls.filter((call) => call.path.endsWith('/status'))).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'End plan' }));
    await waitFor(() =>
      expect(calls.filter((call) => call.path.endsWith('/status')).at(-1)?.body).toEqual({
        expectedVersion: 2,
        status: 'ended',
      }),
    );
  });

  it('offers nothing to change to someone who only reads assets', async () => {
    const { client } = fakeApi({
      'GET /v1/maintenance-plans': () => ({
        body: {
          items: [plan({ counting: 'completion', intervalCount: 1, intervalUnit: 'year' })],
          defaults: { leadDays: 30, windowDays: 7 },
          can: { manage: false },
        },
      }),
    });
    renderScreen(<AssetPlansSection asset={ASSET_ON_SCREEN} />, client);

    expect(
      await screen.findByText('Every year, counted from the last completed job'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a plan' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Pause/u })).not.toBeInTheDocument();
  });

  it('warns of a plan whose jobs could not be made, with the reason, here and on the asset', async () => {
    const failing = plan({
      failure: {
        message: 'The customer is closed.',
        at: '2026-10-31T06:00:00.000Z',
        count: 5,
        gaveUp: true,
      },
    });
    const { client } = fakeApi({
      'GET /v1/maintenance': () => ({
        body: { items: [], from: '2026-09-01', to: '2026-12-31', today: '2026-10-27' },
      }),
      'GET /v1/maintenance-plans': () => ({
        body: {
          items: [failing],
          defaults: { leadDays: 30, windowDays: 7 },
          can: { manage: true },
        },
      }),
    });
    const { unmount } = renderScreen(<MaintenanceScreen />, client);
    expect(
      await screen.findByRole('heading', { name: 'Plans whose jobs could not be made' }),
    ).toBeInTheDocument();
    expect(screen.getByText('The customer is closed.')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Failed 5 times in a row, so it is no longer retried. Edit the plan to try again.',
      ),
    ).toBeInTheDocument();
    unmount();

    renderScreen(<AssetPlansSection asset={ASSET_ON_SCREEN} />, client);
    expect(await screen.findByText('The customer is closed.')).toBeInTheDocument();
  });
});
