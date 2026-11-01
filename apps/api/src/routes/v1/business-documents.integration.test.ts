import { randomUUID } from 'node:crypto';
import { withTenant } from '@integr8/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RecordingPrinter } from '../../documents/printer.js';
import type { RecordingEmailSender } from '../../email/sender.js';
import { createLogger } from '../../http/logger.js';
import { buildJobHandlers } from '../../jobs/handlers.js';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Business PDFs over HTTP (1.3.0, decision 11): a quote, an invoice, a
 * purchase order and a job report printed by the worker in the company's look,
 * kept in the documents register, listed on their record, downloaded and
 * emailed. Each kind follows its own module's switch and permissions; a draft
 * is refused; a new PDF is not shareable until someone who may share asks; a
 * quote's PDF may carry the customer's live link.
 */

const WEB = 'https://app.test.integr8';

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let dispatcher: Member;
let engineer: Member;
let bystander: Member;
let viewer: Member;
let builder: string;
const tokens = new Map<Member, string>();
let customerId: string;

const json = <T>(response: { body: string }) => JSON.parse(response.body) as T;
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;
const tag = () => randomUUID().slice(0, 6);

interface DocumentBody {
  id: string;
  title: string;
  source: string;
  record: { kind: string; id: string } | null;
  reference: string | null;
  customer: { id: string; name: string } | null;
  shareable: boolean;
  status: 'pending' | 'ready' | 'failed';
  failureCode: string | null;
  publicCode: string;
  pageCount: number | null;
  fields: { key: string; value: string; lookupRole: string | null }[];
}

interface ListBody {
  items: DocumentBody[];
  can: { make: boolean; email: boolean; share: boolean };
  email: string | null;
  language: 'en' | 'ar';
}

async function token(who: Member): Promise<string> {
  let value = tokens.get(who);
  if (value === undefined) {
    value = await api.signIn(who);
    tokens.set(who, value);
  }
  return value;
}

