import { DEFAULT_CHART, toTenantId } from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JournalLineInput, JournalQuery, LedgerSettings } from '../repositories/ledger.js';
import {
  asTenant,
  connectAsApp,
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
  withUnprotectedRepositories,
} from './harness.js';

/**
 * Migration 0033 (CRM/ERP plan, phase A1; ADR-0009): the general ledger — a
 * chart set up once, journals that balance, are numbered when posted and never
 * change, corrections by reversal, months locked by hand, manual journals
 * approved by a second person, and a company with a ledger that can still be
 * purged.
 */

const DRAFTER = '00000000-0000-4000-8000-00000000a901';
const APPROVER = '00000000-0000-4000-8000-00000000a902';

let owner: pg.Client;
let northwind: TenantFixture;
let southgate: TenantFixture;

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

async function setUp(tenant: TenantFixture, startDate = '2026-01-01'): Promise<LedgerSettings> {
  const settings = await repos(tenant, (tx) =>
    tx.ledger.setUp({ startDate, fiscalStartMonth: 1, chart }, DRAFTER),
  );
  if (settings === 'already_set_up') {
    throw new Error(settings);
  }
  return settings;
}

const debit = (accountId: string, amount: string): JournalLineInput => ({
  accountId,
  debit: amount,
});
const credit = (accountId: string, amount: string): JournalLineInput => ({
  accountId,
  credit: amount,
});

async function draft(
  tenant: TenantFixture,
  lines: JournalLineInput[],
  extra: {
    entryDate?: string;
    kind?: 'manual' | 'automatic' | 'reversal';
    reversalOf?: string;
  } = {},
) {
  return repos(tenant, (tx) =>
    tx.ledger.createDraft(
      {
        kind: extra.kind ?? 'manual',
        entryDate: extra.entryDate ?? '2026-03-15',
        memo: 'Test',
        ...(extra.kind === 'automatic'
          ? { sourceKind: 'invoice' as const, sourceId: crypto.randomUUID() }
          : {}),
        ...(extra.reversalOf === undefined ? {} : { reversalOf: extra.reversalOf }),
      },
      lines,
      DRAFTER,
    ),
  );
}

const post = (tenant: TenantFixture, id: string, by = APPROVER, selfApproved = false) =>
  repos(tenant, (tx) => tx.ledger.post(id, by, selfApproved));

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  northwind = await createTenant('ledger-northwind');
  southgate = await createTenant('ledger-southgate');
});

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

describe('setting up', () => {
  it('creates the chart and names an account for every automatic posting, once', async () => {
    const settings = await setUp(northwind);
    expect(settings).toMatchObject({
      startDate: '2026-01-01',
      fiscalStartMonth: 1,
      autoPostSales: true,
      autoPostStock: true,
      allowSelfApproval: false,
      version: 1,
    });
    const accounts = await repos(northwind, (tx) => tx.ledger.accounts());
    expect(accounts).toHaveLength(DEFAULT_CHART.length);
    const byId = new Map(accounts.map((account) => [account.id, account]));
    expect(byId.get(settings.accounts.receivables)?.code).toBe('1200');
    expect(byId.get(settings.accounts.vatOutput)?.code).toBe('2200');
    expect(
      await repos(northwind, (tx) =>
        tx.ledger.setUp({ startDate: '2026-02-01', fiscalStartMonth: 1, chart }, DRAFTER),
      ),
    ).toBe('already_set_up');
    // Another company sees none of it.
    expect(await repos(southgate, (tx) => tx.ledger.settings())).toBeUndefined();
    expect(await repos(southgate, (tx) => tx.ledger.accounts())).toEqual([]);
  });

  it('starts on the first of a month, and keeps its start once anything is posted', async () => {
    const tenant = await createTenant('ledger-start');
    await expect(setUp(tenant, '2026-01-15')).rejects.toMatchObject({
      constraint: 'erp_ledger_settings_start_first_of_month',
    });
    const settings = await setUp(tenant);
    const moved = await repos(tenant, (tx) =>
      tx.ledger.saveSettings(settings.version, { startDate: '2026-02-01' }, DRAFTER),
    );
    expect(moved).toMatchObject({ startDate: '2026-02-01', version: 2 });
    expect(
      await repos(tenant, (tx) => tx.ledger.saveSettings(1, { autoPostSales: false }, DRAFTER)),
    ).toBe('version_conflict');
    const journal = await draft(tenant, [
      debit(settings.accounts.cash, '10'),
      credit(settings.accounts.openingBalances, '10'),
    ]);
    await post(tenant, journal.id);
    await expect(
      repos(tenant, (tx) => tx.ledger.saveSettings(2, { startDate: '2026-01-01' }, DRAFTER)),
    ).rejects.toMatchObject({ constraint: 'erp_ledger_settings_fixed' });
  });
});

