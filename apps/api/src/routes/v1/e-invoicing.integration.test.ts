import { randomBytes, randomUUID } from 'node:crypto';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import { inspectForSigning, signRequest, toBase64, type SigningRequest } from '@integr8/eta';
import { TransportError, type TransportRequest, type TransportResponse } from '@integr8/eta/node';
import { createSoftSigner, type SoftSigner } from '@integr8/eta/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildJobHandlers } from '../../jobs/handlers.js';
import { createLogger } from '../../http/logger.js';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Egyptian e-invoicing over HTTP (ADR-0014), against a fake ETA: nothing
 * here reaches the tax authority, and no real credentials exist in this
 * suite. The schema used is a small test schema written below, not the
 * ETA's: what is tested is that a schema is required and enforced, not the
 * ETA's own rules.
 *
 * Covered: the module switch; who may read, configure, prepare, sign and
 * submit; sealed write-only credentials; production refused by default;
 * readiness; preparing and superseding; the signing protocol with a
 * software test signer (pinned certificate, nonce, digest, refusal of an
 * unpinned signer); the gates before submission (signed, schema, arithmetic);
 * the exact bytes sent; status reconciliation (a 202 is not validity);
 * rejection; an ambiguous submission and its manual resolution;
 * cancellation; the ETA PDF; and another company seeing none of it.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let adminMember: Member;
let dispatcher: Member;
let viewer: Member;
let engineer: Member;
const tokens = new Map<Member, string>();
let customerId: string;
let signer: SoftSigner;
let stranger: SoftSigner;

const CLIENT_ID = 'test-client-id-0001';
const CLIENT_SECRET = 'test-client-secret-value';

function json<T>(response: { body: string }): T {
  return JSON.parse(response.body) as T;
}
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

async function token(who: Member): Promise<string> {
  let value = tokens.get(who);
  if (value === undefined) {
    value = await api.signIn(who);
    tokens.set(who, value);
  }
  return value;
}

async function call(
  who: Member,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  payload?: Record<string, unknown>,
  key?: string,
) {
  return api.call(await token(who), {
    method,
    url,
    ...(payload === undefined ? {} : { payload }),
    ...(key === undefined ? {} : { headers: { 'idempotency-key': key } }),
  });
}

