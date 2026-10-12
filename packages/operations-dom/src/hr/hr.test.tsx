import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Employee } from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { EmployeeEditorScreen } from './employee-editor.js';
import { EmployeeListScreen } from './employee-list.js';
import { EmployeeScreen } from './employee-screen.js';
import { MyProfileScreen } from './my-profile.js';

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const MEMBER = '00000000-0000-4000-8000-000000000402';
const EMPLOYEE = '00000000-0000-4000-8000-00000000e001';
const NEW_EMPLOYEE = '00000000-0000-4000-8000-00000000e002';

const HR_MANAGER = ['hr.read', 'hr.sensitive', 'hr.manage'];
const ADMIN = ['hr.read'];

const me =
  (permissions: string[], features: Record<string, boolean> = { hr: true }) =>
  () => ({
    body: {
      userId: USER,
      tenantId: TENANT,
      email: 'h@x.example',
      displayName: 'Hala',
      role: 'hr_manager',
      grants: [],
      permissions,
      features,
      company: { name: 'Riverside Services', slug: 'riverside' },
    },
  });

const SENSITIVE: NonNullable<Employee['sensitive']> = {
  nationalId: { last4: '4321' },
  insuranceNumber: null,
  bankName: 'National Bank of Egypt',
  bankAccount: { last4: '7788' },
};

const employee = (overrides: Partial<Employee> = {}): Employee => ({
  id: EMPLOYEE,
  employeeNumber: 'E-014',
  fullName: 'Karim Adel',
  jobTitle: 'Field engineer',
  department: 'Service',
  phone: '+20 100 000 0000',
  hireDate: '2025-03-01',
  endDate: null,
  endReason: null,
  status: 'active',
  member: { userId: MEMBER, displayName: 'Karim Adel', role: 'engineer' },
  sensitive: SENSITIVE,
  emergencyContact: { name: 'Mona Adel', phone: '+20 111 111 1111' },
  version: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  can: { edit: true, reveal: true },
  ...overrides,
});

const page = (items: Employee[]) => ({
  body: { items, nextCursor: null, departments: ['Service', 'Stores'] },
});

describe('the employee list', { timeout: 20_000 }, () => {
  it('shows an HR manager the last four of each number, and offers to add someone', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/me': me(HR_MANAGER),
      'GET /v1/hr/employees': () => page([employee()]),
    });
    const { container } = renderScreen(<EmployeeListScreen />, client);

    expect(await screen.findByRole('link', { name: 'Karim Adel' })).toHaveAttribute(
      'href',
      `/hr/employees/${EMPLOYEE}`,
    );
    expect(screen.getByText('National ID ending 4321')).toBeInTheDocument();
    expect(screen.getByText('Bank account (IBAN) ending 7788')).toBeInTheDocument();
    expect(screen.queryByText(/Social insurance number ending/u)).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Add employee' })).toBeInTheDocument();
    expect(calls.find((call) => call.path === '/v1/hr/employees')?.query.get('status')).toBe(
      'active',
    );
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('shows an admin job details only: no numbers, and no way to add', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(ADMIN),
      'GET /v1/hr/employees': () =>
        page([employee({ sensitive: null, can: { edit: false, reveal: false } })]),
    });
    renderScreen(<EmployeeListScreen />, client);

    expect(await screen.findByRole('link', { name: 'Karim Adel' })).toBeInTheDocument();
    expect(screen.getByText('Field engineer · Service')).toBeInTheDocument();
    expect(screen.queryByText(/ending/u)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add employee' })).not.toBeInTheDocument();
  });

  it('filters by words, status and department', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(HR_MANAGER),
      'GET /v1/hr/employees': () => page([employee()]),
    });
    renderScreen(<EmployeeListScreen />, client);
    await screen.findByRole('link', { name: 'Karim Adel' });

    await user.type(screen.getByLabelText('Search'), 'karim');
    await user.selectOptions(screen.getByLabelText('Status'), 'all');
    await user.selectOptions(screen.getByLabelText('Department'), 'Stores');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    await waitFor(() => {
      const last = calls.filter((call) => call.path === '/v1/hr/employees').at(-1)!;
      expect(Object.fromEntries(last.query)).toEqual({
        status: 'all',
        q: 'karim',
        department: 'Stores',
        limit: '50',
      });
    });
  });

  it('says the module is off rather than failing', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(HR_MANAGER, { hr: false }),
      'GET /v1/hr/employees': () => apiError(403, 'feature_disabled', 'Not on'),
    });
    renderScreen(<EmployeeListScreen />, client);
    expect(await screen.findByRole('alert')).toHaveTextContent(/not switched on/u);
  });
});

