import {
  FORM_TEMPLATE_CATEGORIES,
  FORM_TEMPLATE_SOURCES,
  type FormTemplateRecord,
  getPlatformDataSource,
} from '@integr8/db';
import { FORM_TEMPLATES } from '@integr8/form-engine/templates';
import { z } from 'zod';
import {
  discardPictures,
  getLibraryStore,
  libraryContentFromForm,
} from '../../../documents/template-copies.js';
import { ApiError, conflict, notFound } from '../../../http/errors.js';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { iso, isoOrNull } from '../schemas.js';
import { recordPlatformAction } from './audit.js';
import { platformListSchema } from './schemas.js';

/**
 * The global form template library (P15; form builder decision 1B, 1.3.0).
 *
 * One library, no company. A template is a starting point a customer clones
 * into their own form and then owns; changing the template afterwards changes
 * nothing they have already cloned, which is the behaviour people expect from
 * a template and the reason it is a copy rather than a reference.
 *
 * Two kinds sit side by side. The built-in ones ship in @integr8/form-engine,
 * `db templates` keeps them equal to the code, and nothing here changes them.
 * Staff-made ones were saved from a company's form (`POST /v1/forms/{formId}/
 * library-template`, from the staff app) and carry that form's PDF templates;
 * they are renamed, replaced with a newer version of the form and retired
 * here.
 *
 * Templates are never deleted. A company may have started from one, and a
 * template that disappeared would be a support question with no answer; a
 * retired one is only no longer offered.
 */

const localizedInput = z.record(z.string().min(2).max(10), z.string().max(2000));

export const libraryTemplateSchema = z.object({
  key: z.string(),
  /** By language tag, like everything else people read. */
  title: z.record(z.string(), z.string()),
  description: z.record(z.string(), z.string()),
  category: z.enum(FORM_TEMPLATE_CATEGORIES),
  definitionSchemaVersion: z.number().int(),
  updatedAt: z.iso.datetime(),
  /** `builtin`: shipped with the product, read-only. `staff`: saved from a company's form. */
  source: z.enum(FORM_TEMPLATE_SOURCES),
  /** A retired staff-made template is no longer offered to companies. */
  retiredAt: z.iso.datetime().nullable(),
  /** Where a staff-made template came from. */
  origin: z
    .object({
      tenantId: z.uuid(),
      /** Null once that company is gone. */
      companyName: z.string().nullable(),
      formId: z.uuid(),
      versionNumber: z.number().int().nullable(),
    })
    .nullable(),
  /** How many PDF templates it carries to a company that starts from it. */
  documentTemplateCount: z.number().int(),
});

const templateWithDefinitionSchema = libraryTemplateSchema.extend({
  definition: z.record(z.string(), z.unknown()),
});

export async function libraryTemplateBody(
  template: FormTemplateRecord,
  companies?: ReadonlyMap<string, string>,
): Promise<z.infer<typeof libraryTemplateSchema>> {
  let companyName: string | null = null;
  if (template.origin !== null) {
    companyName =
      companies === undefined
        ? ((await getPlatformDataSource().tenants.findById(template.origin.tenantId))?.name ?? null)
        : (companies.get(template.origin.tenantId) ?? null);
  }
  return {
    key: template.key,
    title: template.title,
    description: template.description,
    category: template.category,
    definitionSchemaVersion: template.definitionSchemaVersion,
    updatedAt: iso(template.updatedAt),
    source: template.source,
    retiredAt: isoOrNull(template.retiredAt),
    origin:
      template.origin === null
        ? null
        : {
            tenantId: template.origin.tenantId,
            companyName,
            formId: template.origin.formId,
            versionNumber: template.origin.versionNumber,
          },
    documentTemplateCount: template.documentCount,
  };
}

async function requireStaffTemplate(key: string): Promise<FormTemplateRecord> {
  const template = await getPlatformDataSource().formTemplates.find(key);
  if (template === undefined) {
    throw notFound(`No form template "${key}"`);
  }
  if (template.source !== 'staff') {
    throw conflict(
      'form_template_builtin',
      'This template ships with the product and is changed only in its code.',
    );
  }
  return template;
}

const keyParams = z.object({ key: z.string().min(1).max(100) });

export const listTemplatesRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/form-templates',
  operationId: 'listPlatformFormTemplates',
  summary: 'The global form template library',
  description: 'Built-in and staff-made templates, retired ones included.',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The library.', schema: platformListSchema(libraryTemplateSchema) },
  },
  handler: async (_input, context) => {
    void context;
    const platform = getPlatformDataSource();
    const [templates, tenants] = await Promise.all([
      platform.formTemplates.list(),
      platform.tenants.list({ includeDeleted: true }),
    ]);
    const companies = new Map(tenants.map((tenant) => [tenant.id as string, tenant.name]));
    return {
      status: 200,
      body: {
        items: await Promise.all(
          templates.map((template) => libraryTemplateBody(template, companies)),
        ),
      },
    };
  },
});

