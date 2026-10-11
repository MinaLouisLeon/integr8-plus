import { toTenantId } from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDecimals } from '../repositories/sales-quotes.js';
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
 * Migration 0029 (CRM/ERP plan, phase S1): quotes — the rules the database
 * keeps whatever the API does: numbering per company, exact totals, lines
 * frozen once issued, one answer, and one link token per quote.
 */

const USER = '00000000-0000-4000-8000-00000000f501';

let owner: pg.Client;
let northwind: TenantFixture;
let southgate: TenantFixture;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  northwind = await createTenant('qt-northwind');
  southgate = await createTenant('qt-southgate');
});

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

const repos = <T>(
  tenant: TenantFixture,
  fn: Parameters<typeof withUnprotectedRepositories<T>>[1],
) => withUnprotectedRepositories(toTenantId(tenant.id), fn);

async function customer(tenant: TenantFixture, name: string) {
  return repos(tenant, (tx) => tx.customers.create({ name }, USER));
}

const SNAPSHOT = {
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
  contactPhone: null,
};

describe('references', () => {
  it('numbers quotes QT-000001 onwards per company, apart from sales orders', async () => {
    const a = await customer(northwind, 'Riverside');
    const b = await customer(southgate, 'Elsewhere');
    const first = await repos(northwind, (tx) =>
      tx.salesQuotes.createQuote(
        { customerId: a.id, title: 'Boiler', currencyCode: 'EGP' },
        [],
        USER,
      ),
    );
    const second = await repos(northwind, (tx) =>
      tx.salesQuotes.createQuote(
        { customerId: a.id, title: 'Pump', currencyCode: 'EGP' },
        [],
        USER,
      ),
    );
    const other = await repos(southgate, (tx) =>
      tx.salesQuotes.createQuote(
        { customerId: b.id, title: 'Theirs', currencyCode: 'EGP' },
        [],
        USER,
      ),
    );
    expect(second.reference).toBe(first.reference + 1);
    expect(other.reference).toBe(1);
    expect(first.revision).toBe(1);
  });
});

describe('totals', () => {
  it('are exact per line and summed in SQL: gross, discount, net, tax, total', async () => {
    const riverside = await customer(northwind, 'Totals Ltd');
    const { lines, totals } = await repos(northwind, async (tx) => {
      const quote = await tx.salesQuotes.createQuote(
        { customerId: riverside.id, title: 'Service', currencyCode: 'EGP' },
        [
          // 3 × 0.1 = 0.3; 20% off → 0.06; net 0.24; 14% tax → 0.0336
          {
            description: 'Cable',
            quantity: '3',
            unitPrice: '0.1',
            discountBp: 2000,
            taxRateBp: 1400,
          },
          // 1.5 × 2 = 3; no discount; no tax
          { description: 'Labour', quantity: '1.5', unit: 'hour', unitPrice: '2' },
        ],
        USER,
      );
      return {
        lines: await tx.salesQuotes.quoteLines(quote.id),
        totals: await tx.salesQuotes.quoteTotals(quote.id),
      };
    });
    expect(
      lines.map((line) => [line.gross, line.discount, line.net, line.tax, line.total]),
    ).toEqual([
      ['0.3', '0.06', '0.24', '0.0336', '0.2736'],
      ['3', '0', '3', '0', '3'],
    ]);
    expect(totals).toEqual({
      gross: '3.3',
      discount: '0.06',
      net: '3.24',
      tax: '0.0336',
      total: '3.2736',
    });
  });

  it('adds decimal strings without a float in sight', () => {
    expect(addDecimals('0.1', '0.2')).toBe('0.3');
    expect(addDecimals('9999999999999999.9999', '0.0001')).toBe('10000000000000000');
    expect(addDecimals('1', '-1.5')).toBe('-0.5');
    expect(addDecimals('0', '0')).toBe('0');
  });
});

