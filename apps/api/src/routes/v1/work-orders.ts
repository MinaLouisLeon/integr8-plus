import {
  can,
  type CompletionMissing,
  findTransition,
  formatWorkOrderReference,
  type Principal,
} from '@integr8/core';
import {
  type TenantTransaction,
  type WorkOrder,
  type WorkOrderQuery,
  type WorkOrderWrite,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import {
  accessSchema,
  addressSchema,
  allowedTransitions,
  attachmentBodies,
  attachmentSchema,
  booleanQuery,
  contactBody,
  contactSchema,
  locationSchema,
  many,
  mayWork,
  peopleOf,
  personBody,
  personSchema,
  prioritySchema,
  readableWorkOrder,
  requireWork,
  siteBody,
  workOrderStateSchema,
  workOrderSummaries,
  workOrderSummarySchema,
} from './operations.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Work orders (P10): the job, who is on it, what must be done and filled in, and
 * how it moves from scheduled to reviewed.
 *
 * The state machine and the completion rule are enforced by the database for
 * every client (migration 0010). These routes add who may do what: the office
 * (`work_order.manage`) creates, assigns, reschedules and cancels; the crew
 * (`work_order.progress`, on jobs they are assigned to) travels, arrives, works
 * and completes; owners and admins (`work_order.review`) sign a job off or send
 * it back. An engineer sees only the jobs they are on.
 */

const TAGS = ['work-orders'];

const workOrderParams = z.object({ workOrderId: z.uuid() });

const crewInputSchema = z
  .array(z.object({ userId: z.uuid(), lead: z.boolean().default(false) }))
  .max(20)
  .refine((crew) => crew.filter((member) => member.lead).length <= 1, 'At most one lead')
  .refine(
    (crew) => new Set(crew.map((member) => member.userId)).size === crew.length,
    'Each person once',
  );

const eventSchema = z.object({
  kind: z.enum([
    'created',
    'transitioned',
    'rescheduled',
    'updated',
    'assigned',
    'unassigned',
    'lead_changed',
    'signed_off',
  ]),
  fromState: workOrderStateSchema.nullable(),
  toState: workOrderStateSchema.nullable(),
  person: personSchema.nullable(),
  actor: personSchema,
  reason: z.string().nullable(),
  details: z.record(z.string(), z.unknown()),
  /** When it happened: for a change made offline, when the phone recorded it. */
  occurredAt: z.string(),
  /** When the server learned of it. */
  recordedAt: z.string(),
});

/** What still stands between a job and completing it (P14). */
export const completionSchema = z.object({
  forms: z.array(z.object({ formId: z.uuid(), title: z.string() })),
  beforePhotos: z.number().int(),
  afterPhotos: z.number().int(),
  signoff: z.boolean(),
});

export const signoffSchema = z.object({
  signedAt: z.string(),
  signedBy: personSchema,
  /** The signature, when the customer signed. */
  fileId: z.uuid().nullable(),
  name: z.string().nullable(),
  role: z.string().nullable(),
  /** Why nobody could sign, when nobody did. */
  unavailableReason: z.string().nullable(),
});

export const detailSchema = z.object({
  workOrder: workOrderSummarySchema.extend({
    description: z.string().nullable(),
    instructions: z.string().nullable(),
    lastReason: z.string().nullable(),
    completedAt: z.string().nullable(),
    reviewedAt: z.string().nullable(),
    cancelledAt: z.string().nullable(),
  }),
  /** Where the job is and how to get in. The first thing an engineer is shown. */
  site: z.object({
    id: z.uuid(),
    name: z.string(),
    address: addressSchema.extend({ line1: z.string() }),
    location: locationSchema.nullable(),
    geocodeStatus: z.enum(['pending', 'found', 'not_found', 'failed', 'manual']),
    access: accessSchema,
  }),
  siteContact: contactSchema.nullable(),
  customer: z.object({
    id: z.uuid(),
    name: z.string(),
    accountNumber: z.string().nullable(),
    status: z.enum(['active', 'on_hold', 'closed']),
    phone: z.string().nullable(),
  }),
  jobType: z.object({
    id: z.uuid(),
    name: z.string(),
    code: z.string(),
    expectedDurationMinutes: z.number().int().nullable(),
  }),
  crew: z.array(personSchema.extend({ lead: z.boolean(), assignedAt: z.string() })),
  forms: z.array(
    z.object({
      formId: z.uuid(),
      title: z.string(),
      required: z.boolean(),
      submission: z
        .object({
          id: z.uuid(),
          status: z.enum(['draft', 'submitted', 'reopened']),
          submittedAt: z.string().nullable(),
        })
        .nullable(),
    }),
  ),
  checklist: z.array(
    z.object({
      id: z.uuid(),
      label: z.string(),
      done: z.boolean(),
      doneBy: personSchema.nullable(),
      doneAt: z.string().nullable(),
    }),
  ),
  comments: z.array(
    z.object({
      id: z.uuid(),
      author: personSchema,
      visibility: z.enum(['internal', 'customer']),
      body: z.string(),
      createdAt: z.string(),
    }),
  ),
  events: z.array(eventSchema),
  attachments: z.array(attachmentSchema),
  /** Running the job (P14): photos and sign-off it needs, and what is still missing. */
  execution: z.object({
    beforePhotos: z.number().int(),
    afterPhotos: z.number().int(),
    signatureRequired: z.boolean(),
    signoff: signoffSchema.nullable(),
    missing: completionSchema,
  }),
  /** Earlier jobs at the same site that this person may see: the previous reports. */
  previousAtSite: z.array(workOrderSummarySchema),
  can: z.object({
    edit: z.boolean(),
    assign: z.boolean(),
    work: z.boolean(),
    comment: z.boolean(),
    transitions: z.array(z.object({ to: workOrderStateSchema, requiresReason: z.boolean() })),
  }),
});

export async function detailBody(tx: TenantTransaction, principal: Principal, job: WorkOrder) {
  const readAll = can(principal.role, 'work_order.read_all');
  const [
    site,
    customer,
    jobType,
    crew,
    forms,
    checklist,
    comments,
    events,
    attachments,
    previous,
    people,
  ] = await Promise.all([
    tx.sites.find(job.siteId),
    tx.customers.find(job.customerId),
    tx.jobTypes.find(job.jobTypeId),
    tx.workOrders.listCrew(job.id),
    tx.workOrders.listForms(job.id),
    tx.workOrders.listChecklist(job.id),
    tx.workOrders.listComments(job.id),
    tx.workOrders.listEvents(job.id),
    tx.attachments.list({ workOrderId: job.id }),
    tx.workOrders.listPreviousAtSite(job.siteId, job.id),
    peopleOf(tx),
  ]);
  const missing = await tx.workOrders.completionMissing(job);
  const contacts = site?.contactId == null ? [] : await tx.customers.findContacts([site.contactId]);
  const visiblePrevious = readAll
    ? previous
    : (
        await Promise.all(
          previous.map(async (earlier) =>
            (await tx.workOrders.isAssigned(earlier.id, principal.userId)) ? earlier : undefined,
          ),
        )
      ).filter((earlier): earlier is WorkOrder => earlier !== undefined);
  const [summary] = await workOrderSummaries(tx, [job], people);
  const shapedSite = siteBody(site!, people);
  const working = await mayWork(tx, principal, job);

  return {
    workOrder: {
      ...summary!,
      description: job.description,
      instructions: job.instructions,
      lastReason: job.lastReason,
      completedAt: isoOrNull(job.completedAt),
      reviewedAt: isoOrNull(job.reviewedAt),
      cancelledAt: isoOrNull(job.cancelledAt),
    },
    site: {
      id: shapedSite.id,
      name: shapedSite.name,
      address: shapedSite.address,
      location: shapedSite.location,
      geocodeStatus: shapedSite.geocodeStatus,
      access: shapedSite.access,
    },
    siteContact: contacts[0] === undefined ? null : contactBody(contacts[0]),
    customer: {
      id: customer!.id,
      name: customer!.name,
      accountNumber: customer!.accountNumber,
      status: customer!.status,
      phone: customer!.phone,
    },
    jobType: {
      id: jobType!.id,
      name: jobType!.name,
      code: jobType!.code,
      expectedDurationMinutes: jobType!.expectedDurationMinutes,
    },
    crew: crew.map((member) => ({
      ...personBody(member.userId, people),
      lead: member.lead,
      assignedAt: iso(member.assignedAt),
    })),
    forms: forms.map((form) => ({
      formId: form.formId,
      title: form.title,
      required: form.required,
      submission:
        form.submission === null
          ? null
          : { ...form.submission, submittedAt: isoOrNull(form.submission.submittedAt) },
    })),
    checklist: checklist.map((item) => ({
      id: item.id,
      label: item.label,
      done: item.done,
      doneBy: item.doneBy === null ? null : personBody(item.doneBy, people),
      doneAt: isoOrNull(item.doneAt),
    })),
    comments: comments.map((comment) => ({
      id: comment.id,
      author: personBody(comment.authorId, people),
      visibility: comment.visibility,
      body: comment.body,
      createdAt: iso(comment.createdAt),
    })),
    events: events.map((event) => ({
      kind: event.kind,
      fromState: event.fromState,
      toState: event.toState,
      person: event.userId === null ? null : personBody(event.userId, people),
      actor: personBody(event.actorId, people),
      reason: event.reason,
      details: event.details,
      occurredAt: iso(event.occurredAt),
      recordedAt: iso(event.recordedAt),
    })),
    attachments: await attachmentBodies(tx, attachments, people),
    execution: {
      beforePhotos: job.beforePhotos,
      afterPhotos: job.afterPhotos,
      signatureRequired: job.signatureRequired,
      signoff:
        job.signoff === null
          ? null
          : {
              signedAt: iso(job.signoff.signedAt),
              signedBy: personBody(job.signoff.signedBy, people),
              fileId: job.signoff.fileId,
              name: job.signoff.name,
              role: job.signoff.role,
              unavailableReason: job.signoff.unavailableReason,
            },
      missing,
    },
    previousAtSite: await workOrderSummaries(tx, visiblePrevious, people),
    can: {
      edit:
        can(principal.role, 'work_order.manage') &&
        !['complete', 'reviewed', 'cancelled'].includes(job.state),
      assign: can(principal.role, 'work_order.manage'),
      work: working,
      comment: working,
      transitions: await allowedTransitions(tx, principal, job),
    },
  };
}

/** A repository refusal, as the API says it. */
export function refusal(
  result: Exclude<WorkOrderWrite, { outcome: 'written' }>,
  to?: string,
): never {
  switch (result.outcome) {
    case 'not_found':
      throw notFound('This work order does not exist.');
    case 'conflict':
      throw conflict(
        'work_order_changed',
        'This work order was changed elsewhere since you loaded it. Reload it and try again.',
      );
    case 'closed':
      throw conflict(
        'work_order_closed',
        `This work order is ${result.current.state.replace('_', ' ')}; reopen it before changing it.`,
      );
    case 'reason_required':
      throw unprocessable('reason_required', 'Say why.', [
        { field: 'body.reason', code: 'required', message: 'This change needs a reason.' },
      ]);
    case 'nobody_assigned':
      throw conflict('nobody_assigned', 'Assign someone before dispatching this job.');
    case 'incomplete':
      throw new ApiError(
        409,
        'completion_blocked',
        completionBlockedMessage(result.missing),
        completionDetails(result.missing),
      );
    case 'not_allowed':
      throw conflict(
        'transition_not_allowed',
        `A job that is ${result.current.state.replace('_', ' ')} cannot move to ${(to ?? 'that state').replace('_', ' ')}.`,
      );
  }
}

/** What stands in the way of completing, said the way a person would. */
export function completionBlockedMessage(missing: CompletionMissing): string {
  const parts = [
    ...missing.forms.map((form) => `submit ${form.title}`),
    ...(missing.beforePhotos > 0
      ? [
          `take ${String(missing.beforePhotos)} more before photo${missing.beforePhotos === 1 ? '' : 's'}`,
        ]
      : []),
    ...(missing.afterPhotos > 0
      ? [
          `take ${String(missing.afterPhotos)} more after photo${missing.afterPhotos === 1 ? '' : 's'}`,
        ]
      : []),
    ...(missing.signoff ? ["get the customer's sign-off"] : []),
  ];
  const sentence = parts.join(', ');
  return `Before completing this job, ${sentence}.`;
}

export function completionDetails(missing: CompletionMissing) {
  return [
    ...missing.forms.map((form, index) => ({
      field: `forms.${String(index)}`,
      code: 'required_form_missing',
      message: form.title,
      params: { formId: form.formId },
    })),
    ...(missing.beforePhotos > 0
      ? [
          {
            field: 'photos.before',
            code: 'photos_missing',
            message: `${String(missing.beforePhotos)} before photo(s) still needed`,
            params: { needed: String(missing.beforePhotos) },
          },
        ]
      : []),
    ...(missing.afterPhotos > 0
      ? [
          {
            field: 'photos.after',
            code: 'photos_missing',
            message: `${String(missing.afterPhotos)} after photo(s) still needed`,
            params: { needed: String(missing.afterPhotos) },
          },
        ]
      : []),
    ...(missing.signoff
      ? [{ field: 'signoff', code: 'signoff_missing', message: 'The customer has not signed off' }]
      : []),
  ];
}

export async function audit(
  tx: TenantTransaction,
  context: RequestContext,
  action: string,
  workOrderId: string,
  metadata: Record<string, unknown>,
) {
  await tx.auditLog.append({
    actorKind: 'tenant_user',
    actorId: context.principal.userId,
    actorLabel: context.principal.userId,
    action,
    resourceType: 'work_order',
    resourceId: workOrderId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata,
  });
}

/** Everyone on a crew must be an active member of the company. */
async function requireCrew(tx: TenantTransaction, crew: readonly { userId: string }[]) {
  if (crew.length === 0) {
    return;
  }
  const members = new Map<string, { status: string }>(
    (await tx.tenantUsers.list()).map((member) => [member.userId, member]),
  );
  const index = crew.findIndex((member) => members.get(member.userId)?.status !== 'active');
  if (index >= 0) {
    throw unprocessable(
      'crew_member_unknown',
      'Someone on the crew is not an active member of the company.',
      [
        {
          field: `body.crew.${String(index)}.userId`,
          code: 'crew_member_unknown',
          message: 'Choose an active member of the company.',
        },
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Listing
// ---------------------------------------------------------------------------

const listQuery = z.object({
  state: many(workOrderStateSchema, 9),
  priority: many(prioritySchema, 4),
  jobTypeId: many(z.uuid(), 50),
  customerId: z.uuid().optional(),
  siteId: z.uuid().optional(),
  /** A person's id, or `me`. */
  assigneeId: z.union([z.uuid(), z.literal('me')]).optional(),
  unassigned: booleanQuery,
  /** Due on or after this instant. */
  dueFrom: z.iso.datetime({ offset: true }).optional(),
  /** Due before this instant. */
  dueBefore: z.iso.datetime({ offset: true }).optional(),
  overdue: booleanQuery,
  /** Closed (complete, reviewed or cancelled) at or after this instant. */
  closedSince: z.iso.datetime({ offset: true }).optional(),
  q: z.string().trim().max(200).optional(),
  order: z.enum(['due', 'created', 'reference']).default('due'),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

type ListQuery = z.infer<typeof listQuery>;

function buildQuery(principal: Principal, query: ListQuery): WorkOrderQuery {
  const readAll = can(principal.role, 'work_order.read_all');
  const asked = query.assigneeId === 'me' ? principal.userId : query.assigneeId;
  // Without read_all, a list is always of one's own jobs, whatever is asked.
  const assigneeId = readAll ? asked : principal.userId;
  return {
    states: query.state,
    priorities: query.priority,
    jobTypeIds: query.jobTypeId,
    ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
    ...(query.siteId === undefined ? {} : { siteId: query.siteId }),
    ...(assigneeId === undefined ? {} : { assigneeId }),
    ...(readAll && query.unassigned === 'true' ? { unassigned: true } : {}),
    ...(query.dueFrom === undefined ? {} : { dueFrom: new Date(query.dueFrom) }),
    ...(query.dueBefore === undefined ? {} : { dueBefore: new Date(query.dueBefore) }),
    ...(query.overdue === 'true' ? { overdue: true } : {}),
    ...(query.closedSince === undefined ? {} : { closedSince: new Date(query.closedSince) }),
    ...(query.q === undefined || query.q === '' ? {} : { text: query.q }),
    order: query.order,
    ...(query.cursor === undefined ? {} : { after: query.cursor }),
    limit: query.limit,
  };
}

export const listWorkOrdersRoute = defineRoute({
  method: 'get',
  path: '/v1/work-orders',
  operationId: 'listWorkOrders',
  summary: 'Find work orders',
  description:
    'Filters combine. `counts` gives the number of jobs in each state for the same filters without `state`, for tabs. People without `work_order.read_all` see only jobs they are assigned to.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: noSchema,
  query: listQuery,
  body: noSchema,
  responses: {
    200: {
      description: 'A page of work orders.',
      schema: z.object({
        items: z.array(workOrderSummarySchema),
        nextCursor: z.string().nullable(),
        counts: z.record(workOrderStateSchema, z.number().int()),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const { principal } = context;
    const built = buildQuery(principal, query);
    const body = await withTenant(principal.tenantId, async (tx) => {
      const [page, counts] = await Promise.all([
        tx.workOrders.list(built),
        tx.workOrders.countByState({
          ...(built.customerId === undefined ? {} : { customerId: built.customerId }),
          ...(built.siteId === undefined ? {} : { siteId: built.siteId }),
          ...(built.assigneeId === undefined ? {} : { assigneeId: built.assigneeId }),
        }),
      ]);
      return {
        items: await workOrderSummaries(tx, page.items),
        nextCursor: page.next ?? null,
        counts: Object.fromEntries(
          workOrderStateSchema.options.map((state) => [state, counts[state] ?? 0]),
        ),
      };
    });
    return { status: 200, body };
  },
});

// ---------------------------------------------------------------------------
// One job
// ---------------------------------------------------------------------------

const workOrderInputSchema = z.object({
  customerId: z.uuid(),
  siteId: z.uuid(),
  jobTypeId: z.uuid(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(10_000).nullable().optional(),
  instructions: z.string().trim().max(10_000).nullable().optional(),
  priority: prioritySchema.optional(),
  dueFrom: z.iso.datetime({ offset: true }).nullable().optional(),
  dueBy: z.iso.datetime({ offset: true }).nullable().optional(),
  crew: crewInputSchema.optional(),
  /** Needed to create work for a customer on hold. */
  acknowledgeOnHold: z.boolean().optional(),
});

function dueWindow(dueFrom: string | null | undefined, dueBy: string | null | undefined) {
  const from = dueFrom === undefined ? undefined : dueFrom === null ? null : new Date(dueFrom);
  const by = dueBy === undefined ? undefined : dueBy === null ? null : new Date(dueBy);
  if (from instanceof Date && by instanceof Date && by < from) {
    throw unprocessable(
      'due_window_invalid',
      'The job is due to finish before it is due to start.',
      [{ field: 'body.dueBy', code: 'before_due_from', message: 'Due by must be after due from.' }],
    );
  }
  return { from, by };
}

export const createWorkOrderRoute = defineRoute({
  method: 'post',
  path: '/v1/work-orders',
  operationId: 'createWorkOrder',
  summary: 'Create a work order',
  description:
    'Starts scheduled. The job type’s forms, checklist, instructions and default priority are copied onto it. A closed customer takes no new work; one on hold needs `acknowledgeOnHold`. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.manage',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: workOrderInputSchema,
  responses: {
    201: { description: 'The work order.', schema: detailSchema },
    409: {
      description: 'The customer is closed or on hold (`customer_closed`, `customer_on_hold`).',
    },
    422: {
      description:
        'Invalid: the site is not the customer’s, the job type is archived, someone on the crew is not a member.',
    },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const window = dueWindow(body.dueFrom, body.dueBy);
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const [customer, site, jobType] = await Promise.all([
        tx.customers.find(body.customerId),
        tx.sites.find(body.siteId),
        tx.jobTypes.find(body.jobTypeId),
      ]);
      if (customer === undefined) {
        throw unprocessable('customer_unknown', 'This customer does not exist.', [
          { field: 'body.customerId', code: 'not_found', message: 'Choose a customer.' },
        ]);
      }
      if (customer.status === 'closed') {
        throw conflict('customer_closed', `${customer.name} is closed and takes no new work.`);
      }
      if (customer.status === 'on_hold' && body.acknowledgeOnHold !== true) {
        throw conflict(
          'customer_on_hold',
          `${customer.name} is on hold. Check with accounts before creating work.`,
        );
      }
      if (site?.customerId !== customer.id || site.archivedAt !== null) {
        throw unprocessable(
          'site_not_customers',
          'The site must be one of the customer’s current sites.',
          [
            {
              field: 'body.siteId',
              code: 'site_not_customers',
              message: 'Choose one of the customer’s sites.',
            },
          ],
        );
      }
      if (jobType?.archivedAt !== null) {
        throw unprocessable('job_type_unknown', 'This job type does not exist or is archived.', [
          {
            field: 'body.jobTypeId',
            code: 'job_type_unknown',
            message: 'Choose a current job type.',
          },
        ]);
      }
      await requireCrew(tx, body.crew ?? []);
      const job = await tx.workOrders.create(
        {
          customerId: customer.id,
          siteId: site.id,
          jobTypeId: jobType.id,
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
          ...(body.priority === undefined ? {} : { priority: body.priority }),
          ...(window.from === undefined ? {} : { dueFrom: window.from }),
          ...(window.by === undefined ? {} : { dueBy: window.by }),
          ...(body.crew === undefined ? {} : { crew: body.crew }),
        },
        principal.userId,
      );
      await audit(tx, context, 'work_order.created', job.id, {
        reference: formatWorkOrderReference(job.reference),
      });
      return detailBody(tx, principal, (await tx.workOrders.find(job.id))!);
    });
    return { status: 201, body: detail };
  },
});

export const getWorkOrderRoute = defineRoute({
  method: 'get',
  path: '/v1/work-orders/:workOrderId',
  operationId: 'getWorkOrder',
  summary: 'A work order, with its site access notes first',
  description: 'Everything a job screen shows, and what this person may do next.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: workOrderParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The work order.', schema: detailSchema },
    404: { description: 'No such work order this person may see.' },
  },
  handler: async ({ params }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) =>
      detailBody(
        tx,
        context.principal,
        await readableWorkOrder(tx, context.principal, params.workOrderId),
      ),
    );
    return { status: 200, body };
  },
});

export const updateWorkOrderRoute = defineRoute({
  method: 'patch',
  path: '/v1/work-orders/:workOrderId',
  operationId: 'updateWorkOrder',
  summary: 'Change a work order',
  description:
    'Refused for a completed, reviewed or cancelled job. A change to the due window is recorded as a reschedule, with the reason if one is given.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.manage',
  params: workOrderParams,
  query: noSchema,
  body: z
    .object({
      expectedRevision: z.number().int().min(1),
      siteId: z.uuid().optional(),
      title: z.string().trim().min(1).max(200).optional(),
      description: z.string().trim().max(10_000).nullable().optional(),
      instructions: z.string().trim().max(10_000).nullable().optional(),
      priority: prioritySchema.optional(),
      dueFrom: z.iso.datetime({ offset: true }).nullable().optional(),
      dueBy: z.iso.datetime({ offset: true }).nullable().optional(),
      reason: z.string().trim().max(2000).optional(),
    })
    .refine((value) => Object.keys(value).length > 1, 'Change at least one thing'),
  responses: {
    200: { description: 'The work order.', schema: detailSchema },
    404: { description: 'No such work order.' },
    409: {
      description: 'Changed elsewhere (`work_order_changed`), or closed (`work_order_closed`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, principal, params.workOrderId);
      const window = dueWindow(
        body.dueFrom === undefined ? isoOrNull(job.dueFrom) : body.dueFrom,
        body.dueBy === undefined ? isoOrNull(job.dueBy) : body.dueBy,
      );
      if (body.siteId !== undefined) {
        const site = await tx.sites.find(body.siteId);
        if (site?.customerId !== job.customerId || site.archivedAt !== null) {
          throw unprocessable(
            'site_not_customers',
            'The site must be one of the customer’s current sites.',
            [
              {
                field: 'body.siteId',
                code: 'site_not_customers',
                message: 'Choose one of the customer’s sites.',
              },
            ],
          );
        }
      }
      const result = await tx.workOrders.update(
        job.id,
        body.expectedRevision,
        {
          ...(body.siteId === undefined ? {} : { siteId: body.siteId }),
          ...(body.title === undefined ? {} : { title: body.title }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.instructions === undefined ? {} : { instructions: body.instructions }),
          ...(body.priority === undefined ? {} : { priority: body.priority }),
          ...(body.dueFrom === undefined ? {} : { dueFrom: window.from ?? null }),
          ...(body.dueBy === undefined ? {} : { dueBy: window.by ?? null }),
        },
        principal.userId,
        body.reason,
      );
      if (result.outcome !== 'written') {
        refusal(result);
      }
      return detailBody(tx, principal, result.workOrder);
    });
    return { status: 200, body: detail };
  },
});

export const transitionWorkOrderRoute = defineRoute({
  method: 'post',
  path: '/v1/work-orders/:workOrderId/transitions',
  operationId: 'transitionWorkOrder',
  summary: 'Move a work order to another state',
  description:
    'Only along the transitions the state machine allows, by someone allowed to make that transition. Cancelling, reopening a completed job and reinstating a cancelled one need a `reason`. Dispatching needs someone assigned; completing needs every required form submitted, the before and after photos the job asks for, and the customer\u2019s sign-off when it is required.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: workOrderParams,
  query: noSchema,
  body: z.object({
    to: workOrderStateSchema,
    expectedRevision: z.number().int().min(1),
    reason: z.string().trim().max(2000).optional(),
  }),
  responses: {
    200: { description: 'The work order in its new state.', schema: detailSchema },
    403: { description: 'This person may not make this transition.' },
    404: { description: 'No such work order this person may see.' },
    409: {
      description:
        'Not a transition from the current state (`transition_not_allowed`), nobody assigned (`nobody_assigned`), something needed before completing is missing (`completion_blocked`, with a detail for each required form, the before and after photos still needed, and the sign-off), or changed elsewhere (`work_order_changed`).',
    },
    422: { description: 'A reason is required (`reason_required`).' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, principal, params.workOrderId);
      const transition = findTransition(job.state, body.to);
      if (transition !== undefined) {
        const allowed =
          transition.permission === 'work_order.progress'
            ? await mayWork(tx, principal, job)
            : can(principal.role, transition.permission);
        if (!allowed) {
          throw forbidden(
            transition.permission === 'work_order.review'
              ? 'Only an owner or admin can sign off or reopen a completed job.'
              : transition.permission === 'work_order.manage'
                ? 'Only the office can make this change.'
                : 'Only the crew on this job, or the office, can make this change.',
          );
        }
      }
      const result = await tx.workOrders.transition(
        job.id,
        body.expectedRevision,
        body.to,
        principal.userId,
        body.reason,
      );
      if (result.outcome !== 'written') {
        refusal(result, body.to);
      }
      await audit(tx, context, 'work_order.transitioned', job.id, {
        from: job.state,
        to: body.to,
        ...(body.reason === undefined ? {} : { reason: body.reason }),
      });
      return detailBody(tx, principal, result.workOrder);
    });
    return { status: 200, body: detail };
  },
});

export const setCrewRoute = defineRoute({
  method: 'put',
  path: '/v1/work-orders/:workOrderId/crew',
  operationId: 'setWorkOrderCrew',
  summary: 'Assign the crew',
  description:
    'Makes the crew exactly this list. At most one lead; a crew of one with no lead named makes that person lead. Taking everyone off a dispatched job is allowed, and the job cannot move on until someone is assigned.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.manage',
  params: workOrderParams,
  query: noSchema,
  body: z.object({ crew: crewInputSchema }),
  responses: {
    200: { description: 'The work order.', schema: detailSchema },
    404: { description: 'No such work order.' },
    409: { description: 'The job is closed (`work_order_closed`).' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, principal, params.workOrderId);
      if (['complete', 'reviewed', 'cancelled'].includes(job.state)) {
        throw conflict('work_order_closed', 'This job is closed; its crew cannot change.');
      }
      await requireCrew(tx, body.crew);
      await tx.workOrders.setCrew(job.id, body.crew, principal.userId);
      return detailBody(tx, principal, job);
    });
    return { status: 200, body: detail };
  },
});

