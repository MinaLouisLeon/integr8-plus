import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { JobPurchase, WorkOrderDetail } from '../api.js';
import { accessibilityViolations, fakeApi, renderScreen } from '../testing/render.js';
import { Parts } from './work-order-parts.js';

/** Parts bought from a merchant for a job, as the office sees them (ADR-0012). */

const USER = '00000000-0000-4000-8000-000000000401';
const OTHER = '00000000-0000-4000-8000-000000000402';
const TENANT = '00000000-0000-4000-8000-000000000301';
const JOB = '00000000-0000-4000-8000-00000000e101';
const PURCHASE = '00000000-0000-4000-8000-00000000e201';
const PURCHASE_2 = '00000000-0000-4000-8000-00000000e202';

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

/** Only what the parts section reads of a job. */
const job = {
  workOrder: { id: JOB },
  materials: [],
  materialsCost: null,
  can: { recordParts: false },
} as unknown as WorkOrderDetail;

const purchase = (overrides: Partial<JobPurchase> = {}): JobPurchase => ({
  id: PURCHASE,
  workOrderId: JOB,
  item: null,
  description: 'Copper elbow 15mm',
  merchant: 'Plumb Centre',
  quantity: '4',
  unitPrice: '12.5',
  note: null,
  recordedBy: { id: OTHER, name: 'Eve' },
  occurredAt: '2026-10-11T10:00:00.000Z',
  cancelledAt: null,
  receipts: [
    {
      id: '00000000-0000-4000-8000-00000000e301',
      fileId: '00000000-0000-4000-8000-00000000e401',
      title: 'Receipt',
      kind: 'photo',
      stage: null,
      contentType: 'image/jpeg',
      byteSize: 1024,
      addedBy: { id: OTHER, name: 'Eve' },
      createdAt: '2026-10-11T10:01:00.000Z',
    },
  ],
  ...overrides,
});

describe('bought for this job', { timeout: 20_000 }, () => {
  it('lists merchant parts with receipts and the total, and takes one off', async () => {
    const user = userEvent.setup();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let items = [
      purchase(),
      purchase({
        id: PURCHASE_2,
        description: 'Solder',
        merchant: null,
        unitPrice: null,
        cancelledAt: '2026-10-11T11:00:00.000Z',
        receipts: [],
      }),
    ];
    const { client, calls } = fakeApi({
      'GET /v1/me': me(['inventory.read', 'inventory.move']),
      'GET /v1/settings': () => ({ body: { currency: 'EGP', timezone: 'Africa/Cairo' } }),
      'GET /v1/work-orders/:id/purchases': () => ({ body: { items, total: '50' } }),
      'GET /v1/media/:id': () => ({ body: { url: 'https://files.test/r', thumbnailUrl: null } }),
      'POST /v1/work-orders/:id/purchases/:purchaseId/cancel': () => {
        items = items.map((row) =>
          row.id === PURCHASE ? { ...row, cancelledAt: '2026-10-12T09:00:00.000Z' } : row,
        );
        return { body: { items, total: '0' } };
      },
    });
    const { container } = renderScreen(<Parts job={job} onChanged={() => undefined} />, client);

    const list = await screen.findByRole('list', { name: 'Bought for this job' });
    expect(await screen.findByText('EGP 50.00')).toBeInTheDocument();
    // The purchases themselves, not the receipts listed inside them.
    const [elbow, solder] = within(list)
      .getAllByRole('listitem')
      .filter((item) => item.parentElement === list);
    expect(within(elbow!).getByText(/Copper elbow 15mm/u)).toHaveTextContent('EGP 12.50 each');
    expect(within(elbow!).getByText(/from Plumb Centre/u)).toBeInTheDocument();
    expect(within(elbow!).getByRole('img', { name: 'Receipt' })).toBeInTheDocument();
    expect(within(solder!).getByText('Taken off')).toBeInTheDocument();
    expect(within(solder!).queryByRole('button', { name: /Take/u })).not.toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(
      within(elbow!).getByRole('button', { name: 'Take Copper elbow 15mm off the job' }),
    );
    await waitFor(() =>
      expect(
        calls.some((call) => call.path === `/v1/work-orders/${JOB}/purchases/${PURCHASE}/cancel`),
      ).toBe(true),
    );
    expect(await screen.findByText('EGP 0.00')).toBeInTheDocument();
  });

  it('lets an engineer take off only what they recorded', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(['inventory.consume']),
      'GET /v1/settings': () => ({ body: { currency: 'EGP', timezone: 'Africa/Cairo' } }),
      'GET /v1/work-orders/:id/purchases': () => ({
        body: {
          items: [
            purchase({ recordedBy: { id: USER, name: 'Dee' }, receipts: [] }),
            purchase({ id: PURCHASE_2, description: 'Solder', unitPrice: null, receipts: [] }),
          ],
          total: null,
        },
      }),
    });
    renderScreen(<Parts job={job} onChanged={() => undefined} />, client);

    expect(
      await screen.findByRole('button', { name: 'Take Copper elbow 15mm off the job' }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Take Solder off the job' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/EGP/u, { selector: 'p *' })).not.toBeInTheDocument();
  });
});
