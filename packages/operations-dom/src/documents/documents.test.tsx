import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentDetail } from '../api.js';
import { accessibilityViolations, fakeApi, renderScreen } from '../testing/render.js';
import { DocumentListScreen } from './document-list.js';
import { DocumentScreen } from './document-screen.js';

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const DOCUMENT = '00000000-0000-4000-8000-00000000d001';
const TEMPLATE = '00000000-0000-4000-8000-00000000d101';
const SUBMISSION = '00000000-0000-4000-8000-00000000d201';
const FORM = '00000000-0000-4000-8000-00000000d301';

const me = (permissions: string[]) => () => ({
  body: {
    userId: USER,
    tenantId: TENANT,
    email: 'd@x.example',
    displayName: 'Dee',
    role: 'admin',
    permissions,
    features: { documents: true },
    company: { name: 'Nile Gas', slug: 'nile' },
  },
});

const document = (overrides: Partial<DocumentDetail> = {}): DocumentDetail => ({
  id: DOCUMENT,
  title: 'Gas certificate · GS-2026-0042',
  templateId: TEMPLATE,
  templateRevision: 2,
  submissionId: SUBMISSION,
  formId: FORM,
  status: 'ready',
  failureCode: null,
  linkOpens: true,
  link: 'https://app.example.com/d/abcdefghijklmnopqrstuv',
  publicCode: 'abcdefghijklmnopqrstuv',
  pageCount: 2,
  byteSize: 84_000,
  renderedAt: '2026-10-16T09:00:05.000Z',
  expiredAt: null,
  expiresAt: null,
  createdBy: { id: USER, name: 'Dee' },
  createdAt: '2026-10-16T09:00:00.000Z',
  fields: [
    {
      key: 'certificate',
      label: { en: 'Certificate number', ar: 'رقم الشهادة' },
      value: 'GS-2026-0042',
      lookupRole: 'key',
    },
    { key: 'customer', label: { en: 'Customer' }, value: 'Nile Towers', lookupRole: null },
  ],
  ...overrides,
});

describe('the documents register', () => {
  it('lists documents with their state and fields, and searches one field', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(['document.read']),
      'GET /v1/documents': () => ({ body: { items: [document()], nextCursor: null } }),
    });
    const { container } = renderScreen(<DocumentListScreen />, client);
    const link = await screen.findByRole('link', { name: 'Gas certificate · GS-2026-0042' });
    expect(link).toHaveAttribute('href', `/documents/${DOCUMENT}`);
    const item = screen.getByRole('listitem');
    expect(within(item).getByText('Link open')).toBeInTheDocument();
    expect(within(item).getByText('GS-2026-0042')).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.type(screen.getByLabelText('Search'), 'gs-2026');
    await user.selectOptions(screen.getByLabelText('Search in'), 'certificate');
    await user.selectOptions(screen.getByLabelText('State'), 'active');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => {
      const last = calls.filter((call) => call.path === '/v1/documents').at(-1)!;
      expect(last.query.get('q')).toBe('gs-2026');
      expect(last.query.get('fieldKey')).toBe('certificate');
      expect(last.query.get('state')).toBe('active');
    });
  });

  it('says so when there are none yet', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(['document.read']),
      'GET /v1/documents': () => ({ body: { items: [], nextCursor: null } }),
    });
    renderScreen(<DocumentListScreen />, client);
    expect(
      await screen.findByText('No documents yet. Open a submission and choose Make PDF.'),
    ).toBeInTheDocument();
  });
});

describe('one document', () => {
  it('opens the PDF, copies the link, and stops it for a manager', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { client, calls } = fakeApi({
      'GET /v1/me': me(['document.read', 'document.manage']),
      'GET /v1/documents/:id': () => ({ body: document() }),
      'GET /v1/documents/:id/file': (call) => ({
        body: {
          url: `https://files.example/${call.query.get('disposition') ?? ''}`,
          expiresAt: '2026-10-16T09:05:00.000Z',
        },
      }),
      'POST /v1/documents/:id/expire': () => ({
        body: document({ linkOpens: false, expiredAt: '2026-10-16T10:00:00.000Z' }),
      }),
    });
    const { container } = renderScreen(<DocumentScreen documentId={DOCUMENT} />, client);
    expect(
      await screen.findByRole('heading', { name: /Gas certificate · GS-2026-0042/u }),
    ).toBeInTheDocument();
    expect(screen.getByText('Website search')).toBeInTheDocument();
    expect(
      screen.getByText('https://app.example.com/d/abcdefghijklmnopqrstuv'),
    ).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Download' }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith('https://files.example/attachment', '_blank', 'noopener'),
    );

    await user.click(await screen.findByRole('button', { name: 'Stop the link' }));
    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith('/expire'))?.body).toEqual({ expired: true }),
    );
    expect(await screen.findByRole('button', { name: 'Open the link again' })).toBeInTheDocument();
    expect(screen.getByText('Link stopped')).toBeInTheDocument();
    open.mockRestore();
  });

  it('shows why a document failed, and offers no link', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(['document.read']),
      'GET /v1/documents/:id': () => ({
        body: document({
          status: 'failed',
          failureCode: 'renderer_unavailable',
          linkOpens: false,
          pageCount: null,
          byteSize: null,
        }),
      }),
    });
    renderScreen(<DocumentScreen documentId={DOCUMENT} />, client);
    expect(
      await screen.findByText('This server cannot make PDFs at the moment. Ask Integr8.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View' })).not.toBeInTheDocument();
    expect(screen.queryByText('QR code link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('deletes after asking, and goes back to the register', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(['document.read', 'document.manage']),
      'GET /v1/documents/:id': () => ({ body: document() }),
      'DELETE /v1/documents/:id': () => ({ status: 204 }),
    });
    const { navigate } = renderScreen(<DocumentScreen documentId={DOCUMENT} />, client);
    await user.click(await screen.findByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this document?' });
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith('/documents', { replace: true }));
    expect(calls.some((call) => call.method === 'DELETE')).toBe(true);
  });
});
