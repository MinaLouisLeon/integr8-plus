import { EGYPT_2026_RULES } from '@integr8/core';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  Employee,
  PayLine,
  PayrollRuleSet,
  PayRunDetail,
  PayRunSummary,
  Payslip,
  PayTerms,
} from '../api.js';
import { EmployeeScreen } from '../hr/employee-screen.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { MyPayslipsScreen } from './my-payslips.js';
import { PayRunsScreen } from './pay-run-list.js';
import { PayRunScreen } from './pay-run-screen.js';
import { PayrollRulesScreen } from './rule-sets.js';

const USER = '00000000-0000-4000-8000-000000000401';
const OTHER = '00000000-0000-4000-8000-000000000402';
const TENANT = '00000000-0000-4000-8000-000000000301';
const RUN = '00000000-0000-4000-8000-00000000b001';
const OLD_RUN = '00000000-0000-4000-8000-00000000b002';
const LINE = '00000000-0000-4000-8000-00000000b101';
const EMPLOYEE = '00000000-0000-4000-8000-00000000e001';
const NEWCOMER = '00000000-0000-4000-8000-00000000e002';
const RULES = '00000000-0000-4000-8000-00000000c001';
const TERMS = '00000000-0000-4000-8000-00000000d001';

const DISCLAIMER =
  'Integr8 calculates pay from the rule set your company confirmed. The figures must be checked by your accountant; Integr8 files nothing with the Tax Authority or NOSI.';

/** Who keeps payroll: an HR manager. */
const KEEPER = ['hr.read', 'hr.sensitive', 'hr.manage', 'payroll.run', 'payroll.approve'];
const ON = { hr: true, payroll: true };

const me =
  (
    permissions: string[],
    features: Record<string, boolean> = ON,
    role: 'owner' | 'hr_manager' | 'engineer' = 'hr_manager',
  ) =>
  () => ({
    body: {
      userId: USER,
      tenantId: TENANT,
      email: 'h@x.example',
      displayName: 'Hala',
      role,
      grants: [],
      permissions,
      features,
      company: { name: 'Riverside Services', slug: 'riverside' },
    },
  });

const line = (overrides: Partial<PayLine> = {}): PayLine => ({
  id: LINE,
  employee: { id: EMPLOYEE, name: 'Karim Adel' },
  basic: '12000',
  allowances: '1500',
  clockedHours: '220',
  overtimeHours: '12',
  overtimeRate: '77.88',
  bonus: '0',
  deduction: '0',
  unpaidDays: '0',
  reimbursements: '350',
  declaredInsurableWage: null,
  insured: true,
  payMethod: 'bank_transfer',
  note: null,
  overtimePay: '934.56',
  unpaidLeave: '0',
  gross: '14434.56',
  insurableWage: '13500',
  socialInsuranceEmployee: '1485',
  socialInsuranceEmployer: '2531.25',
  taxable: '12949.56',
  incomeTax: '1712.42',
  martyrsFund: '7.22',
  net: '11579.92',
  version: 1,
  ...overrides,
});

const TOTALS: PayRunDetail['totals'] = {
  employees: 1,
  gross: '14434.56',
  socialInsuranceEmployee: '1485',
  socialInsuranceEmployer: '2531.25',
  incomeTax: '1712.42',
  martyrsFund: '7.22',
  reimbursements: '350',
  net: '11579.92',
};

const run = (overrides: Partial<PayRunDetail> = {}): PayRunDetail => ({
  id: RUN,
  reference: 'PR-2026-10',
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  currency: 'EGP',
  status: 'draft',
  payDate: null,
  note: null,
  preparedBy: { id: OTHER, name: 'Nadia Samir' },
  preparedAt: '2026-10-10T09:00:00.000Z',
  approvedBy: null,
  approvedAt: null,
  approveBlockedBy: null,
  hrKeyConfigured: true,
  totals: TOTALS,
  version: 2,
  ruleSet: { id: RULES, name: 'Egypt 2026', effectiveFrom: '2026-01-01' },
  lines: [line()],
  withoutTerms: [],
  disclaimer: DISCLAIMER,
  can: {
    edit: true,
    approve: true,
    discard: true,
    exportBankFile: false,
    exportInsuranceReport: false,
  },
  ...overrides,
});

