import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PipelineDetail, PipelineStage } from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import {
  basisPointsOf,
  percentOf,
  PipelineListScreen,
  PipelineScreen,
} from './pipeline-settings.js';

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const PIPELINE = '00000000-0000-4000-8000-000000000b01';
const SECOND = '00000000-0000-4000-8000-000000000b02';

const stages: PipelineStage[] = (
  [
    ['new', 'open', 1000, 0, 0],
    ['qualified', 'open', 2500, 3, 0],
    ['proposal', 'open', 5000, 1, 0],
    ['negotiation', 'open', 7500, 0, 0],
    ['won', 'won', 10000, 0, 4],
    ['lost', 'lost', 0, 0, 2],
  ] as const
).map(([key, outcome, probabilityBp, openCount, closedCount], index) => ({
  id: `00000000-0000-4000-8000-00000000c00${index}`,
  key,
  label: key[0]!.toUpperCase() + key.slice(1),
  position: index + 1,
  probabilityBp,
  outcome,
  archived: false,
  openCount,
  closedCount,
}));
const stage = (key: string) => stages.find((item) => item.key === key)!;

const detail = (overrides: Partial<PipelineDetail> = {}): PipelineDetail => ({
  id: PIPELINE,
  name: 'Sales',
  isDefault: true,
  stages,
  can: { edit: true },
  ...overrides,
});

const me = (permissions: string[]) => () => ({
  body: {
    userId: USER,
    tenantId: TENANT,
    email: 'o@x.example',
    displayName: 'Olu',
    role: 'owner',
    permissions,
    features: { crm: true },
  },
});
const OWNER = ['crm.read', 'crm.opportunity.manage', 'crm.pipeline.manage'];

describe('chances as percentages', () => {
  it('reads and writes whole basis points without floating point', () => {
    expect(basisPointsOf('37.5')).toBe(3750);
    expect(basisPointsOf('0.05')).toBe(5);
    expect(basisPointsOf('100')).toBe(10_000);
    expect(basisPointsOf('100.01')).toBeUndefined();
    expect(basisPointsOf('12.345')).toBeUndefined();
    expect(percentOf(3750)).toBe('37.5');
    expect(percentOf(5)).toBe('0.05');
    expect(percentOf(2500)).toBe('25');
  });
});

