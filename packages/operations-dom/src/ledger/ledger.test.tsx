import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  JournalDetail,
  LedgerAccount,
  LedgerOverview,
  LedgerYear,
  PostingDetail,
  TrialBalance,
} from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { JournalEditorScreen } from './journal-editor.js';
import { JournalScreen } from './journal-screen.js';
import { LedgerHomeScreen } from './ledger-home.js';
import { LedgerPeriodsScreen } from './ledger-periods.js';
import { LedgerReportsScreen } from './ledger-reports.js';
import { UnpostedScreen } from './unposted-screen.js';

const USER = '00000000-0000-4000-8000-000000000401';
const OTHER = '00000000-0000-4000-8000-000000000402';
const TENANT = '00000000-0000-4000-8000-000000000301';
const CASH = '00000000-0000-4000-8000-00000000a101';
const RECEIVABLES = '00000000-0000-4000-8000-00000000a102';
const REVENUE = '00000000-0000-4000-8000-00000000a103';
const RETAINED = '00000000-0000-4000-8000-00000000a104';
const OPENING = '00000000-0000-4000-8000-00000000a105';
const JOURNAL = '00000000-0000-4000-8000-00000000b001';
const LINE_1 = '00000000-0000-4000-8000-00000000b101';
const LINE_2 = '00000000-0000-4000-8000-00000000b102';
const POSTING = '00000000-0000-4000-8000-00000000c001';
const INVOICE = '00000000-0000-4000-8000-00000000c101';
const CUSTOMER = '00000000-0000-4000-8000-00000000d001';

const READ = ['ledger.read'];
const MANAGE = ['ledger.read', 'ledger.post', 'ledger.manage'];
const OWNER = [...MANAGE, 'ledger.unlock'];

const me =
  (permissions: string[], features: Record<string, boolean> = { ledger: true }) =>
  () => ({
    body: {
      userId: USER,
      tenantId: TENANT,
      email: 'o@x.example',
      displayName: 'Omar',
      role: 'owner',
      permissions,
      features,
      company: { name: 'Riverside Services', slug: 'riverside' },
    },
  });

const settings = (overrides: Partial<NonNullable<LedgerOverview['settings']>> = {}) => ({
  startDate: '2026-01-01',
  fiscalStartMonth: 1,
  autoPostSales: true,
  autoPostStock: true,
  allowSelfApproval: false,
  accounts: {
    receivables: RECEIVABLES,
    cash: CASH,
    revenueServices: REVENUE,
    retainedEarnings: RETAINED,
    openingBalances: OPENING,
  },
  version: 3,
  ...overrides,
});

const overview = (overrides: Partial<LedgerOverview> = {}): LedgerOverview => ({
  setUp: true,
  settings: settings(),
  currency: 'EGP',
  today: '2026-10-12',
  fixed: true,
  openingJournal: null,
  can: { post: true, manage: true, unlock: false },
  unposted: { total: 0, byReason: {} },
  ...overrides,
});

const account = (
  id: string,
  code: string,
  name: string,
  type: LedgerAccount['type'],
  role: LedgerAccount['role'] = null,
): LedgerAccount => ({ id, code, name, type, archived: false, role, version: 1 });

const ACCOUNTS: LedgerAccount[] = [
  account(CASH, '1100', 'Cash on hand', 'asset', 'cash'),
  account(RECEIVABLES, '1200', 'Accounts receivable', 'asset', 'receivables'),
  account(OPENING, '3900', 'Opening balances', 'equity', 'openingBalances'),
  account(RETAINED, '3200', 'Retained earnings', 'equity', 'retainedEarnings'),
  account(REVENUE, '4100', 'Service revenue', 'income', 'revenueServices'),
];

const person = (id: string, name: string) => ({ id, name });

