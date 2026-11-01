import { screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { DocumentDetail } from '../api.js';
import { accessibilityViolations, fakeApi, renderScreen } from '../testing/render.js';
import { BusinessPdfPanel } from './business-pdfs.js';

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const QUOTE = '00000000-0000-4000-8000-00000000e001';
const DOCUMENT = '00000000-0000-4000-8000-00000000e101';

const me = (features: Record<string, boolean>) => () => ({
  body: {
    userId: USER,
    tenantId: TENANT,
    email: 'd@x.example',
    displayName: 'Dee',
    role: 'dispatcher',
    permissions: ['sales.read', 'sales.manage', 'document.read'],
    features,
    company: { name: 'Nile Cooling', slug: 'nile' },
  },
});

const pdf = (overrides: Partial<DocumentDetail> = {}): DocumentDetail => ({
  id: DOCUMENT,
  title: 'Quote QT-000042',
  source: 'quote',
  reference: 'QT-000042',
  record: { kind: 'quote', id: QUOTE },
  customer: { id: '00000000-0000-4000-8000-00000000c001', name: 'Horizon' },
  shareable: false,
  templateId: null,
  templateRevision: null,
  submissionId: null,
  formId: null,
  status: 'ready',
  failureCode: null,
  linkOpens: true,
  link: 'https://app.example.com/d/abcdefghijklmnopqrstuv',
  publicCode: 'abcdefghijklmnopqrstuv',
  pageCount: 1,
  byteSize: 84_000,
  renderedAt: '2026-11-01T09:00:05.000Z',
  expiredAt: null,
  expiresAt: null,
  createdBy: { id: USER, name: 'Dee' },
  createdAt: '2026-11-01T09:00:00.000Z',
  fields: [],
  ...overrides,
});

const listed =
  (items: DocumentDetail[], can = { make: true, email: true, share: false }) =>
  () => ({
    body: { items, can, email: 'mona@horizon.example', language: 'ar' },
  });

describe('a record’s PDFs', () => {
  it('lists them, makes one in the company’s language, and emails a ready one', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me({ documents: true, sales: true }),
      'GET /v1/business-documents': listed([pdf()]),
      'POST /v1/business-documents': () => ({ status: 202, body: pdf({ status: 'pending' }) }),
      'POST /v1/business-documents/:id/email': () => ({ body: { sent: true, problem: null } }),
    });
    const { container } = renderScreen(<BusinessPdfPanel kind="quote" recordId={QUOTE} />, client);
    expect(await screen.findByText('Quote QT-000042')).toBeInTheDocument();
    expect(screen.getByText('Quote')).toBeInTheDocument();
    expect(
      screen.getByText(/Its QR code opens it only once sharing is switched on in Documents/u),
    ).toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Make PDF' }));
    const making = await screen.findByRole('dialog', { name: 'Make a PDF' });
    expect(within(making).getByLabelText('Language')).toHaveValue('ar');
    // Sharing is offered only to those who may share.
    expect(within(making).queryByRole('checkbox')).not.toBeInTheDocument();
    await user.click(within(making).getByRole('button', { name: 'Make PDF' }));
    await waitFor(() => {
      const made = calls.find(
        (call) => call.method === 'POST' && call.path === '/v1/business-documents',
      );
      expect(made?.body).toEqual({
        kind: 'quote',
        recordId: QUOTE,
        language: 'ar',
        shareable: false,
      });
      expect(made?.headers['idempotency-key']).toBeDefined();
    });

    await user.click(screen.getByRole('button', { name: 'Email PDF' }));
    const emailing = await screen.findByRole('dialog', { name: 'Email the PDF' });
    expect(within(emailing).getByLabelText('To')).toHaveValue('mona@horizon.example');
    await user.type(within(emailing).getByLabelText('Message (optional)'), 'As discussed.');
    await user.click(within(emailing).getByRole('button', { name: 'Send' }));
    expect(await within(emailing).findByText('Sent to mona@horizon.example.')).toBeInTheDocument();
    const sent = calls.find((call) => call.path === `/v1/business-documents/${DOCUMENT}/email`);
    expect(sent?.body).toEqual({ to: 'mona@horizon.example', message: 'As discussed.' });
  });

  it('offers only viewing to a seat that may not make or email, and says why one failed', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me({ documents: true, sales: true }),
      'GET /v1/business-documents': listed(
        [
          pdf(),
          pdf({ id: `${DOCUMENT.slice(0, -1)}2`, status: 'failed', failureCode: 'render_timeout' }),
        ],
        { make: false, email: false, share: false },
      ),
    });
    renderScreen(<BusinessPdfPanel kind="quote" recordId={QUOTE} />, client);
    expect(await screen.findByRole('button', { name: 'View' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Make PDF' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Email PDF' })).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('took too long');
  });

  it('shows nothing when the company has no documents module', async () => {
    const { client, calls } = fakeApi({
      'GET /v1/me': me({ documents: false, sales: true }),
      'GET /v1/business-documents': listed([pdf()]),
    });
    renderScreen(<BusinessPdfPanel kind="quote" recordId={QUOTE} />, client);
    await waitFor(() => expect(calls.some((call) => call.path === '/v1/me')).toBe(true));
    expect(screen.queryByText('PDFs')).not.toBeInTheDocument();
    expect(calls.some((call) => call.path === '/v1/business-documents')).toBe(false);
  });
});
