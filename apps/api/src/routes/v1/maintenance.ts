import {
  addDays,
  calendarDaySchema,
  contractLastDay,
  DEFAULT_PLAN_LEAD_DAYS,
  DEFAULT_PLAN_WINDOW_DAYS,
  forecastDues,
  formatAssetReference,
  formatContractReference,
  formatWorkOrderReference,
  holds,
  initialNextDue,
  INTERVAL_UNITS,
  laterDay,
  MAINTENANCE_FORECAST_DAYS,
  maintenanceStanding,
  type NextDue,
  nextAfterFinishing,
  PLAN_COUNTINGS,
  PLAN_INTERVAL_MAX,
  PLAN_LEAD_DAYS_MAX,
  PLAN_STATUSES,
  PLAN_WINDOW_DAYS_MAX,
} from '@integr8/core';
import type {
  LastOccurrence,
  MaintenancePlan,
  MaintenancePlanWrite,
  TenantTransaction,
} from '@integr8/db';
import { withTenant } from '@integr8/db';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { crmAudit as audit } from './crm-shared.js';
import { booleanQuery } from './operations.js';
import { companyToday } from './sales-quotes.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Maintenance plans (P27): recurring servicing of one asset.
 *
 * A plan's jobs are made by the worker (`apps/api/src/maintenance`), a set
 * number of days before each due date, unplanned, for a dispatcher to place.
 * Changing a plan only moves what has not been made yet. Plans need the assets
 * module; they use its permissions (`asset.manage` keeps them, `asset.read`
 * sees them).
 */

const TAGS = ['maintenance'];
const ASSETS = 'assets' as const;

const planParams = z.object({ planId: z.uuid() });

const MAINTENANCE_STANDINGS = [
  'upcoming',
  'created',
  'completed',
  'overdue',
  'cancelled',
  'skipped',
] as const;

const lastSchema = z
  .object({
    dueOn: z.string(),
    workOrder: z.object({ id: z.uuid(), reference: z.string(), state: z.string() }).nullable(),
  })
  .nullable();

export const planSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  instructions: z.string().nullable(),
  asset: z.object({ id: z.uuid(), name: z.string(), reference: z.string(), status: z.string() }),
  customer: z.object({ id: z.uuid(), name: z.string() }),
  site: z.object({ id: z.uuid(), name: z.string() }),
  jobType: z.object({ id: z.uuid(), name: z.string() }),
  contract: z.object({ id: z.uuid(), reference: z.string(), title: z.string() }).nullable(),
  intervalCount: z.number().int(),
  intervalUnit: z.enum(INTERVAL_UNITS),
  counting: z.enum(PLAN_COUNTINGS),
  startsOn: z.string(),
  endsOn: z.string().nullable(),
  windowBeforeDays: z.number().int(),
  windowAfterDays: z.number().int(),
  leadDays: z.number().int(),
  canShare: z.boolean(),
  status: z.enum(PLAN_STATUSES),
  /** The next due date with no job yet; null while a completion plan waits for its open job. */
  nextDueOn: z.string().nullable(),
  /** The next few due dates, for a calendar plan; only the next for a completion plan. */
  upcoming: z.array(z.string()),
  last: lastSchema,
  version: z.number().int(),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
});

const planInputSchema = z.object({
  jobTypeId: z.uuid(),
  contractId: z.uuid().nullable().optional(),
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().max(10000).nullable().optional(),
  intervalCount: z.number().int().min(1).max(PLAN_INTERVAL_MAX),
  intervalUnit: z.enum(INTERVAL_UNITS),
  counting: z.enum(PLAN_COUNTINGS),
  startsOn: calendarDaySchema,
  endsOn: calendarDaySchema.nullable().optional(),
  windowBeforeDays: z.number().int().min(0).max(PLAN_WINDOW_DAYS_MAX).optional(),
  windowAfterDays: z.number().int().min(0).max(PLAN_WINDOW_DAYS_MAX).optional(),
  leadDays: z.number().int().min(0).max(PLAN_LEAD_DAYS_MAX).optional(),
  canShare: z.boolean().optional(),
});

// ---------------------------------------------------------------------------

/**
 * Where a plan goes from here: its next due date with no job yet, worked out
 * from the plan as it now is, today and what it already made.
 */