const journal = (overrides: Partial<JournalDetail> = {}): JournalDetail => ({
  id: JOURNAL,
  reference: null,
  status: 'draft',
  kind: 'manual',
  entryDate: '2026-10-10',
  memo: 'Owner’s cash paid in',
  total: '500',
  source: null,
  reversalOf: null,
  sourceInvoiceId: null,
  reversedBy: null,
  draftedBy: person(USER, 'Omar'),
  postedBy: null,
  postedAt: null,
  selfApproved: false,
  lines: [
    {
      id: LINE_1,
      lineNo: 1,
      account: { id: CASH, code: '1100', name: 'Cash on hand', type: 'asset' },
      debit: '500',
      credit: '0',
      memo: null,
      customer: null,
      foreignAmount: null,
    },
    {
      id: LINE_2,
      lineNo: 2,
      account: { id: OPENING, code: '3900', name: 'Opening balances', type: 'equity' },
      debit: '0',
      credit: '500',
      memo: null,
      customer: null,
      foreignAmount: null,
    },
  ],
  foreign: null,
  totals: { debit: '500', credit: '500', balanced: true },
  can: { edit: true, post: true, discard: true, reverse: false },
  ...overrides,
});

describe('setting up the ledger', { timeout: 20_000 }, () => {
  it('offers a manager the set-up form and sends the first of the chosen month', async () => {
    const user = userEvent.setup();
    let current = overview({ setUp: false, settings: null, fixed: false });
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/ledger': () => ({ body: current }),
      'POST /v1/ledger/setup': () => {
        current = overview({ fixed: false });
        return { status: 201, body: current };
      },
    });
    const { container } = renderScreen(<LedgerHomeScreen />, client);

    expect(await screen.findByRole('heading', { name: 'Set up the ledger' })).toBeInTheDocument();
    expect(screen.getByText(/not statutory accounts/u)).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    const month = screen.getByLabelText('First month');
    expect(month).toHaveValue('2026-10');
    await user.clear(month);
    await user.type(month, '2026-07');
    await user.selectOptions(screen.getByLabelText('Fiscal year starts in'), '7');
    expect(screen.getByLabelText('Language of the chart')).toHaveValue('en');
    await user.click(screen.getByRole('button', { name: 'Set up the ledger' }));

    await waitFor(() =>
      expect(calls.find((call) => call.path === '/v1/ledger/setup')?.body).toEqual({
        startDate: '2026-07-01',
        fiscalStartMonth: 7,
        language: 'en',
      }),
    );
    // Once set up, the page becomes the way into the ledger.
    expect(await screen.findByRole('link', { name: 'Chart of accounts' })).toHaveAttribute(
      'href',
      '/ledger/accounts',
    );
  });

  it('tells a viewer the ledger is not set up, with no form', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(READ),
      'GET /v1/ledger': () => ({
        body: overview({
          setUp: false,
          settings: null,
          can: { post: false, manage: false, unlock: false },
        }),
      }),
    });
    renderScreen(<LedgerHomeScreen />, client);
    expect(await screen.findByText(/has not been set up yet/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Set up the ledger' })).not.toBeInTheDocument();
  });

  it('shows what waits to be posted and the opening balances still to enter', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/ledger': () => ({
        body: overview({ unposted: { total: 3, byReason: { auto_off: 2, foreign_currency: 1 } } }),
      }),
    });
    renderScreen(<LedgerHomeScreen />, client);
    expect(await screen.findByText('3 documents wait to be posted.')).toBeInTheDocument();
    expect(screen.getByText('Automatic posting is off: 2')).toBeInTheDocument();
    expect(screen.getByText('In another currency: 1')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review the unposted list' })).toHaveAttribute(
      'href',
      '/ledger/unposted',
    );
    expect(screen.getByRole('link', { name: 'Enter the opening balances' })).toHaveAttribute(
      'href',
      '/ledger/journals/new?kind=opening',
    );
  });
});

