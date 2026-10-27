import { fireEvent, screen, waitFor, within } from '@testing-library/react';
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
    coverage: null,
    deadline: null,
    maintenance: false,
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
        qualificationGaps: [],
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
        qualificationGaps: [],
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

// ---------------------------------------------------------------------------
// Skills and certificates (P26): warn, never block
// ---------------------------------------------------------------------------

const GAS = '00000000-0000-4000-8000-000000000901';

/** The job needs Gas Safe: Sara holds it, Ahmed's has expired, Dina has none. */
const ELIGIBILITY = {
  requirements: [{ qualificationTypeId: GAS, name: 'Gas Safe' }],
  people: [
    {
      id: SARA,
      name: 'Sara Nabil',
      role: 'engineer',
      met: 1,
      statuses: [{ qualificationTypeId: GAS, status: 'valid' }],
    },
    {
      id: AHMED,
      name: 'Ahmed Ali',
      role: 'engineer',
      met: 0,
      statuses: [{ qualificationTypeId: GAS, status: 'expired' }],
    },
    {
      id: DISPATCHER,
      name: 'Dina Office',
      role: 'dispatcher',
      met: 0,
      statuses: [{ qualificationTypeId: GAS, status: 'missing' }],
    },
  ],
};

function unqualified(userId: string, status: string) {
  return apiError(409, 'visit_unqualified', 'Nobody on this visit holds Gas Safe.', [
    {
      field: 'body.qualificationOverride',
      code: status,
      message: 'Ahmed holds it expired: Gas Safe.',
      params: { qualificationTypeId: GAS, qualification: 'Gas Safe', userId },
    },
  ]);
}

