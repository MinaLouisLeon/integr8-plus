import { screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { EtaDocument, EtaDocumentDetail, EtaSettings } from '../api.js';
import { accessibilityViolations, fakeApi, renderScreen } from '../testing/render.js';
import { EtaDocumentScreen } from './eta-document-screen.js';
import { EtaScreen } from './eta-screen.js';
import { InvoiceEtaPanel } from './invoice-eta-panel.js';

const USER = '00000000-0000-4000-8000-000000000401';
const TENANT = '00000000-0000-4000-8000-000000000301';
const INVOICE = '00000000-0000-4000-8000-00000000e001';
const CUSTOMER = '00000000-0000-4000-8000-00000000e101';
const DOCUMENT = '00000000-0000-4000-8000-00000000e201';

const me =
  (permissions: string[], role = 'admin') =>
  () => ({
    body: {
      userId: USER,
      tenantId: TENANT,
      email: 'a@x.example',
      displayName: 'Amal',
      role,
      permissions,
      features: { finance: true, e_invoicing: true },
      company: { name: 'Nile Trading', slug: 'nile' },
    },
  });

const ALL = ['eta.read', 'eta.prepare', 'eta.configure', 'eta.sign', 'eta.submit'];

const document = (overrides: Partial<EtaDocument> = {}): EtaDocument => ({
  id: DOCUMENT,
  invoiceId: INVOICE,
  sequence: 1,
  environment: 'preprod',
  internalId: 'INV-000042',
  state: 'signed',
  etaStatus: null,
  etaUuid: null,
  etaLongId: null,
  submissionId: null,
  totalAmount: '262.3425',
  currencyCode: 'EGP',
  exchangeRate: null,
  canonicalSha256: 'a'.repeat(64),
  signerCertificate: 'b'.repeat(64),
  signedAt: '2026-10-17T09:00:00.000Z',
  preparedAt: '2026-10-17T08:00:00.000Z',
  submittedAt: null,
  finalAt: null,
  nextCheckAt: null,
  checks: 0,
  lastErrorCode: null,
  errors: [],
  version: 3,
  ...overrides,
});

const detail = (overrides: Partial<EtaDocument> = {}): EtaDocumentDetail => ({
  document: document(overrides),
  signingRequest: null,
  attempts: [],
});

const settings = (overrides: Partial<EtaSettings> = {}): EtaSettings => ({
  enabled: true,
  environment: 'preprod',
  issuerType: 'B',
  taxpayerId: '100200300',
  issuerName: 'Nile Trading',
  branchId: '0',
  activityCode: '4620',
  address: {
    country: 'EG',
    governate: 'Cairo',
    regionCity: 'Nasr City',
    street: 'Abbas El Akkad',
    buildingNumber: '12',
    postalCode: null,
    floor: null,
    room: null,
    landmark: null,
    additionalInformation: null,
  },
  credentials: { saved: false, hint: null, updatedAt: null },
  intermediaryFor: null,
  documentTypeVersion: '1.0',
  defaultItem: null,
  pinnedCertificates: [],
  version: 1,
  updatedAt: '2026-10-17T08:00:00.000Z',
  server: { credentialsKeyConfigured: true, productionAllowed: false },
  ...overrides,
});

describe('the invoice’s e-invoicing panel', () => {
  it('says what stops the invoice, and keeps Prepare off until nothing does', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(ALL),
      'GET /v1/eta/invoices/:id': () => ({
        body: {
          enabled: true,
          environment: 'preprod',
          readiness: [
            { code: 'receiver_missing', severity: 'error', path: 'receiver' },
            {
              code: 'line_unit_unmapped',
              severity: 'error',
              path: 'lines[0].unit',
              params: { unit: 'each' },
            },
          ],
          documents: [],
        },
      }),
    });
    const { container } = renderScreen(
      <InvoiceEtaPanel invoiceId={INVOICE} customerId={CUSTOMER} currencyCode="EGP" />,
      client,
    );
    expect(await screen.findByText('The customer’s ETA details are not set.')).toBeInTheDocument();
    expect(screen.getByText('The unit “each” has no ETA unit code (Codes).')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prepare ETA document' })).toBeDisabled();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('prepares a ready invoice once, with an idempotency key, and opens the document', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ALL),
      'GET /v1/eta/invoices/:id': () => ({
        body: { enabled: true, environment: 'preprod', readiness: [], documents: [] },
      }),
      'POST /v1/eta/invoices/:id/prepare': () => ({
        status: 201,
        body: document({ state: 'ready', signedAt: null, signerCertificate: null }),
      }),
    });
    const { navigate } = renderScreen(
      <InvoiceEtaPanel invoiceId={INVOICE} customerId={CUSTOMER} currencyCode="EGP" />,
      client,
    );
    expect(await screen.findByText('Ready to become an ETA document.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Prepare ETA document' }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(`/e-invoicing/documents/${DOCUMENT}`),
    );
    const prepare = calls.find((call) => call.path.endsWith('/prepare'))!;
    expect(prepare.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u);
  });
});

