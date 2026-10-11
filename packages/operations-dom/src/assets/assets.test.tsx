import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AssetDetail, AssetRow, AssetTimelineEntry, JobAssets } from '../api.js';
import { accessibilityViolations, fakeApi, renderScreen } from '../testing/render.js';
import { AssetListScreen } from './asset-list.js';
import { AssetScreen } from './asset-screen.js';
import { JobAssetsPanel } from './job-assets.js';

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const CUSTOMER = '00000000-0000-4000-8000-00000000c001';
const SITE = '00000000-0000-4000-8000-00000000c101';
const ASSET = '00000000-0000-4000-8000-00000000a501';
const OTHER = '00000000-0000-4000-8000-00000000a502';
const JOB = '00000000-0000-4000-8000-00000000b001';

const me =
  (permissions: string[], features: Record<string, boolean> = { assets: true }) =>
  () => ({
    body: {
      userId: USER,
      tenantId: TENANT,
      email: 'd@x.example',
      displayName: 'Dee',
      role: 'dispatcher',
      permissions,
      features,
      company: { name: 'Riverside Services', slug: 'riverside' },
    },
  });
const MANAGE = ['asset.read', 'asset.record', 'asset.manage', 'customer.read'];
const ENGINEER = ['asset.read', 'asset.record', 'customer.read'];

const row = (overrides: Partial<AssetRow> = {}): AssetRow => ({
  id: ASSET,
  reference: 'AS-000012',
  name: 'Boiler',
  make: 'Vaillant',
  model: 'ecoTEC',
  serialNumber: 'SN-4471',
  status: 'active',
  condition: 'poor',
  customer: { id: CUSTOMER, name: 'Riverside Housing' },
  site: { id: SITE, name: 'Block A' },
  locationNote: 'Plant room',
  warrantyExpiresOn: '2026-11-30',
  warranty: 'expiring',
  tagCode: '7K2M9P4QX8ZT',
  version: 3,
  ...overrides,
});

const detail = (overrides: Partial<AssetDetail> = {}): AssetDetail => ({
  asset: {
    ...row(),
    item: null,
    installDate: '2021-05-01',
    notes: null,
    conditionRecordedAt: '2026-10-10T09:00:00.000Z',
    conditionRecordedBy: { id: USER, name: 'Dee' },
    tagLink: 'https://app.example.com/a/7K2M9P4QX8ZT',
    createdBy: { id: USER, name: 'Dee' },
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-10T09:00:00.000Z',
    retiredAt: null,
    retiredBy: null,
  },
  workOrders: [],
  can: { edit: true, record: true, attach: true },
  ...overrides,
});

const entries: AssetTimelineEntry[] = [
  {
    kind: 'event',
    id: '00000000-0000-4000-8000-00000000e001',
    at: '2026-10-10T09:00:00.000Z',
    event: {
      kind: 'condition_recorded',
      fromSite: null,
      fromStatus: null,
      toStatus: null,
      condition: 'poor',
      changes: null,
      workOrderId: null,
      note: 'Flue corroded',
      by: { id: USER, name: 'Dee' },
    },
  },
  {
    kind: 'part',
    id: '00000000-0000-4000-8000-00000000e002',
    at: '2026-10-09T09:00:00.000Z',
    part: {
      item: {
        id: '00000000-0000-4000-8000-00000000f001',
        sku: 'VAL-1',
        name: 'Ball valve',
        kind: 'stock_item',
        unit: 'each',
      },
      quantity: '2',
      returnedQuantity: '0',
      workOrderId: JOB,
      explicit: false,
      by: { id: USER, name: 'Sam' },
    },
  },
  {
    kind: 'event',
    id: '00000000-0000-4000-8000-00000000e003',
    at: '2026-10-01T09:00:00.000Z',
    event: {
      kind: 'updated',
      fromSite: null,
      fromStatus: null,
      toStatus: null,
      condition: null,
      changes: { model: [null, 'ecoTEC'], serialNumber: [null, 'SN-4471'] },
      workOrderId: null,
      note: null,
      by: { id: USER, name: 'Dee' },
    },
  },
];

