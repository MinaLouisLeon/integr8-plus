import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ReorderLine, Supplier, SupplierDetail, SupplierPrice } from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { NewOrderDialog } from './order-list.js';
import { ReorderScreen } from './reorder-screen.js';
import { SupplierScreen } from './supplier-screen.js';

/**
 * The eighth round's purchasing screens (ADR-0012): a supplier's price list,
 * an order line priced from it, and a location's reorder list.
 */

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const SUPPLIER = '00000000-0000-4000-8000-00000000a001';
const SUPPLIER_2 = '00000000-0000-4000-8000-00000000a002';
const ITEM = '00000000-0000-4000-8000-00000000f001';
const ITEM_2 = '00000000-0000-4000-8000-00000000f002';
const STORE = '00000000-0000-4000-8000-00000000f101';
const PRICE = '00000000-0000-4000-8000-00000000d001';

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

const supplier = (overrides: Partial<Supplier> = {}): Supplier => ({
  id: SUPPLIER,
  name: 'Acme Supplies',
  status: 'active',
  contactName: null,
  email: null,
  phone: null,
  taxReference: null,
  paymentTerms: null,
  leadTimeDays: null,
  address: {
    line1: null,
    line2: null,
    city: null,
    region: null,
    postcode: null,
    countryCode: null,
  },
  notes: null,
  version: 1,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  ...overrides,
});

const valve = {
  id: ITEM,
  sku: 'VAL-15',
  name: 'Ball valve 15mm',
  kind: 'stock_item' as const,
  unit: 'each' as const,
};
const tape = {
  id: ITEM_2,
  sku: 'PTFE',
  name: 'PTFE tape',
  kind: 'stock_item' as const,
  unit: 'roll' as const,
};

const price = (overrides: Partial<SupplierPrice> = {}): SupplierPrice => ({
  id: PRICE,
  supplierId: SUPPLIER,
  item: valve,
  currencyCode: 'EGP',
  minQuantity: '1',
  unitPrice: '25',
  validFrom: '2026-10-01',
  validTo: null,
  updatedAt: '2026-10-01T09:00:00.000Z',
  ...overrides,
});

const itemRow = (item: typeof valve | typeof tape) => ({
  ...item,
  description: null,
  categoryId: null,
  barcode: null,
  defaultUnitCost: null,
  salePrice: null,
  averageUnitCost: null,
  preferredSupplierId: null,
  supplierPartNumber: null,
  leadTimeDays: null,
  version: 1,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  archivedAt: null,
  onHand: '0',
});

