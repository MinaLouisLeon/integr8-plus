import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { QualificationList, QualificationRecord, QualificationType } from '../api.js';
import { accessibilityViolations, fakeApi, renderScreen } from '../testing/render.js';
import { QualificationsScreen } from './qualifications-screen.js';

const AHMED = { id: '00000000-0000-4000-8000-0000000000a1', name: 'Ahmed Ali' };
const SARA = { id: '00000000-0000-4000-8000-0000000000a2', name: 'Sara Nabil' };
const GAS = '00000000-0000-4000-8000-000000000901';
const HEIGHTS = '00000000-0000-4000-8000-000000000902';
const WELDING = '00000000-0000-4000-8000-000000000903';

const READ = ['tenant.read', 'qualification.read', 'work_order.read_all'];
const MANAGE = [...READ, 'qualification.manage'];

function type(id: string, name: string, kind: 'skill' | 'certificate'): QualificationType {
  return {
    id,
    name,
    kind,
    description: null,
    version: 1,
    archived: false,
    archivedAt: null,
    createdAt: '2026-10-01T09:00:00.000Z',
  };
}

const TYPES = [
  type(GAS, 'Gas Safe', 'certificate'),
  type(HEIGHTS, 'Working at heights', 'certificate'),
  type(WELDING, 'Welding', 'skill'),
];

function record(
  id: string,
  person: { id: string; name: string },
  qualification: QualificationType,
  state: QualificationRecord['state'],
  expiresOn: string | null,
): QualificationRecord {
  return {
    id,
    person,
    qualificationType: { id: qualification.id, name: qualification.name, kind: qualification.kind },
    reference: qualification.kind === 'certificate' ? 'GS-1234' : null,
    issuedOn: '2025-01-01',
    expiresOn,
    notes: null,
    state,
    version: 2,
    attachments: [],
    createdAt: '2025-01-01T09:00:00.000Z',
    updatedAt: '2025-01-01T09:00:00.000Z',
    removedAt: null,
    removedBy: null,
  };
}

function list(manage: boolean): QualificationList {
  return {
    items: [
      record('00000000-0000-4000-8000-000000000a01', AHMED, TYPES[0]!, 'expired', '2026-10-01'),
      record('00000000-0000-4000-8000-000000000a02', AHMED, TYPES[2]!, 'no_expiry', null),
      record('00000000-0000-4000-8000-000000000a03', SARA, TYPES[1]!, 'expiring', '2026-11-10'),
      record('00000000-0000-4000-8000-000000000a04', SARA, TYPES[0]!, 'valid', '2027-06-30'),
    ],
    people: [
      { ...AHMED, role: 'engineer' },
      { ...SARA, role: 'engineer' },
    ],
    qualificationTypes: TYPES,
    settings: { warningDays: 30 },
    today: '2026-10-27',
    can: { manage },
  };
}

function routes(manage: boolean, extra: Parameters<typeof fakeApi>[0] = {}) {
  return fakeApi({
    'GET /v1/qualifications': () => ({ body: list(manage) }),
    'GET /v1/qualification-types': () => ({
      body: { items: TYPES, settings: { warningDays: 30 }, can: { manage } },
    }),
    ...extra,
  });
}

