import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DeadlineReport, DeadlineRules } from '../api.js';
import { accessibilityViolations, fakeApi, renderScreen } from '../testing/render.js';
import { DeadlinesScreen } from './deadlines-screen.js';

const RIVERSIDE = { id: '00000000-0000-4000-8000-000000000301', name: 'Riverside Housing' };
const HARBOUR = { id: '00000000-0000-4000-8000-000000000302', name: 'Harbour, Hotels' };
const JOB = '00000000-0000-4000-8000-000000000101';

const REPORT: DeadlineReport = {
  from: '2026-09-28',
  to: '2026-10-27',
  totals: {
    jobs: 8,
    responseDue: 8,
    respondedOnTime: 6,
    completionDue: 4,
    completedOnTime: 3,
    missed: 3,
    averageResponseMinutes: 95,
  },
  customers: [
    {
      customer: RIVERSIDE,
      summary: {
        jobs: 5,
        responseDue: 5,
        respondedOnTime: 3,
        completionDue: 2,
        completedOnTime: 1,
        missed: 3,
        averageResponseMinutes: 120,
      },
    },
    {
      customer: HARBOUR,
      summary: {
        jobs: 3,
        responseDue: 3,
        respondedOnTime: 3,
        completionDue: 2,
        completedOnTime: 2,
        missed: 0,
        averageResponseMinutes: 50,
      },
    },
  ],
  misses: [
    {
      workOrder: { id: JOB, reference: 'WO-000045', title: 'Boiler breakdown', state: 'complete' },
      customer: RIVERSIDE,
      kind: 'response',
      priority: 'urgent',
      dueAt: '2026-10-01T10:00:00.000Z',
      metAt: '2026-10-01T11:30:00.000Z',
      recordedAt: '2026-10-01T10:00:00.000Z',
    },
    {
      workOrder: { id: JOB, reference: 'WO-000045', title: 'Boiler breakdown', state: 'complete' },
      customer: RIVERSIDE,
      kind: 'completion',
      priority: 'urgent',
      dueAt: '2026-10-01T14:00:00.000Z',
      metAt: null,
      recordedAt: '2026-10-01T14:00:00.000Z',
    },
  ],
};

function rules(manage: boolean): DeadlineRules {
  return {
    rules: [
      {
        priority: 'urgent',
        responseMinutes: 60,
        completionMinutes: 240,
        clock: 'always',
        warnMinutes: 15,
        updatedAt: '2026-10-01T09:00:00.000Z',
      },
    ],
    workingHours: {
      timeZone: 'Africa/Cairo',
      startsMinute: 480,
      endsMinute: 1020,
      days: [7, 1, 2, 3, 4],
    },
    defaults: { warnMinutes: 30 },
    can: { manage },
  };
}

