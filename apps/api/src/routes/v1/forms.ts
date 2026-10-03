import { can, roleSchema } from '@integr8/core';
import {
  type Form,
  type FormVersion,
  type FormVersionSummary,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import {
  compileDefinition,
  type DefinitionIssue,
  diffDefinitions,
  emptyDefinition,
  type FormDefinition,
  validateSubmission,
} from '@integr8/form-engine';
import { z } from 'zod';
import { conflict, type ErrorDetail, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { iso, isoOrNull, listSchema } from './schemas.js';

/**
 * Forms, drafts, publishing and the template library — the API behind P07's
 * builder.
 *
 * Three rules shape every handler here:
 *
 * - **A draft may be invalid; a published version may not.** Autosave stores
 *   whatever the builder has, because a half-built form is what a draft is.
 *   Publish compiles the whole definition with @integr8/form-engine and refuses
 *   anything that does not compile, naming the fields. There is no other path
 *   to a published version.
 * - **Nobody publishes what they did not see.** Saves and publishes name the
 *   draft revision they are based on, and a stale one is refused.
 * - **Breaking changes are acknowledged, not discovered.** Removing a field
 *   existing submissions answered is legal; publishing it without saying so is
 *   not.
 *
 * Only people who can build forms see drafts. Everyone else sees published
 * versions.
 */

const TAGS = ['forms'];

// ---------------------------------------------------------------------------
// Contract shapes
// ---------------------------------------------------------------------------

/**
 * A definition, as JSON. Deliberately not the engine's full schema here: a
 * draft is allowed to be incomplete, and the contract should not promise a
 * shape the server then refuses. Validity is what `check` and `publish` report.
 */
const definitionSchema = z
  .record(z.string(), z.unknown())
  .refine(
    (value) => Number.isInteger(value.schemaVersion),
    'A definition must carry an integer schemaVersion',
  );

const localizedSchema = z.record(z.string(), z.string());

const formSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  fillRoles: z.array(roleSchema),
  signatureRequired: z.boolean(),
  /** The job types that require this form to be submitted before a job of theirs can complete. */
  requiredByJobTypeIds: z.array(z.uuid()),
  clonedFromFormId: z.uuid().nullable(),
  sourceTemplateKey: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const versionSummarySchema = z.object({
  id: z.uuid(),
  formId: z.uuid(),
  status: z.enum(['draft', 'published']),
  versionNumber: z.number().int().nullable(),
  revision: z.number().int(),
  changeNote: z.string().nullable(),
  changes: z.record(z.string(), z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
  publishedBy: z.uuid().nullable(),
});

const versionSchema = versionSummarySchema.extend({ definition: definitionSchema });

const formListItemSchema = formSchema.extend({
  latestVersionNumber: z.number().int().nullable(),
  latestPublishedAt: z.string().nullable(),
  hasDraft: z.boolean(),
  /** Whether this person may start filling it: a published version, and a role the form allows. */
  canFill: z.boolean(),
});

export const formDetailSchema = z.object({
  form: formSchema,
  /** Present only for people who may build forms. */
  draft: versionSchema.nullable(),
  live: versionSchema.nullable(),
});

const issueSchema = z.object({
  code: z.string(),
  message: z.string(),
  path: z.string(),
  elements: z.array(z.string()),
});

const changeSchema = z.object({
  kind: z.enum(['added', 'removed', 'moved', 'changed']),
  elementKind: z.enum(['page', 'section', 'field']),
  element: z.string(),
  properties: z.array(z.string()),
});

const breakingSchema = z.object({
  field: z.string(),
  reason: z.enum([
    'field_removed',
    'type_changed',
    'option_removed',
    'now_calculated',
    'now_required',
    'constraint_tightened',
  ]),
  affects: z.enum(['reporting', 'drafts']),
  detail: z.array(z.string()),
});

const diffSchema = z.object({
  titleChanged: z.boolean(),
  changes: z.array(changeSchema),
  breaking: z.array(breakingSchema),
});

const checkSchema = z.object({
  revision: z.number().int(),
  valid: z.boolean(),
  issues: z.array(issueSchema),
  diff: diffSchema,
});

const templateSummarySchema = z.object({
  key: z.string(),
  title: localizedSchema,
  description: localizedSchema,
  category: z.enum(['maintenance', 'safety', 'completion']),
  fieldCount: z.number().int(),
});

const templateSchema = templateSummarySchema.extend({ definition: definitionSchema });

const testSubmissionSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.object({ code: z.string(), field: z.string().nullable() })),
  errors: z.array(
    z.object({ field: z.string(), code: z.string(), params: z.record(z.string(), z.string()) }),
  ),
  answers: z.record(z.string(), z.unknown()),
  stored: z.literal(false),
});

