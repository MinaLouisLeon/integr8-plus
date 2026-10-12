import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssemblyOrderDetail, Bom, ItemBom, MaterialPlan, PlanSuggestion } from '../api.js';
import { ItemScreen } from '../inventory/item-screen.js';
import { accessibilityViolations, apiError, fakeApi, renderScreen } from '../testing/render.js';
import { AssemblyOrderListScreen } from './assembly-order-list.js';
import { AssemblyOrderScreen } from './assembly-order-screen.js';
import { BomListScreen } from './bom-list.js';
import { BomScreen } from './bom-screen.js';
import { BomVersionScreen } from './bom-version-screen.js';
import { MaterialPlanListScreen } from './plan-list.js';
import { MaterialPlanScreen } from './plan-screen.js';

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const PUMP = '00000000-0000-4000-8000-00000000d001';
const MOTOR = '00000000-0000-4000-8000-00000000d002';
const CASING = '00000000-0000-4000-8000-00000000d003';
const SEAL = '00000000-0000-4000-8000-00000000d004';
const BOM = '00000000-0000-4000-8000-00000000d101';
const OLD_BOM = '00000000-0000-4000-8000-00000000d102';
const STORE = '00000000-0000-4000-8000-00000000f101';
const ORDER = '00000000-0000-4000-8000-00000000d201';
const PLAN = '00000000-0000-4000-8000-00000000d301';
const SUPPLIER = '00000000-0000-4000-8000-00000000a001';
const PO = '00000000-0000-4000-8000-00000000b001';

const MANAGE = [
  'inventory.read',
  'inventory.move',
  'inventory.manage',
  'manufacturing.read',
  'manufacturing.manage',
  'purchasing.read',
  'purchasing.manage',
];
const STOREKEEPER = MANAGE.filter((permission) => permission !== 'purchasing.manage');
const VIEWER = ['inventory.read', 'manufacturing.read', 'purchasing.read'];
const BOTH = { inventory: true, manufacturing: true, purchasing: true };

const me =
  (permissions: string[], features: Record<string, boolean> = BOTH) =>
  () => ({
    body: {
      userId: USER,
      tenantId: TENANT,
      email: 'd@x.example',
      displayName: 'Dee',
      role: 'inventory_manager',
      permissions,
      features,
    },
  });
const settings = () => ({ body: { currency: 'EGP', timezone: 'Africa/Cairo' } });
const person = { id: USER, name: 'Dee' };

const pump = {
  id: PUMP,
  sku: 'PMP-1',
  name: 'Pump unit',
  kind: 'stock_item',
  unit: 'each',
} as const;
const motor = { id: MOTOR, sku: 'MOT-1', name: 'Motor', kind: 'stock_item', unit: 'each' } as const;
const casing = {
  id: CASING,
  sku: 'CAS-1',
  name: 'Casing',
  kind: 'stock_item',
  unit: 'each',
} as const;
const seal = {
  id: SEAL,
  sku: 'SEAL-1',
  name: 'Seal kit',
  kind: 'non_stock_item',
  unit: 'set',
} as const;
const store = { id: STORE, name: 'Main store', kind: 'warehouse' } as const;

const locations = () => ({
  body: {
    items: [
      {
        ...store,
        assignedTo: null,
        site: null,
        notes: null,
        version: 1,
        archivedAt: null,
      },
    ],
  },
});

const bom = (overrides: Partial<Bom> = {}): Bom => ({
  id: BOM,
  item: pump,
  version: 2,
  labourCost: '15',
  overheadCost: '5',
  note: 'Torque the casing bolts.',
  components: [
    { item: motor, quantity: '1', unitCost: '100' },
    { item: casing, quantity: '2.5', unitCost: '10' },
  ],
  unitCost: '145',
  createdBy: person,
  createdAt: '2026-10-01T09:00:00.000Z',
  superseded: false,
  ...overrides,
});

const itemBom = (current: Bom | null = bom()): ItemBom => ({
  current,
  versions: [
    { id: BOM, version: 2, createdAt: '2026-10-01T09:00:00.000Z', superseded: false },
    { id: OLD_BOM, version: 1, createdAt: '2026-09-01T09:00:00.000Z', superseded: true },
  ],
});

