import {
  activityKindSchema,
  activityStartsDone,
  activityStatusSchema,
  holds,
  LEAD_STATUSES,
} from '@integr8/core';
import { type Activity, type TenantTransaction, withTenant } from '@integr8/db';
import { z } from 'zod';
import { ApiError, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { crmAudit, FEATURE, requireAssignableMember, TAGS, versionConflict } from './crm-shared.js';
import { stageBody, stageSchema } from './crm-opportunities.js';
import { many } from './operations.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Follow-ups and the record of what was done (CRM/ERP plan, phase C3), and the
 * CRM dashboard.
 *
 * An activity is linked to at least one lead, customer or opportunity of the
 * same company. "Today" and "overdue" are read in the company's time zone. The
 * to-do list is in the app only; reminders by email wait for an email channel.
 */

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export const activitySchema = z.object({
  id: z.uuid(),
  kind: activityKindSchema,
  subject: z.string(),
  detail: z.string().nullable(),
  outcome: z.string().nullable(),
  status: activityStatusSchema,
  assignedTo: z.uuid().nullable(),
  dueAt: z.iso.datetime().nullable(),
  completedAt: z.iso.datetime().nullable(),
  completedBy: z.uuid().nullable(),
  version: z.number().int(),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  leads: z.array(z.object({ id: z.uuid(), displayName: z.string() })),
  customers: z.array(z.object({ id: z.uuid(), name: z.string() })),
  opportunities: z.array(z.object({ id: z.uuid(), title: z.string() })),
});

export type ActivityBody = z.infer<typeof activitySchema>;

/** Activities with what each is about, looked up once for the lot. */
export async function activityBodies(
  tx: TenantTransaction,
  items: readonly Activity[],
): Promise<ActivityBody[]> {
  const [leads, customers, opportunities] = await Promise.all([
    tx.crmLeads.findMany(items.flatMap((item) => item.links.leadIds)),
    tx.customers.findMany(items.flatMap((item) => item.links.customerIds)),
    tx.crmOpportunities.findMany(items.flatMap((item) => item.links.opportunityIds)),
  ]);
  const lead = new Map(leads.map((row) => [row.id, row]));
  const customer = new Map(customers.map((row) => [row.id, row]));
  const opportunity = new Map(opportunities.map((row) => [row.id, row]));
  return items.map((item) => ({
    id: item.id,
    kind: item.kind,
    subject: item.subject,
    detail: item.detail,
    outcome: item.outcome,
    status: item.status,
    assignedTo: item.assignedTo,
    dueAt: isoOrNull(item.dueAt),
    completedAt: isoOrNull(item.completedAt),
    completedBy: item.completedBy,
    version: item.version,
    createdBy: item.createdBy,
    createdAt: iso(item.createdAt),
    updatedAt: iso(item.updatedAt),
    leads: item.links.leadIds.flatMap((id) => {
      const row = lead.get(id);
      return row === undefined ? [] : [{ id: row.id, displayName: row.displayName }];
    }),
    customers: item.links.customerIds.flatMap((id) => {
      const row = customer.get(id);
      return row === undefined ? [] : [{ id: row.id, name: row.name }];
    }),
    opportunities: item.links.opportunityIds.flatMap((id) => {
      const row = opportunity.get(id);
      return row === undefined ? [] : [{ id: row.id, title: row.title }];
    }),
  }));
}

/** Opaque cursors for the activity lists, whose position may have no date. */
function encodeActivityCursor(next: { at: Date | null; id: string } | undefined): string | null {
  return next === undefined
    ? null
    : Buffer.from(
        JSON.stringify({ at: next.at === null ? null : next.at.toISOString(), id: next.id }),
        'utf8',
      ).toString('base64url');
}

function decodeActivityCursor(
  cursor: string | undefined,
): { at: Date | null; id: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    const result = z.object({ at: z.iso.datetime().nullable(), id: z.uuid() }).safeParse(parsed);
    return result.success
      ? { at: result.data.at === null ? null : new Date(result.data.at), id: result.data.id }
      : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const listActivitiesRoute = defineRoute({
  method: 'get',
  path: '/v1/crm/activities',
  operationId: 'listActivities',
  summary: 'Follow-ups and activities',
  description:
    '`order=due` (the default) is the to-do list: soonest first, undated last. `order=recent` is a timeline: newest first. `due` is read in the company’s time zone. `assignedTo` takes a member id, `me` or `none`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    status: many(activityStatusSchema, 3),
    assignedTo: z.union([z.uuid(), z.literal('me'), z.literal('none')]).optional(),
    due: z.enum(['overdue', 'today', 'upcoming', 'none']).optional(),
    leadId: z.uuid().optional(),
    customerId: z.uuid().optional(),
    opportunityId: z.uuid().optional(),
    order: z.enum(['due', 'recent']).default('due'),
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of activities.',
      schema: z.object({ items: z.array(activitySchema), nextCursor: z.string().nullable() }),
    },
  },
  handler: async ({ query }, context) => {
    const after = decodeActivityCursor(query.cursor);
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const page = await tx.crmActivities.list({
        timeZone: (await tx.settings.get()).timezone,
        statuses: query.status,
        ...(query.assignedTo === undefined
          ? {}
          : {
              assignedTo:
                query.assignedTo === 'me'
                  ? context.principal.userId
                  : query.assignedTo === 'none'
                    ? null
                    : query.assignedTo,
            }),
        ...(query.due === undefined ? {} : { due: query.due }),
        ...(query.leadId === undefined ? {} : { leadId: query.leadId }),
        ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
        ...(query.opportunityId === undefined ? {} : { opportunityId: query.opportunityId }),
        order: query.order,
        ...(after === undefined ? {} : { after }),
        limit: query.limit,
      });
      return {
        items: await activityBodies(tx, page.items),
        nextCursor: encodeActivityCursor(page.next),
      };
    });
    return { status: 200, body };
  },
});