describe('journals', () => {
  it('numbers a journal when posted, and a discarded draft leaves no gap', async () => {
    const settings = (await repos(northwind, (tx) => tx.ledger.settings()))!;
    const first = await draft(northwind, [
      debit(settings.accounts.receivables, '114'),
      credit(settings.accounts.revenueServices, '100'),
      credit(settings.accounts.vatOutput, '14'),
    ]);
    expect(first.reference).toBeNull();
    const thrown = await draft(northwind, [
      debit(settings.accounts.cash, '1'),
      credit(settings.accounts.revenueServices, '1'),
    ]);
    expect(await repos(northwind, (tx) => tx.ledger.discardDraft(thrown.id))).toBe(true);
    const posted = await post(northwind, first.id);
    expect(posted).toMatchObject({ status: 'posted', reference: 1, postedBy: APPROVER });
    const second = await draft(northwind, [
      debit(settings.accounts.cash, '50'),
      credit(settings.accounts.receivables, '50'),
    ]);
    expect((await post(northwind, second.id)).reference).toBe(2);
    expect(await repos(northwind, (tx) => tx.ledger.discardDraft(second.id))).toBe(false);
  });

  it('refuses one that does not balance, or has a single line', async () => {
    const settings = (await repos(northwind, (tx) => tx.ledger.settings()))!;
    const unbalanced = await draft(northwind, [
      debit(settings.accounts.cash, '100'),
      credit(settings.accounts.revenueServices, '99.9999'),
    ]);
    await expect(post(northwind, unbalanced.id)).rejects.toMatchObject({
      constraint: 'erp_journals_unbalanced',
    });
    const single = await draft(northwind, [debit(settings.accounts.cash, '0.0001')]);
    await expect(post(northwind, single.id)).rejects.toMatchObject({
      constraint: 'erp_journals_unbalanced',
    });
    await expect(
      draft(northwind, [
        { accountId: settings.accounts.cash, debit: '1', credit: '1' },
        credit(settings.accounts.revenueServices, '0'),
      ]),
    ).rejects.toMatchObject({ constraint: 'erp_journal_lines_one_side' });
  });

  it('never changes once posted, even for the application role', async () => {
    const settings = (await repos(northwind, (tx) => tx.ledger.settings()))!;
    const journal = await draft(northwind, [
      debit(settings.accounts.bank, '500'),
      credit(settings.accounts.receivables, '500'),
    ]);
    await post(northwind, journal.id);
    const app = await connectAsApp();
    try {
      const attempt = (text: string, values: unknown[]) =>
        asTenant(app, northwind.id, () => app.query(text, values));
      await expect(
        attempt(`update erp_journals set memo = 'edited' where id = $1`, [journal.id]),
      ).rejects.toMatchObject({ constraint: 'erp_journals_frozen' });
      await expect(
        attempt(`delete from erp_journals where id = $1`, [journal.id]),
      ).rejects.toMatchObject({ constraint: 'erp_journals_frozen' });
      await expect(
        attempt(`update erp_journal_lines set debit = 1 where journal_id = $1 and debit > 0`, [
          journal.id,
        ]),
      ).rejects.toMatchObject({ constraint: 'erp_journal_lines_frozen' });
      await expect(
        attempt(`delete from erp_journal_lines where journal_id = $1`, [journal.id]),
      ).rejects.toMatchObject({ constraint: 'erp_journal_lines_frozen' });
      await expect(
        attempt(
          `insert into erp_journal_lines (tenant_id, journal_id, line_no, account_id, debit)
           values ($1, $2, 9, $3, 1)`,
          [northwind.id, journal.id, settings.accounts.cash],
        ),
      ).rejects.toMatchObject({ constraint: 'erp_journal_lines_frozen' });
      await expect(
        attempt(
          `insert into erp_journals (tenant_id, kind, entry_date, status, drafted_by, posted_by, posted_at)
           values ($1, 'manual', '2026-03-01', 'posted', $2, $2, now())`,
          [northwind.id, DRAFTER],
        ),
      ).rejects.toMatchObject({ constraint: 'erp_journals_insert_draft' });
      await expect(
        attempt(`update journal_reference_counters set last_reference = 0`, []),
      ).rejects.toThrow(/permission denied/u);
    } finally {
      await app.end();
    }
  });

  it('is corrected by a reversal, once, of a posted journal only', async () => {
    const settings = (await repos(northwind, (tx) => tx.ledger.settings()))!;
    const journal = await post(
      northwind,
      (
        await draft(northwind, [
          debit(settings.accounts.cash, '20'),
          credit(settings.accounts.revenueServices, '20'),
        ])
      ).id,
    );
    const reversal = await draft(
      northwind,
      [credit(settings.accounts.cash, '20'), debit(settings.accounts.revenueServices, '20')],
      { kind: 'reversal', reversalOf: journal.id },
    );
    expect((await post(northwind, reversal.id, DRAFTER)).kind).toBe('reversal');
    expect((await repos(northwind, (tx) => tx.ledger.reversalFor(journal.id)))?.id).toBe(
      reversal.id,
    );
    await expect(
      draft(
        northwind,
        [credit(settings.accounts.cash, '20'), debit(settings.accounts.revenueServices, '20')],
        { kind: 'reversal', reversalOf: journal.id },
      ),
    ).rejects.toMatchObject({ constraint: 'erp_journals_reversal_unique' });
    const pending = await draft(northwind, [
      debit(settings.accounts.cash, '5'),
      credit(settings.accounts.revenueServices, '5'),
    ]);
    const early = await draft(
      northwind,
      [credit(settings.accounts.cash, '5'), debit(settings.accounts.revenueServices, '5')],
      { kind: 'reversal', reversalOf: pending.id },
    );
    await expect(post(northwind, early.id)).rejects.toMatchObject({
      constraint: 'erp_journals_reversal_not_posted',
    });
  });

  it('is posted by someone other than its drafter, unless the company allows it and says so', async () => {
    const tenant = await createTenant('ledger-approval');
    const settings = await setUp(tenant);
    const lines = [
      debit(settings.accounts.cash, '1'),
      credit(settings.accounts.revenueServices, '1'),
    ];
    const mine = await draft(tenant, lines);
    await expect(post(tenant, mine.id, DRAFTER, true)).rejects.toMatchObject({
      constraint: 'erp_journals_self_approval',
    });
    await repos(tenant, (tx) =>
      tx.ledger.saveSettings(settings.version, { allowSelfApproval: true }, DRAFTER),
    );
    const again = await draft(tenant, lines);
    await expect(post(tenant, again.id, DRAFTER, false)).rejects.toMatchObject({
      constraint: 'erp_journals_self_approval',
    });
    expect(await post(tenant, again.id, DRAFTER, true)).toMatchObject({ selfApproved: true });
    // Another person's approval is never marked as self-approval; an automatic posting needs none.
    expect(await post(tenant, (await draft(tenant, lines)).id, APPROVER, true)).toMatchObject({
      selfApproved: false,
    });
    expect(
      await post(tenant, (await draft(tenant, lines, { kind: 'automatic' })).id, DRAFTER),
    ).toMatchObject({ status: 'posted', selfApproved: false });
  });
});