async function as(
  who: Member | string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
) {
  return api.call(typeof who === 'string' ? who : await token(who), {
    method,
    url,
    headers,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
}

async function setFlag(key: string, enabled: boolean) {
  const response = await api.call(admin.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/${key}`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

function make(who: Member, payload: Record<string, unknown>) {
  return as(who, 'POST', '/v1/business-documents', payload, {
    'idempotency-key': randomUUID(),
  });
}

async function list(who: Member, kind: string, recordId: string) {
  return as(who, 'GET', `/v1/business-documents?kind=${kind}&recordId=${recordId}`);
}

const ran = new Set<string>();

/** Runs the print jobs the API queued since the last run, through the handler the worker uses. */
async function runPrintJobs() {
  const jobs = (
    await withTenant(api.tenantId, (tx) =>
      tx.jobs.list({ queue: 'documents.render_business', status: 'pending' }),
    )
  ).filter((job) => !ran.has(job.id));
  const handlers = buildJobHandlers(api.services, api.config);
  for (const job of jobs) {
    await handlers['documents.render_business']!(job.payload, {
      tenantId: api.tenantId,
      jobId: job.id,
      attempt: 1,
      logger: createLogger({ level: 'error', write: () => undefined }),
    });
    ran.add(job.id);
  }
  return jobs;
}

beforeAll(async () => {
  api = await startApi({ env: { PDF_RENDERER: 'recording', WEB_APP_URL: WEB } });
  admin = await api.platformAdmin('biz-staff');
  owner = await api.member('owner', 'biz-owner');
  dispatcher = await api.member('dispatcher', 'biz-dispatcher');
  engineer = await api.member('engineer', 'biz-engineer');
  bystander = await api.member('engineer', 'biz-bystander');
  viewer = await api.member('viewer', 'biz-viewer');
  builder = await api.staff(owner);
  const customer = await as(dispatcher, 'POST', '/v1/customers', {
    name: 'Horizon Business Park',
    email: 'accounts@horizon.example',
    address: { line1: 'Building B2, 90th Street', city: 'New Cairo', countryCode: 'EG' },
  });
  expect(customer.statusCode, customer.body).toBe(201);
  customerId = json<{ id: string }>(customer).id;
});

afterAll(async () => {
  await api.close();
});

describe('the documents module', () => {
  it('keeps the register, so business PDFs wait for it', async () => {
    await setFlag('sales', true);
    await setFlag('inventory', true);
    await setFlag('crm', true);
    await setFlag('finance', true);
    await setFlag('purchasing', true);
    const refused = await list(owner, 'quote', randomUUID());
    expect(refused.statusCode).toBe(403);
    expect(code(refused)).toBe('feature_disabled');
    await setFlag('documents', true);
  });
});

describe('a quote', () => {
  let quoteId: string;
  let acceptToken: string;
  let made: DocumentBody;

  it('is refused while a draft, then printed once issued', async () => {
    const drafted = await as(dispatcher, 'POST', '/v1/sales/quotes', {
      customerId,
      title: `Quarterly service ${tag()}`,
      terms: 'Payment within 30 days.',
      lines: [
        { description: 'Quarterly service', quantity: '2', unitPrice: '4500', taxRateBp: 1400 },
      ],
    });
    expect(drafted.statusCode, drafted.body).toBe(201);
    const draft = json<{ quote: { id: string; version: number } }>(drafted);
    quoteId = draft.quote.id;

    const tooEarly = await make(dispatcher, { kind: 'quote', recordId: quoteId });
    expect(tooEarly.statusCode).toBe(409);
    expect(code(tooEarly)).toBe('business_document_draft');

    const issued = await as(owner, 'POST', `/v1/sales/quotes/${quoteId}/issue`, {
      expectedVersion: draft.quote.version,
    });
    expect(issued.statusCode, issued.body).toBe(200);
    acceptToken = json<{ acceptToken: string }>(issued).acceptToken;

    // A viewer reads quotes but makes nothing; an engineer cannot read them.
    expect((await make(viewer, { kind: 'quote', recordId: quoteId })).statusCode).toBe(403);
    expect((await make(engineer, { kind: 'quote', recordId: quoteId })).statusCode).toBe(403);
    // Sharing at once needs `document.upload`, which a dispatcher does not hold.
    const sharing = await make(dispatcher, { kind: 'quote', recordId: quoteId, shareable: true });
    expect(sharing.statusCode).toBe(403);

    const response = await make(dispatcher, { kind: 'quote', recordId: quoteId, language: 'ar' });
    expect(response.statusCode, response.body).toBe(202);
    made = json<DocumentBody>(response);
    expect(made).toMatchObject({
      source: 'quote',
      record: { kind: 'quote', id: quoteId },
      customer: { id: customerId },
      shareable: false,
      status: 'pending',
    });
    expect(made.reference).toMatch(/^QT-\d{6}$/u);
    expect(made.title).toBe(`عرض سعر ${made.reference ?? ''}`);
    expect(made.fields.map((field) => field.key).sort()).toEqual(['customer', 'reference']);
    expect(made.fields.every((field) => field.lookupRole === null)).toBe(true);
  });

  it('is printed by the worker in Arabic, with its own page in the QR code', async () => {
    const printer = api.services.pdf as RecordingPrinter;
    const before = printer.printed.length;
    const jobs = await runPrintJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({
      qrUrl: `${WEB}/d/${made.publicCode}`,
      qrOpensQuote: false,
      locale: 'ar',
    });
    const printed = printer.printed[before]!;
    expect(printed.html).toContain('dir="rtl"');
    expect(printed.html).toContain(made.reference);
    expect(printed.headerHtml).toBeDefined();
    expect(printed.footerHtml).toContain('pageNumber');

    const ready = json<DocumentBody>(await as(dispatcher, 'GET', `/v1/documents/${made.id}`));
    expect(ready).toMatchObject({ status: 'ready', pageCount: 1 });
    // Not shared: its QR code's page answers as if it did not exist.
    const outside = await api.app.inject({
      method: 'GET',
      url: `/v1/public/documents/${made.publicCode}`,
      headers: { 'x-client-version': '1.0.0', 'x-client-app': 'web' },
      remoteAddress: api.remoteAddress,
    });
    expect(outside.statusCode).toBe(404);
  });

  it('can carry the customer’s live link instead, but only the live one', async () => {
    const wrong = await make(owner, {
      kind: 'quote',
      recordId: quoteId,
      quoteLinkToken: 'x'.repeat(43),
    });
    expect(wrong.statusCode).toBe(422);
    expect(code(wrong)).toBe('quote_link_invalid');
    const right = await make(owner, {
      kind: 'quote',
      recordId: quoteId,
      quoteLinkToken: acceptToken,
      shareable: true,
    });
    expect(right.statusCode, right.body).toBe(202);
    expect(json<DocumentBody>(right).shareable).toBe(true);
    const [job] = await runPrintJobs();
    expect(job!.payload).toMatchObject({ qrUrl: `${WEB}/q/${acceptToken}`, qrOpensQuote: true });
  });

  it('is listed on the quote for those who read quotes, and in the register', async () => {
    const forViewer = await list(viewer, 'quote', quoteId);
    expect(forViewer.statusCode, forViewer.body).toBe(200);
    const body = json<ListBody>(forViewer);
    expect(body.items).toHaveLength(2);
    expect(body.can).toEqual({ make: false, email: false, share: false });
    expect(body.email).toBeNull();
    const forDispatcher = json<ListBody>(await list(dispatcher, 'quote', quoteId));
    expect(forDispatcher.can).toEqual({ make: true, email: true, share: false });
    expect((await list(engineer, 'quote', quoteId)).statusCode).toBe(403);

    const link = await as(viewer, 'GET', `/v1/business-documents/${made.id}/file`);
    expect(link.statusCode, link.body).toBe(200);
    const register = json<{ items: DocumentBody[] }>(
      await as(owner, 'GET', '/v1/documents?source=quote'),
    );
    expect(register.items.map((item) => item.id)).toContain(made.id);
  });

  it('is emailed as an attachment by someone who manages quotes', async () => {
    const outbox = api.services.email as RecordingEmailSender;
    const refused = await as(viewer, 'POST', `/v1/business-documents/${made.id}/email`, {
      to: 'mona@horizon.example',
    });
    expect(refused.statusCode).toBe(403);
    const sent = await as(
      dispatcher,
      'POST',
      `/v1/business-documents/${made.id}/email`,
      { to: 'mona@horizon.example', message: 'As discussed on site.' },
      { 'idempotency-key': randomUUID() },
    );
    expect(sent.statusCode, sent.body).toBe(200);
    expect(json<{ sent: boolean }>(sent).sent).toBe(true);
    const message = outbox.lastTo('mona@horizon.example')!;
    expect(message.subject).toContain(made.title);
    expect(message.text).toContain('As discussed on site.');
    expect(message.replyTo).toContain('@');
    expect(message.attachments).toHaveLength(1);
    const attachment = message.attachments![0]!;
    expect(attachment.filename).toBe(`${made.title}.pdf`);
    expect(Buffer.from(attachment.content.subarray(0, 5)).toString('latin1')).toBe('%PDF-');
  });
});

describe('an invoice', () => {
  it('is printed once issued, and not by those who only read invoices', async () => {
    const drafted = await as(
      dispatcher,
      'POST',
      '/v1/finance/invoices',
      {
        customerId,
        lines: [
          { description: 'Annual service', quantity: '2', unitPrice: '100', taxRateBp: 1400 },
        ],
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(drafted.statusCode, drafted.body).toBe(201);
    const draft = json<{ invoice: { id: string; version: number } }>(drafted);
    expect(
      (await make(dispatcher, { kind: 'invoice', recordId: draft.invoice.id })).statusCode,
    ).toBe(409);
    const issued = await as(owner, 'POST', `/v1/finance/invoices/${draft.invoice.id}/issue`, {
      expectedVersion: draft.invoice.version,
    });
    expect(issued.statusCode, issued.body).toBe(200);
    expect((await make(viewer, { kind: 'invoice', recordId: draft.invoice.id })).statusCode).toBe(
      403,
    );
    const response = await make(dispatcher, { kind: 'invoice', recordId: draft.invoice.id });
    expect(response.statusCode, response.body).toBe(202);
    const made = json<DocumentBody>(response);
    expect(made.reference).toMatch(/^INV-\d{6}$/u);
    expect(made.title).toBe(`Invoice ${made.reference ?? ''}`);
    await runPrintJobs();
    const printer = api.services.pdf as RecordingPrinter;
    expect(printer.printed.at(-1)!.html).toContain('Bill to');

    // Emailing waits for the PDF; this one is ready.
    const listed = json<ListBody>(await list(dispatcher, 'invoice', draft.invoice.id));
    expect(listed.items[0]).toMatchObject({ id: made.id, status: 'ready' });
  });

  it('cannot be emailed before it is printed', async () => {
    const drafted = await as(
      dispatcher,
      'POST',
      '/v1/finance/invoices',
      { customerId, lines: [{ description: 'Call-out', quantity: '1', unitPrice: '50' }] },
      { 'idempotency-key': randomUUID() },
    );
    const draft = json<{ invoice: { id: string; version: number } }>(drafted);
    await as(owner, 'POST', `/v1/finance/invoices/${draft.invoice.id}/issue`, {
      expectedVersion: draft.invoice.version,
    });
    const made = json<DocumentBody>(
      await make(dispatcher, { kind: 'invoice', recordId: draft.invoice.id }),
    );
    const early = await as(dispatcher, 'POST', `/v1/business-documents/${made.id}/email`, {
      to: 'accounts@horizon.example',
    });
    expect(early.statusCode).toBe(409);
    expect(code(early)).toBe('document_not_ready');
    await runPrintJobs();
  });
});

describe('a purchase order', () => {
  it('is printed once approved, for those who see its prices, and names the supplier’s email', async () => {
    const supplier = await as(dispatcher, 'POST', '/v1/purchasing/suppliers', {
      name: `Delta HVAC Parts ${tag()}`,
      email: 'orders@deltahvac.example',
    });
    expect(supplier.statusCode, supplier.body).toBe(201);
    const item = await as(dispatcher, 'POST', '/v1/inventory/items', {
      sku: `FLT-${tag()}`,
      name: 'G4 air filter',
    });
    expect(item.statusCode, item.body).toBe(201);
    const ordered = await as(dispatcher, 'POST', '/v1/purchasing/orders', {
      supplierId: json<{ id: string }>(supplier).id,
      lines: [
        {
          itemId: json<{ id: string }>(item).id,
          quantityOrdered: '48',
          unitPrice: '120',
          taxRateBp: 1400,
        },
      ],
    });
    expect(ordered.statusCode, ordered.body).toBe(201);
    const order = json<{ order: { id: string; version: number } }>(ordered);
    expect(
      (await make(dispatcher, { kind: 'purchase_order', recordId: order.order.id })).statusCode,
    ).toBe(409);
    const approved = await as(owner, 'POST', `/v1/purchasing/orders/${order.order.id}/approve`, {
      expectedVersion: order.order.version,
    });
    expect(approved.statusCode, approved.body).toBe(200);

    const response = await make(dispatcher, { kind: 'purchase_order', recordId: order.order.id });
    expect(response.statusCode, response.body).toBe(202);
    const made = json<DocumentBody>(response);
    expect(made).toMatchObject({ source: 'purchase_order', customer: null });
    expect(made.reference).toMatch(/^PO-\d{6}$/u);
    expect(made.fields.find((field) => field.key === 'supplier')?.value).toContain('Delta HVAC');
    await runPrintJobs();
    expect((api.services.pdf as RecordingPrinter).printed.at(-1)!.html).toContain(
      'orders@deltahvac.example',
    );

    const listed = json<ListBody>(await list(dispatcher, 'purchase_order', order.order.id));
    expect(listed.email).toBe('orders@deltahvac.example');
    // An engineer has no purchasing; a viewer reads orders but not their prices.
    expect((await list(engineer, 'purchase_order', order.order.id)).statusCode).toBe(403);
    expect((await list(viewer, 'purchase_order', order.order.id)).statusCode).toBe(403);
  });
});

describe('a job report', () => {
  let jobId: string;

  it('is made by those on the job and the office, not by a bystander or a viewer', async () => {
    const jobType = await as(builder, 'POST', '/v1/job-types', {
      name: `Planned maintenance ${tag()}`,
      code: `pm-${tag()}`,
      checklist: [{ label: 'Clean coils' }],
    });
    expect(jobType.statusCode, jobType.body).toBe(201);
    const site = await as(dispatcher, 'POST', `/v1/customers/${customerId}/sites`, {
      name: 'Building B2',
      address: { line1: 'Building B2, 90th Street', city: 'New Cairo', countryCode: 'EG' },
    });
    expect(site.statusCode, site.body).toBe(201);
    const created = await as(dispatcher, 'POST', '/v1/work-orders', {
      customerId,
      siteId: json<{ id: string }>(site).id,
      jobTypeId: json<{ id: string }>(jobType).id,
      title: 'Quarterly service – rooftop units',
      crew: [{ userId: engineer.userId, lead: true }],
    });
    expect(created.statusCode, created.body).toBe(201);
    jobId = json<{ workOrder: { id: string } }>(created).workOrder.id;
    const comment = await as(dispatcher, 'POST', `/v1/work-orders/${jobId}/comments`, {
      body: 'Filters replaced on both units.',
      visibility: 'customer',
    });
    expect(comment.statusCode, comment.body).toBe(200);
    await as(dispatcher, 'POST', `/v1/work-orders/${jobId}/comments`, {
      body: 'Internal: customer slow to pay.',
      visibility: 'internal',
    });

    expect((await make(viewer, { kind: 'job_report', recordId: jobId })).statusCode).toBe(403);
    expect((await make(bystander, { kind: 'job_report', recordId: jobId })).statusCode).toBe(404);
    const response = await make(engineer, { kind: 'job_report', recordId: jobId });
    expect(response.statusCode, response.body).toBe(202);
    const made = json<DocumentBody>(response);
    expect(made).toMatchObject({
      source: 'job_report',
      record: { kind: 'job_report', id: jobId },
      customer: { id: customerId },
    });
    expect(made.reference).toMatch(/^WO-\d+/u);
    await runPrintJobs();
    const html = (api.services.pdf as RecordingPrinter).printed.at(-1)!.html;
    expect(html).toContain('Horizon Business Park');
    expect(html).toContain('Building B2');
    expect(html).toContain('Filters replaced on both units.');
    expect(html).not.toContain('slow to pay');
    expect(html).toContain('Clean coils');
  });

  it('is listed for those who may read the job, and emailed only by the office', async () => {
    const forViewer = json<ListBody>(await list(viewer, 'job_report', jobId));
    expect(forViewer.items).toHaveLength(1);
    expect(forViewer.can).toMatchObject({ make: false, email: false });
    const forEngineer = json<ListBody>(await list(engineer, 'job_report', jobId));
    expect(forEngineer.can).toMatchObject({ make: true, email: false });
    expect((await list(bystander, 'job_report', jobId)).statusCode).toBe(404);
    const forDispatcher = json<ListBody>(await list(dispatcher, 'job_report', jobId));
    expect(forDispatcher.email).toBe('accounts@horizon.example');
    const documentId = forViewer.items[0]!.id;
    const refused = await as(engineer, 'POST', `/v1/business-documents/${documentId}/email`, {
      to: 'accounts@horizon.example',
    });
    expect(refused.statusCode).toBe(403);
    const sent = await as(dispatcher, 'POST', `/v1/business-documents/${documentId}/email`, {
      to: 'accounts@horizon.example',
    });
    expect(json<{ sent: boolean }>(sent).sent).toBe(true);
  });
});