export function nextDueFor(
  plan: Pick<
    MaintenancePlan,
    'counting' | 'startsOn' | 'endsOn' | 'intervalCount' | 'intervalUnit'
  >,
  today: string,
  last: LastOccurrence | undefined,
  timeZone: string,
): NextDue {
  const schedule = {
    counting: plan.counting,
    interval: { count: plan.intervalCount, unit: plan.intervalUnit },
    startsOn: plan.startsOn,
    endsOn: plan.endsOn,
  };
  if (plan.counting === 'calendar' || last === undefined) {
    return initialNextDue(schedule, today, last?.dueOn ?? null);
  }
  // A completion plan: wait for an open job; otherwise one interval after it finished.
  if (last.status === 'created' && last.jobState !== null) {
    if (last.jobState === 'complete' || last.jobState === 'reviewed') {
      const finished = dayIn(last.completedAt!, timeZone);
      return { nextDueOn: nextAfterFinishing(schedule.interval, finished), nextSequence: 0 };
    }
    if (last.jobState === 'cancelled') {
      return { nextDueOn: nextAfterFinishing(schedule.interval, last.dueOn), nextSequence: 0 };
    }
    return { nextDueOn: null, nextSequence: 0 };
  }
  return { nextDueOn: nextAfterFinishing(schedule.interval, last.dueOn), nextSequence: 0 };
}

function dayIn(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

async function planBodies(tx: TenantTransaction, plans: readonly MaintenancePlan[]) {
  if (plans.length === 0) {
    return [];
  }
  const [customers, sites, jobTypes, contracts, lasts, today] = await Promise.all([
    tx.customers.findMany(plans.map((plan) => plan.customerId)),
    tx.sites.findMany(plans.map((plan) => plan.siteId)),
    tx.jobTypes.list({ includeArchived: true }),
    tx.contracts.findMany(
      plans.map((plan) => plan.contractId).filter((id): id is string => id !== null),
    ),
    tx.maintenance.lastOccurrences(plans.map((plan) => plan.id)),
    companyToday(tx),
  ]);
  const jobs = await tx.workOrders.findMany(
    [...lasts.values()].map((last) => last.workOrderId).filter((id): id is string => id !== null),
  );
  const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));
  const siteName = new Map(sites.map((site) => [site.id, site.name]));
  const typeName = new Map(jobTypes.map((type) => [type.id, type.name]));
  const contractById = new Map(contracts.map((contract) => [contract.id, contract]));
  const jobById = new Map(jobs.map((job) => [job.id, job]));
  return plans.map((plan) => {
    const contract = plan.contractId === null ? undefined : contractById.get(plan.contractId);
    const last = lasts.get(plan.id);
    const lastJob = last?.workOrderId == null ? undefined : jobById.get(last.workOrderId);
    const contractEnd = contract === undefined ? null : contractLastDay(contract);
    return {
      id: plan.id,
      title: plan.title,
      instructions: plan.instructions,
      asset: {
        id: plan.assetId,
        name: plan.assetName,
        reference: formatAssetReference(plan.assetReference),
        status: plan.assetStatus,
      },
      customer: { id: plan.customerId, name: customerName.get(plan.customerId) ?? '' },
      site: { id: plan.siteId, name: siteName.get(plan.siteId) ?? '' },
      jobType: { id: plan.jobTypeId, name: typeName.get(plan.jobTypeId) ?? '' },
      contract:
        contract === undefined
          ? null
          : {
              id: contract.id,
              reference: formatContractReference(contract.reference),
              title: contract.title,
            },
      intervalCount: plan.intervalCount,
      intervalUnit: plan.intervalUnit,
      counting: plan.counting,
      startsOn: plan.startsOn,
      endsOn: plan.endsOn,
      windowBeforeDays: plan.windowBeforeDays,
      windowAfterDays: plan.windowAfterDays,
      leadDays: plan.leadDays,
      canShare: plan.canShare,
      status: plan.status,
      nextDueOn: plan.nextDueOn,
      upcoming:
        plan.status === 'ended'
          ? []
          : forecastDues(
              {
                counting: plan.counting,
                interval: { count: plan.intervalCount, unit: plan.intervalUnit },
                startsOn: plan.startsOn,
                endsOn:
                  contractEnd === null
                    ? plan.endsOn
                    : plan.endsOn === null || contractEnd < plan.endsOn
                      ? contractEnd
                      : plan.endsOn,
                nextDueOn: plan.nextDueOn,
                nextSequence: plan.nextSequence,
              },
              today,
              addDays(today, MAINTENANCE_FORECAST_DAYS),
              4,
            ),
      last:
        last === undefined
          ? null
          : {
              dueOn: last.dueOn,
              workOrder:
                lastJob === undefined
                  ? null
                  : {
                      id: lastJob.id,
                      reference: formatWorkOrderReference(lastJob.reference),
                      state: lastJob.state,
                    },
            },
      version: plan.version,
      createdAt: iso(plan.createdAt),
      endedAt: isoOrNull(plan.endedAt),
    };
  });
}

