import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ImportDetail, Timesheet, WorkOrderDetail, WorkOrderState } from './api.js';
import { ImportsScreen } from './screens/imports-screen.js';
import { JobTypesScreen } from './screens/job-types-screen.js';
import { TimesheetsScreen } from './screens/timesheets-screen.js';
import { addDays, startOfWeek } from './timesheets.js';
import { WorkOrderListScreen } from './screens/work-order-list.js';
import { WorkOrderScreen } from './screens/work-order-screen.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from './testing/render.js';

const JOB = '00000000-0000-4000-8000-000000000101';
const SITE = '00000000-0000-4000-8000-000000000201';
const CUSTOMER = '00000000-0000-4000-8000-000000000301';
const ENGINEER = { id: '00000000-0000-4000-8000-000000000401', name: 'Sam Carter' };
const FORM = '00000000-0000-4000-8000-000000000501';

function detail(overrides: Partial<WorkOrderDetail> = {}): WorkOrderDetail {
  const base: WorkOrderDetail = {
    workOrder: {
      id: JOB,
      reference: 123,
      referenceLabel: 'WO-000123',
      title: 'Boiler service',
      state: 'in_progress',
      priority: 'urgent',
      dueFrom: null,
      dueBy: '2026-10-01T17:00:00.000Z',
      customer: { id: CUSTOMER, name: 'Riverside Housing' },
      site: { id: SITE, name: 'Block A', city: 'Leeds' },
      jobType: {
        id: '00000000-0000-4000-8000-000000000601',
        name: 'Boiler service',
        code: 'BOILER',
      },
      crew: [{ ...ENGINEER, lead: true }],
      revision: 4,
      stateChangedAt: '2026-10-01T09:00:00.000Z',
      createdAt: '2026-09-30T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z',
      description: 'Annual service, flat 4',
      instructions: 'Check the flue terminal.',
      lastReason: null,
      completedAt: null,
      reviewedAt: null,
      cancelledAt: null,
    },
    site: {
      id: SITE,
      name: 'Block A',
      address: {
        line1: '1 River Road',
        line2: null,
        city: 'Leeds',
        region: null,
        postcode: 'LS1 1AA',
        countryCode: 'GB',
      },
      location: { latitude: 53.8, longitude: -1.55 },
      geocodeStatus: 'found',
      access: {
        gateCode: '4471#',
        parking: 'Visitor bays at the rear',
        askFor: 'Caretaker, ext 12',
        hazards: 'Asbestos in plant room',
        notes: null,
        updatedAt: '2026-09-01T09:00:00.000Z',
        updatedBy: ENGINEER,
      },
    },
    siteContact: null,
    customer: {
      id: CUSTOMER,
      name: 'Riverside Housing',
      accountNumber: 'RH-001',
      status: 'active',
      phone: null,
    },
    jobType: {
      id: '00000000-0000-4000-8000-000000000601',
      name: 'Boiler service',
      code: 'BOILER',
      expectedDurationMinutes: 90,
    },
    crew: [{ ...ENGINEER, lead: true, assignedAt: '2026-09-30T09:00:00.000Z' }],
    forms: [{ formId: FORM, title: 'Gas safety record', required: true, submission: null }],
    checklist: [
      {
        id: '00000000-0000-4000-8000-000000000701',
        label: 'Isolate supply',
        done: false,
        doneBy: null,
        doneAt: null,
      },
    ],
    comments: [],
    events: [
      {
        kind: 'created',
        fromState: null,
        toState: null,
        person: null,
        actor: ENGINEER,
        reason: null,
        details: {},
        occurredAt: '2026-09-30T09:00:00.000Z',
        recordedAt: '2026-09-30T09:00:00.000Z',
      },
    ],
    attachments: [],
    execution: {
      beforePhotos: 0,
      afterPhotos: 0,
      signatureRequired: false,
      signoff: null,
      missing: {
        forms: [{ formId: FORM, title: 'Gas safety record' }],
        beforePhotos: 0,
        afterPhotos: 0,
        signoff: false,
      },
    },
    previousAtSite: [],
    can: {
      edit: false,
      assign: false,
      work: true,
      comment: true,
      transitions: [
        { to: 'awaiting_parts', requiresReason: false },
        { to: 'complete', requiresReason: false },
      ],
    },
  };
  return { ...base, ...overrides };
}