// ---------------------------------------------------------------------------
// Checklist, forms, comments
// ---------------------------------------------------------------------------

export const addChecklistItemRoute = defineRoute({
  method: 'post',
  path: '/v1/work-orders/:workOrderId/checklist',
  operationId: 'addWorkOrderChecklistItem',
  summary: 'Add a checklist item to one job',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.manage',
  params: workOrderParams,
  query: noSchema,
  body: z.object({ label: z.string().trim().min(1).max(300) }),
  responses: {
    200: { description: 'The work order.', schema: detailSchema },
    404: { description: 'No such work order.' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, context.principal, params.workOrderId);
      await tx.workOrders.addChecklistItem(job.id, body.label);
      return detailBody(tx, context.principal, job);
    });
    return { status: 200, body: detail };
  },
});

export const setChecklistItemRoute = defineRoute({
  method: 'patch',
  path: '/v1/work-orders/:workOrderId/checklist/:itemId',
  operationId: 'setWorkOrderChecklistItem',
  summary: 'Tick or untick a checklist item',
  description: 'By the crew or the office. Records who ticked it and when.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.progress',
  params: z.object({ workOrderId: z.uuid(), itemId: z.uuid() }),
  query: noSchema,
  body: z.object({ done: z.boolean() }),
  responses: {
    200: { description: 'The work order.', schema: detailSchema },
    403: { description: 'Not on this job’s crew.' },
    404: { description: 'No such work order or item.' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, context.principal, params.workOrderId);
      await requireWork(tx, context.principal, job);
      const item = await tx.workOrders.setChecklistItem(
        job.id,
        params.itemId,
        body.done,
        context.principal.userId,
      );
      if (item === undefined) {
        throw notFound('This checklist item does not exist.');
      }
      return detailBody(tx, context.principal, job);
    });
    return { status: 200, body: detail };
  },
});

