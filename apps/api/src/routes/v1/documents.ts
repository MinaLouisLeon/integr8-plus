import { randomBytes, randomUUID } from 'node:crypto';
import {
  type DocumentRecord,
  type DocumentTemplate,
  getPlatformDataSource,
  linkOpens,
  TEMPLATE_ASSET_ENTITY,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import {
  checkDesignAgainstForm,
  type DesignIssue,
  designFileIds,
  emptyDesign,
  parseDesign,
  resolveDocumentFields,
  type TemplateDesign,
} from '@integr8/document-render';
import { holds } from '@integr8/core';
import { z } from 'zod';
import {
  DOCUMENT_RENDER_ATTEMPTS,
  DOCUMENT_RENDER_QUEUE,
  documentLink,
} from '../../documents/render.js';
import { documentSources } from '../../documents/sources.js';
import {
  ApiError,
  conflict,
  type ErrorDetail,
  notFound,
  unprocessable,
} from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { planFor } from '../../http/suspension.js';
import { assertUploadFits } from '../../media/quota.js';
import { getStorage } from '../../media/tenant-storage.js';
import { compiledVersion, readable } from './submissions.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * PDF documents made from submissions (docs/documents/ADR-0001).
 *
 * Templates are designed by Integr8 staff in the company's seat
 * (`document.design`, staff only, D1). A member with `document.create` who may
 * read a submission makes a document from it (D6); the worker prints it
 * (D4) into the company's bucket (D5). The register lists, searches, expires
 * and deletes them (D8). Every route here belongs to the `documents` module
 * (D9).
 */

const TAGS = ['documents'];
const DOWNLOAD_LINK_SECONDS = 5 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Image types a template may use as a background or a picture. */
const TEMPLATE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const localized = z.record(z.string(), z.string());
const designInput = z.record(z.string(), z.unknown());

const templateSchema = z.object({
  id: z.uuid(),
  formId: z.uuid(),
  name: z.string(),
  /** The template as `@integr8/document-render` reads it. */
  design: z.record(z.string(), z.unknown()),
  revision: z.number().int(),
  archived: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const documentFieldSchema = z.object({
  key: z.string(),
  label: localized,
  value: z.string(),
  lookupRole: z.enum(['key', 'confirm']).nullable(),
});

const documentSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  templateId: z.uuid(),
  templateRevision: z.number().int(),
  submissionId: z.uuid(),
  formId: z.uuid(),
  /** `pending` while the worker prints it; `failed` with `failureCode` if it could not. */
  status: z.enum(['pending', 'ready', 'failed']),
  failureCode: z.string().nullable(),
  /** Whether the QR code's link opens now. */
  linkOpens: z.boolean(),
  /** The page the QR code opens, or null where this server has no web address. */
  link: z.string().nullable(),
  publicCode: z.string(),
  pageCount: z.number().int().nullable(),
  byteSize: z.number().int().nullable(),
  renderedAt: z.iso.datetime().nullable(),
  expiredAt: z.iso.datetime().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  createdBy: z.object({ id: z.string(), name: z.string() }),
  createdAt: z.iso.datetime(),
  fields: z.array(documentFieldSchema),
});

const templateParams = z.object({ templateId: z.uuid() });
const documentParams = z.object({ documentId: z.uuid() });

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

function templateBody(template: DocumentTemplate): z.infer<typeof templateSchema> {
  return {
    id: template.id,
    formId: template.formId,
    name: template.name,
    design: template.design as Record<string, unknown>,
    revision: template.revision,
    archived: template.archivedAt !== null,
    createdAt: iso(template.createdAt),
    updatedAt: iso(template.updatedAt),
  };
}

async function documentBodies(
  tx: TenantTransaction,
  context: RequestContext,
  documents: readonly DocumentRecord[],
): Promise<z.infer<typeof documentSchema>[]> {
  const people = new Map(
    (await tx.tenantUsers.list({ includeDeleted: true })).map((member) => [
      member.userId as string,
      member.displayName,
    ]),
  );
  const now = new Date();
  return documents.map((document) => ({
    id: document.id,
    title: document.title,
    templateId: document.templateId,
    templateRevision: document.templateRevision,
    submissionId: document.submissionId,
    formId: document.formId,
    status: document.status,
    failureCode: document.failureCode,
    linkOpens: linkOpens(document, now),
    link: documentLink(context.config, document.publicCode),
    publicCode: document.publicCode,
    pageCount: document.pageCount,
    byteSize: document.byteSize,
    renderedAt: isoOrNull(document.renderedAt),
    expiredAt: isoOrNull(document.expiredAt),
    expiresAt: isoOrNull(document.expiresAt),
    createdBy: { id: document.createdBy, name: people.get(document.createdBy) ?? '' },
    createdAt: iso(document.createdAt),
    fields: document.fields.map((field) => ({ ...field, label: { ...field.label } })),
  }));
}

async function documentBody(
  tx: TenantTransaction,
  context: RequestContext,
  document: DocumentRecord,
) {
  const [body] = await documentBodies(tx, context, [document]);
  return body!;
}

function designRefused(issues: readonly DesignIssue[]): never {
  throw unprocessable(
    'document_template_invalid',
    'The template has problems; each is listed with where it is.',
    issues.slice(0, 50).map((issue): ErrorDetail => ({
      field: `body.design.${issue.path}`,
      code: 'document_template_problem',
      message: issue.message,
      params: { problem: issue.code },
    })),
  );
}

/**
 * A design checked as far as it can be: its own shape, then against the form
 * it belongs to as last published, then its pictures, which must be images
 * this company stored and nobody else uses.
 */
async function acceptedDesign(
  tx: TenantTransaction,
  formId: string,
  input: unknown,
): Promise<TemplateDesign> {
  const parsed = parseDesign(input);
  if (!parsed.ok) {
    designRefused(parsed.issues);
  }
  const version = await tx.forms.findLatestPublished(formId);
  if (version === undefined) {
    throw conflict(
      'form_not_published',
      'This form has no published version yet; publish it before designing its documents.',
    );
  }
  const issues = checkDesignAgainstForm(parsed.design, compiledVersion(version));
  if (issues.length > 0) {
    designRefused(issues);
  }
  const fileIds = designFileIds(parsed.design);
  const files = new Map((await tx.files.findMany(fileIds)).map((file) => [file.id, file]));
  for (const fileId of fileIds) {
    const file = files.get(fileId);
    if (file?.deletedAt !== null || !TEMPLATE_IMAGE_TYPES.has(file.contentType)) {
      throw unprocessable(
        'document_template_image_unusable',
        'A picture in the template is not a stored PNG, JPEG or WebP image.',
        [{ field: 'body.design', code: 'document_template_image_unusable', message: fileId }],
      );
    }
  }
  return parsed.design;
}

/** Ties the template's pictures to it, so retention leaves them and no other record takes them. */
async function linkTemplateFiles(
  tx: TenantTransaction,
  templateId: string,
  design: TemplateDesign,
): Promise<void> {
  for (const fileId of designFileIds(design)) {
    if (!(await tx.files.link(fileId, { type: TEMPLATE_ASSET_ENTITY, id: templateId }))) {
      throw unprocessable(
        'document_template_image_unusable',
        'A picture in the template belongs to something else; upload it again for this template.',
        [{ field: 'body.design', code: 'document_template_image_unusable', message: fileId }],
      );
    }
  }
}

async function audit(
  tx: TenantTransaction,
  context: RequestContext,
  action: string,
  resourceType: 'document' | 'document_template',
  resourceId: string,
  metadata: Record<string, unknown>,
) {
  await tx.auditLog.append({
    actorKind: 'tenant_user',
    actorId: context.principal.userId,
    actorLabel: context.principal.userId,
    action,
    resourceType,
    resourceId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata,
  });
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const listDocumentTemplatesRoute = defineRoute({
  method: 'get',
  path: '/v1/document-templates',
  operationId: 'listDocumentTemplates',
  summary: 'PDF templates, for one form or all',
  description:
    'For the designer (`document.design`) and for choosing a template when making a document (`document.create`). Archived templates only when asked.',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: ['document.create', 'document.design'],
  feature: 'documents',
  params: noSchema,
  query: z.object({
    formId: z.uuid().optional(),
    includeArchived: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),
  }),
  body: noSchema,
  responses: {
    200: { description: 'The templates.', schema: z.object({ items: z.array(templateSchema) }) },
  },
  handler: async ({ query }, context) => {
    const items = await withTenant(context.principal.tenantId, (tx) =>
      tx.documentTemplates.list({ formId: query.formId, includeArchived: query.includeArchived }),
    );
    return { status: 200, body: { items: items.map(templateBody) } };
  },
});

export const getDocumentTemplateRoute = defineRoute({
  method: 'get',
  path: '/v1/document-templates/:templateId',
  operationId: 'getDocumentTemplate',
  summary: 'One PDF template',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: ['document.create', 'document.design'],
  feature: 'documents',
  params: templateParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The template.', schema: templateSchema },
    404: { description: 'No such template.' },
  },
  handler: async ({ params }, context) => {
    const template = await withTenant(context.principal.tenantId, (tx) =>
      tx.documentTemplates.find(params.templateId),
    );
    if (template === undefined) {
      throw notFound('This template does not exist.');
    }
    return { status: 200, body: templateBody(template) };
  },
});