const formParams = z.object({ formId: z.uuid() });

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function formBody(form: Form, requiredByJobTypeIds: readonly string[] = []) {
  return {
    id: form.id,
    title: form.title,
    fillRoles: form.fillRoles,
    signatureRequired: form.signatureRequired,
    requiredByJobTypeIds: [...requiredByJobTypeIds],
    clonedFromFormId: form.clonedFromFormId,
    sourceTemplateKey: form.sourceTemplateKey,
    createdAt: iso(form.createdAt),
    updatedAt: iso(form.updatedAt),
  };
}

function summaryBody(version: FormVersionSummary) {
  return {
    id: version.id,
    formId: version.formId,
    status: version.status,
    versionNumber: version.versionNumber,
    revision: version.revision,
    changeNote: version.changeNote,
    changes: version.changes,
    createdAt: iso(version.createdAt),
    updatedAt: iso(version.updatedAt),
    publishedAt: isoOrNull(version.publishedAt),
    publishedBy: version.publishedBy,
  };
}

function versionBody(version: FormVersion) {
  return { ...summaryBody(version), definition: version.definition };
}

function fieldCount(definition: Record<string, unknown>): number {
  const pages = Array.isArray(definition.pages)
    ? (definition.pages as { sections?: { fields?: unknown[] }[] }[])
    : [];
  return pages.reduce(
    (total, page) =>
      total +
      (page.sections ?? []).reduce((sum, section) => sum + (section.fields?.length ?? 0), 0),
    0,
  );
}

/** Compile issues as API error details: `field` is the path in the definition. */
function issueDetails(issues: readonly DefinitionIssue[]): ErrorDetail[] {
  return issues.map((issue) => ({
    field: `definition.${issue.path}`,
    code: issue.code,
    message: issue.message,
  }));
}

async function requireForm(tx: TenantTransaction, formId: string): Promise<Form> {
  const form = await tx.forms.findForm(formId);
  if (form === undefined) {
    throw notFound('This form does not exist.');
  }
  return form;
}

const mayManage = (context: RequestContext) => can(context.principal.role, 'form.manage');

