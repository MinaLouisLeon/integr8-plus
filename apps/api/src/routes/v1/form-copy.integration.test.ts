import { randomUUID } from 'node:crypto';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import { FORM_TEMPLATES } from '@integr8/form-engine/templates';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getLibraryStore } from '../../documents/template-copies.js';
import { provisionTenantStorage } from '../../media/tenant-storage.js';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * Copying forms and PDF templates (form builder decisions 1 and 10, 1.3.0):
 * a form to another company as a draft, with its PDF templates and their
 * pictures copied into that company's storage; a form saved into the library
 * as a staff-made template that carries its PDF templates, which another
 * company starts from and gets its own copies of; managing those templates
 * from the dashboard; and a PDF template duplicated, or copied to another form
 * with every question it names matched first.
 */

/** Unique per run: the library outlives the test database's companies. */
const KEY = `gas_cert_${randomUUID().slice(0, 8)}`;

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let builder: string;
let other: { id: string; name: string; builder: string };
let formId: string;
let templateId: string;
let backgroundId: string;

/** What the migrate service does on every deploy: load the built-in templates. */
const syncFormTemplates = () =>
  getPlatformDataSource().formTemplates.upsert(
    FORM_TEMPLATES.map((template) => ({
      key: template.key,
      title: template.title,
      description: template.description,
      category: template.category,
      definition: template.definition,
    })),
  );

const json = <T>(response: { body: string }) => JSON.parse(response.body) as T;
const code = (response: { body: string }) => json<{ error: { code: string } }>(response).error.code;

const call = (
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT',
  url: string,
  payload?: unknown,
) =>
  api.call(token, {
    method,
    url,
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });

const picture = () =>
  sharp({ create: { width: 60, height: 80, channels: 3, background: { r: 10, g: 120, b: 200 } } })
    .png()
    .toBuffer();

async function upload(token: string, bytes: Buffer): Promise<string> {
  const created = await call(token, 'POST', '/v1/media', {
    contentType: 'image/png',
    byteSize: bytes.length,
  });
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
  expect((await call(token, 'POST', `/v1/media/${media.id}/complete`)).statusCode).toBe(200);
  return media.id;
}

const certificate = {
  schemaVersion: 1,
  title: { en: 'Gas safety certificate', ar: 'شهادة سلامة الغاز' },
  pages: [
    {
      id: 'page_1',
      sections: [
        {
          id: 'section_1',
          fields: [
            { id: 'customer', type: 'text', label: { en: 'Customer', ar: 'العميل' } },
            {
              id: 'pressure',
              type: 'decimal',
              decimalPlaces: 1,
              label: { en: 'Pressure', ar: 'الضغط' },
            },
            { id: 'photos', type: 'photo', label: { en: 'Photos', ar: 'الصور' } },
          ],
        },
      ],
    },
  ],
};

/** Another form of the same company: one question shared, one worded alike, one missing. */
const inspection = {
  schemaVersion: 1,
  title: { en: 'Inspection' },
  pages: [
    {
      id: 'page_1',
      sections: [
        {
          id: 'section_1',
          fields: [
            { id: 'customer', type: 'text', label: { en: 'Client' } },
            {
              id: 'reading',
              type: 'decimal',
              decimalPlaces: 2,
              label: { en: 'Reading', ar: 'الضغط' },
            },
            { id: 'notes', type: 'long_text', label: { en: 'Notes' } },
          ],
        },
      ],
    },
  ],
};

const design = (background: string) => ({
  schemaVersion: 1,
  page: {
    size: 'A4',
    margins: { top: 20, end: 15, bottom: 20, start: 15 },
    background: { fileId: background },
    firstPage: null,
    language: null,
    fontSize: 10,
    footer: { pageNumbers: true },
  },
  fields: [],
  blocks: [
    { type: 'heading', id: 'title', text: { en: 'For {{answer.customer}}' }, level: 1 },
    { type: 'field', id: 'pressure', fieldId: 'pressure' },
    { type: 'image', id: 'photos', source: { kind: 'answer', fieldId: 'photos' } },
  ],
});