export const createDocumentTemplateRoute = defineRoute({
  method: 'post',
  path: '/v1/document-templates',
  operationId: 'createDocumentTemplate',
  summary: 'Start a PDF template for a form',
  description:
    'Staff only (`document.design`). Without a design the template starts with comfortable margins, page numbers and the form’s title. The design is checked against the form’s last published version (422 `document_template_invalid`, each problem in `details`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'document.design',
  feature: 'documents',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    formId: z.uuid(),
    name: z.string().trim().min(1).max(120),
    design: designInput.optional(),
  }),
  responses: {
    201: { description: 'The new template.', schema: templateSchema },
    404: { description: 'No such form.' },
    409: { description: 'The form has never been published (`form_not_published`).' },
    422: { description: 'The design has problems (`document_template_invalid`).' },
  },
  handler: async ({ body }, context) => {
    const template = await withTenant(context.principal.tenantId, async (tx) => {
      const form = await tx.forms.findForm(body.formId);
      if (form === undefined) {
        throw notFound('This form does not exist.');
      }
      const design = await acceptedDesign(tx, form.id, body.design ?? emptyDesign());
      const id = randomUUID();
      const created = await tx.documentTemplates.create({
        id,
        formId: form.id,
        name: body.name,
        design,
        by: context.principal.userId,
      });
      await linkTemplateFiles(tx, id, design);
      await audit(tx, context, 'document_template.created', 'document_template', id, {
        formId: form.id,
        name: body.name,
      });
      return created;
    });
    return { status: 201, body: templateBody(template) };
  },
});

