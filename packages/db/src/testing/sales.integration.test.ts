import { toTenantId } from '@integr8/core';
import { randomUUID } from 'node:crypto';
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
 * Migration 0029 (CRM/ERP plan, phase S1): quotes and sales orders — the
 * rules the database keeps whatever the API does: numbering per company,
 * exact totals, lines frozen once issued or confirmed, one answer and one
 * link token per quote, one order per quote, and reservations that never
 * promise more than a location holds (ADR-0006).
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

// ---------------------------------------------------------------------------
// Sales orders
// ---------------------------------------------------------------------------

async function stockItem(
  tenant: TenantFixture,
  sku: string,
  kind: 'stock_item' | 'service' = 'stock_item',
) {
  return repos(tenant, (tx) =>
    tx.inventoryCatalogue.createItem({ sku, name: `Item ${sku}`, kind, salePrice: '10' }, USER),
  );
}

async function store(tenant: TenantFixture, name: string) {
  return repos(tenant, (tx) => tx.inventoryStock.createLocation({ name, kind: 'warehouse' }));
}

async function receive(
  tenant: TenantFixture,
  itemId: string,
  locationId: string,
  quantity: string,
) {
  await repos(tenant, (tx) =>
    tx.inventoryStock.post(
      [{ itemId, locationId, kind: 'receipt', quantity, unitCost: '5', sourceKey: randomUUID() }],
      { postingId: randomUUID(), actorId: USER },
    ),
  );
}

const CONFIRMATION = {
  confirmedBy: USER,
  customerName: 'Riverside Housing',
  customerAddress: SNAPSHOT.customerAddress,
};