async function setFlag(harness: ApiHarness, staff: PlatformAdmin, key: string, enabled: boolean) {
  const response = await harness.call(staff.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${harness.tenantId}/flags/${key}`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

// ---------------------------------------------------------------------------
// The fake ETA
// ---------------------------------------------------------------------------

/** A test schema: the shape of what `invoice.ts` builds, loosely. Not the ETA's. */
const TEST_SCHEMA = JSON.stringify({
  $schema: 'http://json-schema.org/draft-07/schema#',
  type: 'object',
  required: [
    'issuer',
    'receiver',
    'documentType',
    'documentTypeVersion',
    'invoiceLines',
    'totalAmount',
    'signatures',
  ],
  properties: {
    documentType: { type: 'string', enum: ['I'] },
    documentTypeVersion: { type: 'string', enum: ['1.0'] },
    invoiceLines: { type: 'array', minItems: 1 },
    totalAmount: { type: 'number', minimum: 0 },
    signatures: { type: 'array', minItems: 1 },
  },
});

interface FakeEta {
  requests: TransportRequest[];
  tokenStatus: number;
  submit: (body: string) => TransportResponse | 'timeout';
  status: string;
}

const fake: FakeEta = {
  requests: [],
  tokenStatus: 200,
  submit: () => answer(500, {}),
  status: 'Submitted',
};

function answer(status: number, body: unknown): TransportResponse {
  return {
    status,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

function fakeTransport(request: TransportRequest): Promise<TransportResponse> {
  try {
    return Promise.resolve(fakeAnswer(request));
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

function fakeAnswer(request: TransportRequest): TransportResponse {
  fake.requests.push(request);
  const url = new URL(request.url);
  if (url.pathname === '/connect/token') {
    return fake.tokenStatus === 200
      ? answer(200, { access_token: `token-${randomUUID()}`, expires_in: 3600 })
      : answer(fake.tokenStatus, { error: 'invalid_client' });
  }
  if (url.pathname === '/api/v1.0/documenttypes') {
    return answer(200, [
      {
        id: 'type-i',
        name: 'I',
        documentTypeVersions: [{ id: 'version-1', versionNumber: '1.0', status: 'Active' }],
      },
    ]);
  }
  if (url.pathname === '/api/v1.0/documenttypes/type-i/versions/version-1') {
    return answer(200, {
      versionNumber: '1.0',
      jsonSchema: Buffer.from(TEST_SCHEMA, 'utf8').toString('base64'),
    });
  }
  if (url.pathname === '/api/v1.0/documentsubmissions/') {
    const result = fake.submit(request.body ?? '');
    if (result === 'timeout') {
      throw new TransportError('timeout', 'no answer');
    }
    return result;
  }
  const details = /^\/api\/v1\.0\/documents\/([^/]+)\/details$/u.exec(url.pathname);
  if (details !== null) {
    return answer(200, {
      uuid: details[1],
      status: fake.status,
      longId: 'LONG-1',
      validationResults: {
        validationSteps:
          fake.status === 'Invalid'
            ? [
                {
                  status: 'Invalid',
                  error: { code: 'X1', message: 'Test failure', propertyPath: 'totalAmount' },
                },
              ]
            : [],
      },
    });
  }
  if (/^\/api\/v1\.0\/documents\/[^/]+\/pdf$/u.test(url.pathname)) {
    return {
      status: 200,
      headers: { 'content-type': 'application/pdf' },
      body: new TextEncoder().encode('%PDF-test'),
    };
  }
  if (/^\/api\/v1\.0\/documents\/state\/[^/]+\/state$/u.test(url.pathname)) {
    return answer(200, {});
  }
  return answer(404, { error: { code: 'not_found', message: 'not found' } });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADDRESS = {
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
};

async function issuedInvoice(lines?: Record<string, unknown>[]): Promise<string> {
  const drafted = await call(
    owner,
    'POST',
    '/v1/finance/invoices',
    {
      customerId,
      lines: lines ?? [
        {
          description: 'Annual service',
          quantity: '2',
          unitPrice: '100',
          discountBp: 1000,
          taxRateBp: 1400,
        },
        { description: 'Call-out', quantity: '1', unitPrice: '50.125', taxRateBp: 1400 },
      ],
    },
    randomUUID(),
  );
  expect(drafted.statusCode, drafted.body).toBe(201);
  const detail = json<{ invoice: { id: string; version: number } }>(drafted);
  const issued = await call(owner, 'POST', `/v1/finance/invoices/${detail.invoice.id}/issue`, {
    expectedVersion: detail.invoice.version,
  });
  expect(issued.statusCode, issued.body).toBe(200);
  return detail.invoice.id;
}

interface DocumentBody {
  id: string;
  state: string;
  sequence: number;
  internalId: string;
  totalAmount: string;
  etaUuid: string | null;
  etaStatus: string | null;
  lastErrorCode: string | null;
  errors: { code: string | null; message: string }[];
  canonicalSha256: string;
}
interface Detail {
  document: DocumentBody;
  signingRequest: { id: string; nonce: string } | null;
  attempts: { kind: string; outcome: string }[];
}

async function prepare(invoiceId: string): Promise<DocumentBody> {
  const response = await call(
    dispatcher,
    'POST',
    `/v1/eta/invoices/${invoiceId}/prepare`,
    {},
    randomUUID(),
  );
  expect(response.statusCode, response.body).toBe(201);
  return json<DocumentBody>(response);
}

async function requestSignature(documentId: string): Promise<Detail> {
  const response = await call(owner, 'POST', `/v1/eta/documents/${documentId}/signature-request`);
  expect(response.statusCode, response.body).toBe(201);
  return json<Detail>(response);
}

interface Claimed {
  request: SigningRequest & { status: string };
  documentText: string;
}

async function claim(requestId: string): Promise<Claimed> {
  const response = await call(owner, 'POST', `/v1/eta/signing-requests/${requestId}/claim`);
  expect(response.statusCode, response.body).toBe(200);
  return json<Claimed>(response);
}

async function sign(documentId: string, with_ = signer) {
  const requested = await requestSignature(documentId);
  const claimed = await claim(requested.signingRequest!.id);
  const summary = await inspectForSigning(claimed.request, claimed.documentText);
  expect(summary.environment).toBe('preprod');
  const signed = await signRequest({
    request: claimed.request,
    unsignedDocumentText: claimed.documentText,
    signer: with_,
    certificateSha256: with_.certificateSha256,
  });
  return call(owner, 'POST', `/v1/eta/signing-requests/${claimed.request.id}/complete`, {
    nonce: signed.nonce,
    cms: signed.cms,
  });
}

const handled = new Set<string>();

async function runJobs(queue: string): Promise<number> {
  const jobs = await withTenant(api.tenantId, (tx) => tx.jobs.list({ queue, status: 'pending' }));
  const handlers = buildJobHandlers(api.services, api.config);
  let ran = 0;
  for (const job of jobs) {
    if (handled.has(job.id)) {
      continue;
    }
    handled.add(job.id);
    ran += 1;
    await handlers[queue]!(job.payload, {
      tenantId: api.tenantId,
      jobId: job.id,
      attempt: 1,
      logger: createLogger({ level: 'error', write: () => undefined }),
    });
  }
  return ran;
}

async function documentDetail(id: string): Promise<Detail> {
  const response = await call(viewer, 'GET', `/v1/eta/documents/${id}`);
  expect(response.statusCode, response.body).toBe(200);
  return json<Detail>(response);
}

function pem(der: Uint8Array): string {
  const body = toBase64(der).replace(/(.{64})/gu, '$1\n');
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  api = await startApi({ env: { ETA_CREDENTIALS_KEY: randomBytes(32).toString('base64') } });
  api.services.eta.transports.preprod = fakeTransport;
  api.services.eta.transports.production = () => {
    throw new Error('production must never be called in tests');
  };
  admin = await api.platformAdmin('eta-staff');
  owner = await api.member('owner', 'eta-owner');
  adminMember = await api.member('admin', 'eta-admin');
  dispatcher = await api.member('dispatcher', 'eta-dispatcher');
  viewer = await api.member('viewer', 'eta-viewer');
  engineer = await api.member('engineer', 'eta-engineer');
  signer = await createSoftSigner({ commonName: 'Integr8 test signer' });
  stranger = await createSoftSigner({ commonName: 'Someone else' });
  await setFlag(api, admin, 'finance', true);
  const customer = await call(dispatcher, 'POST', '/v1/customers', {
    name: 'Nile Trading Co',
    address: { line1: '5 Tahrir Square', city: 'Cairo', countryCode: 'EG' },
  });
  expect(customer.statusCode, customer.body).toBe(201);
  customerId = json<{ id: string }>(customer).id;
});

afterAll(async () => {
  await api.close();
});

describe('the module switch and who may do what', () => {
  it('refuses every e-invoicing route until Integr8 switches the module on', async () => {
    const refused = await call(owner, 'GET', '/v1/eta/settings');
    expect(refused.statusCode).toBe(403);
    expect(code(refused)).toBe('feature_disabled');
    await setFlag(api, admin, 'e_invoicing', true);
    expect((await call(viewer, 'GET', '/v1/eta/settings')).statusCode).toBe(200);
  });

  it('lets Integr8 staff acting as the company switch it off and on again, and nobody else', async () => {
    for (const who of [owner, adminMember]) {
      expect((await call(who, 'GET', '/v1/eta/availability')).statusCode).toBe(403);
      expect((await call(who, 'PUT', '/v1/eta/availability', { enabled: false })).statusCode).toBe(
        403,
      );
    }
    const staff = await api.staff(owner);
    const read = await api.call(staff, { method: 'GET', url: '/v1/eta/availability' });
    expect(read.statusCode, read.body).toBe(200);
    expect(json(read)).toEqual({
      enabled: true,
      financeEnabled: true,
      active: true,
      server: { credentialsKeyConfigured: true, productionAllowed: false },
    });

    const off = await api.call(staff, {
      method: 'PUT',
      url: '/v1/eta/availability',
      payload: { enabled: false },
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(json(off)).toMatchObject({ enabled: false, active: false });
    const closed = await call(owner, 'GET', '/v1/eta/settings');
    expect(closed.statusCode).toBe(403);
    expect(code(closed)).toBe('feature_disabled');
    expect((await getPlatformDataSource().settings.flagsFor(api.tenantId)).e_invoicing).toBe(false);
    const audited = await withTenant(api.tenantId, (tx) =>
      tx.auditLog.list({ resourceType: 'tenant', resourceId: api.tenantId }),
    );
    expect(audited.find((entry) => entry.action === 'eta.module_switched')?.metadata).toMatchObject(
      { enabled: false, was: true },
    );

    const on = await api.call(staff, {
      method: 'PUT',
      url: '/v1/eta/availability',
      payload: { enabled: true },
    });
    expect(json(on)).toMatchObject({ enabled: true, active: true });
    expect((await call(viewer, 'GET', '/v1/eta/settings')).statusCode).toBe(200);
  });

  it('lets only owners and admins configure, and keeps engineers out', async () => {
    const settings = {
      expectedVersion: 0,
      enabled: false,
      environment: 'preprod',
      taxpayerId: null,
      issuerName: null,
      branchId: null,
      activityCode: null,
      address: ADDRESS,
      intermediaryFor: null,
      documentTypeVersion: '1.0',
      defaultItem: null,
    };
    expect((await call(dispatcher, 'PUT', '/v1/eta/settings', settings)).statusCode).toBe(403);
    expect((await call(viewer, 'PUT', '/v1/eta/settings', settings)).statusCode).toBe(403);
    expect((await call(engineer, 'GET', '/v1/eta/settings')).statusCode).toBe(403);
    expect((await call(dispatcher, 'GET', '/v1/eta/signing-requests')).statusCode).toBe(403);
    const fresh = json<{
      enabled: boolean;
      environment: string;
      server: { productionAllowed: boolean };
    }>(await call(viewer, 'GET', '/v1/eta/settings'));
    expect(fresh).toMatchObject({
      enabled: false,
      environment: 'preprod',
      server: { productionAllowed: false },
    });
  });
});

describe('settings and credentials', () => {
  it('are saved by the owner, and production is refused on this deployment', async () => {
    const body = {
      expectedVersion: 0,
      enabled: true,
      environment: 'preprod',
      taxpayerId: '100200300',
      issuerName: 'Integr8 Test Services',
      branchId: '0',
      activityCode: '4620',
      address: ADDRESS,
      intermediaryFor: null,
      documentTypeVersion: '1.0',
      defaultItem: { itemType: 'EGS', itemCode: 'EG-100200300-1' },
    };
    const saved = await call(owner, 'PUT', '/v1/eta/settings', body);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(json<{ version: number; enabled: boolean }>(saved)).toMatchObject({
      version: 1,
      enabled: true,
    });

    const production = await call(owner, 'PUT', '/v1/eta/settings', {
      ...body,
      expectedVersion: 1,
      environment: 'production',
      confirmProduction: true,
    });
    expect(production.statusCode).toBe(403);
    expect(
      json<{ error: { details: { code: string }[] } }>(production).error.details[0]!.code,
    ).toBe('eta_production_disabled');
    const stale = await call(owner, 'PUT', '/v1/eta/settings', body);
    expect(stale.statusCode).toBe(409);
  });

  it('are write-only, sealed at rest, and refused to Integr8 staff acting as the company', async () => {
    const asStaff = await api.call(await api.staff(owner), {
      method: 'PUT',
      url: '/v1/eta/settings/credentials',
      payload: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    });
    expect(asStaff.statusCode).toBe(403);
    expect(code(asStaff)).toBe('forbidden');

    const saved = await call(adminMember, 'PUT', '/v1/eta/settings/credentials', {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.body).not.toContain(CLIENT_SECRET);
    expect(saved.body).not.toContain(CLIENT_ID);
    expect(
      json<{ credentials: { saved: boolean; hint: string } }>(saved).credentials,
    ).toMatchObject({
      saved: true,
      hint: '0001',
    });
    const read = await call(viewer, 'GET', '/v1/eta/settings');
    expect(read.body).not.toContain(CLIENT_SECRET);

    const sealed = await withTenant(api.tenantId, (tx) => tx.eta.sealedCredentials());
    expect(sealed?.clientSecret.startsWith('eta1.')).toBe(true);
    expect(sealed?.clientSecret).not.toContain(CLIENT_SECRET);
    expect(sealed?.clientId).not.toContain(CLIENT_ID);
  });

  it('are checked with the ETA, and a refusal is said plainly', async () => {
    const ok = await call(owner, 'POST', '/v1/eta/settings/credentials/check');
    expect(ok.statusCode, ok.body).toBe(200);
    const tokenCall = fake.requests.find((request) => request.url.endsWith('/connect/token'))!;
    expect(tokenCall.url.startsWith('https://id.preprod.eta.gov.eg')).toBe(true);
    expect(tokenCall.body).toBe('grant_type=client_credentials');
    expect(tokenCall.headers.authorization).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64')}`,
    );
    fake.tokenStatus = 401;
    const refused = await call(owner, 'POST', '/v1/eta/settings/credentials/check');
    expect(refused.statusCode).toBe(422);
    expect(code(refused)).toBe('eta_credentials_rejected');
    expect(refused.body).not.toContain('invalid_client');
    fake.tokenStatus = 200;
  });
});

