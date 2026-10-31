import { toTenantId } from '@integr8/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type TenantTransaction, withTenant } from '../connection.js';
import {
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  useTestDatabase,
  withUnprotectedRepositories,
} from './harness.js';

/**
 * The figures the assistant reports (docs/ai), counted in the database.
 *
 * The first version read a page of rows and called it the whole: the newest
 * hundred invoices, two hundred customers. These companies have more than
 * that, and the oldest debts are made first, so a page of the newest would
 * miss exactly the invoices that matter.
 */

const USER = '00000000-0000-4000-8000-00000000f701';
const TODAY = '2026-10-31';

let tenant: TenantFixture;

const repos = <T>(fn: (tx: TenantTransaction) => Promise<T>) =>
  withUnprotectedRepositories(toTenantId(tenant.id), fn);

beforeAll(async () => {
  useTestDatabase();
  tenant = await createTenant('ai-figures');
});

afterAll(async () => {
  await releaseTestDatabase();
});

/** `2026-01-01` plus `days`. */
function dayAfterNewYear(days: number): string {
  return new Date(Date.UTC(2026, 0, 1 + days)).toISOString().slice(0, 10);
}

describe('figures past a page of rows', () => {
  it('counts every customer by status', async () => {
    await repos(async (tx) => {
      for (let i = 0; i < 230; i += 1) {
        await tx.customers.create(
          {
            name: `Figures customer ${String(i).padStart(3, '0')}`,
            status: i < 200 ? 'active' : i < 220 ? 'on_hold' : 'closed',
          },
          USER,
        );
      }
    });

    const counts = await withTenant(tenant.id, (tx) => tx.customers.countByStatus());
    expect(counts).toEqual({ active: 200, on_hold: 20, closed: 10 });
    expect(await repos((tx) => tx.customers.countMatching('Figures customer'))).toBe(230);
  });

  it('sums every invoice still owing, and finds the genuinely oldest overdue', async () => {
    const [big, small] = await repos(async (tx) => [
      await tx.customers.create({ name: 'Big Debtor' }, USER),
      await tx.customers.create({ name: 'Small Debtor' }, USER),
    ]);
    if (big === undefined || small === undefined) {
      throw new Error('customers were not made');
    }

    // 120 invoices of 100 EGP, the oldest first: due on day 0, 1, 2, … of the
    // year. The last ten are not due until next year.
    const ids = await repos(async (tx) => {
      const made: string[] = [];
      for (let i = 0; i < 120; i += 1) {
        const draft = await tx.financeInvoices.createInvoice(
          { customerId: i < 100 ? big.id : small.id, currencyCode: 'EGP' },
          [{ description: 'Service', quantity: '1', unitPrice: '100' }],
          USER,
        );
        const issued = await tx.financeInvoices.issue(draft.id, draft.version, {
          issuedBy: USER,
          issueDate: '2026-01-01',
          dueDate: i < 110 ? dayAfterNewYear(i) : '2027-06-30',
          customerName: i < 100 ? 'Big Debtor' : 'Small Debtor',
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
          issuer: {
            name: 'Figures Ltd',
            address: null,
            taxReference: null,
            paymentInstructions: null,
            footer: null,
          },
        });
        if (typeof issued === 'string') {
          throw new Error(issued);
        }
        made.push(issued.id);
      }
      return made;
    });

    // The very oldest is paid in full, the next one in part.
    await repos(async (tx) => {
      const payment = await tx.financePayments.recordReceipt(
        {
          customerId: big.id,
          receivedOn: '2026-10-01',
          amount: '140',
          currencyCode: 'EGP',
          method: 'bank_transfer',
          paymentReference: 'FIG-1',
        },
        USER,
      );
      await tx.financePayments.allocate(payment.id, ids[0] ?? '', '100', USER);
      await tx.financePayments.allocate(payment.id, ids[1] ?? '', '40', USER);
    });

    // Through the runtime path, so RLS and the tenant guard both see the query.
    const summary = await withTenant(tenant.id, (tx) =>
      tx.financeInvoices.receivablesSummary({ today: TODAY, oldestLimit: 3, customersLimit: 1 }),
    );

    // 119 owing (the partly paid one included), 109 of them past due.
    expect(summary.unpaid).toBe(119);
    expect(summary.overdue).toBe(109);
    expect(summary.owing).toEqual([{ currency: 'EGP', amount: '11860', overdue: '10860' }]);
    expect(summary.customersOwing).toBe(2);
    expect(summary.byCustomer).toEqual([
      {
        customerId: big.id,
        customer: 'Big Debtor',
        currency: 'EGP',
        invoices: 99,
        amount: '9860',
      },
    ]);
    // The oldest overdue are the oldest, not the newest page's oldest.
    expect(summary.oldestOverdue.map((invoice) => [invoice.dueDate, invoice.balance])).toEqual([
      [dayAfterNewYear(1), '60'],
      [dayAfterNewYear(2), '100'],
      [dayAfterNewYear(3), '100'],
    ]);

    const forSmall = await withTenant(tenant.id, (tx) =>
      tx.financeInvoices.receivablesSummary({ today: TODAY, customerId: small.id }),
    );
    expect(forSmall.unpaid).toBe(20);
    expect(forSmall.overdue).toBe(10);
  });
});