describe('response deadlines', { timeout: 20_000 }, () => {
  it('reports the period in total, per customer and miss by miss, and downloads it as CSV', async () => {
    const user = userEvent.setup();
    const download = vi.fn();
    const { client, calls } = fakeApi({
      'GET /v1/deadline-report': () => ({ body: REPORT }),
      'GET /v1/deadline-rules': () => ({ body: rules(false) }),
    });
    const { container } = renderScreen(<DeadlinesScreen />, client, { download });

    const report = await screen.findByRole('region', { name: 'How jobs did' });
    const totals = await within(report).findAllByRole('definition');
    expect(totals.map((value) => value.textContent)).toEqual([
      '8',
      '75%',
      '75%',
      '1 h 35 min',
      '3',
    ]);

    const table = within(report).getByRole('table', { name: 'By customer' });
    const riverside = within(table).getByRole('row', { name: /Riverside Housing/u });
    expect(
      within(riverside)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['5', '60%', '50%', '2 h 0 min', '3']);

    const misses = within(report).getByRole('table', { name: 'Missed deadlines' });
    expect(
      within(misses).getAllByRole('link', { name: 'WO-000045 · Boiler breakdown' })[0],
    ).toHaveAttribute('href', `/work-orders/${JOB}`);
    expect(within(misses).getByText('Not met')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(within(report).getByRole('button', { name: 'Download CSV' }));
    expect(download).toHaveBeenCalledTimes(1);
    const [blob, filename] = download.mock.calls[0] as [Blob, string];
    expect(filename).toBe('response-deadlines-2026-09-28-to-2026-10-27.csv');
    expect(blob.type).toBe('text/csv;charset=utf-8');
    const text = await blob.text();
    expect(text).toContain(
      'Customer,Jobs with deadlines,Response due,Responded on time,Responded on time (%),Completion due,Completed on time,Completed on time (%),Average response (minutes),Missed',
    );
    expect(text).toContain('Riverside Housing,5,5,3,60,2,1,50,120,3');
    expect(text).toContain('"Harbour, Hotels",3,3,3,100,2,2,100,50,0');
    expect(text).toContain('All customers,8,8,6,75,4,3,75,95,3');
    expect(text).toContain(
      'WO-000045,Boiler breakdown,Riverside Housing,Response,Urgent,2026-10-01T10:00:00.000Z,2026-10-01T11:30:00.000Z,2026-10-01T10:00:00.000Z',
    );
    expect(text).toContain(
      'WO-000045,Boiler breakdown,Riverside Housing,Completion,Urgent,2026-10-01T14:00:00.000Z,,',
    );

    // Another period goes to the server.
    expect(within(report).getByLabelText('From')).toHaveValue('2026-09-28');
    fireEvent.change(within(report).getByLabelText('From'), { target: { value: '2026-07-01' } });
    await waitFor(() => {
      const last = calls.filter((call) => call.path === '/v1/deadline-report').at(-1)!;
      expect(last.query.get('from')).toBe('2026-07-01');
      expect(last.query.get('to')).toBe('2026-10-27');
    });
  });

  it('shows the rules to someone who cannot change them', async () => {
    const { client } = fakeApi({
      'GET /v1/deadline-report': () => ({ body: REPORT }),
      'GET /v1/deadline-rules': () => ({ body: rules(false) }),
    });
    renderScreen(<DeadlinesScreen />, client);

    const section = await screen.findByRole('region', { name: 'Deadline rules' });
    expect(await within(section).findByText('Owners and admins set these.')).toBeInTheDocument();
    expect(
      within(section).getByText(/^Working hours: .+ \(Africa\/Cairo\)\./u),
    ).toBeInTheDocument();
    const urgent = within(section).getByRole('row', { name: /Urgent/u });
    expect(
      within(urgent)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['1 h 0 min', '4 h 0 min', 'Around the clock', '15 min']);
    const normal = within(section).getByRole('row', { name: /Normal/u });
    expect(within(normal).getAllByRole('cell')[0]).toHaveTextContent('No deadline');
    expect(within(section).queryByRole('button', { name: 'Save rules' })).not.toBeInTheDocument();
  });

  it('saves the rules in hours and minutes, refusing completion before response', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/deadline-report': () => ({ body: REPORT }),
      'GET /v1/deadline-rules': () => ({ body: rules(true) }),
      'PUT /v1/deadline-rules': () => ({ body: rules(true) }),
    });
    renderScreen(<DeadlinesScreen />, client);

    const section = await screen.findByRole('region', { name: 'Deadline rules' });
    const save = await within(section).findByRole('button', { name: 'Save rules' });
    expect(within(section).getByLabelText('Response hours for Urgent')).toHaveValue(1);

    await user.type(within(section).getByLabelText('Response hours for High'), '2');
    await user.type(within(section).getByLabelText('Completion hours for High'), '8');
    await user.selectOptions(within(section).getByLabelText('Clock for High'), 'working_hours');

    await user.type(within(section).getByLabelText('Response hours for Normal'), '5');
    await user.type(within(section).getByLabelText('Completion hours for Normal'), '1');
    expect(
      within(section).getByText('Completion cannot be due before response.'),
    ).toBeInTheDocument();
    expect(save).toBeDisabled();
    await user.clear(within(section).getByLabelText('Completion hours for Normal'));
    await user.type(within(section).getByLabelText('Completion hours for Normal'), '10');
    expect(save).toBeEnabled();

    await user.click(save);
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'PUT')?.body).toEqual({
        rules: [
          {
            priority: 'urgent',
            responseMinutes: 60,
            completionMinutes: 240,
            clock: 'always',
            warnMinutes: 15,
          },
          {
            priority: 'high',
            responseMinutes: 120,
            completionMinutes: 480,
            clock: 'working_hours',
            warnMinutes: 30,
          },
          {
            priority: 'normal',
            responseMinutes: 300,
            completionMinutes: 600,
            clock: 'always',
            warnMinutes: 30,
          },
        ],
      }),
    );
    expect(await within(section).findByText('Saved.')).toBeInTheDocument();
  });
});
