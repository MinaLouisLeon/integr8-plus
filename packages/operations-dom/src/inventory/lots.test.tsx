import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type {
  InventoryItem,
  ItemDetail,
  ItemLot,
  LotTrace,
  StockCountDetail,
  StockLocation,
} from '../api.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { ItemScreen } from './item-screen.js';
import { LotLookupScreen, LotScreen } from './lot-screens.js';
import { addQuantities, splitSerials, suggestLeaving } from './lots.js';
import { StockCountScreen } from './stock-count-screen.js';

/**
 * Serial numbers and batches on the office's screens (ninth round;
 * ADR-0013): tracking an item, naming what arrives, choosing what leaves —
 * the earliest expiry proposed, an expired batch confirmed and explained —
 * counting by serial number, and the lookup and trace.
 */

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const ITEM = '00000000-0000-4000-8000-00000000f001';
const STORE = '00000000-0000-4000-8000-00000000f101';
const VAN = '00000000-0000-4000-8000-00000000f102';
const COUNT = '00000000-0000-4000-8000-00000000f201';
const LOT_OLD = '00000000-0000-4000-8000-00000000b001';
const LOT_NEXT = '00000000-0000-4000-8000-00000000b002';
const LOT_LAST = '00000000-0000-4000-8000-00000000b003';
const SERIAL_1 = '00000000-0000-4000-8000-00000000b101';
const SERIAL_2 = '00000000-0000-4000-8000-00000000b102';
const JOB = '00000000-0000-4000-8000-00000000a001';
const ASSET = '00000000-0000-4000-8000-00000000a101';

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
const settings = () => ({ body: { currency: 'EGP', timezone: 'Africa/Cairo' } });
const members = () => ({ body: { items: [], nextCursor: null } });
const nothing = () => ({ body: { items: [], nextCursor: null } });

const location = (id: string, name: string, kind: StockLocation['kind']): StockLocation => ({
  id,
  name,
  kind,
  ownership: 'ours',
  assignedTo: null,
  site: null,
  notes: null,
  version: 1,
  archivedAt: null,
});
const locations = [location(STORE, 'Main store', 'warehouse'), location(VAN, 'Van 1', 'van')];

const item = (overrides: Partial<InventoryItem> = {}): InventoryItem => ({
  id: ITEM,
  sku: 'FLT-1',
  name: 'Water filter',
  kind: 'stock_item',
  unit: 'each',
  tracking: 'none',
  description: null,
  categoryId: null,
  barcode: null,
  defaultUnitCost: null,
  salePrice: null,
  averageUnitCost: null,
  preferredSupplierId: null,
  supplierPartNumber: null,
  leadTimeDays: null,
  version: 3,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-10-01T09:00:00.000Z',
  archivedAt: null,
  ...overrides,
});

// Earliest expiry first, as the server lists them: one long expired, one
// expiring in 2099, one that never expires.
const batches: ItemLot[] = [
  {
    lotId: LOT_OLD,
    kind: 'batch',
    code: 'B-OLD',
    expiresOn: '2020-01-31',
    location: { id: STORE, name: 'Main store', kind: 'warehouse' },
    onHand: '2',
  },
  {
    lotId: LOT_NEXT,
    kind: 'batch',
    code: 'B-NEXT',
    expiresOn: '2099-03-31',
    location: { id: STORE, name: 'Main store', kind: 'warehouse' },
    onHand: '3',
  },
  {
    lotId: LOT_LAST,
    kind: 'batch',
    code: 'B-LAST',
    expiresOn: null,
    location: { id: STORE, name: 'Main store', kind: 'warehouse' },
    onHand: '5',
  },
];

const detail = (
  overrides: Partial<InventoryItem> = {},
  stock?: ItemDetail['stock'],
): ItemDetail => ({
  item: item(overrides),
  stock: stock ?? [
    {
      location: { id: STORE, name: 'Main store', kind: 'warehouse' },
      onHand: '2',
      reserved: '0',
      available: '2',
      minimum: null,
      lots: [],
    },
    {
      location: { id: VAN, name: 'Van 1', kind: 'van' },
      onHand: '1',
      reserved: '0',
      available: '1',
      minimum: null,
      lots: [],
    },
  ],
  onHand: '3',
  reserved: '0',
  available: '3',
  can: { manage: true, move: true },
});

