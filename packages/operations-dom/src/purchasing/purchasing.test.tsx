import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PurchaseOrderDetail, Supplier, SupplierDetail } from '../api.js';
import { accessibilityViolations, fakeApi, renderScreen } from '../testing/render.js';
import { OrderListScreen } from './order-list.js';
import { OrderScreen } from './order-screen.js';
import { basisPointsOfPercent, percentOfBasisPoints } from './purchasing-parts.js';
import { SupplierListScreen } from './supplier-list.js';
import { SupplierScreen } from './supplier-screen.js';

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const SUPPLIER = '00000000-0000-4000-8000-00000000a001';
const ITEM = '00000000-0000-4000-8000-00000000f001';
const STORE = '00000000-0000-4000-8000-00000000f101';
const ORDER = '00000000-0000-4000-8000-00000000b001';
const LINE = '00000000-0000-4000-8000-00000000b101';
const RECEIPT = '00000000-0000-4000-8000-00000000c001';
const RECEIPT_LINE = '00000000-0000-4000-8000-00000000c101';

const me = (permissions: string[]) => () => ({
  body: {
    userId: USER,
    tenantId: TENANT,
    email: 'd@x.example',
    displayName: 'Dee',
    role: 'dispatcher',
    permissions,
    features: { inventory: true, purchasing: true },
  },
});
const MANAGE = ['inventory.read', 'inventory.move', 'purchasing.read', 'purchasing.manage'];
const APPROVE = [...MANAGE, 'purchasing.approve'];
const READ = ['inventory.read', 'purchasing.read'];
const members = () => ({
  body: {
    items: [
      {
        userId: USER,
        email: 'd@x.example',
        displayName: 'Dee',
        role: 'owner',
        status: 'active',
        joinedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    nextCursor: null,
  },
});

const supplier = (overrides: Partial<Supplier> = {}): Supplier => ({
  id: SUPPLIER,
  name: 'Acme Supplies',
  status: 'active',
  contactName: 'Sam',
  email: 'orders@acme.example',
  phone: null,
  taxReference: null,
  paymentTerms: '30 days',
  leadTimeDays: 5,
  address: {
    line1: '1 Depot Road',
    line2: null,
    city: 'Cairo',
    region: null,
    postcode: null,
    countryCode: 'EG',
  },
  notes: null,
  version: 2,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  ...overrides,
});

const order = (
  overrides: Partial<PurchaseOrderDetail['order']> = {},
): PurchaseOrderDetail['order'] => ({
  id: ORDER,
  reference: 'PO-000007',
  supplier: { id: SUPPLIER, name: 'Acme Supplies' },
  status: 'draft',
  currencyCode: 'EGP',
  expectedDate: '2026-10-20',
  totals: { subtotal: '250', tax: '35', total: '285' },
  createdAt: '2026-10-02T09:00:00.000Z',
  updatedAt: '2026-10-02T09:00:00.000Z',
  deliveryLocation: { id: STORE, name: 'Main store' },
  notes: null,
  approvedBy: null,
  approvedAt: null,
  cancelledBy: null,
  cancelledAt: null,
  cancelReason: null,
  version: 1,
  createdBy: USER,
  ...overrides,
});

const line = (
  overrides: Partial<PurchaseOrderDetail['lines'][number]> = {},
): PurchaseOrderDetail['lines'][number] => ({
  id: LINE,
  position: 1,
  item: {
    id: ITEM,
    sku: 'VAL-15',
    name: 'Ball valve 15mm',
    kind: 'stock_item',
    unit: 'each',
    tracking: 'none',
  },
  description: 'Ball valve 15mm',
  quantityOrdered: '10',
  quantityReceived: '0',
  unitPrice: '25',
  taxRateBp: 1400,
  subtotal: '250',
  tax: '35',
  ...overrides,
});

const detail = (overrides: Partial<PurchaseOrderDetail> = {}): PurchaseOrderDetail => ({
  order: order(),
  lines: [line()],
  receipts: [],
  parties: {
    buyer: {
      name: 'Riverside Services SAE',
      address: '5 Nile Street, Cairo',
      taxReference: '123-456-789',
    },
    supplier: {
      name: 'Delta Valves',
      address: {
        line1: '12 Industrial Zone',
        line2: null,
        city: '10th of Ramadan',
        region: null,
        postcode: null,
        countryCode: 'EG',
      },
      contactName: 'Hany',
      email: 'orders@delta.example',
      phone: null,
      taxReference: null,
    },
  },
  can: { edit: true, approve: false, cancel: true, receive: false },
  ...overrides,
});

const locations = () => ({
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
});

describe('tax rates', () => {
  it('go between basis points and the percentage people type, exactly', () => {
    expect(percentOfBasisPoints(1400)).toBe('14');
    expect(percentOfBasisPoints(1450)).toBe('14.5');
    expect(percentOfBasisPoints(1405)).toBe('14.05');
    expect(percentOfBasisPoints(0)).toBe('0');
    expect(basisPointsOfPercent('14')).toBe(1400);
    expect(basisPointsOfPercent('14.5')).toBe(1450);
    expect(basisPointsOfPercent('0.07')).toBe(7);
    expect(basisPointsOfPercent('100')).toBe(10_000);
    expect(basisPointsOfPercent('101')).toBeUndefined();
    expect(basisPointsOfPercent('abc')).toBeUndefined();
  });
});

describe('suppliers', { timeout: 20_000 }, () => {
  it('lists suppliers and adds one', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/purchasing/suppliers': () => ({ body: { items: [supplier()], nextCursor: null } }),
      'POST /v1/purchasing/suppliers': (call) => ({
        status: 201,
        body: supplier({
          ...(call.body as Partial<Supplier>),
          id: '00000000-0000-4000-8000-00000000a002',
        }),
      }),
    });
    const { navigate, container } = renderScreen(<SupplierListScreen />, client);

    expect(await screen.findByRole('link', { name: 'Acme Supplies' })).toHaveAttribute(
      'href',
      `/purchasing/suppliers/${SUPPLIER}`,
    );
    expect(screen.getByText('5 days lead time')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'New supplier' }));
    const dialog = await screen.findByRole('dialog', { name: 'New supplier' });
    await user.type(within(dialog).getByLabelText('Name'), 'Bolt & Nut Ltd');
    await user.type(within(dialog).getByLabelText('Lead time (days)'), '3');
    await user.type(within(dialog).getByLabelText('Country code'), 'eg');
    await user.click(within(dialog).getByRole('button', { name: 'Add supplier' }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        '/purchasing/suppliers/00000000-0000-4000-8000-00000000a002',
      ),
    );
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.body).toMatchObject({
      name: 'Bolt & Nut Ltd',
      leadTimeDays: 3,
      address: { countryCode: 'EG', line1: null },
    });
  });

  it('shows a supplier with its orders, and lets a manager make it inactive', async () => {
    const user = userEvent.setup();
    let current = supplier();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/purchasing/suppliers/:id': (): { body: SupplierDetail } => ({
        body: {
          supplier: current,
          orders: [order({ status: 'approved' })],
          can: { manage: true },
        },
      }),
      'PATCH /v1/purchasing/suppliers/:id': (call) => {
        current = supplier({ ...(call.body as Partial<Supplier>), version: 3 });
        return { body: current };
      },
    });
    const { container } = renderScreen(<SupplierScreen supplierId={SUPPLIER} />, client);

    expect(await screen.findByRole('heading', { name: 'Acme Supplies' })).toBeInTheDocument();
    expect(screen.getByText('1 Depot Road, Cairo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PO-000007' })).toHaveAttribute(
      'href',
      `/purchasing/orders/${ORDER}`,
    );
    expect(screen.getByText('EGP 285.00')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Inactive' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({
      expectedVersion: 2,
      status: 'inactive',
    });
  });

  it('offers a viewer nothing to change', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(READ),
      'GET /v1/purchasing/suppliers/:id': (): { body: SupplierDetail } => ({
        body: { supplier: supplier(), orders: [], can: { manage: false } },
      }),
    });
    renderScreen(<SupplierScreen supplierId={SUPPLIER} />, client);
    expect(await screen.findByRole('heading', { name: 'Acme Supplies' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New order' })).not.toBeInTheDocument();
    expect(screen.getByText('Nothing ordered from this supplier yet.')).toBeInTheDocument();
  });
});