const ids = z.array(z.uuid()).max(10).optional();

const createActivitySchema = z.object({
  kind: activityKindSchema,
  subject: z.string().trim().min(1).max(200),
  detail: z.string().max(10_000).nullable().optional(),
  outcome: z.string().max(2000).nullable().optional(),
  assignedTo: z.uuid().nullable().optional(),
  dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
  /** Records something already done (a call made). Notes are always done. */
  done: z.boolean().optional(),
  leadIds: ids,
  customerIds: ids,
  opportunityIds: ids,
});

/** Checks every linked record is this company's, naming the first that is not. */
async function requireLinks(
  tx: TenantTransaction,
  links: { leadIds: string[]; customerIds: string[]; opportunityIds: string[] },
): Promise<void> {
  const total = links.leadIds.length + links.customerIds.length + links.opportunityIds.length;
  if (total === 0) {
    throw unprocessable('link_required', 'Link it to a lead, a customer or an opportunity.', [
      {
        field: 'body.leadIds',
        code: 'link_required',
        message: 'Link it to a lead, a customer or an opportunity.',
      },
    ]);
  }
  const [leads, customers, opportunities] = await Promise.all([
    tx.crmLeads.findMany(links.leadIds),
    tx.customers.findMany(links.customerIds),
    tx.crmOpportunities.findMany(links.opportunityIds),
  ]);
  for (const [field, wanted, found] of [
    ['leadIds', links.leadIds, leads],
    ['customerIds', links.customerIds, customers],
    ['opportunityIds', links.opportunityIds, opportunities],
  ] as const) {
    const known = new Set(found.map((row) => row.id));
    const missing = wanted.find((id) => !known.has(id));
    if (missing !== undefined) {
      throw new ApiError(404, 'link_not_found', 'Something it is linked to does not exist.', [
        {
          field: `body.${field}`,
          code: 'link_not_found',
          message: 'Something it is linked to does not exist.',
        },
      ]);
    }
  }
}