describe('qualifications on the schedule', { timeout: 20_000 }, () => {
  it('names what a visit lacks on the board', async () => {
    const { client } = routes({
      'GET /v1/schedule': () => {
        const board = schedule();
        board.visits[0] = {
          ...board.visits[0]!,
          warnings: ['unqualified'],
          qualificationGaps: [
            {
              qualificationTypeId: GAS,
              name: 'Gas Safe',
              people: [{ id: AHMED, name: 'Ahmed Ali', status: 'expired' }],
            },
          ],
        };
        return { body: board };
      },
    });
    renderScreen(<ScheduleScreen />, client, { permissions: MANAGE });

    expect(
      await screen.findByRole('button', {
        name: /WO-000012 Boiler service.*Nobody on this visit holds Gas Safe/u,
      }),
    ).toBeInTheDocument();
  });

  it('lists the qualified first in the visit dialog and flags the rest without hiding them', async () => {
    const user = userEvent.setup();
    const { client } = routes({
      'GET /v1/work-orders/:id/eligibility': () => ({ body: ELIGIBILITY }),
    });
    renderScreen(<ScheduleScreen />, client, { permissions: MANAGE });

    await user.click(await screen.findByRole('button', { name: /WO-000012/u }));
    const dialog = await screen.findByRole('dialog', { name: 'Visit to WO-000012' });
    expect(await within(dialog).findByText('Needs: Gas Safe')).toBeInTheDocument();
    const names = within(dialog)
      .getAllByRole('checkbox')
      .map((box) => box.closest('label')!.textContent);
    expect(names[0]).toContain('Sara Nabil');
    expect(names[0]).not.toContain('Lacks');
    expect(names[1]).toContain('Ahmed Ali');
    expect(names[1]).toContain('Lacks Gas Safe (expired)');
    expect(names[2]).toContain('Dina Office');
    expect(names[2]).toContain('Lacks Gas Safe');
    // Ahmed alone is on it: the dialog says so before saving.
    expect(
      within(dialog).getByText('Nobody chosen holds Gas Safe for these dates.'),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('checkbox', { name: /Sara Nabil/u }));
    expect(
      within(dialog).queryByText('Nobody chosen holds Gas Safe for these dates.'),
    ).not.toBeInTheDocument();
  });

  it('asks for a reason when the server refuses a visit nobody is qualified for, then goes ahead', async () => {
    const user = userEvent.setup();
    let tries = 0;
    const { client, calls } = routes({
      'PATCH /v1/visits/:id': () => {
        tries += 1;
        return tries === 1
          ? unqualified(AHMED, 'expired')
          : { body: { visit: { ...schedule().visits[0]!, revision: 4 } } };
      },
    });
    renderScreen(<ScheduleScreen />, client, { permissions: MANAGE });

    await user.click(await screen.findByRole('button', { name: /WO-000012/u }));
    const dialog = await screen.findByRole('dialog', { name: 'Visit to WO-000012' });
    await user.click(within(dialog).getByRole('button', { name: 'Save visit' }));

    expect(
      await within(dialog).findByText('Nobody holds Gas Safe for the visit’s dates'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Ahmed Ali’s has expired')).toBeInTheDocument();
    const confirm = within(dialog).getByRole('button', { name: 'Save anyway' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Why go ahead anyway'), 'Sara joins on site');
    await user.click(confirm);

    await waitFor(() => expect(tries).toBe(2));
    const patches = calls.filter((call) => call.method === 'PATCH');
    expect(patches[0]!.body).not.toHaveProperty('qualificationOverride');
    expect(patches[1]!.body).toMatchObject({
      expectedRevision: 3,
      assigneeIds: [AHMED],
      qualificationOverride: { reason: 'Sara joins on site' },
    });
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Visit to WO-000012' })).not.toBeInTheDocument(),
    );
  });

  it('asks once for one reason for a batch, and resends only the refused visits', async () => {
    const user = userEvent.setup();
    const { client, calls } = routes({
      'POST /v1/visits/bulk': (call) =>
        (call.body as { qualificationOverrideReason?: string }).qualificationOverrideReason ===
        undefined
          ? {
              body: {
                results: [
                  {
                    visitId: VISIT,
                    outcome: 'refused',
                    code: 'visit_unqualified',
                    message: 'Nobody holds Gas Safe.',
                  },
                ],
              },
            }
          : {
              body: {
                results: [{ visitId: VISIT, outcome: 'changed', code: null, message: null }],
              },
            },
    });
    renderScreen(<ScheduleScreen />, client, { permissions: MANAGE });

    await user.click(
      await screen.findByRole('button', { name: 'Select Ahmed Ali’s visits in view' }),
    );
    const bar = screen.getByRole('region', { name: 'Visits selected: 1' });
    await user.selectOptions(within(bar).getByLabelText('With'), DISPATCHER);
    await user.click(within(bar).getByRole('button', { name: 'Apply' }));

    const prompt = await screen.findByRole('dialog', {
      name: 'Go ahead without the qualification?',
    });
    expect(within(prompt).getByText(/^WO-000012, .*: Dina Office$/u)).toBeInTheDocument();
    await user.type(within(prompt).getByLabelText('Why go ahead anyway'), 'Training visit');
    await user.click(within(prompt).getByRole('button', { name: 'Go ahead with these visits' }));

    await waitFor(() =>
      expect(calls.filter((call) => call.path === '/v1/visits/bulk')).toHaveLength(2),
    );
    const [first, second] = calls.filter((call) => call.path === '/v1/visits/bulk');
    expect(first!.body).not.toHaveProperty('qualificationOverrideReason');
    expect(second!.body).toEqual({
      action: 'reassign',
      visitIds: [VISIT],
      fromUserId: AHMED,
      toUserId: DISPATCHER,
      qualificationOverrideReason: 'Training visit',
    });
    expect(second!.headers['idempotency-key']).not.toBe(first!.headers['idempotency-key']);
  });
});

describe('dragging a visit nobody would be qualified for', { timeout: 20_000 }, () => {
  /** Drags the visit's bottom edge down an hour, as a mouse does. */
  function dragEndDownAnHour(handle: Element) {
    fireEvent.mouseDown(handle, { button: 0, clientX: 10, clientY: 100 });
    fireEvent.mouseMove(document, { clientX: 10, clientY: 110 });
    fireEvent.mouseMove(document, { clientX: 10, clientY: 148 });
    fireEvent.mouseUp(document, { clientX: 10, clientY: 148 });
  }

  it('keeps the move while asking why, and puts it back when cancelled', async () => {
    const user = userEvent.setup();
    const { client, calls } = routes({
      'PATCH /v1/visits/:id': () => unqualified(AHMED, 'expired'),
    });
    renderScreen(<ScheduleScreen />, client, { permissions: MANAGE });

    await screen.findByRole('button', { name: /WO-000012/u });
    dragEndDownAnHour(screen.getByTitle('Change when WO-000012 ends'));

    const prompt = await screen.findByRole('dialog', {
      name: 'Go ahead without the qualification?',
    });
    expect(within(prompt).getByText('Ahmed Ali’s has expired')).toBeInTheDocument();
    const patch = calls.find((call) => call.method === 'PATCH')!;
    expect(patch.body).toMatchObject({ endsAt: new Date(today('12:00')).toISOString() });

    await user.click(within(prompt).getByRole('button', { name: 'Put it back' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Go ahead without the qualification?' }),
      ).not.toBeInTheDocument(),
    );
    expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(1);
  });

  it('sends the move again with the reason', async () => {
    const user = userEvent.setup();
    let tries = 0;
    const { client, calls } = routes({
      'PATCH /v1/visits/:id': (call) => {
        tries += 1;
        return tries === 1
          ? unqualified(AHMED, 'expires_before_visit')
          : {
              body: {
                visit: {
                  ...schedule().visits[0]!,
                  endsAt: (call.body as { endsAt: string }).endsAt,
                  revision: 4,
                },
              },
            };
      },
    });
    renderScreen(<ScheduleScreen />, client, { permissions: MANAGE });

    await screen.findByRole('button', { name: /WO-000012/u });
    dragEndDownAnHour(screen.getByTitle('Change when WO-000012 ends'));
    const prompt = await screen.findByRole('dialog', {
      name: 'Go ahead without the qualification?',
    });
    expect(
      within(prompt).getByText('Ahmed Ali’s runs out before the visit ends'),
    ).toBeInTheDocument();
    await user.type(within(prompt).getByLabelText('Why go ahead anyway'), 'Renewal booked');
    await user.click(within(prompt).getByRole('button', { name: 'Save anyway' }));

    await waitFor(() => expect(tries).toBe(2));
    expect(calls.filter((call) => call.method === 'PATCH')[1]!.body).toMatchObject({
      expectedRevision: 3,
      qualificationOverride: { reason: 'Renewal booked' },
    });
  });
});