const itemRoutes = (current: () => ItemDetail) => ({
  'GET /v1/me': me(MANAGE),
  'GET /v1/settings': settings,
  'GET /v1/inventory/categories': () => ({ body: { items: [] } }),
  'GET /v1/inventory/locations': () => ({ body: { items: locations } }),
  'GET /v1/inventory/items/:id': () => ({ body: current() }),
  'GET /v1/inventory/items/:id/media': () => ({ body: { items: [] } }),
  'GET /v1/inventory/movements': nothing,
});

describe('the decimal and code helpers', () => {
  it('adds quantities exactly and splits pasted serial numbers', () => {
    expect(addQuantities(['0.1', '0.2'])).toBe('0.3');
    expect(addQuantities(['2.5', '', 'x', '1'])).toBe('3.5');
    expect(splitSerials('SN-1\nSN-2, SN-3;SN-1\t SN-4 \r\n\n')).toEqual([
      'SN-1',
      'SN-2',
      'SN-3',
      'SN-4',
    ]);
  });

  it('proposes the earliest expiry first, passing over an expired batch', () => {
    expect(suggestLeaving(batches, '4', '2026-10-12')).toEqual({
      [LOT_NEXT]: '3',
      [LOT_LAST]: '1',
    });
    expect(suggestLeaving(batches, '0.5', '2026-10-12')).toEqual({ [LOT_NEXT]: '0.5' });
    expect(suggestLeaving(batches, '', '2026-10-12')).toEqual({});
  });
});

