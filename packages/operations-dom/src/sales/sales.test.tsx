import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { QuoteDetail, QuoteRow, SalesOrderDetail, SalesOrderRow } from '../api.js';
import { accessibilityViolations, fakeApi, renderScreen } from '../testing/render.js';
import { SalesOrderListScreen } from './order-list.js';
import { SalesOrderScreen } from './order-screen.js';
import { QuoteListScreen } from './quote-list.js';
import { QuoteScreen } from './quote-screen.js';

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const CUSTOMER = '00000000-0000-4000-8000-00000000c001';
const ITEM = '00000000-0000-4000-8000-00000000f001';
const QUOTE = '00000000-0000-4000-8000-00000000d001';
const LINE = '00000000-0000-4000-8000-00000000d101';

const me = (permissions: string[]) => () => ({
  body: {
    userId: USER,
    tenantId: TENANT,
    email: 'd@x.example',
    displayName: 'Dee',
    role: 'dispatcher',
    permissions,
    features: { crm: true, inventory: true, sales: true },
    company: { name: 'Riverside Services', slug: 'riverside' },
  },
});
const MANAGE = ['crm.read', 'inventory.read', 'sales.read', 'sales.manage'];
const ISSUE = [...MANAGE, 'sales.issue'];

const customers = () => ({
  body: {
    items: [
      {
        id: CUSTOMER,
        name: 'Riverside Housing',
        accountNumber: 'RH-001',
        status: 'active',
        email: null,
        phone: null,
        address: {
          line1: null,
          line2: null,
          city: null,
          region: null,
          postcode: null,
          countryCode: null,
        },
        tags: [],
        notes: null,
        createdAt: '2026-09-30T09:00:00.000Z',
        updatedAt: '2026-09-30T09:00:00.000Z',
      },
    ],
    nextCursor: null,
  },
});

const items = () => ({
  body: {
    items: [
      {
        id: ITEM,
        sku: 'SRV-BOILER',
        name: 'Annual boiler service',
        kind: 'service',
        unit: 'each',
        description: null,
        categoryId: null,
        barcode: null,
        defaultUnitCost: null,
        salePrice: '120',
        averageUnitCost: null,
        preferredSupplierId: null,
        supplierPartNumber: null,
        leadTimeDays: null,
        reorderPoint: null,
        reorderQuantity: null,
        onHand: '0',
        version: 1,
        archivedAt: null,
        createdAt: '2026-09-30T09:00:00.000Z',
        updatedAt: '2026-09-30T09:00:00.000Z',
      },
    ],
    nextCursor: null,
  },
});

const totals = { gross: '240', discount: '24', net: '216', tax: '30.24', total: '246.24' };

const row = (overrides: Partial<QuoteRow> = {}): QuoteRow => ({
  id: QUOTE,
  reference: 'QT-000007',
  revision: 1,
  title: 'Boiler service, two flats',
  customer: { id: CUSTOMER, name: 'Riverside Housing' },
  status: 'draft',
  expired: false,
  currencyCode: 'EGP',
  validUntil: '2026-11-30',
  totals,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  ...overrides,
});

const quote = (overrides: Partial<QuoteDetail['quote']> = {}): QuoteDetail['quote'] => ({
  ...row(),
  site: null,
  contact: null,
  opportunity: null,
  introduction: null,
  terms: 'Payment within 30 days.',
  internalNotes: 'Second flat may need a new valve.',
  issuedTo: null,
  issuedBy: null,
  issuedAt: null,
  hasLink: false,
  answer: null,
  convertedOrderId: null,
  cancelledBy: null,
  cancelledAt: null,
  cancelReason: null,
  version: 1,
  createdBy: { id: USER, name: 'Dee' },
  ...overrides,
});

const line = (): QuoteDetail['lines'][number] => ({
  id: LINE,
  position: 1,
  itemId: ITEM,
  description: 'Annual boiler service',
  quantity: '2',
  unit: 'each',
  unitPrice: '120',
  discountBp: 1000,
  taxRateBp: 1400,
  gross: '240',
  discount: '24',
  net: '216',
  tax: '30.24',
  total: '246.24',
});

