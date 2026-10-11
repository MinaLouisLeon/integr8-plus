import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { QuoteDetail, QuoteRow } from '../api.js';
import { accessibilityViolations, fakeApi, renderScreen } from '../testing/render.js';
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
    expect(screen.getByText('Boiler service, two flats')).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '2 each' })).toBeInTheDocument();
    expect(screen.getByText('10%')).toBeInTheDocument();
    expect(screen.getByText('14%')).toBeInTheDocument();
    expect(screen.getByText('EGP 240.00')).toBeInTheDocument();
    expect(screen.getByText('−EGP 24.00')).toBeInTheDocument();
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
    expect(screen.getByText(/Mrs Hassan/u)).toBeInTheDocument();
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