describe('a supplier’s price list', { timeout: 20_000 }, () => {
  it('lists prices, and refuses an overlapping one in words beside the form', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/settings': () => ({ body: { currency: 'EGP', timezone: 'Africa/Cairo' } }),
      'GET /v1/purchasing/suppliers/:id': (): { body: SupplierDetail } => ({
        body: { supplier: supplier(), orders: [], can: { manage: true } },
      }),
      'GET /v1/purchasing/prices': () => ({ body: { items: [price()] } }),
      'GET /v1/inventory/items': () => ({ body: { items: [itemRow(valve)], nextCursor: null } }),
      'POST /v1/purchasing/suppliers/:id/prices': () =>
        apiError(409, 'price_overlaps', 'Another price covers some of these days.'),
    });
    const { container } = renderScreen(<SupplierScreen supplierId={SUPPLIER} />, client);

    const section = (await screen.findByRole('heading', { name: 'Price list' })).closest(
      'section',
    )!;
    const row = (await within(section).findByRole('link', { name: 'Ball valve 15mm' })).closest(
      'tr',
    )!;
    expect(within(row).getByText('EGP 25.00')).toBeInTheDocument();
    expect(within(row).getByText(/^from /u)).toBeInTheDocument();
    expect(
      calls.find((call) => call.path === '/v1/purchasing/prices')!.query.get('supplierId'),
    ).toBe(SUPPLIER);
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(within(section).getByRole('button', { name: 'Add price' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a price' });
    await user.type(within(dialog).getByLabelText('Item'), 'valve');
    await user.click(within(dialog).getByRole('button', { name: 'Search' }));
    await user.click(await within(dialog).findByRole('button', { name: /Ball valve 15mm/u }));
    await waitFor(() => expect(within(dialog).getByLabelText('Currency')).toHaveValue('EGP'));
    const from = within(dialog).getByLabelText('From quantity');
    await user.clear(from);
    await user.type(from, '10');
    await user.type(within(dialog).getByLabelText('Unit price'), '22.5');
    const validFrom = within(dialog).getByLabelText('Valid from');
    await user.clear(validFrom);
    await user.type(validFrom, '2026-11-01');
    await user.click(within(dialog).getByRole('button', { name: 'Save price' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'Another price for this item, currency and quantity already covers some of these days. End it first, or change these dates.',
    );
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.path).toBe(`/v1/purchasing/suppliers/${SUPPLIER}/prices`);
    expect(post.body).toEqual({
      itemId: ITEM,
      currencyCode: 'EGP',
      minQuantity: '10',
      unitPrice: '22.5',
      validFrom: '2026-11-01',
      validTo: null,
    });
    // The dialog stays open with what was typed, to change the dates.
    expect(within(dialog).getByLabelText('Unit price')).toHaveValue('22.5');
  });

  it('hides the price list from a seat that does not see prices', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/me': me(['inventory.read', 'purchasing.read']),
      'GET /v1/purchasing/suppliers/:id': (): { body: SupplierDetail } => ({
        body: { supplier: supplier(), orders: [], can: { manage: false } },
      }),
    });
    renderScreen(<SupplierScreen supplierId={SUPPLIER} />, client);
    expect(await screen.findByRole('heading', { name: 'Acme Supplies' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Price list' })).not.toBeInTheDocument();
    expect(calls.some((call) => call.path === '/v1/purchasing/prices')).toBe(false);
  });
});

describe('an order line without a price', { timeout: 20_000 }, () => {
  it('may leave the price to the supplier’s list, and marks the line that has none', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/purchasing/suppliers': () => ({ body: { items: [supplier()], nextCursor: null } }),
      'GET /v1/inventory/locations': () => ({ body: { items: [] } }),
      'GET /v1/inventory/items': () => ({ body: { items: [itemRow(valve)], nextCursor: null } }),
      'POST /v1/purchasing/orders': () =>
        apiError(422, 'price_required', 'This supplier has no price for this item.', [
          {
            field: 'body.lines.0.unitPrice',
            code: 'price_required',
            message: 'Enter the price.',
          },
        ]),
    });
    renderScreen(
      <NewOrderDialog
        supplier={{ id: SUPPLIER, name: 'Acme Supplies' }}
        onClose={() => undefined}
      />,
      client,
    );

    const dialog = await screen.findByRole('dialog', { name: 'New purchase order' });
    await user.click(within(dialog).getByRole('button', { name: 'Add line' }));
    await user.type(within(dialog).getByLabelText('Item'), 'valve');
    await user.click(within(dialog).getByRole('button', { name: 'Search' }));
    await user.click(await within(dialog).findByRole('button', { name: /Ball valve 15mm/u }));
    await user.type(within(dialog).getByLabelText('Quantity'), '4');
    const unitPrice = within(dialog).getByLabelText('Unit price');
    expect(unitPrice).toHaveAccessibleDescription(
      'Leave blank to use the supplier’s price in force today.',
    );
    const create = within(dialog).getByRole('button', { name: 'Create draft' });
    expect(create).toBeEnabled();
    await user.click(create);

    await waitFor(() => expect(unitPrice).toHaveAttribute('aria-invalid', 'true'));
    expect(unitPrice).toHaveAccessibleDescription(
      'This supplier has no price for this item. Enter the price.',
    );
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      supplierId: SUPPLIER,
      lines: [{ itemId: ITEM, description: 'Ball valve 15mm', quantityOrdered: '4' }],
    });
  });
});