async function planBody(tx: TenantTransaction, plan: MaintenancePlan) {
  return (await planBodies(tx, [plan]))[0]!;
}

function planRefusal(result: Exclude<MaintenancePlanWrite, { outcome: 'written' }>): never {
  switch (result.outcome) {
    case 'not_found':
      throw notFound('This maintenance plan does not exist.');
    case 'conflict':
      throw conflict(
        'maintenance_plan_changed',
        'Someone else changed this plan. Reload and try again.',
      );
    case 'ended':
      throw conflict('maintenance_plan_ended', 'This plan has ended. Add a new one instead.');
  }
}

/** The job type and contract a plan names must exist and suit its asset. */
async function checkPlanParts(
  tx: TenantTransaction,
  customerId: string,
  input: { jobTypeId?: string | undefined; contractId?: string | null | undefined },
) {
  if (input.jobTypeId !== undefined) {
    const jobType = await tx.jobTypes.find(input.jobTypeId);
    if (jobType?.archivedAt !== null) {
      throw unprocessable('job_type_unknown', 'This job type does not exist or is archived.', [
        {
          field: 'body.jobTypeId',
          code: 'job_type_unknown',
          message: 'Choose a current job type.',
        },
      ]);
    }
  }
  if (input.contractId != null) {
    const contract = await tx.contracts.find(input.contractId);
    if (contract?.customerId !== customerId || contract.cancelledAt !== null) {
      throw unprocessable(
        'contract_not_customers',
        'Choose one of the asset’s customer’s current contracts.',
        [
          {
            field: 'body.contractId',
            code: 'contract_not_customers',
            message: 'Choose one of the customer’s current contracts.',
          },
        ],
      );
    }
  }
}

function datesInOrder(startsOn: string, endsOn: string | null | undefined) {
  if (endsOn != null && endsOn < startsOn) {
    throw unprocessable(
      'maintenance_plan_dates_reversed',
      'The end date must be on or after the start.',
      [
        {
          field: 'body.endsOn',
          code: 'maintenance_plan_dates_reversed',
          message: 'Choose a later end date.',
        },
      ],
    );
  }
}

// ---------------------------------------------------------------------------

