import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { DeliveryNote, SalesDelivery, SalesOrderDetail, StockLocation } from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { DeliveryNoteScreen } from './deliveries.js';
import { SalesOrderScreen } from './order-screen.js';

/**
 * Deliveries by hand on a sales order (eighth round; ADR-0012): the form,
 * its refusals in words, the order's deliveries and the printable note.
 */

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const CUSTOMER = '00000000-0000-4000-8000-00000000c001';
const SITE = '00000000-0000-4000-8000-00000000c101';
const ITEM = '00000000-0000-4000-8000-00000000f001';
const ORDER = '00000000-0000-4000-8000-00000000d201';
const LINE = '00000000-0000-4000-8000-00000000d301';
const LINE_2 = '00000000-0000-4000-8000-00000000d302';
const STORE = '00000000-0000-4000-8000-00000000f101';
const CUSTOMER_STORE = '00000000-0000-4000-8000-00000000f103';
const DELIVERY = '00000000-0000-4000-8000-00000000d401';

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

const address = {
  line1: '4 Nile Street',
  line2: null,
  city: 'Cairo',
  region: null,
  postcode: null,
  countryCode: 'EG',
};

const orderLine = (
  overrides: Partial<SalesOrderDetail['lines'][number]> = {},
): SalesOrderDetail['lines'][number] => ({
  id: LINE,
  position: 1,
  itemId: ITEM,
  description: 'Ball valve 15mm',
  quantity: '2',
  unit: 'each',
  unitPrice: '120',
  discountBp: 0,
  taxRateBp: 0,
  gross: '240',
  discount: '0',
  net: '240',
  tax: '0',
  total: '240',
  quantityReserved: '1.5',
  quantityFulfilled: '0.5',
  shortfall: '0',
  reserveLocation: { id: STORE, name: 'Main store' },
  stock: true,
  ...overrides,
});

const totals = { gross: '360', discount: '0', net: '360', tax: '0', total: '360' };

const orderDetail = (overrides: Partial<SalesOrderDetail['order']> = {}): SalesOrderDetail => ({
  order: {
    id: ORDER,
    reference: 'SO-000034',
    title: 'Valves for Block A',
    customer: { id: CUSTOMER, name: 'Riverside Housing' },
    status: 'partially_fulfilled',
    currencyCode: 'EGP',
    quote: null,
    totals,
    toOrder: false,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-01T09:00:00.000Z',
    site: { id: SITE, name: 'Block A' },
    contact: null,
    notes: null,
    internalNotes: null,
    reserveLocation: { id: STORE, name: 'Main store' },
    confirmedTo: null,
    confirmedBy: { id: USER, name: 'Dee' },
    confirmedAt: '2026-10-02T09:00:00.000Z',
    fulfilledAt: null,
    cancelledBy: null,
    cancelledAt: null,
    cancelReason: null,
    version: 3,
    createdBy: { id: USER, name: 'Dee' },
    ...overrides,
  },
  lines: [
    orderLine(),
    orderLine({
      id: LINE_2,
      position: 2,
      itemId: null,
      description: 'Fitting',
      quantity: '1',
      quantityFulfilled: '1',
      quantityReserved: '0',
      stock: false,
      reserveLocation: null,
    }),
  ],
  workOrders: [],
  can: {
    edit: false,
    confirm: false,
    reserve: true,
    cancel: false,
    linkJobs: true,
    createJobs: false,
  },
});

const locations: StockLocation[] = [
  {
    id: STORE,
    name: 'Main store',
    kind: 'warehouse',
    ownership: 'ours',
    assignedTo: null,
    site: null,
    notes: null,
    version: 1,
    archivedAt: null,
  },
  {
    id: CUSTOMER_STORE,
    name: 'Riverside plant room',
    kind: 'site',
    ownership: 'customer',
    assignedTo: null,
    site: { id: SITE, name: 'Block A' },
    notes: null,
    version: 1,
    archivedAt: null,
  },
];