export const addWorkOrderFormRoute = defineRoute({
  method: 'post',
  path: '/v1/work-orders/:workOrderId/forms',
  operationId: 'addWorkOrderForm',
  summary: 'Add a form to one job, or change whether it is required',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.manage',
  params: workOrderParams,
  query: noSchema,
  body: z.object({ formId: z.uuid(), required: z.boolean() }),
  responses: {
    200: { description: 'The work order.', schema: detailSchema },
    404: { description: 'No such work order.' },
    422: { description: 'No such form, or nothing published to fill.' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, context.principal, params.workOrderId);
      if (['complete', 'reviewed', 'cancelled'].includes(job.state)) {
        throw conflict('work_order_closed', 'This job is closed; its forms cannot change.');
      }
      const form = await tx.forms.findForm(body.formId);
      if (form === undefined || (await tx.forms.findLatestPublished(form.id)) === undefined) {
        throw unprocessable('form_unknown', 'This form does not exist or has nothing published.', [
          { field: 'body.formId', code: 'form_unknown', message: 'Choose a published form.' },
        ]);
      }
      await tx.workOrders.addForm(job.id, form.id, body.required, context.principal.userId);
      return detailBody(tx, context.principal, job);
    });
    return { status: 200, body: detail };
  },
});

export const removeWorkOrderFormRoute = defineRoute({
  method: 'delete',
  path: '/v1/work-orders/:workOrderId/forms/:formId',
  operationId: 'removeWorkOrderForm',
  summary: 'Take a form off one job',
  description: 'Refused once anyone has started filling it for this job.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.manage',
  params: z.object({ workOrderId: z.uuid(), formId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The work order.', schema: detailSchema },
    404: { description: 'No such work order.' },
    409: {
      description:
        'Someone has started this form for the job (`form_started`), or the job is closed.',
    },
  },
  handler: async ({ params }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, context.principal, params.workOrderId);
      if (['complete', 'reviewed', 'cancelled'].includes(job.state)) {
        throw conflict('work_order_closed', 'This job is closed; its forms cannot change.');
      }
      if (!(await tx.workOrders.removeForm(job.id, params.formId))) {
        throw conflict(
          'form_started',
          'Someone has started this form for this job, so it stays on it.',
        );
      }
      return detailBody(tx, context.principal, job);
    });
    return { status: 200, body: detail };
  },
});

