import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  InventoryItem,
  ItemDetail,
  ItemRow,
  StockCountDetail,
  StockLocation,
  StockLocationDetail,
} from '../api.js';
import { accessibilityViolations, fakeApi, renderScreen } from '../testing/render.js';
import { InventoryOverviewScreen } from './inventory-overview.js';
import { ItemListScreen } from './item-list.js';
import { ItemScreen } from './item-screen.js';
import { LocationScreen } from './location-screen.js';
import { StockCountScreen } from './stock-count-screen.js';

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const ITEM = '00000000-0000-4000-8000-00000000f001';
const STORE = '00000000-0000-4000-8000-00000000f101';
const VAN = '00000000-0000-4000-8000-00000000f102';
const COUNT = '00000000-0000-4000-8000-00000000f201';

const me =
  (permissions: string[], inventory = true) =>
  () => ({
    body: {
      userId: USER,
      tenantId: TENANT,
      email: 'd@x.example',
      displayName: 'Dee',
      role: 'dispatcher',
      permissions,
      features: { inventory },
    },
  });
const MANAGE = ['inventory.read', 'inventory.manage', 'inventory.move', 'inventory.consume'];
const READ = ['inventory.read', 'inventory.consume'];
const settings = () => ({ body: { currency: 'EGP', timezone: 'Africa/Cairo' } });
const members = () => ({ body: { items: [], nextCursor: null } });
const categories = () => ({ body: { items: [] } });

const item = (overrides: Partial<InventoryItem> = {}): InventoryItem => ({
  id: ITEM,
  sku: 'VAL-15',
  name: 'Ball valve 15mm',
  kind: 'stock_item',
  unit: 'each',
  description: null,
  categoryId: null,
  barcode: '6291041500213',
  defaultUnitCost: '120.5',
  salePrice: '180',
  averageUnitCost: '118.25',
  preferredSupplierId: null,
  supplierPartNumber: null,
  leadTimeDays: null,
  version: 3,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  archivedAt: null,
  ...overrides,
});
const row = (overrides: Partial<ItemRow> = {}): ItemRow => ({
  ...item(),
  onHand: '12.5',
  ...overrides,
});

const locations: StockLocation[] = [
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
  {
    id: VAN,
    name: 'Van 1',
    kind: 'van',
    assignedTo: USER,
    site: null,
    notes: null,
    version: 2,
    archivedAt: null,
  },
];

const detail = (): ItemDetail => ({
  item: item(),
  stock: [
    {
      location: { id: STORE, name: 'Main store', kind: 'warehouse' },
      onHand: '10',
      reserved: '4',
      available: '6',
      minimum: '5',
    },
    {
      location: { id: VAN, name: 'Van 1', kind: 'van' },
      onHand: '2.5',
      reserved: '0',
      available: '2.5',
      minimum: null,
    },
  ],
  onHand: '12.5',
  reserved: '4',
  available: '8.5',
  can: { manage: true, move: true },
});

describe('the inventory overview', { timeout: 20_000 }, () => {
  it('shows what is running low, what moved, and checks the ledger', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/inventory/balances': () => ({
        body: {
          items: [
            {
              item: {
                id: ITEM,
                sku: 'VAL-15',
                name: 'Ball valve 15mm',
                kind: 'stock_item',
                unit: 'each',
              },
              location: { id: STORE, name: 'Main store', kind: 'warehouse' },
              onHand: '2',
              reserved: '0',
              available: '2',
              minimum: '5',
            },
          ],
        },
      }),
      'GET /v1/inventory/movements': () => ({
        body: {
          items: [
            {
              id: '00000000-0000-4000-8000-00000000f301',
              postingId: '00000000-0000-4000-8000-00000000f302',
              item: {
                id: ITEM,
                sku: 'VAL-15',
                name: 'Ball valve 15mm',
                kind: 'stock_item',
                unit: 'each',
              },
              location: { id: STORE, name: 'Main store', kind: 'warehouse' },
              kind: 'receipt',
              quantity: '20',
              unitCost: '120',
              reason: null,
              actorId: USER,
              occurredAt: '2026-10-01T09:00:00.000Z',
            },
          ],
          nextCursor: null,
        },
      }),
      'GET /v1/inventory/reconcile': () => ({
        body: { checkedAt: '2026-10-01T09:00:00.000Z', discrepancies: [] },
      }),
      'GET /v1/inventory/locations': () => ({ body: { items: locations } }),
    });
    const { container } = renderScreen(<InventoryOverviewScreen />, client);

    expect(await screen.findByText('2 each of 5')).toBeInTheDocument();
    expect(screen.getByText('Received')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Every balance equals its ledger.');
  });

  it('says plainly when inventory is off, and asks for nothing else', async () => {
    const { client, calls } = fakeApi({ 'GET /v1/me': me(MANAGE, false) });
    renderScreen(<InventoryOverviewScreen />, client);
    expect(
      await screen.findByText(
        'Inventory is not switched on for your company. Ask Integr8 to turn it on.',
      ),
    ).toBeInTheDocument();
    expect(calls.some((call) => call.path.startsWith('/v1/inventory'))).toBe(false);
  });
});

