import { createHash, randomUUID } from 'node:crypto';
import { getPlatformDataSource, type TenantTransaction, withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { forgetTenantStatus } from '../../http/suspension.js';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * The website data API (docs/documents WEBSITE-LOOKUP.md; ADR-0001 D10, D11):
 * a company's own website server, holding a website key, asks for one job,
 * quote or invoice by id. Every route is refused the same way without a live
 * key; each needs Integr8's grant, the company's own switch and, for quotes
 * and invoices, the module; drafts are never shown; another company's id is
 * not found; and the key is rate limited. The file route and the document
 * lookup are proven beside the documents they serve, in documents.integration.
 */

const RATE_LIMIT = 30;

let api: ApiHarness;
let manager: PlatformAdmin;
let staff: PlatformAdmin;
let owner: Member;
let ownerToken: string;
let secret: string;
let keyId: string;
let jobId: string;
let quoteId: string;
let draftQuoteId: string;
let invoiceId: string;
let draftInvoiceId: string;

const json = <T>(response: { body: string }) => JSON.parse(response.body) as T;
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

function website(key: string | null, path: string) {
  return api.app.inject({
    method: 'GET',
    url: path,
    remoteAddress: api.remoteAddress,
    headers: key === null ? {} : { authorization: `Bearer ${key}` },
  });
}

async function flag(tenantId: string, name: string, enabled: boolean): Promise<void> {
  const response = await api.call(manager.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${tenantId}/flags/${name}`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function companySwitch(name: string, enabled: boolean): Promise<void> {
  const response = await api.call(ownerToken, {
    method: 'PATCH',
    url: '/v1/settings/website-access',
    payload: { [name]: enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function makeKey(tenantId: string): Promise<{ id: string; secret: string }> {
  const made = await api.call(manager.accessToken, {
    method: 'POST',
    url: `/v1/platform/companies/${tenantId}/website-keys`,
    payload: { label: 'test website' },
  });
  expect(made.statusCode, made.body).toBe(201);
  const body = json<{ key: { id: string }; secret: string }>(made);
  return { id: body.key.id, secret: body.secret };
}

const ADDRESS = {
  line1: '1 River Road',
  line2: null,
  city: 'Cairo',
  region: null,
  postcode: null,
  countryCode: 'EG',
};

/** A job, an issued and a draft quote, an issued and a draft invoice, written directly. */
async function records(tx: TenantTransaction, actor: string) {
  const customer = await tx.customers.create({ name: 'Website Customer' }, actor);
  const site = await tx.sites.create(
    customer.id,
    { name: 'Main', address: { line1: '1 St' } },
    actor,
  );
  const type = await tx.jobTypes.create(
    { name: 'Repair', code: `R${randomUUID().slice(0, 6)}` },
    actor,
  );
  const job = await tx.workOrders.create(
    { customerId: customer.id, siteId: site.id, jobTypeId: type.id, title: 'Boiler repair' },
    actor,
  );
  const lines = [{ description: 'Service', quantity: '1', unitPrice: '100' }];
  const quote = await tx.salesQuotes.createQuote(
    {
      customerId: customer.id,
      title: 'Boiler quote',
      currencyCode: 'EGP',
      internalNotes: 'secret',
    },
    lines,
    actor,
  );
  const issuedQuote = await tx.salesQuotes.issue(quote.id, quote.version, {
    issuedBy: actor,
    snapshot: {
      customerName: 'Website Customer',
      customerAddress: ADDRESS,
      contactName: null,
      contactEmail: null,
      contactPhone: null,
    },
    tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
  });
  if (typeof issuedQuote === 'string') {
    throw new Error(issuedQuote);
  }
  const draftQuote = await tx.salesQuotes.createQuote(
    { customerId: customer.id, title: 'Draft quote', currencyCode: 'EGP' },
    lines,
    actor,
  );
  const invoice = await tx.financeInvoices.createInvoice(
    { customerId: customer.id, currencyCode: 'EGP' },
    lines,
    actor,
  );
  const issuedInvoice = await tx.financeInvoices.issue(invoice.id, invoice.version, {
    issuedBy: actor,
    issueDate: '2026-10-01',
    dueDate: '2026-11-01',
    customerName: 'Website Customer',
    customerAddress: ADDRESS,
    contactName: null,
    contactEmail: null,
    issuer: {
      name: 'Website Test Ltd',
      address: null,
      taxReference: null,
      paymentInstructions: null,
      footer: null,
    },
  });
  if (typeof issuedInvoice === 'string') {
    throw new Error(issuedInvoice);
  }
  const draftInvoice = await tx.financeInvoices.createInvoice(
    { customerId: customer.id, currencyCode: 'EGP' },
    lines,
    actor,
  );
  return {
    job: job.id,
    quote: issuedQuote.id,
    draftQuote: draftQuote.id,
    invoice: issuedInvoice.id,
    draftInvoice: draftInvoice.id,
  };
}

beforeAll(async () => {
  api = await startApi({
    env: {
      WEBSITE_LOOKUP_RATE_LIMIT: String(RATE_LIMIT),
      WEBSITE_LOOKUP_RATE_WINDOW_SECONDS: '600',
    },
  });
  manager = await api.platformAdmin('website-manager', { manager: true });
  staff = await api.platformAdmin('website-staff');
  owner = await api.member('owner', 'website-owner');
  ownerToken = await api.signIn(owner);

  const made = await withTenant(api.tenantId, (tx) => records(tx, owner.userId));
  jobId = made.job;
  quoteId = made.quote;
  draftQuoteId = made.draftQuote;
  invoiceId = made.invoice;
  draftInvoiceId = made.draftInvoice;

  for (const module of ['sales', 'finance']) {
    await flag(api.tenantId, module, true);
  }
  for (const grant of ['website_jobs', 'website_quotes', 'website_invoices']) {
    await flag(api.tenantId, grant, true);
  }
  for (const name of ['websiteJobsEnabled', 'websiteQuotesEnabled', 'websiteInvoicesEnabled']) {
    await companySwitch(name, true);
  }
  ({ id: keyId, secret } = await makeKey(api.tenantId));
});

afterAll(async () => {
  await api.close();
});

const ROUTES = () =>
  [
    ['jobs', `/v1/website/jobs/${jobId}`, 'website_jobs', 'websiteJobsEnabled', undefined],
    ['quotes', `/v1/website/quotes/${quoteId}`, 'website_quotes', 'websiteQuotesEnabled', 'sales'],
    [
      'invoices',
      `/v1/website/invoices/${invoiceId}`,
      'website_invoices',
      'websiteInvoicesEnabled',
      'finance',
    ],
  ] as const;

describe('the website data routes', () => {
  it('answer one record each to a live key', async () => {
    const job = await website(secret, `/v1/website/jobs/${jobId}`);
    expect(job.statusCode, job.body).toBe(200);
    expect(json<{ title: string }>(job).title).toBe('Boiler repair');
    expect(job.headers['cache-control']).toBe('no-store');

    const quote = await website(secret, `/v1/website/quotes/${quoteId}`);
    expect(quote.statusCode, quote.body).toBe(200);
    expect(json<{ title: string; lines: unknown[] }>(quote).lines).toHaveLength(1);
    // Internal notes never leave.
    expect(quote.body).not.toContain('secret');

    const invoice = await website(secret, `/v1/website/invoices/${invoiceId}`);
    expect(invoice.statusCode, invoice.body).toBe(200);
    expect(json<{ reference: string }>(invoice).reference).toMatch(/^INV-/u);
  });

  it('refuse no key, a malformed key and a made-up key alike', async () => {
    for (const [, path] of ROUTES()) {
      for (const key of [null, 'not-a-key', `i8wk_${'x'.repeat(43)}`]) {
        const refused = await website(key, path);
        expect(refused.statusCode, `${path} ${String(key)}`).toBe(401);
        expect(code(refused)).toBe('website_key_invalid');
      }
    }
  });

  it('never show a draft quote or a draft invoice', async () => {
    const quote = await website(secret, `/v1/website/quotes/${draftQuoteId}`);
    expect(quote.statusCode).toBe(404);
    const invoice = await website(secret, `/v1/website/invoices/${draftInvoiceId}`);
    expect(invoice.statusCode).toBe(404);
    const unknown = await website(secret, `/v1/website/jobs/${randomUUID()}`);
    expect(unknown.statusCode).toBe(404);
  });

  it('need Integr8’s grant, the company’s switch and the module, each on its own', async () => {
    for (const [name, path, grant, setting, module] of ROUTES()) {
      await flag(api.tenantId, grant, false);
      const noGrant = await website(secret, path);
      expect(noGrant.statusCode, `${name} without the grant`).toBe(403);
      expect(code(noGrant)).toBe('feature_disabled');
      await flag(api.tenantId, grant, true);

      await companySwitch(setting, false);
      const noSwitch = await website(secret, path);
      expect(noSwitch.statusCode, `${name} without the company's switch`).toBe(403);
      expect(code(noSwitch)).toBe('feature_disabled');
      await companySwitch(setting, true);

      if (module !== undefined) {
        await flag(api.tenantId, module, false);
        const noModule = await website(secret, path);
        expect(noModule.statusCode, `${name} without the ${module} module`).toBe(403);
        expect(code(noModule)).toBe('feature_disabled');
        await flag(api.tenantId, module, true);
      }

      expect((await website(secret, path)).statusCode, `${name} back on`).toBe(200);
    }
  });

  it('keep another company’s records out of reach, and its key out of this one’s', async () => {
    const southgate = await getPlatformDataSource().tenants.create({
      slug: `web-other-${randomUUID().slice(0, 8)}`,
      name: 'Southgate Ltd',
    });
    for (const name of ['sales', 'finance', 'website_jobs', 'website_quotes', 'website_invoices']) {
      await flag(southgate.id, name, true);
    }
    await withTenant(southgate.id, (tx) =>
      tx.settings.update({
        websiteJobsEnabled: true,
        websiteQuotesEnabled: true,
        websiteInvoicesEnabled: true,
      }),
    );
    forgetTenantStatus(southgate.id);
    const theirs = await makeKey(southgate.id);

    // Southgate's key, this company's ids: not found, as if they did not exist.
    for (const [name, path] of ROUTES()) {
      const refused = await website(theirs.secret, path);
      expect(refused.statusCode, name).toBe(404);
    }
  });

  it('stop a key that is disabled or revoked', async () => {
    const path = `/v1/website/jobs/${jobId}`;
    const temporary = await makeKey(api.tenantId);
    const url = `/v1/platform/companies/${api.tenantId}/website-keys/${temporary.id}`;
    expect((await website(temporary.secret, path)).statusCode).toBe(200);

    const disabled = await api.call(manager.accessToken, {
      method: 'PATCH',
      url,
      payload: { enabled: false },
    });
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(code(await website(temporary.secret, path))).toBe('website_key_invalid');

    const revoked = await api.call(manager.accessToken, {
      method: 'POST',
      url: `${url}/revoke`,
      payload: {},
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(code(await website(temporary.secret, path))).toBe('website_key_invalid');
  });

  it('rate limit each key', async () => {
    const path = `/v1/website/jobs/${jobId}`;
    let limited: { statusCode: number; body: string } | undefined;
    for (let attempt = 0; attempt <= RATE_LIMIT + 5; attempt += 1) {
      const response = await website(secret, path);
      if (response.statusCode === 429) {
        limited = response;
        break;
      }
      expect(response.statusCode).toBe(200);
    }
    expect(limited, 'the key was never limited').toBeDefined();
  });
});