export const getTemplateRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/form-templates/:key',
  operationId: 'getPlatformFormTemplate',
  summary: 'One template, with its definition',
  tags: ['platform'],
  security: 'platform',
  params: keyParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The template.', schema: templateWithDefinitionSchema },
    404: { description: 'No such template.' },
  },
  handler: async ({ params }, context) => {
    void context;
    const template = await getPlatformDataSource().formTemplates.find(params.key);
    if (template === undefined) {
      throw notFound(`No form template "${params.key}"`);
    }
    return {
      status: 200,
      body: { ...(await libraryTemplateBody(template)), definition: template.definition },
    };
  },
});

export const upsertTemplateRoute = defineRoute({
  method: 'put',
  path: '/v1/platform/form-templates/:key',
  operationId: 'upsertFormTemplate',
  summary: 'Add a staff-made template, or replace one',
  description:
    'Saves a staff-made template under this key, from a definition rather than a company’s form. Forms already cloned from it are untouched — a clone is a copy, not a reference — so this changes what the next person starts from and nothing else. A built-in template (or a key the product ships) is refused with 409 `form_template_builtin`: those change only in the code.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u) }),
  query: noSchema,
  body: z.object({
    title: z.record(z.string().min(2).max(10), z.string().min(1).max(200)),
    description: z.record(z.string().min(2).max(10), z.string().max(2000)),
    category: z.enum(FORM_TEMPLATE_CATEGORIES),
    definition: z.record(z.string(), z.unknown()),
  }),
  responses: {
    200: { description: 'Saved.', schema: templateWithDefinitionSchema },
    409: { description: 'A built-in template (`form_template_builtin`).' },
    422: { description: 'The definition is not a form this system can compile.' },
  },
  handler: async ({ params, body }, context) => {
    const templates = getPlatformDataSource().formTemplates;
    const by = context.platform.platformUserId;
    if (FORM_TEMPLATES.some((template) => template.key === params.key)) {
      throw conflict(
        'form_template_builtin',
        'This template ships with the product and is changed only in its code.',
      );
    }
    const existing = await templates.find(params.key);
    if (existing === undefined) {
      await templates.createStaff({
        key: params.key,
        title: body.title,
        description: body.description,
        category: body.category,
        origin: null,
        content: {
          definition: body.definition,
          sourceVersionNumber: null,
          documents: [],
          files: [],
        },
        by,
      });
    } else {
      await requireStaffTemplate(params.key);
      await templates.updateDetails(
        params.key,
        { title: body.title, description: body.description, category: body.category },
        by,
      );
      await templates.replaceDefinition(params.key, body.definition, by);
    }

    const saved = await templates.find(params.key);
    if (saved === undefined) {
      throw notFound(`No form template "${params.key}"`);
    }

    await recordPlatformAction(context, {
      action: 'form_template.saved',
      targetKind: 'form_template',
      targetId: params.key,
      metadata: { category: body.category },
    });

    return {
      status: 200,
      body: { ...(await libraryTemplateBody(saved)), definition: saved.definition },
    };
  },
});

export const updateTemplateDetailsRoute = defineRoute({
  method: 'patch',
  path: '/v1/platform/form-templates/:key',
  operationId: 'updatePlatformFormTemplate',
  summary: 'Rename or re-describe a staff-made template',
  description:
    'Its name and description in each language, and its category. A built-in template answers 409 `form_template_builtin`.',
  tags: ['platform'],
  security: 'platform',
  params: keyParams,
  query: noSchema,
  body: z
    .object({
      title: localizedInput.optional(),
      description: localizedInput.optional(),
      category: z.enum(FORM_TEMPLATE_CATEGORIES).optional(),
    })
    .refine((value) => Object.keys(value).length > 0, 'Change at least one thing'),
  responses: {
    200: { description: 'The template.', schema: libraryTemplateSchema },
    404: { description: 'No such template.' },
    409: { description: 'A built-in template (`form_template_builtin`).' },
  },
  handler: async ({ params, body }, context) => {
    await requireStaffTemplate(params.key);
    const clean = (value: Record<string, string> | undefined) =>
      value === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(value)
              .map(([tag, text]) => [tag, text.trim()] as const)
              .filter(([, text]) => text !== ''),
          );
    const title = clean(body.title);
    if (title !== undefined && Object.keys(title).length === 0) {
      throw conflict('form_template_title_required', 'A template needs a name in one language.');
    }
    const saved = await getPlatformDataSource().formTemplates.updateDetails(
      params.key,
      { title, description: clean(body.description), category: body.category },
      context.platform.platformUserId,
    );
    if (saved === undefined) {
      throw notFound(`No form template "${params.key}"`);
    }
    await recordPlatformAction(context, {
      action: 'form_template.renamed',
      targetKind: 'form_template',
      targetId: params.key,
      metadata: { fields: Object.keys(body) },
    });
    return { status: 200, body: await libraryTemplateBody(saved) };
  },
});

