import {
  CUSTOM_ROLE_BASES,
  customRoleMayHold,
  type Permission,
  PERMISSIONS,
  permissionsFor,
} from '@integr8/core';
import { createI18n } from '@integr8/i18n';
import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { CompanyRole } from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { MemberRolePicker } from './member-role-picker.js';
import { groupOf, permissionGroups, roleDifference } from './role-parts.js';
import { CompanyRolesScreen } from './roles-screen.js';

const ROLE = '00000000-0000-4000-8000-0000000000a1';
const USER = '00000000-0000-4000-8000-000000000401';

const catalogue = () => ({
  body: {
    bases: CUSTOM_ROLE_BASES.map((role) => ({ role, permissions: permissionsFor(role) })),
    addable: PERMISSIONS.filter(customRoleMayHold),
  },
});

function companyRole(overrides: Partial<CompanyRole> = {}): CompanyRole {
  return {
    id: ROLE,
    name: 'Store lead',
    description: 'Runs the store and drafts orders.',
    baseRole: 'dispatcher',
    added: ['purchasing.approve'],
    removed: ['crm.lead.manage'],
    permissions: [
      ...permissionsFor('dispatcher').filter((permission) => permission !== 'crm.lead.manage'),
      'purchasing.approve',
    ],
    holders: 3,
    version: 2,
    createdAt: '2026-10-01T09:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

const list =
  (manage: boolean, items: CompanyRole[] = [companyRole()]) =>
  () => ({ body: { items, can: { manage } } });

describe('permission labels', () => {
  const english = createI18n({ locale: 'en' });
  const arabic = createI18n({ locale: 'ar' });
  const label = (instance: typeof english, key: string) =>
    instance.getResource(instance.language, 'translation', key) as unknown;

  it('names every permission, and every area, in English and Arabic', () => {
    const missing = PERMISSIONS.flatMap((permission) =>
      [english, arabic].flatMap((instance) =>
        typeof label(instance, `roles.permission.${permission}`) === 'string' &&
        typeof label(instance, `roles.group.${groupOf(permission)}`) === 'string'
          ? []
          : [`${instance.language}: ${permission}`],
      ),
    );
    expect(missing, `permissions with no label:\n${missing.join('\n')}`).toEqual([]);
  });

  it('groups by the name’s prefix and diffs against the base', () => {
    const groups = permissionGroups(['crm.lead.manage', 'inventory.read', 'crm.read']);
    expect(groups).toEqual([
      { group: 'crm', permissions: ['crm.read', 'crm.lead.manage'] },
      { group: 'inventory', permissions: ['inventory.read'] },
    ]);
    const held = new Set<Permission>(['crm.read', 'purchasing.approve']);
    expect(roleDifference(['crm.read', 'crm.lead.manage'], held)).toEqual({
      added: ['purchasing.approve'],
      removed: ['crm.lead.manage'],
    });
  });
});

describe('the company roles screen', { timeout: 30_000 }, () => {
  it('lets the owner build a role from the checklist and sends what differs from the base', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/roles': list(true, []),
      'GET /v1/roles/catalogue': catalogue,
      'POST /v1/roles': (call) => ({
        status: 201,
        body: companyRole({ ...(call.body as object), holders: 0, version: 1 }),
      }),
    });
    const { container } = renderScreen(
      <CompanyRolesScreen peoplePath="/settings/people" />,
      client,
    );

    expect(await screen.findByText('No company roles yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New role' }));

    const form = await screen.findByRole('form', { name: 'New company role' });
    await user.type(within(form).getByLabelText('Name'), 'Store lead');
    await user.selectOptions(within(form).getByLabelText('Based on'), 'dispatcher');

    // Grouped by area, each line saying whether the base holds it.
    const crm = within(form).getByRole('group', { name: 'CRM' });
    const leads = within(crm).getByRole('checkbox', { name: 'Manage leads' });
    expect(leads).toBeChecked();
    expect(leads).toHaveAccessibleDescription('In Dispatcher');
    const purchasing = within(form).getByRole('group', { name: 'Purchasing' });
    const approve = within(purchasing).getByRole('checkbox', { name: 'Approve purchase orders' });
    expect(approve).not.toBeChecked();
    expect(approve).toHaveAccessibleDescription('Not in Dispatcher');
    // The owner's own permissions are never offered.
    expect(within(form).queryByRole('checkbox', { name: 'Change company settings' })).toBeNull();
    expect(within(form).getByText('The same as Dispatcher.')).toBeInTheDocument();

    await user.click(leads);
    await user.click(approve);
    expect(within(form).getByText('Adds: Approve purchase orders')).toBeInTheDocument();
    expect(within(form).getByText('Takes away: Manage leads')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(within(form).getByRole('button', { name: 'Create role' }));

    expect(await screen.findByText('Store lead is created.')).toBeInTheDocument();
    const post = calls.find((call) => call.method === 'POST' && call.path === '/v1/roles');
    expect(post?.body).toEqual({
      name: 'Store lead',
      description: null,
      baseRole: 'dispatcher',
      added: ['purchasing.approve'],
      removed: ['crm.lead.manage'],
    });
  });

  it('shows everybody else the roles, read-only', async () => {
    const { client } = fakeApi({
      'GET /v1/roles': list(false),
      'GET /v1/roles/catalogue': catalogue,
    });
    renderScreen(<CompanyRolesScreen />, client);

    const row = (await screen.findByText('Store lead')).closest('tr')!;
    expect(within(row).getByText('Dispatcher')).toBeInTheDocument();
    expect(within(row).getByText('3')).toBeInTheDocument();
    expect(screen.getByText('Only the owner creates and changes company roles.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'New role' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Change|Archive/u })).toBeNull();
  });

  it('asks for archived roles when the filter is on', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/roles': (call) =>
        list(
          false,
          call.query.get('archived') === 'true'
            ? [companyRole({ archivedAt: '2026-10-05T09:00:00.000Z', holders: 0 })]
            : [],
        )(),
    });
    renderScreen(<CompanyRolesScreen />, client);

    await user.click(await screen.findByRole('checkbox', { name: 'Show archived roles' }));
    expect(await screen.findByText('Archived')).toBeInTheDocument();
    expect(calls.some((call) => call.query.get('archived') === 'true')).toBe(true);
  });

  it('warns that a change signs out its holders, and sends the version it changed', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/roles': list(true),
      'GET /v1/roles/catalogue': catalogue,
      'PUT /v1/roles/:id': (call) => ({
        body: companyRole({ ...(call.body as object), version: 3 }),
      }),
    });
    renderScreen(<CompanyRolesScreen />, client);

    await user.click(await screen.findByRole('button', { name: 'Change Store lead' }));
    const form = await screen.findByRole('form', { name: 'Change Store lead' });
    expect(within(form).getByText(/Based on Dispatcher/u)).toBeInTheDocument();
    expect(within(form).queryByLabelText('Based on')).toBeNull();
    expect(within(form).queryByText(/signs out everybody/u)).toBeNull();

    await user.click(within(form).getByRole('checkbox', { name: 'Record parts used' }));
    expect(within(form).getByText(/signs out everybody who holds it.*now: 3/u)).toBeVisible();
    await user.click(within(form).getByRole('button', { name: 'Save role' }));

    expect(await screen.findByText('Store lead is saved.')).toBeInTheDocument();
    const put = calls.find((call) => call.method === 'PUT');
    expect(put?.path).toBe(`/v1/roles/${ROLE}`);
    expect(put?.body).toEqual({
      name: 'Store lead',
      description: 'Runs the store and drafts orders.',
      added: ['purchasing.approve'],
      removed: ['crm.lead.manage', 'inventory.consume'],
      expectedVersion: 2,
    });
  });

  it('says in words why a role in use is not archived', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/roles': list(true),
      'GET /v1/roles/catalogue': catalogue,
      'POST /v1/roles/:id/archive': () =>
        apiError(409, 'role_in_use', 'Somebody holds this role. Give them another first.'),
    });
    renderScreen(<CompanyRolesScreen />, client);

    await user.click(await screen.findByRole('button', { name: 'Archive Store lead' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Somebody holds this role. Give them another role first.',
    );
  });

  it('says a taken name in words', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/roles': list(true),
      'GET /v1/roles/catalogue': catalogue,
      'POST /v1/roles': () => apiError(409, 'name_taken', 'Another role has this name.'),
    });
    renderScreen(<CompanyRolesScreen />, client);

    await user.click(await screen.findByRole('button', { name: 'New role' }));
    const form = await screen.findByRole('form', { name: 'New company role' });
    await user.type(within(form).getByLabelText('Name'), 'Store lead');
    await user.click(within(form).getByRole('button', { name: 'Create role' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'This name is already in use. Choose another.',
    );
  });

  it('reads right to left in Arabic, with Arabic labels', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/roles': list(true, []),
      'GET /v1/roles/catalogue': catalogue,
    });
    renderScreen(<CompanyRolesScreen />, client, { locale: 'ar' });

    await user.click(await screen.findByRole('button', { name: 'دور جديد' }));
    const form = await screen.findByRole('form', { name: 'دور جديد للشركة' });
    expect(within(form).getByRole('group', { name: 'المشتريات' })).toBeInTheDocument();
    expect(within(form).getByRole('checkbox', { name: 'اعتماد أوامر الشراء' })).toBeInTheDocument();
  });
});

