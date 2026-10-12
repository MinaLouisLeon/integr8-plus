import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Stage } from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { lastDays, shareOf } from './analytics-parts.js';
import { CrmReportsScreen, StageValuesSection } from './crm-reports.js';
import { PartsUsageScreen } from './parts-usage.js';

const USER = '00000000-0000-4000-8000-000000000401';
const OTHER = '00000000-0000-4000-8000-000000000402';
const GONE = '00000000-0000-4000-8000-000000000403';
const TENANT = '00000000-0000-4000-8000-000000000301';
const PIPELINE = '00000000-0000-4000-8000-000000000b01';

const me = (permissions: string[], features: Record<string, boolean>) => () => ({
  body: {
    userId: USER,
    tenantId: TENANT,
    email: 'o@x.example',
    displayName: 'Olu',
    role: 'owner',
    permissions,
    features,
  },
});
const member = (userId: string, displayName: string) => ({
  userId,
  email: `${displayName.toLowerCase()}@x.example`,
  displayName,
  role: 'sales',
  status: 'active',
  createdAt: '2026-01-01T09:00:00.000Z',
});
const members = () => ({
  body: { items: [member(USER, 'Olu'), member(OTHER, 'Mona')], nextCursor: null },
});
const stages: Stage[] = (
  [
    ['new', 'open', 1000],
    ['proposal', 'open', 5000],
    ['site_survey', 'open', 3000],
    ['won', 'won', 10000],
    ['lost', 'lost', 0],
  ] as const
).map(([key, outcome, probabilityBp], index) => ({
  id: `00000000-0000-4000-8000-00000000c00${index}`,
  key,
  label: key === 'site_survey' ? 'Site survey' : key,
  position: index + 1,
  probabilityBp,
  outcome,
  archived: false,
}));
const pipelines = () => ({
  body: { items: [{ id: PIPELINE, name: 'Sales', isDefault: true, stages }] },
});

describe('figures', () => {
  it('starts at the last 90 days, and divides whole counts only', () => {
    expect(lastDays(90, new Date(2026, 9, 12, 15))).toEqual({
      from: '2026-07-14',
      to: '2026-10-12',
    });
    expect(shareOf(3, 4, 'en')).toBe('75%');
    expect(shareOf(0, 0, 'en')).toBe('—');
  });
});