const detail = (overrides: Partial<QuoteDetail> = {}): QuoteDetail => ({
  quote: quote(),
  lines: [line()],
  can: { edit: true, issue: false, revise: false, answer: false, convert: false, cancel: true },
  ...overrides,
});

describe('quotes', { timeout: 20_000 }, () => {
  it('lists quotes and drafts one from a catalogue item', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/sales/quotes': () => ({ body: { items: [row()], nextCursor: null } }),
      'GET /v1/customers': customers,
      'GET /v1/inventory/items': items,
      'POST /v1/sales/quotes': () => ({
        status: 201,
        body: detail({ quote: quote({ id: '00000000-0000-4000-8000-00000000d002' }) }),
      }),
    });
    const { navigate, container } = renderScreen(<QuoteListScreen />, client);

    expect(await screen.findByRole('link', { name: 'QT-000007' })).toHaveAttribute(
      'href',
      `/sales/quotes/${QUOTE}`,
    );
    const item = screen.getByRole('listitem');
    expect(within(item).getByText('Draft')).toBeInTheDocument();
    expect(within(item).getByText('EGP 246.24')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'New quote' }));
    const dialog = await screen.findByRole('dialog', { name: 'New quote' });
    await user.type(within(dialog).getByLabelText('Customer'), 'river');
    await user.click(within(dialog).getByRole('button', { name: 'Search' }));
    await user.click(await within(dialog).findByRole('button', { name: /Riverside Housing/u }));
    await user.type(within(dialog).getByLabelText('Title'), 'Boiler service, two flats');
    await user.click(within(dialog).getByRole('button', { name: 'Add line' }));
    await user.type(within(dialog).getByLabelText('Catalogue item'), 'boiler');
    await user.click(within(dialog).getByRole('button', { name: 'Search' }));
    await user.click(await within(dialog).findByRole('button', { name: /Annual boiler service/u }));
    // The item filled in the description, unit and sale price.
    expect(within(dialog).getByLabelText('Description')).toHaveValue('Annual boiler service');
    expect(within(dialog).getByLabelText('Unit price')).toHaveValue('120');
    await user.clear(within(dialog).getByLabelText('Quantity'));
    await user.type(within(dialog).getByLabelText('Quantity'), '2');
    await user.type(within(dialog).getByLabelText('Discount %'), '10');
    await user.type(within(dialog).getByLabelText('Tax %'), '14');
    await user.click(within(dialog).getByRole('button', { name: 'Create quote' }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/sales/quotes/00000000-0000-4000-8000-00000000d002'),
    );
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.body).toEqual({
      customerId: CUSTOMER,
      title: 'Boiler service, two flats',
      lines: [
        {
          itemId: ITEM,
          description: 'Annual boiler service',
          quantity: '2',
          unit: 'each',
          unitPrice: '120',
          discountBp: 1000,
          taxRateBp: 1400,
        },
      ],
    });
  });

  it('shows a draft with its totals and, for an issuer, issues it and hands over the link once', async () => {
    const user = userEvent.setup();
    let current = detail({
      can: { edit: true, issue: true, revise: false, answer: false, convert: false, cancel: true },
    });
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ISSUE),
      'GET /v1/sales/quotes/:id': () => ({ body: current }),
      'POST /v1/sales/quotes/:id/issue': () => {
        current = detail({
          quote: quote({
            status: 'issued',
            version: 2,
            hasLink: true,
            issuedBy: { id: USER, name: 'Dee' },
            issuedAt: '2026-10-02T10:00:00.000Z',
            issuedTo: {
              customerName: 'Riverside Housing',
              customerAddress: {
                line1: null,
                line2: null,
                city: null,
                region: null,
                postcode: null,
                countryCode: null,
              },
              contactName: null,
              contactEmail: null,
              contactPhone: null,
            },
          }),
          can: {
            edit: false,
            issue: false,
            revise: true,
            answer: true,
            convert: false,
            cancel: true,
          },
        });
        return {
          body: { ...current, acceptToken: 'tok123', acceptUrl: 'https://app.example/q/tok123' },
        };
      },
    });
    const { container } = renderScreen(<QuoteScreen quoteId={QUOTE} />, client);

    expect(await screen.findByRole('heading', { name: /QT-000007/u })).toBeInTheDocument();
    expect(screen.getAllByText('Boiler service, two flats').length).toBeGreaterThan(0);
    expect(screen.getAllByRole('cell', { name: '2 each' }).length).toBeGreaterThan(0);
    expect(screen.getAllByText('10%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('14%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('EGP 240.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('−EGP 24.00').length).toBeGreaterThan(0);
    expect(screen.getAllByText('EGP 246.24').length).toBeGreaterThan(0);
    expect(screen.getByText('Second flat may need a new valve.')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    window.confirm = () => true;
    await user.click(screen.getByRole('button', { name: 'Issue' }));
    const dialog = await screen.findByRole('dialog', { name: 'Customer link' });
    expect(within(dialog).getByText('https://app.example/q/tok123')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Issued')).toBeInTheDocument();
    expect(screen.getByText(/issued by Dee on/u)).toBeInTheDocument();
    expect(screen.getByText('The customer link is live.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit lines' })).not.toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('/issue'))!.body).toEqual({
      expectedVersion: 1,
    });
  });

  it('records the customer answer given to the office', async () => {
    const user = userEvent.setup();
    let current = detail({
      quote: quote({ status: 'issued', version: 2, hasLink: true }),
      can: { edit: false, issue: false, revise: true, answer: true, convert: false, cancel: true },
    });
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/sales/quotes/:id': () => ({ body: current }),
      'POST /v1/sales/quotes/:id/answer': () => {
        current = detail({
          quote: quote({
            status: 'accepted',
            version: 3,
            hasLink: false,
            answer: {
              status: 'accepted',
              at: '2026-10-03T08:00:00.000Z',
              via: 'office',
              by: { id: USER, name: 'Dee' },
              name: 'Mrs Hassan',
              reason: null,
            },
            issuedTo: {
              customerName: 'Riverside Housing',
              customerAddress: {
                line1: null,
                line2: null,
                city: null,
                region: null,
                postcode: null,
                countryCode: null,
              },
              contactName: null,
              contactEmail: null,
              contactPhone: null,
            },
          }),
          can: {
            edit: false,
            issue: false,
            revise: false,
            answer: false,
            convert: true,
            cancel: false,
          },
        });
        return { body: current };
      },
    });
    renderScreen(<QuoteScreen quoteId={QUOTE} />, client);

    await user.click(await screen.findByRole('button', { name: 'Record answer' }));
    const dialog = await screen.findByRole('dialog', { name: 'Record the customer’s answer' });
    await user.type(within(dialog).getByLabelText('Answered by'), 'Mrs Hassan');
    await user.click(within(dialog).getByRole('button', { name: 'Record' }));

    expect(await screen.findByText('Accepted')).toBeInTheDocument();
    expect(screen.getByText(/recorded by Dee/u)).toBeInTheDocument();
    expect(screen.getAllByText(/Mrs Hassan/u).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Convert to order' })).toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('/answer'))!.body).toEqual({
      expectedVersion: 2,
      status: 'accepted',
      name: 'Mrs Hassan',
    });
  });

  it('shows a reader the quote without the internal notes or any action', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(['sales.read']),
      'GET /v1/sales/quotes/:id': () => ({
        body: detail({
          quote: quote({ internalNotes: null }),
          can: {
            edit: false,
            issue: false,
            revise: false,
            answer: false,
            convert: false,
            cancel: false,
          },
        }),
      }),
    });
    renderScreen(<QuoteScreen quoteId={QUOTE} />, client);

    expect(await screen.findByRole('heading', { name: /QT-000007/u })).toBeInTheDocument();
    expect(screen.queryByText('Second flat may need a new valve.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Issue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit lines' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Sales orders
// ---------------------------------------------------------------------------

const ORDER = '00000000-0000-4000-8000-00000000e001';
const STORE = '00000000-0000-4000-8000-00000000f101';
const JOB = '00000000-0000-4000-8000-00000000a901';
const SITE = '00000000-0000-4000-8000-00000000c101';
const JOB_TYPE = '00000000-0000-4000-8000-00000000c201';
const ISSUE_INVENTORY = [...ISSUE, 'inventory.move', 'work_order.manage', 'work_order.read_all'];

const orderRow = (overrides: Partial<SalesOrderRow> = {}): SalesOrderRow => ({
  id: ORDER,
  reference: 'SO-000003',
  title: 'Boiler service, two flats',
  customer: { id: CUSTOMER, name: 'Riverside Housing' },
  status: 'confirmed',
  currencyCode: 'EGP',
  quote: { id: QUOTE, reference: 'QT-000007' },
  totals,
  toOrder: true,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  ...overrides,
});

const orderLine = (
  overrides: Partial<SalesOrderDetail['lines'][number]> = {},
): SalesOrderDetail['lines'][number] => ({
  ...line(),
  quantityReserved: '0',
  quantityFulfilled: '0',
  shortfall: '2',
  reserveLocation: null,
  stock: true,
  ...overrides,
});

const orderDetail = (overrides: Partial<SalesOrderDetail> = {}): SalesOrderDetail => ({
  order: {
    ...orderRow({ status: 'draft', toOrder: false }),
    site: null,
    contact: null,
    notes: null,
    internalNotes: 'Second flat may need a new valve.',
    reserveLocation: null,
    confirmedTo: null,
    confirmedBy: null,
    confirmedAt: null,
    fulfilledAt: null,
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
    version: 1,
    createdBy: { id: USER, name: 'Dee' },
  },
  lines: [orderLine()],
  workOrders: [],
  can: {
    edit: true,
    confirm: true,
    reserve: false,
    cancel: true,
    linkJobs: true,
    createJobs: true,
  },
  ...overrides,
});

const job = () => ({
  id: JOB,
  reference: 42,
  referenceLabel: 'WO-000042',
  title: 'Fit the valves',
  state: 'scheduled' as const,
  priority: 'normal' as const,
  dueFrom: null,
  dueBy: null,
  customer: { id: CUSTOMER, name: 'Riverside Housing' },
  site: { id: SITE, name: 'Block A', city: null },
  jobType: { id: JOB_TYPE, name: 'Boiler service', code: 'boiler' },
  crew: [],
  revision: 1,
  stateChangedAt: '2026-10-01T09:00:00.000Z',
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
});

describe('sales orders', { timeout: 20_000 }, () => {
  it('lists orders, flagging the ones short of stock', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/sales/orders': () => ({ body: { items: [orderRow()], nextCursor: null } }),
    });
    const { container } = renderScreen(<SalesOrderListScreen />, client);

    expect(await screen.findByRole('link', { name: 'SO-000003' })).toHaveAttribute(
      'href',
      `/sales/orders/${ORDER}`,
    );
    const item = screen.getByRole('listitem');
    expect(within(item).getByText('Confirmed')).toBeInTheDocument();
    expect(within(item).getByText('To order')).toBeInTheDocument();
    expect(within(item).getByText(/QT-000007/u)).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('confirms a draft at a location and shows what each line holds', async () => {
    const user = userEvent.setup();
    let current = orderDetail();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ISSUE_INVENTORY),
      'GET /v1/sales/orders/:id': () => ({ body: current }),
      'GET /v1/inventory/locations': () => ({
        body: {
          items: [
            {
              id: STORE,
              name: 'Main store',
              kind: 'warehouse',
              assignedTo: null,
              site: null,
              notes: null,
              version: 1,
              archivedAt: null,
            },
          ],
        },
      }),
      'POST /v1/sales/orders/:id/confirm': () => {
        current = orderDetail({
          order: {
            ...orderDetail().order,
            status: 'confirmed',
            version: 2,
            toOrder: true,
            reserveLocation: { id: STORE, name: 'Main store' },
            confirmedBy: { id: USER, name: 'Dee' },
            confirmedAt: '2026-10-02T10:00:00.000Z',
            confirmedTo: {
              customerName: 'Riverside Housing',
              customerAddress: {
                line1: null,
                line2: null,
                city: null,
                region: null,
                postcode: null,
                countryCode: null,
              },
            },
          },
          lines: [
            orderLine({
              quantityReserved: '1',
              shortfall: '1',
              reserveLocation: { id: STORE, name: 'Main store' },
            }),
          ],
          can: {
            edit: false,
            confirm: false,
            reserve: true,
            cancel: true,
            linkJobs: true,
            createJobs: true,
          },
        });
        return { body: current };
      },
    });
    const { container } = renderScreen(<SalesOrderScreen orderId={ORDER} />, client);

    expect(await screen.findByRole('heading', { name: /SO-000003/u })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'from QT-000007' })).toHaveAttribute(
      'href',
      `/sales/quotes/${QUOTE}`,
    );
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Confirm' }));
    const dialog = await screen.findByRole('dialog', { name: 'Confirm this order' });
    const confirm = within(dialog).getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    await user.selectOptions(
      within(dialog).getByLabelText('Reserve stock at'),
      await within(dialog).findByRole('option', { name: 'Main store' }),
    );
    await user.click(confirm);

    expect(await screen.findByText('Stock reserved at Main store.')).toBeInTheDocument();
    expect(screen.getByText(/confirmed by Dee on/u)).toBeInTheDocument();
    expect(screen.getAllByText('To order').length).toBeGreaterThan(0);
    expect(screen.getByRole('columnheader', { name: 'Reserved' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Re-run reservation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit lines' })).not.toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('/confirm'))!.body).toEqual({
      expectedVersion: 1,
      reserveLocationId: STORE,
    });
  });

  it('links one of the customer’s open jobs to the order', async () => {
    const user = userEvent.setup();
    let current = orderDetail();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ISSUE_INVENTORY),
      'GET /v1/sales/orders/:id': () => ({ body: current }),
      'GET /v1/work-orders': () => ({
        body: { items: [job()], nextCursor: null, counts: {} },
      }),
      'POST /v1/sales/orders/:id/work-orders': () => {
        current = orderDetail({ workOrders: [job()] });
        return { body: current };
      },
    });
    renderScreen(<SalesOrderScreen orderId={ORDER} />, client);

    await user.click(await screen.findByRole('button', { name: 'Link or create job' }));
    const dialog = await screen.findByRole('dialog', { name: 'Jobs for this order' });
    await user.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Link an existing job' }),
      await within(dialog).findByRole('option', { name: /WO-000042/u }),
    );
    await user.click(within(dialog).getByRole('button', { name: 'Link job' }));

    expect(await screen.findByRole('link', { name: 'WO-000042' })).toHaveAttribute(
      'href',
      `/work-orders/${JOB}`,
    );
    expect(
      calls.find((call) => call.method === 'POST' && call.path.endsWith('/work-orders'))!.body,
    ).toEqual({ workOrderId: JOB });
  });

  it('converts an accepted quote into an order and opens it', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/sales/quotes/:id': () => ({
        body: detail({
          quote: quote({ status: 'accepted', version: 3 }),
          can: {
            edit: false,
            issue: false,
            revise: false,
            answer: false,
            convert: true,
            cancel: false,
          },
        }),
      }),
      'POST /v1/sales/quotes/:id/convert': () => ({ status: 201, body: orderDetail() }),
    });
    const { navigate } = renderScreen(<QuoteScreen quoteId={QUOTE} />, client);

    await user.click(await screen.findByRole('button', { name: 'Convert to order' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/sales/orders/${ORDER}`));
    expect(calls.find((call) => call.path.endsWith('/convert'))!.body).toEqual({
      expectedVersion: 3,
    });
  });
});
