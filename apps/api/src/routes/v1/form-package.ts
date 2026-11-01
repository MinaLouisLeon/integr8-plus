import { holds, type ImpersonationClaim } from '@integr8/core';
import { getPlatformDataSource, type TenantTransaction, withTenant } from '@integr8/db';
import type { TemplateDesign } from '@integr8/document-render';
import { withRequiredSchemaVersion } from '@integr8/form-engine';
import {
  FORM_PACKAGE_LIMITS,
  FORM_PACKAGE_MEDIA_TYPE,
  FormPackageError,
  type PackageImageType,
  packFormPackage,
} from '@integr8/form-package';
import { z } from 'zod';
import { VERSION } from '../../app-info.js';
import {
  checkBody,
  EXPORTING_APP,
  packageCheckSchema,
  packageHeaders,
  packageOrigin,
  packageOriginSchema,
  packageRefusal,
  readPictures,
  readUpload,
} from '../../documents/form-packages.js';
import {
  assertPicturesFit,
  bringTemplatesIn,
  companyPictures,
  companyStore,
  discardPictures,
  storePictures,
} from '../../documents/template-copies.js';
import { conflict, forbidden, notFound } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { mediaKey } from '../../media/storage.js';

/**
 * A form with its PDF templates in one `.integr8form` file (form builder
 * decision 14, 1.3.0), from the staff desktop app's form screens.
 *
 * Like copying a form out of a company (`form-copy.ts`), this is Integr8
 * staff's work in a company's seat: `form.manage` is staff-only, the
 * impersonation claim is required as well, and PDF templates need
 * `document.design`. Each export and import is in the company's audit log and
 * the platform's, naming the staff member.
 *
 * - **Export** packs the last published version (or the draft, when asked),
 *   the form's settings, its PDF templates that are not archived and every
 *   picture they use, read from the company's storage. Never submissions,
 *   answers, customers, job type links or the company's branding: the format
 *   has no place for them.
 * - **Import** reads a file from anywhere with every check the format makes,
 *   and makes a new form with an unpublished draft — never a change to an
 *   existing one — with the file's PDF templates, their pictures written into
 *   the company's storage under new ids. A form that would not publish yet is
 *   still imported, as any draft may be unfinished: the response lists what to
 *   fix, and publishing refuses until it is fixed.
 */

const TAGS = ['forms'];

function staffOf(context: RequestContext, what: string): ImpersonationClaim {
  const staff = context.principal.impersonatedBy;
  if (staff === undefined) {
    // `form.manage` is staff-only, so the permission check has already refused
    // anybody else; this keeps the route honest if that changes.
    throw forbidden(`Only Integr8 staff can ${what}.`);
  }
  return staff;
}

async function staffEmail(staff: ImpersonationClaim): Promise<string> {
  return (await getPlatformDataSource().platformUsers.findById(staff.pid))?.email ?? staff.pid;
}

