import { toTenantId } from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Invoice, IssuerSnapshot } from '../repositories/finance-invoices.js';
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
 * Migration 0030 (CRM/ERP plan, phase B1; ADR-0007): a company's invoices and
 * credit notes — what the database keeps true whatever the API does: numbers
 * given only when issued and never twice, an issued invoice that never
 * changes, a void only while nothing is paid or credited, a credit never
 * larger than what is owed, settings per company — and a company with issued
 * documents can still be purged.
 */

const USER = '00000000-0000-4000-8000-00000000f601';

let owner: pg.Client;
let northwind: TenantFixture;
let southgate: TenantFixture;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  northwind = await createTenant('fin-northwind');
  southgate = await createTenant('fin-southgate');
});

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

const repos = <T>(
  tenant: TenantFixture,
  fn: Parameters<typeof withUnprotectedRepositories<T>>[1],
) => withUnprotectedRepositories(toTenantId(tenant.id), fn);

const ISSUER: IssuerSnapshot = {
  name: 'Northwind Services Ltd',
  address: '5 Nile Street, Cairo',
  taxReference: 'TRN-123',
  paymentInstructions: 'Bank transfer to account 001',
  footer: null,
};

const ADDRESS = {
  line1: '1 River Road',
  line2: null,
  city: 'Cairo',
  region: null,
  postcode: null,
  countryCode: 'EG',
};

async function customer(tenant: TenantFixture, name: string) {
  return repos(tenant, (tx) => tx.customers.create({ name }, USER));
}

async function draft(tenant: TenantFixture, customerId: string, lines = defaultLines()) {
  return repos(tenant, (tx) =>
    tx.financeInvoices.createInvoice({ customerId, currencyCode: 'EGP' }, lines, USER),
  );
}

function defaultLines() {
  return [
    {
      description: 'Annual service',
      quantity: '2',
      unitPrice: '100',
      discountBp: 1000,
      taxRateBp: 1400,
    },
    { description: 'Call-out', quantity: '1', unitPrice: '50' },
  ];
}