export const signOffWorkOrderRoute = defineRoute({
  method: 'put',
  path: '/v1/work-orders/:workOrderId/signoff',
  operationId: 'signOffWorkOrder',
  summary: 'Record the customer\u2019s sign-off on a job',
  description:
    'A signature (an uploaded, confirmed image) with the signer\u2019s name and role, or why nobody could sign. Replaces an earlier one until the job is completed; kept in the job\u2019s history. Phones send this through `/v1/sync/push` instead.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.progress',
  params: workOrderParams,
  query: noSchema,
  body: z.union([
    z.object({
      fileId: z.uuid(),
      name: z.string().trim().min(1).max(200),
      role: z.string().trim().max(100).nullable().optional(),
    }),
    z.object({ unavailableReason: z.string().trim().min(1).max(2000) }),
  ]),
  responses: {
    200: { description: 'The work order.', schema: detailSchema },
    403: { description: 'Not on this job\u2019s crew.' },
    404: { description: 'No such work order, or no such signature file.' },
    409: { description: 'The job is closed (`work_order_closed`).' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, context.principal, params.workOrderId);
      await requireWork(tx, context.principal, job);
      if ('fileId' in body) {
        const file = await tx.files.find(body.fileId);
        if (file?.deletedAt !== null || !file.contentType.startsWith('image/')) {
          throw notFound('This signature file does not exist.');
        }
      }
      const result = await tx.workOrders.signOff(
        job.id,
        'fileId' in body
          ? { fileId: body.fileId, name: body.name, role: body.role ?? null, signedAt: new Date() }
          : { unavailableReason: body.unavailableReason, signedAt: new Date() },
        context.principal.userId,
      );
      if (result.outcome === 'not_found') {
        throw notFound('This work order does not exist.');
      }
      if (result.outcome === 'closed') {
        refusal({ outcome: 'closed', current: job });
      }
      await audit(tx, context, 'work_order.signed_off', job.id, {
        signed: 'fileId' in body,
      });
      return detailBody(tx, context.principal, result.workOrder);
    });
    return { status: 200, body: detail };
  },
});

