import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Activity, CrmDashboard, Opportunity, OpportunityDetail, Stage } from '../api.js';
import {
  accessibilityViolations,
  apiError,
  type Call,
  fakeApi,
  renderScreen,
} from '../testing/render.js';
import { ActivitiesScreen, ActivityPanel } from './activities.js';
import { CrmOverviewScreen } from './crm-overview.js';
import { boardDrop, OpportunityBoardScreen } from './opportunity-board.js';
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
/** A transition the server accepted: the deal at its new stage and next version. */
const moved = (call: Call) => {
  const to = stages.find((item) => item.id === (call.body as { stageId: string }).stageId)!;
  return {
    body: {
      opportunity: opportunity({ stage: to, status: to.outcome, version: 5 }),
      events: [],
      stages,
      can: { edit: true },
    },
  };
};

/**
 * A board whose one deal moves when the server says so: each accepted
 * transition puts it in its new stage at the next version, as the API does.
 */
function boardApi(refuse?: () => ReturnType<typeof apiError>) {
  let current = opportunity();
  return fakeApi({
    'GET /v1/me': me(MANAGE),
    'GET /v1/members': members,
    'GET /v1/crm/pipelines': pipelines,
    'GET /v1/crm/opportunities': () => ({
      body: { items: current.status === 'open' ? [current] : [], nextCursor: null },
    }),
    'POST /v1/crm/opportunities/:id/transitions': (call) => {
      if (refuse !== undefined) {
        return refuse();
      }
      const { stageId } = call.body as { stageId: string };
      const to = stages.find((item) => item.id === stageId)!;
      current = { ...current, stage: to, status: to.outcome, version: current.version + 1 };
      return { body: { opportunity: current, events: [], stages, can: { edit: true } } };
    },
  });
}

const posts = (calls: Call[]) =>
  calls.filter((call) => call.method === 'POST').map((call) => call.body);

/**
 * jsdom lays nothing out, and dragging is all about where things are: the
 * open stages side by side — first on the left, or on the right in Arabic —
 * with won and lost in a row beneath, and each card near its column's top.
 */