async function issue(tenant: TenantFixture, invoice: Invoice, issueDate = '2026-10-11') {
  const issued = await repos(tenant, (tx) =>
    tx.financeInvoices.issue(invoice.id, invoice.version, {
      issuedBy: USER,
      issueDate,
      dueDate: '2026-11-10',
      customerName: 'Riverside Housing',
      customerAddress: ADDRESS,
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

describe('settings', () => {
  it('start at the defaults, are saved once per company and refuse a stale version', async () => {
    expect(await repos(northwind, (tx) => tx.financeInvoices.settings())).toMatchObject({
      version: 0,
      defaultDueDays: 30,
      labourHourlyCost: null,
    });
    const saved = await repos(northwind, (tx) =>
      tx.financeInvoices.saveSettings(
        { legalName: ' Northwind Services Ltd ', labourHourlyCost: '150.5', defaultDueDays: 14 },
        0,
        USER,
      ),
    );
    expect(saved).toMatchObject({
      legalName: 'Northwind Services Ltd',
      labourHourlyCost: '150.5',
      defaultDueDays: 14,
      version: 1,
    });
    expect(
      await repos(northwind, (tx) => tx.financeInvoices.saveSettings({ footer: 'x' }, 0, USER)),
    ).toBe('version_conflict');
    expect(
      await repos(northwind, (tx) =>
        tx.financeInvoices.saveSettings({ footer: 'Thanks' }, 1, USER),
      ),
    ).toMatchObject({ footer: 'Thanks', legalName: 'Northwind Services Ltd', version: 2 });
    expect(await repos(southgate, (tx) => tx.financeInvoices.settings())).toMatchObject({
      version: 0,
      legalName: null,
    });
  });
});

describe('an invoice', () => {
  it('is numbered only when issued, in order per company, and a discarded draft leaves no gap', async () => {
    const riverside = await customer(northwind, 'Numbered Ltd');
    const elsewhere = await customer(southgate, 'Elsewhere Ltd');
    const first = await draft(northwind, riverside.id);
    expect(first).toMatchObject({ reference: null, status: 'draft' });
    const discarded = await draft(northwind, riverside.id);
    expect(
      await repos(northwind, (tx) =>
        tx.financeInvoices.discardDraft(discarded.id, discarded.version),
      ),
    ).toBe(true);
    const second = await draft(northwind, riverside.id);
    const one = await issue(northwind, first);
    const two = await issue(northwind, second);
    expect(two.reference).toBe(one.reference! + 1);
    const theirs = await issue(southgate, await draft(southgate, elsewhere.id));
    expect(theirs.reference).toBe(1);
    expect(one).toMatchObject({
      status: 'issued',
      issueDate: '2026-10-11',
      dueDate: '2026-11-10',
      customerName: 'Riverside Housing',
      customerAddress: ADDRESS,
      issuer: ISSUER,
    });
    // The number never changes.
    await expect(
      owner.query(`update erp_invoices set reference = reference + 100 where id = $1`, [one.id]),
    ).rejects.toMatchObject({ constraint: 'finance_reference_fixed' });
  });

  it('adds up exactly in SQL, and its balance follows credit notes', async () => {
    const riverside = await customer(northwind, 'Totals Ltd');
    const invoice = await issue(northwind, await draft(northwind, riverside.id));
    // 2 × 100 = 200, less 10% = 180, plus 14% = 205.2; plus 50 → 255.2.
    expect(await repos(northwind, (tx) => tx.financeInvoices.invoiceTotals(invoice.id))).toEqual({
      gross: '250',
      discount: '20',
      net: '230',
      tax: '25.2',
      total: '255.2',
    });
    const amounts = await repos(northwind, (tx) => tx.financeInvoices.invoiceAmounts([invoice.id]));
    expect(amounts.get(invoice.id)).toEqual({
      total: '255.2',
      allocated: '0',
      credited: '0',
      balance: '255.2',
    });
  });

  it('never changes once issued, and is never deleted', async () => {
    const riverside = await customer(northwind, 'Frozen Ltd');
    const invoice = await issue(northwind, await draft(northwind, riverside.id));
    await expect(
      owner.query(`update erp_invoice_lines set unit_price = 1 where invoice_id = $1`, [
        invoice.id,
      ]),
    ).rejects.toMatchObject({ constraint: 'erp_invoice_lines_frozen' });
    await expect(
      owner.query(
        `insert into erp_invoice_lines (tenant_id, invoice_id, position, description, quantity, unit_price)
                   values ($1, $2, 9, 'Sneaked in', 1, 1)`,
        [northwind.id, invoice.id],
      ),
    ).rejects.toMatchObject({ constraint: 'erp_invoice_lines_frozen' });
    await expect(
      owner.query(`update erp_invoices set notes = 'changed' where id = $1`, [invoice.id]),
    ).rejects.toMatchObject({ constraint: 'erp_invoices_frozen' });
    await expect(
      owner.query(`delete from erp_invoices where id = $1`, [invoice.id]),
    ).rejects.toMatchObject({
      constraint: 'erp_invoices_frozen',
    });
    expect(
      await repos(northwind, (tx) =>
        tx.financeInvoices.updateDraft(invoice.id, invoice.version, { notes: 'x' }, undefined),
      ),
    ).toBe('not_draft');
    expect(
      await repos(northwind, (tx) => tx.financeInvoices.discardDraft(invoice.id, invoice.version)),
    ).toBe('not_draft');
  });

  it('is voided while nothing is credited against it, keeping its number, and a void never changes', async () => {
    const riverside = await customer(northwind, 'Void Ltd');
    const invoice = await issue(northwind, await draft(northwind, riverside.id));
    const voided = await repos(northwind, (tx) =>
      tx.financeInvoices.voidInvoice(invoice.id, invoice.version, USER, 'Raised in error'),
    );
    expect(voided).toMatchObject({
      status: 'void',
      reference: invoice.reference,
      voidReason: 'Raised in error',
    });
    await expect(
      owner.query(
        `update erp_invoices set status = 'issued', voided_at = null, voided_by = null, void_reason = null where id = $1`,
        [invoice.id],
      ),
    ).rejects.toMatchObject({ constraint: 'erp_invoices_frozen' });

    // Credited: it can no longer be voided.
    const credited = await issue(northwind, await draft(northwind, riverside.id));
    const note = await repos(northwind, (tx) =>
      tx.financeInvoices.createCreditNote(
        credited.id,
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
    expect(
      await repos(northwind, (tx) =>
        tx.financeInvoices.voidInvoice(credited.id, credited.version, USER, 'Too late'),
      ),
    ).toBe('settled');
  });
});

describe('a credit note', () => {
  it('is numbered when issued, reduces the balance, and never takes off more than is owed', async () => {
    const riverside = await customer(northwind, 'Credit Ltd');
    const invoice = await issue(northwind, await draft(northwind, riverside.id));
    const lines = await repos(northwind, (tx) => tx.financeInvoices.invoiceLines(invoice.id));

    // A draft credit note against a draft invoice is refused.
    const draftInvoice = await draft(northwind, riverside.id);
    expect(
      await repos(northwind, (tx) =>
        tx.financeInvoices.createCreditNote(draftInvoice.id, 'No', [], USER),
      ),
    ).toBe('invoice_not_open');

    const partial = await repos(northwind, (tx) =>
      tx.financeInvoices.createCreditNote(
        invoice.id,
        'One service not done',
        [
          {
            invoiceLineId: lines[0]!.id,
            description: lines[0]!.description,
            quantity: '1',
            unitPrice: '100',
            discountBp: 1000,
            taxRateBp: 1400,
          },
        ],
        USER,
      ),
    );
    if (typeof partial === 'string') {
      throw new Error(partial);
    }
    expect(partial).toMatchObject({ reference: null, status: 'draft' });
    const issued = await repos(northwind, (tx) =>
      tx.financeInvoices.issueCreditNote(partial.id, partial.version, USER, '2026-10-12'),
    );
    expect(issued).toMatchObject({ status: 'issued', issueDate: '2026-10-12' });
    expect(typeof issued !== 'string' && issued.reference).toBeGreaterThan(0);
    // 100 less 10% = 90, plus 14% = 102.6 off 255.2.
    expect(
      (await repos(northwind, (tx) => tx.financeInvoices.invoiceAmounts([invoice.id]))).get(
        invoice.id,
      ),
    ).toEqual({ total: '255.2', allocated: '0', credited: '102.6', balance: '152.6' });

    // More than the 152.6 still owed is refused, and leaves nothing behind.
    const tooMuch = await repos(northwind, (tx) =>
      tx.financeInvoices.createCreditNote(
        invoice.id,
        'Everything',
        lines.map((line) => ({
          description: line.description,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          discountBp: line.discountBp,
          taxRateBp: line.taxRateBp,
        })),
        USER,
      ),
    );
    if (typeof tooMuch === 'string') {
      throw new Error(tooMuch);
    }
    expect(
      await repos(northwind, (tx) =>
        tx.financeInvoices.issueCreditNote(tooMuch.id, tooMuch.version, USER, '2026-10-12'),
      ),
    ).toBe('over_balance');
    const empty = await repos(northwind, (tx) =>
      tx.financeInvoices.createCreditNote(invoice.id, 'Nothing', [], USER),
    );
    if (typeof empty === 'string') {
      throw new Error(empty);
    }
    expect(
      await repos(northwind, (tx) =>
        tx.financeInvoices.issueCreditNote(empty.id, empty.version, USER, '2026-10-12'),
      ),
    ).toBe('empty');

    // An issued credit note never changes.
    await expect(
      owner.query(`update erp_credit_notes set reason = 'changed' where id = $1`, [partial.id]),
    ).rejects.toMatchObject({ constraint: 'erp_credit_notes_frozen' });
    await expect(
      owner.query(`update erp_credit_note_lines set unit_price = 1 where credit_note_id = $1`, [
        partial.id,
      ]),
    ).rejects.toMatchObject({ constraint: 'erp_credit_note_lines_frozen' });
    await expect(
      owner.query(`delete from erp_credit_notes where id = $1`, [partial.id]),
    ).rejects.toMatchObject({ constraint: 'erp_credit_notes_frozen' });

    // Credited in full, the invoice reads `credited`.
    const rest = await repos(northwind, (tx) =>
      tx.financeInvoices.createCreditNote(
        invoice.id,
        'The rest',
        [{ description: 'Balance', quantity: '1', unitPrice: '152.6' }],
        USER,
      ),
    );
    if (typeof rest === 'string') {
      throw new Error(rest);
    }
    await repos(northwind, (tx) =>
      tx.financeInvoices.issueCreditNote(rest.id, rest.version, USER, '2026-10-13'),
    );
    const page = await repos(northwind, (tx) =>
      tx.financeInvoices.listInvoices({ statuses: ['credited'], customerId: riverside.id }),
    );
    expect(page.items.map((row) => row.id)).toEqual([invoice.id]);
  });
});

describe('finding invoices', () => {
  it('by reference, customer words, derived status and overdue', async () => {
    const riverside = await customer(northwind, 'Findable Housing');
    const issued = await issue(northwind, await draft(northwind, riverside.id), '2026-09-01');
    const drafted = await draft(northwind, riverside.id);
    const byReference = await repos(northwind, (tx) =>
      tx.financeInvoices.listInvoices({ text: `INV-${String(issued.reference).padStart(6, '0')}` }),
    );
    expect(byReference.items.map((row) => row.id)).toEqual([issued.id]);
    const byWords = await repos(northwind, (tx) =>
      tx.financeInvoices.listInvoices({ text: 'findable', customerId: riverside.id }),
    );
    expect(byWords.items.map((row) => row.id).sort()).toEqual([issued.id, drafted.id].sort());
    const drafts = await repos(northwind, (tx) =>
      tx.financeInvoices.listInvoices({ statuses: ['draft'], customerId: riverside.id }),
    );
    expect(drafts.items.map((row) => row.id)).toEqual([drafted.id]);
    const overdue = await repos(northwind, (tx) =>
      tx.financeInvoices.listInvoices({
        overdue: { today: '2026-12-01' },
        customerId: riverside.id,
      }),
    );
    expect(overdue.items.map((row) => row.id)).toEqual([issued.id]);
    expect(
      (
        await repos(southgate, (tx) =>
          tx.financeInvoices.listInvoices({ customerId: riverside.id }),
        )
      ).items,
    ).toEqual([]);
  });
});

async function receipt(
  tenant: TenantFixture,
  customerId: string,
  amount: string,
  currencyCode = 'EGP',
) {
  return repos(tenant, (tx) =>
    tx.financePayments.recordReceipt(
      {
        customerId,
        receivedOn: '2026-10-12',
        amount,
        currencyCode,
        method: 'bank_transfer',
        paymentReference: ' TRX-1 ',
      },
      USER,
    ),
  );
}

describe('a payment', () => {
  it('is numbered when recorded, allocated within what it has and what the invoice owes, and the rest stays on account', async () => {
    const riverside = await customer(northwind, 'Paying Ltd');
    const first = await issue(northwind, await draft(northwind, riverside.id)); // 255.2
    const second = await issue(northwind, await draft(northwind, riverside.id)); // 255.2
    const paid = await receipt(northwind, riverside.id, '300');
    expect(paid).toMatchObject({
      amount: '300',
      paymentReference: 'TRX-1',
      receivedOn: '2026-10-12',
    });
    expect(paid.reference).toBeGreaterThan(0);
    const later = await receipt(northwind, riverside.id, '1');
    expect(later.reference).toBe(paid.reference + 1);

    expect(
      await repos(northwind, (tx) => tx.financePayments.allocate(paid.id, first.id, '300', USER)),
    ).toBe('over_invoice');
    const whole = await repos(northwind, (tx) =>
      tx.financePayments.allocate(paid.id, first.id, '255.2', USER),
    );
    expect(whole).toMatchObject({ amount: '255.2', removedAt: null });
    if (typeof whole === 'string') {
      throw new Error(whole);
    }
    expect(
      await repos(northwind, (tx) => tx.financePayments.allocate(paid.id, second.id, '50', USER)),
    ).toBe('over_receipt');
    expect(
      await repos(northwind, (tx) => tx.financePayments.allocate(paid.id, second.id, '44.8', USER)),
    ).toMatchObject({ amount: '44.8' });

    const amounts = await repos(northwind, (tx) =>
      tx.financeInvoices.invoiceAmounts([first.id, second.id]),
    );
    expect(amounts.get(first.id)).toMatchObject({ allocated: '255.2', balance: '0' });
    expect(amounts.get(second.id)).toMatchObject({ allocated: '44.8', balance: '210.4' });
    expect(
      (await repos(northwind, (tx) => tx.financePayments.receiptAmounts([paid.id]))).get(paid.id),
    ).toEqual({ amount: '300', allocated: '300', unallocated: '0' });
    const paidPage = await repos(northwind, (tx) =>
      tx.financeInvoices.listInvoices({ statuses: ['paid'], customerId: riverside.id }),
    );
    expect(paidPage.items.map((row) => row.id)).toEqual([first.id]);

    // A paid invoice is not voided.
    expect(
      await repos(northwind, (tx) =>
        tx.financeInvoices.voidInvoice(first.id, first.version, USER, 'No'),
      ),
    ).toBe('settled');

    // Removing an allocation puts the money back on account; the record stays.
    const removed = await repos(northwind, (tx) =>
      tx.financePayments.removeAllocation(whole.id, USER),
    );
    expect(removed).toMatchObject({ removedBy: USER });
    expect(
      await repos(northwind, (tx) => tx.financePayments.removeAllocation(whole.id, USER)),
    ).toBe('already_removed');
    expect(
      await repos(northwind, (tx) => tx.financePayments.customerAccount(riverside.id)),
    ).toEqual([{ currencyCode: 'EGP', owed: '465.6', unallocated: '256.2', net: '209.4' }]);
    expect(
      (await repos(northwind, (tx) => tx.financePayments.allocationsForReceipt(paid.id))).map(
        (row) => row.removedAt === null,
      ),
    ).toEqual([false, true]);
  });

  it('goes only to the same customer’s issued invoices in its currency', async () => {
    const riverside = await customer(northwind, 'Strict Ltd');
    const other = await customer(northwind, 'Other Ltd');
    const theirs = await issue(northwind, await draft(northwind, other.id));
    const drafted = await draft(northwind, riverside.id);
    const paid = await receipt(northwind, riverside.id, '100');
    const dollars = await receipt(northwind, riverside.id, '100', 'USD');
    const mine = await issue(northwind, await draft(northwind, riverside.id));
    expect(
      await repos(northwind, (tx) => tx.financePayments.allocate(paid.id, theirs.id, '10', USER)),
    ).toBe('mismatch');
    expect(
      await repos(northwind, (tx) => tx.financePayments.allocate(dollars.id, mine.id, '10', USER)),
    ).toBe('mismatch');
    expect(
      await repos(northwind, (tx) => tx.financePayments.allocate(paid.id, drafted.id, '10', USER)),
    ).toBe('invoice_not_open');
    // Another company cannot even see the receipt.
    expect(await repos(southgate, (tx) => tx.financePayments.findReceipt(paid.id))).toBeUndefined();
  });

  it('cannot be spent twice by two allocations at once', async () => {
    const riverside = await customer(northwind, 'Racing Ltd');
    const a = await issue(northwind, await draft(northwind, riverside.id));
    const b = await issue(northwind, await draft(northwind, riverside.id));
    const paid = await receipt(northwind, riverside.id, '100');
    const results = await Promise.all([
      repos(northwind, (tx) => tx.financePayments.allocate(paid.id, a.id, '60', USER)),
      repos(northwind, (tx) => tx.financePayments.allocate(paid.id, b.id, '60', USER)),
    ]);
    expect(results.filter((result) => typeof result === 'string')).toEqual(['over_receipt']);
    expect(
      (await repos(northwind, (tx) => tx.financePayments.receiptAmounts([paid.id]))).get(paid.id),
    ).toEqual({ amount: '100', allocated: '60', unallocated: '40' });
  });

  it('is never changed or deleted by the application, and an allocation only ever removed', async () => {
    const riverside = await customer(northwind, 'Immutable Ltd');
    const invoice = await issue(northwind, await draft(northwind, riverside.id));
    const paid = await receipt(northwind, riverside.id, '10');
    const allocation = await repos(northwind, (tx) =>
      tx.financePayments.allocate(paid.id, invoice.id, '10', USER),
    );
    if (typeof allocation === 'string') {
      throw new Error(allocation);
    }
    const app = await connectAsApp();
    try {
      await expect(
        asTenant(app, northwind.id, () =>
          app.query(`update erp_payment_receipts set amount = 1 where id = $1`, [paid.id]),
        ),
      ).rejects.toThrow(/permission denied/u);
      await expect(
        asTenant(app, northwind.id, () =>
          app.query(`delete from erp_payment_receipts where id = $1`, [paid.id]),
        ),
      ).rejects.toThrow(/permission denied/u);
      await expect(
        asTenant(app, northwind.id, () =>
          app.query(`update erp_payment_allocations set amount = 1 where id = $1`, [allocation.id]),
        ),
      ).rejects.toMatchObject({ constraint: 'erp_payment_allocations_frozen' });
    } finally {
      await app.end();
    }
  });
});

describe('deleting a company', () => {
  it('takes its issued quotes, orders, invoices and credit notes with it', async () => {
    const tenant = await createTenant('fin-purge');
    const riverside = await customer(tenant, 'Purged Ltd');
    const quote = await repos(tenant, (tx) =>
      tx.salesQuotes.createQuote(
        { customerId: riverside.id, title: 'Quote', currencyCode: 'EGP' },
        [{ description: 'Line', quantity: '1', unitPrice: '10' }],
        USER,
      ),
    );
    await repos(tenant, (tx) =>
      tx.salesQuotes.issue(quote.id, quote.version, {
        issuedBy: USER,
        snapshot: {
          customerName: 'Purged Ltd',
          customerAddress: ADDRESS,
          contactName: null,
          contactEmail: null,
          contactPhone: null,
        },
        tokenHash: 'f'.repeat(64),
      }),
    );
    const order = await repos(tenant, (tx) =>
      tx.salesOrders.createOrder(
        { customerId: riverside.id, title: 'Order', currencyCode: 'EGP' },
        [{ description: 'Line', quantity: '1', unitPrice: '10' }],
        USER,
      ),
    );
    await repos(tenant, (tx) =>
      tx.salesOrders.confirm(order.id, order.version, {
        confirmedBy: USER,
        customerName: 'Purged Ltd',
        customerAddress: ADDRESS,
        reserveLocationId: null,
      }),
    );
    const invoice = await issue(tenant, await draft(tenant, riverside.id));
    const note = await repos(tenant, (tx) =>
      tx.financeInvoices.createCreditNote(
        invoice.id,
        'Part',
        [{ description: 'x', quantity: '1', unitPrice: '1' }],
        USER,
      ),
    );
    if (typeof note === 'string') {
      throw new Error(note);
    }
    await repos(tenant, (tx) =>
      tx.financeInvoices.issueCreditNote(note.id, note.version, USER, '2026-10-12'),
    );

    const exported = await owner.query<{ id: string }>(
      `insert into tenant_exports (tenant_id, tenant_slug, status, object_key)
       values ($1, 'fin-purge', 'ready', 'exports/fin-purge.zip') returning id`,
      [tenant.id],
    );
    await owner.query(
      `insert into tenant_deletions (tenant_id, tenant_slug, export_id, reason, purge_after)
       values ($1, 'fin-purge', $2, 'Integration test of the purge', now() - interval '1 minute')`,
      [tenant.id, exported.rows[0]!.id],
    );
    await owner.query(`select purge_tenant($1)`, [tenant.id]);
    for (const table of [
      'crm_quote_lines',
      'erp_sales_order_lines',
      'erp_invoices',
      'erp_credit_notes',
    ]) {
      const left = await owner.query(
        `select count(*)::int as n from ${table} where tenant_id = $1`,
        [tenant.id],
      );
      expect(left.rows[0], table).toEqual({ n: 0 });
    }
    // Outside a purge the guards still hold, the owner included.
    const survivor = await issue(
      northwind,
      await draft(northwind, (await customer(northwind, 'Still here')).id),
    );
    await expect(
      owner.query(`delete from erp_invoices where id = $1`, [survivor.id]),
    ).rejects.toMatchObject({
      constraint: 'erp_invoices_frozen',
    });
    // The runtime role cannot pass for the purge by setting its marker.
    const app = await connectAsApp();
    try {
      await expect(
        asTenant(app, northwind.id, async () => {
          await app.query(`select set_config('integr8.purging', $1, true)`, [northwind.id]);
          await app.query(`delete from erp_invoices where id = $1`, [survivor.id]);
        }),
      ).rejects.toMatchObject({ constraint: 'erp_invoices_frozen' });
    } finally {
      await app.end();
    }
  });
});