describe('journals', { timeout: 20_000 }, () => {
  it('adds up the lines as they are typed and says whether they balance', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/ledger': () => ({ body: overview() }),
      'GET /v1/ledger/accounts': () => ({ body: { items: ACCOUNTS } }),
      'POST /v1/ledger/journals': () => ({ status: 201, body: journal() }),
    });
    const { navigate } = renderScreen(<JournalEditorScreen />, client);

    expect(await screen.findByRole('heading', { name: 'New journal' })).toBeInTheDocument();
    expect(screen.getByLabelText('Date')).toHaveValue('2026-10-12');
    await user.type(screen.getByLabelText('Memo'), 'Owner’s cash paid in');
    await user.selectOptions(screen.getByLabelText('Account, line 1'), CASH);
    await user.type(screen.getByLabelText('Debit, line 1'), '500');
    await user.selectOptions(screen.getByLabelText('Account, line 2'), OPENING);
    await user.type(screen.getByLabelText('Credit, line 2'), '320.5');

    expect(
      screen.getByText('Out of balance: debits are EGP 179.50 more than credits.'),
    ).toBeInTheDocument();
    const totals = screen.getByRole('row', { name: /Totals/u });
    expect(within(totals).getByText('EGP 500.00')).toBeInTheDocument();
    expect(within(totals).getByText('EGP 320.50')).toBeInTheDocument();

    // A credit on the line clears its debit: a line is one or the other.
    await user.type(screen.getByLabelText('Credit, line 1'), '1');
    expect(screen.getByLabelText('Debit, line 1')).toHaveValue('');
    await user.clear(screen.getByLabelText('Credit, line 1'));
    await user.type(screen.getByLabelText('Debit, line 1'), '320.5');
    expect(screen.getByText('Balanced: debits equal credits.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/ledger/journals/${JOURNAL}`));
    expect(calls.find((call) => call.path === '/v1/ledger/journals')!.body).toEqual({
      kind: 'manual',
      entryDate: '2026-10-12',
      memo: 'Owner’s cash paid in',
      lines: [
        { accountId: CASH, debit: '320.5' },
        { accountId: OPENING, credit: '320.5' },
      ],
    });
  });

  it('starts the opening balances from what customers owed, dated on the start date', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/ledger': () => ({ body: overview() }),
      'GET /v1/ledger/accounts': () => ({ body: { items: ACCOUNTS } }),
      'GET /v1/ledger/opening-receivables': () => ({
        body: {
          date: '2026-01-01',
          accountId: RECEIVABLES,
          items: [{ customer: { id: CUSTOMER, name: 'Riverside Housing' }, amount: '1250' }],
        },
      }),
    });
    renderScreen(<JournalEditorScreen opening />, client);

    expect(await screen.findByText('Riverside Housing')).toBeInTheDocument();
    expect(screen.getByLabelText('Date')).toHaveValue('2026-01-01');
    expect(screen.getByLabelText('Date')).toBeDisabled();
    expect(screen.getByLabelText('Account, line 1')).toHaveValue(RECEIVABLES);
    expect(screen.getByLabelText('Debit, line 1')).toHaveValue('1250');
    expect(screen.getByLabelText('Account, line 2')).toHaveValue(OPENING);
    expect(screen.getByLabelText('Credit, line 2')).toHaveValue('1250');
    expect(screen.getByText('Balanced: debits equal credits.')).toBeInTheDocument();
  });

  it('asks the drafter to confirm approving their own journal, where the owner allows it', async () => {
    const user = userEvent.setup();
    let current = journal();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(OWNER),
      'GET /v1/ledger': () => ({
        body: overview({ settings: settings({ allowSelfApproval: true }) }),
      }),
      'GET /v1/ledger/journals/:id': () => ({ body: current }),
      'POST /v1/ledger/journals/:id/post': () => {
        current = journal({
          status: 'posted',
          reference: 'JV-000007',
          postedBy: person(USER, 'Omar'),
          postedAt: '2026-10-12T09:00:00.000Z',
          selfApproved: true,
          can: { edit: false, post: false, discard: false, reverse: true },
        });
        return { body: current };
      },
    });
    const { container } = renderScreen(<JournalScreen journalId={JOURNAL} />, client);

    expect(await screen.findByRole('heading', { name: /Draft journal/u })).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Post' }));
    const dialog = await screen.findByRole('dialog', { name: 'Post this journal' });
    const confirm = within(dialog).getByRole('button', { name: 'Post' });
    expect(confirm).toBeDisabled();
    await user.click(within(dialog).getByLabelText(/approve it myself/u));
    await user.click(confirm);

    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith('/post'))?.body).toEqual({
        selfApprove: true,
      }),
    );
    expect(await screen.findByRole('heading', { name: /JV-000007/u })).toBeInTheDocument();
    expect(screen.getByText(/Posted by the person who drafted it/u)).toBeInTheDocument();
  });

  it('explains that a second person posts the drafter’s journal', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/ledger': () => ({ body: overview() }),
      'GET /v1/ledger/journals/:id': () => ({
        body: journal({ can: { edit: true, post: false, discard: true, reverse: false } }),
      }),
    });
    renderScreen(<JournalScreen journalId={JOURNAL} />, client);
    expect(await screen.findByText(/so someone else posts it/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Post' })).not.toBeInTheDocument();
  });

  it('posts another person’s draft without self-approval, and says a refusal in words', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/ledger': () => ({ body: overview() }),
      'GET /v1/ledger/journals/:id': () => ({
        body: journal({ draftedBy: person(OTHER, 'Sara') }),
      }),
      'POST /v1/ledger/journals/:id/post': () =>
        apiError(409, 'period_locked', '2026-10 is locked. Date it in an open month.'),
    });
    renderScreen(<JournalScreen journalId={JOURNAL} />, client);
    await user.click(await screen.findByRole('button', { name: 'Post' }));
    const dialog = await screen.findByRole('dialog', { name: 'Post this journal' });
    expect(within(dialog).queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Post' }));
    expect(
      await within(dialog).findByText('That month is locked. Date it in an open month.'),
    ).toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('/post'))?.body).toEqual({
      selfApprove: false,
    });
  });
});

