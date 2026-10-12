import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * The ledger's reports and year-end close over HTTP (CRM/ERP plan, phase A1;
 * ADR-0009): a trial balance that balances, one account's running balance,
 * receivables against the documents behind them, a profit and loss and a
 * balance sheet; a year closed into retained earnings with its months locked,
 * reopened only by the owner with a reason, and closed again.
 */

let api: ApiHarness;
let staff: PlatformAdmin;
let owner: Member;
let admin: Member;
let viewer: Member;
const tokens = new Map<Member, string>();
let customerId: string;

/** Last calendar year: ended, so it can be closed. */
const LAST = String(new Date().getUTCFullYear() - 1);
const THIS = String(new Date().getUTCFullYear());
const day = (monthDay: string) => `${LAST}-${monthDay}`;

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
  method: 'GET' | 'POST' | 'DELETE',
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

let accounts: Map<string, string>;
const id = (accountCode: string) => accounts.get(accountCode)!;

interface Row {
  account: { code: string };
  amount: string;
}
interface Journal {
  id: string;
  kind: string;
  status: string;
  entryDate: string;
  lines: { account: { code: string }; debit: string; credit: string }[];
}
interface Year {
  start: string;
  end: string;
  status: string;
  lockedMonths: number;
  months: number;
  close: { journal: { id: string } } | null;
  reopened: { reason: string }[];
  can: { close: boolean; reopen: boolean };
}

const codes = (rows: Row[]) => rows.map((row) => [row.account.code, row.amount]);

/** Drafted by the admin, posted by the owner. */
async function journal(entryDate: string, lines: Record<string, unknown>[]) {
  const drafted = await call(admin, 'POST', '/v1/ledger/journals', { entryDate, lines });
  expect(drafted.statusCode, drafted.body).toBe(201);
  const posted = await call(
    owner,
    'POST',
    `/v1/ledger/journals/${json<{ id: string }>(drafted).id}/post`,
    {},
  );
  expect(posted.statusCode, posted.body).toBe(200);
  return json<Journal>(posted);
}

const years = async () =>
  json<{ items: Year[] }>(await call(viewer, 'GET', '/v1/ledger/years')).items;