export const createActivityRoute = defineRoute({
  method: 'post',
  path: '/v1/crm/activities',
  operationId: 'createActivity',
  summary: 'Log an activity or set a follow-up',
  description:
    'Linked to at least one lead, customer or opportunity of this company. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.activity.manage',
  feature: FEATURE,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: createActivitySchema,
  responses: {
    201: { description: 'The activity.', schema: activitySchema },
    404: { description: 'A linked record does not exist (`link_not_found`).' },
    422: {
      description:
        'Invalid; linked to nothing (`link_required`); or the assignee is not an active member (`assignee_not_member`).',
    },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const created = await withTenant(principal.tenantId, async (tx) => {
      const links = {
        leadIds: [...new Set(body.leadIds ?? [])],
        customerIds: [...new Set(body.customerIds ?? [])],
        opportunityIds: [...new Set(body.opportunityIds ?? [])],
      };
      await requireLinks(tx, links);
      if (typeof body.assignedTo === 'string') {
        await requireAssignableMember(tx, body.assignedTo);
      }
      const activity = await tx.crmActivities.create(
        {
          kind: body.kind,
          subject: body.subject,
          ...(body.detail === undefined ? {} : { detail: body.detail }),
          ...(body.outcome === undefined ? {} : { outcome: body.outcome }),
          ...(body.assignedTo === undefined ? {} : { assignedTo: body.assignedTo }),
          ...(body.dueAt === undefined
            ? {}
            : { dueAt: body.dueAt === null ? null : new Date(body.dueAt) }),
          done: activityStartsDone(body.kind) || body.done === true,
        },
        links,
        principal.userId,
      );
      await crmAudit(tx, context, 'crm_activity.created', 'crm_activity', activity.id, {
        kind: activity.kind,
        ...links,
      });
      return (await activityBodies(tx, [activity]))[0]!;
    });
    return { status: 201, body: created };
  },
});

const updateActivitySchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    subject: z.string().trim().min(1).max(200).optional(),
    detail: z.string().max(10_000).nullable().optional(),
    outcome: z.string().max(2000).nullable().optional(),
    assignedTo: z.uuid().nullable().optional(),
    dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
    /** `done` records who and when; `open` reopens; `cancelled` drops it. */
    status: activityStatusSchema.optional(),
  })
  .strict();

export const updateActivityRoute = defineRoute({
  method: 'patch',
  path: '/v1/crm/activities/:activityId',
  operationId: 'updateActivity',
  summary: 'Change, complete, reopen or cancel an activity',
  description:
    'Send `expectedVersion` as read; a newer version wins and this one is refused with 409 `version_conflict`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.activity.manage',
  feature: FEATURE,
  params: z.object({ activityId: z.uuid() }),
  query: noSchema,
  body: updateActivitySchema,
  responses: {
    200: { description: 'The activity as it is now.', schema: activitySchema },
    404: { description: 'No such activity.' },
    409: { description: 'Changed by somebody else since it was read (`version_conflict`).' },
    422: {
      description: 'Invalid, or the assignee is not an active member (`assignee_not_member`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const updated = await withTenant(principal.tenantId, async (tx) => {
      const current = await tx.crmActivities.find(params.activityId);
      if (current === undefined) {
        throw notFound('This activity does not exist.');
      }
      if (typeof body.assignedTo === 'string') {
        await requireAssignableMember(tx, body.assignedTo);
      }
      const result = await tx.crmActivities.update(
        current.id,
        body.expectedVersion,
        {
          ...(body.subject === undefined ? {} : { subject: body.subject }),
          ...(body.detail === undefined ? {} : { detail: body.detail }),
          ...(body.outcome === undefined ? {} : { outcome: body.outcome }),
          ...(body.assignedTo === undefined ? {} : { assignedTo: body.assignedTo }),
          ...(body.dueAt === undefined
            ? {}
            : { dueAt: body.dueAt === null ? null : new Date(body.dueAt) }),
          ...(body.status === undefined ? {} : { status: body.status }),
        },
        principal.userId,
      );
      if (result === 'not_found') {
        throw notFound('This activity does not exist.');
      }
      if (result === 'version_conflict') {
        throw versionConflict();
      }
      await crmAudit(
        tx,
        context,
        result.status !== current.status ? `crm_activity.${result.status}` : 'crm_activity.updated',
        'crm_activity',
        result.id,
        {
          fields: Object.keys(body).filter(
            (key) =>
              key !== 'expectedVersion' && (body as Record<string, unknown>)[key] !== undefined,
          ),
        },
      );
      return (await activityBodies(tx, [result]))[0]!;
    });
    return { status: 200, body: updated };
  },
});

