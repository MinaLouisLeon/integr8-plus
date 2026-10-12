import { randomUUID } from 'node:crypto';
import { DEFAULT_CHART, toTenantId } from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Invoice,
  InvoiceLineInput,
  IssuerSnapshot,
} from '../repositories/finance-invoices.js';
import type { MovementInput } from '../repositories/inventory-stock.js';
import type { LedgerSettings } from '../repositories/ledger.js';
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
 * Migration 0034 (CRM/ERP plan, phase A1; ADR-0009): documents captured by the
 * database and posted at once — invoices, credit notes, voids, payments and
 * stock at its recorded cost — or left waiting with the reason: switched off,
 * another currency, a cost unknown, a locked month, an invoice not posted yet.
 */

const USER = '00000000-0000-4000-8000-00000000b901';

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

async function setUp(tenant: TenantFixture, startDate = '2026-01-01'): Promise<LedgerSettings> {
  const settings = await repos(tenant, (tx) =>
    tx.ledger.setUp({ startDate, fiscalStartMonth: 1, chart }, USER),
  );
  if (settings === 'already_set_up') {
    throw new Error(settings);
  }
  return settings;
}

const ISSUER: IssuerSnapshot = {
  name: 'Northwind Services Ltd',
  address: '5 Nile Street, Cairo',
  taxReference: null,
  paymentInstructions: null,
  footer: null,
};

const LINES: InvoiceLineInput[] = [
  {
    description: 'Annual service',
    quantity: '2',
    unitPrice: '100',
    discountBp: 1000,
    taxRateBp: 1400,
  },
  { description: 'Call-out', quantity: '1', unitPrice: '50' },
];

async function customer(tenant: TenantFixture, name: string) {
  return repos(tenant, (tx) => tx.customers.create({ name }, USER));
}

async function invoice(
  tenant: TenantFixture,
  customerId: string,
  options: { lines?: InvoiceLineInput[]; currency?: string; issueDate?: string } = {},
): Promise<Invoice> {
  const drafted = await repos(tenant, (tx) =>
    tx.financeInvoices.createInvoice(
      { customerId, currencyCode: options.currency ?? 'EGP' },
      options.lines ?? LINES,
      USER,
    ),
  );
  const issued = await repos(tenant, (tx) =>
    tx.financeInvoices.issue(drafted.id, drafted.version, {
      issuedBy: USER,
      issueDate: options.issueDate ?? '2026-10-11',
      dueDate: '2026-11-10',
      customerName: 'Riverside Housing',
      customerAddress: {
        line1: '1 River Road',
        line2: null,
        city: 'Cairo',
        region: null,
        postcode: null,
        countryCode: 'EG',
      },
      contactName: null,
      contactEmail: null,
      issuer: ISSUER,
    }),
  );
  if (typeof issued === 'string') {
    throw new Error(issued);
  }
  return issued;
}

async function journalOf(
  tenant: TenantFixture,
  kind: 'invoice' | 'credit_note' | 'invoice_void' | 'payment' | 'stock',
  id: string,
) {
  const posting = await repos(tenant, (tx) => tx.ledger.postingBySource(kind, id));
  if (posting?.journalId === null || posting === undefined) {
    return { posting, lines: [] as [string, string, string, string | null][] };
  }
  const journalId = posting.journalId;
  const [lines, accounts] = await Promise.all([
    repos(tenant, (tx) => tx.ledger.lines(journalId)),
    repos(tenant, (tx) => tx.ledger.accounts()),
  ]);
  const code = new Map(accounts.map((account) => [account.id, account.code]));
  return {
    posting,
    journal: await repos(tenant, (tx) => tx.ledger.find(journalId)),
    lines: lines.map(
      (line) =>
        [code.get(line.accountId) ?? '?', line.debit, line.credit, line.customerId] as [
          string,
          string,
          string,
          string | null,
        ],
    ),
  };
}

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  northwind = await createTenant('posting-northwind');
  await setUp(northwind);
});

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

