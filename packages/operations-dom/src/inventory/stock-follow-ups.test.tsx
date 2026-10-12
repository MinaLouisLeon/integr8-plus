import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ItemDetail, ItemMedia, StockLocation, VanRequest } from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { ItemScreen } from './item-screen.js';
import { LocationListScreen } from './location-list.js';
import { LocationScreen } from './location-screen.js';
import { VanRequestsScreen } from './van-requests.js';

/**
 * The eighth round's inventory screens (ADR-0012): whose stock a site holds,
 * an item's images and datasheets, and the store's queue of van refills.
 */

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const ITEM = '00000000-0000-4000-8000-00000000f001';
const ITEM_2 = '00000000-0000-4000-8000-00000000f002';
const STORE = '00000000-0000-4000-8000-00000000f101';
const VAN = '00000000-0000-4000-8000-00000000f102';
const SITE_LOCATION = '00000000-0000-4000-8000-00000000f103';
const CUSTOMER = '00000000-0000-4000-8000-00000000c001';
const SITE = '00000000-0000-4000-8000-00000000c101';
const REQUEST = '00000000-0000-4000-8000-00000000e001';
const PHOTO_1 = '00000000-0000-4000-8000-00000000a101';
const PHOTO_2 = '00000000-0000-4000-8000-00000000a102';
const SHEET = '00000000-0000-4000-8000-00000000a103';

const me = (permissions: string[]) => () => ({
  body: {
    userId: USER,
    tenantId: TENANT,
    email: 'd@x.example',
    displayName: 'Dee',
    role: 'dispatcher',
    permissions,
    features: { inventory: true },
  },
});
const MANAGE = ['inventory.read', 'inventory.manage', 'inventory.move', 'inventory.consume'];
const members = () => ({ body: { items: [], nextCursor: null } });

const location = (overrides: Partial<StockLocation> = {}): StockLocation => ({
  id: STORE,
  name: 'Main store',
  kind: 'warehouse',
  ownership: 'ours',
  assignedTo: null,
  site: null,
  notes: null,
  version: 1,
  archivedAt: null,
  ...overrides,
});
const store = location();
const van = location({ id: VAN, name: 'Van 1', kind: 'van', assignedTo: USER });
const customerSite = location({
  id: SITE_LOCATION,
  name: 'Riverside plant room',
  kind: 'site',
  ownership: 'customer',
  site: { id: SITE, name: 'Block A' },
});

