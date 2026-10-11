import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Activity, CrmDashboard, Opportunity, OpportunityDetail, Stage } from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { ActivitiesScreen, ActivityPanel } from './activities.js';
import { CrmOverviewScreen } from './crm-overview.js';
import { OpportunityBoardScreen } from './opportunity-board.js';
import { OpportunityScreen } from './opportunity-screen.js';

const USER = '00000000-0000-4000-8000-000000000401';
const CUSTOMER = '00000000-0000-4000-8000-000000000301';
const OPP = '00000000-0000-4000-8000-000000000a01';
const PIPELINE = '00000000-0000-4000-8000-000000000b01';

const stages: Stage[] = (
  [
    ['new', 'open', 1000],
    ['qualified', 'open', 2500],
    ['proposal', 'open', 5000],
    ['negotiation', 'open', 7500],
    ['won', 'won', 10000],
    ['lost', 'lost', 0],
  ] as const
).map(([key, outcome, probabilityBp], index) => ({
  id: `00000000-0000-4000-8000-00000000c00${index}`,
  key,
  label: key,
  position: index + 1,
  probabilityBp,
  outcome,
  archived: false,
}));
const stage = (key: string) => stages.find((item) => item.key === key)!;

function opportunity(overrides: Partial<Opportunity> = {}): Opportunity {
  return {
    id: OPP,
    title: 'Chiller maintenance',
    customer: { id: CUSTOMER, name: 'Pyramid Hotels' },
    lead: null,
    pipelineId: PIPELINE,
    stage: stage('new'),
    ownerId: USER,
    amount: '250000.75',
    currencyCode: 'EGP',
    expectedCloseDate: '2026-12-15',
    probabilityBp: 1000,
    status: 'open',
    lostReason: null,
    description: null,
    closedAt: null,
    version: 4,
    createdBy: USER,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

const me =
  (permissions: string[], crm = true) =>
  () => ({
    body: {
      userId: USER,
      tenantId: CUSTOMER,
      email: 'd@x.example',
      displayName: 'Dee Dispatcher',
      role: 'dispatcher',
      permissions,
      features: { crm },
    },
  });
const MANAGE = ['crm.read', 'crm.opportunity.manage', 'crm.activity.manage', 'crm.lead.manage'];
const members = () => ({
  body: {
    items: [
      {
        userId: USER,
        email: 'd@x.example',
        displayName: 'Dee Dispatcher',
        role: 'dispatcher',
        status: 'active',
        createdAt: '2026-01-01T09:00:00.000Z',
      },
    ],
    nextCursor: null,
  },
});
const pipelines = () => ({
  body: { items: [{ id: PIPELINE, name: 'Sales', isDefault: true, stages }] },
});
const noActivities = () => ({ body: { items: [], nextCursor: null } });

describe('the opportunity board', { timeout: 20_000 }, () => {
  it('shows a column per open stage and moves a card with its stage select', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/members': members,
      'GET /v1/crm/pipelines': pipelines,
      'GET /v1/crm/opportunities': () => ({
        body: { items: [opportunity()], nextCursor: null },
      }),
      'POST /v1/crm/opportunities/:id/transitions': () => ({ body: {} }),
    });
    const { container } = renderScreen(<OpportunityBoardScreen />, client);

    const column = await screen.findByRole('region', { name: /New/u });
    expect(within(column).getByRole('link', { name: 'Chiller maintenance' })).toHaveAttribute(
      'href',
      `/crm/opportunities/${OPP}`,
    );
    for (const name of [/Qualified/u, /Proposal/u, /Negotiation/u]) {
      expect(screen.getByRole('region', { name })).toBeInTheDocument();
    }
    expect(screen.queryByRole('region', { name: /^Won/u })).not.toBeInTheDocument();
    expect(calls.find((call) => call.path === '/v1/crm/opportunities')!.query.get('status')).toBe(
      'open',
    );
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.selectOptions(within(column).getByLabelText('Stage'), stage('proposal').id);
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      expectedVersion: 4,
      stageId: stage('proposal').id,
    });
  });

  it('asks why before marking a deal lost', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/members': members,
      'GET /v1/crm/pipelines': pipelines,
      'GET /v1/crm/opportunities': () => ({
        body: { items: [opportunity()], nextCursor: null },
      }),
      'POST /v1/crm/opportunities/:id/transitions': () => ({ body: {} }),
    });
    renderScreen(<OpportunityBoardScreen />, client);

    await user.selectOptions(await screen.findByLabelText('Stage'), stage('lost').id);
    const dialog = await screen.findByRole('dialog', { name: 'Why was it lost?' });
    const confirm = within(dialog).getByRole('button', { name: 'Mark lost' });
    expect(confirm).toBeDisabled();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    await user.type(within(dialog).getByLabelText('Why it was lost'), 'Went with a cheaper quote');
    await user.click(confirm);
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      expectedVersion: 4,
      stageId: stage('lost').id,
      lostReason: 'Went with a cheaper quote',
    });
  });

  it('offers nothing to change to someone who may only read', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(['crm.read']),
      'GET /v1/members': members,
      'GET /v1/crm/pipelines': pipelines,
      'GET /v1/crm/opportunities': () => ({
        body: { items: [opportunity()], nextCursor: null },
      }),
    });
    renderScreen(<OpportunityBoardScreen />, client);

    expect(await screen.findByRole('link', { name: 'Chiller maintenance' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Stage')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New opportunity' })).not.toBeInTheDocument();
  });
});