const summary = (overrides: Partial<PayRunSummary> = {}): PayRunSummary => {
  const {
    ruleSet: _ruleSet,
    lines: _lines,
    withoutTerms: _without,
    disclaimer: _disclaimer,
    can: _can,
    ...rest
  } = run();
  return { ...rest, ...overrides };
};

const payslip = (overrides: Partial<Payslip['line']> = {}): Payslip => ({
  company: { name: 'Nile Services', address: null, taxReference: null },
  run: {
    id: RUN,
    reference: 'PR-2026-10',
    periodStart: '2026-10-01',
    periodEnd: '2026-10-31',
    payDate: '2026-10-28',
    currency: 'EGP',
  },
  employee: {
    id: EMPLOYEE,
    name: 'Karim Adel',
    employeeNumber: 'E-014',
    jobTitle: 'Field engineer',
    department: 'Service',
    hireDate: '2025-03-01',
  },
  line: line({ bonus: '500', ...overrides }),
  disclaimer: DISCLAIMER,
});

const ruleSet = (overrides: Partial<PayrollRuleSet> = {}): PayrollRuleSet => ({
  id: RULES,
  name: 'Egypt 2026',
  effectiveFrom: '2026-01-01',
  rules: EGYPT_2026_RULES,
  confirmed: null,
  createdAt: '2026-01-02T09:00:00.000Z',
  version: 1,
  can: { edit: true, confirm: false, remove: true },
  ...overrides,
});