describe('one employee', { timeout: 20_000 }, () => {
  it('shows a number in full only when asked, through the audited reveal, and asks again after hiding', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(HR_MANAGER),
      'GET /v1/hr/employees/:id': () => ({ body: employee() }),
      'POST /v1/hr/employees/:id/reveal': (call) => ({
        body: {
          field: (call.body as { field: string }).field,
          value: '29001011234321',
        },
      }),
    });
    const { container } = renderScreen(<EmployeeScreen employeeId={EMPLOYEE} />, client);

    expect(await screen.findByRole('heading', { name: /Karim Adel/u })).toBeInTheDocument();
    expect(screen.getByText('Ending 4321')).toBeInTheDocument();
    expect(screen.queryByText('29001011234321')).not.toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Show the full National ID' }));
    expect(await screen.findByText('29001011234321')).toBeInTheDocument();
    const reveals = () => calls.filter((call) => call.path.endsWith('/reveal'));
    expect(reveals().map((call) => call.body)).toEqual([{ field: 'nationalId' }]);

    await user.click(screen.getByRole('button', { name: 'Hide the full National ID' }));
    expect(screen.queryByText('29001011234321')).not.toBeInTheDocument();
    // Nothing kept: showing it again asks the server again, and is audited again.
    await user.click(screen.getByRole('button', { name: 'Show the full National ID' }));
    expect(await screen.findByText('29001011234321')).toBeInTheDocument();
    expect(reveals()).toHaveLength(2);
  });

  it('says plainly when the server has no HR key', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/me': me(HR_MANAGER),
      'GET /v1/hr/employees/:id': () => ({ body: employee() }),
      'POST /v1/hr/employees/:id/reveal': () => apiError(503, 'hr_key_missing', 'No key'),
    });
    renderScreen(<EmployeeScreen employeeId={EMPLOYEE} />, client);
    await user.click(
      await screen.findByRole('button', { name: 'Show the full Bank account (IBAN)' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent(/HR data key is set on the server/u);
  });

  it('refuses an end date before the hire date, then ends the employment with a reason', async () => {
    const user = userEvent.setup();
    let current = employee();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(HR_MANAGER),
      'GET /v1/hr/employees/:id': () => ({ body: current }),
      'PATCH /v1/hr/employees/:id': () => {
        current = employee({
          endDate: '2026-10-01',
          endReason: 'Resigned',
          status: 'ended',
          version: 4,
        });
        return { body: current };
      },
    });
    renderScreen(<EmployeeScreen employeeId={EMPLOYEE} />, client);

    await user.click(await screen.findByRole('button', { name: 'End employment' }));
    const dialog = screen.getByRole('dialog', { name: 'End employment' });
    const date = within(dialog).getByLabelText('End date');
    await user.clear(date);
    await user.type(date, '2025-01-15');
    await user.click(within(dialog).getByRole('button', { name: 'End employment' }));

    expect(within(dialog).getByText(/must be on or after the hire date/u)).toBeInTheDocument();
    expect(within(dialog).getByText('Give a reason.')).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);

    await user.clear(date);
    await user.type(date, '2026-10-01');
    await user.type(within(dialog).getByLabelText('Reason'), 'Resigned');
    await user.click(within(dialog).getByRole('button', { name: 'End employment' }));

    await waitFor(() =>
      expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
        expectedVersion: 3,
        endDate: '2026-10-01',
        endReason: 'Resigned',
      }),
    );
    expect(await screen.findByRole('button', { name: 'Bring back' })).toBeInTheDocument();
  });

  it('brings somebody back by clearing the end date and reason together', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(HR_MANAGER),
      'GET /v1/hr/employees/:id': () => ({
        body: employee({ endDate: '2026-10-01', endReason: 'Resigned', status: 'ended' }),
      }),
      'PATCH /v1/hr/employees/:id': () => ({ body: employee({ version: 5 }) }),
    });
    renderScreen(<EmployeeScreen employeeId={EMPLOYEE} />, client);
    await user.click(await screen.findByRole('button', { name: 'Bring back' }));
    const dialog = screen.getByRole('dialog', { name: 'Bring back' });
    await user.click(within(dialog).getByRole('button', { name: 'Bring back' }));
    await waitFor(() =>
      expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
        expectedVersion: 3,
        endDate: null,
        endReason: null,
      }),
    );
  });

  it('offers a reader no edit, no end and no reveal', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(ADMIN),
      'GET /v1/hr/employees/:id': () => ({
        body: employee({ sensitive: null, can: { edit: false, reveal: false } }),
      }),
    });
    renderScreen(<EmployeeScreen employeeId={EMPLOYEE} />, client);
    expect(await screen.findByRole('heading', { name: /Karim Adel/u })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'End employment' })).not.toBeInTheDocument();
    expect(screen.queryByText('ID and bank details')).not.toBeInTheDocument();
  });
});