beforeAll(async () => {
  api = await startApi();
  staff = await api.platformAdmin('lr-staff');
  owner = await api.member('owner', 'lr-owner');
  admin = await api.member('admin', 'lr-admin');
  viewer = await api.member('viewer', 'lr-viewer');
  const flag = await api.call(staff.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/ledger`,
    payload: { enabled: true },
  });
  expect(flag.statusCode, flag.body).toBe(200);
  const customer = await call(owner, 'POST', '/v1/customers', {
    name: 'Riverside Housing',
    address: { line1: '1 River Road', city: 'Cairo', countryCode: 'EG' },
  });
  customerId = json<{ id: string }>(customer).id;
  const setUp = await call(admin, 'POST', '/v1/ledger/setup', {
    startDate: `${LAST}-01-01`,
    fiscalStartMonth: 1,
  });
  expect(setUp.statusCode, setUp.body).toBe(201);
  accounts = new Map(
    json<{ items: { id: string; code: string }[] }>(
      await call(viewer, 'GET', '/v1/ledger/accounts'),
    ).items.map((account) => [account.code, account.id]),
  );
  await journal(day('03-15'), [
    { accountId: id('1110'), debit: '1000' },
    { accountId: id('4100'), credit: '1000' },
  ]);
  await journal(day('06-10'), [
    { accountId: id('6300'), debit: '400' },
    { accountId: id('1110'), credit: '400' },
  ]);
  await journal(day('07-01'), [
    { accountId: id('1200'), debit: '500', customerId },
    { accountId: id('4100'), credit: '500' },
  ]);
});

afterAll(async () => {
  await api.close();
});

describe('reports', () => {
  it('balance: the trial balance, one account’s running balance', async () => {
    const trial = json<{
      rows: { account: { code: string }; debit: string; credit: string }[];
      totals: { debit: string; credit: string; balanced: boolean };
      leftOut: { drafts: number; waiting: number };
    }>(await call(viewer, 'GET', `/v1/ledger/reports/trial-balance?date=${day('12-31')}`));
    expect(trial.rows.map((row) => [row.account.code, row.debit, row.credit])).toEqual([
      ['1110', '600', '0'],
      ['1200', '500', '0'],
      ['4100', '0', '1500'],
      ['6300', '400', '0'],
    ]);
    expect(trial.totals).toEqual({ debit: '1500', credit: '1500', balanced: true });
    expect(trial.leftOut).toEqual({ drafts: 0, waiting: 0 });

    const bank = json<{
      opening: string;
      lines: { debit: string; credit: string; balance: string; journal: { reference: string } }[];
      closing: string;
    }>(
      await call(
        viewer,
        'GET',
        `/v1/ledger/reports/account-activity?accountId=${id('1110')}&from=${day('03-01')}&to=${day('12-31')}`,
      ),
    );
    expect(bank.opening).toBe('0');
    expect(bank.lines.map((line) => [line.debit, line.credit, line.balance])).toEqual([
      ['1000', '0', '1000'],
      ['0', '400', '600'],
    ]);
    expect(bank.lines[0]!.journal.reference).toMatch(/^JV-\d{6}$/u);
    expect(bank.closing).toBe('600');
    const later = json<{ opening: string; lines: unknown[] }>(
      await call(
        viewer,
        'GET',
        `/v1/ledger/reports/account-activity?accountId=${id('1110')}&from=${day('04-01')}&to=${day('12-31')}`,
      ),
    );
    expect(later).toMatchObject({ opening: '1000' });
    expect(later.lines).toHaveLength(1);
  });

  it('reconcile receivables with the documents behind them', async () => {
    const report = json<{
      reconciliation: {
        ledger: string;
        documents: string;
        difference: string;
        customers: { customer: { id: string } | null; difference: string }[];
      };
      aging: { total: string; invoices: unknown[] };
    }>(await call(viewer, 'GET', `/v1/ledger/reports/receivables?date=${day('12-31')}`));
    // A journal by hand put 500 on receivables that no invoice explains.
    expect(report.reconciliation).toMatchObject({
      ledger: '500',
      documents: '0',
      difference: '500',
    });
    expect(report.reconciliation.customers).toEqual([
      expect.objectContaining({ customer: { id: customerId, name: 'Riverside Housing' } }),
    ]);
    expect(report.aging).toMatchObject({ total: '0', invoices: [] });
  });

  it('show profit and loss, and a balance sheet that balances', async () => {
    const profit = json<{ income: Row[]; expenses: Row[]; net: string }>(
      await call(
        viewer,
        'GET',
        `/v1/ledger/reports/profit-and-loss?from=${day('01-01')}&to=${day('12-31')}`,
      ),
    );
    expect(codes(profit.income)).toEqual([['4100', '1500']]);
    expect(codes(profit.expenses)).toEqual([['6300', '400']]);
    expect(profit.net).toBe('1100');
    expect(
      (
        await call(
          viewer,
          'GET',
          `/v1/ledger/reports/profit-and-loss?from=${day('12-31')}&to=${day('01-01')}`,
        )
      ).statusCode,
    ).toBe(422);

    const sheet = json<{
      assets: Row[];
      unclosedEarnings: string;
      totals: { assets: string; liabilitiesAndEquity: string; balanced: boolean };
    }>(await call(viewer, 'GET', `/v1/ledger/reports/balance-sheet?date=${day('12-31')}`));
    expect(codes(sheet.assets)).toEqual([
      ['1110', '600'],
      ['1200', '500'],
    ]);
    expect(sheet.unclosedEarnings).toBe('1100');
    expect(sheet.totals).toMatchObject({
      assets: '1100',
      liabilitiesAndEquity: '1100',
      balanced: true,
    });
  });
});

describe('closing a year', () => {
  it('waits for drafts, then moves income and expenses into retained earnings and locks the year', async () => {
    const before = (await years()).find((year) => year.start === `${LAST}-01-01`)!;
    expect(before).toMatchObject({ status: 'open', months: 12, can: { close: false } });
    const thisYear = await call(admin, 'POST', `/v1/ledger/years/${THIS}-01-01/close`);
    expect(code(thisYear)).toBe('year_not_ended');

    const draft = await call(admin, 'POST', '/v1/ledger/journals', {
      entryDate: day('11-30'),
      lines: [
        { accountId: id('6300'), debit: '10' },
        { accountId: id('1110'), credit: '10' },
      ],
    });
    expect(draft.statusCode, draft.body).toBe(201);
    expect(code(await call(admin, 'POST', `/v1/ledger/years/${LAST}-01-01/close`))).toBe(
      'year_not_ready',
    );
    await call(admin, 'DELETE', `/v1/ledger/journals/${json<{ id: string }>(draft).id}`);

    expect((await call(viewer, 'POST', `/v1/ledger/years/${LAST}-01-01/close`)).statusCode).toBe(
      403,
    );
    const closed = await call(admin, 'POST', `/v1/ledger/years/${LAST}-01-01/close`);
    expect(closed.statusCode, closed.body).toBe(201);
    const closing = json<Journal>(closed);
    expect(closing).toMatchObject({ kind: 'closing', status: 'posted', entryDate: day('12-31') });
    expect(closing.lines.map((line) => [line.account.code, line.debit, line.credit])).toEqual([
      ['4100', '1500', '0'],
      ['6300', '0', '400'],
      ['3200', '0', '1100'],
    ]);
    expect((await years()).find((year) => year.start === `${LAST}-01-01`)).toMatchObject({
      status: 'closed',
      lockedMonths: 12,
      close: { journal: { id: closing.id } },
      can: { close: false },
    });
    expect(code(await call(admin, 'POST', `/v1/ledger/years/${LAST}-01-01/close`))).toBe(
      'year_closed',
    );
    // The closing journal is reversed only by reopening the year.
    expect(code(await call(owner, 'POST', `/v1/ledger/journals/${closing.id}/reverse`, {}))).toBe(
      'closing_journal',
    );

    // The year still earned 1100; the balance sheet now holds it in retained earnings.
    const profit = json<{ net: string }>(
      await call(
        viewer,
        'GET',
        `/v1/ledger/reports/profit-and-loss?from=${day('01-01')}&to=${day('12-31')}`,
      ),
    );
    expect(profit.net).toBe('1100');
    const sheet = json<{ equity: Row[]; unclosedEarnings: string; totals: { balanced: boolean } }>(
      await call(viewer, 'GET', `/v1/ledger/reports/balance-sheet?date=${day('12-31')}`),
    );
    expect(codes(sheet.equity)).toEqual([['3200', '1100']]);
    expect(sheet).toMatchObject({ unclosedEarnings: '0', totals: { balanced: true } });
  });

  it('is reopened only by the owner, with a reason, and closed again', async () => {
    expect(
      code(
        await call(owner, 'POST', `/v1/ledger/periods/${LAST}-06-01/unlock`, {
          reason: 'Late supplier bill',
        }),
      ),
    ).toBe('year_closed');
    expect(
      (
        await call(admin, 'POST', `/v1/ledger/years/${LAST}-01-01/reopen`, {
          reason: 'Late supplier bill',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call(owner, 'POST', `/v1/ledger/years/${LAST}-01-01/reopen`, { reason: ' ' }))
        .statusCode,
    ).toBe(422);
    const reopened = await call(owner, 'POST', `/v1/ledger/years/${LAST}-01-01/reopen`, {
      reason: 'Late supplier bill',
    });
    expect(reopened.statusCode, reopened.body).toBe(200);
    expect(json<Journal>(reopened)).toMatchObject({
      kind: 'reversal',
      status: 'posted',
      entryDate: day('12-31'),
    });
    expect((await years()).find((year) => year.start === `${LAST}-01-01`)).toMatchObject({
      status: 'open',
      lockedMonths: 12,
      reopened: [{ reason: 'Late supplier bill' }],
    });

    // Unlock June, post the bill, close again.
    const unlocked = await call(owner, 'POST', `/v1/ledger/periods/${LAST}-06-01/unlock`, {
      reason: 'Late supplier bill',
    });
    expect(unlocked.statusCode, unlocked.body).toBe(204);
    await journal(day('06-20'), [
      { accountId: id('6300'), debit: '100' },
      { accountId: id('1110'), credit: '100' },
    ]);
    const again = await call(admin, 'POST', `/v1/ledger/years/${LAST}-01-01/close`);
    expect(again.statusCode, again.body).toBe(201);
    expect(
      json<Journal>(again).lines.map((line) => [line.account.code, line.debit, line.credit]),
    ).toEqual([
      ['4100', '1500', '0'],
      ['6300', '0', '500'],
      ['3200', '0', '1000'],
    ]);
    const sheet = json<{ equity: Row[]; totals: { balanced: boolean } }>(
      await call(viewer, 'GET', `/v1/ledger/reports/balance-sheet?date=${day('12-31')}`),
    );
    expect(codes(sheet.equity)).toEqual([['3200', '1000']]);
    expect(sheet.totals.balanced).toBe(true);
  });
});