const order = (overrides: Partial<AssemblyOrderDetail> = {}): AssemblyOrderDetail => ({
  id: ORDER,
  reference: 'AO-000007',
  direction: 'assemble',
  item: pump,
  bom: { id: BOM, version: 2, current: true },
  location: store,
  quantity: '4',
  status: 'draft',
  plannedFor: '2026-10-20',
  planId: null,
  note: null,
  unitCost: null,
  labourCost: null,
  overheadCost: null,
  createdBy: person,
  createdAt: '2026-10-02T09:00:00.000Z',
  completedBy: null,
  completedAt: null,
  cancelledBy: null,
  cancelledAt: null,
  version: 3,
  needs: [
    { item: motor, quantity: '4', onHand: '6', reserved: '1', available: '5', short: '0' },
    { item: casing, quantity: '10', onHand: '9', reserved: '1', available: '8', short: '2' },
  ],
  outputs: [{ item: pump, quantity: '4' }],
  can: { edit: true, complete: false, cancel: true },
  ...overrides,
});

const suggestion = (overrides: Partial<PlanSuggestion> = {}): PlanSuggestion => ({
  id: '00000000-0000-4000-8000-00000000d401',
  item: pump,
  action: 'build',
  level: 0,
  required: '12',
  available: '2',
  onOrder: '0',
  reorderMinimum: '0',
  quantity: '10',
  needBy: '2026-10-15',
  orderBy: '2026-10-12',
  leadTimeDays: 3,
  supplier: null,
  bomId: BOM,
  basis: { sales: '12', assembly: '0', parent: '0', lateByDays: 0 },
  drafted: null,
  ...overrides,
});

const buildPump = suggestion();
const buyMotor = suggestion({
  id: '00000000-0000-4000-8000-00000000d402',
  item: motor,
  action: 'buy',
  level: 1,
  required: '10',
  available: '5',
  onOrder: '1',
  reorderMinimum: '2',
  quantity: '6',
  needBy: '2026-10-12',
  orderBy: '2026-10-05',
  leadTimeDays: 7,
  supplier: { id: SUPPLIER, name: 'Acme Supplies' },
  bomId: null,
  basis: { sales: '0', assembly: '0', parent: '10', lateByDays: 4 },
});
const buyCasing = suggestion({
  id: '00000000-0000-4000-8000-00000000d403',
  item: casing,
  action: 'buy',
  level: 1,
  quantity: '25',
  supplier: null,
  bomId: null,
  basis: { sales: '0', assembly: '0', parent: '25', lateByDays: 0 },
});

const plan = (overrides: Partial<MaterialPlan> = {}): MaterialPlan => ({
  id: PLAN,
  horizonEnd: '2026-11-11',
  runBy: person,
  runAt: '2026-10-12T08:00:00.000Z',
  suggestions: [buyMotor, buildPump, buyCasing],
  can: { draftAssemblies: true, draftPurchases: true },
  ...overrides,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('manufacturing access', { timeout: 20_000 }, () => {
  it('says so when the company has no manufacturing module', async () => {
    const { client } = fakeApi({ 'GET /v1/me': me(MANAGE, { inventory: true }) });
    renderScreen(<BomListScreen />, client);
    expect(
      await screen.findByText(
        'Manufacturing is not switched on for your company. Ask Integr8 to turn it on.',
      ),
    ).toBeInTheDocument();
  });

  it('links an item to its bill, and keeps its lead time', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/settings': settings,
      'GET /v1/inventory/categories': () => ({ body: { items: [] } }),
      'GET /v1/inventory/locations': locations,
      'GET /v1/inventory/movements': () => ({ body: { items: [], nextCursor: null } }),
      'GET /v1/inventory/items/:id': () => ({
        body: {
          item: {
            ...pump,
            description: null,
            categoryId: null,
            barcode: null,
            defaultUnitCost: null,
            salePrice: null,
            averageUnitCost: '140',
            preferredSupplierId: null,
            supplierPartNumber: null,
            leadTimeDays: 3,
            version: 2,
            createdAt: '2026-10-01T09:00:00.000Z',
            updatedAt: '2026-10-01T09:00:00.000Z',
            archivedAt: null,
          },
          stock: [],
          onHand: '0',
          reserved: '0',
          available: '0',
          can: { manage: true, move: true },
        },
      }),
      'PATCH /v1/inventory/items/:id': () => ({ body: {} }),
    });
    renderScreen(<ItemScreen itemId={PUMP} />, client);

    expect(await screen.findByRole('link', { name: 'Bill of materials' })).toHaveAttribute(
      'href',
      `/manufacturing/boms/${PUMP}`,
    );
    expect(screen.getByText('3 days')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit' });
    await user.clear(within(form).getByLabelText('Lead time (days)'));
    await user.type(within(form).getByLabelText('Lead time (days)'), '5');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'PATCH')).toBe(true));
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({
      expectedVersion: 2,
      leadTimeDays: 5,
    });
  });
});