const ruleSets = (items: PayrollRuleSet[]) => ({
  body: {
    items,
    seed: { name: 'Egypt 2026', effectiveFrom: '2026-01-01', rules: EGYPT_2026_RULES },
    disclaimer: DISCLAIMER,
  },
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the pay runs', { timeout: 20_000 }, () => {
  it('lists each month with its status, totals and who prepared and approved it', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(KEEPER),
      'GET /v1/payroll/runs': () => ({
        body: {
          items: [
            summary(),
            summary({
              id: OLD_RUN,
              reference: 'PR-2026-09',
              periodStart: '2026-09-01',
              periodEnd: '2026-09-30',
              status: 'approved',
              approvedBy: { id: USER, name: 'Hala Nabil' },
              approvedAt: '2026-09-28T10:00:00.000Z',
            }),
          ],
          next: null,
          disclaimer: DISCLAIMER,
        },
      }),
    });
    const { container } = renderScreen(<PayRunsScreen />, client);

    expect(await screen.findByRole('link', { name: 'October 2026' })).toHaveAttribute(
      'href',
      `/hr/pay-runs/${RUN}`,
    );
    const september = screen.getByRole('row', { name: /September 2026/u });
    expect(within(september).getByText('Approved')).toBeInTheDocument();
    expect(within(september).getByText(/Approved by Hala Nabil/u)).toBeInTheDocument();
    const october = screen.getByRole('row', { name: /October 2026/u });
    expect(within(october).getByText('Draft')).toBeInTheDocument();
    expect(within(october).getByText(/Prepared by Nadia Samir/u)).toBeInTheDocument();
    expect(within(october).getByText('EGP 11,579.92')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'Check these figures' })).toHaveTextContent(
      'must be checked by your accountant',
    );
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('says plainly why a month cannot be prepared, and leads to what fixes it', async () => {
    const user = userEvent.setup();
    let answer: { status?: number; body?: unknown } = apiError(
      422,
      'no_confirmed_rules',
      'No rules',
    );
    const { client, calls } = fakeApi({
      'GET /v1/me': me(KEEPER),
      'GET /v1/payroll/runs': () => ({
        body: { items: [summary()], next: null, disclaimer: DISCLAIMER },
      }),
      'POST /v1/payroll/runs': () => answer,
    });
    const { container, navigate } = renderScreen(<PayRunsScreen />, client);
    await screen.findByRole('link', { name: 'October 2026' });

    const month = screen.getByLabelText('Month');
    fireEvent.change(month, { target: { value: '2026-11' } });
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    const refusal = await screen.findByRole('alert');
    expect(refusal).toHaveTextContent(/no confirmed rule set in force/u);
    expect(within(refusal).getByRole('link', { name: 'Go to the payroll rules' })).toHaveAttribute(
      'href',
      '/hr/payroll-rules',
    );
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ month: '2026-11' });
    expect(await accessibilityViolations(container)).toEqual([]);

    answer = apiError(422, 'rules_not_confirmed', 'Waiting');
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    expect(await screen.findByText(/waiting for the owner to confirm it/u)).toBeInTheDocument();

    // A month that has a run already leads to it.
    answer = apiError(409, 'month_taken', 'Taken');
    fireEvent.change(month, { target: { value: '2026-10' } });
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    expect(
      await screen.findByText(
        'There is already one for this month. Change it, or choose another month.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open PR-2026-10' })).toHaveAttribute(
      'href',
      `/hr/pay-runs/${RUN}`,
    );

    // The refusal names the month's run, even one the list does not show.
    answer = apiError(409, 'month_taken', 'Taken', [
      { field: 'body.month', code: 'month_taken', message: 'Taken', params: { runId: OLD_RUN } },
    ]);
    fireEvent.change(month, { target: { value: '2026-09' } });
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    expect(
      await screen.findByRole('link', { name: 'Open the run for that month' }),
    ).toHaveAttribute('href', `/hr/pay-runs/${OLD_RUN}`);

    answer = apiError(422, 'month_in_future', 'Too far');
    fireEvent.change(month, { target: { value: '2027-03' } });
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    expect(await screen.findByText(/Choose this month or next/u)).toBeInTheDocument();

    answer = { status: 201, body: run({ id: OLD_RUN }) };
    fireEvent.change(month, { target: { value: '2026-11' } });
    await user.click(screen.getByRole('button', { name: 'Prepare' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/hr/pay-runs/${OLD_RUN}`));
  });

  it('tells a seat without payroll that runs are not theirs, and asks for nothing', async () => {
    const { client, calls } = fakeApi({ 'GET /v1/me': me(['hr.read']) });
    renderScreen(<PayRunsScreen />, client);
    expect(
      await screen.findByText('Pay runs are for the owner and HR managers.'),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.path === '/v1/payroll/runs')).toBe(false);
  });
});

describe('one pay run', { timeout: 20_000 }, () => {
  it('shows the disclaimer, totals and lines, and who is left out for lack of pay terms', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(KEEPER),
      'GET /v1/payroll/runs/:id': () => ({
        body: run({ withoutTerms: [{ id: NEWCOMER, name: 'Omar Fathy' }] }),
      }),
    });
    const { container } = renderScreen(<PayRunScreen runId={RUN} />, client);

    expect(await screen.findByRole('heading', { name: /Pay for October 2026/u })).toBeVisible();
    expect(screen.getByRole('complementary', { name: 'Check these figures' })).toHaveTextContent(
      DISCLAIMER,
    );
    const totals = screen.getByRole('region', { name: 'Totals' });
    expect(within(totals).getByText('EGP 2,531.25')).toBeInTheDocument();
    expect(within(totals).getByText('EGP 11,579.92')).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /Karim Adel/u });
    expect(within(row).getByText('12 h')).toBeInTheDocument();
    expect(within(row).getByText('EGP 934.56')).toBeInTheDocument();
    expect(within(row).getByText('EGP 1,712.42')).toBeInTheDocument();
    const left = screen.getByRole('region', { name: '1 person is not in this run' });
    expect(within(left).getByRole('link', { name: 'Omar Fathy' })).toHaveAttribute(
      'href',
      `/hr/employees/${NEWCOMER}`,
    );
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('types a line’s bonus and unpaid days, checked first, and shows what the server worked out', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(KEEPER),
      'GET /v1/payroll/runs/:id': () => ({ body: run() }),
      'PATCH /v1/payroll/runs/:id/lines/:lineId': () => ({
        body: run({
          version: 3,
          preparedBy: { id: USER, name: 'Hala Nabil' },
          can: {
            edit: true,
            approve: false,
            discard: true,
            exportBankFile: false,
            exportInsuranceReport: false,
          },
          lines: [
            line({
              bonus: '500',
              unpaidDays: '2',
              unpaidLeave: '900',
              note: 'Eid bonus',
              net: '11179.92',
              version: 2,
            }),
          ],
        }),
      }),
    });
    const { container } = renderScreen(<PayRunScreen runId={RUN} />, client);

    await user.click(await screen.findByRole('button', { name: 'Edit the line for Karim Adel' }));
    const bonus = screen.getByRole('textbox', { name: 'Bonus for Karim Adel' });
    await user.clear(bonus);
    await user.type(bonus, '500');
    const days = screen.getByRole('textbox', { name: 'Unpaid days for Karim Adel' });
    await user.clear(days);
    await user.type(days, '31');
    await user.type(screen.getByLabelText('Note for Karim Adel'), 'Eid bonus');
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Save line' }));
    expect(await screen.findByText(/at most 30 unpaid days/u)).toBeInTheDocument();
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);

    await user.clear(days);
    await user.type(days, '2');
    await user.click(screen.getByRole('button', { name: 'Save line' }));

    expect(await screen.findByText('EGP 11,179.92')).toBeInTheDocument();
    expect(calls.find((call) => call.method === 'PATCH')).toMatchObject({
      path: `/v1/payroll/runs/${RUN}/lines/${LINE}`,
      body: {
        expectedRunVersion: 2,
        expectedVersion: 1,
        overtimeHours: '12',
        bonus: '500',
        deduction: '0',
        unpaidDays: '2',
        note: 'Eid bonus',
      },
    });
    expect(screen.getByText('Eid bonus')).toBeInTheDocument();
    // Having typed into it, this person is now its preparer: somebody else approves.
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });

  it('does not let whoever prepared the run approve it, and says why', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(KEEPER),
      'GET /v1/payroll/runs/:id': () => ({
        body: run({
          preparedBy: { id: USER, name: 'Hala Nabil' },
          approveBlockedBy: 'self_approval',
          can: {
            edit: true,
            approve: false,
            discard: true,
            exportBankFile: false,
            exportInsuranceReport: false,
          },
        }),
      }),
    });
    const { container } = renderScreen(<PayRunScreen runId={RUN} />, client);

    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(
      'You prepared this run, so somebody else approves it.',
    );
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('says a negative net holds approval back, and that the HR key is missing', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(KEEPER),
      'GET /v1/payroll/runs/:id': () => ({
        body: run({
          approveBlockedBy: 'negative_net',
          hrKeyConfigured: false,
          can: {
            edit: true,
            approve: false,
            discard: true,
            exportBankFile: false,
            exportInsuranceReport: false,
          },
        }),
      }),
    });
    const { container } = renderScreen(<PayRunScreen runId={RUN} />, client);

    const approve = await screen.findByRole('button', { name: 'Approve' });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAccessibleDescription(
      'Somebody’s net pay is below zero. Lower their deduction or unpaid days, then approve.',
    );
    expect(screen.getByText(/the HR data key is not set on the server/u)).toBeInTheDocument();
    // Without the key, no insurance report is offered, even to a seat that sees ID numbers.
    expect(screen.queryByRole('button', { name: 'Download the insurance report' })).toBeNull();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('approves a run somebody else prepared, and says when claims changed since', async () => {
    const user = userEvent.setup();
    let answer: { status?: number; body?: unknown } = apiError(
      409,
      'run_out_of_date',
      'Out of date',
    );
    const { client, calls } = fakeApi({
      'GET /v1/me': me(KEEPER),
      'GET /v1/payroll/runs/:id': () => ({ body: run() }),
      'POST /v1/payroll/runs/:id/approve': () => answer,
      'POST /v1/payroll/runs/:id/recalculate': () => ({ body: run({ version: 3 }) }),
    });
    renderScreen(<PayRunScreen runId={RUN} />, client);

    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    let dialog = await screen.findByRole('dialog', { name: 'Approve pay for October 2026' });
    expect(within(dialog).getByText('1 person is paid EGP 11,579.92 in all.')).toBeVisible();
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Recalculate it/u);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByRole('button', { name: 'Recalculate' }));
    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith('/recalculate'))?.body).toEqual({
        expectedVersion: 2,
      }),
    );

    answer = {
      body: run({
        version: 4,
        status: 'approved',
        approvedBy: { id: USER, name: 'Hala Nabil' },
        approvedAt: '2026-10-12T09:00:00.000Z',
        can: {
          edit: false,
          approve: false,
          discard: false,
          exportBankFile: true,
          exportInsuranceReport: false,
        },
      }),
    };
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    dialog = await screen.findByRole('dialog', { name: 'Approve pay for October 2026' });
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByRole('button', { name: 'Print payslips' })).toBeVisible();
    expect(calls.filter((call) => call.path.endsWith('/approve')).at(-1)!.body).toEqual({
      expectedVersion: 3,
    });
  });

  it('gives an approved run’s payslips to print and its insurance and bank files', async () => {
    const user = userEvent.setup();
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const download = vi.fn();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(KEEPER),
      'GET /v1/payroll/runs/:id': () => ({
        body: run({
          status: 'approved',
          payDate: '2026-10-28',
          approvedBy: { id: USER, name: 'Hala Nabil' },
          approvedAt: '2026-10-12T09:00:00.000Z',
          can: {
            edit: false,
            approve: false,
            discard: false,
            exportBankFile: true,
            exportInsuranceReport: true,
          },
        }),
      }),
      'GET /v1/payroll/runs/:id/insurance.csv': () => ({
        body: 'Employee,Insurance number\nKarim Adel,123',
      }),
      'GET /v1/payroll/runs/:id/bank.csv': () => apiError(503, 'hr_key_missing', 'No key'),
      'GET /v1/payroll/runs/:id/payslips': () => ({
        body: { items: [payslip(), payslip({ id: OTHER, note: 'Second' })] },
      }),
    });
    const { container } = renderScreen(<PayRunScreen runId={RUN} />, client, { download });

    expect(await screen.findByRole('heading', { name: /Pay for October 2026/u })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit the line for Karim Adel' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Download the insurance report' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [blob, filename] = download.mock.calls[0] as [Blob, string];
    expect(filename).toBe('PR-2026-10-insurance.csv');
    expect(blob.size).toBeGreaterThan(0);

    await user.click(screen.getByRole('button', { name: 'Download the bank file' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/HR data key is set on the server/u);
    expect(calls.filter((call) => call.path.endsWith('.csv'))).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Print payslips' }));
    const slips = await screen.findAllByRole('article', { name: 'Payslip for October 2026' });
    expect(slips).toHaveLength(2);
    expect(within(slips[0]!).getByText('Karim Adel')).toBeInTheDocument();
    // Who pays, as the server sends it.
    expect(within(slips[0]!).getByText('Nile Services')).toBeInTheDocument();
    expect(within(slips[0]!).getByText(DISCLAIMER)).toBeInTheDocument();
    expect(within(slips[0]!).getByText('EGP 11,579.92')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Print payslips' }));
    expect(print).toHaveBeenCalledTimes(1);

    // The same payslips in Arabic, right to left, on request.
    await user.selectOptions(screen.getByLabelText('Payslip language'), 'ar');
    const arabic = await screen.findAllByRole('article', { name: 'قسيمة راتب أكتوبر 2026' });
    expect(arabic[0]).toHaveAttribute('dir', 'rtl');
  });
});

describe('the payroll rules', { timeout: 20_000 }, () => {
  it('waits for the owner: an HR manager sees no way to confirm', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(KEEPER),
      'GET /v1/payroll/rule-sets': () => ruleSets([ruleSet()]),
    });
    const { container } = renderScreen(<PayrollRulesScreen />, client);

    expect(await screen.findByRole('heading', { name: 'Egypt 2026' })).toBeVisible();
    expect(screen.getByText('From January 2026')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for the owner to confirm it/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Confirm Egypt 2026' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit Egypt 2026' })).toBeVisible();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('lets the owner confirm with a note saying who checked the figures', async () => {
    const user = userEvent.setup();
    let confirmed = false;
    const { client, calls } = fakeApi({
      'GET /v1/me': me(['payroll.run', 'payroll.approve', 'hr.read'], ON, 'owner'),
      'GET /v1/payroll/rule-sets': () =>
        ruleSets([
          confirmed
            ? ruleSet({
                version: 2,
                confirmed: {
                  by: { id: USER, name: 'Hala Nabil' },
                  at: '2026-10-12T09:00:00.000Z',
                  note: 'Checked by Mona Saleh, our accountant',
                },
                can: { edit: false, confirm: false, remove: false },
              })
            : ruleSet({ can: { edit: true, confirm: true, remove: true } }),
        ]),
      'POST /v1/payroll/rule-sets/:id/confirm': () => {
        confirmed = true;
        return { body: ruleSet() };
      },
    });
    const { container } = renderScreen(<PayrollRulesScreen />, client);

    expect(await screen.findByText(/Waiting for you to confirm it/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Confirm Egypt 2026' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm Egypt 2026' });
    expect(await accessibilityViolations(container)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(within(dialog).getByText('Say who checked the figures.')).toBeInTheDocument();
    expect(calls.some((call) => call.path.endsWith('/confirm'))).toBe(false);

    await user.type(
      within(dialog).getByLabelText('Who checked these figures, and against what?'),
      'Checked by Mona Saleh, our accountant',
    );
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText(/Confirmed by Hala Nabil/u)).toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('/confirm'))!.body).toEqual({
      expectedVersion: 1,
      note: 'Checked by Mona Saleh, our accountant',
    });
    expect(screen.queryByRole('button', { name: 'Edit Egypt 2026' })).toBeNull();
  });

  it('says so when the server refuses anybody but the owner', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/me': me(KEEPER),
      'GET /v1/payroll/rule-sets': () =>
        ruleSets([ruleSet({ can: { edit: true, confirm: true, remove: true } })]),
      'POST /v1/payroll/rule-sets/:id/confirm': () => apiError(403, 'owner_only', 'Owner only'),
    });
    renderScreen(<PayrollRulesScreen />, client);
    await user.click(await screen.findByRole('button', { name: 'Confirm Egypt 2026' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm Egypt 2026' });
    await user.type(within(dialog).getByRole('textbox'), 'Checked');
    await user.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Only the owner confirms the figures payroll uses.',
    );
  });

  it('adds a set from the 2026 figures, checked against the core’s rules before it is sent', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(KEEPER),
      'GET /v1/payroll/rule-sets': () => ruleSets([]),
      'POST /v1/payroll/rule-sets': () => ({ status: 201, body: ruleSet() }),
    });
    const { container } = renderScreen(<PayrollRulesScreen />, client);

    await user.click(await screen.findByRole('button', { name: 'Add a rule set' }));
    expect(await screen.findByRole('heading', { name: 'Add a rule set' })).toBeVisible();
    expect(screen.getByLabelText('Name')).toHaveValue('Egypt 2026');
    expect(screen.getByLabelText('Personal exemption (a year)')).toHaveValue('20000');
    expect(screen.getByLabelText('Tax bands, band 2: rate')).toHaveValue('10');
    expect(screen.getByLabelText('Martyrs’ Fund rate (%)')).toHaveValue('0.05');
    expect(await accessibilityViolations(container)).toEqual([]);

    fireEvent.change(screen.getByLabelText('In force from'), { target: { value: '2027-01' } });
    await user.clear(screen.getByLabelText('Name'));
    await user.type(screen.getByLabelText('Name'), 'Egypt 2027');
    const rate = screen.getByLabelText('Tax bands, band 2: rate');
    await user.clear(rate);
    await user.type(rate, '120');
    const top = screen.getByLabelText('Tax bands, band 3: up to');
    await user.clear(top);
    await user.type(top, '50000');
    await user.click(screen.getByRole('button', { name: 'Add rule set' }));

    const problems = await screen.findByRole('alert');
    expect(problems).toHaveTextContent(
      'Tax bands, band 2: use a percentage such as 22.5, at most 100.',
    );
    expect(problems).toHaveTextContent('Tax bands: each band must end above the one before.');
    expect(rate).toHaveAttribute('aria-invalid', 'true');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    await user.clear(rate);
    await user.type(rate, '12.5');
    await user.clear(top);
    await user.type(top, '70000');
    await user.click(screen.getByRole('button', { name: 'Add rule set' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const sent = calls.find((call) => call.method === 'POST')!.body as {
      name: string;
      effectiveFrom: string;
      rules: typeof EGYPT_2026_RULES;
    };
    expect(sent.name).toBe('Egypt 2027');
    expect(sent.effectiveFrom).toBe('2027-01-01');
    expect(sent.rules.bands[1]).toEqual({ upTo: '55000', rate: '12.5' });
    expect(sent.rules.bands.at(-1)).toEqual({ upTo: null, rate: '27.5' });
    expect(sent.rules.tiers).toEqual(EGYPT_2026_RULES.tiers);
    expect(await screen.findByRole('button', { name: 'Add a rule set' })).toBeVisible();
  });
});

describe('payslips', { timeout: 20_000 }, () => {
  it('shows every member their own payslips, and prints one in Arabic, right to left', async () => {
    const user = userEvent.setup();
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    const { client } = fakeApi({
      'GET /v1/me': me(['expense.submit'], ON, 'engineer'),
      'GET /v1/hr/me/payslips': () => ({ body: { items: [payslip()] } }),
    });
    const { container } = renderScreen(<MyPayslipsScreen />, client, { locale: 'ar' });

    expect(await screen.findByRole('heading', { name: 'قسائم راتبي' })).toBeVisible();
    await user.click(await screen.findByRole('button', { name: /^عرض قسيمة راتب/u }));
    const slip = await screen.findByRole('article');
    expect(slip).toHaveAttribute('dir', 'rtl');
    expect(slip).toHaveAttribute('lang', 'ar');
    expect(within(slip).getByRole('heading')).toHaveTextContent(/^قسيمة راتب/u);
    expect(within(slip).getByText('صافي الأجر')).toBeInTheDocument();
    expect(within(slip).getByText('Karim Adel')).toBeInTheDocument();
    expect(within(slip).getByText(/يجب أن يراجع محاسبك هذه الأرقام/u)).toBeInTheDocument();
    expect(within(slip).getByText('المكافأة')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'طباعة' }));
    expect(print).toHaveBeenCalledTimes(1);
  });

  it('says when there are none, and that the module is off without payroll', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(['expense.submit'], { hr: true }, 'engineer'),
    });
    renderScreen(<MyPayslipsScreen />, client);
    expect(await screen.findByText(/not switched on/u)).toBeInTheDocument();

    const empty = fakeApi({
      'GET /v1/me': me(['expense.submit'], ON, 'engineer'),
      'GET /v1/hr/me/payslips': () => ({ body: { items: [] } }),
    });
    renderScreen(<MyPayslipsScreen />, empty.client);
    expect(await screen.findByText('No payslips yet.')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Pay terms on the employee screen
// ---------------------------------------------------------------------------

const employee = (): Employee => ({
  id: EMPLOYEE,
  employeeNumber: 'E-014',
  fullName: 'Karim Adel',
  jobTitle: 'Field engineer',
  department: 'Service',
  phone: null,
  hireDate: '2025-03-01',
  endDate: null,
  endReason: null,
  status: 'active',
  member: null,
  sensitive: null,
  emergencyContact: { name: null, phone: null },
  version: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  can: { edit: true, reveal: false },
});

const terms = (overrides: Partial<PayTerms> = {}): PayTerms => ({
  id: TERMS,
  employeeId: EMPLOYEE,
  effectiveFrom: '2026-01-01',
  basic: '12000',
  allowances: '1500',
  insured: true,
  insurableWage: null,
  standardHours: '208',
  overtimeRate: null,
  payMethod: 'bank_transfer',
  version: 1,
  ...overrides,
});

describe('pay terms on the employee screen', { timeout: 20_000 }, () => {
  it('lists dated terms and adds new ones, saying when a day is taken', async () => {
    const user = userEvent.setup();
    let added: { status?: number; body?: unknown } = apiError(409, 'date_taken', 'Taken');
    const { client, calls } = fakeApi({
      'GET /v1/me': me(KEEPER),
      'GET /v1/settings': () => ({ body: { currency: 'EGP' } }),
      'GET /v1/hr/employees/:id': () => ({ body: employee() }),
      'GET /v1/hr/employees/:id/pay-terms': () => ({ body: { items: [terms()] } }),
      'POST /v1/hr/employees/:id/pay-terms': () => added,
    });
    const { container } = renderScreen(<EmployeeScreen employeeId={EMPLOYEE} />, client);

    const pay = await screen.findByRole('region', { name: 'Pay' });
    expect(await within(pay).findByText('From January 1, 2026')).toBeInTheDocument();
    expect(within(pay).getByText('In force')).toBeInTheDocument();
    expect(within(pay).getByText('EGP 12,000.00')).toBeInTheDocument();
    expect(within(pay).getByText('135% of the hourly basic pay')).toBeInTheDocument();
    expect(within(pay).getByText('Insured on basic and allowances')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(within(pay).getByRole('button', { name: 'Add pay terms' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add pay terms' });
    fireEvent.change(within(dialog).getByLabelText('From'), { target: { value: '2026-11-01' } });
    await user.type(within(dialog).getByLabelText('Basic pay (a month)'), '12.345.6');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(within(dialog).getByLabelText('Basic pay (a month)')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    const basic = within(dialog).getByLabelText('Basic pay (a month)');
    await user.clear(basic);
    await user.type(basic, '14000');
    await user.type(within(dialog).getByLabelText('Overtime rate (an hour)'), '90');
    await user.selectOptions(within(dialog).getByLabelText('Paid by'), 'cash');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Pay terms already start that day.',
    );

    added = { status: 201, body: terms({ effectiveFrom: '2026-11-01', basic: '14000' }) };
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Add pay terms' })).not.toBeInTheDocument(),
    );
    expect(calls.filter((call) => call.method === 'POST').at(-1)!.body).toEqual({
      effectiveFrom: '2026-11-01',
      basic: '14000',
      allowances: '0',
      insured: true,
      insurableWage: null,
      standardHours: '208',
      overtimeRate: '90',
      payMethod: 'cash',
    });
  });

  it('is not there for a seat that does not keep payroll, nor without the module', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/me': me(['hr.read', 'hr.manage'], ON),
      'GET /v1/hr/employees/:id': () => ({ body: employee() }),
    });
    renderScreen(<EmployeeScreen employeeId={EMPLOYEE} />, client);
    expect(await screen.findByRole('heading', { name: /Karim Adel/u })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Pay' })).toBeNull();

    const off = fakeApi({
      'GET /v1/me': me(KEEPER, { hr: true }),
      'GET /v1/hr/employees/:id': () => ({ body: employee() }),
    });
    renderScreen(<EmployeeScreen employeeId={EMPLOYEE} />, off.client);
    await waitFor(() => expect(off.calls.some((call) => call.path === '/v1/me')).toBe(true));
    expect(screen.queryByRole('region', { name: 'Pay' })).toBeNull();
    expect([...calls, ...off.calls].some((call) => call.path.endsWith('/pay-terms'))).toBe(false);
  });
});
