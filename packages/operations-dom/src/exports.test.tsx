import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LeadListScreen } from './crm/lead-list.js';
import { OpportunityBoardScreen } from './crm/opportunity-board.js';
import { StockMovementsExportButton } from './exports.js';
import { apiError, fakeApi, renderScreen } from './testing/render.js';

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const PIPELINE = '00000000-0000-4000-8000-000000000b01';

const me = (permissions: string[]) => () => ({
  body: {
    userId: USER,
    tenantId: TENANT,
    email: 'd@x.example',
    displayName: 'Dee',
    role: 'dispatcher',
    permissions,
    features: { crm: true, inventory: true },
  },
});
const empty = () => ({ body: { items: [], nextCursor: null } });
const pipelines = () => ({
  body: {
    items: [
      {
        id: PIPELINE,
        name: 'Sales',
        isDefault: true,
        stages: [
          {
            id: '00000000-0000-4000-8000-00000000c000',
            key: 'new',
            label: 'New',
            position: 1,
            probabilityBp: 1000,
            outcome: 'open',
            archived: false,
          },
        ],
      },
    ],
  },
});

describe('CSV exports', { timeout: 20_000 }, () => {
  it('offers the leads export only to a seat that manages leads', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(['crm.read']),
      'GET /v1/members': empty,
      'GET /v1/crm/leads': empty,
    });
    renderScreen(<LeadListScreen />, client);
    expect(
      await screen.findByText('No leads yet. Add the first prospect you are talking to.'),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Download CSV' })).toBeNull();
  });

  it('downloads the leads with the list’s filters, and says when the file was cut short', async () => {
    const user = userEvent.setup();
    const download = vi.fn();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(['crm.read', 'crm.lead.manage']),
      'GET /v1/members': empty,
      'GET /v1/crm/leads': empty,
      'GET /v1/crm/leads.csv': () => ({
        text: 'Id,Name\n1,Nour\n',
        headers: { 'x-export-truncated': 'true' },
      }),
    });
    renderScreen(<LeadListScreen />, client, { download });

    await user.selectOptions(await screen.findByLabelText('Status'), 'qualified');
    await user.selectOptions(screen.getByLabelText('Source'), 'referral');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await user.click(screen.getByRole('button', { name: 'Download CSV' }));

    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    const [blob, filename] = download.mock.calls[0] as [Blob, string];
    expect(filename).toBe('leads.csv');
    expect(await blob.text()).toBe('Id,Name\n1,Nour\n');
    const asked = calls.find((call) => call.path === '/v1/crm/leads.csv')!;
    expect(asked.query.getAll('status')).toEqual(['qualified']);
    expect(asked.query.getAll('source')).toEqual(['referral']);
    expect(
      await screen.findByText(
        'The file stops at 50,000 rows: more matched. Narrow the filters to download the rest.',
      ),
    ).toBeVisible();
  });

  it('offers the opportunities export to whoever manages them, for the board’s pipeline', async () => {
    const user = userEvent.setup();
    const download = vi.fn();
    const routes = {
      'GET /v1/members': empty,
      'GET /v1/crm/pipelines': pipelines,
      'GET /v1/crm/opportunities': empty,
      'GET /v1/crm/opportunities.csv': () => ({ text: 'Id\n' }),
    };
    const reader = fakeApi({ ...routes, 'GET /v1/me': me(['crm.read']) });
    const first = renderScreen(<OpportunityBoardScreen />, reader.client);
    expect(await screen.findByRole('link', { name: 'Pipelines' })).toHaveAttribute(
      'href',
      '/crm/pipelines',
    );
    expect(screen.queryByRole('button', { name: 'Download CSV' })).toBeNull();
    first.unmount();

    const { client, calls } = fakeApi({
      ...routes,
      'GET /v1/me': me(['crm.read', 'crm.opportunity.manage']),
    });
    renderScreen(<OpportunityBoardScreen />, client, { download });
    await user.click(await screen.findByRole('button', { name: 'Download CSV' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(download.mock.calls[0]![1]).toBe('opportunities.csv');
    const asked = calls.find((call) => call.path === '/v1/crm/opportunities.csv')!;
    expect(asked.query.get('pipelineId')).toBe(PIPELINE);
    expect(asked.query.getAll('status')).toEqual(['open']);
    // A whole file: nothing to say about rows.
    expect(screen.queryByText(/The file stops at/u)).toBeNull();
  });

  it('shows the stock movements export only to whoever moves stock, and says why it failed', async () => {
    const user = userEvent.setup();
    const reader = fakeApi({ 'GET /v1/me': me(['inventory.read']) });
    const first = renderScreen(<StockMovementsExportButton />, reader.client);
    await waitFor(() => expect(reader.calls.some((call) => call.path === '/v1/me')).toBe(true));
    expect(screen.queryByRole('button')).toBeNull();
    first.unmount();

    const { client } = fakeApi({
      'GET /v1/me': me(['inventory.read', 'inventory.move']),
      'GET /v1/inventory/movements.csv': () => apiError(403, 'forbidden', 'Not yours.'),
    });
    renderScreen(<StockMovementsExportButton filters={{ from: '2026-10-01' }} />, client);
    await user.click(await screen.findByRole('button', { name: 'Download stock movements (CSV)' }));
    const alert = await screen.findByRole('alert');
    expect(alert).not.toHaveTextContent('Not yours.');
  });
});