describe('periods and accounts', () => {
  it('posts nothing before the start or into a locked month, and an unlock says why', async () => {
    const tenant = await createTenant('ledger-periods');
    const settings = await setUp(tenant, '2026-02-01');
    const lines = [
      debit(settings.accounts.cash, '3'),
      credit(settings.accounts.revenueServices, '3'),
    ];
    await expect(
      post(tenant, (await draft(tenant, lines, { entryDate: '2026-01-31' })).id),
    ).rejects.toMatchObject({ constraint: 'erp_journals_before_start' });

    expect(
      await repos(tenant, (tx) => tx.ledger.setPeriodLocked('2026-03-01', true, APPROVER, null)),
    ).toEqual({ changed: true });
    expect(
      await repos(tenant, (tx) => tx.ledger.setPeriodLocked('2026-03-01', true, APPROVER, null)),
    ).toEqual({ changed: false });
    const march = await draft(tenant, lines, { entryDate: '2026-03-31' });
    await expect(post(tenant, march.id)).rejects.toMatchObject({
      constraint: 'erp_journals_period_locked',
    });
    await expect(
      repos(tenant, (tx) => tx.ledger.setPeriodLocked('2026-03-01', false, APPROVER, null)),
    ).rejects.toMatchObject({ constraint: 'erp_ledger_period_events_reason_shape' });
    await repos(tenant, (tx) =>
      tx.ledger.setPeriodLocked('2026-03-01', false, APPROVER, 'Supplier credit found late'),
    );
    expect((await post(tenant, march.id)).status).toBe('posted');
    const events = await repos(tenant, (tx) => tx.ledger.periodEvents('2026-03-01'));
    expect(events.map((event) => [event.kind, event.reason])).toEqual([
      ['unlocked', 'Supplier credit found late'],
      ['locked', null],
    ]);
    expect(await repos(tenant, (tx) => tx.ledger.periodLocked('2026-03-15'))).toBe(false);
  });

  it('takes no postings on an archived account, and keeps the type of one posted to', async () => {
    const tenant = await createTenant('ledger-accounts');
    const settings = await setUp(tenant);
    const created = await repos(tenant, (tx) =>
      tx.ledger.createAccount({ code: '6610', name: 'Training', type: 'expense' }, DRAFTER),
    );
    if (typeof created === 'string') {
      throw new Error(created);
    }
    expect(
      await repos(tenant, (tx) =>
        tx.ledger.createAccount({ code: '6610', name: 'Again', type: 'expense' }, DRAFTER),
      ),
    ).toBe('code_taken');
    const archived = await repos(tenant, (tx) =>
      tx.ledger.updateAccount(created.id, created.version, { archived: true }, DRAFTER),
    );
    expect(archived).toMatchObject({ archivedBy: DRAFTER });
    const onArchived = await draft(tenant, [
      debit(created.id, '9'),
      credit(settings.accounts.cash, '9'),
    ]);
    await expect(post(tenant, onArchived.id)).rejects.toMatchObject({
      constraint: 'erp_journals_account_archived',
    });
    const reopened = await repos(tenant, (tx) =>
      tx.ledger.updateAccount(created.id, 2, { archived: false }, DRAFTER),
    );
    expect(reopened).toMatchObject({ archivedAt: null });
    await post(tenant, onArchived.id);
    expect(await repos(tenant, (tx) => tx.ledger.accountUsed(created.id))).toBe(true);
    await expect(
      repos(tenant, (tx) => tx.ledger.updateAccount(created.id, 3, { type: 'asset' }, DRAFTER)),
    ).rejects.toMatchObject({ constraint: 'erp_ledger_accounts_type_fixed' });
    const renamed = await repos(tenant, (tx) =>
      tx.ledger.updateAccount(created.id, 3, { name: 'Staff training' }, DRAFTER),
    );
    expect(renamed).toMatchObject({ name: 'Staff training', type: 'expense' });
  });

  it('finds journals by number, words, account and date, newest first', async () => {
    const tenant = await createTenant('ledger-find');
    const settings = await setUp(tenant);
    const make = async (entryDate: string, memo: string, accountId: string) => {
      const journal = await repos(tenant, (tx) =>
        tx.ledger.createDraft(
          { kind: 'manual', entryDate, memo },
          [debit(accountId, '1'), credit(settings.accounts.openingBalances, '1')],
          DRAFTER,
        ),
      );
      return post(tenant, journal.id);
    };
    const a = await make('2026-01-10', 'Van fuel January', settings.accounts.cash);
    const b = await make('2026-02-10', 'Rent February', settings.accounts.bank);
    const c = await make('2026-02-10', 'Van fuel February', settings.accounts.cash);
    const page = async (query: Partial<JournalQuery>) =>
      (await repos(tenant, (tx) => tx.ledger.list({ limit: 10, ...query }))).items.map(
        (journal) => journal.reference,
      );
    expect(await page({})).toEqual([c.reference, b.reference, a.reference]);
    expect(await page({ text: 'van fuel' })).toEqual([c.reference, a.reference]);
    expect(await page({ accountId: settings.accounts.bank })).toEqual([b.reference]);
    expect(await page({ from: '2026-02-01', to: '2026-02-28' })).toEqual([
      c.reference,
      b.reference,
    ]);
    expect(await page({ reference: a.reference! })).toEqual([a.reference]);
    const first = await repos(tenant, (tx) => tx.ledger.list({ limit: 2 }));
    expect(first.next).toBeDefined();
    const second = await repos(tenant, (tx) => tx.ledger.list({ limit: 2, before: first.next }));
    expect(second.items.map((journal) => journal.reference)).toEqual([a.reference]);
  });
});