export const addCommentRoute = defineRoute({
  method: 'post',
  path: '/v1/work-orders/:workOrderId/comments',
  operationId: 'addWorkOrderComment',
  summary: 'Comment on a job',
  description:
    '`internal` notes are for the company; `customer` notes may be shown to the customer in reports and notifications (P29). Comments are not edited or deleted.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.progress',
  idempotent: true,
  params: workOrderParams,
  query: noSchema,
  body: z.object({
    body: z.string().trim().min(1).max(10_000),
    visibility: z.enum(['internal', 'customer']),
  }),
  responses: {
    200: { description: 'The work order.', schema: detailSchema },
    403: { description: 'Not on this job’s crew.' },
    404: { description: 'No such work order.' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, context.principal, params.workOrderId);
      await requireWork(tx, context.principal, job);
      await tx.workOrders.addComment(job.id, body, context.principal.userId);
      return detailBody(tx, context.principal, job);
    });
    return { status: 200, body: detail };
  },
});

// ---------------------------------------------------------------------------
// Bulk
// ---------------------------------------------------------------------------

export const bulkWorkOrdersRoute = defineRoute({
  method: 'post',
  path: '/v1/work-orders/bulk',
  operationId: 'bulkWorkOrders',
  summary: 'Reassign, reschedule or cancel many work orders',
  description:
    'Each job is changed on its own, so one that cannot be changed — closed, or changed since — is reported and the rest go ahead. `reschedule` sets the window, or shifts it by `shiftMinutes`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.manage',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.discriminatedUnion('action', [
    z.object({
      action: z.literal('reassign'),
      workOrderIds: z.array(z.uuid()).min(1).max(200),
      crew: crewInputSchema,
    }),
    z.object({
      action: z.literal('reschedule'),
      workOrderIds: z.array(z.uuid()).min(1).max(200),
      dueFrom: z.iso.datetime({ offset: true }).nullable().optional(),
      dueBy: z.iso.datetime({ offset: true }).nullable().optional(),
      shiftMinutes: z.number().int().min(-525_600).max(525_600).optional(),
      reason: z.string().trim().max(2000).optional(),
    }),
    z.object({
      action: z.literal('cancel'),
      workOrderIds: z.array(z.uuid()).min(1).max(200),
      reason: z.string().trim().min(1).max(2000),
    }),
  ]),
  responses: {
    200: {
      description: 'What happened to each job, in the order given.',
      schema: z.object({
        results: z.array(
          z.object({
            workOrderId: z.uuid(),
            outcome: z.enum(['changed', 'refused']),
            code: z.string().nullable(),
            message: z.string().nullable(),
          }),
        ),
      }),
    },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    if (body.action === 'reassign') {
      await withTenant(principal.tenantId, (tx) => requireCrew(tx, body.crew));
    }
    const results = [];
    for (const workOrderId of [...new Set(body.workOrderIds)]) {
      try {
        await withTenant(principal.tenantId, async (tx) => {
          const job = await readableWorkOrder(tx, principal, workOrderId);
          if (body.action === 'reassign') {
            if (['complete', 'reviewed', 'cancelled'].includes(job.state)) {
              throw conflict('work_order_closed', 'This job is closed; its crew cannot change.');
            }
            await tx.workOrders.setCrew(job.id, body.crew, principal.userId);
            return;
          }
          if (body.action === 'cancel') {
            const result = await tx.workOrders.transition(
              job.id,
              job.revision,
              'cancelled',
              principal.userId,
              body.reason,
            );
            if (result.outcome !== 'written') {
              refusal(result, 'cancelled');
            }
            await audit(tx, context, 'work_order.transitioned', job.id, {
              from: job.state,
              to: 'cancelled',
              reason: body.reason,
              bulk: true,
            });
            return;
          }
          if (body.shiftMinutes !== undefined && job.dueFrom === null && job.dueBy === null) {
            // Nothing to move. Reported rather than counted as a change that did nothing.
            throw conflict('no_due_window', 'This job has no due dates to move.');
          }
          const shift = (date: Date | null) =>
            date === null || body.shiftMinutes === undefined
              ? date
              : new Date(date.getTime() + body.shiftMinutes * 60_000);
          const from =
            body.shiftMinutes === undefined ? body.dueFrom : isoOrNull(shift(job.dueFrom));
          const by = body.shiftMinutes === undefined ? body.dueBy : isoOrNull(shift(job.dueBy));
          const window = dueWindow(
            from === undefined ? isoOrNull(job.dueFrom) : from,
            by === undefined ? isoOrNull(job.dueBy) : by,
          );
          const result = await tx.workOrders.update(
            job.id,
            job.revision,
            {
              ...(from === undefined ? {} : { dueFrom: window.from ?? null }),
              ...(by === undefined ? {} : { dueBy: window.by ?? null }),
            },
            principal.userId,
            body.reason,
          );
          if (result.outcome !== 'written') {
            refusal(result);
          }
        });
        results.push({ workOrderId, outcome: 'changed' as const, code: null, message: null });
      } catch (error) {
        if (!(error instanceof ApiError)) {
          throw error;
        }
        results.push({
          workOrderId,
          outcome: 'refused' as const,
          code: error.code,
          message: error.message,
        });
      }
    }
    return { status: 200, body: { results } };
  },
});