describe('sales', () => {
  it('posts an issued invoice at once: receivables, revenue by kind, and the tax', async () => {
    const riverside = await customer(northwind, 'Riverside Housing');
    const part = await repos(northwind, (tx) =>
      tx.inventoryCatalogue.createItem(
        { sku: 'VAL-1', name: 'Ball valve', kind: 'stock_item' },
        USER,
      ),
    );
    const issued = await invoice(northwind, riverside.id, {
      lines: [
        ...LINES,
        {
          itemId: part.id,
          description: 'Ball valve',
          quantity: '3',
          unitPrice: '10',
          taxRateBp: 1400,
        },
      ],
    });
    const { posting, journal, lines } = await journalOf(northwind, 'invoice', issued.id);
    expect(posting).toMatchObject({
      status: 'posted',
      documentDate: '2026-10-11',
      amount: '289.4',
    });
    expect(journal).toMatchObject({
      kind: 'automatic',
      status: 'posted',
      entryDate: '2026-10-11',
      sourceKind: 'invoice',
    });
    expect(journal?.memo).toMatch(/^INV-\d{6}$/u);
    // 180 + 50 for services, 30 for the valve, and 14 % of 180 and of 30.
    expect(lines).toEqual([
      ['1200', '289.4', '0', riverside.id],
      ['4100', '0', '230', null],
      ['4200', '0', '30', null],
      ['2200', '0', '29.4', null],
    ]);
  });

  it('reverses a credit note and a void, and posts a payment to the bank', async () => {
    const riverside = await customer(northwind, 'Credit Ltd');
    const issued = await invoice(northwind, riverside.id);
    const note = await repos(northwind, (tx) =>
      tx.financeInvoices.createCreditNote(
        issued.id,
        'Call-out waived',
        [{ description: 'Call-out', quantity: '1', unitPrice: '50' }],
        USER,
      ),
    );
    if (typeof note === 'string') {
      throw new Error(note);
    }
    await repos(northwind, (tx) =>
      tx.financeInvoices.issueCreditNote(note.id, note.version, USER, '2026-10-12'),
    );
    expect((await journalOf(northwind, 'credit_note', note.id)).lines).toEqual([
      ['4100', '50', '0', null],
      ['1200', '0', '50', riverside.id],
    ]);

    const voided = await invoice(northwind, riverside.id);
    await repos(northwind, (tx) =>
      tx.financeInvoices.voidInvoice(voided.id, voided.version, USER, 'Raised in error'),
    );
    const reversal = await journalOf(northwind, 'invoice_void', voided.id);
    expect(reversal.posting?.status).toBe('posted');
    // The invoice's lines, mirrored.
    expect(reversal.lines).toEqual([
      ['1200', '0', '255.2', riverside.id],
      ['4100', '230', '0', null],
      ['2200', '25.2', '0', null],
    ]);

    const paid = await repos(northwind, (tx) =>
      tx.financePayments.recordReceipt(
        {
          customerId: riverside.id,
          receivedOn: '2026-10-13',
          amount: '100',
          currencyCode: 'EGP',
          method: 'bank_transfer',
          paymentReference: null,
        },
        USER,
      ),
    );
    if (typeof paid === 'string') {
      throw new Error(paid);
    }
    expect((await journalOf(northwind, 'payment', paid.id)).lines).toEqual([
      ['1110', '100', '0', null],
      ['1200', '0', '100', riverside.id],
    ]);
  });

  it('waits when switched off or in another currency; a credit note waits for its invoice', async () => {
    const tenant = await createTenant('posting-off');
    const settings = await setUp(tenant);
    await repos(tenant, (tx) =>
      tx.ledger.saveSettings(settings.version, { autoPostSales: false }, USER),
    );
    const riverside = await customer(tenant, 'Waiting Ltd');
    const issued = await invoice(tenant, riverside.id);
    const waiting = await repos(tenant, (tx) => tx.ledger.postingBySource('invoice', issued.id));
    expect(waiting).toMatchObject({ status: 'pending', reason: 'auto_off', amount: '255.2' });
    expect(await repos(tenant, (tx) => tx.ledger.proposal('invoice', issued.id))).toHaveLength(3);

    const note = await repos(tenant, (tx) =>
      tx.financeInvoices.createCreditNote(
        issued.id,
        'Waived',
        [{ description: 'Call-out', quantity: '1', unitPrice: '50' }],
        USER,
      ),
    );
    if (typeof note === 'string') {
      throw new Error(note);
    }
    await repos(tenant, (tx) =>
      tx.financeInvoices.issueCreditNote(note.id, note.version, USER, '2026-10-12'),
    );
    const noteWaits = await repos(tenant, (tx) =>
      tx.ledger.postingBySource('credit_note', note.id),
    );
    expect(noteWaits).toMatchObject({ status: 'pending', reason: 'auto_off' });
    // Forced, the credit note still waits for its invoice; posting the invoice takes it too.
    expect(await repos(tenant, (tx) => tx.ledger.tryPost(noteWaits!.id, USER, true))).toBe(
      'waits_for_invoice',
    );
    expect(await repos(tenant, (tx) => tx.ledger.tryPost(waiting!.id, USER, true))).toBe('posted');
    expect(
      await repos(tenant, (tx) => tx.ledger.postingBySource('credit_note', note.id)),
    ).toMatchObject({
      status: 'posted',
    });
    expect(await repos(tenant, (tx) => tx.ledger.pendingCounts())).toEqual({});

    const dollars = await invoice(tenant, riverside.id, { currency: 'USD' });
    expect(
      await repos(tenant, async (tx) =>
        tx.ledger.tryPost((await tx.ledger.postingBySource('invoice', dollars.id))!.id, USER, true),
      ),
    ).toBe('foreign_currency');
    expect(await repos(tenant, (tx) => tx.ledger.pendingCounts())).toEqual({ foreign_currency: 1 });
  });

  it('sets aside what depends on an invoice set aside, and waits in a locked month', async () => {
    const tenant = await createTenant('posting-skip');
    const settings = await setUp(tenant);
    await repos(tenant, (tx) =>
      tx.ledger.saveSettings(settings.version, { autoPostSales: false }, USER),
    );
    const riverside = await customer(tenant, 'Skipped Ltd');
    const issued = await invoice(tenant, riverside.id);
    const waiting = (await repos(tenant, (tx) => tx.ledger.postingBySource('invoice', issued.id)))!;
    expect(
      await repos(tenant, (tx) => tx.ledger.skip(waiting.id, USER, 'Posted by hand last year')),
    ).toBe(true);
    await repos(tenant, (tx) =>
      tx.financeInvoices.voidInvoice(issued.id, issued.version, USER, 'Raised in error'),
    );
    const voidPosting = (await repos(tenant, (tx) =>
      tx.ledger.postingBySource('invoice_void', issued.id),
    ))!;
    expect(await repos(tenant, (tx) => tx.ledger.tryPost(voidPosting.id, USER, true))).toBe(
      'skipped',
    );
    expect(await repos(tenant, (tx) => tx.ledger.posting(voidPosting.id))).toMatchObject({
      status: 'skipped',
      skipReason: 'Its invoice was set aside',
    });

    await repos(tenant, (tx) => tx.ledger.setPeriodLocked('2026-10-01', true, USER, null));
    const locked = await invoice(tenant, riverside.id);
    const lockedPosting = (await repos(tenant, (tx) =>
      tx.ledger.postingBySource('invoice', locked.id),
    ))!;
    expect(await repos(tenant, (tx) => tx.ledger.tryPost(lockedPosting.id, USER, true))).toBe(
      'period_locked',
    );
  });

  it('captures nothing for a company without a ledger, or dated before its start', async () => {
    const tenant = await createTenant('posting-none');
    const riverside = await customer(tenant, 'No Ledger Ltd');
    const issued = await invoice(tenant, riverside.id);
    expect(
      await repos(tenant, (tx) => tx.ledger.postingBySource('invoice', issued.id)),
    ).toBeUndefined();
    await setUp(tenant, '2026-11-01');
    const early = await invoice(tenant, riverside.id, { issueDate: '2026-10-31' });
    expect(
      await repos(tenant, (tx) => tx.ledger.postingBySource('invoice', early.id)),
    ).toBeUndefined();
    // Set up later, from an earlier start: what was recorded since joins the list for review.
    const late = await createTenant('posting-backfill');
    const backfilled = await customer(late, 'Backfill Ltd');
    const before = await invoice(late, backfilled.id, { issueDate: '2026-09-30' });
    const after = await invoice(late, backfilled.id, { issueDate: '2026-10-11' });
    await setUp(late, '2026-10-01');
    expect(await repos(late, (tx) => tx.ledger.backfill())).toBe(1);
    expect(
      await repos(late, (tx) => tx.ledger.postingBySource('invoice', before.id)),
    ).toBeUndefined();
    expect(await repos(late, (tx) => tx.ledger.postingBySource('invoice', after.id))).toMatchObject(
      {
        status: 'pending',
        reason: 'before_set_up',
      },
    );
  });
});