export const updateDocumentTemplateRoute = defineRoute({
  method: 'patch',
  path: '/v1/document-templates/:templateId',
  operationId: 'updateDocumentTemplate',
  summary: 'Save a PDF template',
  description:
    'Staff only. `revision` is the one last read: a template saved meanwhile by someone else answers 409 `document_template_changed`, and nothing is overwritten. Documents already made keep the design they were printed with.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'document.design',
  feature: 'documents',
  params: templateParams,
  query: noSchema,
  body: z.object({
    revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(120).optional(),
    design: designInput.optional(),
  }),
  responses: {
    200: { description: 'The saved template.', schema: templateSchema },
    404: { description: 'No such template.' },
    409: { description: 'Saved meanwhile by someone else (`document_template_changed`).' },
    422: { description: 'The design has problems (`document_template_invalid`).' },
  },
  handler: async ({ params, body }, context) => {
    const template = await withTenant(context.principal.tenantId, async (tx) => {
      const current = await tx.documentTemplates.find(params.templateId);
      if (current === undefined) {
        throw notFound('This template does not exist.');
      }
      const design =
        body.design === undefined
          ? undefined
          : await acceptedDesign(tx, current.formId, body.design);
      const saved = await tx.documentTemplates.update(
        current.id,
        body.revision,
        { name: body.name, design },
        context.principal.userId,
      );
      if (saved === undefined) {
        throw conflict(
          'document_template_changed',
          'Someone else saved this template meanwhile. Open it again to see their changes.',
        );
      }
      if (design !== undefined) {
        await linkTemplateFiles(tx, current.id, design);
      }
      await audit(tx, context, 'document_template.saved', 'document_template', current.id, {
        revision: saved.revision,
        ...(body.name === undefined ? {} : { name: body.name }),
      });
      return saved;
    });
    return { status: 200, body: templateBody(template) };
  },
});