describe('bills of materials', { timeout: 20_000 }, () => {
  it('lists bills by item, and starts one for another item', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/manufacturing/boms': () => ({
        body: {
          items: [
            {
              id: BOM,
              item: { id: PUMP, sku: 'PMP-1', name: 'Pump unit' },
              version: 2,
              components: 2,
              createdAt: '2026-10-01T09:00:00.000Z',
            },
          ],
          total: 1,
        },
      }),
      'GET /v1/inventory/items': () => ({
        body: {
          items: [
            {
              ...motor,
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
              onHand: '3',
            },
          ],
          nextCursor: null,
        },
      }),
    });
    const { container, navigate } = renderScreen(<BomListScreen />, client);

    expect(await screen.findByRole('link', { name: 'Pump unit' })).toHaveAttribute(
      'href',
      `/manufacturing/boms/${PUMP}`,
    );
    expect(screen.getByText('2 components')).toBeInTheDocument();
    expect(screen.getByText('Version 2')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.type(screen.getByLabelText('Search by SKU or name'), 'pump');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(calls.some((call) => call.query.get('q') === 'pump')).toBe(true));

    await user.click(screen.getByRole('button', { name: 'New bill of materials' }));
    const dialog = await screen.findByRole('dialog', { name: 'New bill of materials' });
    await user.type(within(dialog).getByLabelText('Item to build'), 'mot');
    await user.click(within(dialog).getByRole('button', { name: 'Search' }));
    await user.click(await within(dialog).findByRole('button', { name: /Motor/u }));
    await user.click(within(dialog).getByRole('button', { name: 'Open its bill' }));
    expect(navigate).toHaveBeenCalledWith(`/manufacturing/boms/${MOTOR}`);
  });

  it('shows the bill in use with its costs, and saves a new version', async () => {
    const user = userEvent.setup();
    let current = itemBom();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/settings': settings,
      'GET /v1/inventory/items/:id': () => ({ status: 404, body: undefined }),
      'GET /v1/manufacturing/orders': () => ({
        body: { items: [order()], nextCursor: null, statuses: ['draft', 'completed', 'cancelled'] },
      }),
      'GET /v1/manufacturing/boms/items/:itemId': () => ({ body: current }),
      'GET /v1/inventory/items': () => ({
        body: {
          items: [
            {
              ...seal,
              description: null,
              categoryId: null,
              barcode: null,
              defaultUnitCost: '3',
              salePrice: null,
              averageUnitCost: '0',
              preferredSupplierId: null,
              supplierPartNumber: null,
              leadTimeDays: null,
              version: 1,
              createdAt: '2026-10-01T09:00:00.000Z',
              updatedAt: '2026-10-01T09:00:00.000Z',
              archivedAt: null,
              onHand: '0',
            },
          ],
          nextCursor: null,
        },
      }),
      'PUT /v1/manufacturing/boms/items/:itemId': (call) => {
        const body = call.body as { components: { itemId: string }[] };
        if (body.components.some((component) => component.itemId === SEAL)) {
          current = itemBom(bom({ version: 3 }));
          return { body: current.current };
        }
        return apiError(422, 'contains_itself', 'An item cannot be built from itself.');
      },
    });
    const { container } = renderScreen(<BomScreen itemId={PUMP} />, client);

    expect(await screen.findByRole('heading', { name: 'Pump unit' })).toBeInTheDocument();
    const components = screen.getByRole('table');
    expect(within(components).getByRole('cell', { name: '2.5 each' })).toBeInTheDocument();
    // 2.5 × 10, worked in decimal strings.
    expect(within(components).getByText('EGP 25.00')).toBeInTheDocument();
    expect(within(components).getByText('EGP 145.00')).toBeInTheDocument();
    expect(screen.getByText('Superseded')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'AO-000007' })).toHaveAttribute(
      'href',
      `/manufacturing/orders/${ORDER}`,
    );
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Save a new version' }));
    const form = screen.getByRole('form', { name: 'Save a new version' });
    const second = within(form).getByRole('listitem', { name: 'Component 2' });
    await user.clear(within(second).getByLabelText('Quantity per unit'));
    await user.type(within(second).getByLabelText('Quantity per unit'), '3');
    await user.clear(within(form).getByLabelText('Labour per unit'));
    await user.type(within(form).getByLabelText('Labour per unit'), '17.5');

    // The server's refusal, in words.
    await user.click(within(form).getByRole('button', { name: 'Save version' }));
    expect(
      await within(form).findByText(
        'An item cannot be built from itself, or from anything built from it.',
      ),
    ).toBeInTheDocument();

    await user.click(within(form).getByRole('button', { name: 'Add a component' }));
    const third = within(form).getByRole('listitem', { name: 'Component 3' });
    await user.type(within(third).getByLabelText('Component'), 'seal');
    await user.click(within(third).getByRole('button', { name: 'Search' }));
    await user.click(await within(third).findByRole('button', { name: /Seal kit/u }));
    await user.type(within(third).getByLabelText('Quantity per unit'), '1');
    expect(await accessibilityViolations(container)).toEqual([]);
    await user.click(within(form).getByRole('button', { name: 'Save version' }));

    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Save a new version' })).not.toBeInTheDocument(),
    );
    const puts = calls.filter((call) => call.method === 'PUT');
    expect(puts.at(-1)!.body).toEqual({
      components: [
        { itemId: MOTOR, quantity: '1' },
        { itemId: CASING, quantity: '3' },
        { itemId: SEAL, quantity: '1' },
      ],
      labourCost: '17.5',
      overheadCost: '5',
      note: 'Torque the casing bolts.',
    });
    // The picker for components offers stock and non-stock items, never services.
    const search = calls.find((call) => call.path === '/v1/inventory/items')!;
    expect(search.query.getAll('kind')).toEqual(['stock_item', 'non_stock_item']);
  });

  it('retires a bill after asking', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/settings': settings,
      'GET /v1/inventory/items/:id': () => ({ status: 404, body: undefined }),
      'GET /v1/manufacturing/orders': () => ({
        body: { items: [], nextCursor: null, statuses: [] },
      }),
      'GET /v1/manufacturing/boms/items/:itemId': () => ({
        body: itemBom(bom({ components: [{ item: motor, quantity: '1', unitCost: '100' }] })),
      }),
      'DELETE /v1/manufacturing/boms/items/:itemId': () => ({ status: 204 }),
    });
    renderScreen(<BomScreen itemId={PUMP} />, client);

    await user.click(await screen.findByRole('button', { name: 'Retire' }));
    await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true));
    expect(calls.find((call) => call.method === 'DELETE')!.path).toBe(
      `/v1/manufacturing/boms/items/${PUMP}`,
    );
  });

  it('opens an earlier version from the history, read-only', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/settings': settings,
      'GET /v1/inventory/items/:id': () => ({ status: 404, body: undefined }),
      'GET /v1/manufacturing/orders': () => ({
        body: { items: [], nextCursor: null, statuses: [] },
      }),
      'GET /v1/manufacturing/boms/items/:itemId': () => ({ body: itemBom() }),
      'GET /v1/manufacturing/boms/:bomId': () => ({
        body: bom({
          id: OLD_BOM,
          version: 1,
          superseded: true,
          components: [{ item: motor, quantity: '2', unitCost: '100' }],
          unitCost: '220',
        }),
      }),
    });
    const first = renderScreen(<BomScreen itemId={PUMP} />, client);
    const versions = await screen.findByRole('region', { name: 'Versions' });
    await user.click(within(versions).getByRole('link', { name: 'Version 1' }));
    expect(first.navigate).toHaveBeenCalledWith(`/manufacturing/boms/versions/${OLD_BOM}`);
    first.unmount();

    const { container } = renderScreen(<BomVersionScreen bomId={OLD_BOM} />, client);
    expect(
      await screen.findByRole('heading', { name: 'Pump unit, version 1' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Superseded')).toBeInTheDocument();
    expect(screen.getByText(/An earlier version, kept for the orders/u)).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '2 each' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the bill in use' })).toHaveAttribute(
      'href',
      `/manufacturing/boms/${PUMP}`,
    );
    expect(screen.queryByRole('button', { name: 'Save a new version' })).toBeNull();
    expect(calls.some((call) => call.path === `/v1/manufacturing/boms/${OLD_BOM}`)).toBe(true);
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('shows a viewer the bill without costs or actions', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(VIEWER),
      'GET /v1/settings': settings,
      'GET /v1/inventory/items/:id': () => ({ status: 404, body: undefined }),
      'GET /v1/manufacturing/orders': () => ({
        body: { items: [], nextCursor: null, statuses: [] },
      }),
      'GET /v1/manufacturing/boms/items/:itemId': () => ({
        body: itemBom(
          bom({
            labourCost: null,
            overheadCost: null,
            unitCost: null,
            components: [
              { item: motor, quantity: '1', unitCost: null },
              { item: casing, quantity: '2.5', unitCost: null },
            ],
          }),
        ),
      }),
    });
    const { container } = renderScreen(<BomScreen itemId={PUMP} />, client);

    expect(await screen.findByRole('heading', { name: 'Pump unit' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '2.5 each' })).toBeInTheDocument();
    expect(screen.queryByText('Unit cost')).not.toBeInTheDocument();
    expect(screen.queryByText('Cost of one unit')).not.toBeInTheDocument();
    expect(screen.queryByText(/EGP/u)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save a new version' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retire' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New assembly order' })).not.toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});

describe('assembly orders', { timeout: 20_000 }, () => {
  it('filters by status and number, and drafts an order from a bill', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/inventory/locations': locations,
      'GET /v1/manufacturing/orders': () => ({
        body: { items: [order()], nextCursor: null, statuses: ['draft', 'completed', 'cancelled'] },
      }),
      'GET /v1/manufacturing/boms': () => ({
        body: {
          items: [
            {
              id: BOM,
              item: { id: PUMP, sku: 'PMP-1', name: 'Pump unit' },
              version: 2,
              components: 2,
              createdAt: '2026-10-01T09:00:00.000Z',
            },
          ],
          total: 1,
        },
      }),
      'POST /v1/manufacturing/orders': () => ({ status: 201, body: order() }),
    });
    const { container, navigate } = renderScreen(<AssemblyOrderListScreen />, client);

    expect(await screen.findByRole('link', { name: 'AO-000007' })).toHaveAttribute(
      'href',
      `/manufacturing/orders/${ORDER}`,
    );
    expect(screen.getByText('4 each at Main store')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.type(screen.getByLabelText('Order number'), 'AO-7');
    await user.selectOptions(screen.getByLabelText('Status'), 'draft');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(
        calls.some(
          (call) =>
            call.path === '/v1/manufacturing/orders' &&
            call.query.get('q') === 'AO-7' &&
            call.query.get('status') === 'draft',
        ),
      ).toBe(true),
    );

    await user.click(screen.getByRole('button', { name: 'New assembly order' }));
    const dialog = await screen.findByRole('dialog', { name: 'New assembly order' });
    await user.click(within(dialog).getByRole('radio', { name: 'Disassemble' }));
    await user.type(within(dialog).getByLabelText('Item'), 'pump');
    await user.click(within(dialog).getByRole('button', { name: 'Search' }));
    await user.click(await within(dialog).findByRole('button', { name: /Pump unit/u }));
    await user.selectOptions(within(dialog).getByLabelText('Location'), STORE);
    await user.type(within(dialog).getByLabelText('Quantity'), '2.5');
    await user.type(within(dialog).getByLabelText('Planned for'), '2026-10-20');
    expect(await accessibilityViolations(container)).toEqual([]);
    await user.click(within(dialog).getByRole('button', { name: 'Draft order' }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/manufacturing/orders/${ORDER}`));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      direction: 'disassemble',
      itemId: PUMP,
      locationId: STORE,
      quantity: '2.5',
      plannedFor: '2026-10-20',
    });
  });

  it('shows what is short, moves to the current bill and changes the draft', async () => {
    const user = userEvent.setup();
    let current = order({ bom: { id: OLD_BOM, version: 1, current: false } });
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/settings': settings,
      'GET /v1/inventory/locations': locations,
      'GET /v1/manufacturing/orders/:id': () => ({ body: current }),
      'PATCH /v1/manufacturing/orders/:id': (call) => {
        const body = call.body as { useCurrentBill?: boolean; quantity?: string };
        current = order({
          version: current.version + 1,
          ...(body.useCurrentBill === true ? {} : { bom: current.bom }),
          ...(body.quantity === undefined ? {} : { quantity: body.quantity }),
        });
        return { body: current };
      },
    });
    const { container } = renderScreen(<AssemblyOrderScreen orderId={ORDER} />, client);

    expect(await screen.findByRole('heading', { name: /AO-000007/u })).toBeInTheDocument();
    expect(screen.getByText('Short by 2 each')).toBeInTheDocument();
    expect(screen.getByText('Enough')).toBeInTheDocument();
    expect(
      screen.getByText('There is not enough stock at this location to complete it yet.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Complete' })).toBeDisabled();
    expect(
      screen.getByText(
        'A newer bill of materials is in use. This order still builds from version 1.',
      ),
    ).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Use the current bill' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Use the current bill' }),
      ).not.toBeInTheDocument(),
    );
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({
      expectedVersion: 3,
      useCurrentBill: true,
    });

    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit' });
    await user.clear(within(form).getByLabelText('Quantity'));
    await user.type(within(form).getByLabelText('Quantity'), '3');
    await user.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(calls.filter((call) => call.method === 'PATCH')).toHaveLength(2));
    expect(calls.filter((call) => call.method === 'PATCH')[1]!.body).toEqual({
      expectedVersion: 4,
      quantity: '3',
    });
  });

  it('says what was short when completing is refused, and cancels', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let current = order({
      needs: [
        { item: motor, quantity: '4', onHand: '6', reserved: '0', available: '6', short: '0' },
        { item: casing, quantity: '10', onHand: '12', reserved: '0', available: '12', short: '0' },
      ],
      can: { edit: true, complete: true, cancel: true },
    });
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/settings': settings,
      'GET /v1/inventory/locations': locations,
      'GET /v1/manufacturing/orders/:id': () => ({ body: current }),
      'POST /v1/manufacturing/orders/:id/complete': () => {
        // Somebody took casings meanwhile.
        current = order();
        return apiError(409, 'shortage', 'There is not enough stock.', [
          {
            field: `items.${CASING}`,
            code: 'shortage',
            message: 'Casing is short by 2.',
            params: { itemId: CASING, item: 'Casing', short: '2', needed: '10', available: '8' },
          },
        ]);
      },
      'POST /v1/manufacturing/orders/:id/cancel': () => {
        current = order({
          status: 'cancelled',
          needs: [],
          cancelledBy: person,
          cancelledAt: '2026-10-03T09:00:00.000Z',
          can: { edit: false, complete: false, cancel: false },
        });
        return { body: current };
      },
    });
    renderScreen(<AssemblyOrderScreen orderId={ORDER} />, client);

    await user.click(await screen.findByRole('button', { name: 'Complete' }));
    const alert = await screen.findByText(
      'There is not enough stock at this location to complete it. Nothing was moved.',
    );
    expect(
      await within(alert.closest('[role="alert"]')!).findByText(
        'Casing: needs 10 each, 8 each available, short by 2 each.',
      ),
    ).toBeInTheDocument();
    expect(calls.find((call) => call.path.endsWith('/complete'))!.body).toEqual({
      expectedVersion: 3,
    });

    await user.click(screen.getByRole('button', { name: 'Cancel order' }));
    expect(await screen.findByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument();
  });

  it('shows a completed order its costs, and hides them from a viewer', async () => {
    const completed = order({
      status: 'completed',
      needs: [],
      unitCost: '145',
      labourCost: '15',
      overheadCost: '5',
      completedBy: person,
      completedAt: '2026-10-03T09:00:00.000Z',
      can: { edit: false, complete: false, cancel: false },
    });
    const managerApi = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/settings': settings,
      'GET /v1/inventory/locations': locations,
      'GET /v1/manufacturing/orders/:id': () => ({ body: completed }),
    });
    const first = renderScreen(<AssemblyOrderScreen orderId={ORDER} />, managerApi.client);
    // 4 × 145.
    expect(await screen.findByText('EGP 580.00')).toBeInTheDocument();
    expect(screen.getByText('What it made')).toBeInTheDocument();
    first.unmount();

    const viewerApi = fakeApi({
      'GET /v1/me': me(VIEWER),
      'GET /v1/settings': settings,
      'GET /v1/inventory/locations': locations,
      'GET /v1/manufacturing/orders/:id': () => ({
        body: { ...completed, unitCost: null, labourCost: null, overheadCost: null },
      }),
    });
    const { container } = renderScreen(<AssemblyOrderScreen orderId={ORDER} />, viewerApi.client);
    expect(await screen.findByRole('heading', { name: /AO-000007/u })).toBeInTheDocument();
    expect(screen.queryByText('Costs')).not.toBeInTheDocument();
    expect(screen.queryByText(/EGP/u)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});

describe('material planning', { timeout: 20_000 }, () => {
  it('runs a plan for the days asked', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/manufacturing/plans': () => ({
        body: {
          items: [
            {
              id: PLAN,
              horizonEnd: '2026-11-11',
              runBy: person,
              runAt: '2026-10-12T08:00:00.000Z',
            },
          ],
        },
      }),
      'POST /v1/manufacturing/plans': () => ({ status: 201, body: plan() }),
    });
    const { container, navigate } = renderScreen(<MaterialPlanListScreen />, client);

    expect(
      await screen.findByRole('link', { name: 'Plan up to November 11, 2026' }),
    ).toHaveAttribute('href', `/manufacturing/plans/${PLAN}`);
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.clear(screen.getByLabelText('Days ahead'));
    await user.type(screen.getByLabelText('Days ahead'), '14');
    await user.click(screen.getByRole('button', { name: 'Run a plan' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/manufacturing/plans/${PLAN}`));
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ horizonDays: 14 });
  });

  it('groups suggestions by level, and drafts the chosen ones', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/inventory/locations': locations,
      'GET /v1/manufacturing/plans/:id': () => ({ body: plan() }),
      'POST /v1/manufacturing/plans/:id/draft': () => ({
        body: {
          assemblyOrders: [{ id: ORDER, reference: 'AO-000007' }],
          purchaseOrders: [{ id: PO, reference: 'PO-000003' }],
          plan: plan({
            suggestions: [
              {
                ...buyMotor,
                drafted: {
                  kind: 'purchase_order',
                  id: PO,
                  reference: 'PO-000003',
                  at: '2026-10-12T09:00:00.000Z',
                },
              },
              {
                ...buildPump,
                drafted: {
                  kind: 'assembly_order',
                  id: ORDER,
                  reference: 'AO-000007',
                  at: '2026-10-12T09:00:00.000Z',
                },
              },
              buyCasing,
            ],
          }),
        },
      }),
    });
    const { container } = renderScreen(<MaterialPlanScreen planId={PLAN} />, client);

    const levelZero = await screen.findByRole('region', { name: 'Level 0' });
    const levelOne = screen.getByRole('region', { name: 'Level 1' });
    expect(within(levelZero).getByRole('link', { name: 'Pump unit' })).toBeInTheDocument();
    expect(within(levelZero).getByText('Sales orders: 12 each')).toBeInTheDocument();
    expect(within(levelOne).getByText('Late by 4 days')).toBeInTheDocument();
    expect(within(levelOne).getByText('7 days')).toBeInTheDocument();
    expect(within(levelOne).getByText('On order: 1 each')).toBeInTheDocument();
    expect(within(levelOne).getByText('Reorder level: 2 each')).toBeInTheDocument();
    expect(within(levelOne).getByText('Builds of what uses it: 10 each')).toBeInTheDocument();
    // Ordered by when to order: the motor before the casing.
    const rows = within(levelOne).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('Motor')).toBeInTheDocument();
    // No supplier: it cannot be chosen, and says why.
    expect(within(levelOne).getByRole('checkbox', { name: 'Choose Casing' })).toBeDisabled();
    expect(within(levelOne).getByText('Needs a preferred supplier')).toBeInTheDocument();
    expect(screen.getByText(/Some items to buy have no preferred supplier/u)).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('checkbox', { name: 'Choose Pump unit' }));
    await user.click(screen.getByRole('checkbox', { name: 'Choose Motor' }));
    expect(screen.getByText('2 chosen')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Draft orders' })).toBeDisabled();
    await user.selectOptions(screen.getByLabelText('Build at and deliver to'), STORE);
    await user.click(screen.getByRole('button', { name: 'Draft orders' }));

    const drafted = await screen.findByRole('region', { name: 'Orders drafted' });
    expect(within(drafted).getByRole('link', { name: 'AO-000007' })).toHaveAttribute(
      'href',
      `/manufacturing/orders/${ORDER}`,
    );
    expect(within(drafted).getByRole('link', { name: 'PO-000003' })).toHaveAttribute(
      'href',
      `/purchasing/orders/${PO}`,
    );
    // Each drafted row names its order, and opens it.
    const motorRow = within(screen.getByRole('region', { name: 'Level 1' }))
      .getAllByRole('row')
      .find((row) => within(row).queryByText('Motor') !== null)!;
    expect(within(motorRow).getByText('Purchase order drafted')).toBeInTheDocument();
    expect(within(motorRow).getByRole('link', { name: 'PO-000003' })).toHaveAttribute(
      'href',
      `/purchasing/orders/${PO}`,
    );
    expect(screen.getByRole('checkbox', { name: 'Choose Pump unit' })).toBeDisabled();
    const body = calls.find((call) => call.method === 'POST')!.body as {
      suggestionIds: string[];
      locationId: string;
    };
    expect(body.locationId).toBe(STORE);
    expect([...body.suggestionIds].sort()).toEqual([buildPump.id, buyMotor.id].sort());
  });

  it('lets a seat without purchasing rights draft builds only, and says why', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(STOREKEEPER),
      'GET /v1/inventory/locations': locations,
      'GET /v1/manufacturing/plans/:id': () => ({
        body: plan({ can: { draftAssemblies: true, draftPurchases: false } }),
      }),
    });
    renderScreen(<MaterialPlanScreen planId={PLAN} />, client);

    expect(
      await screen.findByText(/but not purchase orders: buying needs purchasing rights/u),
    ).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Choose Motor' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Choose Pump unit' })).toBeEnabled();
    expect(screen.getAllByText('Needs purchasing rights').length).toBeGreaterThan(0);
  });

  it('says plainly when a buy has no supplier after all', async () => {
    const user = userEvent.setup();
    const { client } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/inventory/locations': locations,
      'GET /v1/manufacturing/plans/:id': () => ({ body: plan() }),
      'POST /v1/manufacturing/plans/:id/draft': () =>
        apiError(422, 'no_supplier', 'Give each item to buy a preferred supplier first.'),
    });
    renderScreen(<MaterialPlanScreen planId={PLAN} />, client);

    await user.click(await screen.findByRole('checkbox', { name: 'Choose Motor' }));
    await user.selectOptions(screen.getByLabelText('Build at and deliver to'), STORE);
    await user.click(screen.getByRole('button', { name: 'Draft orders' }));
    expect(
      await screen.findByText(
        'An item to buy has no preferred supplier. Give it one, or order it by hand from purchasing.',
      ),
    ).toBeInTheDocument();
  });

  it('shows a viewer the plan with nothing to choose', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(VIEWER),
      'GET /v1/inventory/locations': locations,
      'GET /v1/manufacturing/plans/:id': () => ({
        body: plan({ can: { draftAssemblies: false, draftPurchases: false } }),
      }),
    });
    const { container } = renderScreen(<MaterialPlanScreen planId={PLAN} />, client);

    expect(
      await screen.findByText(
        'You can read this plan. Drafting orders from it needs manufacturing rights.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Draft orders' })).not.toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});