/** A new form with a first draft, in one transaction, so there is never a form with nothing to open. */
async function createFormWithDraft(
  tx: TenantTransaction,
  context: RequestContext,
  input: {
    title: string;
    definition: Record<string, unknown>;
    clonedFromFormId?: string;
    sourceTemplateKey?: string;
  },
) {
  const form = await tx.forms.createForm({
    title: input.title,
    createdBy: context.principal.userId,
    ...(input.clonedFromFormId === undefined ? {} : { clonedFromFormId: input.clonedFromFormId }),
    ...(input.sourceTemplateKey === undefined
      ? {}
      : { sourceTemplateKey: input.sourceTemplateKey }),
  });
  const draft = await tx.forms.createDraft({
    formId: form.id,
    definition: input.definition,
    createdBy: context.principal.userId,
  });
  return { form: formBody(form), draft: versionBody(draft), live: null };
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------

export const listFormsRoute = defineRoute({
  method: 'get',
  path: '/v1/forms',
  operationId: 'listForms',
  summary: 'Forms in this company',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.read',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'Forms, newest first.', schema: listSchema(formListItemSchema) },
  },
  handler: async (_input, context) => {
    const { forms, versions, jobTypes } = await withTenant(
      context.principal.tenantId,
      async (tx) => ({
        forms: await tx.forms.listForms(),
        versions: await tx.forms.listVersionSummaries(),
        jobTypes: await tx.jobTypes.list({ includeArchived: true }),
      }),
    );
    const requiring = (formId: string) =>
      jobTypes
        .filter((type) => type.forms.some((link) => link.formId === formId && link.required))
        .map((type) => type.id);

    const manage = mayManage(context);
    return {
      status: 200,
      body: {
        items: forms
          .map((form) => {
            const own = versions.filter((version) => version.formId === form.id);
            const latest = own.find((version) => version.status === 'published');
            return {
              ...formBody(form, requiring(form.id)),
              latestVersionNumber: latest?.versionNumber ?? null,
              latestPublishedAt: isoOrNull(latest?.publishedAt ?? null),
              hasDraft: manage && own.some((version) => version.status === 'draft'),
              canFill:
                latest !== undefined &&
                can(context.principal.role, 'submission.fill') &&
                form.fillRoles.includes(context.principal.role),
            };
          })
          // A form with nothing published is invisible to someone who cannot build it.
          .filter((item) => manage || item.latestVersionNumber !== null),
      },
    };
  },
});

export const createFormRoute = defineRoute({
  method: 'post',
  path: '/v1/forms',
  operationId: 'createForm',
  summary: 'Start a new form',
  description: 'Creates the form and an empty first draft. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.manage',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    title: z.string().trim().min(1).max(200),
    locale: z
      .string()
      .regex(/^[a-z]{2}(?:-[A-Z]{2})?$/u)
      .default('en'),
  }),
  responses: { 201: { description: 'The new form and its draft.', schema: formDetailSchema } },
  handler: async ({ body }, context) => {
    const detail = await withTenant(context.principal.tenantId, (tx) =>
      createFormWithDraft(tx, context, {
        title: body.title,
        definition: emptyDefinition({ [body.locale]: body.title }),
      }),
    );
    return { status: 201, body: detail };
  },
});

export const getFormRoute = defineRoute({
  method: 'get',
  path: '/v1/forms/:formId',
  operationId: 'getForm',
  summary: 'A form, its draft and its live version',
  description: 'The draft is included only for people who may build forms.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.read',
  params: formParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The form.', schema: formDetailSchema },
    404: { description: 'No such form, or nothing published that this person may see.' },
  },
  handler: async ({ params }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) =>
      formDetailBody(tx, mayManage(context), await requireForm(tx, params.formId)),
    );
    if (detail === undefined) {
      throw notFound('This form does not exist.');
    }
    return { status: 200, body: detail };
  },
});

/**
 * A form as its detail route and a phone's sync (P12) show it. Undefined when
 * this person may not see it: someone who does not build forms sees only forms
 * with something published.
 */
export async function formDetailBody(tx: TenantTransaction, manage: boolean, form: Form) {
  const live = await tx.forms.findLatestPublished(form.id);
  if (!manage && live === undefined) {
    return undefined;
  }
  const draft = manage ? await tx.forms.findDraft(form.id) : undefined;
  const requiring = (await tx.jobTypes.listForForm(form.id))
    .filter((link) => link.required)
    .map((link) => link.jobTypeId);
  return {
    form: formBody(form, requiring),
    draft: draft === undefined ? null : versionBody(draft),
    live: live === undefined ? null : versionBody(live),
  };
}

