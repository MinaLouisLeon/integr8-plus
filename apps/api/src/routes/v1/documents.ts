import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  DOCUMENT_FILE_ENTITY,
  type DocumentFieldValue,
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
  sampleAnswers,
  type TemplateDesign,
} from '@integr8/document-render';
import { holds } from '@integr8/core';
import { z } from 'zod';
import {
  latestForms,
  problemKey,
  type TemplateProblem,
  templateProblems,
} from '../../documents/attention.js';
import {
  DOCUMENT_RENDER_ATTEMPTS,
  DOCUMENT_RENDER_QUEUE,
  documentLink,
  printDesign,
  RenderFailed,
} from '../../documents/render.js';
import { dayIn, documentSources } from '../../documents/sources.js';
import {
  ApiError,
  conflict,
  type ErrorDetail,
  notFound,
  unprocessable,
} from '../../http/errors.js';
import { createRateLimiter } from '../../http/rate-limit.js';
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
 *
 * A PDF the company already has can be uploaded into the same register
 * (0067), with a reference number the website lookup finds it by. Whether any
 * document may be shown outside the company — its QR code's link and the
 * website — is its own switch, `shareable`, off for every new document.
 */

const TAGS = ['documents'];
const DOWNLOAD_LINK_SECONDS = 5 * 60;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The largest PDF that may be uploaded into the register (0067). */
export const DOCUMENT_UPLOAD_MAX_BYTES = 20 * 1024 * 1024;

/** What every PDF starts with, whatever its version (ISO 32000). */
const PDF_SIGNATURE = Buffer.from('%PDF-', 'latin1');

/** The labels an uploaded document's lookup fields are shown with. */
const REFERENCE_LABEL = { en: 'Reference', ar: 'المرجع' };
const CUSTOMER_LABEL = { en: 'Customer', ar: 'العميل' };

/** Image types a template may use as a background or a picture. */
const TEMPLATE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

const localized = z.record(z.string(), z.string());
const designInput = z.record(z.string(), z.unknown());

const templateProblemSchema = z.object({
  /** Where: `blocks.<id>` or `fields.<key>`. */
  path: z.string(),
  code: z.string(),
  message: z.string(),
  blockId: z.string().nullable(),
  fieldKey: z.string().nullable(),
});