// ---------------------------------------------------------------------------
// Saved views
// ---------------------------------------------------------------------------

const savedViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  resource: z.literal('work_orders'),
  filters: z.record(z.string(), z.unknown()),
  shared: z.boolean(),
  owner: personSchema,
  mine: z.boolean(),
  updatedAt: z.string(),
});

/** The filters a view may store: exactly the list's query parameters, so a view is a link. */
const viewFiltersSchema = listQuery
  .omit({ cursor: true, limit: true })
  .partial()
  .extend({
    state: z.array(workOrderStateSchema).max(9).optional(),
    priority: z.array(prioritySchema).max(4).optional(),
    jobTypeId: z.array(z.uuid()).max(50).optional(),
  });

export const listSavedViewsRoute = defineRoute({
  method: 'get',
  path: '/v1/saved-views',
  operationId: 'listSavedViews',
  summary: 'Saved views: one’s own and those shared by colleagues',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: noSchema,
  query: z.object({ resource: z.literal('work_orders').default('work_orders') }),
  body: noSchema,
  responses: {
    200: { description: 'Views.', schema: z.object({ items: z.array(savedViewSchema) }) },
  },
  handler: async ({ query }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      const [views, people] = await Promise.all([
        tx.savedViews.listVisible(query.resource, context.principal.userId),
        peopleOf(tx),
      ]);
      return views.map((view) => ({
        id: view.id,
        name: view.name,
        resource: view.resource,
        filters: view.filters,
        shared: view.shared,
        owner: personBody(view.ownerId, people),
        mine: view.ownerId === context.principal.userId,
        updatedAt: iso(view.updatedAt),
      }));
    });
    return { status: 200, body: { items } };
  },
});