describe('an ETA document', () => {
  it('sends a signed document with an idempotency key, and never offers to send an unsigned one', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ALL),
      'GET /v1/eta/documents/:id': () => ({ body: detail() }),
      'POST /v1/eta/documents/:id/submit': () => ({
        status: 202,
        body: detail({ state: 'submitting' }),
      }),
    });
    renderScreen(<EtaDocumentScreen documentId={DOCUMENT} />, client);
    await user.click(await screen.findByRole('button', { name: 'Send to the ETA' }));
    expect(await screen.findByText('Sending')).toBeInTheDocument();
    const submit = calls.find((call) => call.path.endsWith('/submit'))!;
    expect(submit.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('offers a signature, not sending, to a ready document', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(ALL),
      'GET /v1/eta/documents/:id': () => ({
        body: detail({ state: 'ready', signedAt: null, signerCertificate: null }),
      }),
    });
    renderScreen(<EtaDocumentScreen documentId={DOCUMENT} />, client);
    expect(await screen.findByRole('button', { name: 'Ask for signature' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send to the ETA' })).not.toBeInTheDocument();
  });

  it('asks a person to resolve an unclear outcome, warning before it is sent again', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ALL),
      'GET /v1/eta/documents/:id': () => ({
        body: detail({ state: 'unknown', lastErrorCode: 'eta_timeout' }),
      }),
      'POST /v1/eta/documents/:id/resolve': () => ({ body: detail({ state: 'signed' }) }),
    });
    renderScreen(<EtaDocumentScreen documentId={DOCUMENT} />, client);
    expect(await screen.findByText('The ETA did not answer in time.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Say what happened' }));
    await user.click(screen.getByLabelText('The ETA portal does not show it'));
    expect(screen.getByText('The document will be ready to send again.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(calls.find((call) => call.path.endsWith('/resolve'))?.body).toEqual({
        outcome: 'not_received',
      }),
    );
  });
});

describe('the e-invoicing screen', () => {
  it('shows only the documents to someone who cannot configure', async () => {
    const { client } = fakeApi({
      'GET /v1/me': me(['eta.read'], 'viewer'),
      'GET /v1/eta/documents': () => ({ body: { items: [document()], nextCursor: null } }),
    });
    const { container } = renderScreen(<EtaScreen />, client);
    expect(await screen.findByRole('link', { name: 'INV-000042' })).toHaveAttribute(
      'href',
      `/e-invoicing/documents/${DOCUMENT}`,
    );
    expect(screen.queryByRole('tab', { name: 'Settings' })).not.toBeInTheDocument();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('takes the credentials write-only, as a password, and clears them once saved', async () => {
    const user = userEvent.setup();
    const { client, calls } = fakeApi({
      'GET /v1/me': me(ALL),
      'GET /v1/eta/documents': () => ({ body: { items: [], nextCursor: null } }),
      'GET /v1/eta/settings': () => ({ body: settings() }),
      'GET /v1/eta/schemas': () => ({ body: { items: [] } }),
      'PUT /v1/eta/settings/credentials': () => ({
        body: settings({
          credentials: { saved: true, hint: '0001', updatedAt: '2026-10-17T09:00:00.000Z' },
          version: 2,
        }),
      }),
    });
    renderScreen(<EtaScreen />, client);
    await user.click(await screen.findByRole('tab', { name: 'Settings' }));
    const secret = await screen.findByLabelText('Client secret');
    expect(secret).toHaveAttribute('type', 'password');
    await user.type(screen.getByLabelText('Client ID'), 'client-0001');
    await user.type(secret, 'a-secret-value');
    await user.click(screen.getByRole('button', { name: 'Save credentials' }));
    expect(await screen.findByText(/client ID ending 0001/u)).toBeInTheDocument();
    expect(screen.getByLabelText('Client secret')).toHaveValue('');
    expect(calls.find((call) => call.path === '/v1/eta/settings/credentials')?.body).toEqual({
      clientId: 'client-0001',
      clientSecret: 'a-secret-value',
    });
    expect(screen.queryByText('a-secret-value')).not.toBeInTheDocument();
  });
});