export const templateSchema = z.object({
  id: z.uuid(),
  formId: z.uuid(),
  name: z.string(),
  /** The template as `@integr8/document-render` reads it. */
  design: z.record(z.string(), z.unknown()),
  revision: z.number().int(),
  archived: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  /**
   * Whether a published version of the form dropped or changed a question
   * the template uses (1.3.0): `problems` names each block to fix. Documents
   * are still made meanwhile; what is missing prints blank or is left out.
   */
  needsAttention: z.boolean(),
  problems: z.array(templateProblemSchema),
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
  /** `generated` from a submission, or `uploaded` as a PDF by a person (0067). */
  source: z.enum(['generated', 'uploaded']),
  /** Null for an uploaded document. */
  templateId: z.uuid().nullable(),
  templateRevision: z.number().int().nullable(),
  submissionId: z.uuid().nullable(),
  formId: z.uuid().nullable(),
  /** An uploaded document's reference number; null for a generated one. */
  reference: z.string().nullable(),
  /** The customer an uploaded document is for. */
  customer: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  /**
   * Whether the QR code's link and the company website may show it. New
   * documents start off; someone with `document.upload` switches it on.
   */
  shareable: z.boolean(),
  /** `pending` while the worker prints it; `failed` with `failureCode` if it could not. */
  status: z.enum(['pending', 'ready', 'failed']),
  failureCode: z.string().nullable(),
  /**
   * Whether the link is live now: ready and not expired. It opens outside the
   * company only when `shareable` is on too.
   */
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

export function templateBody(
  template: DocumentTemplate,
  problems: readonly TemplateProblem[],
): z.infer<typeof templateSchema> {
  return {
    id: template.id,
    formId: template.formId,
    name: template.name,
    design: template.design as Record<string, unknown>,
    revision: template.revision,
    archived: template.archivedAt !== null,
    createdAt: iso(template.createdAt),
    updatedAt: iso(template.updatedAt),
    needsAttention: problems.length > 0,
    problems: [...problems],
  };
}

/** Templates as the API shows them, each checked against its form as last published. */
export async function templateBodies(
  tx: TenantTransaction,
  templates: readonly DocumentTemplate[],
): Promise<z.infer<typeof templateSchema>[]> {
  const forms = await latestForms(
    tx,
    templates.map((template) => template.formId),
  );
  return templates.map((template) =>
    templateBody(template, templateProblems(template.design, forms.get(template.formId))),
  );
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
  const customerIds = [...new Set(documents.flatMap((document) => document.customerId ?? []))];
  const customers = new Map(
    (await tx.customers.findMany(customerIds)).map((customer) => [customer.id, customer.name]),
  );
  const now = new Date();
  return documents.map((document) => ({
    id: document.id,
    title: document.title,
    source: document.source,
    templateId: document.templateId,
    templateRevision: document.templateRevision,
    submissionId: document.submissionId,
    formId: document.formId,
    reference: document.reference,
    customer:
      document.customerId === null
        ? null
        : { id: document.customerId, name: customers.get(document.customerId) ?? '' },
    shareable: document.shareable,
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

export function designRefused(issues: readonly DesignIssue[]): never {
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
 *
 * A question the form has since dropped or changed (1.3.0 decision 13) does
 * not stop a save: the template already names it, and refusing would stop
 * staff fixing anything else first. Only a problem the stored design did not
 * already have is refused, so a save never adds a new broken reference.
 */
async function acceptedDesign(
  tx: TenantTransaction,
  formId: string,
  input: unknown,
  stored?: unknown,
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
  const form = compiledVersion(version);
  const already = new Set(
    stored === undefined ? [] : templateProblems(stored, form).map(problemKey),
  );
  const issues = checkDesignAgainstForm(parsed.design, form).filter(
    (issue) => !already.has(problemKey(issue)),
  );
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
    const items = await withTenant(context.principal.tenantId, async (tx) =>
      templateBodies(
        tx,
        await tx.documentTemplates.list({
          formId: query.formId,
          includeArchived: query.includeArchived,
        }),
      ),
    );
    return { status: 200, body: { items } };
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
    const template = await withTenant(context.principal.tenantId, async (tx) => {
      const found = await tx.documentTemplates.find(params.templateId);
      return found === undefined ? undefined : (await templateBodies(tx, [found]))[0];
    });
    if (template === undefined) {
      throw notFound('This template does not exist.');
    }
    return { status: 200, body: template };
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
      return (await templateBodies(tx, [created]))[0]!;
    });
    return { status: 201, body: template };
  },
});

export const updateDocumentTemplateRoute = defineRoute({
  method: 'patch',
  path: '/v1/document-templates/:templateId',
  operationId: 'updateDocumentTemplate',
  summary: 'Save a PDF template',
  description:
    'Staff only. `revision` is the one last read: a template saved meanwhile by someone else answers 409 `document_template_changed`, and nothing is overwritten. Documents already made keep the design they were printed with. A question the form has since dropped or changed does not stop a save when the template already named it (it stays in `problems`); a save that adds a new broken reference is refused (422). A version 1 design sent over a template a newer designer saved is refused (409 `document_template_newer`).',
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
    409: {
      description:
        'Saved meanwhile by someone else (`document_template_changed`), or an older designer saving over a newer design (`document_template_newer`).',
    },
    422: { description: 'The design has problems (`document_template_invalid`).' },
  },
  handler: async ({ params, body }, context) => {
    const template = await withTenant(context.principal.tenantId, async (tx) => {
      const current = await tx.documentTemplates.find(params.templateId);
      if (current === undefined) {
        throw notFound('This template does not exist.');
      }
      if (
        body.design !== undefined &&
        (body.design as { schemaVersion?: unknown }).schemaVersion === 1 &&
        current.designSchemaVersion > 1
      ) {
        // An app from before 1.3.0 reads a newer design as an empty one; saving it would lose it.
        throw conflict(
          'document_template_newer',
          'This template was saved by a newer version of the designer. Update the app to edit it.',
        );
      }
      const design =
        body.design === undefined
          ? undefined
          : await acceptedDesign(tx, current.formId, body.design, current.design);
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
      return (await templateBodies(tx, [saved]))[0]!;
    });
    return { status: 200, body: template };
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
      return (await templateBodies(tx, [saved]))[0]!;
    });
    return { status: 200, body: template };
  },
});

