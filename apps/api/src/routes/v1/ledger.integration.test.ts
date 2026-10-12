import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * The general ledger over HTTP (CRM/ERP plan, phase A1; ADR-0009): the module
 * switch, who reads and who posts, setting up with the default chart, the
 * chart's rules, manual journals approved by a second person, self-approval
 * the owner's to allow, months locked by owners and admins and unlocked only
 * by the owner with a reason, reversals once, and the opening balances.
 */

let api: ApiHarness;
let staff: PlatformAdmin;
let owner: Member;
let admin: Member;
let dispatcher: Member;
let viewer: Member;
const tokens = new Map<Member, string>();
let customerId: string;

/** The ledger starts next month, so today's invoices are before it. */
const now = new Date();
const START = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
  .toISOString()
  .slice(0, 10);
const day = (n: number) => `${START.slice(0, 8)}${String(n).padStart(2, '0')}`;
const NEXT_MONTH = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 2, 1))
  .toISOString()
  .slice(0, 10);

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
  key?: string,
) {
  return api.call(await token(who), {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    ...(key === undefined ? {} : { headers: { 'idempotency-key': key } }),
  });
}

async function setFlag(key: string, enabled: boolean) {
  const response = await api.call(staff.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

interface Overview {
  setUp: boolean;
  settings: {
    startDate: string;
    fiscalStartMonth: number;
    allowSelfApproval: boolean;
    accounts: Record<string, string>;
    version: number;
  } | null;
  currency: string;
  fixed: boolean;
  can: { post: boolean; manage: boolean; unlock: boolean };
}
interface Account {
  id: string;
  code: string;
  name: string;
  type: string;
  archived: boolean;
  role: string | null;
  version: number;
}
interface Journal {
  id: string;
  reference: string | null;
  status: string;
  kind: string;
  entryDate: string;
  total: string;
  reversalOf: string | null;
  reversedBy: string | null;
  selfApproved: boolean;
  draftedBy: { id: string };
  postedBy: { id: string } | null;
  lines: {
    account: { code: string };
    debit: string;
    credit: string;
    customer: { id: string } | null;
  }[];
  totals: { debit: string; credit: string; balanced: boolean };
  can: { edit: boolean; post: boolean; discard: boolean; reverse: boolean };
}

let accounts: Map<string, Account>;
const id = (accountCode: string) => accounts.get(accountCode)!.id;

const draft = async (
  who: Member,
  lines: Record<string, unknown>[],
  extra: Record<string, unknown> = {},
) => {
  const response = await call(
    who,
    'POST',
    '/v1/ledger/journals',
    { entryDate: day(15), memo: 'Test', lines, ...extra },
    randomUUID(),
  );
  expect(response.statusCode, response.body).toBe(201);
  return json<Journal>(response);
};
const post = (who: Member, journal: { id: string }, payload: Record<string, unknown> = {}) =>
  call(who, 'POST', `/v1/ledger/journals/${journal.id}/post`, payload);
const rent = () => [
  { accountId: id('6300'), debit: '1000' },
  { accountId: id('1110'), credit: '1000' },
];

beforeAll(async () => {
  api = await startApi();
  staff = await api.platformAdmin('lg-staff');
  owner = await api.member('owner', 'lg-owner');
  admin = await api.member('admin', 'lg-admin');
  dispatcher = await api.member('dispatcher', 'lg-dispatcher');
  viewer = await api.member('viewer', 'lg-viewer');
  const customer = await call(owner, 'POST', '/v1/customers', {
    name: 'Riverside Housing',
    address: { line1: '1 River Road', city: 'Cairo', countryCode: 'EG' },
  });
  customerId = json<{ id: string }>(customer).id;
});

afterAll(async () => {
  await api.close();
});

describe('the ledger module', () => {
  it('is refused until Integr8 switches it on, and kept from dispatchers', async () => {
    const refused = await call(admin, 'GET', '/v1/ledger');
    expect(refused.statusCode).toBe(403);
    expect(code(refused)).toBe('feature_disabled');
    await setFlag('ledger', true);
    expect((await call(viewer, 'GET', '/v1/ledger')).statusCode).toBe(200);
    expect((await call(dispatcher, 'GET', '/v1/ledger')).statusCode).toBe(403);
  });

  it('is set up once, by an owner or admin, with the default chart in the chosen language', async () => {
    const before = json<Overview>(await call(viewer, 'GET', '/v1/ledger'));
    expect(before).toMatchObject({ setUp: false, settings: null, can: { post: false } });
    expect((await call(viewer, 'GET', '/v1/ledger/journals')).statusCode).toBe(200);
    expect(
      (await call(viewer, 'POST', '/v1/ledger/setup', { startDate: START }, randomUUID()))
        .statusCode,
    ).toBe(403);
    const notFirst = await call(
      admin,
      'POST',
      '/v1/ledger/setup',
      { startDate: day(2) },
      randomUUID(),
    );
    expect(notFirst.statusCode).toBe(422);
    const setUp = await call(
      admin,
      'POST',
      '/v1/ledger/setup',
      { startDate: START, fiscalStartMonth: 1, language: 'ar' },
      randomUUID(),
    );
    expect(setUp.statusCode, setUp.body).toBe(201);
    expect(json<Overview>(setUp)).toMatchObject({
      setUp: true,
      currency: 'EGP',
      fixed: false,
      settings: { startDate: START, fiscalStartMonth: 1, allowSelfApproval: false },
      can: { post: true, manage: true, unlock: false },
    });
    const again = await call(admin, 'POST', '/v1/ledger/setup', { startDate: START }, randomUUID());
    expect(code(again)).toBe('already_set_up');
    const chart = json<{ items: Account[] }>(
      await call(viewer, 'GET', '/v1/ledger/accounts'),
    ).items;
    accounts = new Map(chart.map((account) => [account.code, account]));
    expect(accounts.get('1200')).toMatchObject({ role: 'receivables', name: 'العملاء (المدينون)' });
    expect(accounts.get('2200')).toMatchObject({ role: 'vatOutput', type: 'liability' });
  });
});

describe('the chart', () => {
  it('takes new accounts with unique codes, and keeps posting accounts and posted types', async () => {
    const created = await call(admin, 'POST', '/v1/ledger/accounts', {
      code: '6610',
      name: 'Staff training',
      type: 'expense',
    });
    expect(created.statusCode, created.body).toBe(201);
    const training = json<Account>(created);
    expect(
      code(
        await call(admin, 'POST', '/v1/ledger/accounts', {
          code: '6610',
          name: 'Again',
          type: 'expense',
        }),
      ),
    ).toBe('code_taken');
    const receivables = accounts.get('1200')!;
    expect(
      code(
        await call(admin, 'PATCH', `/v1/ledger/accounts/${receivables.id}`, {
          expectedVersion: receivables.version,
          archived: true,
        }),
      ),
    ).toBe('posting_account');
    const journal = await draft(admin, [
      { accountId: training.id, debit: '50' },
      { accountId: id('1100'), credit: '50' },
    ]);
    expect((await post(owner, journal)).statusCode).toBe(200);
    expect(
      code(
        await call(admin, 'PATCH', `/v1/ledger/accounts/${training.id}`, {
          expectedVersion: training.version,
          type: 'asset',
        }),
      ),
    ).toBe('type_fixed');
    const renamed = await call(admin, 'PATCH', `/v1/ledger/accounts/${training.id}`, {
      expectedVersion: training.version,
      name: 'Training and courses',
    });
    expect(json<Account>(renamed)).toMatchObject({ name: 'Training and courses', type: 'expense' });
    expect(json<Overview>(await call(admin, 'GET', '/v1/ledger')).fixed).toBe(true);
    const moved = await call(admin, 'PUT', '/v1/ledger/settings', {
      expectedVersion: 1,
      startDate: NEXT_MONTH,
    });
    expect(code(moved)).toBe('settings_fixed');
  });
});

describe('manual journals', () => {
  it('are posted by someone other than their drafter, numbered and frozen', async () => {
    const journal = await draft(admin, rent());
    expect(journal).toMatchObject({
      status: 'draft',
      reference: null,
      totals: { debit: '1000', credit: '1000', balanced: true },
      can: { edit: true, post: false, discard: true },
    });
    const own = await post(admin, journal);
    expect(own.statusCode).toBe(409);
    expect(code(own)).toBe('self_approval');
    expect((await post(viewer, journal)).statusCode).toBe(403);
    const posted = await post(owner, journal);
    expect(posted.statusCode, posted.body).toBe(200);
    expect(json<Journal>(posted).reference).toMatch(/^JV-\d{6}$/u);
    expect(json<Journal>(posted)).toMatchObject({
      status: 'posted',
      postedBy: { id: owner.userId },
      selfApproved: false,
      can: { edit: false, post: false, discard: false, reverse: true },
    });
    expect(code(await post(owner, journal))).toBe('not_draft');
    expect((await call(owner, 'DELETE', `/v1/ledger/journals/${journal.id}`)).statusCode).toBe(409);
  });

  it('are posted only when they balance; rewriting a draft makes its writer the drafter', async () => {
    const journal = await draft(admin, [
      { accountId: id('6300'), debit: '100' },
      { accountId: id('1110'), credit: '99.99' },
    ]);
    const refused = await post(owner, journal);
    expect(refused.statusCode).toBe(422);
    expect(code(refused)).toBe('unbalanced');
    const rewritten = await call(owner, 'PUT', `/v1/ledger/journals/${journal.id}`, {
      entryDate: day(16),
      memo: 'Rent, corrected',
      lines: rent(),
    });
    expect(json<Journal>(rewritten)).toMatchObject({ draftedBy: { id: owner.userId } });
    expect(code(await post(owner, journal))).toBe('self_approval');
    expect((await post(admin, journal)).statusCode).toBe(200);
    const bad = await call(
      admin,
      'POST',
      '/v1/ledger/journals',
      {
        entryDate: day(15),
        lines: [
          { accountId: id('6300'), debit: '1', credit: '1' },
          { accountId: id('1110'), credit: '1' },
        ],
      },
      randomUUID(),
    );
    expect(bad.statusCode).toBe(422);
  });

  it('may be posted by their drafter only when the owner allows it, and say so', async () => {
    const settings = json<Overview>(await call(admin, 'GET', '/v1/ledger')).settings!;
    expect(
      (
        await call(admin, 'PUT', '/v1/ledger/settings', {
          expectedVersion: settings.version,
          allowSelfApproval: true,
        })
      ).statusCode,
    ).toBe(403);
    const allowed = await call(owner, 'PUT', '/v1/ledger/settings', {
      expectedVersion: settings.version,
      allowSelfApproval: true,
    });
    expect(allowed.statusCode, allowed.body).toBe(200);
    const journal = await draft(admin, rent());
    expect(code(await post(admin, journal))).toBe('self_approval');
    const posted = await post(admin, journal, { selfApprove: true });
    expect(json<Journal>(posted)).toMatchObject({
      selfApproved: true,
      postedBy: { id: admin.userId },
    });
    await call(owner, 'PUT', '/v1/ledger/settings', {
      expectedVersion: settings.version + 1,
      allowSelfApproval: false,
    });
  });

  it('are reversed once, in an open month, on or after the original', async () => {
    const journal = await draft(admin, rent());
    await post(owner, journal);
    const early = await call(
      admin,
      'POST',
      `/v1/ledger/journals/${journal.id}/reverse`,
      { entryDate: day(1) },
      randomUUID(),
    );
    expect(code(early)).toBe('reversal_before_original');
    const reversed = await call(
      admin,
      'POST',
      `/v1/ledger/journals/${journal.id}/reverse`,
      { entryDate: day(20) },
      randomUUID(),
    );
    expect(reversed.statusCode, reversed.body).toBe(201);
    const reversal = json<Journal>(reversed);
    expect(reversal).toMatchObject({ kind: 'reversal', reversalOf: journal.id, status: 'posted' });
    expect(reversal.lines.map((line) => [line.account.code, line.debit, line.credit])).toEqual([
      ['6300', '0', '1000'],
      ['1110', '1000', '0'],
    ]);
    const original = json<Journal>(await call(viewer, 'GET', `/v1/ledger/journals/${journal.id}`));
    expect(original).toMatchObject({ reversedBy: reversal.id, can: { reverse: false } });
    expect(
      code(
        await call(admin, 'POST', `/v1/ledger/journals/${journal.id}/reverse`, {}, randomUUID()),
      ),
    ).toBe('already_reversed');
    expect(
      code(
        await call(admin, 'POST', `/v1/ledger/journals/${reversal.id}/reverse`, {}, randomUUID()),
      ),
    ).toBe('reversal_of_reversal');
  });

  it('are found by number and words, newest first', async () => {
    const all = json<{ items: Journal[] }>(
      await call(viewer, 'GET', '/v1/ledger/journals?status=posted'),
    );
    expect(all.items.length).toBeGreaterThan(3);
    const reference = all.items[0]!.reference!;
    const byNumber = json<{ items: Journal[] }>(
      await call(viewer, 'GET', `/v1/ledger/journals?q=${reference.toLowerCase()}`),
    );
    expect(byNumber.items.map((journal) => journal.reference)).toEqual([reference]);
    const byWords = json<{ items: Journal[] }>(
      await call(viewer, 'GET', '/v1/ledger/journals?q=corrected'),
    );
    expect(byWords.items).toHaveLength(1);
  });
});

describe('months', () => {
  it('are locked by owners and admins, unlocked only by the owner with a reason', async () => {
    const waiting = await draft(admin, rent(), { entryDate: NEXT_MONTH });
    expect(
      (await call(dispatcher, 'POST', `/v1/ledger/periods/${NEXT_MONTH}/lock`)).statusCode,
    ).toBe(403);
    expect((await call(admin, 'POST', `/v1/ledger/periods/${NEXT_MONTH}/lock`)).statusCode).toBe(
      204,
    );
    const intoLocked = await call(
      admin,
      'POST',
      '/v1/ledger/journals',
      { entryDate: NEXT_MONTH, lines: rent() },
      randomUUID(),
    );
    expect(code(intoLocked)).toBe('period_locked');
    expect(code(await post(owner, waiting))).toBe('period_locked');
    expect(
      (
        await call(admin, 'POST', `/v1/ledger/periods/${NEXT_MONTH}/unlock`, {
          reason: 'Late bill',
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await call(owner, 'POST', `/v1/ledger/periods/${NEXT_MONTH}/unlock`, { reason: ' ' }))
        .statusCode,
    ).toBe(422);
    expect(
      (
        await call(owner, 'POST', `/v1/ledger/periods/${NEXT_MONTH}/unlock`, {
          reason: 'Late supplier bill',
        })
      ).statusCode,
    ).toBe(204);
    expect((await post(owner, waiting)).statusCode).toBe(200);
    const periods = json<{
      year: { start: string; end: string };
      months: { month: string; locked: boolean }[];
      events: { month: string; kind: string; reason: string | null; by: { id: string } }[];
    }>(await call(viewer, 'GET', `/v1/ledger/periods?date=${NEXT_MONTH}`));
    expect(periods.months).toHaveLength(12);
    expect(periods.months.find((month) => month.month === NEXT_MONTH)?.locked).toBe(false);
    expect(
      periods.events
        .filter((event) => event.month === NEXT_MONTH)
        .map((event) => [event.kind, event.reason, event.by.id]),
    ).toEqual([
      ['unlocked', 'Late supplier bill', owner.userId],
      ['locked', null, admin.userId],
    ]);
  });

  it('take nothing dated before the ledger starts', async () => {
    const before = new Date(`${START}T00:00:00Z`);
    before.setUTCDate(0);
    const refused = await call(
      admin,
      'POST',
      '/v1/ledger/journals',
      { entryDate: before.toISOString().slice(0, 10), lines: rent() },
      randomUUID(),
    );
    expect(code(refused)).toBe('before_start');
  });
});

describe('opening balances', () => {
  it('start from what customers owed, are dated on the start, and exist once', async () => {
    await setFlag('finance', true);
    const invoice = await call(
      owner,
      'POST',
      '/v1/finance/invoices',
      {
        customerId,
        lines: [{ description: 'Annual service', quantity: '1', unitPrice: '1140' }],
      },
      randomUUID(),
    );
    expect(invoice.statusCode, invoice.body).toBe(201);
    const drafted = json<{ invoice: { id: string; version: number } }>(invoice);
    const issued = await call(owner, 'POST', `/v1/finance/invoices/${drafted.invoice.id}/issue`, {
      expectedVersion: drafted.invoice.version,
    });
    expect(issued.statusCode, issued.body).toBe(200);
    const paid = await call(
      owner,
      'POST',
      '/v1/finance/payments',
      {
        customerId,
        receivedOn: new Date().toISOString().slice(0, 10),
        method: 'cash',
        amount: '140',
      },
      randomUUID(),
    );
    expect(paid.statusCode, paid.body).toBe(201);

    const owed = json<{
      date: string;
      accountId: string;
      items: { customer: { id: string; name: string }; amount: string }[];
    }>(await call(admin, 'GET', '/v1/ledger/opening-receivables'));
    expect(owed).toMatchObject({ date: START, accountId: id('1200') });
    expect(owed.items).toEqual([
      { customer: { id: customerId, name: 'Riverside Housing' }, amount: '1000' },
    ]);

    const wrongDay = await call(
      admin,
      'POST',
      '/v1/ledger/journals',
      { kind: 'opening', entryDate: day(2), lines: rent() },
      randomUUID(),
    );
    expect(code(wrongDay)).toBe('opening_date');
    const opening = await draft(
      admin,
      [
        { accountId: id('1200'), debit: '1000', customerId },
        { accountId: id('1110'), debit: '25000' },
        { accountId: id('3900'), credit: '26000' },
      ],
      { kind: 'opening', entryDate: START },
    );
    expect(opening).toMatchObject({ kind: 'opening', status: 'draft' });
    expect(code(await post(admin, opening))).toBe('self_approval');
    const posted = json<Journal>(await post(owner, opening));
    expect(posted).toMatchObject({ status: 'posted', kind: 'opening' });
    expect(posted.lines[0]!.customer).toEqual({ id: customerId, name: 'Riverside Housing' });
    const again = await call(
      admin,
      'POST',
      '/v1/ledger/journals',
      { kind: 'opening', entryDate: START, lines: rent() },
      randomUUID(),
    );
    expect(code(again)).toBe('opening_exists');
    expect(
      json<{ openingJournal: { status: string } }>(await call(viewer, 'GET', '/v1/ledger'))
        .openingJournal,
    ).toMatchObject({
      status: 'posted',
    });
  });
});
