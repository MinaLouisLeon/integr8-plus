import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Egyptian payroll over HTTP (seventh round; ADR-0010): rule sets the owner
 * confirms, pay terms, a month's run prepared by one person and approved by
 * another, the claims it pays back, the journal it posts, payslips for the
 * office and for the employee, and the insurance and bank files.
 */

let api: ApiHarness;
let staff: PlatformAdmin;
let owner: Member;
let admin: Member;
let payroller: Member;
let engineer: Member;
const tokens = new Map<Member, string>();

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

async function token(who: Member): Promise<string> {
  let value = tokens.get(who);
  if (value === undefined) {
    value = await api.signIn(who);
    tokens.set(who, value);
  }
  return value;
}

async function call(
  who: Member,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
) {
  return api.call(await token(who), {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    ...(method === 'POST' ? { headers: { 'idempotency-key': randomUUID() } } : {}),
  });
}

async function flag(key: string, enabled: boolean) {
  const response = await api.call(staff.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

interface RuleSet {
  id: string;
  version: number;
  confirmed: { note: string } | null;
  can: { edit: boolean; confirm: boolean; remove: boolean };
}

interface Line {
  id: string;
  employee: { id: string; name: string };
  bonus: string;
  gross: string;
  reimbursements: string;
  incomeTax: string;
  net: string;
  version: number;
}

interface Run {
  id: string;
  reference: string;
  status: string;
  version: number;
  lines: Line[];
  withoutTerms: { name: string }[];
  totals: { employees: number; gross: string; net: string; reimbursements: string };
  can: { edit: boolean; approve: boolean; discard: boolean; exportBankFile: boolean };
}

const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);
let categoryId: string;

async function claim(amount: string) {
  const submitted = await call(engineer, 'POST', '/v1/expenses', {
    categoryId,
    spentOn: today,
    amount,
    description: 'Fuel',
  });
  expect(submitted.statusCode, submitted.body).toBe(201);
  const body = json<{ id: string; version: number }>(submitted);
  const approved = await call(admin, 'POST', `/v1/expenses/${body.id}/approve`, {
    expectedVersion: body.version,
    settleVia: 'payroll',
  });
  expect(approved.statusCode, approved.body).toBe(200);
  return body.id;
}

beforeAll(async () => {
  api = await startApi({ env: { HR_DATA_KEY: randomBytes(32).toString('base64') } });
  staff = await api.platformAdmin('pay-staff');
  owner = await api.member('owner', 'pay-owner');
  admin = await api.member('admin', 'pay-admin');
  payroller = await api.member('hr_manager', 'pay-payroller');
  engineer = await api.member('engineer', 'pay-engineer');
});

afterAll(async () => {
  await api.close();
});

describe('rule sets', () => {
  it('need the payroll module, which needs hr', async () => {
    expect(code(await call(payroller, 'GET', '/v1/payroll/rule-sets'))).toBe('feature_disabled');
    await flag('payroll', true);
    expect(code(await call(payroller, 'GET', '/v1/payroll/rule-sets'))).toBe('feature_disabled');
    await flag('hr', true);
    const listed = await call(payroller, 'GET', '/v1/payroll/rule-sets');
    expect(listed.statusCode, listed.body).toBe(200);
    expect(json<{ seed: { rules: { siEmployeeRate: string } } }>(listed).seed.rules).toMatchObject({
      siEmployeeRate: '11',
    });
    expect((await call(admin, 'GET', '/v1/payroll/rule-sets')).statusCode).toBe(403);
  });

  it('are confirmed by the owner alone, and frozen after', async () => {
    const created = await call(payroller, 'POST', '/v1/payroll/rule-sets', {
      name: 'Egypt 2026',
      effectiveFrom: '2026-01-01',
    });
    expect(created.statusCode, created.body).toBe(201);
    const set = json<RuleSet>(created);
    expect(set.can).toMatchObject({ edit: true, confirm: false });
    // Nothing runs on figures nobody confirmed.
    expect(code(await call(payroller, 'POST', '/v1/payroll/runs', { month }))).toBe(
      'rules_not_confirmed',
    );
    expect(
      code(
        await call(payroller, 'POST', `/v1/payroll/rule-sets/${set.id}/confirm`, {
          expectedVersion: set.version,
          note: 'Checked',
        }),
      ),
    ).toBe('owner_only');
    const confirmed = await call(owner, 'POST', `/v1/payroll/rule-sets/${set.id}/confirm`, {
      expectedVersion: set.version,
      note: 'Checked by Hany, our accountant, against the 2026 guides',
    });
    expect(json<RuleSet>(confirmed).confirmed?.note).toMatch(/Hany/u);
    expect(
      code(
        await call(payroller, 'PATCH', `/v1/payroll/rule-sets/${set.id}`, {
          expectedVersion: set.version + 1,
          name: 'Changed',
        }),
      ),
    ).toBe('confirmed');
  });
});

describe('a pay run', () => {
  let run: Run;
  let engineerEmployee: string;
  let firstClaim: string;

  it('proposes everyone with pay terms, and the claims waiting for payroll', async () => {
    await flag('ledger', true);
    const setUp = await call(owner, 'POST', '/v1/ledger/setup', { startDate: '2026-01-01' });
    expect(setUp.statusCode, setUp.body).toBe(201);
    const category = await call(admin, 'POST', '/v1/expenses/categories', { name: 'Fuel' });
    categoryId = json<{ id: string }>(category).id;

    const linked = await call(payroller, 'POST', '/v1/hr/employees', {
      userId: engineer.userId,
      employeeNumber: 'P-1',
      hireDate: '2025-02-01',
      insuranceNumber: '12345678',
      bankName: 'National Bank',
      bankAccount: 'EG380019000500000000263180002',
    });
    expect(linked.statusCode, linked.body).toBe(201);
    engineerEmployee = json<{ id: string }>(linked).id;
    const standalone = await call(payroller, 'POST', '/v1/hr/employees', {
      fullName: 'Sami Standalone',
      hireDate: '2025-02-01',
    });
    const samiId = json<{ id: string }>(standalone).id;
    const nobody = await call(payroller, 'POST', '/v1/hr/employees', {
      fullName: 'Nadia No Terms',
      hireDate: '2025-02-01',
    });
    expect(nobody.statusCode).toBe(201);

    const terms = await call(payroller, 'POST', `/v1/hr/employees/${engineerEmployee}/pay-terms`, {
      effectiveFrom: '2026-01-01',
      basic: '10000',
      allowances: '2000',
    });
    expect(terms.statusCode, terms.body).toBe(201);
    expect(
      code(
        await call(payroller, 'POST', `/v1/hr/employees/${engineerEmployee}/pay-terms`, {
          effectiveFrom: '2026-01-01',
          basic: '1',
        }),
      ),
    ).toBe('date_taken');
    await call(payroller, 'POST', `/v1/hr/employees/${samiId}/pay-terms`, {
      effectiveFrom: '2026-01-01',
      basic: '6000',
      payMethod: 'cash',
    });

    firstClaim = await claim('120.5');
    const created = await call(payroller, 'POST', '/v1/payroll/runs', { month });
    expect(created.statusCode, created.body).toBe(201);
    run = json<Run>(created);
    expect(run).toMatchObject({ status: 'draft', reference: `PR-${month}` });
    expect(run.withoutTerms.map((person) => person.name)).toEqual(['Nadia No Terms']);
    const mine = run.lines.find((line) => line.employee.id === engineerEmployee)!;
    // 10,000 + 2,000 gross; the claim paid back on top, untaxed.
    expect(mine).toMatchObject({ gross: '12000', incomeTax: '948.5', reimbursements: '120.5' });
    expect(mine.net).toBe('9846');
    expect(code(await call(payroller, 'POST', '/v1/payroll/runs', { month }))).toBe('month_taken');
  });

  it('is edited by whoever prepares it, and approved by somebody else', async () => {
    const mine = run.lines.find((line) => line.employee.id === engineerEmployee)!;
    const edited = await call(payroller, 'PATCH', `/v1/payroll/runs/${run.id}/lines/${mine.id}`, {
      expectedRunVersion: run.version,
      expectedVersion: mine.version,
      bonus: '500',
    });
    expect(edited.statusCode, edited.body).toBe(200);
    run = json<Run>(edited);
    expect(run.lines.find((line) => line.id === mine.id)?.gross).toBe('12500');
    expect(run.can.approve).toBe(false);
    expect(
      code(
        await call(payroller, 'POST', `/v1/payroll/runs/${run.id}/approve`, {
          expectedVersion: run.version,
        }),
      ),
    ).toBe('self_approval');

    // A claim approved since: the run is out of date until recalculated.
    await claim('30');
    expect(
      code(
        await call(owner, 'POST', `/v1/payroll/runs/${run.id}/approve`, {
          expectedVersion: run.version,
        }),
      ),
    ).toBe('run_out_of_date');
    const again = await call(payroller, 'POST', `/v1/payroll/runs/${run.id}/recalculate`, {
      expectedVersion: run.version,
    });
    run = json<Run>(again);
    const refreshed = run.lines.find((line) => line.employee.id === engineerEmployee)!;
    // The bonus typed for the run stays.
    expect(refreshed).toMatchObject({ bonus: '500', reimbursements: '150.5' });

    const approved = await call(owner, 'POST', `/v1/payroll/runs/${run.id}/approve`, {
      expectedVersion: run.version,
    });
    expect(approved.statusCode, approved.body).toBe(200);
    run = json<Run>(approved);
    expect(run).toMatchObject({ status: 'approved', can: { edit: false, exportBankFile: true } });
    expect(
      json<{ status: string; paidVia: string }>(
        await call(engineer, 'GET', `/v1/expenses/${firstClaim}`),
      ),
    ).toMatchObject({ status: 'paid', paidVia: 'payroll' });
    expect((await call(payroller, 'DELETE', `/v1/payroll/runs/${run.id}`)).statusCode).toBe(409);

    const posted = json<{ items: { source: { kind: string; id: string }; status: string }[] }>(
      await call(owner, 'GET', '/v1/ledger/postings?status=posted&limit=200'),
    ).items.filter((item) => item.source.id === run.id);
    expect(posted.map((item) => item.source.kind)).toEqual(['payroll_run']);
  });

  it('gives payslips to the office and to the employee, and the insurance and bank files', async () => {
    const slips = json<{ items: { employee: { name: string }; disclaimer: string }[] }>(
      await call(payroller, 'GET', `/v1/payroll/runs/${run.id}/payslips`),
    );
    expect(slips.items).toHaveLength(2);
    expect(slips.items[0]?.disclaimer).toMatch(/accountant/u);
    const own = json<{ items: { run: { reference: string }; line: { net: string } }[] }>(
      await call(engineer, 'GET', '/v1/hr/me/payslips'),
    );
    expect(own.items.map((slip) => slip.run.reference)).toEqual([`PR-${month}`]);

    const bank = await call(payroller, 'GET', `/v1/payroll/runs/${run.id}/bank.csv`);
    expect(bank.statusCode, bank.body).toBe(200);
    expect(bank.headers['cache-control']).toBe('no-store');
    // Sami is paid in cash: only the engineer's transfer, with the full account.
    const rows = bank.body.trim().split('\r\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('EG380019000500000000263180002');
    expect(rows[1]).toContain(`PR-${month}`);

    const insurance = await call(payroller, 'GET', `/v1/payroll/runs/${run.id}/insurance.csv`);
    expect(insurance.body).toContain('12345678');
    expect(insurance.body.trim().split('\r\n').at(-1)).toMatch(/^Total,/u);
    expect((await call(admin, 'GET', `/v1/payroll/runs/${run.id}/bank.csv`)).statusCode).toBe(403);
  });
});