describe('an opportunity', { timeout: 20_000 }, () => {
  const detail = (overrides: Partial<Opportunity> = {}): OpportunityDetail => ({
    opportunity: opportunity(overrides),
    events: [
      {
        kind: 'stage_changed',
        fromStage: stage('new'),
        toStage: stage('qualified'),
        fromStatus: 'open',
        toStatus: 'open',
        reason: null,
        actorId: USER,
        occurredAt: '2026-10-02T09:00:00.000Z',
      },
      {
        kind: 'created',
        fromStage: null,
        toStage: stage('new'),
        fromStatus: null,
        toStatus: 'open',
        reason: null,
        actorId: USER,
        occurredAt: '2026-10-01T09:00:00.000Z',
      },
    ],
    stages,
    can: { edit: true },
  });

  it('shows what it is worth, its history, and saves only what changed', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/members': members,
      'GET /v1/crm/opportunities/:id': () => ({
        body: detail({ stage: stage('qualified'), probabilityBp: 2500 }),
      }),
      'PATCH /v1/crm/opportunities/:id': () => ({ body: opportunity() }),
      'GET /v1/crm/activities': noActivities,
    });
    const { container } = renderScreen(<OpportunityScreen opportunityId={OPP} />, client);

    expect(await screen.findByRole('heading', { name: 'Chiller maintenance' })).toBeInTheDocument();
    expect(screen.getByText('EGP 250,000.75')).toBeInTheDocument();
    expect(screen.getByText('25%')).toBeInTheDocument();
    expect(screen.getByText('Moved from New to Qualified')).toBeInTheDocument();
    expect(screen.getByText('Opened at New')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit' });
    const chance = within(form).getByLabelText('Chance of winning');
    await user.clear(chance);
    await user.type(chance, '37.5');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({
      expectedVersion: 4,
      probabilityBp: 3750,
    });
  });

  it('asks for a reload when somebody else moved it first', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/members': members,
      'GET /v1/crm/opportunities/:id': () => ({ body: detail() }),
      'POST /v1/crm/opportunities/:id/transitions': () =>
        apiError(409, 'version_conflict', 'Changed'),
      'GET /v1/crm/activities': noActivities,
    });
    renderScreen(<OpportunityScreen opportunityId={OPP} />, client);

    await user.selectOptions(await screen.findByLabelText('Stage'), stage('proposal').id);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Somebody changed this opportunity');
    expect(within(alert).getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });
});

function activity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: '00000000-0000-4000-8000-000000000d01',
    kind: 'follow_up',
    subject: 'Send the revised quote',
    detail: null,
    outcome: null,
    status: 'open',
    assignedTo: USER,
    dueAt: '2026-10-01T09:00:00.000Z',
    completedAt: null,
    completedBy: null,
    version: 2,
    createdBy: USER,
    createdAt: '2026-09-30T09:00:00.000Z',
    updatedAt: '2026-09-30T09:00:00.000Z',
    leads: [],
    customers: [{ id: CUSTOMER, name: 'Pyramid Hotels' }],
    opportunities: [{ id: OPP, title: 'Chiller maintenance' }],
    ...overrides,
  };
}