const posting = (overrides: Partial<PostingDetail> = {}): PostingDetail => ({
  id: POSTING,
  source: { kind: 'invoice', id: INVOICE },
  label: 'INV-000012',
  documentDate: '2026-10-05',
  currency: 'USD',
  amount: '114',
  status: 'pending',
  reason: 'foreign_currency',
  detail: null,
  journal: null,
  resolvedBy: null,
  resolvedAt: null,
  skipReason: null,
  capturedAt: '2026-10-05T09:00:00.000Z',
  lines: [
    {
      account: { id: RECEIVABLES, code: '1200', name: 'Accounts receivable', type: 'asset' },
      debit: '114',
      credit: '0',
      customer: { id: CUSTOMER, name: 'Riverside Housing' },
    },
    {
      account: { id: REVENUE, code: '4100', name: 'Service revenue', type: 'income' },
      debit: '0',
      credit: '114',
      customer: null,
    },
  ],
  totals: { debit: '114', credit: '114', balanced: true },
  companyCurrency: 'EGP',
  invoice: null,
  can: { post: true, skip: true },
  ...overrides,
});

describe('the unposted list', { timeout: 20_000 }, () => {
  it('needs a rate and its source before a document in another currency posts', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/ledger': () => ({ body: overview() }),
      'GET /v1/ledger/postings/:id': () => ({ body: posting() }),
      'POST /v1/ledger/postings/:id/post': () => ({
        body: journal({ status: 'posted', reference: 'JV-000008', kind: 'automatic' }),
      }),
    });
    const { container, navigate } = renderScreen(<UnpostedScreen postingId={POSTING} />, client);

    expect(await screen.findByRole('heading', { name: /INV-000012/u })).toBeInTheDocument();
    expect(screen.getByText('Waiting: In another currency')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open the document' })).toHaveAttribute(
      'href',
      `/finance/invoices/${INVOICE}`,
    );
    expect(await accessibilityViolations(container)).toEqual([]);

    const post = screen.getByRole('button', { name: 'Post as proposed' });
    expect(post).toBeDisabled();
    await user.type(screen.getByLabelText('EGP per 1 USD'), '48.5');
    expect(post).toBeDisabled();
    // The converted lines are previewed; the server does the conversion.
    expect(screen.getByText(/The server does the conversion/u)).toBeInTheDocument();
    expect(screen.getAllByText('EGP 5,529.00').length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText('Where the rate came from'), 'Central Bank, 5 Oct');
    expect(post).toBeEnabled();
    await user.click(post);

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/ledger/journals/${JOURNAL}`));
    expect(calls.find((call) => call.path.endsWith('/post'))!.body).toEqual({
      rate: '48.5',
      rateSource: 'Central Bank, 5 Oct',
    });
  });

  it('says a credit note waits for its invoice and offers no posting', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/ledger': () => ({ body: overview() }),
      'GET /v1/ledger/postings/:id': () => ({
        body: posting({
          source: { kind: 'credit_note', id: INVOICE },
          label: 'CN-000003',
          currency: 'EGP',
          reason: 'waits_for_invoice',
          invoice: { id: OTHER, label: 'INV-000012', status: 'pending' },
          can: { post: false, skip: true },
        }),
      }),
    });
    renderScreen(<UnpostedScreen postingId={POSTING} />, client);
    expect(await screen.findByText('Follows INV-000012 (Waiting).')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open its entry' })).toHaveAttribute(
      'href',
      `/ledger/unposted/${OTHER}`,
    );
    expect(screen.queryByRole('button', { name: 'Post as proposed' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Set aside' })).toBeInTheDocument();
  });
});

describe('reports', { timeout: 20_000 }, () => {
  it('downloads the trial balance as CSV with formula-like cells escaped', async () => {
    const user = userEvent.setup();
    const download = vi.fn();
    const trial: TrialBalance = {
      date: '2026-10-12',
      rows: [
        {
          account: { id: CASH, code: '1100', name: 'Cash, on hand', type: 'asset' },
          debit: '500',
          credit: '0',
        },
        {
          account: { id: OPENING, code: '3900', name: '=HYPERLINK("x")', type: 'equity' },
          debit: '0',
          credit: '500',
        },
      ],
      totals: { debit: '500', credit: '500', balanced: true },
      leftOut: { drafts: 2, waiting: 0 },
    };
    const { client, calls } = fakeApi({
      'GET /v1/me': me(READ),
      'GET /v1/ledger': () => ({ body: overview() }),
      'GET /v1/ledger/reports/trial-balance': () => ({ body: trial }),
    });
    const { container } = renderScreen(<LedgerReportsScreen />, client, { download });

    expect(await screen.findByText('=HYPERLINK("x")')).toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('/trial-balance'))?.query.get('date')).toBe(
      '2026-10-12',
    );
    expect(screen.getByText(/Debits equal credits/u)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /2 draft journals dated in it/u })).toHaveAttribute(
      'href',
      '/ledger/journals',
    );
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Download CSV' }));
    expect(download).toHaveBeenCalledTimes(1);
    const [blob, filename] = download.mock.calls[0] as [Blob, string];
    expect(filename).toBe('trial-balance-2026-10-12.csv');
    expect(blob.type).toBe('text/csv;charset=utf-8');
    const text = await blob.text();
    expect(text).toContain('1100,"Cash, on hand",Asset,500,0');
    expect(text).toContain(`3900,"'=HYPERLINK(""x"")",Equity,0,500`);
    expect(text).toContain('Totals,,,500,500');
  });

  it('heads the profit and loss as a management report and ranges over the year to date', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(READ),
      'GET /v1/ledger': () => ({ body: overview() }),
      'GET /v1/ledger/reports/trial-balance': () => ({
        body: {
          date: '2026-10-12',
          rows: [],
          totals: { debit: '0', credit: '0', balanced: false },
          leftOut: { drafts: 0, waiting: 0 },
        },
      }),
      'GET /v1/ledger/reports/profit-and-loss': () => ({
        body: {
          from: '2026-01-01',
          to: '2026-10-12',
          income: [
            {
              account: { id: REVENUE, code: '4100', name: 'Service revenue', type: 'income' },
              amount: '900',
            },
          ],
          expenses: [],
          totalIncome: '900',
          totalExpenses: '0',
          net: '900',
          leftOut: { drafts: 0, waiting: 0 },
        },
      }),
    });
    renderScreen(<LedgerReportsScreen />, client);
    await user.selectOptions(await screen.findByLabelText('Report'), 'profitAndLoss');
    expect(
      await screen.findByText('Management report — not statutory accounts'),
    ).toBeInTheDocument();
    expect(await screen.findByText('Net profit')).toBeInTheDocument();
    const call = calls.find((candidate) => candidate.path.endsWith('/profit-and-loss'))!;
    expect(call.query.get('from')).toBe('2026-01-01');
    expect(call.query.get('to')).toBe('2026-10-12');
  });
});

const year = (overrides: Partial<LedgerYear> = {}): LedgerYear => ({
  start: '2026-01-01',
  end: '2026-12-31',
  status: 'open',
  lockedMonths: 0,
  months: 12,
  close: null,
  reopened: [],
  can: { close: false, reopen: false },
  ...overrides,
});

describe('months and years', { timeout: 20_000 }, () => {
  it('closes an ended year after saying what closing does', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/ledger': () => ({ body: overview() }),
      'GET /v1/ledger/years': () => ({
        body: {
          items: [
            year(),
            year({ start: '2025-01-01', end: '2025-12-31', can: { close: true, reopen: false } }),
          ],
        },
      }),
      'GET /v1/ledger/periods': (call) => ({
        body: {
          year: { start: call.query.get('date') ?? '2026-01-01', end: '2026-12-31' },
          months: [
            {
              month: '2026-01-01',
              locked: true,
              changedBy: person(USER, 'Omar'),
              changedAt: '2026-02-03T10:00:00.000Z',
            },
            { month: '2026-02-01', locked: false, changedBy: null, changedAt: null },
          ],
          events: [],
        },
      }),
      'POST /v1/ledger/years/:start/close': () => ({
        status: 201,
        body: journal({ kind: 'closing', status: 'posted', reference: 'JV-000099' }),
      }),
    });
    const { container } = renderScreen(<LedgerPeriodsScreen />, client);

    expect(await screen.findByRole('button', { name: 'Lock February 2026' })).toBeInTheDocument();
    // Only the owner unlocks: an admin sees no unlock.
    expect(screen.queryByRole('button', { name: 'Unlock January 2026' })).not.toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Close the year' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close this fiscal year' });
    expect(
      within(dialog).getByText(/posts a closing journal on its last day/u),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/Every month of the year is locked/u)).toBeInTheDocument();
    expect(calls.some((call) => call.path.endsWith('/close'))).toBe(false);
    await user.click(within(dialog).getByRole('button', { name: 'Close the year' }));

    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith('/close'))?.path).toBe(
        '/v1/ledger/years/2025-01-01/close',
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Close this fiscal year' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('says why a close was refused', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/ledger': () => ({ body: overview() }),
      'GET /v1/ledger/years': () => ({
        body: { items: [year({ can: { close: true, reopen: false } })] },
      }),
      'GET /v1/ledger/periods': () => ({
        body: { year: { start: '2026-01-01', end: '2026-12-31' }, months: [], events: [] },
      }),
      'POST /v1/ledger/years/:start/close': () =>
        apiError(409, 'year_not_ready', 'Post or discard the 1 draft journal(s) first.'),
    });
    renderScreen(<LedgerPeriodsScreen />, client);
    await user.click(await screen.findByRole('button', { name: 'Close the year' }));
    const dialog = await screen.findByRole('dialog', { name: 'Close this fiscal year' });
    await user.click(within(dialog).getByRole('button', { name: 'Close the year' }));
    expect(
      await within(dialog).findByText(/Post or discard the draft journals/u),
    ).toBeInTheDocument();
  });
});
