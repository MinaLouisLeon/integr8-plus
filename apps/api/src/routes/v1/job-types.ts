import {
  normaliseJobTypeCode,
  type JobType,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { booleanQuery, prioritySchema } from './operations.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Job types: what each kind of job carries onto a new work order (P10).
 *
 * Read by everyone, because a work order names its type; configured by owners
 * and admins. A type is archived, never deleted, because jobs point at it.
 */

const TAGS = ['job-types'];

const jobTypeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  code: z.string(),
  description: z.string().nullable(),
  expectedDurationMinutes: z.number().int().nullable(),
  defaultPriority: prioritySchema,
  instructions: z.string().nullable(),
  checklist: z.array(z.object({ id: z.string(), label: z.string() })),
  forms: z.array(z.object({ formId: z.uuid(), title: z.string(), required: z.boolean() })),
  /** Photos to take before starting and when done; a job needs them to complete (P14). */
  beforePhotos: z.number().int(),
  afterPhotos: z.number().int(),
  /** Whether the customer signs off before a job of this type completes. */
  signatureRequired: z.boolean(),
  archived: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});

const jobTypeInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  code: z
    .string()
    .trim()
    .min(1)
    .max(32)
    .refine(
      (code) => /^[A-Z0-9][A-Z0-9_-]{0,31}$/u.test(normaliseJobTypeCode(code)),
      'Letters, digits, - and _',
    ),
  description: z.string().trim().max(2000).nullable().optional(),
  expectedDurationMinutes: z.number().int().min(1).max(10_080).nullable().optional(),
  defaultPriority: prioritySchema.optional(),
  instructions: z.string().trim().max(10_000).nullable().optional(),
  /** Items without an id are given one. */
  checklist: z
    .array(
      z.object({ id: z.string().max(64).optional(), label: z.string().trim().min(1).max(300) }),
    )
    .max(100)
    .optional(),
  forms: z
    .array(z.object({ formId: z.uuid(), required: z.boolean() }))
    .max(20)
    .optional(),
  beforePhotos: z.number().int().min(0).max(20).optional(),
  afterPhotos: z.number().int().min(0).max(20).optional(),
  signatureRequired: z.boolean().optional(),
});

async function jobTypeBody(tx: TenantTransaction, jobType: JobType) {
  const titles = new Map((await tx.forms.listForms()).map((form) => [form.id, form.title]));
  return {
    id: jobType.id,
    name: jobType.name,
    code: jobType.code,
    description: jobType.description,
    expectedDurationMinutes: jobType.expectedDurationMinutes,
    defaultPriority: jobType.defaultPriority,
    instructions: jobType.instructions,
    checklist: jobType.checklist,
    forms: jobType.forms.map((form) => ({
      formId: form.formId,
      title: titles.get(form.formId) ?? '',
      required: form.required,
    })),
    beforePhotos: jobType.beforePhotos,
    afterPhotos: jobType.afterPhotos,
    signatureRequired: jobType.signatureRequired,
    archived: jobType.archivedAt !== null,
    createdAt: iso(jobType.createdAt),
    updatedAt: iso(jobType.updatedAt),
    archivedAt: isoOrNull(jobType.archivedAt),
  };
}

async function requireForms(
  tx: TenantTransaction,
  forms: readonly { formId: string }[] | undefined,
) {
  if (forms === undefined || forms.length === 0) {
    return;
  }
  const known = new Set((await tx.forms.listForms()).map((form) => form.id));
  const unknown = forms.findIndex((form) => !known.has(form.formId));
  if (unknown >= 0) {
    throw unprocessable('unknown_form', 'A form on this job type does not exist.', [
      {
        field: `body.forms.${String(unknown)}.formId`,
        code: 'unknown_form',
        message: 'Choose one of the company’s forms.',
      },
    ]);
  }
}

function codeTaken(error: unknown): never {
  const { code, constraint } = error as { code?: string; constraint?: string };
  if (
    code === '23505' &&
    (constraint === 'job_types_code_unique' || constraint === 'job_types_name_unique')
  ) {
    const field = constraint === 'job_types_code_unique' ? 'code' : 'name';
    throw unprocessable(`${field}_taken`, `Another job type already has this ${field}.`, [
      {
        field: `body.${field}`,
        code: `${field}_taken`,
        message: `Another job type already has this ${field}.`,
      },
    ]);
  }
  throw error;
}

const withIds = (checklist: readonly { id?: string | undefined; label: string }[] | undefined) =>
  checklist?.map((item) => ({ id: item.id ?? randomUUID(), label: item.label }));

export const listJobTypesRoute = defineRoute({
  method: 'get',
  path: '/v1/job-types',
  operationId: 'listJobTypes',
  summary: 'Job types',
  tags: TAGS,
  security: 'authenticated',
  permission: 'tenant.read',
  params: noSchema,
  query: z.object({ includeArchived: booleanQuery }),
  body: noSchema,
  responses: {
    200: {
      description: 'Job types, by name.',
      schema: z.object({ items: z.array(jobTypeSchema) }),
    },
  },
  handler: async ({ query }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      const types = await tx.jobTypes.list({ includeArchived: query.includeArchived === 'true' });
      return Promise.all(types.map((type) => jobTypeBody(tx, type)));
    });
    return { status: 200, body: { items } };
  },
});

