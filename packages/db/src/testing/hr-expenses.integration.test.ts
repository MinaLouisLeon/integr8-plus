import { DEFAULT_CHART, toTenantId } from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExpenseClaim } from '../repositories/hr-expenses.js';
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
 * Migration 0037 (seventh round; ADR-0010): expense claims numbered and frozen
 * once submitted, moving forward only, never approved by their claimant; and
 * their postings — the category's expense against staff claims payable when
 * approved, staff claims payable against cash or bank when paid back.
 */

const CLAIMANT = '00000000-0000-4000-8000-00000000d901';
const APPROVER = '00000000-0000-4000-8000-00000000d902';

let owner: pg.Client;
let northwind: TenantFixture;

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
      userId: CLAIMANT,
      email: `claimant@${tenant.slug}.example`,
      displayName: 'Ed Engineer',
      role: 'engineer',
    });
    await tx.tenantUsers.create({
      userId: APPROVER,
      email: `approver@${tenant.slug}.example`,
      displayName: 'Ada Admin',
      role: 'admin',
    });
  });
}

async function category(tenant: TenantFixture, name: string, accountId: string | null = null) {
  const created = await repos(tenant, (tx) =>
    tx.hrExpenses.createCategory({ name, accountId }, APPROVER),
  );
  if (created === 'name_taken') {
    throw new Error(created);
  }
  return created;
}

async function claim(tenant: TenantFixture, categoryId: string, amount = '120.5') {
  const { claim: submitted } = await repos(tenant, (tx) =>
    tx.hrExpenses.submit({
      claimantId: CLAIMANT,
      categoryId,
      spentOn: '2026-10-05',
      amount,
      currency: 'EGP',
      description: 'Fuel for the van',
    }),
  );
  return submitted;
}

async function journalLines(
  tenant: TenantFixture,
  kind: 'expense_claim' | 'expense_payment',
  id: string,
) {
  const posting = await repos(tenant, (tx) => tx.ledger.postingBySource(kind, id));
  if (posting?.journalId === null || posting === undefined) {
    return { posting, lines: [] as [string, string, string][] };
  }
  const journalId = posting.journalId;
  const [lines, accounts] = await Promise.all([
    repos(tenant, (tx) => tx.ledger.lines(journalId)),
    repos(tenant, (tx) => tx.ledger.accounts()),
  ]);
  const code = new Map(accounts.map((account) => [account.id, account.code]));
  return {
    posting,
    lines: lines.map(
      (line) =>
        [code.get(line.accountId) ?? '?', line.debit, line.credit] as [string, string, string],
    ),
  };
}

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  northwind = await createTenant('expense-northwind');
  await members(northwind);
});

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

describe('claims', () => {
  it('are numbered when submitted, and a resent claim lands once', async () => {
    const fuel = await category(northwind, 'Fuel');
    expect(
      await repos(northwind, (tx) =>
        tx.hrExpenses.createCategory({ name: 'fuel', accountId: null }, APPROVER),
      ),
    ).toBe('name_taken');
    const first = await claim(northwind, fuel.id);
    const second = await claim(northwind, fuel.id);
    expect(second.reference).toBe(first.reference + 1);
    expect(first).toMatchObject({ status: 'submitted', amount: '120.5', spentOn: '2026-10-05' });

    const action = '00000000-0000-4000-8000-00000000d9aa';
    const sent = await repos(northwind, (tx) =>
      tx.hrExpenses.submit({
        claimantId: CLAIMANT,
        categoryId: fuel.id,
        spentOn: '2026-10-06',
        amount: '40',
        currency: 'EGP',
        description: 'Parking',
        clientActionId: action,
      }),
    );
    const again = await repos(northwind, (tx) =>
      tx.hrExpenses.submit({
        claimantId: CLAIMANT,
        categoryId: fuel.id,
        spentOn: '2026-10-06',
        amount: '40',
        currency: 'EGP',
        description: 'Parking',
        clientActionId: action,
      }),
    );
    expect(again).toEqual({ claim: sent.claim, created: false });
  });

  it('never change once submitted, move forward only, and are never approved by their claimant', async () => {
    const meals = await category(northwind, 'Meals');
    const submitted = await claim(northwind, meals.id);
    await expect(
      owner.query(`update hr_expense_claims set amount = 1 where id = $1`, [submitted.id]),
    ).rejects.toMatchObject({ constraint: 'hr_expense_claims_frozen' });
    await expect(
      repos(northwind, (tx) =>
        tx.hrExpenses.approve(submitted.id, submitted.version, CLAIMANT, 'direct'),
      ),
    ).rejects.toMatchObject({ constraint: 'hr_expense_claims_not_self_approved' });
    const withdrawn = (await repos(northwind, (tx) =>
      tx.hrExpenses.withdraw(submitted.id, submitted.version),
    ))!;
    expect(withdrawn.status).toBe('withdrawn');
    await expect(
      repos(northwind, (tx) =>
        tx.hrExpenses.approve(withdrawn.id, withdrawn.version, APPROVER, 'direct'),
      ),
    ).rejects.toMatchObject({ constraint: 'hr_expense_claims_transition' });
    await expect(
      owner.query(`delete from hr_expense_claims where id = $1`, [submitted.id]),
    ).rejects.toMatchObject({ constraint: 'hr_expense_claims_frozen' });
    // A stale version changes nothing.
    const other = await claim(northwind, meals.id);
    expect(
      await repos(northwind, (tx) =>
        tx.hrExpenses.reject(other.id, other.version + 1, APPROVER, 'No receipt'),
      ),
    ).toBeUndefined();
  });
});