describe('an invoice becoming an ETA document', () => {
  let invoiceId: string;
  let documentId: string;

  it('is not ready until the receiver, units and taxes are mapped', async () => {
    invoiceId = await issuedInvoice();
    const panel = json<{ readiness: { code: string; severity: string }[] }>(
      await call(viewer, 'GET', `/v1/eta/invoices/${invoiceId}`),
    );
    const codes = panel.readiness.map((issue) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining(['receiver_missing', 'line_unit_unmapped', 'line_tax_unmapped']),
    );
    const refused = await call(
      dispatcher,
      'POST',
      `/v1/eta/invoices/${invoiceId}/prepare`,
      {},
      randomUUID(),
    );
    expect(refused.statusCode).toBe(422);
    expect(code(refused)).toBe('eta_not_ready');
  });

  it('is ready once the codes are entered, and is prepared with exact amounts', async () => {
    const receiver = await call(owner, 'PUT', `/v1/eta/receivers/${customerId}`, {
      receiverType: 'B',
      receiverId: '200300400',
      address: ADDRESS,
    });
    expect(receiver.statusCode, receiver.body).toBe(200);
    expect(
      (await call(owner, 'PUT', '/v1/eta/unit-types', { unitTypes: { each: 'EA' } })).statusCode,
    ).toBe(200);
    const taxes = await call(owner, 'PUT', '/v1/eta/tax-mappings', {
      taxMappings: [{ taxRateBp: 1400, taxType: 'T1', subType: 'V009' }],
    });
    expect(taxes.statusCode, taxes.body).toBe(200);
    const repeated = await call(owner, 'PUT', '/v1/eta/tax-mappings', {
      taxMappings: [
        { taxRateBp: 1400, taxType: 'T1', subType: 'V009' },
        { taxRateBp: 1400, taxType: 'T1', subType: 'V001' },
      ],
    });
    expect(code(repeated)).toBe('eta_tax_rate_repeated');

    const panel = json<{ readiness: { severity: string }[] }>(
      await call(viewer, 'GET', `/v1/eta/invoices/${invoiceId}`),
    );
    expect(panel.readiness.filter((issue) => issue.severity === 'error')).toEqual([]);

    const document = await prepare(invoiceId);
    documentId = document.id;
    // 2 × 100 less 10% = 180, +14% = 205.2; 50.125 + 14% = 57.1425. Five places, never a float.
    expect(document).toMatchObject({ state: 'ready', sequence: 1, totalAmount: '262.3425' });
    expect(document.internalId).toMatch(/^INV-\d+$/u);
    const texts = await withTenant(api.tenantId, (tx) => tx.eta.documentTexts(documentId));
    expect(texts?.unsigned).toContain('"amountEGP":50.125');
    expect(texts?.signed).toBeNull();
  });

  it('cannot be sent unsigned', async () => {
    const refused = await call(
      owner,
      'POST',
      `/v1/eta/documents/${documentId}/submit`,
      undefined,
      randomUUID(),
    );
    expect(refused.statusCode).toBe(409);
    expect(code(refused)).toBe('eta_state_conflict');
    const noKey = await call(owner, 'POST', `/v1/eta/documents/${documentId}/submit`);
    expect(noKey.statusCode).toBe(400);
  });

  it('is signed only by a pinned certificate, through the agent protocol', async () => {
    const unpinned = await call(owner, 'POST', `/v1/eta/documents/${documentId}/signature-request`);
    expect(unpinned.statusCode).toBe(422);
    expect(code(unpinned)).toBe('eta_no_certificates');

    const privateKey = await call(owner, 'PUT', '/v1/eta/settings/certificates', {
      certificates: [`-----BEGIN PRIVATE KEY-----\n${'A'.repeat(200)}\n-----END PRIVATE KEY-----`],
    });
    expect(code(privateKey)).toBe('eta_private_key_refused');
    const pinned = await call(owner, 'PUT', '/v1/eta/settings/certificates', {
      certificates: [pem(signer.certificateDer)],
    });
    expect(pinned.statusCode, pinned.body).toBe(200);
    expect(
      json<{ settings: { pinnedCertificates: string[] } }>(pinned).settings.pinnedCertificates,
    ).toEqual([signer.certificateSha256]);

    // Someone else's certificate: refused, and the document is ready again.
    const refused = await sign(documentId, stranger);
    expect(refused.statusCode).toBe(422);
    expect(code(refused)).toBe('eta_signature_refused');
    expect(json<{ error: { details: { code: string }[] } }>(refused).error.details[0]!.code).toBe(
      'eta_signature_certificate_not_pinned',
    );
    expect((await documentDetail(documentId)).document.state).toBe('ready');

    // The wrong nonce is refused outright.
    const requested = await requestSignature(documentId);
    expect(requested.signingRequest!.nonce).toBe('');
    const claimed = await claim(requested.signingRequest!.id);
    const answer_ = await signRequest({
      request: claimed.request,
      unsignedDocumentText: claimed.documentText,
      signer,
      certificateSha256: signer.certificateSha256,
    });
    const wrongNonce = await call(
      owner,
      'POST',
      `/v1/eta/signing-requests/${claimed.request.id}/complete`,
      {
        nonce: 'x'.repeat(43),
        cms: answer_.cms,
      },
    );
    expect(wrongNonce.statusCode).toBe(403);
    // Only the member who claimed it may answer.
    const notClaimer = await call(
      adminMember,
      'POST',
      `/v1/eta/signing-requests/${claimed.request.id}/complete`,
      {
        nonce: answer_.nonce,
        cms: answer_.cms,
      },
    );
    expect(notClaimer.statusCode).toBe(409);
    const good = await call(
      owner,
      'POST',
      `/v1/eta/signing-requests/${claimed.request.id}/complete`,
      {
        nonce: answer_.nonce,
        cms: answer_.cms,
      },
    );
    expect(good.statusCode, good.body).toBe(200);
    expect(json<Detail>(good).document.state).toBe('signed');
    const texts = await withTenant(api.tenantId, (tx) => tx.eta.documentTexts(documentId));
    expect(texts?.signed?.startsWith(texts.unsigned.slice(0, -1))).toBe(true);
    expect(texts?.signed).toContain('"signatures":[{"signatureType":"I","value":"');
  });

  it('needs the fetched schema before it is sent', async () => {
    const missing = await call(
      owner,
      'POST',
      `/v1/eta/documents/${documentId}/submit`,
      undefined,
      randomUUID(),
    );
    expect(missing.statusCode).toBe(422);
    expect(code(missing)).toBe('eta_schema_missing');
    const available = await call(owner, 'GET', '/v1/eta/schemas/available');
    expect(available.statusCode, available.body).toBe(200);
    const fetched = await call(owner, 'POST', '/v1/eta/schemas/fetch', {
      etaTypeId: 'type-i',
      etaVersionId: 'version-1',
      documentType: 'I',
      typeVersion: '1.0',
    });
    expect(fetched.statusCode, fetched.body).toBe(200);
  });

  it('is sent exactly as signed, and is valid only once the ETA says so', async () => {
    let sentBody = '';
    fake.submit = (body) => {
      sentBody = body;
      return answer(202, {
        submissionId: 'SUB-1',
        acceptedDocuments: [
          {
            uuid: 'UUID-0000000001',
            longId: 'LONG-1',
            internalId: (JSON.parse(body) as { documents: { internalID: string }[] }).documents[0]!
              .internalID,
          },
        ],
        rejectedDocuments: [],
      });
    };
    const queued = await call(
      owner,
      'POST',
      `/v1/eta/documents/${documentId}/submit`,
      undefined,
      randomUUID(),
    );
    expect(queued.statusCode, queued.body).toBe(202);
    expect(json<Detail>(queued).document.state).toBe('submitting');
    expect(await runJobs('eta.submit')).toBe(1);

    const texts = await withTenant(api.tenantId, (tx) => tx.eta.documentTexts(documentId));
    expect(sentBody).toBe(`{"documents":[${texts!.signed!}]}`);
    const submitted = await documentDetail(documentId);
    expect(submitted.document).toMatchObject({ state: 'submitted', etaUuid: 'UUID-0000000001' });

    // Still "Submitted" at the ETA: not valid yet.
    fake.status = 'Submitted';
    await runJobs('eta.reconcile');
    expect((await documentDetail(documentId)).document.state).toBe('submitted');
    fake.status = 'Valid';
    await runJobs('eta.reconcile');
    const valid = await documentDetail(documentId);
    expect(valid.document).toMatchObject({ state: 'valid', etaStatus: 'Valid' });
    expect(valid.attempts.map((attempt) => attempt.kind)).toEqual(
      expect.arrayContaining(['submit', 'status']),
    );
  });

  it('is not prepared again while valid, gives the ETA’s PDF, and is cancelled when the ETA says so', async () => {
    const again = await call(
      dispatcher,
      'POST',
      `/v1/eta/invoices/${invoiceId}/prepare`,
      {},
      randomUUID(),
    );
    expect(again.statusCode).toBe(409);
    expect(code(again)).toBe('eta_document_live');

    const pdf = await call(viewer, 'GET', `/v1/eta/documents/${documentId}/pdf`);
    expect(pdf.statusCode, pdf.body).toBe(200);
    expect(Buffer.from(json<{ base64: string }>(pdf).base64, 'base64').toString()).toBe(
      '%PDF-test',
    );

    const cancel = await call(
      owner,
      'POST',
      `/v1/eta/documents/${documentId}/cancel`,
      { reason: 'Wrong customer' },
      randomUUID(),
    );
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(json<Detail>(cancel).document.state).toBe('valid');
    fake.status = 'Cancelled';
    await runJobs('eta.reconcile');
    expect((await documentDetail(documentId)).document.state).toBe('cancelled');
  });
});

