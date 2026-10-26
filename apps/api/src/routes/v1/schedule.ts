import type { Principal } from '@integr8/core';
import type { TenantTransaction, Visit, WorkOrder } from '@integr8/db';
import { withTenant } from '@integr8/db';
import { z } from 'zod';
import { ApiError, conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import {
  many,
  peopleOf,
  type People,
  readableWorkOrder,
  requireWork,
  workOrderSummaries,
  workOrderSummarySchema,
} from './operations.js';
import { audit, requireCrew } from './work-orders.js';
import { visitBody, visitRefusal, visitSchema } from './visits-shared.js';

/**
 * The scheduling board (P25): a calendar of visits, the jobs still waiting for
 * one, and the changes a dispatcher makes by dragging.
 *
 * A job can take several visits; each has its own times and people from the
 * job's crew. Migration 0051 refuses the same person on overlapping visits of
 * different jobs for every client, so two dispatchers dropping a visit at once
 * cannot double-book anyone. Work outside office hours is never refused or
 * warned about: companies run 24/7 teams and flexible hours.
 *
 * The office (`work_order.manage`) plans, moves, reassigns and cancels visits.
 * Anyone who reads every job (`work_order.read_all`) sees the board. The crew
 * marks a visit done, normally from the phone through sync.
 */

const TAGS = ['schedule'];

/** About six weeks: a month view with its leading and trailing days. */
const MAX_RANGE_MS = 45 * 24 * 60 * 60 * 1000;

const instant = z.iso.datetime({ offset: true });

const visitParams = z.object({ visitId: z.uuid() });
const workOrderParams = z.object({ workOrderId: z.uuid() });

const visitResponseSchema = z.object({ visit: visitSchema });

const scheduleSchema = z.object({
  from: z.string(),
  to: z.string(),
  /** The company's day, for shading the calendar. Never a rule. */
  settings: z.object({
    timezone: z.string(),
    workDayStarts: z.number().int(),
    workDayEnds: z.number().int(),
    workingDays: z.array(z.number().int()),
  }),
  visits: z.array(visitSchema),
  /** The jobs those visits belong to. */
  workOrders: z.array(workOrderSummarySchema),
  /** Active members, for the engineer filter and the assignee picker. */
  people: z.array(z.object({ id: z.uuid(), name: z.string(), role: z.string() })),
});

const unscheduledSchema = z.object({
  items: z.array(
    z.object({
      workOrder: workOrderSummarySchema,
      /** What the job type expects; the calendar sizes a dropped visit with it. */
      expectedDurationMinutes: z.number().int().nullable(),
    }),
  ),
});

const assigneeIdsSchema = z
  .array(z.uuid())
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length, 'Each person once');

// ---------------------------------------------------------------------------

async function readableVisit(
  tx: TenantTransaction,
  principal: Principal,
  visitId: string,
): Promise<{ visit: Visit; job: WorkOrder }> {
  const visit = await tx.visits.find(visitId);
  if (visit === undefined) {
    throw notFound('This visit does not exist.');
  }
  try {
    return { visit, job: await readableWorkOrder(tx, principal, visit.workOrderId) };
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw notFound('This visit does not exist.');
    }
    throw error;
  }
}

/**
 * Puts people on the job's crew who are not on it yet, so a dispatcher can drop
 * a visit on anyone without a trip to the crew editor first.
 */
async function joinCrew(
  tx: TenantTransaction,
  job: WorkOrder,
  userIds: readonly string[],
  actor: string,
) {
  const crew = await tx.workOrders.listCrew(job.id);
  const missing = userIds.filter((userId) => !crew.some((member) => member.userId === userId));
  if (missing.length === 0) {
    return;
  }
  if (['complete', 'reviewed', 'cancelled'].includes(job.state)) {
    throw conflict('work_order_closed', 'This job is closed; its crew cannot change.');
  }
  await requireCrew(
    tx,
    missing.map((userId) => ({ userId })),
  );
  await tx.workOrders.setCrew(
    job.id,
    [
      ...crew.map((member) => ({ userId: member.userId, lead: member.lead })),
      ...missing.map((userId) => ({ userId, lead: false })),
    ],
    actor,
  );
}

