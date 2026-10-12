# ADR-0009 — General ledger

**Status:** Accepted (A1 planning, 2026-10-12)

## Context

The plan gates the general ledger (ERP-08, phase A1) behind the product
owner's explicit authorization and agreed accounting rules: fiscal year, chart
structure, country, tax and posting rules. On 2026-10-12 the product owner
authorized A1 and took the decisions below, one at a time.

By now the company already keeps commercial records that carry money: issued
invoices and credit notes, voided invoices and recorded payments (B1), and an
immutable stock ledger with unit costs for receipts, returns, transfers,
adjustments, counts and parts used on jobs (E1, E2). The ledger turns these
into double-entry journals, and adds what only a ledger has: accounts,
periods, manual journals, and the reports read from them.

This is a management ledger for a field-service company. It makes no claim of
compliance with Egyptian tax law, the ETA e-invoicing or e-receipt systems,
EAS or IFRS, or any other standard; the screens and reports say so.

## Decision — accounts, years and periods

- **Module:** a new `ledger` feature flag, off until Integr8 switches it on
  for a company, independent of `finance` and `inventory` (each only adds
  postings).
- **One currency:** the ledger is kept in the company's currency (EGP by
  default). Amounts are `numeric(20,4)` decimal strings, never floats.
- **Chart of accounts:** created when the ledger is set up, from a default
  Egypt-oriented chart for a service company, in English or Arabic as the
  person setting it up chooses; every name and code is editable afterwards
  and accounts can be added or archived (never deleted once used). Each
  account has a type — asset, liability, equity, income or expense — which
  decides where it appears on the reports and which side is its normal
  balance. Tax charged on invoices goes to a "VAT payable (output)" account.
- **Posting accounts:** a settings map names the account each automatic
  posting uses: receivables, revenue (services; goods), VAT output, cash,
  bank, other receipts, inventory, goods received not invoiced, cost of parts
  used, stock adjustments, opening balances, retained earnings.
- **Fiscal year:** the company chooses the month it starts (default January).
  Periods are calendar months.
- **Start date:** the first day of a month, chosen at setup. Nothing dated
  before it is ever posted. Balances brought forward are entered once as an
  opening-balances journal (approved like any manual journal); receivables
  can be pre-filled from customers' open invoices at that date.
- **Locks:** an owner or admin locks a month once it is closed; nothing can
  be posted into a locked month or before the start date, and corrections go
  into an open month. Only an owner may unlock a month, with a reason, and it
  is audited.
- **Year-end close:** one journal, dated the last day of the year, moves the
  year's income and expenses into retained earnings and locks the year's
  months. Reopening the year is the owner's, with a reason, and reverses the
  closing journal.

## Decision — journals

- **Double entry:** every journal balances — total debits equal total
  credits — and each line is a debit or a credit, never both. The database
  checks it when the transaction commits, whatever the code does.
- **Immutable:** a posted journal and its lines never change and are never
  deleted. A mistake is corrected by a reversal: a new journal that mirrors
  it, dated in an open month, naming the journal it reverses; a journal is
  reversed at most once.
- **Numbering:** `JV-000001` onwards per company, given when posted, never
  reused.
- **Manual journals:** drafted by an owner or admin and posted by a
  different owner or admin (segregation of duties). A company with a single
  person may allow self-approval in its settings (owner only); a journal
  posted that way says so.
- **Source link:** a journal posted from a document names it, and a document
  posts once (unique per source).

## Decision — automatic postings

- **What posts:** sales and stock.
  - Issued invoice: debit receivables (the total); credit revenue (each
    line's net, to goods or services by the line's item, services for a
    hand-written line) and VAT output (the tax).
  - Issued credit note: the reverse, from its own lines.
  - Voided invoice: a reversal of the invoice's journal.
  - Recorded payment: debit cash, bank or other receipts (by its method);
    credit receivables with the whole amount, so money not yet allocated is a
    credit on the customer's side of receivables.
  - Stock, one journal per stock posting, at the recorded unit cost: goods
    received — debit inventory, credit goods received not invoiced; returned
    to the supplier — the reverse; parts used on a job — debit cost of parts
    used, credit inventory, and returned from a job — the reverse;
    adjustments and count differences — inventory against stock adjustments;
    transfers between locations post nothing.
- **Capture:** each of these events is recorded in a posting queue by the
  database itself, so no code path can skip one.
- **Switches:** automatic posting is on by default and switched separately
  for sales and for stock. While a switch is off, its documents wait in the
  **unposted list** with the journal they would make. An owner or admin
  reviews one, may change its accounts or date (within open months), and
  posts it — one or many at once — or marks it "won't post" with a reason.
- **When automatic posting cannot:** a document in a locked month, before
  the start date's month, in another currency, or with a stock line of
  unknown cost, waits in the unposted list with the reason, even while the
  switch is on. The trial balance warns while anything waits.
- **Other currencies:** a document in another currency waits for the
  exchange rate on its date, typed by the accountant and recorded on the
  journal with its source; the journal keeps both amounts. No rate feed, no
  revaluation of open balances, no exchange gains or losses in A1.
- **Before setup:** documents of a company that has not set up its ledger,
  or dated before its start date, are not queued.

## Decision — reports

- Trial balance at a date; account activity (the general ledger detail) for
  a date range; receivables reconciliation — the receivables account against
  customers' open invoices and money on account, with aging by due date.
- A profit and loss for a date range and a balance sheet at a date, labelled
  "management report, not statutory accounts".
- Each printable from the browser and exportable to CSV, with cells that
  would start a spreadsheet formula escaped.

## Decision — who

| Permission      | Owner | Admin | Dispatcher | Engineer | Viewer |
| --------------- | :---: | :---: | :--------: | :------: | :----: |
| `ledger.read`   |   ✓   |   ✓   |     —      |    —     |   ✓    |
| `ledger.post`   |   ✓   |   ✓   |     —      |    —     |   —    |
| `ledger.manage` |   ✓   |   ✓   |     —      |    —     |   —    |
| `ledger.unlock` |   ✓   |   —   |     —      |    —     |   —    |

`ledger.post`: draft and approve manual journals, post or skip from the
unposted list, reverse. `ledger.manage`: set up the ledger, edit the chart and
the posting accounts, switch automatic posting, lock months, close a year.
`ledger.unlock`: unlock a month, reopen a year, allow self-approval.

## Consequences

Every number on the reports is derived from posted journal lines; nothing is
stored as a balance. The commercial records stay the source of truth for what
a customer owes; the receivables reconciliation shows where the two differ
(an unposted document, a manual journal to receivables). Purchasing posts
only goods received against "goods received not invoiced" until supplier
invoices and payables exist, so that account only grows until then; the
screens say so. Payables, supplier invoices, bank reconciliation, budgets,
cost centres, multi-currency revaluation and tax returns are left for later.