describe('stock', () => {
  it('posts goods received, parts used and adjustments at their cost; transfers post nothing', async () => {
    const valve = await repos(northwind, (tx) =>
      tx.inventoryCatalogue.createItem({ sku: 'VAL-2', name: 'Valve', kind: 'stock_item' }, USER),
    );
    const store = await repos(northwind, (tx) =>
      tx.inventoryStock.createLocation({ name: 'Store', kind: 'warehouse' }),
    );
    const van = await repos(northwind, (tx) =>
      tx.inventoryStock.createLocation({ name: 'Van', kind: 'warehouse' }),
    );
    const post = async (movements: MovementInput[]) => {
      const postingId = randomUUID();
      await repos(northwind, (tx) =>
        tx.inventoryStock.post(movements, { postingId, actorId: USER }),
      );
      return postingId;
    };

    const received = await post([
      {
        itemId: valve.id,
        locationId: store.id,
        kind: 'receipt',
        quantity: '10',
        unitCost: '12.5',
        sourceKey: `receipt-line:${randomUUID()}`,
      },
    ]);
    expect((await journalOf(northwind, 'stock', received)).lines).toEqual([
      ['1300', '125', '0', null],
      ['2150', '0', '125', null],
    ]);

    const used = await post([
      {
        itemId: valve.id,
        locationId: store.id,
        kind: 'consumption',
        quantity: '-2',
        unitCost: '12.5',
        sourceKey: randomUUID(),
      },
    ]);
    expect((await journalOf(northwind, 'stock', used)).lines).toEqual([
      ['5100', '25', '0', null],
      ['1300', '0', '25', null],
    ]);

    const moved = await post([
      {
        itemId: valve.id,
        locationId: store.id,
        kind: 'transfer_out',
        quantity: '-1',
        unitCost: '12.5',
        sourceKey: randomUUID(),
      },
      {
        itemId: valve.id,
        locationId: van.id,
        kind: 'transfer_in',
        quantity: '1',
        unitCost: '12.5',
        sourceKey: randomUUID(),
      },
    ]);
    expect(
      await repos(northwind, (tx) => tx.ledger.postingBySource('stock', moved)),
    ).toBeUndefined();

    const unknown = await post([
      {
        itemId: valve.id,
        locationId: store.id,
        kind: 'adjustment',
        quantity: '1',
        sourceKey: randomUUID(),
      },
    ]);
    expect(
      await repos(northwind, (tx) => tx.ledger.postingBySource('stock', unknown)),
    ).toMatchObject({
      status: 'pending',
      reason: 'cost_unknown',
    });
  });
});

