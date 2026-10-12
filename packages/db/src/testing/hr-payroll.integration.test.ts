import { calculatePay, DEFAULT_CHART, EGYPT_2026_RULES, payMonth, toTenantId } from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PayLineInputs, PayRun, PayrollRuleSet } from '../repositories/hr-payroll.js';
import {
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
  withUnprotectedRepositories,
} from './harness.js';

/**
 * Migration 0038 (seventh round; ADR-0010): rule sets frozen once confirmed,
 * runs only on a confirmed set in force, approved by somebody other than
 * whoever prepared them and never changed after; claims paid through a run
 * name it; and an approved run posts one balanced journal.
 */

const PREPARER = '00000000-0000-4000-8000-00000000e901';
const APPROVER = '00000000-0000-4000-8000-00000000e902';

let owner: pg.Client;

const repos = <T>(
  tenant: TenantFixture,
  fn: Parameters<typeof withUnprotectedRepositories<T>>[1],
) => withUnprotectedRepositories(toTenantId(tenant.id), fn);

const chart = DEFAULT_CHART.map((account) => ({
  code: account.code,
  name: account.name.en,
  type: account.type,
  ...(account.role === undefined ? {} : { role: account.role }),
}));

async function members(tenant: TenantFixture) {
  await repos(tenant, async (tx) => {
    await tx.tenantUsers.create({
      userId: PREPARER,
      email: `preparer@${tenant.slug}.example`,
      displayName: 'Hana HR',
      role: 'hr_manager',
    });
    await tx.tenantUsers.create({
      userId: APPROVER,
      email: `approver@${tenant.slug}.example`,
      displayName: 'Omar Owner',
      role: 'admin',
    });
  });
}

async function employee(tenant: TenantFixture, fullName: string, userId: string | null = null) {
  const created = await repos(tenant, (tx) =>
    tx.hrEmployees.create({ fullName, hireDate: '2025-01-01', userId }, PREPARER),
  );
  if (typeof created === 'string') {
    throw new Error(created);
  }
  return created;
}

async function confirmedRules(tenant: TenantFixture): Promise<PayrollRuleSet> {
  const created = await repos(tenant, (tx) =>
    tx.hrPayroll.createRuleSet(
      { name: 'Egypt 2026', effectiveFrom: '2026-01-01', rules: EGYPT_2026_RULES },
      APPROVER,
    ),
  );
  if (typeof created === 'string') {
    throw new Error(created);
  }
  return (await repos(tenant, (tx) =>
    tx.hrPayroll.confirmRuleSet(created.id, created.version, APPROVER, 'Checked by our accountant'),
  ))!;
}

function line(basic: string, reimbursements = '0'): PayLineInputs & ReturnType<typeof result> {
  const inputs: PayLineInputs = {
    basic,
    allowances: '0',
    clockedHours: '0',
    overtimeHours: '0',
    overtimeRate: '0',
    bonus: '0',
    deduction: '0',
    unpaidDays: '0',
    reimbursements,
    declaredInsurableWage: null,
    insured: true,
    payMethod: 'bank_transfer',
    note: null,
  };
  return { ...inputs, ...result(inputs) };
}

function result(inputs: PayLineInputs) {
  const pay = calculatePay(
    { ...inputs, insurableWage: inputs.declaredInsurableWage },
    EGYPT_2026_RULES,
  );
  return {
    overtimePay: pay.overtimePay,
    unpaidLeave: pay.unpaidLeave,
    gross: pay.gross,
    insurableWage: pay.insurableWage,
    socialInsuranceEmployee: pay.socialInsuranceEmployee,
    socialInsuranceEmployer: pay.socialInsuranceEmployer,
    taxable: pay.taxable,
    incomeTax: pay.incomeTax,
    martyrsFund: pay.martyrsFund,
    net: pay.net,
  };
}

function period(month: string) {
  const { start, end } = payMonth(`${month}-01`);
  return { periodStart: start, periodEnd: end };
}

async function draft(tenant: TenantFixture, ruleSetId: string, month = '2026-10') {
  const run = await repos(tenant, (tx) =>
    tx.hrPayroll.createRun({ ...period(month), ruleSetId, currency: 'EGP' }, PREPARER),
  );
  if (run === 'month_taken') {
    throw new Error(run);
  }
  return run;
}

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
});

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