describe('assets', { timeout: 20_000 }, () => {
  it('lists assets with their status, condition and warranty, and filters them', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/assets': () => ({ body: { items: [row()], nextCursor: null } }),
    });
    const { container } = renderScreen(<AssetListScreen />, client);
    const link = await screen.findByRole('link', { name: /AS-000012/u });
    expect(link).toHaveAttribute('href', `/assets/${ASSET}`);
    const item = screen.getByRole('listitem');
    expect(within(item).getByText('In use')).toBeInTheDocument();
    expect(within(item).getByText('Condition: Poor')).toBeInTheDocument();
    expect(within(item).getByText('Warranty ending soon')).toBeInTheDocument();
    expect(within(item).getByText('S/N SN-4471')).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'New asset' })).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.selectOptions(screen.getByLabelText('Warranty'), 'expiring');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(calls.some((call) => call.query.get('warranty') === 'expiring')).toBe(true),
    );
  });

  it('shows an asset’s details and its history in words, and edits it', async () => {
    const user = userEvent.setup();
    let current = detail();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/assets/:id': () => ({ body: current }),
      'GET /v1/assets/:id/timeline': () => ({ body: { entries } }),
      'PATCH /v1/assets/:id': () => {
        current = detail({ asset: { ...detail().asset, model: 'ecoTEC plus', version: 4 } });
        return { body: current };
      },
    });
    const { container } = renderScreen(<AssetScreen assetId={ASSET} />, client);
    expect(await screen.findByRole('heading', { name: /AS-000012/u })).toBeInTheDocument();
    expect(screen.getByText('7K2M9P4QX8ZT')).toBeInTheDocument();
    expect(await screen.findByText('Condition recorded: Poor')).toBeInTheDocument();
    expect(screen.getByText('Flue corroded')).toBeInTheDocument();
    expect(screen.getByText('2 × Ball valve fitted')).toBeInTheDocument();
    expect(screen.getByText('Details changed: Model, Serial number')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Edit details' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit details' });
    const model = within(dialog).getByLabelText('Model');
    await user.clear(model);
    await user.type(model, 'ecoTEC plus');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.find((call) => call.method === 'PATCH')!.body).toMatchObject({
      expectedVersion: 3,
      name: 'Boiler',
      model: 'ecoTEC plus',
      notes: null,
    });
  });

  it('records a condition, and hides office actions from an engineer', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ENGINEER),
      'GET /v1/assets/:id': () => ({
        body: detail({ can: { edit: false, record: true, attach: true } }),
      }),
      'GET /v1/assets/:id/timeline': () => ({ body: { entries: [] } }),
      'POST /v1/assets/:id/condition': () => ({ body: detail() }),
    });
    renderScreen(<AssetScreen assetId={ASSET} />, client);
    await user.click(await screen.findByRole('button', { name: 'Record condition' }));
    expect(screen.queryByRole('button', { name: 'Edit details' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New tag' })).not.toBeInTheDocument();
    const dialog = await screen.findByRole('dialog', { name: 'Record condition' });
    await user.click(within(dialog).getByLabelText('Fair'));
    await user.type(within(dialog).getByLabelText('Note'), 'Serviced, running well');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith('/condition'))?.body).toEqual({
        condition: 'fair',
        note: 'Serviced, running well',
      }),
    );
  });

  it('links one of the site’s assets to a job', async () => {
    const user = userEvent.setup();
    let linked = false;
    const jobAssets = (): JobAssets => ({
      items: linked
        ? [row({ id: OTHER, reference: 'AS-000013', name: 'Pump', warranty: 'none' })]
        : [],
      atSite: linked
        ? []
        : [row({ id: OTHER, reference: 'AS-000013', name: 'Pump', warranty: 'none' })],
      can: { link: true, unlink: true, register: true },
    });
    const { client, calls } = fakeApi({
      'GET /v1/me': me(MANAGE),
      'GET /v1/work-orders/:id/assets': () => ({ body: jobAssets() }),
      'POST /v1/work-orders/:id/assets': () => {
        linked = true;
        return { status: 204 };
      },
    });
    const { container } = renderScreen(<JobAssetsPanel workOrderId={JOB} />, client);
    expect(await screen.findByText('No asset linked to this job.')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
    await user.selectOptions(screen.getByLabelText('Link an asset at this site'), OTHER);
    await user.click(screen.getByRole('button', { name: 'Link' }));
    expect(await screen.findByRole('link', { name: /AS-000013/u })).toBeInTheDocument();
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({ assetId: OTHER });
  });

  it('leaves the job screen as it was without the assets module', async () => {
    const { client, calls } = fakeApi({ 'GET /v1/me': me(MANAGE, { assets: false }) });
    const { container } = renderScreen(<JobAssetsPanel workOrderId={JOB} />, client);
    await waitFor(() => expect(calls.some((call) => call.path === '/v1/me')).toBe(true));
    expect(container).toBeEmptyDOMElement();
    expect(calls.some((call) => call.path.includes('/assets'))).toBe(false);
  });
});