describe('the job screen', () => {
  it('shows how to get in before anything else on the page, hazards first', async () => {
    const { client } = fakeApi({ 'GET /v1/work-orders/:id': () => ({ body: detail() }) });
    const { container } = renderScreen(<WorkOrderScreen workOrderId={JOB} />, client);

    const access = await screen.findByRole('region', { name: 'Getting in' });
    const title = screen.getByRole('heading', { level: 1, name: 'Boiler service' });
    // Nothing above it but the way back to the list.
    expect(access.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const headings = within(container).getAllByRole('heading');
    expect(headings[0]).toHaveTextContent('Getting in');

    const terms = within(access)
      .getAllByRole('term')
      .map((term) => term.textContent);
    expect(terms[0]).toContain('Hazards on arrival');
    expect(within(access).getByText('4471#')).toBeInTheDocument();
    expect(within(access).getByText('Asbestos in plant room')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('offers exactly the transitions the server allows, and lists everything a completion is waiting for', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/work-orders/:id': () => ({ body: detail() }),
      'POST /v1/work-orders/:id/transitions': () =>
        apiError(
          409,
          'completion_blocked',
          "Before completing this job, submit Gas safety record, take 1 more after photo, get the customer's sign-off.",
          [
            {
              field: 'forms.0',
              code: 'required_form_missing',
              message: 'Gas safety record',
              params: { formId: FORM },
            },
            {
              field: 'photos.after',
              code: 'photos_missing',
              message: '1 after photo(s) still needed',
              params: { needed: '1' },
            },
            {
              field: 'signoff',
              code: 'signoff_missing',
              message: 'The customer has not signed off',
            },
          ],
        ),
    });
    renderScreen(<WorkOrderScreen workOrderId={JOB} />, client);

    const actions = await screen.findByRole('region', { name: 'Move this job on' });
    expect(
      within(actions)
        .getAllByRole('button')
        .map((button) => button.textContent),
    ).toEqual(['Waiting for parts', 'Complete job']);

    await user.click(within(actions).getByRole('button', { name: 'Complete job' }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/^Before completing this job, submit/u)).toBeInTheDocument();
    expect(
      within(alert)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Submit Gas safety record', '1 more after photo', 'The customer’s sign-off']);
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      to: 'complete',
      expectedRevision: 4,
    });
  });

  it('asks why before cancelling, and sends the reason', async () => {
    const user = userEvent.setup();
    const cancelled = detail({
      workOrder: {
        ...detail().workOrder,
        state: 'cancelled',
        cancelledAt: '2026-10-01T10:00:00.000Z',
      },
      can: { edit: false, assign: true, work: true, comment: true, transitions: [] },
    });
    const { client, calls } = fakeApi({
      'GET /v1/work-orders/:id': () => ({
        body: detail({
          workOrder: { ...detail().workOrder, state: 'scheduled' },
          can: {
            edit: true,
            assign: true,
            work: true,
            comment: true,
            transitions: [
              { to: 'dispatched', requiresReason: false },
              { to: 'cancelled', requiresReason: true },
            ],
          },
        }),
      }),
      'POST /v1/work-orders/:id/transitions': () => ({ body: cancelled }),
    });
    renderScreen(<WorkOrderScreen workOrderId={JOB} />, client);

    await user.click(await screen.findByRole('button', { name: 'Cancel job' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel job' });
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Reason'), 'Customer rang to cancel');
    await user.click(confirm);

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((call) => call.method === 'POST')?.body).toEqual({
      to: 'cancelled',
      expectedRevision: 4,
      reason: 'Customer rang to cancel',
    });
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
  });

  it('does not offer to correct access notes to someone who cannot work the job', async () => {
    const { client } = fakeApi({
      'GET /v1/work-orders/:id': () => ({
        body: detail({
          can: { edit: false, assign: false, work: false, comment: false, transitions: [] },
        }),
      }),
    });
    renderScreen(<WorkOrderScreen workOrderId={JOB} />, client);
    await screen.findByRole('region', { name: 'Getting in' });
    expect(screen.queryByRole('button', { name: 'Correct access notes' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fill in' })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Isolate supply' })).toBeDisabled();
  });

  const SIGNATURE = '00000000-0000-4000-8000-000000000901';
  const change = (
    fromState: WorkOrderState,
    toState: WorkOrderState,
    occurredAt: string,
  ): WorkOrderDetail['events'][number] => ({
    kind: 'transitioned',
    fromState,
    toState,
    person: null,
    actor: ENGINEER,
    reason: null,
    details: {},
    occurredAt,
    recordedAt: occurredAt,
  });
  const worked = (overrides: Partial<WorkOrderDetail['execution']> = {}) =>
    detail({
      workOrder: { ...detail().workOrder, state: 'awaiting_parts' },
      events: [
        change('dispatched', 'travelling', '2026-10-01T09:00:00.000Z'),
        change('travelling', 'on_site', '2026-10-01T09:30:00.000Z'),
        change('on_site', 'in_progress', '2026-10-01T09:40:00.000Z'),
        change('in_progress', 'awaiting_parts', '2026-10-01T10:40:00.000Z'),
        change('awaiting_parts', 'in_progress', '2026-10-01T11:00:00.000Z'),
        change('in_progress', 'awaiting_parts', '2026-10-01T12:00:00.000Z'),
        {
          kind: 'signed_off',
          fromState: null,
          toState: null,
          person: null,
          actor: ENGINEER,
          reason: null,
          details: {
            name: overrides.signoff?.name ?? 'Pat Lee',
            role: 'Tenant',
            fileId: SIGNATURE,
            unavailableReason: overrides.signoff?.unavailableReason ?? null,
          },
          occurredAt: '2026-10-01T12:05:00.000Z',
          // Signed in a basement with no signal; synced from the van.
          recordedAt: '2026-10-01T14:30:00.000Z',
        },
      ],
      attachments: [
        {
          id: '00000000-0000-4000-8000-000000000911',
          fileId: '00000000-0000-4000-8000-000000000912',
          title: 'Boiler before',
          kind: 'photo',
          stage: 'before',
          contentType: 'image/jpeg',
          byteSize: 1000,
          addedBy: ENGINEER,
          createdAt: '2026-10-01T09:35:00.000Z',
        },
      ],
      can: { edit: false, assign: false, work: true, comment: true, transitions: [] },
      execution: {
        beforePhotos: 1,
        afterPhotos: 2,
        signatureRequired: true,
        signoff: {
          signedAt: '2026-10-01T12:05:00.000Z',
          signedBy: ENGINEER,
          fileId: SIGNATURE,
          name: 'Pat Lee',
          role: 'Tenant',
          unavailableReason: null,
        },
        missing: { forms: [], beforePhotos: 0, afterPhotos: 2, signoff: false },
        ...overrides,
      },
    });

  it('shows the photos, the sign-off, what is still missing and the time on the job', async () => {
    const user = userEvent.setup();
    const opened = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { client, calls } = fakeApi({
      'GET /v1/work-orders/:id': () => ({ body: worked() }),
      'GET /v1/media/:id': () => ({
        body: { url: 'https://files.test/signature.png', expiresAt: '2099-01-01T00:00:00.000Z' },
      }),
    });
    const { container } = renderScreen(<WorkOrderScreen workOrderId={JOB} />, client);

    const completion = await screen.findByRole('region', { name: 'Completion' });
    expect(within(completion).getByText('1 of 1')).toBeInTheDocument();
    expect(within(completion).getByText('0 of 2')).toBeInTheDocument();
    expect(within(completion).getByRole('button', { name: 'Boiler before' })).toBeInTheDocument();
    expect(within(completion).getByText('Signed by Pat Lee (Tenant)')).toBeInTheDocument();
    expect(within(completion).getByText(/^Recorded by Sam Carter /u)).toBeInTheDocument();
    expect(within(completion).getByText('2 more after photos')).toBeInTheDocument();
    const times = definitions(completion);
    expect(times).toMatchObject({
      Travelling: '30 min',
      'Arrived, before starting': '10 min',
      Working: '2 h 0 min',
    });
    // Still waiting for parts, so that stretch runs on to now.
    expect(times['Waiting for parts']).toMatch(/min$/u);

    await user.click(within(completion).getByRole('button', { name: 'View signature' }));
    await waitFor(() =>
      expect(opened).toHaveBeenCalledWith('https://files.test/signature.png', '_blank', 'noopener'),
    );
    expect(calls.some((call) => call.path === `/v1/media/${SIGNATURE}`)).toBe(true);

    const files = screen.getByRole('region', { name: 'Files' });
    expect(within(files).getByText('Photo · Before · Sam Carter')).toBeInTheDocument();

    const history = screen.getByRole('region', { name: 'History' });
    expect(
      within(history).getByText('Sam Carter recorded the customer’s sign-off by Pat Lee'),
    ).toBeInTheDocument();
    // Only the late one says when it synced.
    expect(
      within(history).getAllByText(/^Recorded on the phone at .+, synced at .+$/u),
    ).toHaveLength(1);
    expect(await accessibilityViolations(container)).toEqual([]);
    opened.mockRestore();
  });

  it('says why nobody signed, in the section and the history', async () => {
    const reason = 'Tenant was not home';
    const { client } = fakeApi({
      'GET /v1/work-orders/:id': () => ({
        body: worked({
          signoff: {
            signedAt: '2026-10-01T12:05:00.000Z',
            signedBy: ENGINEER,
            fileId: null,
            name: null,
            role: null,
            unavailableReason: reason,
          },
        }),
      }),
    });
    renderScreen(<WorkOrderScreen workOrderId={JOB} />, client);

    const completion = await screen.findByRole('region', { name: 'Completion' });
    expect(within(completion).getByText(`Nobody could sign: ${reason}`)).toBeInTheDocument();
    expect(within(completion).queryByRole('button', { name: 'View signature' })).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'History' })).getByText(
        `Sam Carter recorded that nobody could sign: ${reason}`,
      ),
    ).toBeInTheDocument();
  });
});

