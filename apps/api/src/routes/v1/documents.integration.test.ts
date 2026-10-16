import { randomUUID } from 'node:crypto';
import { withTenant } from '@integr8/db';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderDocument } from '../../documents/render.js';
import { ChromiumPrinter, type RecordingPrinter } from '../../documents/printer.js';
import { createLogger } from '../../http/logger.js';
import { buildJobHandlers } from '../../jobs/handlers.js';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * PDF documents over HTTP (docs/documents ADR-0001): the module switch;
 * templates only for staff, checked against the form; making a document from
 * a submission with typed and taken fields; the worker printing it into the
 * company's bucket and ledger; the register's search, expiry and deletion;
 * the QR code's public link; website keys issued only by the terminal account;
 * and the website lookup that finds one document or none.
 */

const WEB = 'https://app.test.integr8';

let api: ApiHarness;
let admin: PlatformAdmin;
let manager: PlatformAdmin;
let owner: Member;
let engineer: Member;
let viewer: Member;
let builder: string;
const tokens = new Map<Member, string>();
let formId: string;
let submissionId: string;
let draftId: string;
let templateId: string;
let backgroundId: string;

const json = <T>(response: { body: string }) => JSON.parse(response.body) as T;
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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

async function setFlag(enabled: boolean) {
  const response = await api.call(admin.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/documents`,
    payload: { enabled },
  });
  expect(response.statusCode, response.body).toBe(200);
}

async function upload(who: Member | string, bytes: Buffer, contentType: string) {
  const created = await as(who, 'POST', '/v1/media', { contentType, byteSize: bytes.length });
  expect(created.statusCode, created.body).toBe(201);
  const { media, upload: target } = json<{
    media: { id: string };
    upload: { url: string; headers: Record<string, string> };
  }>(created);
  const url = new URL(target.url);
  const put = await api.app.inject({
    method: 'PUT',
    url: url.pathname + url.search,
    headers: target.headers,
    payload: bytes,
    remoteAddress: api.remoteAddress,
  });
  expect(put.statusCode, put.body).toBe(200);
  const completed = await as(who, 'POST', `/v1/media/${media.id}/complete`);
  expect(completed.statusCode, completed.body).toBe(200);
  return media.id;
}

const picture = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 200, g: 220, b: 240 } } })
    .png()
    .toBuffer();

const definition = {
  schemaVersion: 1,
  title: { en: 'Gas safety certificate' },
  pages: [
    {
      id: 'page_1',
      sections: [
        {
          id: 'section_1',
          fields: [
            { id: 'customer', type: 'text', label: { en: 'Customer' } },
            {
              id: 'result',
              type: 'radio',
              label: { en: 'Result' },
              options: [
                { value: 'pass', label: { en: 'Pass' } },
                { value: 'fail', label: { en: 'Fail' } },
              ],
            },
            { id: 'photos', type: 'photo', label: { en: 'Photos' } },
          ],
        },
      ],
    },
  ],
};

function design(background: string | null, extra: Record<string, unknown>[] = []) {
  return {
    schemaVersion: 1,
    page: {
      size: 'A4',
      margins: { top: 25, end: 15, bottom: 20, start: 15 },
      background: background === null ? null : { fileId: background },
      firstPage: null,
      language: 'en',
      fontSize: 10,
      footer: { pageNumbers: true },
    },
    fields: [
      {
        key: 'certificate',
        label: { en: 'Certificate number', ar: 'رقم الشهادة' },
        source: { kind: 'typed', required: true, maxLength: 40 },
        lookup: 'key',
      },
      {
        key: 'customer',
        label: { en: 'Customer' },
        source: { kind: 'answer', fieldId: 'customer' },
        lookup: 'confirm',
      },
    ],
    blocks: [
      { type: 'heading', id: 'title', text: { en: 'Certificate {{field.certificate}}' }, level: 1 },
      { type: 'field', id: 'result', fieldId: 'result', layout: 'inline' },
      { type: 'image', id: 'photos', source: { kind: 'answer', fieldId: 'photos' }, width: 60 },
      { type: 'qr', id: 'qr', size: 30, align: 'end' },
      ...extra,
    ],
  };
}

async function publishForm() {
  const created = await as(builder, 'POST', '/v1/forms', { title: 'Gas safety certificate' });
  expect(created.statusCode, created.body).toBe(201);
  const id = json<{ form: { id: string } }>(created).form.id;
  const detail = json<{ draft: { revision: number } | null }>(
    await as(builder, 'GET', `/v1/forms/${id}`),
  );
  const saved = await as(builder, 'PUT', `/v1/forms/${id}/draft`, {
    definition,
    expectedRevision: detail.draft?.revision ?? null,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const published = await as(builder, 'POST', `/v1/forms/${id}/draft/publish`, {
    expectedRevision: json<{ revision: number }>(saved).revision,
    acknowledgeBreakingChanges: false,
  });
  expect(published.statusCode, published.body).toBe(200);
  return id;
}

async function submission(answers: Record<string, unknown>, finish = true) {
  const started = await as(engineer, 'POST', '/v1/submissions', { formId });
  expect(started.statusCode, started.body).toBe(201);
  const draft = json<{ submission: { id: string; revision: number } }>(started).submission;
  if (!finish) {
    return draft.id;
  }
  const submitted = await as(engineer, 'POST', `/v1/submissions/${draft.id}/submit`, {
    expectedRevision: draft.revision,
    answers,
  });
  expect(submitted.statusCode, submitted.body).toBe(200);
  return draft.id;
}

interface DocumentBody {
  id: string;
  title: string;
  status: 'pending' | 'ready' | 'failed';
  failureCode: string | null;
  linkOpens: boolean;
  link: string | null;
  publicCode: string;
  pageCount: number | null;
  byteSize: number | null;
  fields: { key: string; value: string; lookupRole: string | null }[];
}

async function makeDocument(
  certificate: string,
  extra: Record<string, unknown> = {},
  who: Member = engineer,
) {
  return as(
    who,
    'POST',
    `/v1/submissions/${submissionId}/documents`,
    { templateId, fields: { certificate }, ...extra },
    { 'idempotency-key': randomUUID() },
  );
}

/** Runs the render job the export queued, through the handler the worker uses. */
async function runRenderJobs() {
  const jobs = await withTenant(api.tenantId, (tx) =>
    tx.jobs.list({ queue: 'documents.render', status: 'pending' }),
  );
  const handlers = buildJobHandlers(api.services, api.config);
  for (const job of jobs) {
    await handlers['documents.render']!(job.payload, {
      tenantId: api.tenantId,
      jobId: job.id,
      attempt: 1,
      logger: createLogger({ level: 'error', write: () => undefined }),
    });
  }
  return jobs.length;
}

async function fetchSigned(url: string) {
  const target = new URL(url);
  return api.app.inject({
    method: 'GET',
    url: target.pathname + target.search,
    remoteAddress: api.remoteAddress,
  });
}

beforeAll(async () => {
  api = await startApi({ env: { PDF_RENDERER: 'recording', WEB_APP_URL: WEB } });
  admin = await api.platformAdmin('ops');
  manager = await api.platformAdmin('boss', { manager: true });
  owner = await api.member('owner', 'owner');
  engineer = await api.member('engineer', 'engineer');
  viewer = await api.member('viewer', 'viewer');
  builder = await api.staff(owner);
  formId = await publishForm();
  const photoBytes = await picture(900, 600);
  const photo = await upload(engineer, photoBytes, 'image/png');
  submissionId = await submission({
    customer: 'Nile Towers',
    result: 'pass',
    photos: [{ mediaId: photo, contentType: 'image/png', byteSize: photoBytes.length }],
  });
  draftId = await submission({}, false);
  backgroundId = await upload(builder, await picture(620, 877), 'image/png');
});

afterAll(async () => {
  await api.close();
});

describe('the module switch', () => {
  it('refuses every documents route until documents are switched on', async () => {
    const refused = await as(owner, 'GET', '/v1/documents');
    expect(refused.statusCode).toBe(403);
    expect(code(refused)).toBe('feature_disabled');
    await setFlag(true);
    expect((await as(owner, 'GET', '/v1/documents')).statusCode).toBe(200);
  });
});

describe('templates', () => {
  it('are designed by staff only', async () => {
    const refused = await as(owner, 'POST', '/v1/document-templates', {
      formId,
      name: 'Certificate',
    });
    expect(refused.statusCode).toBe(403);
  });

  it('are checked against the form, then saved with their pictures', async () => {
    const wrong = await as(builder, 'POST', '/v1/document-templates', {
      formId,
      name: 'Certificate',
      design: design(null, [{ type: 'field', id: 'ghost', fieldId: 'ghost' }]),
    });
    expect(wrong.statusCode, wrong.body).toBe(422);
    expect(code(wrong)).toBe('document_template_invalid');
    const details = json<{ error: { details: { params: { problem: string } }[] } }>(wrong).error
      .details;
    expect(details.map((detail) => detail.params.problem)).toContain('unknown_field');

    const created = await as(
      builder,
      'POST',
      '/v1/document-templates',
      { formId, name: 'Certificate', design: design(backgroundId) },
      { 'idempotency-key': randomUUID() },
    );
    expect(created.statusCode, created.body).toBe(201);
    const template = json<{ id: string; revision: number; design: { fields: unknown[] } }>(created);
    templateId = template.id;
    expect(template.revision).toBe(1);
    expect(template.design.fields).toHaveLength(2);

    const background = await withTenant(api.tenantId, (tx) => tx.files.find(backgroundId));
    expect(background?.linkedEntityType).toBe('document_template');
    expect(background?.linkedEntityId).toBe(templateId);
  });

  it('refuse a save over someone else’s', async () => {
    const first = await as(builder, 'PATCH', `/v1/document-templates/${templateId}`, {
      revision: 1,
      name: 'Gas certificate',
    });
    expect(first.statusCode, first.body).toBe(200);
    const stale = await as(builder, 'PATCH', `/v1/document-templates/${templateId}`, {
      revision: 1,
      name: 'Gas certificate (old)',
    });
    expect(stale.statusCode).toBe(409);
    expect(code(stale)).toBe('document_template_changed');
  });

  it('are listed for whoever makes documents', async () => {
    const listed = json<{ items: { id: string; name: string }[] }>(
      await as(engineer, 'GET', `/v1/document-templates?formId=${formId}`),
    );
    expect(listed.items.map((item) => item.name)).toEqual(['Gas certificate']);
    expect((await as(viewer, 'GET', '/v1/document-templates')).statusCode).toBe(403);
  });
});

let document: DocumentBody;

describe('making a document', () => {
  it('needs the typed fields the template requires', async () => {
    const refused = await as(
      engineer,
      'POST',
      `/v1/submissions/${submissionId}/documents`,
      { templateId, fields: {} },
      { 'idempotency-key': randomUUID() },
    );
    expect(refused.statusCode, refused.body).toBe(422);
    expect(code(refused)).toBe('document_fields_invalid');
    expect(json<{ error: { details: { field: string }[] } }>(refused).error.details[0]?.field).toBe(
      'body.fields.certificate',
    );
  });

  it('is refused for a draft and for a seat without document.create', async () => {
    const draft = await as(
      engineer,
      'POST',
      `/v1/submissions/${draftId}/documents`,
      { templateId, fields: { certificate: 'X' } },
      { 'idempotency-key': randomUUID() },
    );
    expect(draft.statusCode).toBe(409);
    expect(code(draft)).toBe('submission_draft');
    expect((await makeDocument('GS-1', {}, viewer)).statusCode).toBe(403);
  });

  it('starts pending, with its fields and its link', async () => {
    const made = await makeDocument('GS-2026-0042');
    expect(made.statusCode, made.body).toBe(202);
    document = json<DocumentBody>(made);
    expect(document.status).toBe('pending');
    expect(document.title).toBe('Gas certificate · GS-2026-0042');
    expect(document.publicCode).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(document.link).toBe(`${WEB}/d/${document.publicCode}`);
    expect(document.fields).toEqual([
      expect.objectContaining({ key: 'certificate', value: 'GS-2026-0042', lookupRole: 'key' }),
      expect.objectContaining({ key: 'customer', value: 'Nile Towers', lookupRole: 'confirm' }),
    ]);
  });

  it('is printed by the worker into the company’s bucket and ledger', async () => {
    expect(await runRenderJobs()).toBeGreaterThan(0);
    const ready = json<DocumentBody>(await as(engineer, 'GET', `/v1/documents/${document.id}`));
    expect(ready.status).toBe('ready');
    expect(ready.pageCount).toBe(1);
    expect(ready.byteSize).toBeGreaterThan(0);
    expect(ready.linkOpens).toBe(true);

    const printer = api.services.pdf as RecordingPrinter;
    const printed = printer.printed.at(-1)!;
    expect(printed.html).toContain('Certificate GS-2026-0042');
    expect(printed.html).toContain('<svg');
    expect(printed.html).toMatch(/data:image\/(png|jpeg);base64,/u);

    const link = json<{ url: string }>(
      await as(viewer, 'GET', `/v1/documents/${document.id}/file?disposition=attachment`),
    );
    const file = await fetchSigned(link.url);
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(String(file.headers['content-disposition'])).toContain('attachment;');
    expect(String(file.headers['content-disposition'])).toContain('GS-2026-0042.pdf');
    const pdf = await PDFDocument.load(file.rawPayload);
    expect(pdf.getPageCount()).toBe(1);
    expect(pdf.getTitle()).toBe('Gas certificate · GS-2026-0042');
  });
});

describe('the register', () => {
  it('finds documents by their fields and title', async () => {
    const byField = json<{ items: { id: string }[] }>(
      await as(viewer, 'GET', '/v1/documents?q=gs-2026-0042&fieldKey=certificate'),
    );
    expect(byField.items.map((item) => item.id)).toEqual([document.id]);
    const byCustomer = json<{ items: { id: string }[] }>(
      await as(viewer, 'GET', '/v1/documents?q=nile%20towers'),
    );
    expect(byCustomer.items.map((item) => item.id)).toContain(document.id);
    const none = json<{ items: unknown[] }>(await as(viewer, 'GET', '/v1/documents?q=nothing'));
    expect(none.items).toEqual([]);
    const active = json<{ items: { id: string }[] }>(
      await as(viewer, 'GET', '/v1/documents?state=active'),
    );
    expect(active.items.map((item) => item.id)).toContain(document.id);
  });
});

describe('the QR code’s public link', () => {
  it('opens for anyone with the code', async () => {
    const opened = await api.app.inject({
      method: 'GET',
      url: `/v1/public/documents/${document.publicCode}`,
      remoteAddress: api.remoteAddress,
    });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(json<{ company: { name: string }; document: { title: string } }>(opened)).toMatchObject({
      company: { name: 'API Test Ltd' },
      document: { title: 'Gas certificate · GS-2026-0042', formTitle: 'Gas safety certificate' },
    });
    const file = await api.app.inject({
      method: 'GET',
      url: `/v1/public/documents/${document.publicCode}/file?download=true`,
      remoteAddress: api.remoteAddress,
    });
    expect(file.statusCode).toBe(302);
    const pdf = await fetchSigned(String(file.headers.location));
    expect(pdf.statusCode).toBe(200);
    expect(String(pdf.headers['content-disposition'])).toContain('attachment;');
  });

  it('stops when expired, by a person or by date, and opens again when undone', async () => {
    const publicCall = () =>
      api.app.inject({
        method: 'GET',
        url: `/v1/public/documents/${document.publicCode}`,
        remoteAddress: api.remoteAddress,
      });
    expect(
      (await as(engineer, 'POST', `/v1/documents/${document.id}/expire`, { expired: true }))
        .statusCode,
    ).toBe(403);
    const expired = await as(owner, 'POST', `/v1/documents/${document.id}/expire`, {
      expired: true,
    });
    expect(json<DocumentBody>(expired).linkOpens).toBe(false);
    const gone = await publicCall();
    expect(gone.statusCode).toBe(410);
    expect(code(gone)).toBe('document_expired');
    await as(owner, 'POST', `/v1/documents/${document.id}/expire`, { expired: false });
    expect((await publicCall()).statusCode).toBe(200);

    await as(owner, 'PATCH', `/v1/documents/${document.id}`, {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect((await publicCall()).statusCode).toBe(410);
    await as(owner, 'PATCH', `/v1/documents/${document.id}`, { expiresAt: null });
    expect((await publicCall()).statusCode).toBe(200);
  });

  it('answers an unknown code like any other', async () => {
    const unknown = await api.app.inject({
      method: 'GET',
      url: `/v1/public/documents/${'a'.repeat(22)}`,
      remoteAddress: api.remoteAddress,
    });
    expect(unknown.statusCode).toBe(404);
  });
});

describe('website keys and the website lookup', () => {
  let secret: string;
  let keyId: string;
  const lookup = (key: string | null, body: Record<string, unknown>) =>
    api.app.inject({
      method: 'POST',
      url: '/v1/website/documents/lookup',
      remoteAddress: api.remoteAddress,
      headers: key === null ? {} : { authorization: `Bearer ${key}` },
      payload: body,
    });

  it('are made only by the terminal account, and shown once', async () => {
    const url = `/v1/platform/companies/${api.tenantId}/website-keys`;
    const refused = await api.call(admin.accessToken, { method: 'POST', url, payload: {} });
    expect(refused.statusCode).toBe(403);
    expect(code(refused)).toBe('staff_manager_only');

    const made = await api.call(manager.accessToken, {
      method: 'POST',
      url,
      payload: { label: 'nile-website' },
    });
    expect(made.statusCode, made.body).toBe(201);
    const body = json<{ key: { id: string; hint: string }; secret: string }>(made);
    secret = body.secret;
    keyId = body.key.id;
    expect(secret).toMatch(/^i8wk_[A-Za-z0-9_-]{43}$/u);
    expect(body.key.hint).toBe(secret.slice(-4));

    const listed = json<{ items: { hint: string }[]; canManage: boolean }>(
      await api.call(admin.accessToken, { method: 'GET', url }),
    );
    expect(listed.canManage).toBe(false);
    expect(listed.items.map((item) => item.hint)).toEqual([secret.slice(-4)]);
    expect(JSON.stringify(listed)).not.toContain(secret);

    await api.call(manager.accessToken, { method: 'POST', url, payload: {} });
    const third = await api.call(manager.accessToken, { method: 'POST', url, payload: {} });
    expect(third.statusCode).toBe(409);
    expect(code(third)).toBe('website_key_limit');
  });

  it('finds one document by its key field and the confirming field, or none', async () => {
    const found = await lookup(secret, {
      key: { field: 'certificate', value: '  gs-2026-0042 ' },
      confirm: { field: 'customer', value: 'NILE towers' },
    });
    expect(found.statusCode, found.body).toBe(200);
    const body = json<{ found: boolean; document: { link: string; viewUrl: string } }>(found);
    expect(body.found).toBe(true);
    expect(body.document.link).toBe(`${WEB}/d/${document.publicCode}`);
    expect((await fetchSigned(body.document.viewUrl)).statusCode).toBe(200);

    const unconfirmed = json<{ found: boolean }>(
      await lookup(secret, { key: { field: 'certificate', value: 'GS-2026-0042' } }),
    );
    expect(unconfirmed.found).toBe(false);
    const wrong = json<{ found: boolean; document: null }>(
      await lookup(secret, {
        key: { field: 'certificate', value: 'GS-2026-9999' },
        confirm: { field: 'customer', value: 'Nile Towers' },
      }),
    );
    expect(wrong).toEqual({ found: false, document: null });
  });

  it('does not find an expired document', async () => {
    await as(owner, 'POST', `/v1/documents/${document.id}/expire`, { expired: true });
    const hidden = json<{ found: boolean }>(
      await lookup(secret, {
        key: { field: 'certificate', value: 'GS-2026-0042' },
        confirm: { field: 'customer', value: 'Nile Towers' },
      }),
    );
    expect(hidden.found).toBe(false);
    await as(owner, 'POST', `/v1/documents/${document.id}/expire`, { expired: false });
  });

  it('refuses no key, a made-up key and a revoked key alike', async () => {
    const body = { key: { field: 'certificate', value: 'GS-2026-0042' } };
    for (const key of [null, `i8wk_${'x'.repeat(43)}`, 'not-a-key']) {
      const refused = await lookup(key, body);
      expect(refused.statusCode).toBe(401);
      expect(code(refused)).toBe('website_key_invalid');
    }
    const revoked = await api.call(manager.accessToken, {
      method: 'DELETE',
      url: `/v1/platform/companies/${api.tenantId}/website-keys/${keyId}`,
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect((await lookup(secret, body)).statusCode).toBe(401);
  });
});

describe('when printing cannot happen', () => {
  it('marks the document failed with the reason, and does not retry', async () => {
    const made = await makeDocument('GS-FAIL-1');
    const failing = json<DocumentBody>(made);
    const job = (
      await withTenant(api.tenantId, (tx) =>
        tx.jobs.list({ queue: 'documents.render', status: 'pending' }),
      )
    ).find((entry) => entry.payload.documentId === failing.id)!;
    const outcome = await renderDocument(
      {
        media: api.services.media,
        pdf: new ChromiumPrinter({
          executablePath: '/nowhere/chromium',
          timeoutMs: 1000,
          maxConcurrent: 1,
        }),
        config: api.config,
        logger: createLogger({ level: 'error', write: () => undefined }),
      },
      { tenantId: api.tenantId, documentId: failing.id, attempt: 1, design: job.payload.design },
    );
    expect(outcome).toEqual({ outcome: 'failed', reason: 'renderer_unavailable' });
    const after = json<DocumentBody>(await as(owner, 'GET', `/v1/documents/${failing.id}`));
    expect(after.status).toBe('failed');
    expect(after.failureCode).toBe('renderer_unavailable');
    const failed = json<{ items: { id: string }[] }>(
      await as(owner, 'GET', '/v1/documents?state=failed'),
    );
    expect(failed.items.map((item) => item.id)).toContain(failing.id);
  });
});

describe('deleting', () => {
  it('removes the record and the link, and sends the file to the restore window', async () => {
    expect((await as(viewer, 'DELETE', `/v1/documents/${document.id}`)).statusCode).toBe(403);
    const fileId = await withTenant(
      api.tenantId,
      async (tx) => (await tx.documents.find(document.id))?.fileId,
    );
    const deleted = await as(owner, 'DELETE', `/v1/documents/${document.id}`);
    expect(deleted.statusCode, deleted.body).toBe(204);
    expect((await as(owner, 'GET', `/v1/documents/${document.id}`)).statusCode).toBe(404);
    const opened = await api.app.inject({
      method: 'GET',
      url: `/v1/public/documents/${document.publicCode}`,
      remoteAddress: api.remoteAddress,
    });
    expect(opened.statusCode).toBe(404);
    const file = await withTenant(api.tenantId, (tx) => tx.files.find(fileId!));
    expect(file?.deletedAt).not.toBeNull();
  });
});