describe('purchase orders', { timeout: 20_000 }, () => {
  it('lists orders with status and total, and drafts one with lines', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/purchasing/orders': () => ({ body: { items: [order()], nextCursor: null } }),
      'GET /v1/purchasing/suppliers': () => ({ body: { items: [supplier()], nextCursor: null } }),
      'GET /v1/inventory/locations': locations,
      'GET /v1/inventory/items': () => ({
        body: {
          items: [
            {
              ...line().item,
              description: null,
              categoryId: null,
              barcode: null,
              defaultUnitCost: '25',
              salePrice: null,
              averageUnitCost: '24',
              preferredSupplierId: SUPPLIER,
              supplierPartNumber: null,
              leadTimeDays: null,
              version: 1,
              createdAt: '2026-10-01T09:00:00.000Z',
              updatedAt: '2026-10-01T09:00:00.000Z',
              archivedAt: null,
              onHand: '3',
            },
          ],
          nextCursor: null,
        },
      }),
      'POST /v1/purchasing/orders': () => ({
        status: 201,
        body: detail({ order: order({ id: '00000000-0000-4000-8000-00000000b002' }) }),
      }),
    });
    const { navigate, container } = renderScreen(<OrderListScreen />, client);

    expect(await screen.findByRole('link', { name: 'PO-000007' })).toHaveAttribute(
      'href',
      `/purchasing/orders/${ORDER}`,
    );
    // The status badge; the filter offers 'Draft' too.
    expect(within(screen.getByRole('list')).getByText('Draft')).toBeInTheDocument();
    expect(screen.getByText('EGP 285.00')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'New purchase order' }));
    const dialog = await screen.findByRole('dialog', { name: 'New purchase order' });
    await user.selectOptions(within(dialog).getByLabelText('Supplier'), SUPPLIER);
    await user.selectOptions(within(dialog).getByLabelText('Deliver to'), STORE);
    await user.click(within(dialog).getByRole('button', { name: 'Add line' }));
    await user.type(within(dialog).getByLabelText('Item'), 'valve');
    await user.click(within(dialog).getByRole('button', { name: 'Search' }));
    await user.click(await within(dialog).findByRole('button', { name: /Ball valve 15mm/u }));
    await user.type(within(dialog).getByLabelText('Quantity'), '10');
    await user.type(within(dialog).getByLabelText('Unit price'), '25');
    await user.type(within(dialog).getByLabelText('Tax %'), '14');
    await user.click(within(dialog).getByRole('button', { name: 'Create draft' }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        '/purchasing/orders/00000000-0000-4000-8000-00000000b002',
      ),
    );
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.body).toEqual({
      supplierId: SUPPLIER,
      deliveryLocationId: STORE,
      lines: [
        {
          itemId: ITEM,
          description: 'Ball valve 15mm',
          quantityOrdered: '10',
          unitPrice: '25',
          taxRateBp: 1400,
        },
      ],
    });
  });

  it('shows a draft with totals, and lets an approver approve it', async () => {
    const user = userEvent.setup();
    let current = detail({ can: { edit: true, approve: true, cancel: true, receive: false } });
    const { client, calls } = fakeApi({
      'GET /v1/me': me(APPROVE),
      'GET /v1/members': members,
      'GET /v1/purchasing/orders/:id': () => ({ body: current }),
      'POST /v1/purchasing/orders/:id/approve': () => {
        current = detail({
          order: order({
            status: 'approved',
            version: 2,
            approvedBy: USER,
            approvedAt: '2026-10-03T09:00:00.000Z',
          }),
          can: { edit: false, approve: false, cancel: true, receive: true },
        });
        return { body: current };
      },
    });
    const { container } = renderScreen(<OrderScreen orderId={ORDER} />, client);

    expect(await screen.findByRole('heading', { name: /PO-000007/u })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '10 each' })).toBeInTheDocument();
    // Once on the screen, once on the printed order beneath it.
    expect(screen.getAllByText('14%')).toHaveLength(2);
    expect(screen.getAllByText('EGP 285.00').length).toBeGreaterThan(0);
    expect(await accessibilityViolations(container)).toEqual([]);

    window.confirm = () => true;
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Approved')).toBeInTheDocument();
    expect(screen.getByText(/Approved by Dee on/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Receive goods' })).toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('/approve'))!.body).toEqual({
      expectedVersion: 1,
    });
  });

  it('receives goods against an approved order with an idempotency key, then returns some', async () => {
    const user = userEvent.setup();
    let current = detail({
      order: order({ status: 'approved', version: 2 }),
      can: { edit: false, approve: false, cancel: true, receive: true },
    });
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/members': members,
      'GET /v1/inventory/locations': locations,
      'GET /v1/purchasing/orders/:id': () => ({ body: current }),
      'POST /v1/purchasing/orders/:id/receipts': () => {
        current = detail({
          order: order({ status: 'partially_received', version: 3 }),
          lines: [line({ quantityReceived: '4' })],
          receipts: [
            {
              id: RECEIPT,
              location: { id: STORE, name: 'Main store' },
              supplierNote: 'DN-1',
              notes: null,
              receivedBy: USER,
              receivedAt: '2026-10-04T09:00:00.000Z',
              lines: [
                {
                  id: RECEIPT_LINE,
                  orderLineId: LINE,
                  quantity: '4',
                  unitCost: '24',
                  returnedQuantity: '0',
                },
              ],
            },
          ],
          can: { edit: false, approve: false, cancel: true, receive: true },
        });
        return { status: 201, body: current };
      },
      'POST /v1/purchasing/receipts/:id/returns': () => {
        current = {
          ...current,
          lines: [line({ quantityReceived: '3' })],
          receipts: current.receipts.map((receipt) => ({
            ...receipt,
            lines: receipt.lines.map((row) => ({ ...row, returnedQuantity: '1' })),
          })),
        };
        return { status: 201, body: current };
      },
    });
    renderScreen(<OrderScreen orderId={ORDER} />, client);

    await user.click(await screen.findByRole('button', { name: 'Receive goods' }));
    const dialog = await screen.findByRole('dialog', { name: 'Receive goods' });
    expect(within(dialog).getByText('Left to receive: 10 each')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText('Delivery note or invoice number'), 'DN-1');
    await user.type(within(dialog).getByLabelText(/^Arrived/u), '4');
    await user.type(within(dialog).getByLabelText(/^Unit cost/u), '24');
    await user.click(within(dialog).getByRole('button', { name: 'Record receipt' }));

    expect(await screen.findByText('Partly received')).toBeInTheDocument();
    expect(screen.getByText(/Delivery note DN-1/u)).toBeInTheDocument();
    const receipt = calls.find((call) => call.path.endsWith('/receipts'))!;
    expect(receipt.body).toEqual({
      expectedVersion: 2,
      locationId: STORE,
      supplierNote: 'DN-1',
      lines: [{ orderLineId: LINE, quantity: '4', unitCost: '24' }],
    });

    await user.click(screen.getByRole('button', { name: 'Return to supplier' }));
    const returning = await screen.findByRole('dialog', { name: 'Return to supplier' });
    await user.type(within(returning).getByLabelText('Reason'), 'Wrong size');
    await user.type(within(returning).getByLabelText(/^Return/u), '1');
    await user.click(within(returning).getByRole('button', { name: 'Record return' }));

    expect(await screen.findByText(/1 each returned/u)).toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('/returns'))!.body).toEqual({
      reason: 'Wrong size',
      lines: [{ receiptLineId: RECEIPT_LINE, quantity: '1' }],
    });
  });

  it('hides prices and every action from a viewer', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(READ),
      'GET /v1/members': members,
      'GET /v1/purchasing/orders/:id': () => ({
        body: detail({
          order: order({ totals: null }),
          lines: [line({ unitPrice: null, subtotal: null, tax: null })],
          can: { edit: false, approve: false, cancel: false, receive: false },
        }),
      }),
    });
    renderScreen(<OrderScreen orderId={ORDER} />, client);
    expect(await screen.findByRole('heading', { name: /PO-000007/u })).toBeInTheDocument();
    expect(screen.queryByText('EGP 285.00')).not.toBeInTheDocument();
    expect(
      screen.getByText('Prices are shown to those who manage purchasing or move stock.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit draft' })).not.toBeInTheDocument();
  });
});

describe('the printed purchase order', { timeout: 20_000 }, () => {
  it('names the company, the supplier, the lines and the totals, and prints from the screen', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(['purchasing.read', 'purchasing.manage', 'inventory.read']),
      'GET /v1/purchasing/orders/:id': () => ({ body: detail() }),
      'GET /v1/inventory/locations': locations,
    });
    const printed: string[] = [];
    const print = vi.spyOn(window, 'print').mockImplementation(() => {
      printed.push('print');
    });
    try {
      renderScreen(<OrderScreen orderId={ORDER} />, client);
      const document = await screen.findByRole('article', { hidden: true });
      expect(within(document).getByText('Riverside Services SAE')).toBeInTheDocument();
      expect(within(document).getByText('Delta Valves')).toBeInTheDocument();
      expect(within(document).getByText(/12 Industrial Zone/u)).toBeInTheDocument();
      expect(
        within(document).getByRole('heading', { name: /^Purchase order PO-/u, hidden: true }),
      ).toBeInTheDocument();
      await userEvent.setup().click(screen.getByRole('button', { name: 'Print' }));
      expect(printed).toEqual(['print']);
    } finally {
      print.mockRestore();
    }
  });
});