export const archiveDocumentTemplateRoute = defineRoute({
  method: 'post',
  path: '/v1/document-templates/:templateId/archive',
  operationId: 'archiveDocumentTemplate',
  summary: 'Archive a PDF template, or bring it back',
  description:
    'Staff only. An archived template is no longer offered for new documents; documents made from it are untouched.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'document.design',
  feature: 'documents',
  params: templateParams,
  query: noSchema,
  body: z.object({ archived: z.boolean() }),
  responses: {
    200: { description: 'The template.', schema: templateSchema },
    404: { description: 'No such template.' },
  },
  handler: async ({ params, body }, context) => {
    const template = await withTenant(context.principal.tenantId, async (tx) => {
      const saved = await tx.documentTemplates.setArchived(
        params.templateId,
        body.archived,
        context.principal.userId,
      );
      if (saved === undefined) {
        throw notFound('This template does not exist.');
      }
      await audit(
        tx,
        context,
        body.archived ? 'document_template.archived' : 'document_template.restored',
        'document_template',
        saved.id,
        {},
      );
      return saved;
    });
    return { status: 200, body: templateBody(template) };
  },
});

// ---------------------------------------------------------------------------
// Making a document
// ---------------------------------------------------------------------------

export const createDocumentRoute = defineRoute({
  method: 'post',
  path: '/v1/submissions/:submissionId/documents',
  operationId: 'createDocument',
  summary: 'Make a PDF document from a submission',
  description:
    'Needs `document.create` and the right to read the submission. `fields` are the values typed for the template’s typed document fields; the others are taken from the submission. Answers 202 with the document pending: the worker prints it, and it becomes `ready` or `failed` with a reason. Refused for a draft (409 `submission_draft`), an archived template (409 `document_template_archived`), missing or overlong fields (422 `document_fields_invalid`), a server with no web address for the QR link (503 `document_link_unavailable`) or a company past its storage allowance (409 `storage_quota_exceeded`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'document.create',
  feature: 'documents',
  idempotent: 'required',
  params: z.object({ submissionId: z.uuid() }),
  query: noSchema,
  body: z.object({
    templateId: z.uuid(),
    fields: z.record(z.string().max(64), z.string().max(500)).default({}),
    /** When the link stops opening by itself; null or absent for never. */
    expiresAt: z.iso.datetime().nullable().optional(),
  }),
  responses: {
    202: { description: 'The document, pending.', schema: documentSchema },
    404: { description: 'No such submission this person may read, or no such template.' },
    409: {
      description:
        'A draft (`submission_draft`), an archived template (`document_template_archived`), a template for another form (`document_template_wrong_form`), or storage full (`storage_quota_exceeded`).',
    },
    422: { description: 'Document fields missing or wrong (`document_fields_invalid`).' },
    503: { description: 'No web address for the QR link (`document_link_unavailable`).' },
  },
  handler: async ({ params, body }, context) => {
    const { principal, config } = context;
    if (config.WEB_APP_URL === undefined) {
      throw new ApiError(
        503,
        'document_link_unavailable',
        'This server has no WEB_APP_URL, so a document’s QR code would have nowhere to point.',
      );
    }
    const expiresAt = body.expiresAt == null ? null : new Date(body.expiresAt);
    if (expiresAt !== null && expiresAt.getTime() <= Date.now()) {
      throw unprocessable('document_expiry_past', 'The expiry date has already passed.', [
        { field: 'body.expiresAt', code: 'document_expiry_past', message: body.expiresAt ?? '' },
      ]);
    }
    // Refused now rather than after printing, when the company is already full.
    await assertUploadFits({
      plan: await planFor(principal.tenantId),
      usage: await withTenant(principal.tenantId, (tx) => tx.files.usage()),
      incomingBytes: 1,
    });
    const brand = await getPlatformDataSource().tenantSettings.brandByTenantId(principal.tenantId);
    const document = await withTenant(principal.tenantId, async (tx) => {
      const submission = await readable(tx, principal, params.submissionId);
      if (submission.status === 'draft') {
        throw conflict(
          'submission_draft',
          'A draft cannot be made into a document; submit it first.',
        );
      }
      const template = await tx.documentTemplates.find(body.templateId);
      if (template === undefined) {
        throw notFound('This template does not exist.');
      }
      if (template.archivedAt !== null) {
        throw conflict('document_template_archived', 'This template is archived.');
      }
      if (template.formId !== submission.formId) {
        throw conflict('document_template_wrong_form', 'This template belongs to another form.');
      }
      const parsed = parseDesign(template.design);
      if (!parsed.ok) {
        designRefused(parsed.issues);
      }
      const design = parsed.design;
      const now = new Date();
      const sources = await documentSources(tx, {
        submission,
        design,
        companyName: brand?.name ?? '',
        documentDate: now,
      });
      const resolved = resolveDocumentFields({
        design,
        form: sources.form,
        answers: sources.answers,
        typed: body.fields,
        facts: sources.facts,
        locale: sources.locale,
        today: sources.today,
      });
      if (!resolved.ok) {
        throw unprocessable(
          'document_fields_invalid',
          'Some document fields are missing or wrong.',
          resolved.problems.map((problem) => ({
            field: `body.fields.${problem.key}`,
            code:
              problem.code === 'required'
                ? 'required'
                : problem.code === 'too_long'
                  ? 'too_long'
                  : 'unknown_field',
            message: problem.key,
          })),
        );
      }
      const keyField = resolved.fields.find((field) => field.lookupRole === 'key');
      const title = `${template.name}${keyField === undefined ? '' : ` · ${keyField.value}`}`.slice(
        0,
        200,
      );
      const id = randomUUID();
      const created = await tx.documents.create({
        id,
        templateId: template.id,
        templateRevision: template.revision,
        submissionId: submission.id,
        formId: submission.formId,
        title,
        publicCode: randomBytes(16).toString('base64url'),
        expiresAt,
        by: principal.userId,
        fields: resolved.fields.map((field) => ({ ...field, label: { ...field.label } })),
      });
      // The design travels with the job, so a template saved while this one
      // waits does not change what was asked for.
      await tx.jobs.enqueue({
        queue: DOCUMENT_RENDER_QUEUE,
        payload: { documentId: id, design },
        maxAttempts: DOCUMENT_RENDER_ATTEMPTS,
      });
      await audit(tx, context, 'document.created', 'document', id, {
        templateId: template.id,
        templateRevision: template.revision,
        submissionId: submission.id,
        title,
      });
      return documentBody(tx, context, created);
    });
    return { status: 202, body: document };
  },
});

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