export const updateFormRoute = defineRoute({
  method: 'patch',
  path: '/v1/forms/:formId',
  operationId: 'updateForm',
  summary: 'Rename a form or change its settings',
  description:
    'Settings take effect immediately and are not versioned: who may fill a form, whether a signature is mandatory, and which job types require it — a job of a requiring type cannot complete until the form is submitted for it. The requirement applies to jobs created afterwards.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.manage',
  params: formParams,
  query: noSchema,
  body: z
    .object({
      title: z.string().trim().min(1).max(200).optional(),
      fillRoles: z.array(roleSchema).min(1).max(5).optional(),
      signatureRequired: z.boolean().optional(),
      requiredByJobTypeIds: z.array(z.uuid()).max(100).optional(),
    })
    .refine((value) => Object.keys(value).length > 0, 'Change at least one setting'),
  responses: {
    200: { description: 'The updated form.', schema: formSchema },
    404: { description: 'No such form.' },
  },
  handler: async ({ params, body }, context) => {
    const result = await withTenant(context.principal.tenantId, async (tx) => {
      const { requiredByJobTypeIds, ...settings } = body;
      const form =
        Object.keys(settings).length === 0
          ? await tx.forms.findForm(params.formId)
          : await tx.forms.updateForm(params.formId, {
              ...(settings.title === undefined ? {} : { title: settings.title }),
              ...(settings.fillRoles === undefined ? {} : { fillRoles: settings.fillRoles }),
              ...(settings.signatureRequired === undefined
                ? {}
                : { signatureRequired: settings.signatureRequired }),
            });
      if (form === undefined) {
        throw notFound('This form does not exist.');
      }
      if (requiredByJobTypeIds !== undefined) {
        const known = new Set(
          (await tx.jobTypes.list({ includeArchived: true })).map((type) => type.id),
        );
        const unknown = requiredByJobTypeIds.findIndex((id) => !known.has(id));
        if (unknown >= 0) {
          throw unprocessable('unknown_job_type', 'A job type named here does not exist.', [
            {
              field: `body.requiredByJobTypeIds.${String(unknown)}`,
              code: 'unknown_job_type',
              message: 'Choose one of the company’s job types.',
            },
          ]);
        }
        await tx.jobTypes.setRequiringTypes(form.id, requiredByJobTypeIds);
      }
      const requiring = (await tx.jobTypes.listForForm(form.id))
        .filter((link) => link.required)
        .map((link) => link.jobTypeId);
      return { form, requiring };
    });
    return { status: 200, body: formBody(result.form, result.requiring) };
  },
});