describe('the pipelines', { timeout: 20_000 }, () => {
  it('lists the pipelines and adds one for an owner', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(OWNER),
      'GET /v1/crm/pipelines': () => ({
        body: {
          items: [
            { id: PIPELINE, name: 'Sales', isDefault: true, stages },
            {
              id: SECOND,
              name: 'Service contracts',
              isDefault: false,
              stages: stages.slice(0, 3),
            },
          ],
        },
      }),
      'POST /v1/crm/pipelines': () => ({
        status: 201,
        body: detail({ id: SECOND, name: 'Renewals', isDefault: false }),
      }),
    });
    const { container, navigate } = renderScreen(<PipelineListScreen />, client);

    expect(await screen.findByRole('link', { name: 'Sales' })).toHaveAttribute(
      'href',
      `/crm/pipelines/${PIPELINE}`,
    );
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByText('6 stages')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    // A name is needed first.
    await user.click(screen.getByRole('button', { name: 'Add pipeline' }));
    expect(screen.getByText('Enter a name.')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    await user.type(screen.getByLabelText('Name'), 'Renewals');
    await user.click(screen.getByRole('button', { name: 'Add pipeline' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/crm/pipelines/${SECOND}`));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ name: 'Renewals' });
  });

  it('shows a dispatcher the stages and their counts, with nothing to change', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(['crm.read']),
      'GET /v1/crm/pipelines/:id': () => ({ body: detail({ can: { edit: false } }) }),
    });
    const { container } = renderScreen(<PipelineScreen pipelineId={PIPELINE} />, client);

    const table = await screen.findByRole('table', { name: 'Stages' });
    const qualified = within(table).getByRole('row', { name: /Qualified/u });
    expect(within(qualified).getByRole('cell', { name: '25%' })).toBeInTheDocument();
    expect(within(qualified).getByRole('cell', { name: '3' })).toBeInTheDocument();
    expect(
      within(within(table).getByRole('row', { name: /^Won/u })).getByRole('cell', { name: '4' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Only owners and admins change pipelines and their stages.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add stage' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Archive/u })).toBeNull();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('moves a stage earlier with its button, keeping the focus on it', async () => {
    const user = userEvent.setup();
    const reordered = [stage('new'), stage('proposal'), stage('qualified')]
      .concat(stages.slice(3))
      .map((item, index) => ({ ...item, position: index + 1 }));
    const { client, calls } = fakeApi({
      'GET /v1/me': me(OWNER),
      'GET /v1/crm/pipelines/:id': () => ({ body: detail() }),
      'PUT /v1/crm/pipelines/:id/stages/order': () => ({ body: detail({ stages: reordered }) }),
      'GET /v1/crm/pipelines': () => ({ body: { items: [] } }),
    });
    renderScreen(<PipelineScreen pipelineId={PIPELINE} />, client);

    // The first stage cannot go earlier, nor the last later.
    expect(await screen.findByRole('button', { name: 'Move New earlier' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move Lost later' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Move Proposal earlier' }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
        stageIds: [
          stage('new').id,
          stage('proposal').id,
          stage('qualified').id,
          stage('negotiation').id,
          stage('won').id,
          stage('lost').id,
        ],
      }),
    );
    expect(await screen.findByText('Proposal is now stage 2 of 6.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Move Proposal earlier' })).toHaveFocus(),
    );
  });

  it('archives a stage by moving its open opportunities to another open stage', async () => {
    const user = userEvent.setup();
    let answer: { status?: number; body?: unknown } = apiError(
      422,
      'move_target_not_open',
      'Open opportunities move to another open stage.',
    );
    const remaining = stages
      .filter((item) => item.key !== 'qualified')
      .map((item) => (item.key === 'proposal' ? { ...item, openCount: 4 } : item));
    const { client, calls } = fakeApi({
      'GET /v1/me': me(OWNER),
      'GET /v1/crm/pipelines/:id': () => ({ body: detail() }),
      'POST /v1/crm/pipelines/:id/stages/:stageId/archive': () => answer,
      'GET /v1/crm/pipelines': () => ({ body: { items: [] } }),
    });
    const { container } = renderScreen(<PipelineScreen pipelineId={PIPELINE} />, client);

    await user.click(await screen.findByRole('button', { name: 'Archive Qualified' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive Qualified?' });
    expect(
      within(dialog).getByText(
        'It holds 3 open opportunities. Each move is recorded in its history.',
      ),
    ).toBeInTheDocument();
    // Only the other open stages are offered.
    const choose = within(dialog).getByLabelText('Move its open opportunities to');
    expect(
      within(choose)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose a stage', 'New', 'Proposal', 'Negotiation']);
    expect(await accessibilityViolations(container)).toEqual([]);

    // Nothing is sent until a stage is chosen.
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(within(dialog).getByText('Choose the stage they move to.')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    // A refusal says why, in the reader's language.
    await user.selectOptions(choose, stage('proposal').id);
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await within(dialog).findByRole('alert')).not.toHaveTextContent(
      'Open opportunities move to another open stage.',
    );

    answer = {
      body: { pipeline: detail({ stages: remaining }), moved: 3 },
    };
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(
      await screen.findByText('Qualified is archived. 3 opportunities moved.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('row', { name: /Qualified/u })).toBeNull();
    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts.at(-1)!.path).toBe(
      `/v1/crm/pipelines/${PIPELINE}/stages/${stage('qualified').id}/archive`,
    );
    expect(posts.at(-1)!.body).toEqual({ moveToStageId: stage('proposal').id });
  });

  it('archives an empty stage without asking where to move anything', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(OWNER),
      'GET /v1/crm/pipelines/:id': () => ({ body: detail() }),
      'POST /v1/crm/pipelines/:id/stages/:stageId/archive': () => ({
        body: {
          pipeline: detail({ stages: stages.filter((item) => item.key !== 'negotiation') }),
          moved: 0,
        },
      }),
      'GET /v1/crm/pipelines': () => ({ body: { items: [] } }),
    });
    renderScreen(<PipelineScreen pipelineId={PIPELINE} />, client);

    await user.click(await screen.findByRole('button', { name: 'Archive Negotiation' }));
    const dialog = await screen.findByRole('dialog', { name: 'Archive Negotiation?' });
    expect(within(dialog).queryByLabelText('Move its open opportunities to')).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('Negotiation is archived.')).toBeInTheDocument();
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({});
  });

  it('adds a stage with its chance typed as a percentage', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(OWNER),
      'GET /v1/crm/pipelines/:id': () => ({ body: detail() }),
      'POST /v1/crm/pipelines/:id/stages': () => ({ status: 201, body: detail() }),
      'GET /v1/crm/pipelines': () => ({ body: { items: [] } }),
    });
    renderScreen(<PipelineScreen pipelineId={PIPELINE} />, client);

    await user.click(await screen.findByRole('button', { name: 'Add stage' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a stage' });
    await user.type(within(dialog).getByLabelText('Name'), 'Site survey');
    await user.type(within(dialog).getByLabelText('Usual chance of winning (%)'), '150');
    await user.click(within(dialog).getByRole('button', { name: 'Add stage' }));
    expect(
      within(dialog).getByText('Enter a percentage from 0 to 100, with up to two decimal places.'),
    ).toBeInTheDocument();

    await user.clear(within(dialog).getByLabelText('Usual chance of winning (%)'));
    await user.type(within(dialog).getByLabelText('Usual chance of winning (%)'), '37.5');
    await user.click(within(dialog).getByRole('button', { name: 'Add stage' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.body).toEqual({ label: 'Site survey', probabilityBp: 3750, outcome: 'open' });
  });

  it('says why the default pipeline cannot be archived', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/me': me(OWNER),
      'GET /v1/crm/pipelines/:id': () => ({
        body: detail({ id: SECOND, name: 'Service', isDefault: false }),
      }),
      'DELETE /v1/crm/pipelines/:id': () =>
        apiError(409, 'pipeline_has_open', 'Close or move its open opportunities.'),
    });
    renderScreen(<PipelineScreen pipelineId={SECOND} />, client, { locale: 'ar' });

    await user.click(await screen.findByRole('button', { name: 'أرشفة المسار' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'أرشفة المسار' }));
    const alert = await within(dialog).findByRole('alert');
    expect(alert).not.toHaveTextContent('Close or move its open opportunities.');
    expect(alert.textContent).not.toBe('');
  });
});