describe('tracking an item', { timeout: 30_000 }, () => {
  it('shows the lots each location holds, with an expired badge', async () => {
    const tracked = detail({ tracking: 'batch' }, [
      {
        location: { id: STORE, name: 'Main store', kind: 'warehouse' },
        onHand: '5',
        reserved: '0',
        available: '5',
        minimum: null,
        lots: [
          { lotId: LOT_OLD, kind: 'batch', code: 'B-OLD', expiresOn: '2020-01-31', onHand: '2' },
          { lotId: LOT_NEXT, kind: 'batch', code: 'B-NEXT', expiresOn: '2099-03-31', onHand: '3' },
        ],
      },
    ]);
    const { container } = renderScreen(
      <ItemScreen itemId={ITEM} />,
      fakeApi(itemRoutes(() => tracked)).client,
    );

    const stock = (await screen.findByRole('heading', { name: 'Stock by location' })).closest(
      'section',
    )!;
    const old = within(stock).getByRole('link', { name: 'B-OLD' });
    expect(old).toHaveAttribute('href', `/inventory/lots/${LOT_OLD}`);
    expect(within(old.closest('li')!).getByText('Expired')).toBeInTheDocument();
    const next = within(stock).getByRole('link', { name: 'B-NEXT' }).closest('li')!;
    expect(within(next).queryByText('Expired')).not.toBeInTheDocument();
    expect(within(next).getByText('Expires March 31, 2099')).toBeInTheDocument();
    expect(screen.getByText('Tracked by').nextElementSibling).toHaveTextContent('Batch');
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('asks for the serial numbers making up each location’s stock, with a running total', async () => {
    const user = userEvent.setup();
    let current = detail();
    let tries = 0;
    const { client, calls } = fakeApi({
      ...itemRoutes(() => current),
      'POST /v1/inventory/items/:id/tracking': () => {
        tries += 1;
        if (tries === 1) {
          return apiError(422, 'lots_quantity_mismatch', 'Mismatch.', [
            {
              field: 'body.lots',
              code: 'lots_quantity_mismatch',
              message: 'Mismatch.',
              params: { locationId: VAN, quantity: '1', lots: '0' },
            },
          ]);
        }
        current = detail({ tracking: 'serial', version: 4 });
        return { body: current };
      },
    });
    renderScreen(<ItemScreen itemId={ITEM} />, client);

    await user.click(await screen.findByRole('button', { name: 'Track by serial number / batch' }));
    const dialog = await screen.findByRole('dialog', { name: 'Serial numbers and batches' });
    expect(within(dialog).getByRole('radio', { name: 'Serial number' })).toBeChecked();
    expect(within(dialog).getByRole('radio', { name: 'Not tracked (as now)' })).not.toBeChecked();
    const save = within(dialog).getByRole('button', { name: 'Save tracking' });
    expect(save).toBeDisabled();

    const store = within(dialog).getByRole('group', { name: 'Main store: 2 each on hand' });
    expect(within(store).getAllByLabelText(/^Serial number \d$/u)).toHaveLength(2);
    expect(within(store).getByRole('status')).toHaveTextContent(
      '0 each of 2 each named. It does not add up yet.',
    );
    // Pasted or scanned in one go: each line fills the next empty row.
    await user.type(
      within(store).getByLabelText('Paste or scan serial numbers'),
      'SN-100{Enter}SN-101',
    );
    await user.click(within(store).getByRole('button', { name: 'Add these serial numbers' }));
    expect(within(store).getByLabelText('Serial number 1')).toHaveValue('SN-100');
    expect(within(store).getByLabelText('Serial number 2')).toHaveValue('SN-101');
    expect(within(store).getByRole('status')).toHaveTextContent(
      '2 each of 2 each named. It adds up.',
    );
    expect(save).toBeDisabled();

    const van = within(dialog).getByRole('group', { name: 'Van 1: 1 each on hand' });
    await user.type(within(van).getByLabelText('Serial number 1'), 'SN-100');
    await user.click(save);
    // Stock moved meanwhile: the server's refusal is said with the location's name.
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'At Van 1, 0 each named for 1 each on hand.',
    );

    await user.clear(within(van).getByLabelText('Serial number 1'));
    await user.type(within(van).getByLabelText('Serial number 1'), 'SN-102');
    await user.click(save);
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Serial numbers and batches' })).toBeNull(),
    );
    const posts = calls.filter((call) => call.path.endsWith('/tracking'));
    expect(posts.at(-1)!.body).toEqual({
      tracking: 'serial',
      expectedVersion: 3,
      lots: [
        { locationId: STORE, code: 'SN-100', quantity: '1' },
        { locationId: STORE, code: 'SN-101', quantity: '1' },
        { locationId: VAN, code: 'SN-102', quantity: '1' },
      ],
    });
    expect(screen.getByText('Tracked by').nextElementSibling).toHaveTextContent('Serial number');
  });

  it('stops tracking without asking for anything: the stock stays', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      ...itemRoutes(() => detail({ tracking: 'batch' })),
      'POST /v1/inventory/items/:id/tracking': () => ({ body: detail() }),
    });
    renderScreen(<ItemScreen itemId={ITEM} />, client);
    await user.click(await screen.findByRole('button', { name: 'Track by serial number / batch' }));
    const dialog = await screen.findByRole('dialog', { name: 'Serial numbers and batches' });
    expect(within(dialog).getByRole('radio', { name: 'Not tracked' })).toBeChecked();
    expect(within(dialog).getByText(/The stock stays where it is/u)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Save tracking' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      tracking: 'none',
      expectedVersion: 3,
    });
  });
});