describe('the ledger', () => {
  let tenant: TenantFixture;
  let approved: ExpenseClaim;

  it('posts an approved claim to its category’s account against staff claims payable', async () => {
    tenant = await createTenant('expense-ledger');
    await members(tenant);
    const settings = await repos(tenant, (tx) =>
      tx.ledger.setUp({ startDate: '2026-01-01', fiscalStartMonth: 1, chart }, APPROVER),
    );
    if (settings === 'already_set_up') {
      throw new Error(settings);
    }
    expect(settings.accounts.staffClaimsPayable).toBeDefined();
    const vehicles = (await repos(tenant, (tx) => tx.ledger.accountByCode('6200')))!;
    const fuel = await category(tenant, 'Fuel', vehicles.id);
    const other = await category(tenant, 'Sundries');

    const submitted = await claim(tenant, fuel.id, '250');
    approved = (await repos(tenant, (tx) =>
      tx.hrExpenses.approve(submitted.id, submitted.version, APPROVER, 'direct'),
    ))!;
    expect((await journalLines(tenant, 'expense_claim', approved.id)).lines).toEqual([
      ['6200', '250', '0'],
      ['2410', '0', '250'],
    ]);
    // Without an account of its own, a category posts to staff expenses.
    const sundry = await claim(tenant, other.id, '15');
    await repos(tenant, (tx) =>
      tx.hrExpenses.approve(sundry.id, sundry.version, APPROVER, 'payroll'),
    );
    expect((await journalLines(tenant, 'expense_claim', sundry.id)).lines).toEqual([
      ['6900', '15', '0'],
      ['2410', '0', '15'],
    ]);
  });

  it('posts paying it back by bank, and waits while expenses are switched off', async () => {
    const paid = (await repos(tenant, (tx) =>
      tx.hrExpenses.pay(approved.id, approved.version, APPROVER, 'bank_transfer', 'TRF-881'),
    ))!;
    expect(paid).toMatchObject({ status: 'paid', paidVia: 'bank_transfer' });
    const payment = await journalLines(tenant, 'expense_payment', paid.id);
    expect(payment.posting?.label).toMatch(/^EX-\d{6} paid$/u);
    expect(payment.lines).toEqual([
      ['2410', '250', '0'],
      ['1110', '0', '250'],
    ]);

    const settings = (await repos(tenant, (tx) => tx.ledger.settings()))!;
    await repos(tenant, (tx) =>
      tx.ledger.saveSettings(settings.version, { autoPostExpenses: false }, APPROVER),
    );
    const fuel = (await repos(tenant, (tx) => tx.hrExpenses.categories()))[0]!;
    const waiting = await claim(tenant, fuel.id, '30');
    await repos(tenant, (tx) =>
      tx.hrExpenses.approve(waiting.id, waiting.version, APPROVER, 'direct'),
    );
    expect(
      await repos(tenant, (tx) => tx.ledger.postingBySource('expense_claim', waiting.id)),
    ).toMatchObject({
      status: 'pending',
      reason: 'auto_off',
      amount: '30',
    });
  });
});