/** A description list as `{ term: definition }`. */
function definitions(container: HTMLElement): Record<string, string> {
  return Object.fromEntries(
    within(container)
      .getAllByRole('term')
      .map((term) => [term.textContent, term.nextElementSibling?.textContent ?? '']),
  );
}

describe('job types', () => {
  // Two dialogs typed into key by key: slow when the whole workspace is testing at once.
  it(
    'sends the photos and sign-off a job type needs before completion',
    { timeout: 20_000 },
    async () => {
      const user = userEvent.setup();
      const existing = {
        id: '00000000-0000-4000-8000-000000000601',
        name: 'Boiler service',
        code: 'BOILER',
        description: null,
        expectedDurationMinutes: null,
        defaultPriority: 'normal',
        instructions: null,
        checklist: [],
        forms: [],
        archived: false,
        beforePhotos: 2,
        afterPhotos: 1,
        signatureRequired: true,
      };
      const { client, calls } = fakeApi({
        'GET /v1/me': () => ({
          body: {
            userId: ENGINEER.id,
            tenantId: CUSTOMER,
            email: 'o@x.example',
            displayName: 'Olu',
            role: 'admin',
            permissions: ['job_type.manage'],
          },
        }),
        'GET /v1/job-types': () => ({ body: { items: [existing] } }),
        'GET /v1/forms': () => ({ body: { items: [] } }),
        'POST /v1/job-types': (call) => ({ status: 201, body: call.body }),
        'PATCH /v1/job-types/:id': (call) => ({ body: { ...existing, ...(call.body as object) } }),
      });
      renderScreen(<JobTypesScreen />, client);

      expect(
        await screen.findByText('2 before photos · 1 after photo · Customer signs off'),
      ).toBeInTheDocument();

      await user.click(await screen.findByRole('button', { name: 'New job type' }));
      let dialog = await screen.findByRole('dialog', { name: 'New job type' });
      await user.type(within(dialog).getByLabelText('Name'), 'Meter fit');
      await user.type(within(dialog).getByLabelText('Code'), 'METER');
      const before = within(dialog).getByLabelText('Before photos required');
      expect(before).toHaveAttribute('max', '20');
      await user.clear(before);
      await user.type(before, '3');
      await user.clear(within(dialog).getByLabelText('After photos required'));
      await user.type(within(dialog).getByLabelText('After photos required'), '2');
      await user.click(
        within(dialog).getByRole('checkbox', { name: 'Customer signs off to complete' }),
      );
      await user.click(within(dialog).getByRole('button', { name: 'Create job type' }));

      await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
      expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({
        name: 'Meter fit',
        code: 'METER',
        beforePhotos: 3,
        afterPhotos: 2,
        signatureRequired: true,
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

      await user.click(screen.getByRole('button', { name: 'Edit' }));
      dialog = await screen.findByRole('dialog', { name: 'Boiler service' });
      expect(within(dialog).getByLabelText('Before photos required')).toHaveValue(2);
      await user.click(
        within(dialog).getByRole('checkbox', { name: 'Customer signs off to complete' }),
      );
      await user.click(within(dialog).getByRole('button', { name: 'Save job type' }));
      await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
      expect(calls.find((call) => call.method === 'PATCH')?.body).toMatchObject({
        beforePhotos: 2,
        afterPhotos: 1,
        signatureRequired: false,
      });
    },
  );
});

describe('the job list', () => {
  const item = (id: string, reference: number, state: 'scheduled' | 'complete') => ({
    ...detail().workOrder,
    id,
    reference,
    referenceLabel: `WO-${String(reference).padStart(6, '0')}`,
    state,
  });

  it('cancels the selected jobs and lists each one that could not be cancelled', async () => {
    const user = userEvent.setup();
    const first = '00000000-0000-4000-8000-000000000111';
    const second = '00000000-0000-4000-8000-000000000112';
    const { client, calls } = fakeApi({
      'GET /v1/me': () => ({
        body: {
          userId: ENGINEER.id,
          tenantId: CUSTOMER,
          email: 'd@x.example',
          displayName: 'Dee',
          role: 'dispatcher',
          permissions: ['work_order.manage', 'work_order.read_all'],
        },
      }),
      'GET /v1/job-types': () => ({ body: { items: [] } }),
      'GET /v1/saved-views': () => ({ body: { items: [] } }),
      'GET /v1/work-orders': () => ({
        body: {
          items: [item(first, 1, 'scheduled'), item(second, 2, 'complete')],
          nextCursor: null,
          counts: {
            scheduled: 1,
            dispatched: 0,
            travelling: 0,
            on_site: 0,
            in_progress: 0,
            awaiting_parts: 0,
            complete: 1,
            reviewed: 0,
            cancelled: 0,
          },
        },
      }),
      'POST /v1/work-orders/bulk': () => ({
        body: {
          results: [
            { workOrderId: first, outcome: 'changed', code: null, message: null },
            {
              workOrderId: second,
              outcome: 'refused',
              code: 'transition_not_allowed',
              message: 'A job that is complete cannot move to cancelled.',
            },
          ],
        },
      }),
    });
    const { container } = renderScreen(<WorkOrderListScreen />, client);

    expect(await screen.findByRole('button', { name: /Scheduled 1/u })).toBeInTheDocument();
    await user.click(await screen.findByRole('checkbox', { name: 'Select every job shown' }));
    await user.click(screen.getByRole('button', { name: 'Cancel jobs' }));
    const dialog = await screen.findByRole('dialog', { name: 'Cancel 2 jobs' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Contract ended');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));

    const status = await screen.findByText('1 job changed.');
    expect(status.parentElement).toHaveTextContent(
      'WO-000002: A job that is complete cannot move to cancelled.',
    );
    expect(calls.find((call) => call.path === '/v1/work-orders/bulk')?.body).toEqual({
      action: 'cancel',
      workOrderIds: [first, second],
      reason: 'Contract ended',
    });
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});

describe('imports', () => {
  it('lists every problem by spreadsheet row and column', async () => {
    const importId = '00000000-0000-4000-8000-000000000801';
    const report: ImportDetail = {
      id: importId,
      kind: 'work_orders',
      status: 'completed',
      fileName: 'jobs.csv',
      totalRows: 1000,
      succeededRows: 998,
      failedRows: 2,
      createdBy: ENGINEER,
      createdAt: '2026-10-01T09:00:00.000Z',
      startedAt: '2026-10-01T09:00:01.000Z',
      completedAt: '2026-10-01T09:00:30.000Z',
      errors: [
        {
          row: 18,
          column: 'site_name',
          code: 'not_found',
          message: 'Riverside Housing has no site called "Block Z".',
        },
        { row: 102, column: 'priority', code: 'invalid', message: '"whenever" is not a priority.' },
      ],
    };
    const { client } = fakeApi({
      'GET /v1/imports/columns/:kind': () => ({ body: { items: [] } }),
      'GET /v1/imports': () => ({ body: { items: [{ ...report, errors: undefined }] } }),
      'GET /v1/imports/:id': () => ({ body: report }),
    });
    const user = userEvent.setup();
    renderScreen(<ImportsScreen />, client);

    await user.click(await screen.findByRole('button', { name: 'Details' }));
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole('cell')
          .map((cell) => cell.textContent),
      ),
    ).toEqual([
      ['18', 'site_name', 'Riverside Housing has no site called "Block Z".'],
      ['102', 'priority', '"whenever" is not a priority.'],
    ]);
    expect(screen.getByText('998 imported, 2 with problems')).toBeInTheDocument();
  });
});

describe('timesheets', () => {
  const SAM = ENGINEER;
  const ALEX = { id: '00000000-0000-4000-8000-000000000402', name: 'Alex Moore' };
  const DEE = { id: '00000000-0000-4000-8000-000000000403', name: 'Dee Walsh' };
  const BOILER = '00000000-0000-4000-8000-000000000121';
  const METER = '00000000-0000-4000-8000-000000000122';

  /** A local time on a day of the week being shown: 0 is Monday. */
  const at = (day: number, hours: number, minutes = 0) => {
    const date = addDays(startOfWeek(new Date()), day);
    date.setHours(hours, minutes);
    return date.toISOString();
  };
  const move = (
    actor: { id: string },
    workOrderId: string,
    fromState: WorkOrderState,
    toState: WorkOrderState,
    occurredAt: string,
  ): Timesheet['changes'][number] => ({
    workOrderId,
    fromState,
    toState,
    actorId: actor.id,
    occurredAt,
    recordedAt: occurredAt,
  });

  const sheet: Timesheet = {
    people: [SAM, ALEX, DEE],
    shifts: [
      {
        id: '00000000-0000-4000-8000-000000000131',
        userId: SAM.id,
        startedAt: at(0, 8, 0),
        endedAt: at(0, 16, 30),
        startLocation: null,
        endLocation: null,
      },
      {
        id: '00000000-0000-4000-8000-000000000132',
        userId: SAM.id,
        startedAt: at(1, 8, 0),
        endedAt: at(1, 12, 0),
        startLocation: null,
        endLocation: null,
      },
      {
        id: '00000000-0000-4000-8000-000000000133',
        userId: ALEX.id,
        startedAt: at(2, 7, 0),
        endedAt: null,
        startLocation: null,
        endLocation: null,
      },
    ],
    changes: [
      // The office dispatching is not time on a job.
      move(DEE, BOILER, 'scheduled', 'dispatched', at(0, 7, 0)),
      move(SAM, BOILER, 'dispatched', 'travelling', at(0, 9, 0)),
      move(SAM, BOILER, 'travelling', 'on_site', at(0, 9, 30)),
      move(SAM, BOILER, 'on_site', 'in_progress', at(0, 9, 40)),
      move(SAM, BOILER, 'in_progress', 'complete', at(0, 11, 40)),
      move(SAM, METER, 'dispatched', 'travelling', at(1, 8, 15)),
      move(SAM, METER, 'travelling', 'on_site', at(1, 8, 45)),
      move(SAM, METER, 'on_site', 'in_progress', at(1, 9, 0)),
      move(SAM, METER, 'in_progress', 'complete', at(1, 10, 15)),
    ],
    workOrders: [
      { id: BOILER, referenceLabel: 'WO-000121', title: 'Boiler service', state: 'complete' },
      { id: METER, referenceLabel: 'WO-000122', title: 'Meter fit', state: 'complete' },
    ],
    crews: [
      { workOrderId: BOILER, userId: SAM.id },
      { workOrderId: METER, userId: SAM.id },
    ],
    truncated: false,
  };

  it('adds up each person’s shifts and time on jobs for every day and the week', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': () => ({
        body: {
          userId: DEE.id,
          tenantId: CUSTOMER,
          email: 'd@x.example',
          displayName: DEE.name,
          role: 'dispatcher',
          permissions: ['work_order.manage'],
        },
      }),
      'GET /v1/members': () => ({ body: { items: [], nextCursor: null } }),
      'GET /v1/timesheets': () => ({ body: sheet }),
    });
    const { container } = renderScreen(<TimesheetsScreen />, client);

    const sam = await screen.findByRole('region', { name: 'Sam Carter' });
    const week = startOfWeek(new Date());
    const request = calls.find((call) => call.path === '/v1/timesheets')!;
    expect(request.query.get('from')).toBe(week.toISOString());
    expect(request.query.get('to')).toBe(addDays(week, 7).toISOString());
    expect(request.query.has('userId')).toBe(false);

    expect(definitions(within(sam).getByRole('group', { name: 'Week total' }))).toEqual({
      'Shift time': '12 h 30 min',
      Travel: '1 h 0 min',
      'On site': '25 min',
      Working: '3 h 15 min',
    });
    const days = within(sam).getAllByRole('group', { name: 'Day total' });
    expect(days.map((day) => definitions(day))).toEqual([
      { 'Shift time': '8 h 30 min', Travel: '30 min', 'On site': '10 min', Working: '2 h 0 min' },
      { 'Shift time': '4 h 0 min', Travel: '30 min', 'On site': '15 min', Working: '1 h 15 min' },
    ]);
    const [monday] = within(sam).getAllByRole('table');
    expect(
      within(monday!)
        .getAllByRole('row')
        .slice(1)
        .map((row) => [
          ...within(row)
            .queryAllByRole('rowheader')
            .map((cell) => cell.textContent),
          ...within(row)
            .getAllByRole('cell')
            .map((cell) => cell.textContent),
        ]),
    ).toEqual([['WO-000121 Boiler service', '30 min', '10 min', '2 h 0 min']]);

    // Still clocked in; the office moving jobs along is not a timesheet.
    const alex = screen.getByRole('region', { name: 'Alex Moore' });
    expect(within(alex).getByText('Clocked in')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Dee Walsh' })).not.toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Previous week' }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.path === '/v1/timesheets' &&
            call.query.get('from') === addDays(week, -7).toISOString(),
        ),
      ).toBe(true),
    );
  });

  it('says so when there is nothing in the week', async () => {
    const { client } = fakeApi({
      'GET /v1/me': () => ({
        body: {
          userId: SAM.id,
          tenantId: CUSTOMER,
          email: 's@x.example',
          displayName: SAM.name,
          role: 'engineer',
          permissions: [],
        },
      }),
      'GET /v1/timesheets': () => ({
        body: { people: [], shifts: [], changes: [], workOrders: [], crews: [], truncated: false },
      }),
    });
    renderScreen(<TimesheetsScreen />, client);
    expect(await screen.findByText('No shifts or time on jobs in this week.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Person')).not.toBeInTheDocument();
  });
});
