import { can, formatWorkOrderReference, type Principal } from '@integr8/core';
import {
  type Form,
  type FormVersion,
  type ReportableValueType,
  type Submission,
  type SubmissionQuery,
  type SubmissionStatus,
  type TenantTransaction,
  type ValueFilter,
  type ValueOperator,
  withTenant,
} from '@integr8/db';
import {
  compileDefinition,
  type CompiledForm,
  type FieldError,
  type FormDefinition,
  mediaReferences,
  type SubmissionIssue,
  validateSubmission,
} from '@integr8/form-engine';
import { z } from 'zod';
import {
  conflict,
  type ErrorDetail,
  forbidden,
  internal,
  notFound,
  unprocessable,
} from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { readableWorkOrder, requireWork } from './operations.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Filling, submitting, finding and correcting submissions.
 *
 * The rule that shapes every handler: **the client validates for speed, the
 * server validates for truth.** A submit is revalidated here against the version
 * the submission is bound to, with the same engine the client ran — and anything
 * the client got wrong or made up is refused: an answer to a hidden question, a
 * value for a calculated one, a question the form does not have, a photo that
 * was never uploaded.
 *
 * Who may see what:
 *
 * - A draft is its author's alone. Nobody else lists or opens it.
 * - A submitted or reopened submission is visible to its author, and to anyone
 *   holding `submission.read_all`.
 * - Filling needs `submission.fill` *and* a role the form's own fill roles include.
 * - Reopening needs `submission.amend`. A reopened submission is corrected by
 *   its author or by someone who may amend, and resubmitted with a reason.
 *
 * Anything a caller may not see answers 404, not 403, so ids cannot be probed.
 */

const TAGS = ['submissions'];
const EXPORT_ROW_LIMIT = 50_000;
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

// ---------------------------------------------------------------------------
// Contract shapes
// ---------------------------------------------------------------------------

const statusSchema = z.enum(['draft', 'submitted', 'reopened']);
export const answersSchema = z.record(z.string(), z.unknown());

const personSchema = z.object({ id: z.uuid(), name: z.string() });