describe('moving tracked stock', { timeout: 30_000 }, () => {
  it('proposes the earliest expiry, lets the person change it, and confirms an expired batch', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      ...itemRoutes(() => detail({ tracking: 'batch' })),
      'GET /v1/inventory/items/:id/lots': (call) => ({
        body: { items: call.query.get('locationId') === STORE ? batches : [] },
      }),
      'POST /v1/inventory/movements': () => ({
        status: 201,
        body: { postingId: USER, movements: [] },
      }),
    });
    renderScreen(<ItemScreen itemId={ITEM} />, client);

    await user.click(await screen.findByRole('button', { name: 'Move stock' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move stock' });
    await user.selectOptions(within(dialog).getByLabelText('What happened'), 'issue');
    await user.selectOptions(within(dialog).getByLabelText('Location'), STORE);
    await user.type(within(dialog).getByLabelText('Quantity'), '4');

    const picker = await within(dialog).findByRole('group', { name: 'Which batches' });
    // B-OLD expired: passed over; B-NEXT then B-LAST.
    expect(within(picker).getByLabelText(/^B-OLD/u)).toHaveValue('');
    expect(within(picker).getByLabelText(/^B-NEXT/u)).toHaveValue('3');
    expect(within(picker).getByLabelText(/^B-LAST/u)).toHaveValue('1');
    expect(within(picker).getByRole('status')).toHaveTextContent(
      '4 each of 4 each named. It adds up.',
    );

    // The person took the old batch instead.
    await user.type(within(picker).getByLabelText(/^B-OLD/u), '2');
    await user.clear(within(picker).getByLabelText(/^B-NEXT/u));
    await user.type(within(picker).getByLabelText(/^B-NEXT/u), '1');
    const post = within(dialog).getByRole('button', { name: 'Post' });
    const warning = within(picker).getByRole('alert');
    expect(warning).toHaveTextContent('Batch B-OLD expired on January 31, 2020.');
    await user.type(within(dialog).getByLabelText('Reason'), 'Training rig');
    expect(post).toBeDisabled();
    await user.click(within(warning).getByLabelText('Use the expired batch anyway'));
    expect(post).toBeEnabled();
    await user.click(post);

    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      type: 'issue',
      itemId: ITEM,
      locationId: STORE,
      quantity: '4',
      reason: 'Training rig',
      lots: [
        { lotId: LOT_OLD, quantity: '2' },
        { lotId: LOT_NEXT, quantity: '1' },
        { lotId: LOT_LAST, quantity: '1' },
      ],
      allowExpired: true,
    });
  });

  it('names a serial number per unit received, from a pasted list', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      ...itemRoutes(() => detail({ tracking: 'serial' })),
      'POST /v1/inventory/movements': () => ({
        status: 201,
        body: { postingId: USER, movements: [] },
      }),
    });
    const { container } = renderScreen(<ItemScreen itemId={ITEM} />, client);

    await user.click(await screen.findByRole('button', { name: 'Move stock' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move stock' });
    await user.selectOptions(within(dialog).getByLabelText('Location'), STORE);
    await user.type(within(dialog).getByLabelText('Quantity'), '3');
    const serials = within(dialog).getByRole('group', { name: 'Serial numbers' });
    expect(within(serials).getAllByLabelText(/^Serial number \d$/u)).toHaveLength(3);
    await user.type(within(serials).getByLabelText('Serial number 1'), 'A-1');
    await user.type(
      within(serials).getByLabelText('Paste or scan serial numbers'),
      'A-1{Enter}A-2{Enter}A-3',
    );
    await user.click(within(serials).getByRole('button', { name: 'Add these serial numbers' }));
    // A-1 was there already: only the new ones fill the empty rows.
    expect(within(serials).getByLabelText('Serial number 2')).toHaveValue('A-2');
    expect(within(serials).getByLabelText('Serial number 3')).toHaveValue('A-3');
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(within(dialog).getByRole('button', { name: 'Post' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'POST')).toBe(true));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      type: 'receipt',
      itemId: ITEM,
      locationId: STORE,
      quantity: '3',
      lots: [
        { code: 'A-1', quantity: '1' },
        { code: 'A-2', quantity: '1' },
        { code: 'A-3', quantity: '1' },
      ],
    });
  });
});