describe('adding and changing an employee', { timeout: 20_000 }, () => {
  const members = () => ({
    body: {
      items: [
        {
          userId: MEMBER,
          email: 'k@x.example',
          displayName: 'Karim Adel',
          role: 'engineer',
          grants: [],
          status: 'active',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    },
  });

  it('sends a linked member, the job and the sealed numbers to someone who keeps them', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(HR_MANAGER),
      'GET /v1/members': members,
      'POST /v1/hr/employees': () => ({ status: 201, body: employee({ id: NEW_EMPLOYEE }) }),
    });
    const { navigate } = renderScreen(<EmployeeEditorScreen />, client);

    await user.selectOptions(await screen.findByLabelText('Member'), MEMBER);
    const hire = screen.getByLabelText('Hire date');
    await user.clear(hire);
    await user.type(hire, '2025-03-01');
    await user.type(screen.getByLabelText('Employee number'), 'E-014');
    await user.type(screen.getByLabelText('Job title'), 'Field engineer');
    await user.type(screen.getByLabelText('National ID'), '29001011234321');
    await user.type(screen.getByLabelText('Bank'), 'National Bank of Egypt');
    await user.click(screen.getByRole('button', { name: 'Add employee' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/hr/employees/${NEW_EMPLOYEE}`));
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.body).toEqual({
      userId: MEMBER,
      hireDate: '2025-03-01',
      employeeNumber: 'E-014',
      jobTitle: 'Field engineer',
      bankName: 'National Bank of Egypt',
      nationalId: '29001011234321',
    });
  });

  it('offers no sealed numbers to a seat without hr.sensitive, and sends none', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(['hr.read', 'hr.manage']),
      'GET /v1/members': members,
      'POST /v1/hr/employees': () => ({ status: 201, body: employee({ id: NEW_EMPLOYEE }) }),
    });
    renderScreen(<EmployeeEditorScreen />, client);

    await user.click(await screen.findByLabelText('Somebody who does not sign in'));
    await user.type(screen.getByLabelText('Full name'), 'Sayed the driver');
    expect(screen.queryByLabelText('National ID')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Bank account (IBAN)')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add employee' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const body = calls.find((call) => call.method === 'POST')!.body as Record<string, unknown>;
    expect(body.fullName).toBe('Sayed the driver');
    expect(body).not.toHaveProperty('userId');
    expect(body).not.toHaveProperty('nationalId');
    expect(body).not.toHaveProperty('bankAccount');
  });

  it('keeps an empty sealed number as it is, and clears one only when asked', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(HR_MANAGER),
      'GET /v1/members': members,
      'GET /v1/hr/employees/:id': () => ({ body: employee() }),
      'PATCH /v1/hr/employees/:id': () => ({ body: employee({ version: 4 }) }),
    });
    renderScreen(<EmployeeEditorScreen employeeId={EMPLOYEE} />, client);

    expect(await screen.findByText('Ends in 4321. Leave empty to keep it.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear the Bank account (IBAN)' }));
    expect(screen.getByText('Will be removed when you save.')).toBeInTheDocument();
    const title = screen.getByLabelText('Job title');
    await user.clear(title);
    await user.type(title, 'Senior engineer');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    await waitFor(() =>
      expect(calls.find((call) => call.method === 'PATCH')?.body).toEqual({
        expectedVersion: 3,
        jobTitle: 'Senior engineer',
        bankAccount: null,
      }),
    );
  });

  it('says what a refusal means', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/me': me(HR_MANAGER),
      'GET /v1/members': members,
      'POST /v1/hr/employees': () => apiError(409, 'member_taken', 'Taken'),
    });
    renderScreen(<EmployeeEditorScreen />, client);
    await user.selectOptions(await screen.findByLabelText('Member'), MEMBER);
    await user.click(screen.getByRole('button', { name: 'Add employee' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This member already has an employee profile.',
    );
  });

  it('turns away a seat that may not manage HR', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(ADMIN),
      'GET /v1/members': members,
    });
    renderScreen(<EmployeeEditorScreen />, client);
    expect(await screen.findByText(/Only the owner and HR managers/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add employee' })).not.toBeInTheDocument();
  });
});

describe('my own profile', { timeout: 20_000 }, () => {
  it('tells somebody without a profile to ask HR', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me([]),
      'GET /v1/hr/me': () => apiError(404, 'not_found', 'You have no employee profile yet.'),
    });
    renderScreen(<MyProfileScreen />, client);
    expect(
      await screen.findByText('You have no employee profile yet. Ask HR to add one.'),
    ).toBeInTheDocument();
  });

  it('shows the person their own details, and their own numbers on request', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me([]),
      'GET /v1/hr/me': () => ({ body: employee({ can: { edit: false, reveal: true } }) }),
      'POST /v1/hr/employees/:id/reveal': () => ({
        body: { field: 'bankAccount', value: 'EG380019000500000000263180002' },
      }),
    });
    renderScreen(<MyProfileScreen />, client);
    expect(await screen.findByText('Karim Adel')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show the full Bank account (IBAN)' }));
    expect(await screen.findByText('EG380019000500000000263180002')).toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('/reveal'))?.path).toBe(
      `/v1/hr/employees/${EMPLOYEE}/reveal`,
    );
  });
});