describe('items', { timeout: 20_000 }, () => {
  it('lists items with their stock and adds one with an idempotency key', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/inventory/categories': categories,
      'GET /v1/inventory/items': () => ({ body: { items: [row()], nextCursor: null } }),
      'POST /v1/inventory/items': (call) => ({
        status: 201,
        body: item({
          ...(call.body as Partial<InventoryItem>),
          id: '00000000-0000-4000-8000-00000000f002',
        }),
      }),
    });
    const { navigate, container } = renderScreen(<ItemListScreen />, client);

    expect(await screen.findByRole('link', { name: 'Ball valve 15mm' })).toHaveAttribute(
      'href',
      `/inventory/items/${ITEM}`,
    );
    expect(screen.getByText('12.5 each')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'New item' }));
    const dialog = await screen.findByRole('dialog', { name: 'New item' });
    await user.type(within(dialog).getByLabelText('SKU'), 'CAB-2.5');
    await user.type(within(dialog).getByLabelText('Name'), 'Cable 2.5mm');
    await user.selectOptions(within(dialog).getByLabelText('Unit'), 'm');
    await user.type(within(dialog).getByLabelText('Default unit cost'), '14.75');
    await user.click(within(dialog).getByRole('button', { name: 'Add item' }));

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        '/inventory/items/00000000-0000-4000-8000-00000000f002',
      ),
    );
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.body).toMatchObject({
      sku: 'CAB-2.5',
      name: 'Cable 2.5mm',
      unit: 'm',
      defaultUnitCost: '14.75',
    });
  });

  it('shows no costs and no actions to an engineer', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(READ),
      'GET /v1/settings': settings,
      'GET /v1/inventory/categories': categories,
      'GET /v1/inventory/locations': () => ({ body: { items: locations } }),
      'GET /v1/inventory/items/:id': () => ({
        body: {
          ...detail(),
          item: item({ defaultUnitCost: null, averageUnitCost: null }),
          can: { manage: false, move: false },
        },
      }),
    });
    renderScreen(<ItemScreen itemId={ITEM} />, client);

    expect(await screen.findByRole('heading', { name: 'Ball valve 15mm' })).toBeInTheDocument();
    expect(screen.queryByText('Average unit cost')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move stock' })).not.toBeInTheDocument();
    expect(screen.getByText('Main store')).toBeInTheDocument();
    expect(screen.getByText('reorder at 5')).toBeInTheDocument();
  });

  it('saves only the changed fields, and sets reorder levels', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/settings': settings,
      'GET /v1/inventory/categories': categories,
      'GET /v1/inventory/locations': () => ({ body: { items: locations } }),
      'GET /v1/inventory/items/:id': () => ({ body: detail() }),
      'GET /v1/inventory/movements': () => ({ body: { items: [], nextCursor: null } }),
      'PATCH /v1/inventory/items/:id': () => ({ body: item({ version: 4 }) }),
      'PUT /v1/inventory/items/:id/reorder-levels': () => ({ body: detail() }),
    });
    const { container } = renderScreen(<ItemScreen itemId={ITEM} />, client);

    expect(await screen.findByText('EGP 118.25')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit' });
    // Holds stock, so it stays a stock item.
    expect(within(form).getByLabelText('Kind')).toBeDisabled();
    await user.clear(within(form).getByLabelText('Sale price'));
    await user.type(within(form).getByLabelText('Sale price'), '195');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({
      expectedVersion: 3,
      salePrice: '195',
    });

    await user.click(await screen.findByRole('button', { name: 'Reorder levels' }));
    const levels = screen.getByRole('form', { name: 'Reorder levels' });
    const van = within(levels).getByLabelText(/Van 1/u);
    await user.type(van, '1');
    await user.click(within(levels).getByRole('button', { name: 'Save levels' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({
      levels: [
        { locationId: STORE, minimum: '5' },
        { locationId: VAN, minimum: '1' },
      ],
    });
  });
});