export const cloneFormRoute = defineRoute({
  method: 'post',
  path: '/v1/forms/:formId/clone',
  operationId: 'cloneForm',
  summary: 'Copy a form into a new one',
  description:
    'The copy starts as a draft of the latest published version, or of the draft if nothing is published. Nothing about the original changes, and the copy has no history. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.manage',
  idempotent: true,
  params: formParams,
  query: noSchema,
  body: z.object({ title: z.string().trim().min(1).max(200) }),
  responses: {
    201: { description: 'The copy and its draft.', schema: formDetailSchema },
    404: { description: 'No such form.' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const original = await requireForm(tx, params.formId);
      const source =
        (await tx.forms.findLatestPublished(original.id)) ??
        (await tx.forms.findDraft(original.id));
      if (source === undefined) {
        throw notFound('This form has nothing to copy.');
      }
      const definition = {
        ...source.definition,
        title: { ...(source.definition.title as object), en: body.title },
      };
      return createFormWithDraft(tx, context, {
        title: body.title,
        definition,
        clonedFromFormId: original.id,
      });
    });
    return { status: 201, body: detail };
  },
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export const saveDraftRoute = defineRoute({
  method: 'put',
  path: '/v1/forms/:formId/draft',
  operationId: 'saveFormDraft',
  summary: 'Autosave the draft',
  description:
    'Stores the definition as it is, valid or not. `expectedRevision` is the revision the builder last saw, or `null` to start a draft when there is none. A save based on an older revision is refused with 409, so a second tab cannot overwrite the first.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.manage',
  params: formParams,
  query: noSchema,
  body: z.object({
    definition: definitionSchema,
    expectedRevision: z.number().int().min(1).nullable(),
  }),
  responses: {
    200: { description: 'The saved draft.', schema: versionSchema },
    404: { description: 'No such form.' },
    409: { description: 'Somebody saved first. Reload the draft and reapply.' },
  },
  handler: async ({ params, body }, context) => {
    const result = await withTenant(context.principal.tenantId, async (tx) => {
      await requireForm(tx, params.formId);
      return tx.forms.saveDraft(
        params.formId,
        body.definition,
        body.expectedRevision,
        context.principal.userId,
      );
    });

    if (result.outcome === 'conflict') {
      throw conflict(
        'draft_conflict',
        result.current === undefined
          ? 'This draft was published or discarded while you were editing it.'
          : `This draft was saved elsewhere (revision ${String(result.current.revision)}) since you last loaded it.`,
      );
    }
    return { status: 200, body: versionBody(result.version) };
  },
});

async function draftAndLive(context: RequestContext, formId: string) {
  return withTenant(context.principal.tenantId, async (tx) => {
    await requireForm(tx, formId);
    const draft = await tx.forms.findDraft(formId);
    if (draft === undefined) {
      throw notFound('This form has no draft.');
    }
    const live = await tx.forms.findLatestPublished(formId);
    return { draft, live };
  });
}

/** The definition of a published version, as the engine's type. It compiled when it was published. */
function liveDefinition(live: FormVersion | undefined): FormDefinition | undefined {
  if (live === undefined) {
    return undefined;
  }
  const compiled = compileDefinition(live.definition);
  return compiled.ok ? compiled.form.definition : undefined;
}

export const checkDraftRoute = defineRoute({
  method: 'post',
  path: '/v1/forms/:formId/draft/check',
  operationId: 'checkFormDraft',
  summary: 'Validate the draft and compare it with the live version',
  description:
    'What publishing would decide, without publishing: every issue that would refuse it, named by field, and every change against the live version with the breaking ones marked.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.manage',
  params: formParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The verdict.', schema: checkSchema },
    404: { description: 'No such form, or no draft.' },
  },
  handler: async ({ params }, context) => {
    const { draft, live } = await draftAndLive(context, params.formId);
    const compiled = compileDefinition(draft.definition);

    return {
      status: 200,
      body: {
        revision: draft.revision,
        valid: compiled.ok,
        issues: compiled.ok ? [] : compiled.issues,
        diff: compiled.ok
          ? diffDefinitions(liveDefinition(live), compiled.form.definition)
          : { titleChanged: false, changes: [], breaking: [] },
      },
    };
  },
});