async function auditInCompany(
  tx: TenantTransaction,
  context: RequestContext,
  input: { action: string; resourceId: string; metadata: Record<string, unknown> },
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

async function auditOnPlatform(
  context: RequestContext,
  staff: ImpersonationClaim,
  input: { action: string; formId: string; metadata: Record<string, unknown> },
) {
  await getPlatformDataSource().platformAudit.append({
    platformUserId: staff.pid,
    actorLabel: await staffEmail(staff),
    action: input.action,
    tenantId: context.principal.tenantId,
    tenantSlug: null,
    targetKind: 'form',
    targetId: input.formId,
    reason: null,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { ...input.metadata, grantId: staff.gid },
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const exportFormRoute = defineRoute({
  method: 'get',
  path: '/v1/forms/:formId/export',
  operationId: 'exportForm',
  summary: 'Export a form with its PDF templates as a .integr8form file',
  description:
    'Integr8 staff only, acting as the company the form is in (`form.manage` and the impersonation claim; `document.design` when the form has PDF templates). The file holds the form’s last published version — or, with `source=draft`, its draft — its settings (who fills it, the signature rule), its PDF templates that are not archived and every picture they use. Never submissions, answers, customers, job type links or the company’s branding. The format is described in `docs/form-engine/package-format.md`. 409 `form_export_not_published` when nothing is published, `form_export_no_draft` when there is no draft, `document_template_image_missing` when a picture is gone from storage. Audited in the company and the platform.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.manage',
  params: z.object({ formId: z.uuid() }),
  query: z.object({ source: z.enum(['published', 'draft']).default('published') }),
  body: noSchema,
  responses: {
    200: {
      description: 'The `.integr8form` file, as an attachment named after the form.',
      schema: z.string(),
      contentType: FORM_PACKAGE_MEDIA_TYPE,
    },
    403: { description: 'Not Integr8 staff, or PDF templates without `document.design`.' },
    404: { description: 'No such form.' },
    409: { description: 'Nothing to export from the chosen source, or a picture is missing.' },
  },
  handler: async ({ params, query }, context) => {
    const staff = staffOf(context, 'export a form');
    const { principal } = context;
    const read = await withTenant(principal.tenantId, async (tx) => {
      const form = await tx.forms.findForm(params.formId);
      if (form === undefined) {
        throw notFound('This form does not exist.');
      }
      const version =
        query.source === 'draft'
          ? await tx.forms.findDraft(form.id)
          : await tx.forms.findLatestPublished(form.id);
      if (version === undefined) {
        throw query.source === 'draft'
          ? conflict(
              'form_export_no_draft',
              'This form has no draft; export its published version.',
            )
          : conflict(
              'form_export_not_published',
              'This form has no published version yet; export its draft instead.',
            );
      }
      const templates = await tx.documentTemplates.list({ formId: form.id });
      const designs = templates.map((template) => template.design as TemplateDesign);
      return { form, version, templates, pictures: await companyPictures(tx, designs) };
    });
    if (read.templates.length > 0 && !holds(principal, 'document.design')) {
      throw forbidden('Exporting PDF templates needs the right to design them.');
    }

    const files =
      read.pictures.length === 0
        ? []
        : await readPictures(
            await companyStore(context.services.media, principal.tenantId),
            read.pictures,
          );
    let bytes: Uint8Array;
    try {
      bytes = packFormPackage({
        createdBy: { app: EXPORTING_APP, version: VERSION },
        definition: read.version.definition,
        source: query.source,
        versionNumber: read.version.versionNumber,
        settings: {
          fillRoles: [...read.form.fillRoles],
          signatureRequired: read.form.signatureRequired,
        },
        templates: read.templates.map((template) => ({
          name: template.name,
          design: template.design,
        })),
        // A stored picture of another kind is refused by the packer, by name.
        files: files.map((file) => ({
          ...file,
          contentType: file.contentType as PackageImageType,
        })),
      });
    } catch (error) {
      if (error instanceof FormPackageError) {
        throw packageRefusal(error, 409);
      }
      throw error;
    }

    const metadata = {
      source: query.source,
      versionNumber: read.version.versionNumber,
      documentTemplates: read.templates.map((template) => template.id),
      pictures: files.length,
      bytes: bytes.length,
    };
    await withTenant(principal.tenantId, (tx) =>
      auditInCompany(tx, context, { action: 'form.exported', resourceId: read.form.id, metadata }),
    );
    await auditOnPlatform(context, staff, {
      action: 'form.exported',
      formId: read.form.id,
      metadata: { ...metadata, documentTemplates: read.templates.length },
    });

    return { status: 200, body: Buffer.from(bytes), headers: packageHeaders(read.form.title) };
  },
});

// ---------------------------------------------------------------------------
// Import into this company
// ---------------------------------------------------------------------------

/** The suffix a title gets when a form of that name exists, in the title's language. */
const IMPORTED = { en: 'imported', ar: 'مستورد' } as const;

/**
 * The new form's name: the file's title (English first, as the forms list
 * shows one name), and when a form here is already called that, the title
 * with "(imported)" — "(imported 2)" and so on if that is taken too. Two forms
 * of one name would be told apart only by their dates.
 */
export function importTitle(title: Record<string, string>, taken: readonly string[]): string {
  const english = title.en?.trim() ?? '';
  const arabic = title.ar?.trim() ?? '';
  const language: 'en' | 'ar' = english === '' && arabic !== '' ? 'ar' : 'en';
  const base = (
    language === 'ar'
      ? arabic
      : english !== ''
        ? english
        : (Object.values(title).find((text) => text.trim() !== '') ?? 'Form')
  )
    .trim()
    .slice(0, 180);
  const used = new Set(taken.map((name) => name.trim().toLocaleLowerCase()));
  if (!used.has(base.toLocaleLowerCase())) {
    return base;
  }
  for (let attempt = 1; ; attempt += 1) {
    const candidate = `${base} (${IMPORTED[language]}${attempt === 1 ? '' : ` ${String(attempt)}`})`;
    if (!used.has(candidate.toLocaleLowerCase())) {
      return candidate;
    }
  }
}

export const importedFormSchema = z.object({
  formId: z.uuid(),
  title: z.string(),
  documentTemplatesCreated: z.number().int(),
  imagesCopied: z.number().int(),
  source: packageOriginSchema,
  /**
   * The publish check, run on the file: `problems` must be fixed before the
   * draft publishes (the builder's own check says the same); `warnings`
   * (missing Arabic, say) stop nothing.
   */
  check: packageCheckSchema,
});

export const importFormRoute = defineRoute({
  method: 'post',
  path: '/v1/forms/import',
  operationId: 'importForm',
  summary: 'Import a .integr8form file as a new draft form',
  description: `Integr8 staff only, acting as the company to import into (\`form.manage\` and the impersonation claim; \`document.design\` when the file has PDF templates). The body is the file itself, sent as \`${FORM_PACKAGE_MEDIA_TYPE}\`, at most ${String(FORM_PACKAGE_LIMITS.fileBytes / 1024 / 1024)} MB. It is read with every check of the format (\`docs/form-engine/package-format.md\`); a refusal answers 422 with the package's code (\`package_invalid\`, \`package_too_large\`, \`package_too_new\`, \`package_entry_unexpected\`, \`package_file_mismatch\`, \`package_image_invalid\`, \`package_form_invalid\`, \`package_template_invalid\`) and \`details\` naming each problem's entry and place. The file becomes a new form with an unpublished draft and the file's settings — never a change to an existing form; when a form of the same name exists, the new one is called "<name> (imported)". Its PDF templates are created with their pictures written into the company's storage under new ids (409 \`storage_quota_exceeded\` past a blocking allowance; nothing is kept when anything fails). \`check\` lists what must be fixed before the draft publishes, and warnings such as missing Arabic. Audited in the company (\`form.imported\`) and the platform. Honours \`Idempotency-Key\`.`,
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.manage',
  idempotent: true,
  fileBody: FORM_PACKAGE_MEDIA_TYPE,
  bodyLimit: FORM_PACKAGE_LIMITS.fileBytes,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    201: { description: 'The new form.', schema: importedFormSchema },
    403: { description: 'Not Integr8 staff, or PDF templates without `document.design`.' },
    409: { description: 'Not enough storage for its pictures (`storage_quota_exceeded`).' },
    413: { description: 'The file is larger than the limit (`body_too_large`).' },
    422: { description: 'The file is not one this server reads; `details` say why.' },
  },
  handler: async (_input, context) => {
    const staff = staffOf(context, 'import a form');
    const { principal } = context;
    const { unpacked, check } = readUpload(context.fileBody);
    if (unpacked.templates.length > 0 && !holds(principal, 'document.design')) {
      throw forbidden('Importing PDF templates needs the right to design them.');
    }

    // Storage first, so a company with no room is refused before anything is written.
    await assertPicturesFit(
      principal.tenantId,
      unpacked.files.map((file) => ({ byteSize: file.bytes.length })),
    );
    const store =
      unpacked.files.length === 0
        ? null
        : await companyStore(context.services.media, principal.tenantId);
    const copies =
      store === null ? [] : await storePictures(store, unpacked.files, (id) => mediaKey(id));

    const origin = packageOrigin(unpacked);
    let created: { formId: string; title: string; documentTemplates: number };
    try {
      created = await withTenant(principal.tenantId, async (tx) => {
        const title = importTitle(
          unpacked.manifest.form.title,
          (await tx.forms.listForms()).map((form) => form.title),
        );
        const form = await tx.forms.createForm({
          title,
          createdBy: principal.userId,
          fillRoles: unpacked.settings.fillRoles,
          signatureRequired: unpacked.settings.signatureRequired,
        });
        await tx.forms.createDraft({
          formId: form.id,
          definition: withRequiredSchemaVersion(unpacked.form),
          createdBy: principal.userId,
        });
        const brought = await bringTemplatesIn({
          tx,
          formId: form.id,
          templates: unpacked.templates,
          copies,
          by: principal.userId,
        });
        await auditInCompany(tx, context, {
          action: 'form.imported',
          resourceId: form.id,
          metadata: {
            sourceApp: origin.app,
            sourceVersion: origin.version,
            exportedFrom: origin.exportedFrom,
            versionNumber: origin.versionNumber,
            fileCreatedAt: origin.createdAt,
            documentTemplates: brought.templateIds,
            pictures: brought.pictures,
            problems: check.problems.length,
            warnings: check.warnings.length,
          },
        });
        return { formId: form.id, title, documentTemplates: brought.templateIds.length };
      });
    } catch (error) {
      // Nothing was committed: the pictures written for it go too.
      if (store !== null) {
        await discardPictures(store, copies);
      }
      throw error;
    }

    await auditOnPlatform(context, staff, {
      action: 'form.imported',
      formId: created.formId,
      metadata: {
        sourceApp: origin.app,
        sourceVersion: origin.version,
        exportedFrom: origin.exportedFrom,
        documentTemplates: created.documentTemplates,
        pictures: copies.length,
      },
    });

    return {
      status: 201,
      body: {
        formId: created.formId,
        title: created.title,
        documentTemplatesCreated: created.documentTemplates,
        imagesCopied: copies.length,
        source: origin,
        check: checkBody(check),
      },
    };
  },
});

export const formPackageRoutes = [exportFormRoute, importFormRoute];