describe('site locations', { timeout: 20_000 }, () => {
  it('marks the customer’s stock, and offers the choice only for a site', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/members': members,
      'GET /v1/inventory/locations': () => ({ body: { items: [store, van, customerSite] } }),
      'GET /v1/customers': () => ({
        body: {
          items: [
            {
              id: CUSTOMER,
              name: 'Riverside Housing',
              accountNumber: null,
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
      }),
      'GET /v1/sites': () => ({
        body: { items: [{ id: SITE, name: 'Block A' }], nextCursor: null },
      }),
      'POST /v1/inventory/locations': () => ({ status: 201, body: customerSite }),
    });
    const { container, navigate } = renderScreen(<LocationListScreen />, client);

    const row = (await screen.findByRole('link', { name: 'Riverside plant room' })).closest('li')!;
    expect(within(row).getByText('Customer’s stock')).toBeInTheDocument();
    const storeRow = screen.getByRole('link', { name: 'Main store' }).closest('li')!;
    expect(within(storeRow).queryByText('Customer’s stock')).not.toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'New location' }));
    const dialog = await screen.findByRole('dialog', { name: 'New location' });
    // A warehouse is always ours: no choice to make.
    expect(within(dialog).queryByRole('radio', { name: /Our stock/u })).not.toBeInTheDocument();

    await user.type(within(dialog).getByLabelText('Name'), 'Riverside plant room');
    await user.selectOptions(within(dialog).getByLabelText('Kind'), 'site');
    const ours = within(dialog).getByRole('radio', { name: /Our stock/u });
    expect(ours).toBeChecked();
    expect(ours).toHaveAccessibleDescription(
      'Counted and valued as ours; moved here by transfer and used on jobs at this site.',
    );
    const add = within(dialog).getByRole('button', { name: 'Add location' });
    expect(add).toBeDisabled();

    await user.type(within(dialog).getByLabelText('Customer'), 'Riverside');
    await user.click(within(dialog).getByRole('button', { name: 'Search' }));
    await user.click(await within(dialog).findByRole('button', { name: /Riverside Housing/u }));
    await user.selectOptions(
      within(dialog).getByLabelText('Site'),
      await within(dialog).findByRole('option', { name: 'Block A' }),
    );
    await user.click(within(dialog).getByRole('radio', { name: /The customer’s stock/u }));
    await user.click(add);

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(`/inventory/locations/${SITE_LOCATION}`),
    );
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      name: 'Riverside plant room',
      kind: 'site',
      siteId: SITE,
      ownership: 'customer',
    });
  });

  it('says so when whose stock it is can no longer change', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/members': members,
      'GET /v1/inventory/locations/:id': () => ({
        body: {
          location: location({
            id: SITE_LOCATION,
            name: 'Riverside plant room',
            kind: 'site',
            site: { id: SITE, name: 'Block A' },
            version: 4,
          }),
          stock: [],
          can: { manage: true, move: true },
        },
      }),
      'GET /v1/inventory/counts': () => ({ body: { items: [] } }),
      'PATCH /v1/inventory/locations/:id': () =>
        apiError(409, 'ownership_fixed', 'Stock has moved at this location.'),
    });
    renderScreen(<LocationScreen locationId={SITE_LOCATION} />, client);

    const section = (await screen.findByRole('heading', { name: 'Whose stock' })).closest(
      'section',
    )!;
    expect(within(section).getByText('Our stock')).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Change' }));
    await user.click(within(section).getByRole('radio', { name: /The customer’s stock/u }));
    await user.click(within(section).getByRole('button', { name: 'Save changes' }));

    expect(await within(section).findByRole('alert')).toHaveTextContent(
      'Stock has moved at this location, so whose stock it holds can no longer change.',
    );
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({
      expectedVersion: 4,
      ownership: 'customer',
    });
  });
});

const media = (overrides: Partial<ItemMedia> = {}): ItemMedia => ({
  id: PHOTO_1,
  fileId: '00000000-0000-4000-8000-00000000a201',
  title: 'Front',
  kind: 'photo',
  stage: null,
  contentType: 'image/jpeg',
  byteSize: 2048,
  addedBy: { id: USER, name: 'Dee' },
  createdAt: '2026-10-01T09:00:00.000Z',
  isMain: false,
  ...overrides,
});

const itemDetail = (): ItemDetail => ({
  item: {
    id: ITEM,
    sku: 'VAL-15',
    name: 'Ball valve 15mm',
    kind: 'stock_item',
    unit: 'each',
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
  },
  stock: [],
  onHand: '0',
  reserved: '0',
  available: '0',
  can: { manage: true, move: true },
});

