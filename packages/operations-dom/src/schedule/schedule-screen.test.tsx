import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Schedule, ScheduleJob, UnscheduledJob } from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { ScheduleScreen } from './schedule-screen.js';

const AHMED = '00000000-0000-4000-8000-0000000000a1';
const SARA = '00000000-0000-4000-8000-0000000000a2';
const DISPATCHER = '00000000-0000-4000-8000-0000000000d1';
const BOILER = '00000000-0000-4000-8000-000000000b01';
const PUMP = '00000000-0000-4000-8000-000000000b02';
const WAITING = '00000000-0000-4000-8000-000000000b03';
const VISIT = '00000000-0000-4000-8000-000000000c01';
const OTHER = '00000000-0000-4000-8000-000000000c02';

const MANAGE = ['work_order.read_all', 'work_order.manage'];

/** Today at a time, in the device's time zone: the board opens on this week. */
function today(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  const at = new Date();
  at.setHours(hours!, minutes, 0, 0);
  return at.toISOString();
}

function job(id: string, reference: number, title: string, crew: string[] = []): ScheduleJob {
  return {
    id,
    reference,
    referenceLabel: `WO-${String(reference).padStart(6, '0')}`,
    title,
    state: 'scheduled',
    priority: 'normal',
    dueFrom: null,
    dueBy: null,
    customer: { id: '00000000-0000-4000-8000-000000000e01', name: 'Riverside Housing' },
    site: { id: '00000000-0000-4000-8000-000000000f01', name: 'Block A', city: 'Leeds' },
    jobType: { id: '00000000-0000-4000-8000-000000000601', name: 'AC service', code: 'AC' },
    crew: crew.map((id, index) => ({
      id,
      name: id === AHMED ? 'Ahmed Ali' : 'Sara Nabil',
      lead: index === 0,
    })),
    revision: 1,
    stateChangedAt: '2026-10-01T09:00:00.000Z',
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
  };
}

function schedule(): Schedule {
  return {
    from: today('00:00'),
    to: today('23:59'),
    settings: {
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      workDayStarts: 8 * 60,
      workDayEnds: 17 * 60,
      workingDays: [1, 2, 3, 4, 5],
    },
    visits: [
      {
        id: VISIT,
        workOrderId: BOILER,
        startsAt: today('09:00'),
        endsAt: today('11:00'),
        status: 'planned',
        notes: null,
        assignees: [{ id: AHMED, name: 'Ahmed Ali' }],
        completedAt: null,
        completedBy: null,
        cancelledAt: null,
        cancelReason: null,
        revision: 3,
        warnings: [],
      },
      {
        id: OTHER,
        workOrderId: PUMP,
        startsAt: today('13:00'),
        endsAt: today('14:00'),
        status: 'planned',
        notes: null,
        assignees: [{ id: SARA, name: 'Sara Nabil' }],
        completedAt: null,
        completedBy: null,
        cancelledAt: null,
        cancelReason: null,
        revision: 1,
        warnings: ['outside_due_window'],
      },
    ],
    workOrders: [job(BOILER, 12, 'Boiler service', [AHMED]), job(PUMP, 13, 'Pump repair', [SARA])],
    people: [
      { id: AHMED, name: 'Ahmed Ali', role: 'engineer' },
      { id: SARA, name: 'Sara Nabil', role: 'engineer' },
      { id: DISPATCHER, name: 'Dina Office', role: 'dispatcher' },
    ],
  };
}

const waiting: UnscheduledJob[] = [
  { workOrder: job(WAITING, 14, 'Chiller inspection', [SARA]), expectedDurationMinutes: 90 },
];

function routes(extra: Parameters<typeof fakeApi>[0] = {}) {
  return fakeApi({
    'GET /v1/schedule': () => ({ body: schedule() }),
    'GET /v1/schedule/unscheduled': () => ({ body: { items: waiting } }),
    ...extra,
  });
}

beforeEach(() => {
  localStorage.clear();
});