async function respond(tx: TenantTransaction, visit: Visit, job: WorkOrder, people?: People) {
  return { visit: visitBody(visit, job, people ?? (await peopleOf(tx))) };
}

// ---------------------------------------------------------------------------
// Reading the board
// ---------------------------------------------------------------------------

export const getScheduleRoute = defineRoute({
  method: 'get',
  path: '/v1/schedule',
  operationId: 'getSchedule',
  summary: 'Visits in a window, for the calendar',
  description:
    'Every visit overlapping `from`–`to` (at most 45 days), planned and done, with the jobs they belong to and warnings worth noticing. `userId` narrows to visits with any of those people on them. `includeCancelled` adds called-off visits.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.read_all',
  params: noSchema,
  query: z.object({
    from: instant,
    to: instant,
    userId: many(z.uuid(), 200),
    includeCancelled: z.enum(['true', 'false']).optional(),
  }),
  body: noSchema,
  responses: {
    200: { description: 'The calendar.', schema: scheduleSchema },
    422: { description: 'The window is backwards or too wide (`schedule_range_invalid`).' },
  },
  handler: async ({ query }, context) => {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (to.getTime() <= from.getTime() || to.getTime() - from.getTime() > MAX_RANGE_MS) {
      throw unprocessable('schedule_range_invalid', 'Choose a window of up to 45 days.', [
        { field: 'query.to', code: 'schedule_range_invalid', message: 'Choose an earlier end.' },
      ]);
    }
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const [visits, people, members, settings] = await Promise.all([
        tx.visits.listInRange({
          from,
          to,
          ...(query.userId === undefined ? {} : { userIds: query.userId }),
          includeCancelled: query.includeCancelled === 'true',
        }),
        peopleOf(tx),
        tx.tenantUsers.list(),
        tx.settings.get(),
      ]);
      const jobs = await tx.workOrders.findMany(visits.map((visit) => visit.workOrderId));
      const jobById = new Map(jobs.map((job) => [job.id, job]));
      return {
        from: from.toISOString(),
        to: to.toISOString(),
        settings: {
          timezone: settings.timezone,
          workDayStarts: settings.workDayStarts,
          workDayEnds: settings.workDayEnds,
          workingDays: settings.workingDays,
        },
        visits: visits.map((visit) =>
          visitBody(
            visit,
            jobById.get(visit.workOrderId) ?? { dueFrom: null, dueBy: null },
            people,
          ),
        ),
        workOrders: await workOrderSummaries(tx, jobs, people),
        people: members
          .filter((member) => member.status === 'active')
          .map((member) => ({ id: member.userId, name: member.displayName, role: member.role })),
      };
    });
    return { status: 200, body };
  },
});

export const listUnscheduledRoute = defineRoute({
  method: 'get',
  path: '/v1/schedule/unscheduled',
  operationId: 'listUnscheduledWorkOrders',
  summary: 'Open jobs with no planned visit',
  description:
    'Urgent first, then oldest. A job whose visits are all done or cancelled is here too: it still needs a visit, or closing.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.read_all',
  params: noSchema,
  query: z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }),
  body: noSchema,
  responses: {
    200: { description: 'The jobs.', schema: unscheduledSchema },
  },
  handler: async ({ query }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const waiting = await tx.visits.listUnscheduled(query.limit ?? 200);
      const jobs = await tx.workOrders.findMany(waiting.map((entry) => entry.workOrderId));
      const summaries = new Map(
        (await workOrderSummaries(tx, jobs)).map((summary) => [summary.id, summary]),
      );
      return {
        items: waiting.flatMap((entry) => {
          const workOrder = summaries.get(entry.workOrderId);
          return workOrder === undefined
            ? []
            : [{ workOrder, expectedDurationMinutes: entry.expectedDurationMinutes }];
        }),
      };
    });
    return { status: 200, body };
  },
});

// ---------------------------------------------------------------------------
// Planning and changing visits
// ---------------------------------------------------------------------------

