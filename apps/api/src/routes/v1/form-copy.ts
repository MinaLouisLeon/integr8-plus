import { holds, type ImpersonationClaim, toTenantId } from '@integr8/core';
import {
  FORM_TEMPLATE_CATEGORIES,
  getPlatformDataSource,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import type { TemplateDesign } from '@integr8/document-render';
import { FORM_TEMPLATES } from '@integr8/form-engine/templates';
import { z } from 'zod';
import {
  assertPicturesFit,
  bringTemplatesIn,
  companyPictures,
  companyStore,
  copyPictures,
  discardPictures,
  libraryContentFromForm,
} from '../../documents/template-copies.js';
import { conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { mediaKey } from '../../media/storage.js';
import { libraryTemplateSchema, libraryTemplateBody } from './platform/templates.js';

/**
 * Copying a form out of its company (form builder decision 1, 1.3.0), from
 * the staff desktop app's form screen.
 *
 * Both are Integr8 staff's work, done in a company's seat through the audited
 * impersonation grant — which is how the staff app reaches a form at all; its
 * platform sign-in is dropped once a company is open (`apps/desktop/src/lib/
 * staff.ts`). So these are company routes that only a staff session may use:
 * `form.manage` is staff-only, and each also requires the impersonation claim
 * and names the staff member behind it in both companies' audit logs and the
 * platform's.
 *
 * - **Copy to another company** (1A): the form's last published version — or
 *   its draft when it was never published — arrives in the other company as a
 *   new, unpublished draft, with its settings (who fills it, the signature
 *   rule) and nothing else: no job type links, no submissions, no answers.
 *   With `includeDocumentTemplates`, its PDF templates go too, each picture
 *   copied into the other company's own storage and counted there.
 * - **Save as a library template** (1B, 10b): the last published version, and
 *   its PDF templates with their pictures in the platform's library bucket,
 *   become a staff-made library template every company can start from.
 */

const TAGS = ['forms'];

const formParams = z.object({ formId: z.uuid() });
const localized = z.record(z.string().regex(/^[a-z]{2}$/u), z.string().trim().max(2000));

function staffOf(context: RequestContext): ImpersonationClaim {
  const staff = context.principal.impersonatedBy;
  if (staff === undefined) {
    // `form.manage` is staff-only, so the permission check has already refused
    // anybody else; this keeps the route honest if that changes.
    throw forbidden('Only Integr8 staff can copy a form out of a company.');
  }
  return staff;
}

async function staffEmail(staff: ImpersonationClaim): Promise<string> {
  return (await getPlatformDataSource().platformUsers.findById(staff.pid))?.email ?? staff.pid;
}

async function auditInCompany(
  tx: TenantTransaction,
  context: RequestContext,
  input: {
    action: string;
    resourceId: string;
    metadata: Record<string, unknown>;
  },
) {
  await tx.auditLog.append({
    actorKind: 'tenant_user',
    actorId: context.principal.userId,
    actorLabel: context.principal.userId,
    action: input.action,
    resourceType: 'form',
    resourceId: input.resourceId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { ...input.metadata, impersonatedBy: context.principal.impersonatedBy },
  });
}

// ---------------------------------------------------------------------------
// Copy to another company
// ---------------------------------------------------------------------------

const companyChoiceSchema = z.object({ id: z.uuid(), name: z.string(), slug: z.string() });

export const listCopyTargetsRoute = defineRoute({
  method: 'get',
  path: '/v1/forms/copy-targets',
  operationId: 'listFormCopyTargets',
  summary: 'Companies a form can be copied to',
  description:
    'Integr8 staff only, acting as a company (`form.manage` and the impersonation claim). Every other company that is not closed, by name.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.manage',
  params: noSchema,
  query: z.object({ search: z.string().trim().max(100).optional() }),
  body: noSchema,
  responses: {
    200: {
      description: 'The companies.',
      schema: z.object({ items: z.array(companyChoiceSchema) }),
    },
    403: { description: 'Not Integr8 staff.' },
  },
  handler: async ({ query }, context) => {
    staffOf(context);
    const search = query.search?.toLocaleLowerCase() ?? '';
    const items = (await getPlatformDataSource().tenants.list())
      .filter(
        (tenant) =>
          tenant.id !== context.principal.tenantId &&
          tenant.status !== 'cancelled' &&
          (search === '' ||
            tenant.name.toLocaleLowerCase().includes(search) ||
            tenant.slug.includes(search)),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 100)
      .map((tenant) => ({ id: tenant.id, name: tenant.name, slug: tenant.slug }));
    return { status: 200, body: { items } };
  },
});

const copiedSchema = z.object({
  tenantId: z.uuid(),
  companyName: z.string(),
  formId: z.uuid(),
  title: z.string(),
  /** Whether the copy was made from a published version or from a draft. */
  copiedFrom: z.enum(['published', 'draft']),
  versionNumber: z.number().int().nullable(),
  documentTemplatesCopied: z.number().int(),
  imagesCopied: z.number().int(),
});

export const copyFormToCompanyRoute = defineRoute({
  method: 'post',
  path: '/v1/forms/:formId/copy-to-company',
  operationId: 'copyFormToCompany',
  summary: 'Copy a form to another company',
  description:
    'Integr8 staff only, acting as the company the form is in. The form’s last published version — or its draft, when it was never published — arrives in the other company as a new form with an unpublished draft, keeping its answer keys, its English and Arabic texts and its settings (who fills it, the signature rule). Never copied: job type links, submissions, answers, documents. With `includeDocumentTemplates` (needs `document.design`), its PDF templates go too, every picture copied into the other company’s storage (409 `storage_quota_exceeded` past a blocking allowance). Audited in both companies and in the platform audit log. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.manage',
  idempotent: true,
  params: formParams,
  query: noSchema,
  body: z.object({
    tenantId: z.uuid(),
    title: z.string().trim().min(1).max(200).optional(),
    includeDocumentTemplates: z.boolean().default(false),
    /** Why, for both audit logs. */
    reason: z.string().trim().max(500).optional(),
  }),
  responses: {
    201: { description: 'The copy, in the other company.', schema: copiedSchema },
    403: { description: 'Not Integr8 staff, or PDF templates without `document.design`.' },
    404: { description: 'No such form or company.' },
    409: {
      description:
        'The company is closed (`company_closed`), its storage is not ready (`storage_not_ready`, 503) or full (`storage_quota_exceeded`), or a picture is gone (`document_template_image_missing`).',
    },
    422: { description: 'The form’s own company (`form_copy_same_company`).' },
  },
  handler: async ({ params, body }, context) => {
    const staff = staffOf(context);
    const { principal } = context;
    if (body.includeDocumentTemplates && !holds(principal, 'document.design')) {
      throw forbidden('Copying PDF templates needs the right to design them.');
    }
    if (body.tenantId === principal.tenantId) {
      throw unprocessable(
        'form_copy_same_company',
        'This is the form’s own company; use Copy in the forms list instead.',
      );
    }
    const platform = getPlatformDataSource();
    const company = await platform.tenants.findById(body.tenantId);
    if (company?.deletedAt !== null) {
      throw notFound('This company does not exist.');
    }
    if (company.status === 'cancelled') {
      throw conflict('company_closed', 'This company is closed; nothing can be copied to it.');
    }

    const source = await withTenant(principal.tenantId, async (tx) => {
      const form = await tx.forms.findForm(params.formId);
      if (form === undefined) {
        throw notFound('This form does not exist.');
      }
      const published = await tx.forms.findLatestPublished(form.id);
      const version = published ?? (await tx.forms.findDraft(form.id));
      if (version === undefined) {
        throw notFound('This form has nothing to copy.');
      }
      const templates = body.includeDocumentTemplates
        ? await tx.documentTemplates.list({ formId: form.id })
        : [];
      const designs = templates.map((template) => template.design as TemplateDesign);
      return {
        form,
        version,
        copiedFrom: published === undefined ? ('draft' as const) : ('published' as const),
        templates: templates.map((template, index) => ({
          name: template.name,
          design: designs[index]!,
        })),
        pictures: await companyPictures(tx, designs),
      };
    });

    await assertPicturesFit(company.id, source.pictures);
    const target =
      source.pictures.length === 0 ? null : await companyStore(context.services.media, company.id);
    const copies =
      target === null
        ? []
        : await copyPictures(
            await companyStore(context.services.media, principal.tenantId),
            target,
            source.pictures,
            mediaKey,
          );

    const email = await staffEmail(staff);
    const title = body.title ?? source.form.title;
    try {
      const created = await withTenant(toTenantId(company.id), async (tx) => {
        const form = await tx.forms.createForm({
          title,
          createdBy: staff.pid,
          fillRoles: source.form.fillRoles,
          signatureRequired: source.form.signatureRequired,
        });
        await tx.forms.createDraft({
          formId: form.id,
          definition: source.version.definition,
          createdBy: staff.pid,
        });
        const brought = await bringTemplatesIn({
          tx,
          formId: form.id,
          templates: source.templates,
          copies,
          by: staff.pid,
        });
        await tx.auditLog.append({
          actorKind: 'platform_user',
          actorId: staff.pid,
          actorLabel: email,
          action: 'form.copied_in',
          resourceType: 'form',
          resourceId: form.id,
          requestId: context.requestId,
          ipAddress: context.ipAddress,
          userAgent: context.userAgent,
          metadata: {
            fromTenantId: principal.tenantId,
            fromFormId: source.form.id,
            copiedFrom: source.copiedFrom,
            versionNumber: source.version.versionNumber,
            documentTemplates: brought.templateIds,
            pictures: brought.pictures,
            ...(body.reason === undefined ? {} : { reason: body.reason }),
          },
        });
        return { formId: form.id, documentTemplates: brought.templateIds.length };
      });

      await withTenant(principal.tenantId, (tx) =>
        auditInCompany(tx, context, {
          action: 'form.copied_to_company',
          resourceId: source.form.id,
          metadata: {
            toTenantId: company.id,
            toFormId: created.formId,
            copiedFrom: source.copiedFrom,
            versionNumber: source.version.versionNumber,
            documentTemplates: created.documentTemplates,
            ...(body.reason === undefined ? {} : { reason: body.reason }),
          },
        }),
      );
      await platform.platformAudit.append({
        platformUserId: staff.pid,
        actorLabel: email,
        action: 'form.copied_to_company',
        tenantId: principal.tenantId,
        tenantSlug: null,
        targetKind: 'form',
        targetId: source.form.id,
        reason: body.reason ?? null,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: {
          toTenantId: company.id,
          toFormId: created.formId,
          copiedFrom: source.copiedFrom,
          documentTemplates: created.documentTemplates,
          pictures: copies.length,
          grantId: staff.gid,
        },
      });

      return {
        status: 201,
        body: {
          tenantId: company.id,
          companyName: company.name,
          formId: created.formId,
          title,
          copiedFrom: source.copiedFrom,
          versionNumber: source.version.versionNumber,
          documentTemplatesCopied: created.documentTemplates,
          imagesCopied: copies.length,
        },
      };
    } catch (error) {
      if (target !== null) {
        await discardPictures(target, copies);
      }
      throw error;
    }
  },
});

// ---------------------------------------------------------------------------
// Save as a library template
// ---------------------------------------------------------------------------

/** Keys the code ships, synced or not yet: never a staff-made template's. */
const BUILT_IN_KEYS = new Set(FORM_TEMPLATES.map((template) => template.key));

export const saveToLibraryRoute = defineRoute({
  method: 'post',
  path: '/v1/forms/:formId/library-template',
  operationId: 'saveFormToLibrary',
  summary: 'Save a form as a library template',
  description:
    'Integr8 staff only, acting as the company the form is in. The form’s last published version becomes a staff-made library template under `key`, offered to every company beside the built-in ones. With `includeDocumentTemplates` (the default) its PDF templates that are not archived go too, their pictures copied into the platform’s library storage; a company that starts from the template gets its own copies. Renamed, replaced with a newer version and retired from the dashboard’s Templates page. 409 `form_template_key_taken` for a key in use (built-in keys included), `form_not_published` for a form never published.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.manage',
  idempotent: true,
  params: formParams,
  query: noSchema,
  body: z.object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u),
    title: localized.refine((value) => Object.values(value).some((text) => text !== ''), {
      message: 'Give the template a name',
    }),
    description: localized.default({}),
    category: z.enum(FORM_TEMPLATE_CATEGORIES),
    includeDocumentTemplates: z.boolean().default(true),
  }),
  responses: {
    201: { description: 'The library template.', schema: libraryTemplateSchema },
    403: { description: 'Not Integr8 staff, or PDF templates without `document.design`.' },
    404: { description: 'No such form.' },
    409: { description: 'The key is taken, or the form was never published.' },
  },
  handler: async ({ params, body }, context) => {
    const staff = staffOf(context);
    const { principal } = context;
    if (body.includeDocumentTemplates && !holds(principal, 'document.design')) {
      throw forbidden('Saving PDF templates needs the right to design them.');
    }
    const library = getPlatformDataSource().formTemplates;
    if (BUILT_IN_KEYS.has(body.key) || (await library.find(body.key)) !== undefined) {
      throw conflict('form_template_key_taken', 'A library template already uses this key.');
    }
    const title = Object.fromEntries(Object.entries(body.title).filter(([, text]) => text !== ''));
    const description = Object.fromEntries(
      Object.entries(body.description).filter(([, text]) => text !== ''),
    );

    const {
      content,
      copies,
      library: store,
    } = await libraryContentFromForm({
      media: context.services.media,
      tenantId: principal.tenantId,
      formId: params.formId,
      includeDocumentTemplates: body.includeDocumentTemplates,
    });
    try {
      const created = await library.createStaff({
        key: body.key,
        title,
        description,
        category: body.category,
        origin: { tenantId: principal.tenantId, formId: params.formId },
        content,
        by: staff.pid,
      });
      if (!created) {
        throw conflict('form_template_key_taken', 'A library template already uses this key.');
      }
    } catch (error) {
      await discardPictures(store, copies);
      throw error;
    }

    const email = await staffEmail(staff);
    await withTenant(principal.tenantId, (tx) =>
      auditInCompany(tx, context, {
        action: 'form.saved_to_library',
        resourceId: params.formId,
        metadata: {
          key: body.key,
          versionNumber: content.sourceVersionNumber,
          documentTemplates: content.documents.length,
        },
      }),
    );
    await getPlatformDataSource().platformAudit.append({
      platformUserId: staff.pid,
      actorLabel: email,
      action: 'form_template.saved_from_form',
      tenantId: principal.tenantId,
      tenantSlug: null,
      targetKind: 'form_template',
      targetId: body.key,
      reason: null,
      requestId: context.requestId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      metadata: {
        formId: params.formId,
        versionNumber: content.sourceVersionNumber,
        documentTemplates: content.documents.length,
        pictures: copies.length,
        grantId: staff.gid,
      },
    });

    const saved = await library.find(body.key);
    if (saved === undefined) {
      throw notFound('This template does not exist.');
    }
    return { status: 201, body: await libraryTemplateBody(saved) };
  },
});

export const formCopyRoutes = [listCopyTargetsRoute, copyFormToCompanyRoute, saveToLibraryRoute];