describe('the schedule', { timeout: 20_000 }, () => {
  it('shows the week’s visits, the people, and the jobs that need a visit', async () => {
    const { client, calls } = routes();
    const { container } = renderScreen(<ScheduleScreen />, client, { permissions: MANAGE });

    expect(
      await screen.findByRole('button', { name: /WO-000012 Boiler service/u }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /WO-000013 Pump repair.*Outside the job’s due window/u }),
    ).toBeInTheDocument();
    // Engineers are shown at first; the dispatcher is not.
    expect(screen.getByRole('checkbox', { name: 'Ahmed Ali' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Dina Office' })).not.toBeChecked();
    expect(screen.getByText('Chiller inspection')).toBeInTheDocument();

    const request = calls.find((call) => call.path === '/v1/schedule')!;
    const from = new Date(request.query.get('from')!);
    const to = new Date(request.query.get('to')!);
    expect(to.getTime() - from.getTime()).toBeGreaterThanOrEqual(6.9 * 24 * 60 * 60 * 1000);
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('hides a person’s visits when they are unticked, and remembers it', async () => {
    const user = userEvent.setup();
    const { client } = routes();
    renderScreen(<ScheduleScreen />, client, { permissions: MANAGE });

    await screen.findByRole('button', { name: /WO-000012/u });
    await user.click(screen.getByRole('checkbox', { name: 'Ahmed Ali' }));
    expect(screen.queryByRole('button', { name: /WO-000012/u })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem('integr8.schedule.v1')!)).toMatchObject({
      hidden: expect.arrayContaining([AHMED, DISPATCHER]) as unknown,
    });
  });

  it('moves a visit from its dialog, sending the revision it was loaded at', async () => {
    const user = userEvent.setup();
    const { client, calls } = routes({
      'PATCH /v1/visits/:id': (call) => ({
        body: {
          visit: {
            ...schedule().visits[0]!,
            endsAt: (call.body as { endsAt: string }).endsAt,
            revision: 4,
          },
        },
      }),
    });
    renderScreen(<ScheduleScreen />, client, { permissions: MANAGE });

    await user.click(await screen.findByRole('button', { name: /WO-000012/u }));
    const dialog = await screen.findByRole('dialog', { name: 'Visit to WO-000012' });
    const ends = within(dialog).getByLabelText('Ends');
    await user.clear(ends);
    await user.type(ends, `${today('12:00').slice(0, 10)}T12:00`);
    await user.click(within(dialog).getByRole('button', { name: 'Save visit' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect(patch.path).toBe(`/v1/visits/${VISIT}`);
    expect(patch.body).toMatchObject({
      expectedRevision: 3,
      assigneeIds: [AHMED],
      addToCrew: false,
    });
  });

  it('plans a visit for a waiting job with its lead engineer, and warns of a clash first', async () => {
    const user = userEvent.setup();
    const { client, calls } = routes({
      'POST /v1/work-orders/:id/visits': () => ({
        status: 201,
        body: { visit: schedule().visits[1] },
      }),
    });
    renderScreen(<ScheduleScreen />, client, { permissions: MANAGE });

    await user.click(await screen.findByRole('button', { name: /Plan a visit WO-000014/u }));
    const dialog = await screen.findByRole('dialog', { name: 'Plan a visit' });
    expect(within(dialog).getByRole('checkbox', { name: /Sara Nabil/u })).toBeChecked();

    // Put the visit on Sara's other job's time: the dialog says so before saving.
    const starts = within(dialog).getByLabelText('Starts');
    const ends = within(dialog).getByLabelText('Ends');
    await user.clear(starts);
    await user.type(starts, `${today('13:00').slice(0, 10)}T13:30`);
    await user.clear(ends);
    await user.type(ends, `${today('13:00').slice(0, 10)}T14:30`);
    expect(within(dialog).getByText('Sara Nabil is on WO-000013 then.')).toBeInTheDocument();

    await user.click(within(dialog).getByRole('checkbox', { name: /Ahmed Ali/u }));
    expect(
      within(dialog).getByText('Anyone not on the job’s crew is added to it.'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save visit' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.path).toBe(`/v1/work-orders/${WAITING}/visits`);
    expect(post.body).toMatchObject({ assigneeIds: [SARA, AHMED], addToCrew: true });
  });

  it('says why the server refused a visit, in words from the catalogue', async () => {
    const user = userEvent.setup();
    const { client } = routes({
      'PATCH /v1/visits/:id': () =>
        apiError(409, 'visit_double_booked', 'Ahmed is already on another job.'),
    });
    renderScreen(<ScheduleScreen />, client, { permissions: MANAGE });

    await user.click(await screen.findByRole('button', { name: /WO-000012/u }));
    const dialog = await screen.findByRole('dialog', { name: 'Visit to WO-000012' });
    await user.click(within(dialog).getByRole('button', { name: 'Save visit' }));
    expect(
      await within(dialog).findByText(
        /already on another job at that time\. Choose another time or person\./u,
      ),
    ).toBeInTheDocument();
  });

  it('hands an unavailable engineer’s visits to someone else in one go', async () => {
    const user = userEvent.setup();
    const { client, calls } = routes({
      'POST /v1/visits/bulk': () => ({
        body: { results: [{ visitId: VISIT, outcome: 'changed', code: null, message: null }] },
      }),
    });
    renderScreen(<ScheduleScreen />, client, { permissions: MANAGE });

    await user.click(
      await screen.findByRole('button', { name: 'Select Ahmed Ali’s visits in view' }),
    );
    const bar = screen.getByRole('region', { name: 'Visits selected: 1' });
    expect(within(bar).getByLabelText('Replace')).toHaveValue(AHMED);
    await user.selectOptions(within(bar).getByLabelText('With'), SARA);
    await user.click(within(bar).getByRole('button', { name: 'Apply' }));

    await waitFor(() => expect(calls.some((call) => call.path === '/v1/visits/bulk')).toBe(true));
    const bulk = calls.find((call) => call.path === '/v1/visits/bulk')!;
    expect(bulk.body).toEqual({
      action: 'reassign',
      visitIds: [VISIT],
      fromUserId: AHMED,
      toUserId: SARA,
    });
    expect(bulk.headers['idempotency-key']).toBeTruthy();
  });

  it('is read-only for someone who may see the board but not plan', async () => {
    const { client } = routes();
    renderScreen(<ScheduleScreen />, client, { permissions: ['work_order.read_all'] });

    expect(
      await screen.findByText('You can see the schedule but not change it.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Plan a visit/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Select Ahmed Ali/u })).not.toBeInTheDocument();
  });
});