describe('rule sets', () => {
  it('change until confirmed, and never after', async () => {
    const tenant = await createTenant('payroll-rules');
    await members(tenant);
    const created = await repos(tenant, (tx) =>
      tx.hrPayroll.createRuleSet(
        { name: 'Egypt 2026', effectiveFrom: '2026-01-01', rules: EGYPT_2026_RULES },
        APPROVER,
      ),
    );
    if (typeof created === 'string') {
      throw new Error(created);
    }
    expect(created.rules).toEqual(EGYPT_2026_RULES);
    expect(
      await repos(tenant, (tx) =>
        tx.hrPayroll.createRuleSet(
          { name: 'Again', effectiveFrom: '2026-01-01', rules: EGYPT_2026_RULES },
          APPROVER,
        ),
      ),
    ).toBe('month_taken');
    // A run cannot use it yet.
    await expect(draft(tenant, created.id)).rejects.toMatchObject({
      constraint: 'hr_payroll_runs_rule_set_usable',
    });

    const confirmed = (await repos(tenant, (tx) =>
      tx.hrPayroll.confirmRuleSet(created.id, created.version, APPROVER, 'Checked against the law'),
    ))!;
    expect(confirmed.confirmedBy).toBe(APPROVER);
    await expect(
      owner.query(`update hr_payroll_rule_sets set rules = '{}'::jsonb where id = $1`, [
        confirmed.id,
      ]),
    ).rejects.toMatchObject({ constraint: 'hr_payroll_rule_sets_frozen' });
    await expect(
      owner.query(`delete from hr_payroll_rule_sets where id = $1`, [confirmed.id]),
    ).rejects.toMatchObject({ constraint: 'hr_payroll_rule_sets_frozen' });
    expect(await repos(tenant, (tx) => tx.hrPayroll.removeRuleSet(confirmed.id))).toBe(false);
    const forMonth = await repos(tenant, (tx) => tx.hrPayroll.ruleSetFor('2026-10-01'));
    expect(forMonth.confirmed?.id).toBe(confirmed.id);
  });
});