describe('the CRM’s reports', { timeout: 20_000 }, () => {
  it('shows quote conversion and win rate by person, and the pipeline by month', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(['crm.read', 'sales.read'], { crm: true, sales: true }),
      'GET /v1/members': members,
      'GET /v1/crm/pipelines': pipelines,
      'GET /v1/analytics/quotes': () => ({
        body: {
          items: [
            {
              issuedBy: OTHER,
              issued: 4,
              accepted: 3,
              declined: 1,
              expired: 0,
              open: 0,
              medianDaysToAccept: 6,
            },
            {
              issuedBy: null,
              issued: 5,
              accepted: 3,
              declined: 1,
              expired: 1,
              open: 0,
              medianDaysToAccept: 6,
            },
            {
              issuedBy: GONE,
              issued: 1,
              accepted: 0,
              declined: 0,
              expired: 1,
              open: 0,
              medianDaysToAccept: null,
            },
          ],
        },
      }),
      'GET /v1/analytics/pipeline': (call) =>
        call.query.get('groupBy') === 'owner'
          ? {
              body: {
                groupBy: 'owner',
                items: [
                  { group: null, won: 2, lost: 1, medianDaysToClose: 20 },
                  { group: USER, won: 2, lost: 0, medianDaysToClose: 18 },
                  { group: 'none', won: 0, lost: 1, medianDaysToClose: 40 },
                ],
              },
            }
          : {
              body: {
                groupBy: 'source',
                items: [
                  { group: null, won: 2, lost: 1, medianDaysToClose: 20 },
                  { group: 'referral', won: 2, lost: 0, medianDaysToClose: 18 },
                  { group: 'none', won: 0, lost: 1, medianDaysToClose: 40 },
                ],
              },
            },
      'GET /v1/analytics/pipelines/:id/stage-values': () => ({
        body: {
          monthEnds: ['2026-09-30', '2026-10-12'],
          items: [
            {
              monthEnd: '2026-09-30',
              stageId: stages[1]!.id,
              currency: 'EGP',
              count: 2,
              amount: '250000.75',
              weighted: '125000.375',
              estimated: 0,
            },
            {
              monthEnd: '2026-10-12',
              stageId: stages[2]!.id,
              currency: 'USD',
              count: 1,
              amount: '1000',
              weighted: '300',
              estimated: 0,
            },
          ],
          amountsRecordedFrom: '2026-09-01T08:00:00.000Z',
        },
      }),
    });
    const { container } = renderScreen(<CrmReportsScreen />, client);

    // Quotes: overall first, then each issuer by name.
    const quotes = await screen.findByRole('table', { name: 'Quote conversion' });
    const quoteRows = within(quotes).getAllByRole('row').slice(1);
    expect(quoteRows.map((row) => within(row).getAllByRole('rowheader')[0]!.textContent)).toEqual([
      'All',
      'Mona',
      'Former member',
    ]);
    expect(within(quoteRows[0]!).getByRole('cell', { name: '60%' })).toBeInTheDocument();
    expect(within(quoteRows[0]!).getByRole('cell', { name: '6 days' })).toBeInTheDocument();
    expect(within(quoteRows[1]!).getByRole('cell', { name: '75%' })).toBeInTheDocument();
    expect(within(quoteRows[2]!).getAllByRole('cell', { name: '—' })).toHaveLength(1);
    // The period asked for is the last 90 days.
    const { from, to } = lastDays(90);
    const asked = calls.find((call) => call.path === '/v1/analytics/quotes')!;
    expect([asked.query.get('from'), asked.query.get('to')]).toEqual([from, to]);

    // Win rate by source, then by owner.
    const winRate = await screen.findByRole('table', { name: 'Win rate' });
    expect(within(winRate).getByRole('row', { name: /^Referral/u })).toHaveTextContent('100%');
    expect(within(winRate).getByRole('row', { name: /^Not from a lead/u })).toHaveTextContent('0%');
    expect(within(winRate).getByRole('row', { name: /^All/u })).toHaveTextContent('67%');
    const pipelineSection = screen.getByRole('region', { name: 'Win rate' });
    await user.selectOptions(within(pipelineSection).getByLabelText('Group by'), 'owner');
    await user.click(within(pipelineSection).getByRole('button', { name: 'Show' }));
    expect(await within(pipelineSection).findByRole('row', { name: /^Olu/u })).toHaveTextContent(
      '18 days',
    );
    expect(within(pipelineSection).getByRole('row', { name: /^Nobody/u })).toBeInTheDocument();
    expect(
      calls
        .filter((call) => call.path === '/v1/analytics/pipeline')
        .at(-1)!
        .query.get('groupBy'),
    ).toBe('owner');

    // Value by stage at each month's end, unweighted and weighted, each currency on its own.
    const values = await screen.findByRole('table', { name: 'Pipeline value by month' });
    const proposal = within(values).getByRole('row', { name: /^Proposal/u });
    expect(proposal).toHaveTextContent('EGP 250,000.75');
    expect(proposal).toHaveTextContent('2 open');
    expect(within(values).getByRole('row', { name: /^Site survey/u })).toHaveTextContent(
      '$1,000.00',
    );
    expect(within(values).getByRole('columnheader', { name: 'Today' })).toBeInTheDocument();
    expect(within(values).queryByRole('row', { name: /^New/u })).toBeNull();
    // Every figure is from the history: nothing to explain, nothing marked.
    expect(screen.queryByText(/earlier changes were not kept/u)).toBeNull();
    expect(within(values).queryByText('Estimated')).toBeNull();
    expect(calls.some((call) => call.path === '/v1/settings')).toBe(false);
    await user.click(screen.getByLabelText('Weight by each stage’s usual chance'));
    expect(within(values).getByRole('row', { name: /^Proposal/u })).toHaveTextContent(
      'EGP 125,000.375',
    );
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('refuses a period that ends before it starts, and says what the server refused', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/me': me(['crm.read'], { crm: true }),
      'GET /v1/members': members,
      'GET /v1/crm/pipelines': pipelines,
      'GET /v1/analytics/pipeline': () =>
        apiError(422, 'period_too_long', 'A period is at most two years.'),
      'GET /v1/analytics/pipelines/:id/stage-values': () => ({
        body: { monthEnds: ['2026-10-12'], items: [], amountsRecordedFrom: null },
      }),
    });
    renderScreen(<CrmReportsScreen />, client);

    // Without the sales module there is no quotes section, and nothing is asked of it.
    const section = await screen.findByRole('region', { name: 'Win rate' });
    expect(screen.queryByRole('region', { name: 'Quote conversion' })).toBeNull();
    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'Choose a period of at most two years.',
    );
    expect(
      await screen.findByText('Nothing stood open in this pipeline in these months.'),
    ).toBeVisible();

    fireEvent.change(within(section).getByLabelText('From'), { target: { value: '2026-10-20' } });
    fireEvent.change(within(section).getByLabelText('To'), { target: { value: '2026-10-01' } });
    expect(within(section).getByRole('button', { name: 'Show' })).toBeDisabled();
    expect(within(section).getByText('Choose a start on or before the end.')).toBeVisible();
    expect(calls.some((call) => call.path === '/v1/analytics/quotes')).toBe(false);
  });

  it('says which month ends count deals at the amount they had when amounts began to be kept', async () => {
    const value = (monthEnd: string, estimated: number) => ({
      monthEnd,
      stageId: stages[1]!.id,
      currency: 'EGP',
      count: 2,
      amount: '1000',
      weighted: '500',
      estimated,
    });
    const { client } = fakeApi({
      'GET /v1/crm/pipelines': pipelines,
      'GET /v1/settings': () => ({ body: { currency: 'EGP', timezone: 'Africa/Cairo' } }),
      'GET /v1/analytics/pipelines/:id/stage-values': () => ({
        body: {
          monthEnds: ['2026-08-31', '2026-09-30', '2026-10-12'],
          items: [value('2026-08-31', 2), value('2026-09-30', 1), value('2026-10-12', 0)],
          // Late on the 30th in UTC is the 1st in Cairo: the company's day is the one said.
          amountsRecordedFrom: '2026-09-30T22:30:00.000Z',
        },
      }),
    });
    const { container } = renderScreen(<StageValuesSection />, client);

    expect(
      await screen.findByText(
        'Amounts before October 1, 2026 are the amounts deals had on October 1, 2026; earlier changes were not kept.',
      ),
    ).toBeVisible();
    const row = within(screen.getByRole('table', { name: 'Pipeline value by month' })).getByRole(
      'row',
      { name: /^Proposal/u },
    );
    const cells = within(row).getAllByRole('cell');
    expect(within(cells[0]!).getByText('Estimated')).toHaveAttribute(
      'title',
      'Some deals here are counted at the amount they had on October 1, 2026.',
    );
    expect(cells[1]).toHaveTextContent('Estimated');
    expect(cells[2]).not.toHaveTextContent('Estimated');
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('says so in Arabic too, in the company’s calendar', async () => {
    const { client } = fakeApi({
      'GET /v1/crm/pipelines': pipelines,
      'GET /v1/settings': () => ({ body: { currency: 'EGP', timezone: 'Africa/Cairo' } }),
      'GET /v1/analytics/pipelines/:id/stage-values': () => ({
        body: {
          monthEnds: ['2026-09-30', '2026-10-12'],
          items: [
            {
              monthEnd: '2026-09-30',
              stageId: stages[1]!.id,
              currency: 'EGP',
              count: 1,
              amount: '1000',
              weighted: '500',
              estimated: 1,
            },
          ],
          amountsRecordedFrom: '2026-09-30T22:30:00.000Z',
        },
      }),
    });
    renderScreen(<StageValuesSection />, client, { locale: 'ar' });

    expect(
      await screen.findByText(/^المبالغ قبل .+ هي المبالغ التي كانت للصفقات في /u),
    ).toBeVisible();
    expect(screen.getByText('تقديري')).toBeInTheDocument();
  });

  it('says so without the CRM, and asks for no figures', async () => {
    const { client, calls } = fakeApi({ 'GET /v1/me': me([], { crm: false }) });
    renderScreen(<CrmReportsScreen />, client);
    expect(
      await screen.findByText(
        'The CRM is not switched on for your company. Ask Integr8 to turn it on.',
      ),
    ).toBeVisible();
    expect(calls.some((call) => call.path.startsWith('/v1/analytics'))).toBe(false);
  });
});

