import { randomUUID } from 'node:crypto';
import { getPlatformDataSource, type PlanAllowance, withTenant } from '@integr8/db';
import type { TemplateDesign } from '@integr8/document-render';
import { FORM_TEMPLATES } from '@integr8/form-engine/templates';
import {
  FORM_PACKAGE_ERROR_CODES,
  FORM_PACKAGE_MEDIA_TYPE,
  type FormPackageErrorCode,
  packFormPackage,
  unpackFormPackage,
} from '@integr8/form-package';
import {
  boilerInput,
  JPEG,
  jsonBytes,
  type RawPackage,
  rawBoiler,
  sha256,
  zipRaw,
} from '@integr8/form-package/testing';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getLibraryStore } from '../../documents/template-copies.js';
import { forgetTenantStatus } from '../../http/suspension.js';
import { forgetAllowances } from '../../media/quota.js';
import { getStorage, provisionTenantStorage } from '../../media/tenant-storage.js';
import {
  type ApiHarness,
  type Member,
  type PlatformAdmin,
  startApi,
} from '../../testing/api-harness.js';

/**
 * A form and its PDF templates in one `.integr8form` file (form builder
 * decision 14, 1.3.0): exported from one company and imported into another
 * as a new draft with its own copies of every picture, every kind of bad file
 * refused with the package's code and nothing left behind, the storage
 * allowance checked first, staff only, and the library's import and export.
 */

let api: ApiHarness;
let admin: PlatformAdmin;
let owner: Member;
let builder: string;
let other: { id: string; builder: string };
let formId: string;
let backgroundId: string;
let stampId: string;
let backgroundBytes: Buffer;
let stampBytes: Buffer;

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

/** Sends a file as the import routes take it: the bytes themselves. */
const send = (
  token: string,
  url: string,
  bytes: Uint8Array,
  headers: Record<string, string> = {},
) =>
  api.call(token, {
    method: 'POST',
    url,
    payload: Buffer.from(bytes),
    headers: { 'content-type': FORM_PACKAGE_MEDIA_TYPE, ...headers },
  });

const sendAsPlatform = (bytes: Uint8Array, query = '') =>
  api.app.inject({
    method: 'POST',
    url: `/v1/platform/form-templates/import${query}`,
    payload: Buffer.from(bytes),
    remoteAddress: api.remoteAddress,
    headers: {
      authorization: `Bearer ${admin.accessToken}`,
      'x-client-version': '1.0.0',
      'x-client-app': 'web',
      'content-type': FORM_PACKAGE_MEDIA_TYPE,
    },
  });

async function upload(token: string, bytes: Buffer, contentType: string): Promise<string> {
  const created = await call(token, 'POST', '/v1/media', { contentType, byteSize: bytes.length });
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
            // No Arabic: a warning on import, never a refusal.
            { id: 'photos', type: 'photo', label: { en: 'Photos' } },
          ],
        },
      ],
    },
  ],
};