function encodeCursor(document: DocumentRecord): string {
  return Buffer.from(`${document.createdAt.toISOString()}|${document.id}`).toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [at = '', id = ''] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(at);
  if (Number.isNaN(createdAt.getTime()) || !z.uuid().safeParse(id).success) {
    throw unprocessable('invalid_cursor', 'This page link is not valid.', [
      { field: 'query.cursor', code: 'invalid_cursor', message: cursor },
    ]);
  }
  return { createdAt, id };
}

export const listDocumentsRoute = defineRoute({
  method: 'get',
  path: '/v1/documents',
  operationId: 'listDocuments',
  summary: 'The company’s documents, newest first',
  description:
    '`q` matches any document field and the title, ignoring case and extra spaces; with `fieldKey` it matches that field only. `state`: `active` (the link opens), `expired` (stopped by a person or by its date), `pending`, `failed`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'document.read',
  feature: 'documents',
  params: noSchema,
  query: z.object({
    q: z.string().trim().max(200).optional(),
    fieldKey: z.string().max(64).optional(),
    formId: z.uuid().optional(),
    templateId: z.uuid().optional(),
    submissionId: z.uuid().optional(),
    state: z.enum(['active', 'expired', 'pending', 'failed']).optional(),
    from: z.iso.date().optional(),
    before: z.iso.date().optional(),
    cursor: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of documents.',
      schema: z.object({ items: z.array(documentSchema), nextCursor: z.string().nullable() }),
    },
  },
  handler: async ({ query }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const page = await tx.documents.list({
        q: query.q,
        fieldKey: query.fieldKey,
        formId: query.formId,
        templateId: query.templateId,
        submissionId: query.submissionId,
        state: query.state,
        createdFrom: query.from === undefined ? undefined : new Date(`${query.from}T00:00:00Z`),
        createdBefore:
          query.before === undefined ? undefined : new Date(`${query.before}T00:00:00Z`),
        limit: query.limit + 1,
        after: query.cursor === undefined ? undefined : decodeCursor(query.cursor),
      });
      const items = page.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items: await documentBodies(tx, context, items),
        nextCursor: page.length > query.limit && last !== undefined ? encodeCursor(last) : null,
      };
    });
    return { status: 200, body };
  },
});

