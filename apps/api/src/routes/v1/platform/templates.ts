import {
  FORM_TEMPLATE_CATEGORIES,
  type FormTemplateRecord,
  getPlatformDataSource,
} from '@integr8/db';
import { z } from 'zod';
import { notFound } from '../../../http/errors.js';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { iso } from '../schemas.js';
import { recordPlatformAction } from './audit.js';
import { platformListSchema } from './schemas.js';

/**
 * The global form template library (P15).
 *
 * One library, no company. A template is a starting point a customer clones
 * into their own form and then owns; changing the template afterwards changes
 * nothing they have already cloned, which is the behaviour people expect from
 * a template and the reason it is a copy rather than a reference.
 *
 * Templates are never deleted, only replaced. A company may have cloned one,
 * and a template that disappeared from the list would be a support question
 * with no answer.
 */

const templateSchema = z.object({
  key: z.string(),
  /** By language tag, like everything else people read. */
  title: z.record(z.string(), z.string()),
  description: z.record(z.string(), z.string()),
  category: z.enum(FORM_TEMPLATE_CATEGORIES),
  definitionSchemaVersion: z.number().int(),
  updatedAt: z.iso.datetime(),
});

const templateWithDefinitionSchema = templateSchema.extend({
  definition: z.record(z.string(), z.unknown()),
});

export const listTemplatesRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/form-templates',
  operationId: 'listPlatformFormTemplates',
  summary: 'The global form template library',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The library.', schema: platformListSchema(templateSchema) },
  },
  handler: async (_input, context) => {
    void context;
    const templates = await getPlatformDataSource().formTemplates.list();
    return { status: 200, body: { items: templates.map(toSummary) } };
  },
});

export const getTemplateRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/form-templates/:key',
  operationId: 'getPlatformFormTemplate',
  summary: 'One template, with its definition',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ key: z.string().min(1).max(100) }),
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
    return { status: 200, body: { ...toSummary(template), definition: template.definition } };
  },
});

export const upsertTemplateRoute = defineRoute({
  method: 'put',
  path: '/v1/platform/form-templates/:key',
  operationId: 'upsertFormTemplate',
  summary: 'Add a template, or replace one',
  description:
    'Replaces the template under this key. Forms already cloned from it are untouched — a clone is a copy, not a reference — so this changes what the next person starts from and nothing else.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ key: z.string().min(1).max(100) }),
  query: noSchema,
  body: z.object({
    title: z.record(z.string().min(2).max(10), z.string().min(1).max(200)),
    description: z.record(z.string().min(2).max(10), z.string().max(2000)),
    category: z.enum(FORM_TEMPLATE_CATEGORIES),
    definition: z.record(z.string(), z.unknown()),
  }),
  responses: {
    200: { description: 'Saved.', schema: templateWithDefinitionSchema },
    422: { description: 'The definition is not a form this system can compile.' },
  },
  handler: async ({ params, body }, context) => {
    const templates = getPlatformDataSource().formTemplates;
    await templates.upsert([
      {
        key: params.key,
        title: body.title,
        description: body.description,
        category: body.category,
        definition: body.definition,
      },
    ]);

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

    return { status: 200, body: { ...toSummary(saved), definition: saved.definition } };
  },
});

function toSummary(template: FormTemplateRecord): z.infer<typeof templateSchema> {
  return {
    key: template.key,
    title: template.title,
    description: template.description,
    category: template.category,
    definitionSchemaVersion: template.definitionSchemaVersion,
    updatedAt: iso(template.updatedAt),
  };
}

export const platformTemplateRoutes = [listTemplatesRoute, getTemplateRoute, upsertTemplateRoute];