export const publishDraftRoute = defineRoute({
  method: 'post',
  path: '/v1/forms/:formId/draft/publish',
  operationId: 'publishFormDraft',
  summary: 'Publish the draft as a new, immutable version',
  description:
    'Refused with 422 if the definition does not compile — the details name every offending field. Refused with 409 if the draft changed since `expectedRevision`, or if it contains breaking changes and `acknowledgeBreakingChanges` is not true. Existing submissions keep pointing at the version they were made against.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.manage',
  params: formParams,
  query: noSchema,
  body: z.object({
    expectedRevision: z.number().int().min(1),
    changeNote: z.string().trim().max(2000).optional(),
    acknowledgeBreakingChanges: z.boolean().default(false),
  }),
  responses: {
    200: { description: 'The new version.', schema: versionSummarySchema },
    404: { description: 'No such form, or no draft.' },
    409: {
      description:
        'The draft changed since it was reviewed, or breaking changes were not acknowledged.',
    },
    422: { description: 'The definition does not compile. Details name the fields.' },
  },
  handler: async ({ params, body }, context) => {
    const version = await withTenant(context.principal.tenantId, async (tx) => {
      await requireForm(tx, params.formId);
      const draft = await tx.forms.findDraft(params.formId);
      if (draft === undefined) {
        throw notFound('This form has no draft.');
      }
      if (draft.revision !== body.expectedRevision) {
        throw conflict(
          'draft_changed',
          'The draft was saved again since you reviewed it. Review it again before publishing.',
        );
      }

      const compiled = compileDefinition(draft.definition);
      if (!compiled.ok) {
        throw unprocessable(
          'invalid_definition',
          `This form cannot be published: ${String(compiled.issues.length)} problem${compiled.issues.length === 1 ? '' : 's'} to fix.`,
          issueDetails(compiled.issues),
        );
      }

      const live = await tx.forms.findLatestPublished(params.formId);
      const diff = diffDefinitions(liveDefinition(live), compiled.form.definition);
      if (diff.breaking.length > 0 && !body.acknowledgeBreakingChanges) {
        throw conflict(
          'breaking_changes_unacknowledged',
          `Publishing changes ${String(new Set(diff.breaking.map((entry) => entry.field)).size)} field(s) in ways that affect existing submissions or drafts. Confirm to publish.`,
        );
      }

      const published = await tx.forms.publishDraft(draft.id, context.principal.userId, {
        changeNote: body.changeNote ?? null,
        changes: diff as unknown as Record<string, unknown>,
        expectedRevision: body.expectedRevision,
      });
      if (published === undefined) {
        throw conflict(
          'draft_changed',
          'The draft was saved or published elsewhere at the same moment.',
        );
      }

      await tx.auditLog.append({
        actorKind: 'tenant_user',
        actorId: context.principal.userId,
        actorLabel: context.principal.userId,
        action: 'form.published',
        resourceType: 'form',
        resourceId: params.formId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: {
          versionId: published.id,
          versionNumber: published.versionNumber,
          breakingChanges: diff.breaking.length,
          acknowledged: body.acknowledgeBreakingChanges,
        },
      });

      return published;
    });

    return { status: 200, body: summaryBody(version) };
  },
});

export const testSubmissionRoute = defineRoute({
  method: 'post',
  path: '/v1/forms/:formId/draft/test-submission',
  operationId: 'testFormDraftSubmission',
  summary: 'Submit a test fill of the draft, storing nothing',
  description:
    'Runs exactly the validation a real submission gets, against the draft, and returns the verdict. Nothing is written — not to submissions, not anywhere — so a test fill can never be mistaken for a job record.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.manage',
  params: formParams,
  query: noSchema,
  body: z.object({
    answers: z.record(z.string(), z.unknown()),
    today: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/u)
      .optional(),
  }),
  responses: {
    200: { description: 'What the server decided.', schema: testSubmissionSchema },
    404: { description: 'No such form, or no draft.' },
    422: { description: 'The draft itself does not compile yet.' },
  },
  handler: async ({ params, body }, context) => {
    const { draft } = await draftAndLive(context, params.formId);
    const compiled = compileDefinition(draft.definition);
    if (!compiled.ok) {
      throw unprocessable(
        'invalid_definition',
        'Fix the form before test-filling it.',
        issueDetails(compiled.issues),
      );
    }

    const check = validateSubmission(
      compiled.form,
      body.answers,
      body.today === undefined ? {} : { today: body.today },
    );
    return {
      status: 200,
      body: {
        valid: check.valid,
        issues: check.issues.map((issue) => ({ code: issue.code, field: issue.field ?? null })),
        errors: check.errors.map((error) => ({
          field: error.field,
          code: error.code,
          params: { ...error.params },
        })),
        answers: check.answers,
        stored: false as const,
      },
    };
  },
});

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