describe('the member role picker', { timeout: 30_000 }, () => {
  const member = {
    userId: USER,
    displayName: 'Dee Dispatcher',
    role: 'engineer' as const,
    customRole: null,
  };
  const roles = ['admin', 'dispatcher', 'engineer', 'viewer'] as const;

  it('offers the company’s roles beside the built-in ones and sends a customRoleId', async () => {
    const user = userEvent.setup();
    const onChanged = vi.fn();
    const { client, calls } = fakeApi({
      'GET /v1/roles': list(false),
      'PATCH /v1/members/:userId/role': () => ({
        body: { ...member, role: 'dispatcher', customRole: { id: ROLE, name: 'Store lead' } },
      }),
    });
    renderScreen(<MemberRolePicker member={member} roles={roles} onChanged={onChanged} />, client);

    const picker = screen.getByRole('combobox', { name: 'Change role' });
    const option = await screen.findByRole('option', { name: 'Store lead (based on Dispatcher)' });
    expect(within(screen.getByRole('group', { name: 'Company roles' })).getByRole('option')).toBe(
      option,
    );
    await user.selectOptions(picker, option);

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(onChanged.mock.calls[0]![0]).toMatch(/next sign-in, within fifteen minutes/u);
    const patch = calls.find((call) => call.method === 'PATCH');
    expect(patch?.path).toBe(`/v1/members/${USER}/role`);
    expect(patch?.body).toEqual({ customRoleId: ROLE });
  });

  it('shows the member’s company role as chosen, and sends a built-in role as one', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/roles': list(false),
      'PATCH /v1/members/:userId/role': () => ({ body: member }),
    });
    renderScreen(
      <MemberRolePicker
        member={{ ...member, role: 'dispatcher', customRole: { id: ROLE, name: 'Store lead' } }}
        roles={roles}
      />,
      client,
    );

    const picker = screen.getByRole('combobox', { name: 'Change role' });
    await waitFor(() => expect(picker).toHaveDisplayValue('Store lead (based on Dispatcher)'));
    await user.selectOptions(picker, 'Viewer');
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({ role: 'viewer' }),
    );
  });

  it('says in words that only the owner gives a role beyond the giver’s own', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/roles': list(false),
      'PATCH /v1/members/:userId/role': () =>
        apiError(
          422,
          'role_beyond_own',
          'This role can do things you cannot, so only the owner gives it.',
          [
            {
              field: 'body.customRoleId',
              code: 'role_beyond_own',
              message: 'The owner gives this role.',
              params: { permissions: 'purchasing.approve' },
            },
          ],
        ),
    });
    renderScreen(<MemberRolePicker member={member} roles={roles} />, client);

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Change role' }),
      await screen.findByRole('option', { name: 'Store lead (based on Dispatcher)' }),
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(
      'This role can do things you cannot, so only the owner gives it.',
    );
    expect(alert).toHaveTextContent('What you do not hold yourself: Approve purchase orders');
    expect(alert).not.toHaveTextContent('The owner gives this role.');
  });
});