describe('who may manage website keys', () => {
  it('is a staff manager only; any staff may list them', async () => {
    const url = `/v1/platform/companies/${api.tenantId}/website-keys`;
    const listed = await api.call(staff.accessToken, { method: 'GET', url });
    expect(listed.statusCode).toBe(200);
    expect(json<{ canManage: boolean; canDelete: boolean }>(listed)).toMatchObject({
      canManage: false,
      canDelete: false,
    });

    const refusals = [
      await api.call(staff.accessToken, { method: 'POST', url, payload: {} }),
      await api.call(staff.accessToken, {
        method: 'PATCH',
        url: `${url}/${keyId}`,
        payload: { enabled: false },
      }),
      await api.call(staff.accessToken, {
        method: 'POST',
        url: `${url}/${keyId}/revoke`,
        payload: {},
      }),
      await api.call(staff.accessToken, { method: 'DELETE', url: `${url}/${keyId}` }),
    ];
    for (const refused of refusals) {
      expect(refused.statusCode, refused.body).toBe(403);
      expect(code(refused)).toBe('staff_manager_only');
    }
    // Nothing changed: the key still answers.
    const key = await getPlatformDataSource().websiteKeys.listForTenant(api.tenantId);
    expect(key.find((entry) => entry.id === keyId)).toMatchObject({
      enabled: true,
      revokedAt: null,
    });

    const managerListed = json<{ canManage: boolean }>(
      await api.call(manager.accessToken, { method: 'GET', url }),
    );
    expect(managerListed.canManage).toBe(true);
  });
});
