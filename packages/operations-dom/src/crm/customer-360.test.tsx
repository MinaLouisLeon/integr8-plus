import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { TimelineEntry } from '../api.js';
import { accessibilityViolations, fakeApi, renderScreen } from '../testing/render.js';
import { CustomerRecordsSection } from './customer-360.js';

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const CUSTOMER = '00000000-0000-4000-8000-000000000302';
const JOB = '00000000-0000-4000-8000-000000000e01';
const QUOTE = '00000000-0000-4000-8000-000000000e02';
const INVOICE = '00000000-0000-4000-8000-000000000e03';
const RECEIPT = '00000000-0000-4000-8000-000000000e04';
const ACTIVITY = '00000000-0000-4000-8000-000000000e05';
const SUBMISSION = '00000000-0000-4000-8000-000000000e06';

const me = (permissions: string[], features: Record<string, boolean>) => () => ({
  body: {
    userId: USER,
    tenantId: TENANT,
    email: 'o@x.example',
    displayName: 'Olu',
    role: 'owner',
    permissions,
    features,
  },
});
const EVERYTHING = { crm: true, sales: true, finance: true };
const READS = ['customer.read', 'crm.read', 'sales.read', 'finance.read', 'work_order.read_all'];

const entry = (overrides: Partial<TimelineEntry>): TimelineEntry => ({
  kind: 'activity',
  at: '2026-10-10T09:00:00.000Z',
  recordId: ACTIVITY,
  reference: null,
  title: null,
  detail: null,
  workOrderId: null,
  ...overrides,
});

const firstPage = [
  entry({
    kind: 'payment_received',
    at: '2026-10-11T12:00:00.000Z',
    recordId: RECEIPT,
    reference: 12,
    title: 'BANK-778',
    detail: '1500.50 EGP',
  }),
  entry({
    kind: 'quote_answered',
    at: '2026-10-11T10:00:00.000Z',
    recordId: QUOTE,
    reference: 31,
    title: 'Chiller service',
    detail: 'accepted',
  }),
  entry({
    kind: 'job_event',
    at: '2026-10-10T15:00:00.000Z',
    recordId: JOB,
    reference: 104,
    title: 'Annual inspection',
    detail: 'signed_off',
    workOrderId: JOB,
  }),
];
const secondPage = [
  entry({
    kind: 'activity',
    at: '2026-10-09T09:00:00.000Z',
    title: 'Call about the renewal',
    detail: 'call',
  }),
  entry({
    kind: 'submission',
    at: '2026-10-08T09:00:00.000Z',
    recordId: SUBMISSION,
    reference: 104,
    title: 'Boiler checklist',
    workOrderId: JOB,
  }),
  entry({
    kind: 'invoice_issued',
    at: '2026-10-07T09:00:00.000Z',
    recordId: INVOICE,
    reference: 9,
    detail: 'EGP',
  }),
];