export const createVisitRoute = defineRoute({
  method: 'post',
  path: '/v1/work-orders/:workOrderId/visits',
  operationId: 'createVisit',
  summary: 'Plan a visit to a job',
  description:
    'Plans one trip with its own times and people. People must be on the job’s crew; `addToCrew` puts anyone who is not on it first. Refused when someone would be on another job at the same time.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.manage',
  params: workOrderParams,
  query: noSchema,
  body: z.object({
    startsAt: instant,
    endsAt: instant,
    notes: z.string().trim().max(2000).nullable().optional(),
    assigneeIds: assigneeIdsSchema.default([]),
    addToCrew: z.boolean().default(false),
  }),
  responses: {
    201: { description: 'The visit.', schema: visitResponseSchema },
    404: { description: 'No such work order.' },
    409: {
      description:
        'Someone would be on two jobs at once (`visit_double_booked`, with a detail naming each clash), or the job is closed (`work_order_closed`).',
    },
    422: {
      description:
        'The visit ends before it starts or lasts over a week (`visit_slot_invalid`), or someone is not on the crew (`visit_assignee_not_on_crew`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const result = await withTenant(principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, principal, params.workOrderId);
      if (body.addToCrew) {
        await joinCrew(tx, job, body.assigneeIds, principal.userId);
      }
      const people = await peopleOf(tx);
      const written = await tx.visits.create(
        {
          workOrderId: job.id,
          startsAt: new Date(body.startsAt),
          endsAt: new Date(body.endsAt),
          notes: body.notes ?? null,
          assigneeIds: body.assigneeIds,
        },
        principal.userId,
      );
      if (written.outcome !== 'written') {
        visitRefusal(written, people);
      }
      await audit(tx, context, 'work_order.visit_scheduled', job.id, {
        visitId: written.visit.id,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        assigneeIds: body.assigneeIds,
      });
      return respond(tx, written.visit, job, people);
    });
    return { status: 201, body: result };
  },
});

export const updateVisitRoute = defineRoute({
  method: 'patch',
  path: '/v1/visits/:visitId',
  operationId: 'updateVisit',
  summary: 'Move a visit, or change who goes',
  description:
    'Refused when the visit changed since `expectedRevision`, when it is done or cancelled, or when someone would be on another job at the same time. `assigneeIds` replaces who goes; `addToCrew` puts newcomers on the job’s crew first.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.manage',
  params: visitParams,
  query: noSchema,
  body: z
    .object({
      expectedRevision: z.number().int().min(1),
      startsAt: instant.optional(),
      endsAt: instant.optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
      assigneeIds: assigneeIdsSchema.optional(),
      addToCrew: z.boolean().default(false),
    })
    .refine(
      (value) =>
        value.startsAt !== undefined ||
        value.endsAt !== undefined ||
        value.notes !== undefined ||
        value.assigneeIds !== undefined,
      'Change at least one thing',
    ),
  responses: {
    200: { description: 'The visit.', schema: visitResponseSchema },
    404: { description: 'No such visit.' },
    409: {
      description:
        'Changed elsewhere (`visit_changed`), done or cancelled (`visit_final`), a double booking (`visit_double_booked`), or the job is closed (`work_order_closed`).',
    },
    422: {
      description:
        'The visit ends before it starts or lasts over a week (`visit_slot_invalid`), or someone is not on the crew (`visit_assignee_not_on_crew`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const result = await withTenant(principal.tenantId, async (tx) => {
      const { visit, job } = await readableVisit(tx, principal, params.visitId);
      if (body.addToCrew && body.assigneeIds !== undefined) {
        await joinCrew(tx, job, body.assigneeIds, principal.userId);
      }
      const people = await peopleOf(tx);
      const written = await tx.visits.update(
        visit.id,
        body.expectedRevision,
        {
          ...(body.startsAt === undefined ? {} : { startsAt: new Date(body.startsAt) }),
          ...(body.endsAt === undefined ? {} : { endsAt: new Date(body.endsAt) }),
          ...(body.notes === undefined ? {} : { notes: body.notes }),
          ...(body.assigneeIds === undefined ? {} : { assigneeIds: body.assigneeIds }),
        },
        principal.userId,
      );
      if (written.outcome !== 'written') {
        visitRefusal(written, people);
      }
      await audit(tx, context, 'work_order.visit_changed', job.id, {
        visitId: visit.id,
        ...(body.startsAt === undefined ? {} : { startsAt: body.startsAt }),
        ...(body.endsAt === undefined ? {} : { endsAt: body.endsAt }),
        ...(body.assigneeIds === undefined ? {} : { assigneeIds: body.assigneeIds }),
      });
      return respond(tx, written.visit, job, people);
    });
    return { status: 200, body: result };
  },
});