const submissionSummarySchema = z.object({
  id: z.uuid(),
  /** The job this form was filled for, if any. */
  workOrder: z
    .object({ id: z.uuid(), reference: z.number().int(), referenceLabel: z.string() })
    .nullable(),
  formId: z.uuid(),
  formTitle: z.string(),
  formVersionId: z.uuid(),
  versionNumber: z.number().int().nullable(),
  status: statusSchema,
  revision: z.number().int(),
  submittedBy: personSchema,
  submittedAt: z.string().nullable(),
  amendedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const submissionSchema = submissionSummarySchema.extend({ answers: answersSchema });

const eventSchema = z.object({
  sequence: z.number().int(),
  kind: z.enum(['submitted', 'reopened', 'amended']),
  answers: answersSchema.nullable(),
  actor: personSchema,
  reason: z.string().nullable(),
  occurredAt: z.string(),
});

const detailSchema = z.object({
  submission: submissionSchema,
  version: z.object({
    id: z.uuid(),
    versionNumber: z.number().int().nullable(),
    definition: z.record(z.string(), z.unknown()),
  }),
  /** Every submit, reopening and amendment, oldest first. Empty for a draft. */
  events: z.array(eventSchema),
  /** What this caller may do next. A convenience for the screen; every action is checked again. */
  can: z.object({ edit: z.boolean(), submit: z.boolean(), reopen: z.boolean() }),
});

const submissionParams = z.object({ submissionId: z.uuid() });

export const dateSchema = z.iso.date();

const listQuery = z.object({
  formId: z.uuid().optional(),
  status: statusSchema.optional(),
  /** Only the caller's own. Always true for a caller without `submission.read_all`. */
  mine: z.enum(['true', 'false']).optional(),
  submittedBy: z.uuid().optional(),
  /** First submitted on or after this day (UTC). */
  from: dateSchema.optional(),
  /** First submitted on or before this day (UTC). */
  to: dateSchema.optional(),
  /** Words anywhere in the written answers. */
  q: z.string().trim().max(200).optional(),
  /** Filled for this job. */
  workOrderId: z.uuid().optional(),
  /** Filled for a job at this site. */
  siteId: z.uuid().optional(),
  /** Filled for a job for this customer. */
  customerId: z.uuid().optional(),
  /**
   * `field:operator:value`, repeatable, all must match. Needs `formId`.
   * Operators: eq, ne, lt, lte, gt, gte, contains (text only).
   */
  filter: z.union([z.string().max(300), z.array(z.string().max(300)).max(10)]).optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

export function mayRead(principal: Principal, submission: Submission): boolean {
  if (submission.submittedBy === principal.userId) {
    return true;
  }
  return submission.status !== 'draft' && can(principal.role, 'submission.read_all');
}

export function mayFill(principal: Principal, form: Form): boolean {
  return can(principal.role, 'submission.fill') && form.fillRoles.includes(principal.role);
}

/** Whether this caller may change the answers now: their own draft, or a reopened submission they may correct. */
export function mayEdit(
  principal: Principal,
  submission: Submission,
  form: Form | undefined,
): boolean {
  if (submission.status === 'draft') {
    return (
      submission.submittedBy === principal.userId && form !== undefined && mayFill(principal, form)
    );
  }
  if (submission.status === 'reopened') {
    return submission.submittedBy === principal.userId || can(principal.role, 'submission.amend');
  }
  return false;
}

export async function readable(
  tx: TenantTransaction,
  principal: Principal,
  submissionId: string,
): Promise<Submission> {
  const submission = await tx.submissions.findById(submissionId);
  if (submission === undefined || !mayRead(principal, submission)) {
    throw notFound('This submission does not exist.');
  }
  return submission;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

interface Lookups {
  people: Map<string, string>;
  workOrders: Map<string, number>;
  forms: Map<string, string>;
  versions: Map<string, number | null>;
}

async function lookups(
  tx: TenantTransaction,
  submissions: readonly Submission[] = [],
): Promise<Lookups> {
  const [members, forms, versions, jobs] = await Promise.all([
    tx.tenantUsers.list({ includeDeleted: true }),
    tx.forms.listForms(),
    tx.forms.listVersionSummaries(),
    tx.workOrders.findMany(
      submissions.flatMap((submission) =>
        submission.workOrderId === null ? [] : [submission.workOrderId],
      ),
    ),
  ]);
  return {
    people: new Map(members.map((member) => [member.userId, member.displayName])),
    workOrders: new Map(jobs.map((job) => [job.id, job.reference])),
    forms: new Map(forms.map((form) => [form.id, form.title])),
    versions: new Map(versions.map((version) => [version.id, version.versionNumber])),
  };
}

const person = (id: string, known: Lookups) => ({ id, name: known.people.get(id) ?? '' });

function summaryBody(submission: Submission, known: Lookups) {
  const reference =
    submission.workOrderId === null ? undefined : known.workOrders.get(submission.workOrderId);
  return {
    id: submission.id,
    workOrder:
      submission.workOrderId === null || reference === undefined
        ? null
        : {
            id: submission.workOrderId,
            reference,
            referenceLabel: formatWorkOrderReference(reference),
          },
    formId: submission.formId,
    formTitle: known.forms.get(submission.formId) ?? '',
    formVersionId: submission.formVersionId,
    versionNumber: known.versions.get(submission.formVersionId) ?? null,
    status: submission.status,
    revision: submission.revision,
    submittedBy: person(submission.submittedBy, known),
    submittedAt: isoOrNull(submission.submittedAt),
    amendedAt: isoOrNull(submission.amendedAt),
    createdAt: iso(submission.createdAt),
    updatedAt: iso(submission.updatedAt),
  };
}

export async function detailBody(
  tx: TenantTransaction,
  principal: Principal,
  submission: Submission,
) {
  const [known, version, form, events] = await Promise.all([
    lookups(tx, [submission]),
    tx.forms.findVersion(submission.formVersionId),
    tx.forms.findForm(submission.formId),
    tx.submissions.listEvents(submission.id),
  ]);
  if (version === undefined) {
    throw internal();
  }
  const editable = mayEdit(principal, submission, form);
  return {
    submission: { ...summaryBody(submission, known), answers: submission.answers },
    version: {
      id: version.id,
      versionNumber: version.versionNumber,
      definition: version.definition,
    },
    events: events.map((event) => ({
      sequence: event.sequence,
      kind: event.kind,
      answers: event.answers,
      actor: person(event.actorId, known),
      reason: event.reason,
      occurredAt: iso(event.occurredAt),
    })),
    can: {
      edit: editable,
      submit: editable,
      reopen: submission.status === 'submitted' && can(principal.role, 'submission.amend'),
    },
  };
}

// ---------------------------------------------------------------------------
// Validation for truth
// ---------------------------------------------------------------------------

/**
 * The date the rules are evaluated on.
 *
 * The client's, because "before today" means the engineer's today, not the
 * server's — but only within a day of the server's, so a client cannot move
 * "today" to make an expired certificate pass.
 */
/**
 * The day the form was filled. Within a day of `reference`: now, or for a form
 * filled offline and synced later (P12), when the phone recorded it — measured
 * on the server's clock, not the phone's.
 */
export function resolveToday(claimed: string | undefined, reference: Date = new Date()): string {
  const serverDay = reference.toISOString().slice(0, 10);
  if (claimed === undefined) {
    return serverDay;
  }
  const difference = Math.abs(
    Date.parse(`${claimed}T12:00:00Z`) - Date.parse(`${serverDay}T12:00:00Z`),
  );
  if (difference > 24 * 60 * 60 * 1000) {
    throw unprocessable('today_out_of_range', 'The date the form was filled is not today.', [
      { field: 'body.today', code: 'today_out_of_range', message: `Server date is ${serverDay}.` },
    ]);
  }
  return claimed;
}

function issueDetail(issue: SubmissionIssue): ErrorDetail {
  const field = issue.field === undefined ? 'body.answers' : `body.answers.${issue.field}`;
  const messages: Record<SubmissionIssue['code'], string> = {
    not_an_object: 'The answers must be an object keyed by question.',
    unknown_field: `This form has no question "${issue.field ?? ''}".`,
    answer_to_hidden_field: `"${issue.field ?? ''}" is hidden by the form's rules and cannot be answered.`,
    answer_to_calculated_field: `"${issue.field ?? ''}" is worked out by the form and cannot be answered.`,
  };
  return { field, code: issue.code, message: messages[issue.code] };
}

function errorDetail(error: FieldError): ErrorDetail {
  const params = Object.entries(error.params)
    .map(([name, value]) => `${name} ${value}`)
    .join(', ');
  return {
    field: `body.answers.${error.field}`,
    code: error.code,
    message: `"${error.field}" failed ${error.code}${params === '' ? '' : ` (${params})`}.`,
    params: { ...error.params },
  };
}

/**
 * Everything the server checks before answers become a submission.
 * Returns the answers to store: the engine's, with calculated values its own.
 */
export async function revalidate(
  tx: TenantTransaction,
  compiled: CompiledForm,
  answers: Record<string, unknown>,
  today: string,
): Promise<Record<string, unknown>> {
  const check = validateSubmission(compiled, answers, { today });
  const details = [...check.issues.map(issueDetail), ...check.errors.map(errorDetail)];

  if (details.length === 0) {
    const references = mediaReferences(compiled.definition, check.answers);
    const stored = new Map(
      (await tx.files.findMany(references.map((reference) => reference.media.mediaId))).map(
        (file) => [file.id, file],
      ),
    );
    for (const { field, media } of references) {
      const found = stored.get(media.mediaId);
      if (found?.deletedAt !== null) {
        details.push({
          field: `body.answers.${field}`,
          code: 'media_not_found',
          message: `"${field}" refers to a file that was not uploaded.`,
        });
      } else if (found.contentType !== media.contentType || found.byteSize !== media.byteSize) {
        details.push({
          field: `body.answers.${field}`,
          code: 'media_mismatch',
          message: `"${field}" describes its file differently from what was uploaded.`,
        });
      }
    }
  }

  if (details.length > 0) {
    throw unprocessable(
      'invalid_submission',
      `These answers cannot be accepted: ${String(details.length)} problem${details.length === 1 ? '' : 's'}.`,
      details,
    );
  }
  return { ...check.answers };
}

export function compiledVersion(version: FormVersion): CompiledForm {
  const compiled = compileDefinition(version.definition);
  // Every published version compiled when it was published.
  if (!compiled.ok) {
    throw internal();
  }
  return compiled.form;
}

export function refusal(outcome: 'not_found' | 'conflict' | 'wrong_status'): never {
  switch (outcome) {
    case 'not_found':
      throw notFound('This submission does not exist.');
    case 'conflict':
      throw conflict(
        'submission_changed',
        'This submission was changed elsewhere since you loaded it. Reload it and try again.',
      );
    case 'wrong_status':
      throw conflict('submission_state', 'This submission cannot be changed in its current state.');
  }
}

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

const OPERATORS: readonly ValueOperator[] = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte', 'contains'];

async function buildQuery(
  tx: TenantTransaction,
  principal: Principal,
  query: z.infer<typeof listQuery>,
): Promise<SubmissionQuery> {
  const own = query.mine === 'true' || !can(principal.role, 'submission.read_all');
  const statuses: SubmissionStatus[] =
    query.status === undefined ? ['submitted', 'reopened'] : [query.status];
  const drafts = statuses.includes('draft');

  let submittedBy = query.submittedBy;
  if (own || drafts) {
    // Drafts are private to their author, whoever asks.
    if (submittedBy !== undefined && submittedBy !== principal.userId) {
      return { formId: '00000000-0000-0000-0000-000000000000', statuses, limit: 1 };
    }
    submittedBy = principal.userId;
  }

  const filters = query.filter === undefined ? [] : [query.filter].flat();
  const values: ValueFilter[] = [];
  if (filters.length > 0) {
    if (query.formId === undefined) {
      throw unprocessable('filter_needs_form', 'Filtering by an answer needs a form.', [
        {
          field: 'query.formId',
          code: 'required',
          message: 'Choose a form to filter by its answers.',
        },
      ]);
    }
    const types = await reportableTypes(tx, query.formId);
    for (const [index, raw] of filters.entries()) {
      const [field = '', operator = '', ...rest] = raw.split(':');
      const type = types.get(field);
      const detail = (code: string, message: string): ErrorDetail => ({
        field: `query.filter.${String(index)}`,
        code,
        message,
      });
      if (type === undefined) {
        throw unprocessable(
          'invalid_filter',
          'A filter names an answer that cannot be filtered on.',
          [detail('unknown_field', `"${field}" is not a reportable question on this form.`)],
        );
      }
      if (
        !OPERATORS.includes(operator as ValueOperator) ||
        (operator === 'contains' && type !== 'text')
      ) {
        throw unprocessable('invalid_filter', 'A filter uses a comparison that does not apply.', [
          detail('invalid_operator', `"${operator}" does not apply to a ${type} answer.`),
        ]);
      }
      const value = rest.join(':');
      if (!valueFits(type, value)) {
        throw unprocessable('invalid_filter', 'A filter compares with a value of the wrong kind.', [
          detail('invalid_value', `"${value}" is not a ${type}.`),
        ]);
      }
      values.push({ field, type, operator: operator as ValueOperator, value });
    }
  }

  return {
    ...(query.formId === undefined ? {} : { formId: query.formId }),
    statuses,
    ...(submittedBy === undefined ? {} : { submittedBy }),
    ...(query.from === undefined ? {} : { submittedFrom: new Date(`${query.from}T00:00:00Z`) }),
    ...(query.to === undefined
      ? {}
      : { submittedBefore: new Date(Date.parse(`${query.to}T00:00:00Z`) + 24 * 60 * 60 * 1000) }),
    ...(query.q === undefined || query.q === '' ? {} : { text: query.q }),
    ...(query.workOrderId === undefined ? {} : { workOrderId: query.workOrderId }),
    ...(query.siteId === undefined ? {} : { siteId: query.siteId }),
    ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
    values,
    order: drafts ? 'updated' : 'submitted',
    ...(query.cursor === undefined ? {} : { after: decodeCursor(query.cursor) }),
    limit: query.limit,
  };
}

/** What each reportable question of a form is, across every published version; the newest wins. */
async function reportableTypes(
  tx: TenantTransaction,
  formId: string,
): Promise<Map<string, ReportableValueType>> {
  const versions = await tx.forms.listVersions(formId);
  const types = new Map<string, ReportableValueType>();
  for (const version of versions) {
    for (const spec of version.reportableFields ?? []) {
      if (!types.has(spec.field)) {
        types.set(spec.field, spec.type);
      }
    }
  }
  return types;
}

function valueFits(type: ReportableValueType, value: string): boolean {
  switch (type) {
    case 'text':
      return value.length > 0;
    case 'number':
      return /^-?\d+(\.\d+)?$/u.test(value);
    case 'date':
      return dateSchema.safeParse(value).success;
    case 'time':
      return /^([01]\d|2[0-3]):[0-5]\d$/u.test(value);
    case 'datetime':
      return z.iso.datetime({ offset: true }).safeParse(value).success;
    case 'boolean':
      return value === 'true' || value === 'false';
  }
}

function encodeCursor(next: { at: Date; id: string } | undefined): string | null {
  return next === undefined
    ? null
    : Buffer.from(JSON.stringify({ at: next.at.toISOString(), id: next.id })).toString('base64url');
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  try {
    const parsed = z
      .object({ at: z.iso.datetime(), id: z.uuid() })
      .parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return { at: new Date(parsed.at), id: parsed.id };
  } catch {
    throw unprocessable(
      'invalid_cursor',
      'This page link is not valid. Start from the first page.',
      [{ field: 'query.cursor', code: 'invalid_cursor', message: 'Not a cursor this API issued.' }],
    );
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const startSubmissionRoute = defineRoute({
  method: 'post',
  path: '/v1/submissions',
  operationId: 'startSubmission',
  summary: 'Start filling a form',
  description:
    'Creates a draft against the form’s latest published version. The draft is saved on the server, so it can be finished on another device. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'submission.fill',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    formId: z.uuid(),
    /** Fill it for this job. The form must be one of the job's, and the job still open. */
    workOrderId: z.uuid().optional(),
  }),
  responses: {
    201: { description: 'The draft, with the version it is bound to.', schema: detailSchema },
    409: {
      description:
        'The job is closed (`work_order_closed`), or the form is not one of its forms (`form_not_on_work_order`).',
    },
    403: { description: 'This person’s role may not fill this form.' },
    404: { description: 'No such form, or nothing published to fill.' },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const form = await tx.forms.findForm(body.formId);
      const version = form === undefined ? undefined : await tx.forms.findLatestPublished(form.id);
      if (form === undefined || version === undefined) {
        throw notFound('This form does not exist, or has no published version to fill.');
      }
      if (!mayFill(principal, form)) {
        throw forbidden('Your role is not one this form may be filled by.');
      }
      if (body.workOrderId !== undefined) {
        const job = await readableWorkOrder(tx, principal, body.workOrderId);
        await requireWork(tx, principal, job);
        if (['complete', 'reviewed', 'cancelled'].includes(job.state)) {
          throw conflict(
            'work_order_closed',
            'This job is closed; reopen it to fill forms for it.',
          );
        }
        if (!(await tx.workOrders.listForms(job.id)).some((entry) => entry.formId === form.id)) {
          throw conflict('form_not_on_work_order', 'This form is not one of the job’s forms.');
        }
      }
      const draft = await tx.submissions.startDraft({
        formVersionId: version.id,
        submittedBy: principal.userId,
        ...(body.workOrderId === undefined ? {} : { workOrderId: body.workOrderId }),
      });
      return detailBody(tx, principal, draft);
    });
    return { status: 201, body: detail };
  },
});

export const listSubmissionsRoute = defineRoute({
  method: 'get',
  path: '/v1/submissions',
  operationId: 'listSubmissions',
  summary: 'Find submissions',
  description:
    'Newest first, a page at a time. Without `status`, lists submitted and reopened submissions; `status=draft` lists the caller’s own drafts. People without `submission.read_all` see only their own.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.read',
  params: noSchema,
  query: listQuery,
  body: noSchema,
  responses: {
    200: {
      description: 'A page of submissions.',
      schema: z.object({
        items: z.array(submissionSummarySchema),
        nextCursor: z.string().nullable(),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const built = await buildQuery(tx, principal, query);
      const page = await tx.submissions.list(built);
      const known = await lookups(tx, page.items);
      return {
        items: page.items.map((submission) => summaryBody(submission, known)),
        nextCursor: encodeCursor(page.next),
      };
    });
    return { status: 200, body };
  },
});

export const exportSubmissionsRoute = defineRoute({
  method: 'get',
  path: '/v1/submissions/export',
  operationId: 'exportSubmissions',
  summary: 'Export submissions of one form as CSV',
  description:
    'The same filters as the list, for one form. One row per submission, one column per question any published version asked, headed by its answer key. Up to 50,000 rows.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.read',
  params: noSchema,
  query: listQuery.omit({ cursor: true, limit: true }).extend({ formId: z.uuid() }),
  body: noSchema,
  responses: {
    200: {
      description: 'UTF-8 CSV with a byte-order mark.',
      schema: z.string(),
      contentType: 'text/csv',
    },
    404: { description: 'No such form.' },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const { csv, title } = await withTenant(principal.tenantId, async (tx) => {
      const form = await tx.forms.findForm(query.formId);
      if (form === undefined) {
        throw notFound('This form does not exist.');
      }
      const built = await buildQuery(tx, principal, { ...query, limit: 200 });
      const [versions, known] = await Promise.all([tx.forms.listVersions(form.id), lookups(tx)]);
      const columns = exportColumns(versions);

      const rows: string[] = [
        [
          'submission_id',
          'status',
          'form_version',
          'submitted_by',
          'submitted_at',
          'amended_at',
          ...columns,
        ]
          .map(csvCell)
          .join(','),
      ];
      let after = built.after;
      let count = 0;
      while (count < EXPORT_ROW_LIMIT) {
        const page = await tx.submissions.list({
          ...built,
          limit: 500,
          ...(after === undefined ? {} : { after }),
        });
        for (const submission of page.items) {
          rows.push(
            [
              submission.id,
              submission.status,
              String(known.versions.get(submission.formVersionId) ?? ''),
              known.people.get(submission.submittedBy) ?? submission.submittedBy,
              isoOrNull(submission.submittedAt) ?? '',
              isoOrNull(submission.amendedAt) ?? '',
              ...columns.map((column) => exportValue(submission.answers[column])),
            ]
              .map(csvCell)
              .join(','),
          );
        }
        count += page.items.length;
        if (page.next === undefined) {
          break;
        }
        after = page.next;
      }
      // A byte-order mark, so a spreadsheet opens Arabic answers as UTF-8.
      return { csv: `${BYTE_ORDER_MARK}${rows.join('\r\n')}\r\n`, title: form.title };
    });

    const filename = `${title.replace(/[^\w.-]+/gu, '-').slice(0, 60) || 'submissions'}.csv`;
    return {
      status: 200,
      body: csv,
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="${filename}"`,
      },
    };
  },
});

/** Every question any published version asked, newest version's order first. */
function exportColumns(versions: readonly FormVersion[]): string[] {
  const seen = new Set<string>();
  const columns: string[] = [];
  for (const version of versions.filter((candidate) => candidate.status === 'published')) {
    const definition = version.definition as unknown as FormDefinition;
    for (const page of definition.pages) {
      for (const section of page.sections) {
        for (const field of section.fields) {
          if (!seen.has(field.id)) {
            seen.add(field.id);
            columns.push(field.id);
          }
        }
      }
    }
  }
  return columns;
}

function exportValue(value: unknown): string | number | boolean {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) =>
        typeof item === 'object' && item !== null && 'mediaId' in item
          ? String((item as { mediaId: unknown }).mediaId)
          : String(item),
      )
      .join('; ');
  }
  if (typeof value === 'object' && 'mediaId' in value) {
    return String(value.mediaId);
  }
  if (typeof value === 'object' && 'latitude' in value && 'longitude' in value) {
    const point = value;
    return `${String(point.latitude)} ${String(point.longitude)}`;
  }
  return JSON.stringify(value);
}

/**
 * One CSV cell.
 *
 * Quoted when it must be. And text that a spreadsheet would run as a formula —
 * starting `=`, `+`, `-`, `@` — is prefixed with an apostrophe, because an
 * engineer's free text is not ours to execute on an office manager's machine.
 * Plain numbers are left alone, including negative ones.
 */
export function csvCell(value: string | number | boolean): string {
  let text = String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/u.test(text) && !/^-?\d+(\.\d+)?$/u.test(text)) {
    text = `'${text}`;
  }
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const getSubmissionRoute = defineRoute({
  method: 'get',
  path: '/v1/submissions/:submissionId',
  operationId: 'getSubmission',
  summary: 'A submission, the version it answers, and its history',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.read',
  params: submissionParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The submission.', schema: detailSchema },
    404: { description: 'No such submission this person may see.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) =>
      detailBody(tx, principal, await readable(tx, principal, params.submissionId)),
    );
    return { status: 200, body };
  },
});

export const saveAnswersRoute = defineRoute({
  method: 'put',
  path: '/v1/submissions/:submissionId/answers',
  operationId: 'saveSubmissionAnswers',
  summary: 'Autosave answers',
  description:
    'Stores the answers as they are, finished or not, on `expectedRevision`. Refused with 409 if the submission changed since, so two devices cannot overwrite each other.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.read',
  params: submissionParams,
  query: noSchema,
  body: z.object({ answers: answersSchema, expectedRevision: z.number().int().min(1) }),
  responses: {
    200: { description: 'The saved revision.', schema: submissionSummarySchema },
    404: { description: 'No such submission this person may change.' },
    409: { description: 'Changed elsewhere, or no longer editable.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const saved = await withTenant(principal.tenantId, async (tx) => {
      const submission = await readable(tx, principal, params.submissionId);
      const form = await tx.forms.findForm(submission.formId);
      if (!mayEdit(principal, submission, form)) {
        throw submission.status === 'submitted'
          ? conflict(
              'submission_state',
              'A submitted form must be reopened before it can be changed.',
            )
          : forbidden('You may not change this submission.');
      }
      const result = await tx.submissions.saveAnswers(
        submission.id,
        body.answers,
        body.expectedRevision,
        principal.userId,
      );
      if (result.outcome !== 'written') {
        refusal(result.outcome);
      }
      return summaryBody(result.submission, await lookups(tx));
    });
    return { status: 200, body: saved };
  },
});

export const submitRoute = defineRoute({
  method: 'post',
  path: '/v1/submissions/:submissionId/submit',
  operationId: 'submitSubmission',
  summary: 'Submit, or submit a correction',
  description:
    'Revalidates the answers against the version the submission is bound to and stores the server’s result. Refused with 422 and field-level details when the answers break the form’s rules, answer a hidden or calculated question, or name a file that was not uploaded. A correction of a reopened submission needs `reason`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'form.read',
  params: submissionParams,
  query: noSchema,
  body: z.object({
    answers: answersSchema,
    expectedRevision: z.number().int().min(1),
    /** Required when correcting a reopened submission. */
    reason: z.string().trim().min(1).max(2000).optional(),
    /** The day the form was filled, `YYYY-MM-DD`, in the filler's calendar. Within a day of the server's. */
    today: dateSchema.optional(),
  }),
  responses: {
    200: { description: 'The submitted submission.', schema: detailSchema },
    404: { description: 'No such submission this person may change.' },
    409: { description: 'Changed elsewhere, or not in a state that can be submitted.' },
    422: { description: 'The answers were refused. Details name each question.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const submission = await readable(tx, principal, params.submissionId);
      const form = await tx.forms.findForm(submission.formId);
      if (!mayEdit(principal, submission, form)) {
        throw submission.status === 'submitted'
          ? conflict('submission_state', 'This form is already submitted.')
          : forbidden('You may not submit this.');
      }
      if (submission.status === 'reopened' && body.reason === undefined) {
        throw unprocessable('reason_required', 'Say why this submission is being corrected.', [
          { field: 'body.reason', code: 'required', message: 'A correction needs a reason.' },
        ]);
      }

      const version = await tx.forms.findVersion(submission.formVersionId);
      if (version === undefined) {
        throw internal();
      }
      const answers = await revalidate(
        tx,
        compiledVersion(version),
        body.answers,
        resolveToday(body.today),
      );

      const amending = submission.status === 'reopened';
      const result = await tx.submissions.submit(
        submission.id,
        answers,
        body.expectedRevision,
        principal.userId,
        amending ? body.reason : undefined,
      );
      if (result.outcome !== 'written') {
        refusal(result.outcome);
      }

      if (amending) {
        await audit(tx, context, 'submission.amended', submission.id, {
          reason: body.reason ?? '',
        });
      }
      return detailBody(tx, principal, result.submission);
    });
    return { status: 200, body: detail };
  },
});

export const reopenRoute = defineRoute({
  method: 'post',
  path: '/v1/submissions/:submissionId/reopen',
  operationId: 'reopenSubmission',
  summary: 'Reopen a submission to correct it',
  description:
    'Needs a reason, which is kept in the submission’s history with who reopened it and when. The answers as submitted are kept too; nothing about the original is lost.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'submission.amend',
  params: submissionParams,
  query: noSchema,
  body: z.object({
    reason: z.string().trim().min(1).max(2000),
    expectedRevision: z.number().int().min(1),
  }),
  responses: {
    200: { description: 'The reopened submission.', schema: detailSchema },
    404: { description: 'No such submission.' },
    409: { description: 'Changed elsewhere, or not submitted.' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const submission = await readable(tx, principal, params.submissionId);
      const result = await tx.submissions.reopen(
        submission.id,
        body.expectedRevision,
        principal.userId,
        body.reason,
      );
      if (result.outcome !== 'written') {
        refusal(result.outcome);
      }
      await audit(tx, context, 'submission.reopened', submission.id, { reason: body.reason });
      return detailBody(tx, principal, result.submission);
    });
    return { status: 200, body: detail };
  },
});

async function audit(
  tx: TenantTransaction,
  context: RequestContext,
  action: string,
  submissionId: string,
  metadata: Record<string, unknown>,
) {
  await tx.auditLog.append({
    actorKind: 'tenant_user',
    actorId: context.principal.userId,
    actorLabel: context.principal.userId,
    action,
    resourceType: 'submission',
    resourceId: submissionId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata,
  });
}

export const submissionRoutes = [
  startSubmissionRoute,
  listSubmissionsRoute,
  exportSubmissionsRoute,
  getSubmissionRoute,
  saveAnswersRoute,
  submitRoute,
  reopenRoute,
];