describe('when the ETA says no, or says nothing', () => {
  it('a rejected document is recorded with the ETA’s errors and may be prepared again', async () => {
    const invoiceId = await issuedInvoice();
    const first = await prepare(invoiceId);
    expect((await sign(first.id)).statusCode).toBe(200);
    fake.submit = () =>
      answer(202, {
        submissionId: 'SUB-2',
        acceptedDocuments: [],
        rejectedDocuments: [
          {
            internalId: first.internalId,
            error: { code: 'BadStructure', message: 'Test rejection', details: [] },
          },
        ],
      });
    expect(
      (await call(owner, 'POST', `/v1/eta/documents/${first.id}/submit`, undefined, randomUUID()))
        .statusCode,
    ).toBe(202);
    await runJobs('eta.submit');
    const rejected = await documentDetail(first.id);
    expect(rejected.document).toMatchObject({
      state: 'rejected',
      lastErrorCode: 'eta_document_rejected',
    });
    expect(rejected.document.errors[0]).toMatchObject({ code: 'BadStructure' });
    const second = await prepare(invoiceId);
    expect(second.sequence).toBe(2);
  });

  it('a lost answer makes the document unknown, never sent again until a person resolves it', async () => {
    const invoiceId = await issuedInvoice();
    const document = await prepare(invoiceId);
    expect((await sign(document.id)).statusCode).toBe(200);
    fake.submit = () => 'timeout';
    const before = fake.requests.filter((request) =>
      request.url.includes('documentsubmissions'),
    ).length;
    expect(
      (
        await call(
          owner,
          'POST',
          `/v1/eta/documents/${document.id}/submit`,
          undefined,
          randomUUID(),
        )
      ).statusCode,
    ).toBe(202);
    await runJobs('eta.submit');
    const after = fake.requests.filter((request) =>
      request.url.includes('documentsubmissions'),
    ).length;
    expect(after - before).toBe(1);
    expect((await documentDetail(document.id)).document.state).toBe('unknown');

    const resend = await call(
      owner,
      'POST',
      `/v1/eta/documents/${document.id}/submit`,
      undefined,
      randomUUID(),
    );
    expect(resend.statusCode).toBe(409);
    const resolved = await call(owner, 'POST', `/v1/eta/documents/${document.id}/resolve`, {
      outcome: 'not_received',
    });
    expect(resolved.statusCode, resolved.body).toBe(200);
    expect(json<Detail>(resolved).document.state).toBe('signed');
  });

  it('a submission job that dies part-way is never sent twice', async () => {
    const invoiceId = await issuedInvoice();
    const document = await prepare(invoiceId);
    expect((await sign(document.id)).statusCode).toBe(200);
    expect(
      (
        await call(
          owner,
          'POST',
          `/v1/eta/documents/${document.id}/submit`,
          undefined,
          randomUUID(),
        )
      ).statusCode,
    ).toBe(202);
    const before = fake.requests.length;
    const [job] = await withTenant(api.tenantId, (tx) =>
      tx.jobs.list({ queue: 'eta.submit', status: 'pending' }),
    ).then((jobs) => jobs.filter((entry) => !handled.has(entry.id)));
    handled.add(job!.id);
    await buildJobHandlers(api.services, api.config)['eta.submit']!(job!.payload, {
      tenantId: api.tenantId,
      jobId: job!.id,
      attempt: 2,
      logger: createLogger({ level: 'error', write: () => undefined }),
    });
    expect(fake.requests.length).toBe(before);
    const detail = await documentDetail(document.id);
    expect(detail.document).toMatchObject({
      state: 'unknown',
      lastErrorCode: 'eta_submission_interrupted',
    });
  });
});