export const saveViewRoute = defineRoute({
  method: 'post',
  path: '/v1/saved-views',
  operationId: 'createSavedView',
  summary: 'Save the current filters as a view',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({
    name: z.string().trim().min(1).max(80),
    resource: z.literal('work_orders').default('work_orders'),
    filters: viewFiltersSchema,
    shared: z.boolean().optional(),
  }),
  responses: {
    201: { description: 'The view.', schema: savedViewSchema },
    409: { description: 'You already have a view with this name (`view_name_taken`).' },
  },
  handler: async ({ body }, context) => {
    const view = await withTenant(context.principal.tenantId, async (tx) => {
      const created = await tx.savedViews
        .create(
          body.resource,
          {
            name: body.name,
            filters: body.filters,
            ...(body.shared === undefined ? {} : { shared: body.shared }),
          },
          context.principal.userId,
        )
        .catch((error: unknown) => {
          if ((error as { code?: string }).code === '23505') {
            throw conflict('view_name_taken', 'You already have a view with this name.');
          }
          throw error;
        });
      return { created, people: await peopleOf(tx) };
    });
    return {
      status: 201,
      body: {
        id: view.created.id,
        name: view.created.name,
        resource: view.created.resource,
        filters: view.created.filters,
        shared: view.created.shared,
        owner: personBody(view.created.ownerId, view.people),
        mine: true,
        updatedAt: iso(view.created.updatedAt),
      },
    };
  },
});

export const deleteViewRoute = defineRoute({
  method: 'delete',
  path: '/v1/saved-views/:viewId',
  operationId: 'deleteSavedView',
  summary: 'Delete one of your saved views',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: z.object({ viewId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    204: { description: 'Deleted.' },
    404: { description: 'No such view of yours.' },
  },
  handler: async ({ params }, context) => {
    const deleted = await withTenant(context.principal.tenantId, (tx) =>
      tx.savedViews.delete(params.viewId, context.principal.userId),
    );
    if (!deleted) {
      throw notFound('You have no view with this id.');
    }
    return { status: 204, body: undefined };
  },
});

export const workOrderRoutes = [
  listWorkOrdersRoute,
  createWorkOrderRoute,
  bulkWorkOrdersRoute,
  getWorkOrderRoute,
  updateWorkOrderRoute,
  transitionWorkOrderRoute,
  signOffWorkOrderRoute,
  setCrewRoute,
  addChecklistItemRoute,
  setChecklistItemRoute,
  addWorkOrderFormRoute,
  removeWorkOrderFormRoute,
  addCommentRoute,
  listSavedViewsRoute,
  saveViewRoute,
  deleteViewRoute,
];