const design = (background: string, stamp: string) => ({
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
    { type: 'image', id: 'stamp', source: { kind: 'file', fileId: stamp } },
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

async function exported(token: string, id: string, source?: 'published' | 'draft') {
  const response = await call(
    token,
    'GET',
    `/v1/forms/${id}/export${source === undefined ? '' : `?source=${source}`}`,
  );
  return { response, bytes: new Uint8Array(response.rawPayload) };
}

const formsIn = (tenantId: string) => withTenant(tenantId, (tx) => tx.forms.listForms());

async function objectsIn(tenantId: string): Promise<string[]> {
  const store = await getStorage(api.services.media, tenantId);
  const keys: string[] = [];
  for await (const object of store.list()) {
    keys.push(object.key);
  }
  return keys.sort();
}

interface Imported {
  formId: string;
  title: string;
  documentTemplatesCreated: number;
  imagesCopied: number;
  source: { app: string; version: string; exportedFrom: string; versionNumber: number | null };
  check: {
    ok: boolean;
    problems: { code: string }[];
    warnings: { code: string; path: string }[];
  };
}

beforeAll(async () => {
  api = await startApi();
  admin = await api.platformAdmin('package');
  owner = await api.member('owner', 'owner');
  builder = await api.staff(owner);
  const documents = await api.call(admin.accessToken, {
    method: 'PUT',
    url: `/v1/platform/companies/${api.tenantId}/flags/documents`,
    payload: { enabled: true },
  });
  expect(documents.statusCode, documents.body).toBe(200);

  const company = await getPlatformDataSource().tenants.create({
    slug: `pkg-${randomUUID().slice(0, 8)}`,
    name: 'Imports Ltd',
  });
  await provisionTenantStorage(api.services.media, company.id);
  const otherOwner = randomUUID();
  await withTenant(company.id, (tx) =>
    tx.tenantUsers.create({
      userId: otherOwner,
      email: `imports.${randomUUID().slice(0, 8)}@test.integr8.example`,
      displayName: 'Imports owner',
      role: 'owner',
      status: 'active',
    }),
  );
  other = { id: company.id, builder: await api.staff({ userId: otherOwner }, company.id) };

  formId = await publish(builder, 'Gas safety certificate', certificate);
  const settings = await call(builder, 'PATCH', `/v1/forms/${formId}`, {
    fillRoles: ['engineer', 'dispatcher'],
    signatureRequired: true,
  });
  expect(settings.statusCode, settings.body).toBe(200);

  backgroundBytes = await sharp({
    create: { width: 60, height: 80, channels: 3, background: { r: 10, g: 120, b: 200 } },
  })
    .png()
    .toBuffer();
  stampBytes = await sharp({
    create: { width: 20, height: 20, channels: 3, background: { r: 200, g: 20, b: 20 } },
  })
    .jpeg()
    .toBuffer();
  backgroundId = await upload(builder, backgroundBytes, 'image/png');
  stampId = await upload(builder, stampBytes, 'image/jpeg');
  const created = await call(builder, 'POST', '/v1/document-templates', {
    formId,
    name: 'Certificate',
    design: design(backgroundId, stampId),
  });
  expect(created.statusCode, created.body).toBe(201);
  // An archived template stays behind.
  const archived = await call(builder, 'POST', '/v1/document-templates', {
    formId,
    name: 'Old certificate',
    design: {
      ...design(backgroundId, stampId),
      page: { ...design(backgroundId, stampId).page, background: null },
      blocks: [{ type: 'heading', id: 'title', text: { en: 'Old' }, level: 1 }],
    },
  });
  expect(archived.statusCode, archived.body).toBe(201);
  const archive = await call(
    builder,
    'POST',
    `/v1/document-templates/${json<{ id: string }>(archived).id}/archive`,
    { archived: true },
  );
  expect(archive.statusCode, archive.body).toBe(200);
});

afterAll(async () => {
  await api.close();
});

describe('exporting a form', () => {
  it('packs the published version, its settings, its live PDF templates and their pictures', async () => {
    const { response, bytes } = await exported(builder, formId);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['content-type']).toBe(FORM_PACKAGE_MEDIA_TYPE);
    expect(String(response.headers['content-disposition'])).toContain(
      'filename="Gas safety certificate.integr8form"',
    );

    const file = unpackFormPackage(bytes);
    expect(file.manifest.createdBy).toEqual({ app: 'integr8-plus', version: '1.3.0' });
    expect(file.manifest.form).toMatchObject({ source: 'published', versionNumber: 1 });
    expect(file.form).toEqual(certificate);
    expect(file.settings).toEqual({
      fillRoles: ['engineer', 'dispatcher'],
      signatureRequired: true,
    });
    expect(file.templates.map((template) => template.name)).toEqual(['Certificate']);
    const pictures = new Map(file.files.map((picture) => [picture.id, picture]));
    expect(Buffer.from(pictures.get(backgroundId)?.bytes ?? [])).toEqual(backgroundBytes);
    expect(Buffer.from(pictures.get(stampId)?.bytes ?? [])).toEqual(stampBytes);
    expect(pictures.get(stampId)?.contentType).toBe('image/jpeg');

    const audit = await withTenant(api.tenantId, (tx) =>
      tx.auditLog.list({ resourceType: 'form', resourceId: formId }),
    );
    expect(audit.map((entry) => entry.action)).toContain('form.exported');
    const platform = await getPlatformDataSource().platformAudit.list({ action: 'form.exported' });
    expect(platform.entries[0]).toMatchObject({ targetId: formId, tenantId: api.tenantId });
  });

  it('exports the draft when asked, and says when there is nothing to export', async () => {
    const created = await call(builder, 'POST', '/v1/forms', { title: 'Half built' });
    const draftOnly = json<{ form: { id: string } }>(created).form.id;
    const published = await exported(builder, draftOnly);
    expect(published.response.statusCode).toBe(409);
    expect(code(published.response)).toBe('form_export_not_published');

    const draft = await exported(builder, draftOnly, 'draft');
    expect(draft.response.statusCode, draft.response.body).toBe(200);
    expect(unpackFormPackage(draft.bytes).manifest.form.source).toBe('draft');

    const none = await exported(builder, formId, 'draft');
    expect(code(none.response)).toBe('form_export_no_draft');
  });

  it('is for Integr8 staff only', async () => {
    const own = await api.signIn(owner);
    expect((await exported(own, formId)).response.statusCode).toBe(403);
  });
});

describe('importing a form into a company', () => {
  it('arrives as a new draft with its settings, templates and its own copies of the pictures', async () => {
    const { bytes } = await exported(builder, formId);
    const response = await send(other.builder, '/v1/forms/import', bytes, {
      'idempotency-key': randomUUID(),
    });
    expect(response.statusCode, response.body).toBe(201);
    const body = json<Imported>(response);
    expect(body).toMatchObject({
      title: 'Gas safety certificate',
      documentTemplatesCreated: 1,
      imagesCopied: 2,
      source: {
        app: 'integr8-plus',
        version: '1.3.0',
        exportedFrom: 'published',
        versionNumber: 1,
      },
    });
    expect(body.check.ok).toBe(true);
    expect(body.check.warnings).toContainEqual(
      expect.objectContaining({ code: 'translation_missing' }),
    );

    const inside = await withTenant(other.id, async (tx) => ({
      form: await tx.forms.findForm(body.formId),
      draft: await tx.forms.findDraft(body.formId),
      live: await tx.forms.findLatestPublished(body.formId),
      templates: await tx.documentTemplates.list({ formId: body.formId }),
      audit: await tx.auditLog.list({ resourceType: 'form', resourceId: body.formId }),
    }));
    expect(inside.live).toBeUndefined();
    expect(inside.draft?.definition).toEqual(certificate);
    expect(inside.form).toMatchObject({
      fillRoles: ['engineer', 'dispatcher'],
      signatureRequired: true,
    });
    expect(inside.templates).toHaveLength(1);
    const imported = inside.templates[0]!;
    const blocks = (imported.design as TemplateDesign).blocks;
    expect(blocks.map((block) => block.id)).toEqual(['title', 'pressure', 'stamp']);
    const newBackground = (imported.design as TemplateDesign).page.background?.fileId;
    const stampBlock = blocks.find((block) => block.id === 'stamp') as unknown as {
      source: { fileId: string };
    };
    expect(newBackground).toBeDefined();
    expect([newBackground, stampBlock.source.fileId]).not.toContain(backgroundId);
    expect([newBackground, stampBlock.source.fileId]).not.toContain(stampId);

    const files = await withTenant(other.id, (tx) =>
      tx.files.findMany([newBackground!, stampBlock.source.fileId]),
    );
    expect(files).toHaveLength(2);
    const store = await getStorage(api.services.media, other.id);
    for (const file of files) {
      expect(file).toMatchObject({
        linkedEntityType: 'document_template',
        linkedEntityId: imported.id,
        bucket: api.services.media.bucketFor(other.id),
      });
      const stored = Buffer.from((await store.get(file.storageKey)) ?? []);
      expect(stored).toEqual(file.id === newBackground ? backgroundBytes : stampBytes);
    }

    expect(inside.audit[0]?.action).toBe('form.imported');
    expect(inside.audit[0]?.metadata).toMatchObject({
      sourceApp: 'integr8-plus',
      sourceVersion: '1.3.0',
    });
    const platform = await getPlatformDataSource().platformAudit.list({ action: 'form.imported' });
    expect(platform.entries[0]).toMatchObject({ targetId: body.formId, tenantId: other.id });
  });

  it('names a form whose title is taken "(imported)", then "(imported 2)"', async () => {
    const { bytes } = await exported(builder, formId);
    const first = json<Imported>(await send(builder, '/v1/forms/import', bytes));
    expect(first.title).toBe('Gas safety certificate (imported)');
    const second = json<Imported>(await send(builder, '/v1/forms/import', bytes));
    expect(second.title).toBe('Gas safety certificate (imported 2)');
    expect(second.formId).not.toBe(first.formId);
  });

  it('replays a retry with the same key and file instead of importing twice', async () => {
    const { bytes } = await exported(builder, formId);
    const key = randomUUID();
    const before = (await formsIn(other.id)).length;
    const first = await send(other.builder, '/v1/forms/import', bytes, { 'idempotency-key': key });
    const again = await send(other.builder, '/v1/forms/import', bytes, { 'idempotency-key': key });
    expect(json<Imported>(again).formId).toBe(json<Imported>(first).formId);
    expect((await formsIn(other.id)).length).toBe(before + 1);
  });

  it('imports a form that would not publish yet, listing what to fix', async () => {
    const broken = structuredClone(certificate);
    broken.pages[0]!.sections[0]!.fields.push({
      id: 'customer',
      type: 'text',
      label: { en: 'Customer again', ar: 'العميل مرة أخرى' },
    });
    const bytes = packFormPackage(
      boilerInput({ definition: broken, source: 'draft', templates: [], files: [] }),
    );
    const response = await send(other.builder, '/v1/forms/import', bytes);
    expect(response.statusCode, response.body).toBe(201);
    const body = json<Imported>(response);
    expect(body.check.ok).toBe(false);
    expect(body.check.problems.map((problem) => problem.code)).toContain('duplicate_id');
  });

  /** Each kind of bad file, made the way the package's own suite makes them. */
  const tampered = (change: (raw: RawPackage) => void) => {
    const raw = rawBoiler();
    change(raw);
    return zipRaw(raw);
  };
  const text = new TextEncoder().encode('<svg onload="alert(1)"></svg> not really a png');
  const badFiles: Record<FormPackageErrorCode, Uint8Array> = {
    package_invalid: new TextEncoder().encode('not a zip at all'),
    package_too_large: tampered((raw) => {
      // A template entry past its 2 MB, refused from its declared size.
      raw.templates = [{ ...(raw.templates[0] as object), padding: 'x'.repeat(2.5 * 1024 * 1024) }];
    }),
    package_too_new: tampered((raw) => {
      raw.manifest.formatVersion = 2;
    }),
    package_entry_unexpected: tampered((raw) => {
      raw.extra = [{ name: 'notes.txt', data: jsonBytes('hello'), compress: true }];
    }),
    package_file_mismatch: tampered((raw) => {
      (raw.manifest.files as { sha256: string }[])[0]!.sha256 = sha256(JPEG);
    }),
    package_image_invalid: tampered((raw) => {
      const files = raw.manifest.files as { bytes: number; sha256: string }[];
      files[0]!.bytes = text.length;
      files[0]!.sha256 = sha256(text);
      raw.files[0]!.bytes = text;
    }),
    package_form_invalid: tampered((raw) => {
      raw.form = { definition: { pages: [] }, settings: { fillRoles: ['owner'] } };
    }),
    package_template_invalid: tampered((raw) => {
      raw.templates = [{ name: '', design: (raw.templates[0] as { design: unknown }).design }];
    }),
  };

  it.each(FORM_PACKAGE_ERROR_CODES)(
    'refuses a file with %s and keeps nothing',
    async (expected) => {
      const forms = (await formsIn(other.id)).length;
      const objects = await objectsIn(other.id);
      const response = await send(other.builder, '/v1/forms/import', badFiles[expected]);
      expect(response.statusCode, response.body).toBe(422);
      const error = json<{ error: { code: string; details?: { field: string }[] } }>(
        response,
      ).error;
      expect(error.code).toBe(expected);
      expect(error.details?.length ?? 0).toBeGreaterThan(0);
      expect((await formsIn(other.id)).length).toBe(forms);
      expect(await objectsIn(other.id)).toEqual(objects);
    },
  );

  it('refuses a body that is not a file', async () => {
    const response = await call(other.builder, 'POST', '/v1/forms/import', { form: 'no' });
    expect(response.statusCode).toBe(422);
    expect(code(response)).toBe('package_invalid');
  });

  it('checks the storage allowance before writing anything', async () => {
    const platform = getPlatformDataSource();
    const original: PlanAllowance[] = await platform.metering.allowances();
    const enterprise = original.find((allowance) => allowance.plan === 'enterprise');
    await platform.tenants.setPlan(other.id, { plan: 'enterprise' });
    await platform.metering.setAllowance('enterprise', {
      storageBytes: 16,
      overage: 'block',
      updatedBy: null,
    });
    forgetAllowances();
    forgetTenantStatus(other.id);
    try {
      const forms = (await formsIn(other.id)).length;
      const objects = await objectsIn(other.id);
      const { bytes } = await exported(builder, formId);
      const response = await send(other.builder, '/v1/forms/import', bytes);
      expect(response.statusCode, response.body).toBe(409);
      expect(code(response)).toBe('storage_quota_exceeded');
      expect((await formsIn(other.id)).length).toBe(forms);
      expect(await objectsIn(other.id)).toEqual(objects);
    } finally {
      if (enterprise !== undefined) {
        await platform.metering.setAllowance('enterprise', {
          storageBytes: enterprise.storageBytes,
          retentionDays: enterprise.retentionDays,
          overage: enterprise.overage,
          warnAtPercent: enterprise.warnAtPercent,
          updatedBy: null,
        });
      }
      await platform.tenants.setPlan(other.id, { plan: 'trial' });
      forgetAllowances();
      forgetTenantStatus(other.id);
    }
  });

  it('is for Integr8 staff only', async () => {
    const { bytes } = await exported(builder, formId);
    const own = await api.signIn(owner);
    expect((await send(own, '/v1/forms/import', bytes)).statusCode).toBe(403);
  });
});

describe('the library and .integr8form files', () => {
  it('imports a file as a new staff-made template, its pictures in the library bucket', async () => {
    const response = await sendAsPlatform(packFormPackage(boilerInput()), '?category=safety');
    expect(response.statusCode, response.body).toBe(201);
    const body = json<{
      template: { key: string; source: string; category: string; documentTemplateCount: number };
      imagesCopied: number;
    }>(response);
    // "Boiler service" is a built-in key, so the new one is numbered.
    expect(body.template.key).toMatch(/^boiler_service_\d+$/u);
    expect(body.template).toMatchObject({
      source: 'staff',
      category: 'safety',
      documentTemplateCount: 1,
    });
    expect(body.imagesCopied).toBe(2);

    const files = await getPlatformDataSource().formTemplates.files(body.template.key);
    expect(files).toHaveLength(2);
    const store = await getLibraryStore(api.services.media);
    for (const file of files) {
      expect(file.bucket).toBe(api.services.media.bucketFor('platform-library'));
      expect(await store.head(file.storageKey)).toBeDefined();
    }
    const audit = await getPlatformDataSource().platformAudit.list({
      action: 'form_template.imported',
    });
    expect(audit.entries[0]?.targetId).toBe(body.template.key);

    // A company starting from it gets the PDF template and its own pictures.
    const started = await call(
      other.builder,
      'POST',
      `/v1/form-templates/${body.template.key}/clone`,
      {},
    );
    expect(started.statusCode, started.body).toBe(201);
    expect(json<{ documentTemplatesCopied: number }>(started).documentTemplatesCopied).toBe(1);

    // And it exports to the same kind of file, pictures and all.
    const out = await api.app.inject({
      method: 'GET',
      url: `/v1/platform/form-templates/${body.template.key}/export`,
      remoteAddress: api.remoteAddress,
      headers: {
        authorization: `Bearer ${admin.accessToken}`,
        'x-client-version': '1.0.0',
        'x-client-app': 'web',
      },
    });
    expect(out.statusCode, out.body).toBe(200);
    const file = unpackFormPackage(new Uint8Array(out.rawPayload));
    expect(file.templates).toHaveLength(1);
    expect(file.files.map((picture) => picture.contentType).sort()).toEqual([
      'image/jpeg',
      'image/png',
    ]);
    expect(file.form).toEqual(
      FORM_TEMPLATES.find((template) => template.key === 'boiler_service')?.definition,
    );
  });

  it('refuses a form that would not publish, listing the problems', async () => {
    const broken = structuredClone(certificate);
    broken.pages[0]!.sections[0]!.fields.push({
      id: 'customer',
      type: 'text',
      label: { en: 'Customer again', ar: 'العميل مرة أخرى' },
    });
    const before = (await getPlatformDataSource().formTemplates.list()).length;
    const response = await sendAsPlatform(
      packFormPackage(boilerInput({ definition: broken, templates: [], files: [] })),
    );
    expect(response.statusCode, response.body).toBe(422);
    const error = json<{ error: { code: string; details: { code: string }[] } }>(response).error;
    expect(error.code).toBe('form_package_not_publishable');
    expect(error.details.map((detail) => detail.code)).toContain('duplicate_id');
    expect((await getPlatformDataSource().formTemplates.list()).length).toBe(before);
  });

  it('refuses a file the format refuses, with its code', async () => {
    const response = await sendAsPlatform(new TextEncoder().encode('not a zip'));
    expect(response.statusCode).toBe(422);
    expect(code(response)).toBe('package_invalid');
  });
});