export const retireTemplateRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/form-templates/:key/retire',
  operationId: 'retirePlatformFormTemplate',
  summary: 'Retire a staff-made template, or bring it back',
  description:
    'A retired template is no longer offered to companies; forms already made from it are copies and stay as they are. A built-in template answers 409 `form_template_builtin`.',
  tags: ['platform'],
  security: 'platform',
  params: keyParams,
  query: noSchema,
  body: z.object({ retired: z.boolean() }),
  responses: {
    200: { description: 'The template.', schema: libraryTemplateSchema },
    404: { description: 'No such template.' },
    409: { description: 'A built-in template (`form_template_builtin`).' },
  },
  handler: async ({ params, body }, context) => {
    await requireStaffTemplate(params.key);
    const saved = await getPlatformDataSource().formTemplates.setRetired(
      params.key,
      body.retired,
      context.platform.platformUserId,
    );
    if (saved === undefined) {
      throw notFound(`No form template "${params.key}"`);
    }
    await recordPlatformAction(context, {
      action: body.retired ? 'form_template.retired' : 'form_template.restored',
      targetKind: 'form_template',
      targetId: params.key,
    });
    return { status: 200, body: await libraryTemplateBody(saved) };
  },
});

export const refreshTemplateRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/form-templates/:key/refresh',
  operationId: 'refreshPlatformFormTemplate',
  summary: 'Replace a staff-made template with its form’s newer version',
  description:
    'Reads the form the template was saved from, in its company, again: its last published version and its PDF templates that are not archived (pictures copied into the library storage) replace the template’s. Its name, description and category stay. 409 `form_template_builtin` for a built-in template, `form_template_source_gone` when the company or form no longer exists, `form_not_published` when nothing is published.',
  tags: ['platform'],
  security: 'platform',
  params: keyParams,
  query: noSchema,
  body: z.object({ includeDocumentTemplates: z.boolean().default(true) }),
  responses: {
    200: { description: 'The template.', schema: libraryTemplateSchema },
    404: { description: 'No such template.' },
    409: { description: 'Built in, or its form is gone or unpublished.' },
  },
  handler: async ({ params, body }, context) => {
    const template = await requireStaffTemplate(params.key);
    const platform = getPlatformDataSource();
    const origin = template.origin;
    const company = origin === null ? undefined : await platform.tenants.findById(origin.tenantId);
    if (origin === null || company?.deletedAt !== null) {
      throw conflict(
        'form_template_source_gone',
        'The form this template was saved from no longer exists; save a form to the library again instead.',
      );
    }
    let gathered: Awaited<ReturnType<typeof libraryContentFromForm>>;
    try {
      gathered = await libraryContentFromForm({
        media: context.services.media,
        tenantId: origin.tenantId,
        formId: origin.formId,
        includeDocumentTemplates: body.includeDocumentTemplates,
      });
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        throw conflict(
          'form_template_source_gone',
          'The form this template was saved from no longer exists; save a form to the library again instead.',
        );
      }
      throw error;
    }
    let old: Awaited<ReturnType<typeof platform.formTemplates.replaceContent>>;
    try {
      old = await platform.formTemplates.replaceContent(
        params.key,
        gathered.content,
        context.platform.platformUserId,
      );
    } catch (error) {
      await discardPictures(gathered.library, gathered.copies);
      throw error;
    }
    // The pictures of the version replaced, now that nothing names them.
    if (old !== undefined && old.length > 0) {
      const store = await getLibraryStore(context.services.media);
      await store.delete(old.map((file) => file.storageKey)).catch(() => undefined);
    }
    await recordPlatformAction(context, {
      action: 'form_template.refreshed',
      tenantId: origin.tenantId,
      tenantSlug: company.slug,
      targetKind: 'form_template',
      targetId: params.key,
      metadata: {
        formId: origin.formId,
        versionNumber: gathered.content.sourceVersionNumber,
        documentTemplates: gathered.content.documents.length,
      },
    });
    const saved = await platform.formTemplates.find(params.key);
    if (saved === undefined) {
      throw notFound(`No form template "${params.key}"`);
    }
    return { status: 200, body: await libraryTemplateBody(saved) };
  },
});

export const platformTemplateRoutes = [
  listTemplatesRoute,
  getTemplateRoute,
  upsertTemplateRoute,
  updateTemplateDetailsRoute,
  retireTemplateRoute,
  refreshTemplateRoute,
];