async function publish(token: string, title: string, definition: unknown): Promise<string> {
  const created = await call(token, 'POST', '/v1/forms', { title });
  expect(created.statusCode, created.body).toBe(201);
  const body = json<{ form: { id: string }; draft: { revision: number } }>(created);
  const saved = await call(token, 'PUT', `/v1/forms/${body.form.id}/draft`, {
    definition,
    expectedRevision: body.draft.revision,
  });
  expect(saved.statusCode, saved.body).toBe(200);
  const published = await call(token, 'POST', `/v1/forms/${body.form.id}/draft/publish`, {
    expectedRevision: json<{ revision: number }>(saved).revision,
    acknowledgeBreakingChanges: false,
  });
  expect(published.statusCode, published.body).toBe(200);
  return body.form.id;
}

async function setDocuments(tenantId: string) {
  const response = await api.call(admin.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${tenantId}/flags/documents`,
    payload: { enabled: true },
  });
  expect(response.statusCode, response.body).toBe(200);
}

/** Template pictures in a company's ledger, each tied to a template of that company. */
const templatePictures = (tenantId: string, ids: readonly string[]) =>
  withTenant(tenantId, async (tx) => tx.files.findMany(ids));

beforeAll(async () => {
  api = await startApi();
  await syncFormTemplates();
  admin = await api.platformAdmin('copy');
  owner = await api.member('owner', 'owner');
  builder = await api.staff(owner);
  await setDocuments(api.tenantId);

  const company = await getPlatformDataSource().tenants.create({
    slug: `copy-${randomUUID().slice(0, 8)}`,
    name: 'Other Company Ltd',
  });
  await provisionTenantStorage(api.services.media, company.id);
  const otherOwner = randomUUID();
  await withTenant(company.id, (tx) =>
    tx.tenantUsers.create({
      userId: otherOwner,
      email: `other.${randomUUID().slice(0, 8)}@test.integr8.example`,
      displayName: 'Other owner',
      role: 'owner',
      status: 'active',
    }),
  );
  await setDocuments(company.id);
  other = {
    id: company.id,
    name: company.name,
    builder: await api.staff({ userId: otherOwner }, company.id),
  };

  formId = await publish(builder, 'Gas safety certificate', certificate);
  backgroundId = await upload(builder, await picture());
  const created = await call(builder, 'POST', '/v1/document-templates', {
    formId,
    name: 'Certificate',
    design: design(backgroundId),
  });
  expect(created.statusCode, created.body).toBe(201);
  templateId = json<{ id: string }>(created).id;
});

afterAll(async () => {
  await api.close();
});

describe('copying a form to another company (1A)', () => {
  it('lists the other companies to staff only', async () => {
    const listed = await call(builder, 'GET', '/v1/forms/copy-targets?search=other');
    expect(listed.statusCode, listed.body).toBe(200);
    const items = json<{ items: { id: string }[] }>(listed).items;
    expect(items.map((item) => item.id)).toContain(other.id);
    expect(items.map((item) => item.id)).not.toContain(api.tenantId);

    const ownToken = await api.signIn(owner);
    expect((await call(ownToken, 'GET', '/v1/forms/copy-targets')).statusCode).toBe(403);
    expect(
      (await call(ownToken, 'POST', `/v1/forms/${formId}/copy-to-company`, { tenantId: other.id }))
        .statusCode,
    ).toBe(403);
  });

  it('arrives as an unpublished draft with its PDF templates and their pictures, audited in both', async () => {
    const response = await call(builder, 'POST', `/v1/forms/${formId}/copy-to-company`, {
      tenantId: other.id,
      includeDocumentTemplates: true,
      reason: 'Same certificate for the sister company',
    });
    expect(response.statusCode, response.body).toBe(201);
    const copied = json<{
      formId: string;
      copiedFrom: string;
      documentTemplatesCopied: number;
      imagesCopied: number;
    }>(response);
    expect(copied).toMatchObject({
      copiedFrom: 'published',
      documentTemplatesCopied: 1,
      imagesCopied: 1,
    });

    const inside = await withTenant(other.id, async (tx) => ({
      form: await tx.forms.findForm(copied.formId),
      draft: await tx.forms.findDraft(copied.formId),
      live: await tx.forms.findLatestPublished(copied.formId),
      templates: await tx.documentTemplates.list({ formId: copied.formId }),
      links: await tx.jobTypes.listForForm(copied.formId),
      audit: await tx.auditLog.list({ resourceType: 'form', resourceId: copied.formId }),
    }));
    expect(inside.live).toBeUndefined();
    // Answer keys and both languages, as they were.
    expect(inside.draft?.definition).toEqual(certificate);
    expect(inside.links).toEqual([]);
    expect(inside.templates).toHaveLength(1);
    const copiedDesign = inside.templates[0]?.design as ReturnType<typeof design>;
    const newBackground = copiedDesign.page.background.fileId;
    expect(newBackground).not.toBe(backgroundId);
    const [file] = await templatePictures(other.id, [newBackground]);
    expect(file).toMatchObject({
      linkedEntityType: 'document_template',
      linkedEntityId: inside.templates[0]?.id,
      contentType: 'image/png',
    });
    expect(file?.bucket).toBe(api.services.media.bucketFor(other.id));
    // The source company's picture is its own still.
    expect((await templatePictures(api.tenantId, [backgroundId]))[0]?.linkedEntityId).toBe(
      templateId,
    );
    expect(inside.audit[0]).toMatchObject({ action: 'form.copied_in', actorKind: 'platform_user' });

    const sourceAudit = await withTenant(api.tenantId, (tx) =>
      tx.auditLog.list({ resourceType: 'form', resourceId: formId }),
    );
    expect(sourceAudit.map((entry) => entry.action)).toContain('form.copied_to_company');
    const platformAudit = await getPlatformDataSource().platformAudit.list({
      action: 'form.copied_to_company',
    });
    expect(platformAudit.entries[0]).toMatchObject({ targetId: formId, tenantId: api.tenantId });
  });

  it('copies the draft of a form never published, and nothing else when asked for nothing else', async () => {
    const created = await call(builder, 'POST', '/v1/forms', { title: 'Half built' });
    const draftOnly = json<{ form: { id: string } }>(created).form.id;
    const response = await call(builder, 'POST', `/v1/forms/${draftOnly}/copy-to-company`, {
      tenantId: other.id,
      title: 'Half built (copy)',
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(json<{ copiedFrom: string; documentTemplatesCopied: number }>(response)).toMatchObject({
      copiedFrom: 'draft',
      documentTemplatesCopied: 0,
    });
    expect(
      code(
        await call(builder, 'POST', `/v1/forms/${formId}/copy-to-company`, {
          tenantId: api.tenantId,
        }),
      ),
    ).toBe('form_copy_same_company');
  });
});

describe('library templates made by staff (1B, 10b)', () => {
  it('saves a published form with its PDF templates into the library', async () => {
    expect(
      code(
        await call(builder, 'POST', `/v1/forms/${formId}/library-template`, {
          key: 'boiler_service',
          title: { en: 'Taken' },
          category: 'safety',
        }),
      ),
    ).toBe('form_template_key_taken');

    const saved = await call(builder, 'POST', `/v1/forms/${formId}/library-template`, {
      key: `${KEY}`,
      title: { en: 'Gas safety certificate', ar: 'شهادة سلامة الغاز' },
      description: { en: 'With its certificate PDF' },
      category: 'safety',
    });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(json<Record<string, unknown>>(saved)).toMatchObject({
      key: `${KEY}`,
      source: 'staff',
      retiredAt: null,
      documentTemplateCount: 1,
      origin: { tenantId: api.tenantId, formId, versionNumber: 1 },
    });

    // The picture is the library's own, in the platform's bucket.
    const [file] = await getPlatformDataSource().formTemplates.files(`${KEY}`);
    expect(file?.bucket).toBe(api.services.media.bucketFor('platform-library'));
    const store = await getLibraryStore(api.services.media);
    expect(await store.head(file?.storageKey ?? '')).toMatchObject({ contentType: 'image/png' });

    // Loading the built-in templates again leaves it alone.
    await syncFormTemplates();
    expect(await getPlatformDataSource().formTemplates.find(`${KEY}`)).toMatchObject({
      source: 'staff',
    });
  });

  it('is offered to every company beside the built-in ones, and brings its PDF templates', async () => {
    const offered = await call(other.builder, 'GET', '/v1/form-templates');
    const items = json<{ items: { key: string; source: string; documentTemplateCount: number }[] }>(
      offered,
    ).items;
    expect(items.find((item) => item.key === `${KEY}`)).toMatchObject({
      source: 'staff',
      documentTemplateCount: 1,
    });
    expect(items.find((item) => item.key === 'boiler_service')).toMatchObject({
      source: 'builtin',
    });

    const started = await call(other.builder, 'POST', `/v1/form-templates/${KEY}/clone`, {});
    expect(started.statusCode, started.body).toBe(201);
    const body = json<{
      form: { id: string; sourceTemplateKey: string };
      documentTemplatesCopied: number;
    }>(started);
    expect(body.documentTemplatesCopied).toBe(1);
    const templates = await withTenant(other.id, (tx) =>
      tx.documentTemplates.list({ formId: body.form.id }),
    );
    const fileId = (templates[0]?.design as ReturnType<typeof design>).page.background.fileId;
    const [file] = await templatePictures(other.id, [fileId]);
    expect(file).toMatchObject({
      linkedEntityId: templates[0]?.id,
      bucket: api.services.media.bucketFor(other.id),
    });

    const without = await call(other.builder, 'POST', `/v1/form-templates/${KEY}/clone`, {
      includeDocumentTemplates: false,
    });
    expect(json<{ documentTemplatesCopied: number }>(without).documentTemplatesCopied).toBe(0);
  });

  it('is renamed, replaced with a newer version and retired from the dashboard', async () => {
    const headers = admin.accessToken;
    const renamed = await call(headers, 'PATCH', `/v1/platform/form-templates/${KEY}`, {
      title: { en: 'Gas certificate', ar: 'شهادة الغاز' },
      category: 'completion',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(json<{ title: Record<string, string> }>(renamed).title).toEqual({
      en: 'Gas certificate',
      ar: 'شهادة الغاز',
    });

    // A newer published version of the source form, then replace.
    const detail = json<{ draft: { revision: number } | null; live: { revision: number } }>(
      await call(builder, 'GET', `/v1/forms/${formId}`),
    );
    const next = {
      ...certificate,
      pages: [
        {
          ...certificate.pages[0],
          sections: [
            {
              ...certificate.pages[0]!.sections[0]!,
              fields: [
                ...certificate.pages[0]!.sections[0]!.fields,
                { id: 'remarks', type: 'long_text', label: { en: 'Remarks' } },
              ],
            },
          ],
        },
      ],
    };
    const saved = await call(builder, 'PUT', `/v1/forms/${formId}/draft`, {
      definition: next,
      expectedRevision: detail.draft?.revision ?? null,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const published = await call(builder, 'POST', `/v1/forms/${formId}/draft/publish`, {
      expectedRevision: json<{ revision: number }>(saved).revision,
      acknowledgeBreakingChanges: false,
    });
    expect(published.statusCode, published.body).toBe(200);

    const before = await getPlatformDataSource().formTemplates.files(`${KEY}`);
    const refreshed = await call(headers, 'POST', `/v1/platform/form-templates/${KEY}/refresh`, {});
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(
      json<{ origin: { versionNumber: number }; title: Record<string, string> }>(refreshed),
    ).toMatchObject({ origin: { versionNumber: 2 }, title: { en: 'Gas certificate' } });
    const after = await getPlatformDataSource().formTemplates.files(`${KEY}`);
    expect(after.map((file) => file.id)).not.toEqual(before.map((file) => file.id));
    // The old picture left the bucket with the version that used it.
    const store = await getLibraryStore(api.services.media);
    expect(await store.head(before[0]?.storageKey ?? '')).toBeUndefined();

    const retired = await call(headers, 'POST', `/v1/platform/form-templates/${KEY}/retire`, {
      retired: true,
    });
    expect(json<{ retiredAt: string | null }>(retired).retiredAt).not.toBe(null);
    const offered = json<{ items: { key: string }[] }>(
      await call(other.builder, 'GET', '/v1/form-templates'),
    ).items.map((item) => item.key);
    expect(offered).not.toContain(`${KEY}`);
    expect(
      (await call(other.builder, 'POST', `/v1/form-templates/${KEY}/clone`, {})).statusCode,
    ).toBe(404);
    // Still on the dashboard, and back on demand.
    const listed = json<{ items: { key: string; retiredAt: string | null }[] }>(
      await call(headers, 'GET', '/v1/platform/form-templates'),
    ).items;
    expect(listed.find((item) => item.key === `${KEY}`)?.retiredAt).not.toBe(null);
    await call(headers, 'POST', `/v1/platform/form-templates/${KEY}/retire`, {
      retired: false,
    });

    const audit = await getPlatformDataSource().platformAudit.list({ limit: 200 });
    expect(
      audit.entries.filter((entry) => entry.targetId === `${KEY}`).map((entry) => entry.action),
    ).toEqual(
      expect.arrayContaining([
        'form_template.saved_from_form',
        'form_template.renamed',
        'form_template.refreshed',
        'form_template.retired',
        'form_template.restored',
      ]),
    );
  });

  it('keeps the built-in templates read-only', async () => {
    const headers = admin.accessToken;
    for (const [method, url, payload] of [
      ['PATCH', '/v1/platform/form-templates/boiler_service', { title: { en: 'x' } }],
      ['POST', '/v1/platform/form-templates/boiler_service/retire', { retired: true }],
      ['POST', '/v1/platform/form-templates/boiler_service/refresh', {}],
      [
        'PUT',
        '/v1/platform/form-templates/boiler_service',
        { title: { en: 'x' }, description: {}, category: 'safety', definition: certificate },
      ],
    ] as const) {
      const response = await call(headers, method, url, payload);
      expect(response.statusCode, `${method} ${url}`).toBe(409);
      expect(code(response)).toBe('form_template_builtin');
    }
  });
});

describe('copying a PDF template (10a, 10c)', () => {
  it('duplicates a template beside its original, with its own copy of every picture', async () => {
    const response = await call(builder, 'POST', `/v1/document-templates/${templateId}/copy`, {
      name: 'Certificate (copy)',
    });
    expect(response.statusCode, response.body).toBe(201);
    const copy = json<{ id: string; formId: string; design: ReturnType<typeof design> }>(response);
    expect(copy.formId).toBe(formId);
    expect(copy.design.blocks.map((block) => block.id)).toEqual(
      design(backgroundId).blocks.map((block) => block.id),
    );
    const fileId = copy.design.page.background.fileId;
    expect(fileId).not.toBe(backgroundId);
    expect((await templatePictures(api.tenantId, [fileId]))[0]?.linkedEntityId).toBe(copy.id);
  });

  it('refuses to save a copy to another form until every question is matched', async () => {
    const target = await publish(builder, 'Inspection', inspection);
    const refused = await call(builder, 'POST', `/v1/document-templates/${templateId}/copy`, {
      formId: target,
      name: 'Inspection certificate',
    });
    expect(refused.statusCode, refused.body).toBe(422);
    const error = json<{
      error: { code: string; details: { field: string; params?: Record<string, string> }[] };
    }>(refused).error;
    expect(error.code).toBe('document_template_unmatched');
    // "customer" matched by key, "pressure" by its Arabic wording; the photo has nowhere to go.
    expect(error.details.map((detail) => detail.field)).toEqual(['body.answerMap.photos']);
    expect(
      (await withTenant(api.tenantId, (tx) => tx.documentTemplates.list({ formId: target })))
        .length,
    ).toBe(0);

    expect(
      code(
        await call(builder, 'POST', `/v1/document-templates/${templateId}/copy`, {
          formId: target,
          name: 'Inspection certificate',
          answerMap: { photos: 'notes' },
        }),
      ),
    ).toBe('document_template_mapping_invalid');

    const saved = await call(builder, 'POST', `/v1/document-templates/${templateId}/copy`, {
      formId: target,
      name: 'Inspection certificate',
      answerMap: { photos: null },
    });
    expect(saved.statusCode, saved.body).toBe(201);
    const copy = json<{ formId: string; design: ReturnType<typeof design> }>(saved);
    expect(copy.formId).toBe(target);
    expect(copy.design.blocks.map((block) => block.id)).toEqual(['title', 'pressure']);
    expect(copy.design.blocks[1]).toMatchObject({ fieldId: 'reading' });
  });
});