describe('item media', { timeout: 20_000 }, () => {
  it('shows images first with the main one marked, datasheets below, and changes the main image', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const front = media({ isMain: true });
    const side = media({
      id: PHOTO_2,
      fileId: '00000000-0000-4000-8000-00000000a202',
      title: 'Side',
    });
    const sheet = media({
      id: SHEET,
      fileId: '00000000-0000-4000-8000-00000000a203',
      title: 'Datasheet',
      kind: 'manual',
      contentType: 'application/pdf',
    });
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/settings': () => ({ body: { currency: 'EGP', timezone: 'Africa/Cairo' } }),
      'GET /v1/inventory/categories': () => ({ body: { items: [] } }),
      'GET /v1/inventory/locations': () => ({ body: { items: [store] } }),
      'GET /v1/inventory/items/:id': () => ({ body: itemDetail() }),
      'GET /v1/inventory/movements': () => ({ body: { items: [], nextCursor: null } }),
      'GET /v1/inventory/items/:id/media': () => ({ body: { items: [front, side, sheet] } }),
      'GET /v1/media/:id': (_call, params) => ({
        body: {
          id: params.id,
          url: `https://files.test/${params.id}`,
          thumbnailUrl: null,
          expiresAt: '2099-01-01T00:00:00.000Z',
        },
      }),
      'POST /v1/inventory/items/:id/media/:attachmentId/main': () => ({
        body: {
          items: [{ ...side, isMain: true }, { ...front, isMain: false }, sheet],
        },
      }),
    });
    const { container } = renderScreen(<ItemScreen itemId={ITEM} />, client);

    const images = await screen.findByRole('list', { name: 'Images' });
    const [first, second] = within(images).getAllByRole('listitem');
    expect(within(first!).getByText('Main image')).toBeInTheDocument();
    expect(within(first!).getByRole('img', { name: 'Front' })).toHaveAttribute(
      'src',
      `https://files.test/${front.fileId}`,
    );
    expect(within(second!).queryByText('Main image')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Datasheets' })).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: /^Datasheet/u }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith(`https://files.test/${sheet.fileId}`, '_blank', 'noopener'),
    );

    await user.click(screen.getByRole('button', { name: 'Make Side the main image' }));
    await waitFor(() =>
      expect(
        calls.some((call) => call.path === `/v1/inventory/items/${ITEM}/media/${PHOTO_2}/main`),
      ).toBe(true),
    );
    const after = within(screen.getByRole('list', { name: 'Images' })).getAllByRole('listitem');
    expect(within(after[0]!).getByText('Side')).toBeInTheDocument();
    expect(within(after[0]!).getByText('Main image')).toBeInTheDocument();
    expect(within(after[1]!).queryByText('Main image')).not.toBeInTheDocument();
    open.mockRestore();
  });

  it('says only an image can be the main one', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/settings': () => ({ body: { currency: 'EGP', timezone: 'Africa/Cairo' } }),
      'GET /v1/inventory/categories': () => ({ body: { items: [] } }),
      'GET /v1/inventory/locations': () => ({ body: { items: [store] } }),
      'GET /v1/inventory/items/:id': () => ({ body: itemDetail() }),
      'GET /v1/inventory/movements': () => ({ body: { items: [], nextCursor: null } }),
      'GET /v1/inventory/items/:id/media': () => ({
        body: { items: [media({ isMain: true }), media({ id: PHOTO_2, title: 'Side' })] },
      }),
      'GET /v1/media/:id': (_call, params) => ({
        body: { id: params.id, url: 'https://files.test/x', thumbnailUrl: null },
      }),
      'POST /v1/inventory/items/:id/media/:attachmentId/main': () =>
        apiError(422, 'main_not_image', 'Only an image can be the main image.'),
    });
    renderScreen(<ItemScreen itemId={ITEM} />, client);

    await user.click(await screen.findByRole('button', { name: 'Make Side the main image' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Only an image can be the item’s main image. Choose a photo.',
    );
  });

  it('shows a reader the gallery without any way to change it', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(['inventory.read']),
      'GET /v1/settings': () => ({ body: { currency: 'EGP', timezone: 'Africa/Cairo' } }),
      'GET /v1/inventory/categories': () => ({ body: { items: [] } }),
      'GET /v1/inventory/locations': () => ({ body: { items: [store] } }),
      'GET /v1/inventory/items/:id': () => ({
        body: { ...itemDetail(), can: { manage: false, move: false } },
      }),
      'GET /v1/inventory/movements': () => ({ body: { items: [], nextCursor: null } }),
      'GET /v1/inventory/items/:id/media': () => ({ body: { items: [media({ isMain: true })] } }),
      'GET /v1/media/:id': (_call, params) => ({
        body: { id: params.id, url: 'https://files.test/x', thumbnailUrl: 'https://files.test/t' },
      }),
    });
    renderScreen(<ItemScreen itemId={ITEM} />, client);

    expect(await screen.findByRole('img', { name: 'Front' })).toHaveAttribute(
      'src',
      'https://files.test/t',
    );
    expect(screen.queryByRole('button', { name: /main image/u })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('form', { name: 'Add an image or datasheet' }),
    ).not.toBeInTheDocument();
  });
});