export const cancelVisitRoute = defineRoute({
  method: 'post',
  path: '/v1/visits/:visitId/cancel',
  operationId: 'cancelVisit',
  summary: 'Call a visit off',
  description: 'Final: a cancelled visit stays in the job’s history and frees its people.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.manage',
  params: visitParams,
  query: noSchema,
  body: z.object({
    expectedRevision: z.number().int().min(1),
    reason: z.string().trim().max(500).nullable().optional(),
  }),
  responses: {
    200: { description: 'The visit, cancelled.', schema: visitResponseSchema },
    404: { description: 'No such visit.' },
    409: {
      description:
        'Changed elsewhere (`visit_changed`), or already done or cancelled (`visit_final`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const result = await withTenant(principal.tenantId, async (tx) => {
      const { visit, job } = await readableVisit(tx, principal, params.visitId);
      const people = await peopleOf(tx);
      const written = await tx.visits.cancel(
        visit.id,
        body.expectedRevision,
        body.reason ?? null,
        principal.userId,
      );
      if (written.outcome !== 'written') {
        visitRefusal(written, people);
      }
      await audit(tx, context, 'work_order.visit_cancelled', job.id, {
        visitId: visit.id,
        ...(body.reason == null ? {} : { reason: body.reason }),
      });
      return respond(tx, written.visit, job, people);
    });
    return { status: 200, body: result };
  },
});

export const completeVisitRoute = defineRoute({
  method: 'post',
  path: '/v1/visits/:visitId/done',
  operationId: 'completeVisit',
  summary: 'Mark a visit done',
  description:
    'By the crew or the office. `completedAt` is when it was done, if not now; never later than now. Doing it twice is harmless. The job itself moves on separately.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: visitParams,
  query: noSchema,
  body: z.object({ completedAt: instant.optional() }),
  responses: {
    200: { description: 'The visit, done.', schema: visitResponseSchema },
    403: { description: 'Not on this job’s crew, and not the office.' },
    404: { description: 'No such visit this person may see.' },
    409: { description: 'The visit was cancelled (`visit_final`).' },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const result = await withTenant(principal.tenantId, async (tx) => {
      const { visit, job } = await readableVisit(tx, principal, params.visitId);
      await requireWork(tx, principal, job);
      const people = await peopleOf(tx);
      const written = await tx.visits.markDone(
        visit.id,
        body.completedAt === undefined ? new Date() : new Date(body.completedAt),
        principal.userId,
      );
      if (written.outcome !== 'written') {
        visitRefusal(written, people);
      }
      if (visit.status !== 'done') {
        await audit(tx, context, 'work_order.visit_done', job.id, { visitId: visit.id });
      }
      return respond(tx, written.visit, job, people);
    });
    return { status: 200, body: result };
  },
});

// ---------------------------------------------------------------------------
// Many at once
// ---------------------------------------------------------------------------