function layOut(container: HTMLElement, direction: 'ltr' | 'rtl') {
  const open = [...container.querySelectorAll('section[aria-labelledby^="crm-stage-"]')];
  const closing = [...container.querySelectorAll('[aria-labelledby^="crm-close-zone-"]')];
  const rect = (left: number, top: number, width: number, height: number) =>
    ({
      x: left,
      y: top,
      left,
      top,
      width,
      height,
      right: left + width,
      bottom: top + height,
      toJSON: () => ({}),
    }) as DOMRect;
  const slot = (index: number, count: number) =>
    (direction === 'ltr' ? index : count - 1 - index) * 160;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const column = open.findIndex((node) => node.contains(this));
    if (column >= 0) {
      return this === open[column]
        ? rect(slot(column, open.length), 0, 150, 400)
        : rect(slot(column, open.length) + 5, 40, 140, 100);
    }
    const zone = closing.indexOf(this);
    if (zone >= 0) {
      return rect(slot(zone, open.length), 450, 150, 60);
    }
    return rect(0, 0, 0, 0);
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

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
      'POST /v1/crm/opportunities/:id/transitions': moved,
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
      'POST /v1/crm/opportunities/:id/transitions': moved,
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

  it('drags a card to another stage at once, says so, and undoes it', async () => {
    const user = userEvent.setup();
    const { client, calls } = boardApi();
    const { container } = renderScreen(<OpportunityBoardScreen />, client);
    const handle = await screen.findByRole('button', { name: 'Move Chiller maintenance' });
    layOut(container, 'ltr');
    expect(await accessibilityViolations(container)).toEqual([]);

    handle.focus();
    await user.keyboard('[Space]');
    await user.keyboard('[ArrowRight]');
    await user.keyboard('[Space]');

    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toEqual({ expectedVersion: 4, stageId: stage('qualified').id });
    expect(
      within(screen.getByRole('region', { name: /Qualified/u })).getByRole('link', {
        name: 'Chiller maintenance',
      }),
    ).toBeInTheDocument();
    // The keyboard stays with the card, in its new column.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move Chiller maintenance' })).toHaveFocus(),
    );
    expect(
      await screen.findByText('Chiller maintenance dropped in Qualified.'),
    ).toBeInTheDocument();
    const notice = await screen.findByText('Chiller maintenance moved to Qualified.');

    // Undo moves it back, from the version the move left it at.
    await user.click(
      within(notice.closest('[role="status"]')!).getByRole('button', { name: 'Undo' }),
    );
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(posts(calls)[1]).toEqual({ expectedVersion: 5, stageId: stage('new').id });
    expect(
      await within(screen.getByRole('region', { name: /New/u })).findByRole('link', {
        name: 'Chiller maintenance',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('puts a dragged card back when the move is refused', async () => {
    const user = userEvent.setup();
    const { client, calls } = boardApi(() => apiError(409, 'version_conflict', 'Changed'));
    const { container } = renderScreen(<OpportunityBoardScreen />, client);
    const handle = await screen.findByRole('button', { name: 'Move Chiller maintenance' });
    layOut(container, 'ltr');

    handle.focus();
    await user.keyboard('[Space]');
    await user.keyboard('[ArrowRight]');
    await user.keyboard('[ArrowRight]');
    await user.keyboard('[Space]');

    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toMatchObject({ stageId: stage('proposal').id });
    expect(await screen.findByRole('alert')).toHaveTextContent('Somebody else changed this');
    expect(
      within(screen.getByRole('region', { name: /New/u })).getByRole('link', {
        name: 'Chiller maintenance',
      }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('asks before closing a deal dropped on won or lost, and leaves it be on cancel', async () => {
    const user = userEvent.setup();
    const { client, calls } = boardApi();
    const { container } = renderScreen(<OpportunityBoardScreen />, client);
    const handle = await screen.findByRole('button', { name: 'Move Chiller maintenance' });
    expect(screen.getByRole('group', { name: 'Won' })).toHaveTextContent(
      'Drop a card here to close it.',
    );
    layOut(container, 'ltr');

    // Won is under the first column: down, and drop.
    handle.focus();
    await user.keyboard('[Space]');
    await user.keyboard('[ArrowDown]');
    await user.keyboard('[Space]');
    const won = await screen.findByRole('dialog', { name: 'Was it won?' });
    expect(won).toHaveTextContent('Chiller maintenance moves to Won and leaves the board.');
    await user.click(within(won).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(posts(calls)).toHaveLength(0);
    expect(
      within(screen.getByRole('region', { name: /New/u })).getByRole('link', {
        name: 'Chiller maintenance',
      }),
    ).toBeInTheDocument();

    // Lost is beside won, and wants a reason.
    screen.getByRole('button', { name: 'Move Chiller maintenance' }).focus();
    await user.keyboard('[Space]');
    await user.keyboard('[ArrowDown]');
    await user.keyboard('[ArrowRight]');
    await user.keyboard('[Space]');
    const lost = await screen.findByRole('dialog', { name: 'Why was it lost?' });
    expect(within(lost).getByRole('button', { name: 'Mark lost' })).toBeDisabled();
    await user.type(within(lost).getByLabelText('Why it was lost'), 'No budget this year');
    await user.click(within(lost).getByRole('button', { name: 'Mark lost' }));
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toEqual({
      expectedVersion: 4,
      stageId: stage('lost').id,
      lostReason: 'No budget this year',
    });
    // Closed deals leave the board, and there is nothing to undo.
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Chiller maintenance' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('mirrors the board in Arabic: the next stage is to the left, by key and by pointer', async () => {
    const user = userEvent.setup();
    const { client, calls } = boardApi();
    const { container } = renderScreen(<OpportunityBoardScreen />, client, { locale: 'ar' });
    const handle = await screen.findByRole('button', {
      name: 'نقل الفرصة «Chiller maintenance»',
    });
    expect(handle).toHaveAttribute('aria-roledescription', 'بطاقة قابلة للنقل');
    layOut(container, 'rtl');
    expect(await accessibilityViolations(container)).toEqual([]);

    // Left from the first stage, which sits on the right, is the second.
    handle.focus();
    await user.keyboard('[Space]');
    await user.keyboard('[ArrowLeft]');
    await user.keyboard('[Space]');
    await waitFor(() => expect(posts(calls)).toHaveLength(1));
    expect(posts(calls)[0]).toEqual({ expectedVersion: 4, stageId: stage('qualified').id });
    expect(
      await screen.findByText('أُفلتت الفرصة «Chiller maintenance» في مؤهلة.'),
    ).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'تراجع' })).toBeInTheDocument();

    // By pointer: the stage under the pointer, three columns to the left, is where it lands.
    const card = within(screen.getByRole('region', { name: /مؤهلة/u }))
      .getByRole('link', { name: 'Chiller maintenance' })
      .closest('article')!;
    const from = card.getBoundingClientRect();
    const negotiation = container
      .querySelector(`#crm-stage-${stage('negotiation').id}`)!
      .closest('section')!
      .getBoundingClientRect();
    fireEvent.mouseDown(card, { button: 0, clientX: from.left + 20, clientY: from.top + 20 });
    fireEvent.mouseMove(document, { clientX: from.left, clientY: from.top + 20 });
    fireEvent.mouseMove(document, {
      clientX: negotiation.left + 30,
      clientY: negotiation.top + 30,
    });
    fireEvent.mouseUp(document, { clientX: negotiation.left + 30, clientY: negotiation.top + 30 });
    await waitFor(() => expect(posts(calls)).toHaveLength(2));
    expect(posts(calls)[1]).toEqual({ expectedVersion: 5, stageId: stage('negotiation').id });
  });

  it('decides what a drop means: nothing, a move, or a question', () => {
    const item = { stage: stage('new') };
    expect(boardDrop(item, undefined)).toEqual({ kind: 'none' });
    expect(boardDrop(item, stage('new'))).toEqual({ kind: 'none' });
    expect(boardDrop(item, { ...stage('proposal'), archived: true })).toEqual({ kind: 'none' });
    expect(boardDrop(item, stage('proposal'))).toEqual({ kind: 'move', stage: stage('proposal') });
    expect(boardDrop(item, stage('won'))).toEqual({ kind: 'confirm', stage: stage('won') });
    expect(boardDrop(item, stage('lost'))).toEqual({ kind: 'confirm', stage: stage('lost') });
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