const request = (overrides: Partial<VanRequest> = {}): VanRequest => ({
  id: REQUEST,
  van: { id: VAN, name: 'Van 1', kind: 'van', assignedTo: USER },
  status: 'open',
  notes: 'For the Riverside job tomorrow.',
  requestedBy: { id: USER, name: 'Eve' },
  requestedAt: '2026-10-10T07:30:00.000Z',
  from: null,
  pickedBy: null,
  pickedAt: null,
  cancelledAt: null,
  version: 1,
  lines: [
    {
      item: { id: ITEM, sku: 'VAL-15', name: 'Ball valve 15mm', kind: 'stock_item', unit: 'each' },
      requested: '5',
      picked: null,
    },
    {
      item: { id: ITEM_2, sku: 'PTFE', name: 'PTFE tape', kind: 'stock_item', unit: 'roll' },
      requested: '2',
      picked: null,
    },
  ],
  can: { pick: true, cancel: true },
  ...overrides,
});

describe('van requests', { timeout: 20_000 }, () => {
  it('lists the open queue and picks a request from a warehouse, never more than asked', async () => {
    const user = userEvent.setup();
    let current = request();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/inventory/van-requests': () => ({ body: { items: [current] } }),
      'GET /v1/inventory/locations': () => ({ body: { items: [store, van, customerSite] } }),
      'POST /v1/inventory/van-requests/:id/pick': () => {
        current = request({
          status: 'picked',
          from: { id: STORE, name: 'Main store', kind: 'warehouse' },
          pickedBy: { id: USER, name: 'Dee' },
          pickedAt: '2026-10-10T09:00:00.000Z',
          version: 2,
          lines: request().lines.map((line, index) => ({
            ...line,
            picked: index === 0 ? '3' : '0',
          })),
          can: { pick: false, cancel: false },
        });
        return { body: current };
      },
    });
    const { container } = renderScreen(<VanRequestsScreen />, client);

    const card = await screen.findByRole('article', { name: 'Request for Van 1' });
    expect(within(card).getByText('Open')).toBeInTheDocument();
    expect(within(card).getByText(/Asked by Eve/u)).toBeInTheDocument();
    expect(within(card).getByText('PTFE tape')).toBeInTheDocument();
    expect(calls[calls.length - 1]!.query.getAll('status')).toEqual(['open']);
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(within(card).getByRole('button', { name: 'Pick' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pick for Van 1' });
    const from = within(dialog).getByLabelText('From warehouse');
    // Only our warehouses: never the van itself, nor the customer's stock.
    expect(
      within(from)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual(['Choose a warehouse', 'Main store']);
    expect(from).toHaveValue(STORE);

    const valves = within(dialog).getByLabelText('Ball valve 15mm');
    expect(valves).toHaveValue('5');
    const send = within(dialog).getByRole('button', { name: 'Send to the van' });
    await user.clear(valves);
    await user.type(valves, '6');
    expect(valves).toHaveAccessibleDescription('At most 5 each: that is what was asked.');
    expect(send).toBeDisabled();

    await user.clear(valves);
    await user.type(valves, '3');
    const tape = within(dialog).getByLabelText('PTFE tape');
    await user.clear(tape);
    await user.type(tape, '0');
    expect(send).toBeEnabled();
    await user.click(send);

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Pick for Van 1' })).not.toBeInTheDocument(),
    );
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      expectedVersion: 1,
      fromLocationId: STORE,
      lines: [
        { itemId: ITEM, quantity: '3' },
        { itemId: ITEM_2, quantity: '0' },
      ],
    });
  });

  it('says when the request was already picked elsewhere', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/inventory/van-requests': () => ({ body: { items: [request()] } }),
      'GET /v1/inventory/locations': () => ({ body: { items: [store] } }),
      'POST /v1/inventory/van-requests/:id/pick': () =>
        apiError(409, 'request_not_open', 'Already picked.'),
    });
    renderScreen(<VanRequestsScreen />, client);

    await user.click(await screen.findByRole('button', { name: 'Pick' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pick for Van 1' });
    await user.click(within(dialog).getByRole('button', { name: 'Send to the van' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'This request has already been picked or withdrawn. Reload to see it.',
    );
  });
});