describe('an issued quote', () => {
  it('freezes its lines and its customer; revising makes a new draft revision', async () => {
    const riverside = await customer(northwind, 'Frozen Ltd');
    const quote = await repos(northwind, (tx) =>
      tx.salesQuotes.createQuote(
        { customerId: riverside.id, title: 'Service', currencyCode: 'EGP' },
        [{ description: 'Cable', quantity: '4', unitPrice: '1' }],
        USER,
      ),
    );
    const issued = await repos(northwind, (tx) =>
      tx.salesQuotes.issue(quote.id, quote.version, {
        issuedBy: USER,
        snapshot: SNAPSHOT,
        tokenHash: 'a'.repeat(64),
      }),
    );
    expect(issued).toMatchObject({
      status: 'issued',
      customerName: 'Riverside Housing',
      customerAddress: SNAPSHOT.customerAddress,
      hasToken: true,
    });

    await expect(
      owner.query(`update crm_quote_lines set unit_price = 99 where quote_id = $1`, [quote.id]),
    ).rejects.toMatchObject({ constraint: 'crm_quote_lines_frozen' });
    await expect(
      owner.query(`delete from crm_quote_lines where quote_id = $1`, [quote.id]),
    ).rejects.toMatchObject({ constraint: 'crm_quote_lines_frozen' });
    expect(
      await repos(northwind, (tx) =>
        tx.salesQuotes.updateDraft(quote.id, quote.version + 1, {}, []),
      ),
    ).toBe('not_draft');

    // Another quote cannot carry the same link token.
    const second = await repos(northwind, (tx) =>
      tx.salesQuotes.createQuote(
        { customerId: riverside.id, title: 'Second', currencyCode: 'EGP' },
        [{ description: 'Cable', quantity: '1', unitPrice: '1' }],
        USER,
      ),
    );
    await expect(
      repos(northwind, (tx) =>
        tx.salesQuotes.issue(second.id, second.version, {
          issuedBy: USER,
          snapshot: SNAPSHOT,
          tokenHash: 'a'.repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ constraint: 'crm_quotes_token_unique' });

    const revised = await repos(northwind, (tx) =>
      tx.salesQuotes.revise(quote.id, quote.version + 1),
    );
    expect(revised).toMatchObject({
      status: 'draft',
      revision: 2,
      reference: quote.reference,
      customerName: null,
      hasToken: false,
    });
    // A draft again: the lines may change.
    const edited = await repos(northwind, (tx) =>
      tx.salesQuotes.updateDraft(quote.id, quote.version + 2, { title: 'Service, revised' }, [
        { description: 'Cable, more', quantity: '5', unitPrice: '1' },
      ]),
    );
    expect(edited).toMatchObject({ title: 'Service, revised', version: quote.version + 3 });
  });

  it('keeps its bookkeeping paired: no issued quote without who and when, no answer without a way', async () => {
    const riverside = await customer(northwind, 'Pairing Ltd');
    const quote = await repos(northwind, (tx) =>
      tx.salesQuotes.createQuote(
        { customerId: riverside.id, title: 'Service', currencyCode: 'EGP' },
        [],
        USER,
      ),
    );
    // Whichever pairing Postgres checks first names the gap; any of them will do.
    const pairing: { constraint: unknown } = {
      constraint: expect.stringMatching(/^crm_quotes_\w+_pairing$/u) as unknown,
    };
    for (const status of ['issued', 'accepted', 'converted']) {
      await expect(
        owner.query(`update crm_quotes set status = $2 where id = $1`, [quote.id, status]),
      ).rejects.toMatchObject(pairing);
    }
  });

  it('records one answer, spends the link, and refuses a stale version', async () => {
    const riverside = await customer(northwind, 'Answer Ltd');
    const quote = await repos(northwind, (tx) =>
      tx.salesQuotes.createQuote(
        { customerId: riverside.id, title: 'Service', currencyCode: 'EGP' },
        [{ description: 'Cable', quantity: '1', unitPrice: '1' }],
        USER,
      ),
    );
    const issued = await repos(northwind, (tx) =>
      tx.salesQuotes.issue(quote.id, quote.version, {
        issuedBy: USER,
        snapshot: SNAPSHOT,
        tokenHash: 'b'.repeat(64),
      }),
    );
    expect(typeof issued).not.toBe('string');
    const accepted = await repos(northwind, (tx) =>
      tx.salesQuotes.answer(quote.id, {
        status: 'accepted',
        via: 'link',
        answeredBy: null,
        name: 'Sam at Riverside',
        from: '203.0.113.9',
        reason: null,
      }),
    );
    expect(accepted).toMatchObject({
      status: 'accepted',
      answeredVia: 'link',
      answeredName: 'Sam at Riverside',
      answeredFrom: '203.0.113.9',
      hasToken: false,
    });
    expect(await repos(northwind, (tx) => tx.salesQuotes.cancel(quote.id, 1, USER, 'late'))).toBe(
      'version_conflict',
    );
    expect(
      await repos(northwind, (tx) =>
        tx.salesQuotes.cancel('00000000-0000-4000-8000-00000000fff0', 1, USER, null),
      ),
    ).toBe('not_found');
  });

  it('finds quotes by reference, words and customer, newest first', async () => {
    const riverside = await customer(northwind, 'Findable Housing');
    const made = await repos(northwind, (tx) =>
      tx.salesQuotes.createQuote(
        { customerId: riverside.id, title: 'Annual boiler service', currencyCode: 'EGP' },
        [],
        USER,
      ),
    );
    const byReference = await repos(northwind, (tx) =>
      tx.salesQuotes.listQuotes({ text: `QT-${String(made.reference).padStart(6, '0')}` }),
    );
    expect(byReference.items.map((quote) => quote.id)).toEqual([made.id]);
    const byWord = await repos(northwind, (tx) => tx.salesQuotes.listQuotes({ text: 'boiler' }));
    expect(byWord.items.map((quote) => quote.id)).toContain(made.id);
    const byCustomer = await repos(northwind, (tx) =>
      tx.salesQuotes.listQuotes({ text: 'findable' }),
    );
    expect(byCustomer.items.map((quote) => quote.id)).toContain(made.id);
    const elsewhere = await repos(southgate, (tx) => tx.salesQuotes.listQuotes({}));
    expect(elsewhere.items.map((quote) => quote.id)).not.toContain(made.id);
  });
});