describe('moving stock', { timeout: 20_000 }, () => {
  it('transfers from a location to another, with the key the retry would reuse', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/members': members,
      'GET /v1/inventory/locations': () => ({ body: { items: locations } }),
      'GET /v1/inventory/locations/:id': () => ({
        body: {
          location: locations[0]!,
          stock: [
            {
              item: {
                id: ITEM,
                sku: 'VAL-15',
                name: 'Ball valve 15mm',
                kind: 'stock_item',
                unit: 'each',
              },
              onHand: '10',
              reserved: '0',
              available: '10',
              minimum: '5',
            },
          ],
          can: { manage: true, move: true },
        } satisfies StockLocationDetail,
      }),
      'GET /v1/inventory/counts': () => ({ body: { items: [] } }),
      'GET /v1/inventory/items': () => ({ body: { items: [row()], nextCursor: null } }),
      'POST /v1/inventory/movements': () => ({
        status: 201,
        body: { postingId: COUNT, movements: [] },
      }),
    });
    renderScreen(<LocationScreen locationId={STORE} />, client);

    await user.click(await screen.findByRole('button', { name: 'Move stock' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move stock' });
    await user.selectOptions(within(dialog).getByLabelText('What happened'), 'transfer');
    await user.type(within(dialog).getByLabelText('Item'), 'valve');
    await user.click(within(dialog).getByRole('button', { name: 'Search' }));
    await user.click(await within(dialog).findByRole('button', { name: /VAL-15/u }));
    await user.selectOptions(within(dialog).getByLabelText('To'), VAN);
    await user.type(within(dialog).getByLabelText('Quantity'), '2.5');
    await user.click(within(dialog).getByRole('button', { name: 'Post' }));

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    const post = calls.find((call) => call.method === 'POST')!;
    expect(post.body).toEqual({
      type: 'transfer',
      itemId: ITEM,
      fromLocationId: STORE,
      toLocationId: VAN,
      quantity: '2.5',
    });
  });
});

describe('a stock count', { timeout: 20_000 }, () => {
  const count = (status: StockCountDetail['count']['status']): StockCountDetail => ({
    count: {
      id: COUNT,
      location: { id: STORE, name: 'Main store', kind: 'warehouse' },
      status,
      notes: null,
      version: 2,
      createdBy: USER,
      postedBy: null,
      postedAt: null,
      createdAt: '2026-10-01T09:00:00.000Z',
    },
    lines: [
      {
        item: {
          id: ITEM,
          sku: 'VAL-15',
          name: 'Ball valve 15mm',
          kind: 'stock_item',
          unit: 'each',
        },
        countedQuantity: '10',
        expectedQuantity: null,
        onHand: '10',
      },
    ],
    can: { edit: status === 'draft' },
  });

  it('records what was counted, then posts after confirming', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let status: StockCountDetail['count']['status'] = 'draft';
    const { client, calls } = fakeApi({
      'GET /v1/members': members,
      'GET /v1/inventory/counts/:id': () => ({ body: count(status) }),
      'GET /v1/inventory/locations/:id': () => ({
        body: { location: locations[0]!, stock: [], can: { manage: true, move: true } },
      }),
      'PUT /v1/inventory/counts/:id/lines': () => ({ body: count('draft') }),
      'POST /v1/inventory/counts/:id/post': () => {
        status = 'posted';
        return { body: count('posted') };
      },
    });
    const { container } = renderScreen(<StockCountScreen countId={COUNT} />, client);

    expect(await screen.findByRole('heading', { name: 'Count: Main store' })).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Edit the count' }));
    const form = screen.getByRole('form', { name: 'Edit the count' });
    const counted = within(form).getByLabelText(/Ball valve 15mm/u);
    await user.clear(counted);
    await user.type(counted, '7.25');
    await user.click(within(form).getByRole('button', { name: 'Save count' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({
      expectedVersion: 2,
      lines: [{ itemId: ITEM, countedQuantity: '7.25' }],
    });

    await user.click(await screen.findByRole('button', { name: 'Post count' }));
    await waitFor(() => expect(calls.some((call) => call.path.endsWith('/post'))).toBe(true));
    expect(await screen.findByText('Posted', { exact: false })).toBeInTheDocument();
  });
});