describe('counting by serial number', { timeout: 30_000 }, () => {
  const count = (lines: StockCountDetail['lines'] = []): StockCountDetail => ({
    count: {
      id: COUNT,
      location: { id: STORE, name: 'Main store', kind: 'warehouse' },
      status: 'draft',
      notes: null,
      version: 1,
      createdBy: USER,
      postedBy: null,
      postedAt: null,
      createdAt: '2026-10-01T09:00:00.000Z',
    },
    lines,
    can: { edit: true },
  });
  const serialItem = {
    id: ITEM,
    sku: 'FLT-1',
    name: 'Water filter',
    kind: 'stock_item',
    unit: 'each',
    tracking: 'serial',
  } as const;

  it('lists the serial numbers held, ticks those found, and adds a code not known here', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/members': members,
      'GET /v1/inventory/counts/:id': () => ({ body: count() }),
      'GET /v1/inventory/locations/:id': () => ({
        body: {
          location: locations[0]!,
          stock: [{ item: serialItem, onHand: '2', reserved: '0', available: '2', minimum: null }],
          can: { manage: true, move: true },
        },
      }),
      'GET /v1/inventory/items/:id/lots': () => ({
        body: {
          items: [
            {
              lotId: SERIAL_1,
              kind: 'serial',
              code: 'SN-1',
              expiresOn: null,
              location: { id: STORE, name: 'Main store', kind: 'warehouse' },
              onHand: '1',
            },
            {
              lotId: SERIAL_2,
              kind: 'serial',
              code: 'SN-2',
              expiresOn: null,
              location: { id: STORE, name: 'Main store', kind: 'warehouse' },
              onHand: '1',
            },
          ],
        },
      }),
      'PUT /v1/inventory/counts/:id/lines': () => ({ body: count() }),
    });
    const { container } = renderScreen(<StockCountScreen countId={COUNT} />, client);

    await user.click(await screen.findByRole('button', { name: 'Edit the count' }));
    await user.click(await screen.findByRole('button', { name: '+ Water filter' }));
    const form = screen.getByRole('form', { name: 'Edit the count' });
    const first = await within(form).findByRole('checkbox', { name: 'SN-1 is here' });
    expect(first).not.toBeChecked();
    expect(within(form).getByRole('checkbox', { name: 'SN-2 is here' })).not.toBeChecked();
    await user.click(first);

    await user.click(within(form).getByRole('button', { name: 'Add a code' }));
    const save = within(form).getByRole('button', { name: 'Save count' });
    // A new code must be typed before the count can be saved.
    expect(save).toBeDisabled();
    await user.type(within(form).getByLabelText('New serial number or batch code'), 'SN-9');
    expect(within(form).getByRole('checkbox', { name: 'SN-9 is here' })).toBeChecked();
    expect(await accessibilityViolations(container)).toEqual([]);
    await user.click(save);

    await waitFor(() => expect(calls.some((call) => call.method === 'PUT')).toBe(true));
    expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({
      expectedVersion: 1,
      lines: [
        { itemId: ITEM, countedQuantity: '1', lotId: SERIAL_1 },
        { itemId: ITEM, countedQuantity: '0', lotId: SERIAL_2 },
        { itemId: ITEM, countedQuantity: '1', lotCode: 'SN-9' },
      ],
    });
  });
});