describe('skills and certificates', { timeout: 20_000 }, () => {
  it('is read-only for someone who may see the records but not keep them', async () => {
    const user = userEvent.setup();
    const { client } = routes(false);
    const { container } = renderScreen(<QualificationsScreen />, client, { permissions: READ });

    const table = await screen.findByRole('table', { name: 'Who holds what' });
    expect(screen.getByText('You can see who holds what but not change it.')).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(within(table).getByText('Expired')).toBeInTheDocument();
    expect(within(table).getByText('Expiring soon')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a record' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Renew/u })).not.toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Open Gas Safe of Ahmed Ali' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gas Safe of Ahmed Ali' });
    expect(within(dialog).getByLabelText('Number')).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: 'Save record' })).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Remove record' })).not.toBeInTheDocument();

    // The company's list, read-only too.
    await user.click(within(dialog).getAllByRole('button', { name: 'Close' }).at(-1)!);
    await user.click(screen.getByRole('button', { name: 'The company’s list' }));
    expect(await screen.findByRole('heading', { name: 'Welding' })).toBeInTheDocument();
    expect(
      screen.getByText('Holders and managers are warned 30 days before a certificate runs out.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Archive/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a qualification' })).not.toBeInTheDocument();
  });

  it('shows only what is expiring soon or expired, soonest first', async () => {
    const user = userEvent.setup();
    const { client } = routes(false);
    renderScreen(<QualificationsScreen />, client, { permissions: READ });

    const table = await screen.findByRole('table', { name: 'Who holds what' });
    await user.click(screen.getByRole('checkbox', { name: 'Expiring soon and expired only' }));
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Ahmed Ali') as unknown,
      expect.stringContaining('Sara Nabil') as unknown,
    ]);
    expect(rows[0]).toHaveTextContent('Expired');
    expect(rows[1]).toHaveTextContent('Expiring soon');
  });

  it('filters by person and qualification on the server', async () => {
    const user = userEvent.setup();
    const { client, calls } = routes(false);
    renderScreen(<QualificationsScreen />, client, { permissions: READ });

    await screen.findByRole('table', { name: 'Who holds what' });
    await user.selectOptions(screen.getByLabelText('Person'), SARA.id);
    await user.selectOptions(screen.getByLabelText('Qualification'), GAS);
    await waitFor(() => {
      const last = calls.filter((call) => call.path === '/v1/qualifications').at(-1)!;
      expect(last.query.get('userId')).toBe(SARA.id);
      expect(last.query.get('qualificationTypeId')).toBe(GAS);
    });
  });

  it('adds a record, and keeps a skill without an expiry', async () => {
    const user = userEvent.setup();
    const { client, calls } = routes(true, {
      'POST /v1/qualifications': (call) => ({
        status: 201,
        body: { ...list(true).items[0], ...(call.body as object) },
      }),
    });
    renderScreen(<QualificationsScreen />, client, { permissions: MANAGE });

    await user.click(await screen.findByRole('button', { name: 'Add a record' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a record' });
    await user.selectOptions(within(dialog).getByLabelText('Qualification'), WELDING);
    expect(within(dialog).getByLabelText('Valid until')).toBeDisabled();
    expect(within(dialog).getByText('A skill does not expire.')).toBeInTheDocument();

    await user.selectOptions(within(dialog).getByLabelText('Qualification'), GAS);
    await user.selectOptions(within(dialog).getByLabelText('Person'), SARA.id);
    await user.type(within(dialog).getByLabelText('Number'), 'GS-9');
    await user.type(within(dialog).getByLabelText('Issued on'), '2026-10-01');
    await user.type(within(dialog).getByLabelText('Valid until'), '2027-09-30');
    await user.click(within(dialog).getByRole('button', { name: 'Save record' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      userId: SARA.id,
      qualificationTypeId: GAS,
      reference: 'GS-9',
      issuedOn: '2026-10-01',
      expiresOn: '2027-09-30',
      notes: null,
    });
  });

  it('renews a certificate as a new record for the same person and qualification', async () => {
    const user = userEvent.setup();
    const { client, calls } = routes(true, {
      'POST /v1/qualifications': () => ({ status: 201, body: list(true).items[0] }),
    });
    renderScreen(<QualificationsScreen />, client, { permissions: MANAGE });

    await user.click(await screen.findByRole('button', { name: 'Renew Gas Safe of Ahmed Ali' }));
    const dialog = await screen.findByRole('dialog', { name: 'Renew Gas Safe for Ahmed Ali' });
    expect(within(dialog).getByLabelText('Person')).toHaveValue(AHMED.id);
    expect(within(dialog).getByLabelText('Person')).toBeDisabled();
    expect(within(dialog).getByLabelText('Qualification')).toHaveValue(GAS);
    expect(within(dialog).getByLabelText('Valid until')).toHaveValue('');
    await user.type(within(dialog).getByLabelText('Valid until'), '2028-10-01');
    await user.click(within(dialog).getByRole('button', { name: 'Save record' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toMatchObject({
      userId: AHMED.id,
      qualificationTypeId: GAS,
      expiresOn: '2028-10-01',
    });
    // The old record is left alone.
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('removes a record after asking, with the version it was loaded at', async () => {
    const user = userEvent.setup();
    const { client, calls } = routes(true, {
      'POST /v1/qualifications/:id/remove': () => ({ body: list(true).items[0] }),
    });
    renderScreen(<QualificationsScreen />, client, { permissions: MANAGE });

    await user.click(await screen.findByRole('button', { name: 'Edit Gas Safe of Ahmed Ali' }));
    const dialog = await screen.findByRole('dialog', { name: 'Gas Safe of Ahmed Ali' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove record' }));
    await user.click(within(dialog).getByRole('button', { name: 'Remove it' }));
    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith('/remove'))?.body).toEqual({
        expectedVersion: 2,
      }),
    );
  });

  it('archives a qualification and changes the warning period for a manager', async () => {
    const user = userEvent.setup();
    const { client, calls } = routes(true, {
      'PATCH /v1/qualification-types/:id': () => ({ body: { ...TYPES[2], archived: true } }),
      'PATCH /v1/qualification-settings': () => ({ body: { warningDays: 45 } }),
    });
    renderScreen(<QualificationsScreen />, client, { permissions: MANAGE });

    await user.click(await screen.findByRole('button', { name: 'The company’s list' }));
    await user.click(await screen.findByRole('button', { name: 'Archive Welding' }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
        expectedVersion: 1,
        archived: true,
      }),
    );

    const days = screen.getByLabelText('Warn this many days before');
    await user.clear(days);
    await user.type(days, '45');
    await user.click(
      within(screen.getByRole('region', { name: 'Expiry warnings' })).getByRole('button', {
        name: 'Save',
      }),
    );
    await waitFor(() =>
      expect(calls.find((call) => call.path === '/v1/qualification-settings')?.body).toEqual({
        warningDays: 45,
      }),
    );
  });

  it('shows someone who cannot read everybody’s records their own', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/me/qualifications': () => ({
        body: { items: [list(false).items[0]], settings: { warningDays: 30 }, today: '2026-10-27' },
      }),
    });
    renderScreen(<QualificationsScreen />, client, { permissions: ['tenant.read'] });

    expect(
      await screen.findByRole('heading', { name: 'My skills and certificates' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Gas Safe')).toBeInTheDocument();
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(calls.some((call) => call.path === '/v1/qualifications')).toBe(false);
  });
});