// ---------------------------------------------------------------------------
// Previewing a design as a PDF (1.3.0 decision 12)
// ---------------------------------------------------------------------------

/**
 * Previews per person per minute. A preview is a real print by Chromium in
 * the API process, a second or two of a CPU the documents queue also needs.
 */
export const PREVIEW_PER_PERSON_PER_MINUTE = 6;
/** Previews per minute across every company on this server, so previews cannot crowd out documents. */
export const PREVIEW_PER_SERVER_PER_MINUTE = 30;
const previewLimiter = createRateLimiter();

const previewSchema = z.object({
  contentType: z.literal('application/pdf'),
  /** The PDF itself, base64. Nothing is stored. */
  base64: z.string(),
  pageCount: z.number().int(),
  byteSize: z.number().int(),
});

export const previewDocumentTemplateRoute = defineRoute({
  method: 'post',
  path: '/v1/document-templates/:templateId/preview',
  operationId: 'previewDocumentTemplate',
  summary: 'Print a design as a PDF, without keeping it',
  description:
    'Staff only (`document.design`). Prints `design` — the designer’s current one, saved or not — the way a document is printed, filled with a submission of the template’s form or, without one, with sample answers. The PDF is returned and nothing is stored or counted against the company’s storage. A few per minute per person and a cap for the whole server (429 `rate_limited`); 503 `document_preview_failed` when the printer cannot print.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'document.design',
  feature: 'documents',
  allowedWhenReadOnly: true,
  params: templateParams,
  query: noSchema,
  body: z.object({
    design: designInput,
    /** A submitted submission of the template's form; sample answers when absent. */
    submissionId: z.uuid().nullable().optional(),
  }),
  responses: {
    200: { description: 'The PDF.', schema: previewSchema },
    404: { description: 'No such template, or no such submission this person may read.' },
    409: { description: 'The submission is of another form (`document_template_wrong_form`).' },
    422: { description: 'The design has problems (`document_template_invalid`).' },
    429: { description: 'Too many previews (`rate_limited`).' },
    503: { description: 'The printer could not print it (`document_preview_failed`).' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    await previewLimiter.consume({
      bucketKey: `documents.preview:person:${principal.userId}`,
      limit: PREVIEW_PER_PERSON_PER_MINUTE,
      windowMs: 60_000,
      logger: context.logger,
    });
    await previewLimiter.consume({
      bucketKey: 'documents.preview:server',
      limit: PREVIEW_PER_SERVER_PER_MINUTE,
      windowMs: 60_000,
      logger: context.logger,
    });
    const parsed = parseDesign(body.design);
    if (!parsed.ok) {
      designRefused(parsed.issues);
    }
    const design = parsed.design;
    const brand = await getPlatformDataSource().tenantSettings.brandByTenantId(principal.tenantId);
    const now = new Date();
    const gathered = await withTenant(principal.tenantId, async (tx) => {
      const template = await tx.documentTemplates.find(params.templateId);
      if (template === undefined) {
        throw notFound('This template does not exist.');
      }
      if (body.submissionId != null) {
        const submission = await readable(tx, principal, body.submissionId);
        if (submission.formId !== template.formId) {
          throw conflict(
            'document_template_wrong_form',
            'This submission is of another form than the template.',
          );
        }
        const sources = await documentSources(tx, {
          submission,
          design,
          companyName: brand?.name ?? '',
          documentDate: now,
        });
        return { template, sources };
      }
      // No submission: the form as last published, answered with made-up values.
      const [version, form, settings] = await Promise.all([
        tx.forms.findLatestPublished(template.formId),
        tx.forms.findForm(template.formId),
        tx.settings.get(),
      ]);
      if (version === undefined) {
        throw conflict(
          'form_not_published',
          'This form has no published version yet; publish it before designing its documents.',
        );
      }
      const compiled = compiledVersion(version);
      const locale = design.page.language ?? (settings.locale.startsWith('ar') ? 'ar' : 'en');
      const today = dayIn(now, settings.timezone);
      return {
        template,
        sources: {
          form: compiled,
          answers: sampleAnswers(compiled, locale, today),
          locale,
          today,
          facts: {
            companyName: brand?.name ?? '',
            formTitle: form?.title ?? '',
            submittedAt: now.toISOString(),
            submittedBy: null,
            workOrderReference: null,
            assetReference: null,
            documentDate: now.toISOString(),
            timeZone: settings.timezone,
          },
        },
      };
    });
    const { template, sources } = gathered;
    // Typed fields show their label in brackets, where the person's words will go.
    const typed = Object.fromEntries(
      design.fields
        .filter((field) => field.source.kind === 'typed')
        .map((field) => [
          field.key,
          `[${field.label[sources.locale] ?? field.label.en ?? field.key}]`.slice(
            0,
            field.source.kind === 'typed' ? field.source.maxLength : 100,
          ),
        ]),
    );
    const resolved = resolveDocumentFields({
      design,
      form: sources.form,
      answers: sources.answers,
      typed,
      facts: sources.facts,
      locale: sources.locale,
      today: sources.today,
    });
    try {
      const { pdf } = await printDesign(context.services, {
        tenantId: principal.tenantId,
        design,
        form: sources.form,
        answers: sources.answers,
        locale: sources.locale,
        facts: sources.facts,
        fields: resolved.ok ? resolved.fields : [],
        qrUrl: documentLink(context.config, 'preview'),
        today: sources.today,
        logoMediaId: brand?.logoMediaId ?? null,
        brandColour: brand?.brandColour ?? null,
        title: template.name,
      });
      return {
        status: 200,
        body: {
          contentType: 'application/pdf' as const,
          base64: Buffer.from(pdf.bytes).toString('base64'),
          pageCount: pdf.pageCount,
          byteSize: pdf.bytes.byteLength,
        },
      };
    } catch (error) {
      if (error instanceof RenderFailed) {
        context.logger.warn('Template preview failed', {
          templateId: template.id,
          reason: error.reason,
          error: error.message,
        });
        throw new ApiError(
          503,
          'document_preview_failed',
          'The preview could not be printed just now. Try again in a minute.',
        );
      }
      throw error;
    }
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
    /** Only documents made from submissions, or only uploaded ones (0067). */
    source: z.enum(['generated', 'uploaded']).optional(),
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
        source: query.source,
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

// ---------------------------------------------------------------------------
// Uploaded documents and sharing (0067)
// ---------------------------------------------------------------------------

/** Whether these bytes are a PDF: its signature within the first kilobyte, as readers accept it. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  return Buffer.from(bytes.subarray(0, 1024)).includes(PDF_SIGNATURE);
}

export const uploadDocumentRoute = defineRoute({
  method: 'post',
  path: '/v1/documents',
  operationId: 'uploadDocument',
  summary: 'Add a PDF the company already has to the register',
  description:
    'Needs `document.upload`. Upload the PDF first (`/v1/media`, as `application/pdf`, at most 20 MB), then name it here with a title and its reference number (a certificate number, say), and optionally the customer it is for. The bytes are checked to be a PDF (422 `document_not_pdf`). It is ready at once, with its own public code and link like a generated document, and starts not shareable unless `shareable` is true. The website lookup finds it by its reference, and by the customer’s name as the second value when a customer is given. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'document.upload',
  feature: 'documents',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    fileId: z.uuid(),
    title: z.string().trim().min(1).max(200),
    reference: z.string().trim().min(1).max(100),
    customerId: z.uuid().nullable().optional(),
    /** When the link stops opening by itself; null or absent for never. */
    expiresAt: z.iso.datetime().nullable().optional(),
    shareable: z.boolean().default(false),
  }),
  responses: {
    201: { description: 'The document, ready.', schema: documentSchema },
    404: { description: 'No such file uploaded by this person, or no such customer.' },
    409: { description: 'The file is already used by something else (`media_in_use`).' },
    422: {
      description:
        'Not a PDF (`document_not_pdf`), larger than 20 MB (`document_too_large`), or an expiry already past (`document_expiry_past`).',
    },
    503: { description: 'No web address for the QR link (`document_link_unavailable`).' },
  },
  handler: async ({ body }, context) => {
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
    const notPdf = () =>
      unprocessable('document_not_pdf', 'Only a PDF can be uploaded as a document.', [
        { field: 'body.fileId', code: 'document_not_pdf', message: body.fileId },
      ]);

    const { file, customer } = await withTenant(principal.tenantId, async (tx) => {
      const stored = await tx.files.find(body.fileId);
      if (stored?.deletedAt !== null || stored.uploadedBy !== principal.userId) {
        throw notFound('This file does not exist.');
      }
      const named = body.customerId == null ? undefined : await tx.customers.find(body.customerId);
      if (body.customerId != null && named === undefined) {
        throw notFound('This customer does not exist.');
      }
      return { file: stored, customer: named };
    });
    if (file.contentType !== 'application/pdf') {
      throw notPdf();
    }
    if (file.byteSize > DOCUMENT_UPLOAD_MAX_BYTES) {
      throw unprocessable('document_too_large', 'A document can be at most 20 MB.', [
        {
          field: 'body.fileId',
          code: 'document_too_large',
          message: `At most ${String(DOCUMENT_UPLOAD_MAX_BYTES)} bytes.`,
          params: { maximum: String(DOCUMENT_UPLOAD_MAX_BYTES) },
        },
      ]);
    }
    // The type was declared by the browser; the bytes say what it really is.
    const store = await getStorage(context.services.media, principal.tenantId);
    const bytes = await store.get(file.storageKey);
    if (bytes === undefined) {
      throw notFound('This file does not exist.');
    }
    if (!looksLikePdf(bytes)) {
      throw notPdf();
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    const document = await withTenant(principal.tenantId, async (tx) => {
      const id = randomUUID();
      const fields: DocumentFieldValue[] = [
        { key: 'reference', label: REFERENCE_LABEL, value: body.reference, lookupRole: 'key' },
        ...(customer === undefined
          ? []
          : [
              {
                key: 'customer',
                label: CUSTOMER_LABEL,
                value: customer.name,
                lookupRole: 'confirm' as const,
              },
            ]),
      ];
      if (await tx.files.isReferenced(file.id)) {
        throw conflict('media_in_use', 'This file is already used elsewhere; upload it again.');
      }
      const created = await tx.documents.createUploaded({
        id,
        title: body.title,
        reference: body.reference,
        customerId: customer?.id ?? null,
        publicCode: randomBytes(16).toString('base64url'),
        expiresAt,
        shareable: body.shareable,
        by: principal.userId,
        file: { fileId: file.id, byteSize: file.byteSize, sha256, pageCount: null },
        fields,
      });
      if (!(await tx.files.link(file.id, { type: DOCUMENT_FILE_ENTITY, id }))) {
        throw conflict('media_in_use', 'This file is already used elsewhere; upload it again.');
      }
      await audit(tx, context, 'document.uploaded', 'document', id, {
        title: body.title,
        reference: body.reference,
        customerId: customer?.id ?? null,
        fileId: file.id,
        shareable: body.shareable,
      });
      return documentBody(tx, context, created);
    });
    return { status: 201, body: document };
  },
});

export const setDocumentShareableRoute = defineRoute({
  method: 'post',
  path: '/v1/documents/:documentId/share',
  operationId: 'setDocumentShareable',
  summary: 'Let a document be shown outside the company, or stop it',
  description:
    'Needs `document.upload`. `shareable: false` stops the QR code’s link (it answers as if the code did not exist) and the website lookup at once; `true` lets them show it again, while it is not expired. Each change is recorded in the audit log. Works the same for generated and uploaded documents.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'document.upload',
  feature: 'documents',
  params: documentParams,
  query: noSchema,
  body: z.object({ shareable: z.boolean() }),
  responses: {
    200: { description: 'The document.', schema: documentSchema },
    404: { description: 'No such document.' },
  },
  handler: async ({ params, body }, context) => {
    const document = await withTenant(context.principal.tenantId, async (tx) => {
      const result = await tx.documents.setShareable(params.documentId, body.shareable);
      if (result === undefined) {
        throw notFound('This document does not exist.');
      }
      if (result.changed) {
        await audit(
          tx,
          context,
          body.shareable ? 'document.shared' : 'document.unshared',
          'document',
          result.document.id,
          { title: result.document.title },
        );
      }
      return documentBody(tx, context, result.document);
    });
    return { status: 200, body: document };
  },
});

export const documentRoutes = [
  listDocumentTemplatesRoute,
  getDocumentTemplateRoute,
  createDocumentTemplateRoute,
  updateDocumentTemplateRoute,
  archiveDocumentTemplateRoute,
  previewDocumentTemplateRoute,
  createDocumentRoute,
  listDocumentsRoute,
  getDocumentRoute,
  getDocumentFileRoute,
  expireDocumentRoute,
  setDocumentExpiryRoute,
  deleteDocumentRoute,
  uploadDocumentRoute,
  setDocumentShareableRoute,
];