describe('a sales order', () => {
  it('is made from an accepted quote once, and numbered SO-000001 onwards apart from quotes', async () => {
    const riverside = await customer(northwind, 'Converted Ltd');
    const quote = await repos(northwind, (tx) =>
      tx.salesQuotes.createQuote(
        { customerId: riverside.id, title: 'Pump', currencyCode: 'EGP' },
        [{ description: 'Pump', quantity: '1', unitPrice: '100' }],
        USER,
      ),
    );
    // Issued and accepted first: only an accepted quote becomes an order.
    await repos(northwind, async (tx) => {
      await tx.salesQuotes.issue(quote.id, quote.version, {
        issuedBy: USER,
        snapshot: SNAPSHOT,
        tokenHash: 'c'.repeat(64),
      });
      await tx.salesQuotes.answer(quote.id, {
        status: 'accepted',
        via: 'office',
        answeredBy: USER,
        name: null,
        from: null,
        reason: null,
      });
    });
    const order = await repos(northwind, async (tx) => {
      const lines = await tx.salesQuotes.quoteLines(quote.id);
      const created = await tx.salesOrders.createOrder(
        {
          customerId: riverside.id,
          quoteId: quote.id,
          title: quote.title,
          currencyCode: quote.currencyCode,
        },
        lines,
        USER,
      );
      await tx.salesQuotes.markConverted(quote.id, created.id);
      return created;
    });
    expect(order).toMatchObject({ status: 'draft', quoteId: quote.id, title: 'Pump' });
    expect(order.reference).toBeGreaterThan(0);
    expect(await repos(northwind, (tx) => tx.salesOrders.orderTotals(order.id))).toEqual({
      gross: '100',
      discount: '0',
      net: '100',
      tax: '0',
      total: '100',
    });
    expect(await repos(northwind, (tx) => tx.salesQuotes.findQuote(quote.id))).toMatchObject({
      status: 'converted',
      convertedOrderId: order.id,
    });
    // The same quote cannot become a second order.
    await expect(
      repos(northwind, (tx) =>
        tx.salesOrders.createOrder(
          { customerId: riverside.id, quoteId: quote.id, title: 'Again', currencyCode: 'EGP' },
          [],
          USER,
        ),
      ),
    ).rejects.toMatchObject({ constraint: 'erp_sales_orders_quote_unique' });
    expect(await repos(northwind, (tx) => tx.salesOrders.findByQuote(quote.id))).toMatchObject({
      id: order.id,
    });
  });

  it('reserves what the location holds when confirmed, flags the rest, and shares stock fairly between orders', async () => {
    const riverside = await customer(northwind, 'Reserving Ltd');
    const valve = await stockItem(northwind, `VALVE-${randomUUID().slice(0, 6)}`);
    const callout = await stockItem(northwind, `CALL-${randomUUID().slice(0, 6)}`, 'service');
    const main = await store(northwind, `Main ${randomUUID().slice(0, 6)}`);
    await receive(northwind, valve.id, main.id, '6');

    const first = await repos(northwind, (tx) =>
      tx.salesOrders.createOrder(
        { customerId: riverside.id, title: 'Four valves', currencyCode: 'EGP' },
        [
          { itemId: valve.id, description: 'Valve', quantity: '4', unitPrice: '10' },
          { itemId: callout.id, description: 'Fitting', quantity: '1', unitPrice: '50' },
        ],
        USER,
      ),
    );
    const confirmed = await repos(northwind, async (tx) => {
      const result = await tx.salesOrders.confirm(first.id, first.version, {
        ...CONFIRMATION,
        reserveLocationId: main.id,
      });
      expect(result).toMatchObject({ status: 'confirmed', customerName: 'Riverside Housing' });
      return tx.salesOrders.reserve(first.id, main.id);
    });
    expect(confirmed.map((line) => [line.quantityReserved, line.shortfall])).toEqual([
      ['4', '0'],
      ['0', '1'], // a service: nothing to hold, delivered by the job
    ]);

    // A second order wants five more; only two are left to promise.
    const second = await repos(northwind, (tx) =>
      tx.salesOrders.createOrder(
        { customerId: riverside.id, title: 'Five valves', currencyCode: 'EGP' },
        [{ itemId: valve.id, description: 'Valve', quantity: '5', unitPrice: '10' }],
        USER,
      ),
    );
    const secondLines = await repos(northwind, async (tx) => {
      await tx.salesOrders.confirm(second.id, second.version, {
        ...CONFIRMATION,
        reserveLocationId: main.id,
      });
      return tx.salesOrders.reserve(second.id, main.id);
    });
    expect(secondLines[0]).toMatchObject({ quantityReserved: '2', shortfall: '3' });
    expect(
      await repos(northwind, (tx) => tx.salesOrders.reservations({ itemId: valve.id })),
    ).toEqual([{ itemId: valve.id, locationId: main.id, reserved: '6' }]);
    expect(
      await repos(northwind, (tx) =>
        tx.salesOrders.reservedElsewhere(valve.id, main.id, [first.id]),
      ),
    ).toBe('2');
    expect(
      await repos(northwind, (tx) => tx.salesOrders.reservedElsewhere(valve.id, main.id, [])),
    ).toBe('6');
    const short = await repos(northwind, (tx) => tx.salesOrders.shortLines());
    expect(short.filter((line) => line.orderId === second.id)).toEqual([
      expect.objectContaining({ itemId: valve.id, shortfall: '3', locationId: main.id }),
    ]);

    // Goods arrive; the second order is re-run and now holds everything it needs.
    await receive(northwind, valve.id, main.id, '10');
    const rerun = await repos(northwind, (tx) => tx.salesOrders.reserve(second.id, main.id));
    expect(rerun[0]).toMatchObject({ quantityReserved: '5', shortfall: '0' });
    expect(
      (await repos(northwind, (tx) => tx.salesOrders.shortLines())).filter(
        (line) => line.orderId === second.id,
      ),
    ).toEqual([]);

    // A confirmed order's lines are frozen; only what is reserved and fulfilled moves.
    expect(
      await repos(northwind, (tx) =>
        tx.salesOrders.updateDraft(first.id, first.version + 2, {}, []),
      ),
    ).toBe('not_draft');
    await expect(
      owner.query(`update erp_sales_order_lines set unit_price = 1 where order_id = $1`, [
        first.id,
      ]),
    ).rejects.toMatchObject({ constraint: 'erp_sales_order_lines_frozen' });

    // Parts used on a linked job deliver the stock line and release what it held.
    const consumed = await repos(northwind, (tx) =>
      tx.salesOrders.consume(first.id, valve.id, '3'),
    );
    expect(consumed).toBe('3');
    let lines = await repos(northwind, (tx) => tx.salesOrders.orderLines(first.id));
    expect(lines[0]).toMatchObject({
      quantityFulfilled: '3',
      quantityReserved: '1',
      shortfall: '0',
    });
    expect(await repos(northwind, (tx) => tx.salesOrders.refreshStatus(first.id))).toMatchObject({
      status: 'partially_fulfilled',
    });
    // More than the order asked for: only the rest of the line counts.
    expect(await repos(northwind, (tx) => tx.salesOrders.consume(first.id, valve.id, '5'))).toBe(
      '1',
    );
    // The linked job completes: the service line is delivered with it.
    expect(await repos(northwind, (tx) => tx.salesOrders.fulfilNonStockLines(first.id))).toBe(1);
    const done = await repos(northwind, (tx) => tx.salesOrders.refreshStatus(first.id));
    expect(done.status).toBe('fulfilled');
    expect(done.fulfilledAt).not.toBeNull();
    lines = await repos(northwind, (tx) => tx.salesOrders.orderLines(first.id));
    expect(lines.map((line) => [line.quantityFulfilled, line.quantityReserved])).toEqual([
      ['4', '0'],
      ['1', '0'],
    ]);

    // Cancelling lets go of everything the order held.
    const cancelled = await repos(northwind, (tx) =>
      tx.salesOrders.cancel(
        second.id,
        rerun.length > 0 ? second.version + 3 : second.version,
        USER,
        'Customer changed their mind',
      ),
    );
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancelReason: 'Customer changed their mind',
    });
    expect(
      await repos(northwind, (tx) => tx.salesOrders.reservations({ itemId: valve.id })),
    ).toEqual([]);
  });

  it('links the jobs that deliver it, and lists them from either side', async () => {
    const riverside = await customer(northwind, 'Linked Ltd');
    const site = await repos(northwind, (tx) =>
      tx.sites.create(riverside.id, { name: 'Block A', address: { line1: '1 River Road' } }, USER),
    );
    const type = await repos(northwind, (tx) =>
      tx.jobTypes.create(
        { name: `Type ${randomUUID().slice(0, 6)}`, code: randomUUID().slice(0, 8) },
        USER,
      ),
    );
    const job = await repos(northwind, (tx) =>
      tx.workOrders.create(
        { customerId: riverside.id, siteId: site.id, jobTypeId: type.id, title: 'Fit the pump' },
        USER,
      ),
    );
    const order = await repos(northwind, (tx) =>
      tx.salesOrders.createOrder(
        { customerId: riverside.id, title: 'Pump', currencyCode: 'EGP' },
        [{ description: 'Pump', quantity: '1', unitPrice: '100' }],
        USER,
      ),
    );
    await repos(northwind, (tx) => tx.salesOrders.linkWorkOrder(order.id, job.id, USER));
    await repos(northwind, (tx) => tx.salesOrders.linkWorkOrder(order.id, job.id, USER)); // twice is once
    expect(await repos(northwind, (tx) => tx.salesOrders.workOrderLinks(order.id))).toEqual([
      expect.objectContaining({ workOrderId: job.id, linkedBy: USER }),
    ]);
    expect(await repos(northwind, (tx) => tx.salesOrders.ordersOfWorkOrder(job.id))).toEqual([
      expect.objectContaining({ id: order.id }),
    ]);
    expect(await repos(northwind, (tx) => tx.salesOrders.unlinkWorkOrder(order.id, job.id))).toBe(
      true,
    );
    expect(await repos(northwind, (tx) => tx.salesOrders.unlinkWorkOrder(order.id, job.id))).toBe(
      false,
    );
    // Another company cannot see it.
    expect(await repos(southgate, (tx) => tx.salesOrders.findOrder(order.id))).toBeUndefined();
  });
});
