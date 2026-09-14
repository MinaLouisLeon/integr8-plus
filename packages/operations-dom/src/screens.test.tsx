import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ImportDetail, WorkOrderDetail } from './api.js';
import { ImportsScreen } from './screens/imports-screen.js';
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
      },
    ],
    attachments: [],
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

  it('offers exactly the transitions the server allows, and names the forms a completion is waiting for', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/work-orders/:id': () => ({ body: detail() }),
      'POST /v1/work-orders/:id/transitions': () =>
        apiError(
          409,
          'required_forms_missing',
          'Submit Gas safety record before completing this job.',
          [{ field: 'forms.0', code: 'required_form_missing', message: 'Gas safety record' }],
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
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Before completing, submit: Gas safety record',
    );
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