export const listVersionsRoute = defineRoute({
  method: 'get',
  path: '/v1/forms/:formId/versions',
  operationId: 'listFormVersions',
  summary: 'Version history',
  description: 'Published versions, newest first, each with its change note and change summary.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.read',
  params: formParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'Versions.', schema: listSchema(versionSummarySchema) },
    404: { description: 'No such form.' },
  },
  handler: async ({ params }, context) => {
    const versions = await withTenant(context.principal.tenantId, async (tx) => {
      await requireForm(tx, params.formId);
      return tx.forms.listVersions(params.formId);
    });
    return {
      status: 200,
      body: {
        items: versions.filter((version) => version.status === 'published').map(summaryBody),
      },
    };
  },
});

export const getVersionRoute = defineRoute({
  method: 'get',
  path: '/v1/forms/:formId/versions/:versionId',
  operationId: 'getFormVersion',
  summary: 'One version, read-only',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.read',
  params: z.object({ formId: z.uuid(), versionId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The version, with its definition.', schema: versionSchema },
    404: { description: 'No such version of this form.' },
  },
  handler: async ({ params }, context) => {
    const version = await withTenant(context.principal.tenantId, (tx) =>
      tx.forms.findVersion(params.versionId),
    );
    if (version?.formId !== params.formId || (version.status === 'draft' && !mayManage(context))) {
      throw notFound('This version does not exist.');
    }
    return { status: 200, body: versionBody(version) };
  },
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export const listTemplatesRoute = defineRoute({
  method: 'get',
  path: '/v1/form-templates',
  operationId: 'listFormTemplates',
  summary: 'The global template library',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.read',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'Templates.', schema: listSchema(templateSummarySchema) } },
  handler: async (_input, context) => {
    const templates = await withTenant(context.principal.tenantId, (tx) => tx.formTemplates.list());
    return {
      status: 200,
      body: {
        items: templates.map((template) => ({
          key: template.key,
          title: template.title,
          description: template.description,
          category: template.category,
          fieldCount: fieldCount(template.definition),
        })),
      },
    };
  },
});

export const getTemplateRoute = defineRoute({
  method: 'get',
  path: '/v1/form-templates/:key',
  operationId: 'getFormTemplate',
  summary: 'One template, to preview',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.read',
  params: z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u) }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The template.', schema: templateSchema },
    404: { description: 'No such template.' },
  },
  handler: async ({ params }, context) => {
    const template = await withTenant(context.principal.tenantId, (tx) =>
      tx.formTemplates.find(params.key),
    );
    if (template === undefined) {
      throw notFound('This template does not exist.');
    }
    return {
      status: 200,
      body: {
        key: template.key,
        title: template.title,
        description: template.description,
        category: template.category,
        fieldCount: fieldCount(template.definition),
        definition: template.definition,
      },
    };
  },
});

export const cloneTemplateRoute = defineRoute({
  method: 'post',
  path: '/v1/form-templates/:key/clone',
  operationId: 'cloneFormTemplate',
  summary: 'Start a form from a template',
  description:
    'The new form starts as a draft of the template. The template itself never changes. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.manage',
  idempotent: true,
  params: z.object({ key: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u) }),
  query: noSchema,
  body: z.object({ title: z.string().trim().min(1).max(200).optional() }),
  responses: {
    201: { description: 'The new form and its draft.', schema: formDetailSchema },
    404: { description: 'No such template.' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const template = await tx.formTemplates.find(params.key);
      if (template === undefined) {
        throw notFound('This template does not exist.');
      }
      const title =
        body.title ?? template.title.en ?? Object.values(template.title)[0] ?? template.key;
      return createFormWithDraft(tx, context, {
        title,
        definition: template.definition,
        sourceTemplateKey: template.key,
      });
    });
    return { status: 201, body: detail };
  },
});

export const formRoutes = [
  listFormsRoute,
  createFormRoute,
  getFormRoute,
  updateFormRoute,
  cloneFormRoute,
  saveDraftRoute,
  checkDraftRoute,
  publishDraftRoute,
  testSubmissionRoute,
  listVersionsRoute,
  getVersionRoute,
  listTemplatesRoute,
  getTemplateRoute,
  cloneTemplateRoute,
];