describe('the queue', () => {
  it('is written only by the database, and what is resolved stays resolved', async () => {
    const riverside = await customer(northwind, 'Final Ltd');
    const issued = await invoice(northwind, riverside.id);
    const posting = (await repos(northwind, (tx) =>
      tx.ledger.postingBySource('invoice', issued.id),
    ))!;
    const app = await connectAsApp();
    try {
      await expect(
        asTenant(app, northwind.id, () =>
          app.query(
            `insert into erp_ledger_postings (tenant_id, source_kind, source_id, document_date, currency, reason)
             values ($1, 'invoice', $2, '2026-10-11', 'EGP', 'queued')`,
            [northwind.id, randomUUID()],
          ),
        ),
      ).rejects.toThrow(/permission denied/u);
      await expect(
        asTenant(app, northwind.id, () =>
          app.query(
            `update erp_ledger_postings set status = 'skipped', skip_reason = 'x', journal_id = null, resolved_at = now() where id = $1`,
            [posting.id],
          ),
        ),
      ).rejects.toMatchObject({ constraint: 'erp_ledger_postings_final' });
      await expect(
        asTenant(app, northwind.id, () =>
          app.query(`delete from erp_ledger_postings where id = $1`, [posting.id]),
        ),
      ).rejects.toThrow(/permission denied/u);
    } finally {
      await app.end();
    }
  });
});