const delivery = (): SalesDelivery => ({
  id: DELIVERY,
  reference: 'DN-000012',
  location: { id: STORE, name: 'Main store', kind: 'warehouse' },
  deliveredBy: { id: USER, name: 'Dee' },
  deliveredAt: '2026-10-12T10:00:00.000Z',
  lines: [
    {
      orderLineId: LINE,
      description: 'Ball valve 15mm',
      sku: 'VAL-15',
      unit: 'each',
      quantity: '1',
      lots: [],
    },
  ],
});

describe('delivering a sales order by hand', { timeout: 20_000 }, () => {
  it('delivers what is left from one of our locations, saying how much is left when refused', async () => {
    const user = userEvent.setup();
    let deliveries: SalesDelivery[] = [];
    let attempts = 0;
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/sales/orders/:id': () => ({ body: orderDetail() }),
      'GET /v1/inventory/locations': () => ({ body: { items: locations } }),
      'GET /v1/sales/orders/:id/deliveries': () => ({ body: { items: deliveries } }),
      'POST /v1/sales/orders/:id/deliveries': () => {
        attempts += 1;
        if (attempts === 1) {
          return apiError(422, 'over_delivery', 'That is more than is left to deliver.', [
            {
              field: 'body.lines.0.quantity',
              code: 'over_delivery',
              message: 'At most 1.',
              params: { left: '1' },
            },
          ]);
        }
        deliveries = [delivery()];
        return {
          status: 201,
          body: { delivery: delivery(), order: orderDetail({ status: 'fulfilled', version: 4 }) },
        };
      },
    });
    const { container } = renderScreen(<SalesOrderScreen orderId={ORDER} />, client);

    expect(await screen.findByText('Nothing delivered by hand yet.')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Deliver' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deliver from SO-000034' });
    const from = within(dialog).getByLabelText('Deliver from');
    // Our locations only, the order's reserve location first chosen.
    await waitFor(() =>
      expect(
        within(from)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['Choose a location', 'Main store']),
    );
    expect(from).toHaveValue(STORE);
    // A line already delivered in full is not offered again.
    expect(within(dialog).queryByLabelText('Fitting')).not.toBeInTheDocument();

    const valves = within(dialog).getByLabelText('Ball valve 15mm');
    expect(valves).toHaveValue('1.5');
    expect(valves).toHaveAccessibleDescription('1.5 each left to deliver');
    const deliver = within(dialog).getByRole('button', { name: 'Deliver' });
    await user.clear(valves);
    await user.type(valves, '2');
    expect(valves).toHaveAccessibleDescription(
      'At most 1.5 each: that is what is left to deliver.',
    );
    expect(deliver).toBeDisabled();

    await user.clear(valves);
    await user.type(valves, '1.5');
    await user.type(within(dialog).getByLabelText('Notes'), 'Left with the caretaker.');
    await user.click(deliver);

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'That is more than is left to deliver on this line.',
    );
    expect(valves).toHaveAttribute('aria-invalid', 'true');
    expect(valves).toHaveAccessibleDescription('At most 1 each: that is what is left to deliver.');
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      expectedVersion: 3,
      locationId: STORE,
      notes: 'Left with the caretaker.',
      lines: [{ orderLineId: LINE, quantity: '1.5' }],
    });

    await user.clear(valves);
    await user.type(valves, '1');
    await user.click(deliver);

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Deliver from SO-000034' }),
      ).not.toBeInTheDocument(),
    );
    expect(await screen.findByRole('link', { name: 'DN-000012' })).toHaveAttribute(
      'href',
      `/sales/orders/${ORDER}/deliveries/${DELIVERY}`,
    );
  });

  it('offers no delivery to a seat that does not manage sales, or on a draft', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(['crm.read', 'sales.read']),
      'GET /v1/sales/orders/:id': () => ({ body: orderDetail() }),
      'GET /v1/sales/orders/:id/deliveries': () => ({ body: { items: [delivery()] } }),
    });
    renderScreen(<SalesOrderScreen orderId={ORDER} />, client);
    expect(await screen.findByRole('link', { name: 'DN-000012' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Deliver' })).not.toBeInTheDocument();
  });

  it('says why when the order is no longer open', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/sales/orders/:id': () => ({ body: orderDetail() }),
      'GET /v1/inventory/locations': () => ({ body: { items: locations } }),
      'GET /v1/sales/orders/:id/deliveries': () => ({ body: { items: [] } }),
      'POST /v1/sales/orders/:id/deliveries': () =>
        apiError(409, 'order_not_open', 'Only a confirmed order is delivered.'),
    });
    renderScreen(<SalesOrderScreen orderId={ORDER} />, client);
    await user.click(await screen.findByRole('button', { name: 'Deliver' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deliver from SO-000034' });
    await user.click(within(dialog).getByRole('button', { name: 'Deliver' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Only a confirmed order is delivered. Reload to see where it is.',
    );
  });
});

describe('the delivery note', { timeout: 20_000 }, () => {
  it('shows who, what and where, with a place to sign and no prices', async () => {
    const note: DeliveryNote = {
      ...delivery(),
      // The serial numbers and batches handed over are printed under the line (ADR-0013).
      lines: delivery().lines.map((line) => ({
        ...line,
        quantity: '3',
        lots: [
          { kind: 'serial' as const, code: 'SN-1', expiresOn: null, quantity: '1' },
          { kind: 'serial' as const, code: 'SN-2', expiresOn: null, quantity: '1' },
          { kind: 'batch' as const, code: 'B-7', expiresOn: '2099-03-31', quantity: '1' },
        ],
      })),
      notes: 'Left with the caretaker.',
      order: { id: ORDER, reference: 'SO-000034', title: 'Valves for Block A' },
      customer: { id: CUSTOMER, name: 'Riverside Housing', address },
      site: { id: SITE, name: 'Block A', address: { ...address, line1: '6 Nile Street' } },
      company: { name: 'Delta Services', address: '1 Depot Road, Giza', taxReference: '123-456' },
    };
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/sales/deliveries/:id': () => ({ body: note }),
    });
    const { container } = renderScreen(
      <DeliveryNoteScreen orderId={ORDER} deliveryId={DELIVERY} />,
      client,
    );

    const document = await screen.findByRole('article', { name: 'Delivery note DN-000012' });
    expect(within(document).getByText('Delta Services')).toBeInTheDocument();
    expect(within(document).getByText('Tax reference 123-456')).toBeInTheDocument();
    expect(within(document).getByText('For order SO-000034')).toBeInTheDocument();
    expect(within(document).getByText('Riverside Housing')).toBeInTheDocument();
    expect(within(document).getByText('6 Nile Street, Cairo')).toBeInTheDocument();
    expect(within(document).getByRole('cell', { name: 'VAL-15' })).toBeInTheDocument();
    expect(within(document).getByText('SN-1, SN-2')).toBeInTheDocument();
    expect(
      within(document).getByText('Batch B-7: 1 each · Expires March 31, 2099'),
    ).toBeInTheDocument();
    expect(within(document).getByText('Received by (name)')).toBeInTheDocument();
    expect(within(document).queryByText(/EGP/u)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to SO-000034' })).toHaveAttribute(
      'href',
      `/sales/orders/${ORDER}`,
    );
    expect(screen.getByRole('button', { name: 'Print or save as PDF' })).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('reads in Arabic', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/sales/deliveries/:id': () => ({
        body: {
          ...delivery(),
          notes: null,
          order: { id: ORDER, reference: 'SO-000034', title: 'Valves' },
          customer: { id: CUSTOMER, name: 'Riverside Housing', address: null },
          site: null,
          company: { name: 'Delta Services', address: null, taxReference: null },
        },
      }),
    });
    renderScreen(<DeliveryNoteScreen orderId={ORDER} deliveryId={DELIVERY} />, client, {
      locale: 'ar',
    });
    expect(await screen.findByRole('article', { name: 'إذن تسليم DN-000012' })).toBeInTheDocument();
    expect(screen.getByText('المستلم (الاسم)')).toBeInTheDocument();
  });
});
