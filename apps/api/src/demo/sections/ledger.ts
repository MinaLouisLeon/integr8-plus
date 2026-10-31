import { day, type DemoContext, monthStart } from '../context.js';

/**
 * The general ledger.
 *
 * `seedLedgerSetup` runs early, before anything posts, so every invoice,
 * payment, stock movement, expense and pay run that follows lands in it. It
 * also writes the invoicing company's details (finance settings), because
 * every invoice reads them.
 *
 * `seedLedgerActivity` runs near the end: manual journals in each state, the
 * waiting automatic postings posted, and the first month locked.
 *
 * Adds to refs:
 *   ledgerAccounts  account code ('1110', '4100', …) → account id
 *   ledgerStart     the ledger's start date, YYYY-MM-DD
 */

interface Account {
  id: string;
  code: string;
}

interface Journal {
  id: string;
  version?: number;
}

export async function seedLedgerSetup(ctx: DemoContext): Promise<void> {
  // Who issues the invoices. Every invoice section reads this.
  const finance = await ctx.call<{ version: number }>('owner', 'GET', '/v1/finance/settings');
  await ctx.call('owner', 'PUT', '/v1/finance/settings', {
    expectedVersion: finance.version,
    legalName: 'Nile Delta Facilities S.A.E.',
    address: '42 Abbas El Akkad Street, Nasr City, Cairo 11765, Egypt',
    taxReference: '100-200-300',
    paymentInstructions:
      'Bank transfer to National Bank of Egypt, account 1234 5678 9012, IBAN EG38 0019 0005 0000 0000 1234 5678 9. Please quote the invoice number.',
    footer: 'Thank you for your business. Payment is due within 30 days.',
    defaultDueDays: 30,
    labourHourlyCost: '250.00',
    labourHourlyRate: '650.00',
  });
  ctx.log('invoice issuer details, 30-day terms');

  // Two months back, so there is a closed month to lock and an opening balance.
  const startDate = monthStart(-2);
  const setUp = await ctx.call<{
    settings: { version: number };
    openingJournal: { id: string } | null;
  }>('owner', 'POST', '/v1/ledger/setup', { startDate, fiscalStartMonth: 1, language: 'en' });
  ctx.refs.ledgerStart = startDate;

  // Self-approval on, so the owner can post the opening balances alone; the
  // manual journals later still show the two-person flow.
  await ctx.call('owner', 'PUT', '/v1/ledger/settings', {
    expectedVersion: setUp.settings.version,
    autoPostSales: true,
    autoPostStock: true,
    autoPostExpenses: true,
    autoPostPayroll: true,
    allowSelfApproval: true,
  });

  const { items } = await ctx.call<{ items: Account[] }>('owner', 'GET', '/v1/ledger/accounts');
  const accounts: Record<string, string> = {};
  for (const account of items) {
    accounts[account.code] = account.id;
  }
  ctx.refs.ledgerAccounts = accounts;

  // Opening balances: cash, bank, vehicles, against capital and retained earnings.
  const opening = [
    { accountId: accounts['1100'], debit: '25000.00', memo: 'Petty cash' },
    {
      accountId: accounts['1110'],
      debit: '850000.00',
      memo: 'National Bank of Egypt current account',
    },
    { accountId: accounts['1500'], debit: '1200000.00', memo: 'Three service vans and tools' },
    { accountId: accounts['1590'], credit: '240000.00', memo: 'Depreciation to date' },
    { accountId: accounts['3100'], credit: '1500000.00' },
    { accountId: accounts['3200'], credit: '335000.00' },
  ];
  const body = { entryDate: startDate, memo: 'Opening balances', lines: opening };
  const journal =
    setUp.openingJournal === null
      ? await ctx.call<Journal>('owner', 'POST', '/v1/ledger/journals', {
          ...body,
          kind: 'opening',
        })
      : await ctx.call<Journal>(
          'owner',
          'PUT',
          `/v1/ledger/journals/${setUp.openingJournal.id}`,
          body,
        );
  await ctx.attempt('owner', 'POST', `/v1/ledger/journals/${journal.id}/post`, {
    selfApprove: true,
  });

  ctx.log(`ledger from ${startDate}, ${String(items.length)} accounts, opening balances posted`);
}

export async function seedLedgerActivity(ctx: DemoContext): Promise<void> {
  const accounts = ctx.refs.ledgerAccounts as Record<string, string> | undefined;
  const startDate = ctx.refs.ledgerStart as string | undefined;
  if (accounts === undefined || startDate === undefined) {
    ctx.log('no ledger set up; skipped');
    return;
  }

  // The automatic postings everything else left waiting: invoices, payments,
  // stock, expenses, pay runs.
  const posted = await ctx.call<{ posted: number; skipped: number }>(
    'owner',
    'POST',
    '/v1/ledger/postings/post-all',
    {},
  );

  // Manual journals, drafted by the admin and posted by the owner.
  const draft = (entryDate: string, memo: string, lines: Record<string, unknown>[]) =>
    ctx.call<Journal>('admin', 'POST', '/v1/ledger/journals', { entryDate, memo, lines });
  const post = (journal: Journal) =>
    ctx.call('owner', 'POST', `/v1/ledger/journals/${journal.id}/post`, {});

  const firstMonth = startDate.slice(0, 8);
  const rent = await draft(`${firstMonth}05`, 'Office and warehouse rent', [
    { accountId: accounts['6300'], debit: '45000.00' },
    { accountId: accounts['1110'], credit: '45000.00' },
  ]);
  await post(rent);

  const lastMonth = monthStart(-1).slice(0, 8);
  for (const [memo, account, amount] of [
    ['Office and warehouse rent', '6300', '45000.00'],
    ['Fuel cards for the vans', '6200', '18750.00'],
    ['Electricity, water and phones', '6400', '6320.00'],
    ['Bank charges', '6500', '410.00'],
  ] as const) {
    await post(
      await draft(`${lastMonth}10`, memo, [
        { accountId: accounts[account], debit: amount },
        { accountId: accounts['1110'], credit: amount },
      ]),
    );
  }

  // Posted to the wrong account, reversed, then posted again correctly.
  const wrong = await draft(day(-3), 'Van insurance', [
    { accountId: accounts['6400'], debit: '12000.00' },
    { accountId: accounts['1110'], credit: '12000.00' },
  ]);
  await post(wrong);
  await ctx.attempt('owner', 'POST', `/v1/ledger/journals/${wrong.id}/reverse`, {
    entryDate: day(-2),
    memo: 'Reversed: should have gone to vehicles',
  });
  await post(
    await draft(day(-2), 'Van insurance', [
      { accountId: accounts['6200'], debit: '12000.00' },
      { accountId: accounts['1110'], credit: '12000.00' },
    ]),
  );

  // Left as a draft, waiting for the owner.
  await draft(day(0), 'Prepaid annual software subscription', [
    { accountId: accounts['1400'], debit: '9600.00' },
    { accountId: accounts['1110'], credit: '9600.00' },
  ]);

  // The first month is closed.
  await ctx.attempt('owner', 'POST', `/v1/ledger/periods/${startDate}/lock`);

  ctx.log(
    `${String(posted.posted)} automatic postings posted, 8 manual journals (1 reversed, 1 draft), ${startDate.slice(0, 7)} locked`,
  );
}