export const bulkVisitsRoute = defineRoute({
  method: 'post',
  path: '/v1/visits/bulk',
  operationId: 'bulkVisits',
  summary: 'Reassign, move or cancel many visits',
  description:
    'Each visit is changed on its own, so one that cannot be — done, cancelled, a double booking — is reported and the rest go ahead. `reassign` hands the visits from `fromUserId` to `toUserId` (or makes `toUserId` the only person when `fromUserId` is left out); `shift` moves them by `shiftMinutes`; `cancel` calls them off.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.manage',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.discriminatedUnion('action', [
    z.object({
      action: z.literal('reassign'),
      visitIds: z.array(z.uuid()).min(1).max(200),
      fromUserId: z.uuid().optional(),
      toUserId: z.uuid(),
      addToCrew: z.boolean().default(true),
    }),
    z.object({
      action: z.literal('shift'),
      visitIds: z.array(z.uuid()).min(1).max(200),
      shiftMinutes: z.number().int().min(-525_600).max(525_600),
    }),
    z.object({
      action: z.literal('cancel'),
      visitIds: z.array(z.uuid()).min(1).max(200),
      reason: z.string().trim().max(500).nullable().optional(),
    }),
  ]),
  responses: {
    200: {
      description: 'What happened to each visit, in the order given.',
      schema: z.object({
        results: z.array(
          z.object({
            visitId: z.uuid(),
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
    const results = [];
    for (const visitId of [...new Set(body.visitIds)]) {
      try {
        await withTenant(principal.tenantId, (tx) => changeOne(tx, context, visitId, body));
        results.push({ visitId, outcome: 'changed' as const, code: null, message: null });
      } catch (error) {
        if (!(error instanceof ApiError)) {
          throw error;
        }
        results.push({
          visitId,
          outcome: 'refused' as const,
          code: error.code,
          message: error.message,
        });
      }
    }
    return { status: 200, body: { results } };
  },
});

type BulkAction =
  | { action: 'reassign'; fromUserId?: string | undefined; toUserId: string; addToCrew: boolean }
  | { action: 'shift'; shiftMinutes: number }
  | { action: 'cancel'; reason?: string | null | undefined };

async function changeOne(
  tx: TenantTransaction,
  context: RequestContext,
  visitId: string,
  body: BulkAction,
) {
  const { principal } = context;
  const { visit, job } = await readableVisit(tx, principal, visitId);
  const people = await peopleOf(tx);
  if (body.action === 'cancel') {
    const written = await tx.visits.cancel(
      visit.id,
      visit.revision,
      body.reason ?? null,
      principal.userId,
    );
    if (written.outcome !== 'written') {
      visitRefusal(written, people);
    }
    await audit(tx, context, 'work_order.visit_cancelled', job.id, { visitId, bulk: true });
    return;
  }
  if (body.action === 'shift') {
    const by = body.shiftMinutes * 60_000;
    const written = await tx.visits.update(
      visit.id,
      visit.revision,
      {
        startsAt: new Date(visit.startsAt.getTime() + by),
        endsAt: new Date(visit.endsAt.getTime() + by),
      },
      principal.userId,
    );
    if (written.outcome !== 'written') {
      visitRefusal(written, people);
    }
    await audit(tx, context, 'work_order.visit_changed', job.id, {
      visitId,
      shiftMinutes: body.shiftMinutes,
      bulk: true,
    });
    return;
  }
  const assigneeIds =
    body.fromUserId === undefined
      ? [body.toUserId]
      : [
          ...new Set(
            visit.assigneeIds.map((userId) =>
              userId === body.fromUserId ? body.toUserId : userId,
            ),
          ),
        ];
  if (body.fromUserId !== undefined && !visit.assigneeIds.some((id) => id === body.fromUserId)) {
    throw conflict('visit_assignee_missing', 'The person being replaced is not on this visit.');
  }
  if (body.addToCrew) {
    await joinCrew(tx, job, [body.toUserId], principal.userId);
  }
  const written = await tx.visits.update(
    visit.id,
    visit.revision,
    { assigneeIds },
    principal.userId,
  );
  if (written.outcome !== 'written') {
    visitRefusal(written, people);
  }
  await audit(tx, context, 'work_order.visit_changed', job.id, {
    visitId,
    assigneeIds,
    bulk: true,
  });
}

export const scheduleRoutes = [
  getScheduleRoute,
  listUnscheduledRoute,
  createVisitRoute,
  updateVisitRoute,
  cancelVisitRoute,
  completeVisitRoute,
  bulkVisitsRoute,
];