// ---------------------------------------------------------------------------
// The dashboard
// ---------------------------------------------------------------------------

const currencyTotalSchema = z.object({
  currencyCode: z.string(),
  /** A decimal string. */
  total: z.string(),
  /** A decimal string: each amount times its chance. A forecast, not revenue. */
  weighted: z.string(),
  count: z.number().int(),
});

export const crmDashboardSchema = z.object({
  /** The company's currency. */
  currency: z.string(),
  /** Wins and losses are counted from here (30 days back). */
  since: z.iso.datetime(),
  leadsByStatus: z.object(
    Object.fromEntries(LEAD_STATUSES.map((status) => [status, z.number().int()])) as Record<
      (typeof LEAD_STATUSES)[number],
      z.ZodNumber
    >,
  ),
  pipeline: z.object({
    id: z.uuid(),
    name: z.string(),
    stages: z.array(
      stageSchema.extend({ count: z.number().int(), totals: z.array(currencyTotalSchema) }),
    ),
  }),
  openTotals: z.array(currencyTotalSchema),
  won: z.array(currencyTotalSchema),
  lostCount: z.number().int(),
  activities: z.object({
    overdue: z.number().int(),
    dueToday: z.number().int(),
    /** Open ones assigned to the caller. */
    mine: z.number().int(),
  }),
  can: z.object({
    manageLeads: z.boolean(),
    manageOpportunities: z.boolean(),
    manageActivities: z.boolean(),
  }),
});

export const crmDashboardRoute = defineRoute({
  method: 'get',
  path: '/v1/crm/dashboard',
  operationId: 'getCrmDashboard',
  summary: 'The CRM at a glance',
  description:
    'Leads by status, the open pipeline by stage with totals per currency (and weighted by chance — a forecast, not revenue), wins and losses in the last 30 days, and follow-ups due.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.read',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The figures.', schema: crmDashboardSchema },
  },
  handler: async (_input, context) => {
    const { principal } = context;
    const since = new Date(Date.now() - 30 * 86_400_000);
    const body = await withTenant(principal.tenantId, async (tx) => {
      const settings = await tx.settings.get();
      const pipeline = await tx.crmPipelines.ensureDefault();
      const [figures, activities] = await Promise.all([
        tx.crmReports.dashboard(since),
        tx.crmActivities.counts(settings.timezone, principal.userId),
      ]);
      const byStage = new Map(figures.openByStage.map((stage) => [stage.stageId, stage]));
      return {
        currency: settings.currency,
        since: since.toISOString(),
        leadsByStatus: figures.leadsByStatus,
        pipeline: {
          id: pipeline.id,
          name: pipeline.name,
          stages: pipeline.stages
            .filter((stage) => stage.outcome === 'open' && stage.archivedAt === null)
            .map((stage) => ({
              ...stageBody(stage),
              count: byStage.get(stage.id)?.count ?? 0,
              totals: byStage.get(stage.id)?.totals ?? [],
            })),
        },
        openTotals: figures.openTotals,
        won: figures.wonSince,
        lostCount: figures.lostSinceCount,
        activities: {
          overdue: activities.overdue,
          dueToday: activities.dueToday,
          mine: activities.mineOpen,
        },
        can: {
          manageLeads: holds(principal, 'crm.lead.manage'),
          manageOpportunities: holds(principal, 'crm.opportunity.manage'),
          manageActivities: holds(principal, 'crm.activity.manage'),
        },
      };
    });
    return { status: 200, body };
  },
});

export const activityRoutes = [
  listActivitiesRoute,
  createActivityRoute,
  updateActivityRoute,
  crmDashboardRoute,
];