describe('when Integr8 switches e-invoicing off', () => {
  it('sends nothing that was waiting, and says why once it is back on', async () => {
    const invoiceId = await issuedInvoice();
    const document = await prepare(invoiceId);
    expect((await sign(document.id)).statusCode).toBe(200);
    expect(
      (
        await call(
          owner,
          'POST',
          `/v1/eta/documents/${document.id}/submit`,
          undefined,
          randomUUID(),
        )
      ).statusCode,
    ).toBe(202);
    const staff = await api.staff(owner);
    const switchTo = (enabled: boolean) =>
      api.call(staff, { method: 'PUT', url: '/v1/eta/availability', payload: { enabled } });
    expect((await switchTo(false)).statusCode).toBe(200);
    const before = fake.requests.length;
    expect(await runJobs('eta.submit')).toBe(1);
    expect(fake.requests.length).toBe(before);

    expect((await switchTo(true)).statusCode).toBe(200);
    expect((await documentDetail(document.id)).document).toMatchObject({
      state: 'failed',
      lastErrorCode: 'feature_disabled',
    });
  });
});

describe('another company', () => {
  it('cannot reach this company’s documents, signing requests or codes, nor this one theirs', async () => {
    const elsewhere = await getPlatformDataSource().tenants.create({
      slug: `eta-other-${randomUUID().slice(0, 8)}`,
      name: 'Elsewhere Ltd',
    });
    const theirs = await withTenant(elsewhere.id, async (tx) => {
      const customer = await tx.customers.create({ name: 'Theirs' }, randomUUID());
      const invoice = await tx.financeInvoices.createInvoice(
        { customerId: customer.id, currencyCode: 'EGP' },
        [{ description: 'x', quantity: '1', unitPrice: '1' }],
        randomUUID(),
      );
      const document = await tx.eta.createDocument({
        id: randomUUID(),
        invoiceId: invoice.id,
        environment: 'preprod',
        internalId: 'INV-THEIRS',
        unsignedJson: '{}',
        canonicalSha256: 'a'.repeat(64),
        exchangeRate: null,
        totalAmount: '1',
        currencyCode: 'EGP',
        by: randomUUID(),
      });
      await tx.eta.transition(document.id, ['ready'], 'pending_signature');
      const request = await tx.eta.createSigningRequest({
        id: randomUUID(),
        documentId: document.id,
        digest: 'a'.repeat(64),
        nonce: 'b'.repeat(64),
        expiresAt: new Date(Date.now() + 600_000),
        by: randomUUID(),
      });
      return { customer, invoice, document, request };
    });
    expect((await call(owner, 'GET', `/v1/eta/documents/${theirs.document.id}`)).statusCode).toBe(
      404,
    );
    expect((await call(owner, 'GET', `/v1/eta/invoices/${theirs.invoice.id}`)).statusCode).toBe(
      404,
    );
    expect(
      (
        await call(
          dispatcher,
          'POST',
          `/v1/eta/invoices/${theirs.invoice.id}/prepare`,
          {},
          randomUUID(),
        )
      ).statusCode,
    ).toBe(404);
    expect(
      (await call(owner, 'POST', `/v1/eta/signing-requests/${theirs.request.id}/claim`)).statusCode,
    ).toBe(404);
    expect(
      (
        await call(owner, 'PUT', `/v1/eta/receivers/${theirs.customer.id}`, {
          receiverType: 'B',
          receiverId: '1',
          address: ADDRESS,
        })
      ).statusCode,
    ).toBe(404);
    const ours = json<{ items: DocumentBody[] }>(
      await call(viewer, 'GET', '/v1/eta/documents'),
    ).items;
    expect(ours.length).toBeGreaterThan(0);
    expect(ours.some((document) => document.id === theirs.document.id)).toBe(false);
    const queue = json<{ items: { id: string }[] }>(
      await call(owner, 'GET', '/v1/eta/signing-requests'),
    );
    expect(queue.items.some((request) => request.id === theirs.request.id)).toBe(false);

    // And from their side: nothing of ours, and no credentials.
    const view = await withTenant(elsewhere.id, async (tx) => ({
      documents: await tx.eta.listDocuments({ limit: 100 }),
      sealed: await tx.eta.sealedCredentials(),
    }));
    expect(view.documents.map((document) => document.id)).toEqual([theirs.document.id]);
    expect(view.sealed).toBeUndefined();
  });
});