describe('the customer’s records', { timeout: 20_000 }, () => {
  it('pages through the timeline, newest first, each entry linked to its record', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(READS, EVERYTHING),
      'GET /v1/customers/:id/timeline': (call) => {
        const sources = call.query.getAll('sources');
        if (sources.length > 0) {
          return {
            body: {
              items: firstPage.filter((item) => item.kind === 'job_event'),
              nextCursor: null,
              sources,
            },
          };
        }
        return call.query.get('cursor') === 'page-2'
          ? {
              body: {
                items: secondPage,
                nextCursor: null,
                sources: ['activities', 'jobs', 'sales', 'finance'],
              },
            }
          : {
              body: {
                items: firstPage,
                nextCursor: 'page-2',
                sources: ['activities', 'jobs', 'sales', 'finance'],
              },
            };
      },
    });
    const { container } = renderScreen(<CustomerRecordsSection customerId={CUSTOMER} />, client);

    const panel = await screen.findByRole('tabpanel', { name: 'Timeline' });
    expect(await within(panel).findByRole('link', { name: 'RC-000012' })).toHaveAttribute(
      'href',
      `/finance/payments/${RECEIPT}`,
    );
    expect(within(panel).getByText('EGP 1,500.50')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'QT-000031' })).toHaveAttribute(
      'href',
      `/sales/quotes/${QUOTE}`,
    );
    expect(within(panel).getByText('Quote answered')).toBeInTheDocument();
    expect(within(panel).getByText('Accepted')).toBeInTheDocument();
    expect(within(panel).getByRole('link', { name: 'WO-000104' })).toHaveAttribute(
      'href',
      `/work-orders/${JOB}`,
    );
    expect(within(panel).getByText('Customer signed off')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    // The next page comes after the first, with the cursor the server gave.
    await user.click(within(panel).getByRole('button', { name: 'Show more' }));
    expect(await within(panel).findByRole('link', { name: 'INV-000009' })).toHaveAttribute(
      'href',
      `/finance/invoices/${INVOICE}`,
    );
    expect(within(panel).getByRole('link', { name: 'Call about the renewal' })).toHaveAttribute(
      'href',
      '/crm/activities',
    );
    expect(within(panel).getByRole('link', { name: 'Boiler checklist' })).toHaveAttribute(
      'href',
      `/submissions/${SUBMISSION}`,
    );
    const links = within(panel)
      .getAllByRole('listitem')
      .map((item) => within(item).getAllByRole('link')[0]!.textContent);
    expect(links).toEqual([
      'RC-000012',
      'QT-000031',
      'WO-000104',
      'Call about the renewal',
      'Boiler checklist',
      'INV-000009',
    ]);
    expect(within(panel).queryByRole('button', { name: 'Show more' })).toBeNull();
    const pages = calls.filter((call) => call.path.endsWith('/timeline'));
    expect(pages.map((call) => call.query.get('cursor'))).toEqual([null, 'page-2']);

    // The filter offers only what this seat may see.
    const show = within(panel).getByLabelText('Show');
    expect(
      within(show)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([
      'Everything',
      'CRM activities',
      'Jobs',
      'Quotes and orders',
      'Invoices and payments',
    ]);
    await user.selectOptions(show, 'jobs');
    await waitFor(() =>
      expect(within(panel).queryByRole('link', { name: 'RC-000012' })).toBeNull(),
    );
    expect(within(panel).getByRole('link', { name: 'WO-000104' })).toBeInTheDocument();
    expect(calls.at(-1)!.query.getAll('sources')).toEqual(['jobs']);
  });

  it('shows each documents tab only with its module and permission', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(['customer.read', 'sales.read', 'finance.read'], {
        sales: true,
        finance: false,
      }),
      'GET /v1/customers/:id/timeline': () => ({
        body: { items: [], nextCursor: null, sources: ['sales'] },
      }),
      'GET /v1/sales/quotes': () => ({
        body: {
          items: [
            {
              id: QUOTE,
              reference: 'QT-000031',
              revision: 1,
              title: 'Chiller service',
              customer: { id: CUSTOMER, name: 'Delta Facilities' },
              status: 'issued',
              expired: false,
              currencyCode: 'EGP',
              validUntil: '2026-11-30',
              totals: {
                gross: '1000',
                discount: '0',
                net: '1000',
                tax: '140',
                total: '1140',
              },
              createdAt: '2026-10-01T09:00:00.000Z',
              updatedAt: '2026-10-01T09:00:00.000Z',
            },
          ],
          nextCursor: null,
        },
      }),
    });
    renderScreen(<CustomerRecordsSection customerId={CUSTOMER} />, client);

    const tabs = await screen.findByRole('tablist', { name: 'This customer’s records' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Timeline', 'Quotes', 'Sales orders']);
    expect(await screen.findByText('Nothing has happened with this customer yet.')).toBeVisible();

    // Arrow keys move between tabs.
    within(tabs).getByRole('tab', { name: 'Timeline' }).focus();
    await user.keyboard('{ArrowRight}');
    const quotes = within(tabs).getByRole('tab', { name: 'Quotes' });
    expect(quotes).toHaveFocus();
    expect(quotes).toHaveAttribute('aria-selected', 'true');
    const panel = screen.getByRole('tabpanel', { name: 'Quotes' });
    expect(await within(panel).findByRole('link', { name: 'QT-000031' })).toHaveAttribute(
      'href',
      `/sales/quotes/${QUOTE}`,
    );
    expect(within(panel).getByText('EGP 1,140.00')).toBeInTheDocument();
    expect(calls.find((call) => call.path === '/v1/sales/quotes')!.query.get('customerId')).toBe(
      CUSTOMER,
    );
    // Finance is off: neither its list nor the account is asked for.
    expect(calls.some((call) => call.path.startsWith('/v1/finance'))).toBe(false);
  });

  it('shows the account balance above the invoices', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/me': me(['customer.read', 'finance.read'], { finance: true }),
      'GET /v1/customers/:id/timeline': () => ({
        body: { items: [], nextCursor: null, sources: ['finance'] },
      }),
      'GET /v1/finance/customers/:id/account': () => ({
        body: {
          accounts: [{ currencyCode: 'EGP', owed: '2500', unallocated: '0', net: '2500' }],
          openInvoices: [],
          unallocatedPayments: [],
        },
      }),
      'GET /v1/finance/invoices': () => ({ body: { items: [], nextCursor: null } }),
    });
    renderScreen(<CustomerRecordsSection customerId={CUSTOMER} />, client);

    await user.click(await screen.findByRole('tab', { name: 'Invoices' }));
    const panel = screen.getByRole('tabpanel', { name: 'Invoices' });
    expect(await within(panel).findByText('No invoices for this customer yet.')).toBeVisible();
    expect(within(panel).getByRole('heading', { name: 'Account' })).toBeInTheDocument();
    expect(within(panel).getByText(/EGP 2,500\.00/u, { selector: '.font-semibold' })).toBeVisible();
  });
});