export const getJobTypeRoute = defineRoute({
  method: 'get',
  path: '/v1/job-types/:jobTypeId',
  operationId: 'getJobType',
  summary: 'A job type',
  tags: TAGS,
  security: 'authenticated',
  permission: 'tenant.read',
  params: z.object({ jobTypeId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The job type.', schema: jobTypeSchema },
    404: { description: 'No such job type.' },
  },
  handler: async ({ params }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const type = await tx.jobTypes.find(params.jobTypeId);
      if (type === undefined) {
        throw notFound('This job type does not exist.');
      }
      return jobTypeBody(tx, type);
    });
    return { status: 200, body };
  },
});

export const createJobTypeRoute = defineRoute({
  method: 'post',
  path: '/v1/job-types',
  operationId: 'createJobType',
  summary: 'Add a job type',
  description: 'Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'job_type.manage',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: jobTypeInputSchema,
  responses: {
    201: { description: 'The job type.', schema: jobTypeSchema },
    422: { description: 'Invalid, or the code or name is taken.' },
  },
  handler: async ({ body }, context) => {
    const created = await withTenant(context.principal.tenantId, async (tx) => {
      await requireForms(tx, body.forms);
      const type = await tx.jobTypes
        .create(
          {
            name: body.name,
            code: body.code,
            ...(body.description === undefined ? {} : { description: body.description }),
            ...(body.expectedDurationMinutes === undefined
              ? {}
              : { expectedDurationMinutes: body.expectedDurationMinutes }),
            ...(body.defaultPriority === undefined
              ? {}
              : { defaultPriority: body.defaultPriority }),
            ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
            ...(body.checklist === undefined ? {} : { checklist: withIds(body.checklist)! }),
            ...(body.forms === undefined ? {} : { forms: body.forms }),
            ...(body.beforePhotos === undefined ? {} : { beforePhotos: body.beforePhotos }),
            ...(body.afterPhotos === undefined ? {} : { afterPhotos: body.afterPhotos }),
            ...(body.signatureRequired === undefined
              ? {}
              : { signatureRequired: body.signatureRequired }),
          },
          context.principal.userId,
        )
        .catch(codeTaken);
      return jobTypeBody(tx, type);
    });
    return { status: 201, body: created };
  },
});

export const updateJobTypeRoute = defineRoute({
  method: 'patch',
  path: '/v1/job-types/:jobTypeId',
  operationId: 'updateJobType',
  summary: 'Change or archive a job type',
  description:
    'Changes apply to work orders created afterwards; jobs already created keep the forms and checklist they were given. `forms` replaces the list.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'job_type.manage',
  params: z.object({ jobTypeId: z.uuid() }),
  query: noSchema,
  body: jobTypeInputSchema
    .partial()
    .extend({ archived: z.boolean().optional() })
    .refine((value) => Object.keys(value).length > 0, 'Change at least one thing'),
  responses: {
    200: { description: 'The job type.', schema: jobTypeSchema },
    404: { description: 'No such job type.' },
  },
  handler: async ({ params, body }, context) => {
    const updated = await withTenant(context.principal.tenantId, async (tx) => {
      await requireForms(tx, body.forms);
      const { archived, ...changes } = body;
      let type = await tx.jobTypes
        .update(params.jobTypeId, {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.code === undefined ? {} : { code: changes.code }),
          ...(changes.description === undefined ? {} : { description: changes.description }),
          ...(changes.expectedDurationMinutes === undefined
            ? {}
            : { expectedDurationMinutes: changes.expectedDurationMinutes }),
          ...(changes.defaultPriority === undefined
            ? {}
            : { defaultPriority: changes.defaultPriority }),
          ...(changes.instructions === undefined ? {} : { instructions: changes.instructions }),
          ...(changes.checklist === undefined ? {} : { checklist: withIds(changes.checklist)! }),
          ...(changes.forms === undefined ? {} : { forms: changes.forms }),
          ...(changes.beforePhotos === undefined ? {} : { beforePhotos: changes.beforePhotos }),
          ...(changes.afterPhotos === undefined ? {} : { afterPhotos: changes.afterPhotos }),
          ...(changes.signatureRequired === undefined
            ? {}
            : { signatureRequired: changes.signatureRequired }),
        })
        .catch(codeTaken);
      if (type !== undefined && archived !== undefined) {
        type = await tx.jobTypes.setArchived(type.id, archived);
      }
      if (type === undefined) {
        throw notFound('This job type does not exist.');
      }
      return jobTypeBody(tx, type);
    });
    return { status: 200, body: updated };
  },
});

export const jobTypeRoutes = [
  listJobTypesRoute,
  getJobTypeRoute,
  createJobTypeRoute,
  updateJobTypeRoute,
];