describe('follow-ups', { timeout: 20_000 }, () => {
  it('lists my overdue ones first, marks one done, and switches to done', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/members': members,
      'GET /v1/crm/activities': (call) => ({
        body: {
          items: call.query.get('status') === 'done' ? [] : [activity()],
          nextCursor: null,
        },
      }),
      'PATCH /v1/crm/activities/:id': () => ({ body: activity({ status: 'done' }) }),
    });
    const { container } = renderScreen(<ActivitiesScreen />, client);

    expect(await screen.findByText('Send the revised quote')).toBeInTheDocument();
    const first = calls.find((call) => call.path === '/v1/crm/activities')!.query;
    expect(Object.fromEntries(first)).toMatchObject({
      status: 'open',
      due: 'overdue',
      assignedTo: 'me',
      order: 'due',
    });
    expect(screen.getByRole('link', { name: 'Chiller maintenance' })).toHaveAttribute(
      'href',
      `/crm/opportunities/${OPP}`,
    );
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({
      expectedVersion: 2,
      status: 'done',
    });

    await user.click(screen.getByRole('tab', { name: 'Done' }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.path === '/v1/crm/activities' &&
            call.query.get('status') === 'done' &&
            call.query.get('order') === 'recent',
        ),
      ).toBe(true),
    );
  });

  it('adds a follow-up to the record it is shown on', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/members': members,
      'GET /v1/crm/activities': noActivities,
      'POST /v1/crm/activities': () => ({ status: 201, body: activity() }),
    });
    renderScreen(<ActivityPanel links={{ opportunityIds: [OPP] }} canManage />, client);

    await user.click(await screen.findByRole('button', { name: 'Add activity' }));
    const form = screen.getByRole('form', { name: 'Add activity' });
    await user.selectOptions(within(form).getByLabelText('Type'), 'call');
    await user.type(within(form).getByLabelText('Subject'), 'Call the facilities manager');
    await user.click(within(form).getByLabelText(/Already done/u));
    await user.click(within(form).getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      kind: 'call',
      subject: 'Call the facilities manager',
      detail: null,
      dueAt: null,
      assignedTo: null,
      done: true,
      opportunityIds: [OPP],
    });
  });
});

describe('the CRM dashboard', { timeout: 20_000 }, () => {
  const figures: CrmDashboard = {
    currency: 'EGP',
    since: '2026-09-11T00:00:00.000Z',
    leadsByStatus: { new: 3, contacted: 1, qualified: 2, unqualified: 0, converted: 4 },
    pipeline: {
      id: PIPELINE,
      name: 'Sales',
      stages: stages
        .filter((item) => item.outcome === 'open')
        .map((item) => ({
          ...item,
          count: item.key === 'proposal' ? 2 : 0,
          totals:
            item.key === 'proposal'
              ? [{ currencyCode: 'EGP', total: '300000', weighted: '150000', count: 2 }]
              : [],
        })),
    },
    openTotals: [
      { currencyCode: 'EGP', total: '300000', weighted: '150000', count: 2 },
      { currencyCode: 'USD', total: '1200.5', weighted: '120.05', count: 1 },
    ],
    won: [],
    lostCount: 1,
    activities: { overdue: 2, dueToday: 1, mine: 3 },
    can: { manageLeads: true, manageOpportunities: true, manageActivities: true },
  };

  it('totals each currency on its own and says the forecast is not revenue', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/crm/dashboard': () => ({ body: figures }),
    });
    const { container } = renderScreen(<CrmOverviewScreen />, client);

    expect(await screen.findByText('EGP 300,000.00 · $1,200.50')).toBeInTheDocument();
    expect(screen.getByText('EGP 150,000.00 · $120.05')).toBeInTheDocument();
    expect(
      screen.getByText('Each amount times its chance of winning. A forecast, not revenue.'),
    ).toBeInTheDocument();
    expect(screen.getByText('2 overdue')).toBeInTheDocument();
    expect(screen.getByText('0 won, 1 lost')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('says plainly when the company does not have the CRM, and asks for nothing', async () => {
    const { client, calls } = fakeApi({ 'GET /v1/me': me(MANAGE, false) });
    renderScreen(<CrmOverviewScreen />, client);

    expect(
      await screen.findByText(
        'The CRM is not switched on for your company. Ask Integr8 to turn it on.',
      ),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.path === '/v1/crm/dashboard')).toBe(false);
  });
});