const reorderLine = (overrides: Partial<ReorderLine> = {}): ReorderLine => ({
  item: valve,
  minimum: '10',
  onHand: '2',
  onOrder: '3',
  short: '5',
  suggested: '6',
  supplier: { id: SUPPLIER, name: 'Acme Supplies' },
  price: { currencyCode: 'EGP', unitPrice: '24' },
  ...overrides,
});

describe('reorder', { timeout: 20_000 }, () => {
  it('drafts one order per supplier from the chosen lines, then links to them', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/purchasing/suppliers': () => ({
        body: {
          items: [supplier(), supplier({ id: SUPPLIER_2, name: 'Bolt & Co' })],
          nextCursor: null,
        },
      }),
      'GET /v1/inventory/locations/:id': () => ({
        body: {
          location: {
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
          stock: [],
          can: { manage: true, move: true },
        },
      }),
      'GET /v1/inventory/locations/:id/reorder': () => ({
        body: {
          items: [
            reorderLine(),
            reorderLine({
              item: tape,
              minimum: '4',
              onHand: '1',
              onOrder: '0',
              short: '3',
              suggested: '3',
              supplier: null,
              price: null,
            }),
          ],
        },
      }),
      'POST /v1/inventory/locations/:id/reorder': () => ({
        status: 201,
        body: {
          orders: [
            { id: '00000000-0000-4000-8000-00000000b001', reference: 'PO-000041', lines: 1 },
            { id: '00000000-0000-4000-8000-00000000b002', reference: 'PO-000042', lines: 1 },
          ],
        },
      }),
    });
    const { container } = renderScreen(<ReorderScreen locationId={STORE} />, client);

    expect(
      await screen.findByRole('heading', { name: 'Reorder for Main store' }),
    ).toBeInTheDocument();
    const valveRow = screen.getByRole('link', { name: 'Ball valve 15mm' }).closest('tr')!;
    expect(within(valveRow).getByText('EGP 24.00')).toBeInTheDocument();
    expect(within(valveRow).getByRole('checkbox', { name: 'Order Ball valve 15mm' })).toBeChecked();
    expect(within(valveRow).getByLabelText('Quantity of Ball valve 15mm to order')).toHaveValue(
      '6',
    );
    // No preferred supplier: not chosen until one is.
    const tapeRow = screen.getByRole('link', { name: 'PTFE tape' }).closest('tr')!;
    expect(within(tapeRow).getByRole('checkbox', { name: 'Order PTFE tape' })).not.toBeChecked();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(within(tapeRow).getByRole('checkbox', { name: 'Order PTFE tape' }));
    const draft = screen.getByRole('button', { name: 'Draft purchase orders' });
    expect(draft).toBeDisabled();
    await user.selectOptions(
      within(tapeRow).getByLabelText('Supplier for PTFE tape'),
      await within(tapeRow).findByRole('option', { name: 'Bolt & Co' }),
    );
    const quantity = within(valveRow).getByLabelText('Quantity of Ball valve 15mm to order');
    await user.clear(quantity);
    await user.type(quantity, '8');
    expect(screen.getByText('2 lines chosen')).toBeInTheDocument();
    await user.click(draft);

    const drafted = await screen.findByRole('status');
    expect(within(drafted).getByRole('link', { name: 'PO-000041' })).toHaveAttribute(
      'href',
      '/purchasing/orders/00000000-0000-4000-8000-00000000b001',
    );
    expect(within(drafted).getByRole('link', { name: 'PO-000042' })).toBeInTheDocument();
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      lines: [
        { itemId: ITEM, supplierId: SUPPLIER, quantity: '8' },
        { itemId: ITEM_2, supplierId: SUPPLIER_2, quantity: '3' },
      ],
    });
  });

  it('says plainly when nothing is below its level', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/inventory/locations/:id': () => apiError(404, 'not_found', 'No.'),
      'GET /v1/inventory/locations/:id/reorder': () => ({ body: { items: [] } }),
    });
    renderScreen(<ReorderScreen locationId={STORE} />, client);
    expect(await screen.findByText('Nothing here is below its reorder level.')).toBeInTheDocument();
  });
});