describe('parts used on jobs', { timeout: 20_000 }, () => {
  const usage = (value: string | null) => () => ({
    body: {
      groupBy: 'engineer',
      items: [
        { group: USER, label: 'Olu', lines: 12, value },
        { group: OTHER, label: 'Mona', lines: 3, value: value === null ? null : '45.5' },
      ],
    },
  });

  it('shows lines and value by engineer, and downloads both files for whoever moves stock', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(['inventory.read', 'inventory.move'], { inventory: true }),
      'GET /v1/settings': () => ({ body: { currency: 'EGP', timezone: 'Africa/Cairo' } }),
      'GET /v1/analytics/parts-usage': usage('1250.25'),
      'GET /v1/analytics/parts-usage.csv': () => ({ text: 'Group,Name,Lines,Value\n' }),
      'GET /v1/inventory/movements.csv': () => ({
        text: 'Id,When\n',
        headers: { 'x-export-truncated': 'true' },
      }),
    });
    const { container } = renderScreen(<PartsUsageScreen />, client);

    const table = await screen.findByRole('table', { name: 'Parts used on jobs' });
    expect(within(table).getByRole('row', { name: /^Olu/u })).toHaveTextContent('EGP 1,250.25');
    expect(within(table).getByRole('columnheader', { name: 'Engineer' })).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Download parts used (CSV)' }));
    await waitFor(() =>
      expect(calls.some((call) => call.path === '/v1/analytics/parts-usage.csv')).toBe(true),
    );
    const csv = calls.find((call) => call.path === '/v1/analytics/parts-usage.csv')!;
    expect(csv.query.get('groupBy')).toBe('engineer');
    expect(csv.query.get('from')).toBe(lastDays(90).from);

    await user.click(screen.getByRole('button', { name: 'Download stock movements (CSV)' }));
    expect(
      await screen.findByText(
        'The file stops at 50,000 rows: more matched. Narrow the filters to download the rest.',
      ),
    ).toBeVisible();
  });

  it('hides the value from a seat that does not see costs, and offers no downloads', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(['inventory.read'], { inventory: true }),
      'GET /v1/settings': () => ({ body: { currency: 'EGP', timezone: 'Africa/Cairo' } }),
      'GET /v1/analytics/parts-usage': usage(null),
    });
    renderScreen(<PartsUsageScreen />, client);

    const table = await screen.findByRole('table', { name: 'Parts used on jobs' });
    expect(within(table).queryByRole('columnheader', { name: 'Value' })).toBeNull();
    expect(screen.getByText('Values show only to those who see stock costs.')).toBeVisible();
    expect(screen.queryByRole('button', { name: /CSV/u })).toBeNull();
  });
});