describe('purge', () => {
  it('takes a company’s ledger with it', async () => {
    const tenant = await createTenant('ledger-purge');
    const settings = await setUp(tenant);
    const journal = await draft(tenant, [
      debit(settings.accounts.cash, '7'),
      credit(settings.accounts.openingBalances, '7'),
    ]);
    await post(tenant, journal.id);
    await repos(tenant, (tx) => tx.ledger.setPeriodLocked('2026-01-01', true, APPROVER, null));
    const exported = await owner.query<{ id: string }>(
      `insert into tenant_exports (tenant_id, tenant_slug, status, object_key)
       values ($1, 'ledger-purge', 'ready', 'exports/ledger-purge.zip') returning id`,
      [tenant.id],
    );
    await owner.query(
      `insert into tenant_deletions (tenant_id, tenant_slug, export_id, reason, purge_after)
       values ($1, 'ledger-purge', $2, 'Integration test of the purge', now() - interval '1 minute')`,
      [tenant.id, exported.rows[0]!.id],
    );
    await owner.query(`select purge_tenant($1)`, [tenant.id]);
    for (const table of [
      'erp_ledger_accounts',
      'erp_ledger_settings',
      'erp_ledger_periods',
      'erp_ledger_period_events',
      'erp_journals',
      'erp_journal_lines',
      'journal_reference_counters',
    ]) {
      const left = await owner.query(
        `select count(*)::int as n from ${table} where tenant_id = $1`,
        [tenant.id],
      );
      expect(left.rows[0], table).toEqual({ n: 0 });
    }
  });
});