export const listMaintenancePlansRoute = defineRoute({
  method: 'get',
  path: '/v1/maintenance-plans',
  operationId: 'listMaintenancePlans',
  summary: 'Maintenance plans',
  description:
    'Soonest next due date first. For one asset, customer, site or contract; ended ones only with `includeEnded`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.read',
  feature: ASSETS,
  params: noSchema,
  query: z.object({
    assetId: z.uuid().optional(),
    customerId: z.uuid().optional(),
    siteId: z.uuid().optional(),
    contractId: z.uuid().optional(),
    includeEnded: booleanQuery,
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'The plans.',
      schema: z.object({
        items: z.array(planSchema),
        defaults: z.object({ leadDays: z.number().int(), windowDays: z.number().int() }),
        can: z.object({ manage: z.boolean() }),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const plans = await tx.maintenance.listPlans({
        ...(query.assetId === undefined ? {} : { assetId: query.assetId }),
        ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
        ...(query.siteId === undefined ? {} : { siteId: query.siteId }),
        ...(query.contractId === undefined ? {} : { contractId: query.contractId }),
        includeEnded: query.includeEnded === 'true',
      });
      return {
        items: await planBodies(tx, plans),
        defaults: { leadDays: DEFAULT_PLAN_LEAD_DAYS, windowDays: DEFAULT_PLAN_WINDOW_DAYS },
        can: { manage: holds(context.principal, 'asset.manage') },
      };
    });
    return { status: 200, body };
  },
});

export const createMaintenancePlanRoute = defineRoute({
  method: 'post',
  path: '/v1/maintenance-plans',
  operationId: 'createMaintenancePlan',
  summary: 'Add a maintenance plan to an asset',
  description:
    'Due dates before today are not made. The first job is made `leadDays` before the first due date, by the worker’s next daily run.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.manage',
  feature: ASSETS,
  params: noSchema,
  query: noSchema,
  body: planInputSchema.extend({ assetId: z.uuid() }),
  responses: {
    201: { description: 'The plan.', schema: planSchema },
    409: { description: 'The asset is retired (`asset_retired`).' },
    422: {
      description:
        'Unknown job type, a contract that is not the asset’s customer’s, or reversed dates.',
    },
  },
  handler: async ({ body }, context) => {
    const created = await withTenant(context.principal.tenantId, async (tx) => {
      const asset = await tx.assets.find(body.assetId);
      if (asset === undefined) {
        throw unprocessable('asset_unknown', 'This asset does not exist.', [
          { field: 'body.assetId', code: 'not_found', message: 'Choose an asset.' },
        ]);
      }
      if (asset.status === 'retired') {
        throw conflict('asset_retired', 'This asset is retired.');
      }
      await checkPlanParts(tx, asset.customerId, body);
      datesInOrder(body.startsOn, body.endsOn);
      const { timezone } = await tx.settings.get();
      const today = dayIn(new Date(), timezone);
      const plan = await tx.maintenance.createPlan(
        body,
        nextDueFor({ ...body, endsOn: body.endsOn ?? null }, today, undefined, timezone),
        context.principal.userId,
      );
      await audit(tx, context, 'maintenance_plan.created', 'maintenance_plan', plan.id, {
        assetId: plan.assetId,
      });
      return planBody(tx, plan);
    });
    return { status: 201, body: created };
  },
});

export const updateMaintenancePlanRoute = defineRoute({
  method: 'patch',
  path: '/v1/maintenance-plans/:planId',
  operationId: 'updateMaintenancePlan',
  summary: 'Change a maintenance plan',
  description:
    'Only what has not been made yet moves: jobs already made or completed keep their dates.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.manage',
  feature: ASSETS,
  params: planParams,
  query: noSchema,
  body: planInputSchema.partial().extend({ expectedVersion: z.number().int().min(1) }),
  responses: {
    200: { description: 'The plan.', schema: planSchema },
    404: { description: 'No such plan.' },
    409: { description: 'Changed elsewhere, or ended.' },
    422: { description: 'As for adding one.' },
  },
  handler: async ({ params, body }, context) => {
    const updated = await withTenant(context.principal.tenantId, async (tx) => {
      const current = await tx.maintenance.findPlan(params.planId);
      if (current === undefined) {
        throw notFound('This maintenance plan does not exist.');
      }
      const { expectedVersion, ...changes } = body;
      await checkPlanParts(tx, current.customerId, changes);
      const merged = {
        counting: changes.counting ?? current.counting,
        startsOn: changes.startsOn ?? current.startsOn,
        endsOn: changes.endsOn === undefined ? current.endsOn : changes.endsOn,
        intervalCount: changes.intervalCount ?? current.intervalCount,
        intervalUnit: changes.intervalUnit ?? current.intervalUnit,
      };
      datesInOrder(merged.startsOn, merged.endsOn);
      const scheduleChanged = (
        ['counting', 'startsOn', 'endsOn', 'intervalCount', 'intervalUnit'] as const
      ).some((key) => changes[key] !== undefined && changes[key] !== current[key]);
      let next: NextDue | undefined;
      if (scheduleChanged && current.status === 'active') {
        const { timezone } = await tx.settings.get();
        const last = (await tx.maintenance.lastOccurrences([current.id])).get(current.id);
        next = nextDueFor(merged, dayIn(new Date(), timezone), last, timezone);
      }
      const result = await tx.maintenance.updatePlan(current.id, expectedVersion, changes, next);
      if (result.outcome !== 'written') {
        planRefusal(result);
      }
      await audit(tx, context, 'maintenance_plan.updated', 'maintenance_plan', current.id, {
        fields: Object.keys(changes),
      });
      return planBody(tx, result.plan);
    });
    return { status: 200, body: updated };
  },
});

export const setMaintenancePlanStatusRoute = defineRoute({
  method: 'post',
  path: '/v1/maintenance-plans/:planId/status',
  operationId: 'setMaintenancePlanStatus',
  summary: 'Pause, resume or end a maintenance plan',
  description:
    'A paused plan makes no jobs; resuming carries on from today, without making the dates missed while paused. Ending is final.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.manage',
  feature: ASSETS,
  params: planParams,
  query: noSchema,
  body: z.object({
    expectedVersion: z.number().int().min(1),
    status: z.enum(PLAN_STATUSES),
  }),
  responses: {
    200: { description: 'The plan.', schema: planSchema },
    404: { description: 'No such plan.' },
    409: { description: 'Changed elsewhere, or ended.' },
  },
  handler: async ({ params, body }, context) => {
    const updated = await withTenant(context.principal.tenantId, async (tx) => {
      const current = await tx.maintenance.findPlan(params.planId);
      if (current === undefined) {
        throw notFound('This maintenance plan does not exist.');
      }
      let next: NextDue | undefined;
      if (body.status === 'active' && current.status === 'paused') {
        const { timezone } = await tx.settings.get();
        const today = dayIn(new Date(), timezone);
        const last = (await tx.maintenance.lastOccurrences([current.id])).get(current.id);
        next = nextDueFor(current, today, last, timezone);
        if (next.nextDueOn !== null && current.counting === 'completion') {
          next = { ...next, nextDueOn: laterDay(next.nextDueOn, today) };
        }
      }
      const result = await tx.maintenance.setStatus(
        current.id,
        body.expectedVersion,
        body.status,
        context.principal.userId,
        next,
      );
      if (result.outcome !== 'written') {
        planRefusal(result);
      }
      await audit(tx, context, `maintenance_plan.${body.status}`, 'maintenance_plan', current.id);
      return planBody(tx, result.plan);
    });
    return { status: 200, body: updated };
  },
});

const maintenanceItemSchema = z.object({
  /** The occurrence's id, or `planId:dueOn` for one not made yet. */
  key: z.string(),
  plan: z.object({ id: z.uuid(), title: z.string() }),
  asset: z.object({ id: z.uuid(), name: z.string(), reference: z.string() }),
  customer: z.object({ id: z.uuid(), name: z.string() }),
  site: z.object({ id: z.uuid(), name: z.string() }),
  jobType: z.object({ id: z.uuid(), name: z.string() }),
  dueOn: z.string(),
  standing: z.enum(MAINTENANCE_STANDINGS),
  skipReason: z.string().nullable(),
  workOrder: z
    .object({
      id: z.uuid(),
      reference: z.string(),
      state: z.string(),
      completedAt: z.string().nullable(),
    })
    .nullable(),
});

export const listMaintenanceRoute = defineRoute({
  method: 'get',
  path: '/v1/maintenance',
  operationId: 'listMaintenance',
  summary: 'Upcoming, made, completed and overdue maintenance',
  description:
    'Every due date between `from` and `to` (at most 400 days apart): those already made or passed over, and — from today on — those the active plans will make. Defaults to the last 30 days and the next 90.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'asset.read',
  feature: ASSETS,
  params: noSchema,
  query: z.object({
    from: calendarDaySchema.optional(),
    to: calendarDaySchema.optional(),
    customerId: z.uuid().optional(),
    siteId: z.uuid().optional(),
    jobTypeId: z.uuid().optional(),
    assetId: z.uuid().optional(),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'The maintenance.',
      schema: z.object({
        items: z.array(maintenanceItemSchema),
        from: z.string(),
        to: z.string(),
        /** Today in the company's time zone, which standings are judged against. */
        today: z.string(),
      }),
    },
    422: { description: 'The range is reversed or too long (`maintenance_range_invalid`).' },
  },
  handler: async ({ query }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const { timezone } = await tx.settings.get();
      const today = dayIn(new Date(), timezone);
      const from = query.from ?? addDays(today, -30);
      const to = query.to ?? addDays(today, 90);
      if (to < from || addDays(from, 400) < to) {
        throw unprocessable('maintenance_range_invalid', 'Choose a range of at most 400 days.', [
          {
            field: 'query.to',
            code: 'maintenance_range_invalid',
            message: 'Choose a range of at most 400 days.',
          },
        ]);
      }
      const filter = {
        ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
        ...(query.siteId === undefined ? {} : { siteId: query.siteId }),
        ...(query.jobTypeId === undefined ? {} : { jobTypeId: query.jobTypeId }),
        ...(query.assetId === undefined ? {} : { assetId: query.assetId }),
      };
      const [occurrences, plans] = await Promise.all([
        tx.maintenance.listOccurrences({ from, to, ...filter, limit: 2000 }),
        to < today ? Promise.resolve([]) : tx.maintenance.listPlans(filter),
      ]);
      const active = plans.filter((plan) => plan.status === 'active');
      const contracts = await tx.contracts.findMany(
        active.map((plan) => plan.contractId).filter((id): id is string => id !== null),
      );
      const contractEnd = new Map(
        contracts.map((contract) => [contract.id, contractLastDay(contract)]),
      );
      const [customers, sites, jobTypes] = await Promise.all([
        tx.customers.findMany([
          ...occurrences.map((row) => row.customerId),
          ...active.map((plan) => plan.customerId),
        ]),
        tx.sites.findMany([
          ...occurrences.map((row) => row.siteId),
          ...active.map((plan) => plan.siteId),
        ]),
        tx.jobTypes.list({ includeArchived: true }),
      ]);
      const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));
      const siteName = new Map(sites.map((site) => [site.id, site.name]));
      const typeName = new Map(jobTypes.map((type) => [type.id, type.name]));

      const items: z.infer<typeof maintenanceItemSchema>[] = occurrences.map((row) => ({
        key: row.id,
        plan: { id: row.planId, title: row.planTitle },
        asset: {
          id: row.assetId,
          name: row.assetName,
          reference: formatAssetReference(row.assetReference),
        },
        customer: { id: row.customerId, name: customerName.get(row.customerId) ?? '' },
        site: { id: row.siteId, name: siteName.get(row.siteId) ?? '' },
        jobType: { id: row.jobTypeId, name: typeName.get(row.jobTypeId) ?? '' },
        dueOn: row.dueOn,
        standing:
          row.status === 'skipped'
            ? 'skipped'
            : maintenanceStanding({
                jobState: row.jobState ?? undefined,
                dueByDay: row.dueBy === null ? row.dueOn : dayIn(row.dueBy, timezone),
                today,
              }),
        skipReason: row.skipReason,
        workOrder:
          row.workOrderId === null || row.workOrderReference === null
            ? null
            : {
                id: row.workOrderId,
                reference: formatWorkOrderReference(row.workOrderReference),
                state: row.jobState ?? 'scheduled',
                completedAt: isoOrNull(row.completedAt),
              },
      }));

      for (const plan of active) {
        const end = plan.contractId === null ? undefined : contractEnd.get(plan.contractId);
        const dues = forecastDues(
          {
            counting: plan.counting,
            interval: { count: plan.intervalCount, unit: plan.intervalUnit },
            startsOn: plan.startsOn,
            endsOn:
              end === undefined
                ? plan.endsOn
                : plan.endsOn === null || end < plan.endsOn
                  ? end
                  : plan.endsOn,
            nextDueOn: plan.nextDueOn,
            nextSequence: plan.nextSequence,
          },
          laterDay(from, today),
          to,
          120,
        );
        for (const dueOn of dues) {
          items.push({
            key: `${plan.id}:${dueOn}`,
            plan: { id: plan.id, title: plan.title },
            asset: {
              id: plan.assetId,
              name: plan.assetName,
              reference: formatAssetReference(plan.assetReference),
            },
            customer: { id: plan.customerId, name: customerName.get(plan.customerId) ?? '' },
            site: { id: plan.siteId, name: siteName.get(plan.siteId) ?? '' },
            jobType: { id: plan.jobTypeId, name: typeName.get(plan.jobTypeId) ?? '' },
            dueOn,
            standing: 'upcoming',
            skipReason: null,
            workOrder: null,
          });
        }
      }
      items.sort(
        (a, b) => a.dueOn.localeCompare(b.dueOn) || a.plan.title.localeCompare(b.plan.title),
      );
      return { items, from, to, today };
    });
    return { status: 200, body };
  },
});

export const maintenanceRoutes = [
  listMaintenancePlansRoute,
  createMaintenancePlanRoute,
  updateMaintenancePlanRoute,
  setMaintenancePlanStatusRoute,
  listMaintenanceRoute,
];