async function existing(tx: TenantTransaction, documentId: string): Promise<DocumentRecord> {
  const document = await tx.documents.find(documentId);
  if (document === undefined) {
    throw notFound('This document does not exist.');
  }
  return document;
}

/**
 * A document this seat may read: any, with `document.read`; otherwise one it
 * made itself, so an engineer who exported a certificate can open it.
 */
async function readableDocument(
  tx: TenantTransaction,
  context: RequestContext,
  documentId: string,
): Promise<DocumentRecord> {
  const document = await existing(tx, documentId);
  if (
    !holds(context.principal, 'document.read') &&
    document.createdBy !== context.principal.userId
  ) {
    throw notFound('This document does not exist.');
  }
  return document;
}

export const getDocumentRoute = defineRoute({
  method: 'get',
  path: '/v1/documents/:documentId',
  operationId: 'getDocument',
  summary: 'One document',
  description:
    'With `document.read`, any document; with `document.create` alone, only the ones this person made.',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: ['document.read', 'document.create'],
  feature: 'documents',
  params: documentParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The document.', schema: documentSchema },
    404: { description: 'No such document.' },
  },
  handler: async ({ params }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) =>
      documentBody(tx, context, await readableDocument(tx, context, params.documentId)),
    );
    return { status: 200, body };
  },
});

const fileLinkSchema = z.object({ url: z.string(), expiresAt: z.iso.datetime() });

/** A short-lived link to a ready document's PDF, shown in the browser or saved. */
export async function documentFileLink(
  context: { services: RequestContext['services'] },
  tenantId: string,
  document: DocumentRecord,
  disposition: 'inline' | 'attachment',
): Promise<z.infer<typeof fileLinkSchema>> {
  const file =
    document.fileId === null
      ? undefined
      : await withTenant(tenantId, (tx) => tx.files.find(document.fileId!));
  if (document.status !== 'ready' || file?.deletedAt !== null) {
    throw notFound('This document has no file yet.');
  }
  const store = await getStorage(context.services.media, tenantId);
  const link = await store.createDownload({
    key: file.storageKey,
    contentType: 'application/pdf',
    expiresInSeconds: DOWNLOAD_LINK_SECONDS,
    disposition,
    filename: `${document.title}.pdf`,
  });
  return { url: link.url, expiresAt: iso(link.expiresAt) };
}

export const getDocumentFileRoute = defineRoute({
  method: 'get',
  path: '/v1/documents/:documentId/file',
  operationId: 'getDocumentFile',
  summary: 'A link to a document’s PDF',
  description:
    'Five minutes long. `disposition=inline` opens it in the browser; `attachment` saves it under the document’s title. Works whether or not the public link is expired: the company can always read its own documents. With `document.create` alone, only for documents this person made.',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: ['document.read', 'document.create'],
  feature: 'documents',
  params: documentParams,
  query: z.object({ disposition: z.enum(['inline', 'attachment']).default('inline') }),
  body: noSchema,
  responses: {
    200: { description: 'The link.', schema: fileLinkSchema },
    404: { description: 'No such document, or it is not ready.' },
  },
  handler: async ({ params, query }, context) => {
    const document = await withTenant(context.principal.tenantId, (tx) =>
      readableDocument(tx, context, params.documentId),
    );
    return {
      status: 200,
      body: await documentFileLink(
        context,
        context.principal.tenantId,
        document,
        query.disposition,
      ),
    };
  },
});