describe('the serial lookup and trace', { timeout: 30_000 }, () => {
  it('finds codes by their start and opens one', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/inventory/lots': () => ({
        body: {
          items: [
            {
              lotId: SERIAL_1,
              kind: 'serial',
              code: 'SN-1',
              expiresOn: null,
              item: {
                id: ITEM,
                sku: 'FLT-1',
                name: 'Water filter',
                kind: 'stock_item',
                unit: 'each',
                tracking: 'serial',
              },
            },
          ],
        },
      }),
    });
    const { container, navigate } = renderScreen(<LotLookupScreen />, client);

    await user.type(screen.getByLabelText('Serial number or batch code'), 'sn');
    await user.click(screen.getByRole('button', { name: 'Find' }));
    const link = await screen.findByRole('link', { name: 'SN-1' });
    expect(calls.at(-1)!.query.get('code')).toBe('sn');
    expect(screen.getByRole('link', { name: 'Water filter' })).toHaveAttribute(
      'href',
      `/inventory/items/${ITEM}`,
    );
    expect(await accessibilityViolations(container)).toEqual([]);
    await user.click(link);
    expect(navigate).toHaveBeenCalledWith(`/inventory/lots/${SERIAL_1}`);
  });

  it('says so when nothing starts with the code', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({ 'GET /v1/inventory/lots': () => ({ body: { items: [] } }) });
    renderScreen(<LotLookupScreen initialCode="ZZ" />, client);
    expect(
      await screen.findByText('No serial number or batch starts with that.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Serial number or batch code')).toHaveValue('ZZ');
    await user.clear(screen.getByLabelText('Serial number or batch code'));
    expect(screen.getByRole('button', { name: 'Find' })).toBeDisabled();
  });

  it('traces a serial number from its receipt to the job and asset it was fitted to', async () => {
    const trace: LotTrace = {
      lotId: SERIAL_1,
      kind: 'serial',
      code: 'SN-1',
      expiresOn: null,
      item: {
        id: ITEM,
        sku: 'FLT-1',
        name: 'Water filter',
        kind: 'stock_item',
        unit: 'each',
        tracking: 'serial',
      },
      createdAt: '2026-10-01T09:00:00.000Z',
      stock: [],
      history: [
        {
          movementId: '00000000-0000-4000-8000-00000000c001',
          at: '2026-10-01T09:00:00.000Z',
          location: { id: STORE, name: 'Main store', kind: 'warehouse' },
          kind: 'receipt',
          quantity: '1',
          reason: 'PO-000004',
          by: { id: USER, name: 'Dee' },
          source: { kind: 'receipt', id: null },
          workOrder: null,
          assetId: null,
        },
        {
          movementId: '00000000-0000-4000-8000-00000000c002',
          at: '2026-10-05T09:00:00.000Z',
          location: { id: VAN, name: 'Van 1', kind: 'van' },
          kind: 'consumption',
          quantity: '-1',
          reason: null,
          by: { id: USER, name: 'Sam' },
          source: { kind: 'job_part', id: null },
          workOrder: { id: JOB, referenceLabel: 'WO-000012' },
          assetId: ASSET,
        },
      ],
    };
    const { container } = renderScreen(
      <LotScreen lotId={SERIAL_1} />,
      fakeApi({ 'GET /v1/inventory/lots/:id': () => ({ body: trace }) }).client,
    );

    expect(await screen.findByRole('heading', { level: 1 })).toHaveTextContent('SN-1');
    expect(
      screen.getByText('Not in stock anywhere: used, delivered or returned.'),
    ).toBeInTheDocument();
    const history = screen.getByRole('heading', { name: 'Where it has been' }).closest('section')!;
    const steps = within(history).getAllByRole('listitem');
    expect(steps[0]).toHaveTextContent('Received from a supplier');
    expect(steps[0]).toHaveTextContent('PO-000004');
    expect(steps[1]).toHaveTextContent('Used on a job');
    expect(within(steps[1]!).getByRole('link', { name: 'Job WO-000012' })).toHaveAttribute(
      'href',
      `/work-orders/${JOB}`,
    );
    expect(
      within(steps[1]!).getByRole('link', { name: 'Open the asset it was fitted to' }),
    ).toHaveAttribute('href', `/assets/${ASSET}`);
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('reads right to left in Arabic', async () => {
    renderScreen(<LotLookupScreen />, fakeApi({}).client, { locale: 'ar' });
    expect(
      await screen.findByRole('heading', { name: 'البحث عن رقم تسلسلي أو دفعة' }),
    ).toBeInTheDocument();
    // Codes are typed and read left to right inside the mirrored page.
    expect(screen.getByLabelText('الرقم التسلسلي أو رمز الدفعة')).toHaveAttribute('dir', 'ltr');
    expect(screen.getByRole('button', { name: 'بحث' })).toBeDisabled();
  });
});