describe('pay runs', () => {
  let tenant: TenantFixture;
  let run: PayRun;

  it('are one a month, approved by somebody other than who prepared them', async () => {
    tenant = await createTenant('payroll-runs');
    await members(tenant);
    const rules = await confirmedRules(tenant);
    const settings = await repos(tenant, (tx) =>
      tx.ledger.setUp({ startDate: '2026-01-01', fiscalStartMonth: 1, chart }, APPROVER),
    );
    if (settings === 'already_set_up') {
      throw new Error(settings);
    }
    const hana = await employee(tenant, 'Hana HR', PREPARER);
    const sami = await employee(tenant, 'Sami Standalone');
    await repos(tenant, (tx) =>
      tx.hrPayroll.addTerms(
        sami.id,
        {
          effectiveFrom: '2026-01-01',
          basic: '10000',
          allowances: '2000',
          insured: true,
          insurableWage: null,
          standardHours: '208',
          overtimeRate: null,
          payMethod: 'cash',
        },
        PREPARER,
      ),
    );
    const candidates = await repos(tenant, (tx) =>
      tx.hrPayroll.candidates('2026-10-01', '2026-10-31'),
    );
    expect(candidates.map((candidate) => [candidate.fullName, candidate.terms?.basic])).toEqual([
      ['Hana HR', undefined],
      ['Sami Standalone', '10000'],
    ]);

    run = await draft(tenant, rules.id);
    expect(
      await repos(tenant, (tx) =>
        tx.hrPayroll.createRun(
          {
            periodStart: '2026-10-01',
            periodEnd: '2026-10-31',
            ruleSetId: rules.id,
            currency: 'EGP',
          },
          PREPARER,
        ),
      ),
    ).toBe('month_taken');
    await expect(
      owner.query(
        `insert into hr_payroll_runs (tenant_id, period_start, period_end, rule_set_id, currency, prepared_by)
         values ($1, '2026-11-02', '2026-11-30', $2, 'EGP', $3)`,
        [tenant.id, rules.id, PREPARER],
      ),
    ).rejects.toMatchObject({ constraint: 'hr_payroll_runs_month' });

    await repos(tenant, (tx) =>
      tx.hrPayroll.replaceLines(run.id, [
        { employeeId: hana.id, ...line('9000', '120.5') },
        { employeeId: sami.id, ...line('12000') },
      ]),
    );
    // Every piastre accounted for.
    await expect(
      owner.query(`update hr_payroll_lines set net = net + 1 where run_id = $1`, [run.id]),
    ).rejects.toMatchObject({ constraint: 'hr_payroll_lines_balance' });
    await expect(
      repos(tenant, (tx) => tx.hrPayroll.approveRun(run.id, run.version, PREPARER)),
    ).rejects.toMatchObject({ constraint: 'hr_payroll_runs_not_self_approved' });
  });

  it('never change once approved, and post one balanced journal', async () => {
    run = (await repos(tenant, (tx) => tx.hrPayroll.approveRun(run.id, run.version, APPROVER)))!;
    expect(run.status).toBe('approved');
    await expect(
      owner.query(`update hr_payroll_lines set note = 'later' where run_id = $1`, [run.id]),
    ).rejects.toMatchObject({ constraint: 'hr_payroll_runs_frozen' });
    await expect(
      owner.query(`delete from hr_payroll_runs where id = $1`, [run.id]),
    ).rejects.toMatchObject({ constraint: 'hr_payroll_runs_frozen' });
    expect(await repos(tenant, (tx) => tx.hrPayroll.discardRun(run.id))).toBe(false);

    const posting = await repos(tenant, (tx) => tx.ledger.postingBySource('payroll_run', run.id));
    expect(posting).toMatchObject({ status: 'posted', label: 'PR-2026-10' });
    const [lines, accounts] = await Promise.all([
      repos(tenant, (tx) => tx.ledger.lines(posting!.journalId!)),
      repos(tenant, (tx) => tx.ledger.accounts()),
    ]);
    const code = new Map(accounts.map((account) => [account.id, account.code]));
    const totals = (await repos(tenant, (tx) => tx.hrPayroll.totals([run.id]))).get(run.id)!;
    expect(totals).toMatchObject({ employees: 2, gross: '21000', reimbursements: '120.5' });
    expect(lines.map((entry) => [code.get(entry.accountId), entry.debit, entry.credit])).toEqual([
      ['6100', totals.gross, '0'],
      ['6110', totals.socialInsuranceEmployer, '0'],
      ['2410', '120.5', '0'],
      [
        '2320',
        '0',
        String(Number(totals.socialInsuranceEmployee) + Number(totals.socialInsuranceEmployer)),
      ],
      ['2310', '0', totals.incomeTax],
      ['2330', '0', totals.martyrsFund],
      ['2400', '0', totals.net],
    ]);
  });

  it('pay back the claims they carry, naming the run', async () => {
    const category = await repos(tenant, (tx) =>
      tx.hrExpenses.createCategory({ name: 'Fuel', accountId: null }, APPROVER),
    );
    if (category === 'name_taken') {
      throw new Error(category);
    }
    const { claim } = await repos(tenant, (tx) =>
      tx.hrExpenses.submit({
        claimantId: PREPARER,
        categoryId: category.id,
        spentOn: '2026-10-05',
        amount: '120.5',
        currency: 'EGP',
        description: 'Fuel',
      }),
    );
    const approved = (await repos(tenant, (tx) =>
      tx.hrExpenses.approve(claim.id, claim.version, APPROVER, 'payroll'),
    ))!;
    expect(
      (await repos(tenant, (tx) => tx.hrExpenses.awaitingPayroll([PREPARER]))).map((x) => x.id),
    ).toEqual([approved.id]);
    // Paid through payroll only with a run named.
    await expect(
      owner.query(
        `update hr_expense_claims set status = 'paid', paid_via = 'payroll', paid_at = now() where id = $1`,
        [approved.id],
      ),
    ).rejects.toMatchObject({ constraint: 'hr_expense_claims_payroll_pairing' });
    expect(
      await repos(tenant, (tx) => tx.hrExpenses.paidThroughPayroll([approved.id], run.id)),
    ).toBe(1);
    const paid = (await repos(tenant, (tx) => tx.hrExpenses.find(approved.id)))!;
    expect(paid).toMatchObject({ status: 'paid', paidVia: 'payroll', payrollRunId: run.id });
    // Nothing posts for it: the run's journal paid it.
    expect(
      await repos(tenant, (tx) => tx.ledger.postingBySource('expense_payment', paid.id)),
    ).toBeUndefined();
  });

  it('are discarded while drafts, lines and all', async () => {
    const rules = (await repos(tenant, (tx) => tx.hrPayroll.ruleSets()))[0]!;
    const november = await draft(tenant, rules.id, '2026-11');
    const sami = (await repos(tenant, (tx) => tx.hrEmployees.list({ q: 'Sami', limit: 5 })))
      .items[0]!;
    await repos(tenant, (tx) =>
      tx.hrPayroll.replaceLines(november.id, [{ employeeId: sami.id, ...line('12000') }]),
    );
    expect(await repos(tenant, (tx) => tx.hrPayroll.discardRun(november.id))).toBe(true);
    expect(await repos(tenant, (tx) => tx.hrPayroll.lines(november.id))).toEqual([]);
  });
});