export const expireDocumentRoute = defineRoute({
  method: 'post',
  path: '/v1/documents/:documentId/expire',
  operationId: 'expireDocument',
  summary: 'Stop a document’s link now, or let it open again',
  description:
    '`expired: true` stops the QR code’s link and the website lookup at once; `false` undoes it. Neither touches the file. Needs `document.manage`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'document.manage',
  feature: 'documents',
  params: documentParams,
  query: noSchema,
  body: z.object({ expired: z.boolean() }),
  responses: {
    200: { description: 'The document.', schema: documentSchema },
    404: { description: 'No such document.' },
  },
  handler: async ({ params, body }, context) => {
    const document = await withTenant(context.principal.tenantId, async (tx) => {
      const saved = await tx.documents.setExpired(
        params.documentId,
        body.expired,
        context.principal.userId,
      );
      if (saved === undefined) {
        throw notFound('This document does not exist.');
      }
      await audit(
        tx,
        context,
        body.expired ? 'document.expired' : 'document.unexpired',
        'document',
        saved.id,
        { title: saved.title },
      );
      return documentBody(tx, context, saved);
    });
    return { status: 200, body: document };
  },
});

export const setDocumentExpiryRoute = defineRoute({
  method: 'patch',
  path: '/v1/documents/:documentId',
  operationId: 'setDocumentExpiry',
  summary: 'Set or clear the date a document’s link stops by itself',
  tags: TAGS,
  security: 'authenticated',
  permission: 'document.manage',
  feature: 'documents',
  params: documentParams,
  query: noSchema,
  body: z.object({ expiresAt: z.iso.datetime().nullable() }),
  responses: {
    200: { description: 'The document.', schema: documentSchema },
    404: { description: 'No such document.' },
  },
  handler: async ({ params, body }, context) => {
    const document = await withTenant(context.principal.tenantId, async (tx) => {
      const saved = await tx.documents.setExpiresAt(
        params.documentId,
        body.expiresAt === null ? null : new Date(body.expiresAt),
      );
      if (saved === undefined) {
        throw notFound('This document does not exist.');
      }
      await audit(tx, context, 'document.expiry_set', 'document', saved.id, {
        expiresAt: body.expiresAt,
      });
      return documentBody(tx, context, saved);
    });
    return { status: 200, body: document };
  },
});

export const deleteDocumentRoute = defineRoute({
  method: 'delete',
  path: '/v1/documents/:documentId',
  operationId: 'deleteDocument',
  summary: 'Delete a document, its link and its file',
  description:
    'The record and the link go at once; the PDF goes through the media restore window and is then purged, like any deleted file. Needs `document.manage`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'document.manage',
  feature: 'documents',
  params: documentParams,
  query: noSchema,
  body: noSchema,
  responses: {
    204: { description: 'Deleted.' },
    404: { description: 'No such document.' },
  },
  handler: async ({ params }, context) => {
    await withTenant(context.principal.tenantId, async (tx) => {
      const document = await existing(tx, params.documentId);
      const removed = await tx.documents.delete(document.id);
      if (removed === undefined) {
        throw notFound('This document does not exist.');
      }
      if (removed.fileId !== null) {
        await tx.files.softDelete(
          removed.fileId,
          context.principal.userId,
          new Date(Date.now() + context.config.MEDIA_RESTORE_DAYS * DAY_MS),
        );
      }
      await audit(tx, context, 'document.deleted', 'document', document.id, {
        title: document.title,
        submissionId: document.submissionId,
        fileId: removed.fileId,
      });
    });
    return { status: 204, body: undefined };
  },
});

export const documentRoutes = [
  listDocumentTemplatesRoute,
  getDocumentTemplateRoute,
  createDocumentTemplateRoute,
  updateDocumentTemplateRoute,
  archiveDocumentTemplateRoute,
  createDocumentRoute,
  listDocumentsRoute,
  getDocumentRoute,
  getDocumentFileRoute,
  expireDocumentRoute,
  setDocumentExpiryRoute,
  deleteDocumentRoute,
];
