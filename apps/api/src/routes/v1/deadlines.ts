import {
  addDays,
  calendarDaySchema,
  complianceSummary,
  type ComplianceJob,
  DEADLINE_CLOCKS,
  DEADLINE_MINUTES_MAX,
  DEADLINE_WARN_MINUTES_MAX,
  DEFAULT_DEADLINE_WARN_MINUTES,
  formatWorkOrderReference,
  holds,
  WORK_ORDER_PRIORITIES,
  workOrderPrioritySchema,
  zonedInstant,
} from '@integr8/core';
import type { DeadlineReportRow, StoredDeadlineRule } from '@integr8/db';
import { withTenant } from '@integr8/db';
import { z } from 'zod';
import { unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { crmAudit as audit } from './crm-shared.js';
import { companyToday } from './sales-quotes.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Response deadlines (P27).
 *
 * The company sets, per priority, how long it has to respond to a job (to
 * dispatch it) and to complete it, counted around the clock or in working
 * hours only. Owners and admins set the rules (`job_type.manage`); anyone who
 * sees every job sees the report (`work_order.read_all`).
 */

const TAGS = ['deadlines'];

const ruleSchema = z.object({
  priority: workOrderPrioritySchema,
  /** Minutes from creation to first dispatch; null for no response deadline. */
  responseMinutes: z.number().int().nullable(),
  /** Minutes from creation to completion; null for no completion deadline. */
  completionMinutes: z.number().int().nullable(),
  clock: z.enum(DEADLINE_CLOCKS),
  warnMinutes: z.number().int(),
});

const rulesBodySchema = z.object({
  /** One per priority that has deadlines, most urgent first. */
  rules: z.array(ruleSchema.extend({ updatedAt: z.string() })),
  /** The company's working week, which `working_hours` rules count. */
  workingHours: z.object({
    timeZone: z.string(),
    startsMinute: z.number().int(),
    endsMinute: z.number().int(),
    days: z.array(z.number().int()),
  }),
  defaults: z.object({ warnMinutes: z.number().int() }),
  can: z.object({ manage: z.boolean() }),
});

function ruleBody(rule: StoredDeadlineRule) {
  return {
    priority: rule.priority,
    responseMinutes: rule.responseMinutes,
    completionMinutes: rule.completionMinutes,
    clock: rule.clock,
    warnMinutes: rule.warnMinutes,
    updatedAt: iso(rule.updatedAt),
  };
}

export const getDeadlineRulesRoute = defineRoute({
  method: 'get',
  path: '/v1/deadline-rules',
  operationId: 'getDeadlineRules',
  summary: 'The company’s response and completion deadlines',
  description: 'A priority with no rule has no deadlines.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.read_all',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'The rules.', schema: rulesBodySchema } },
  handler: async (_request, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const [rules, hours] = await Promise.all([
        tx.deadlines.listRules(),
        tx.deadlines.workingHours(),
      ]);
      return {
        rules: rules.map(ruleBody),
        workingHours: { ...hours, days: [...hours.days] },
        defaults: { warnMinutes: DEFAULT_DEADLINE_WARN_MINUTES },
        can: { manage: holds(context.principal, 'job_type.manage') },
      };
    });
    return { status: 200, body };
  },
});

export const replaceDeadlineRulesRoute = defineRoute({
  method: 'put',
  path: '/v1/deadline-rules',
  operationId: 'replaceDeadlineRules',
  summary: 'Set the company’s deadlines',
  description:
    'Replaces every rule. A priority left out has no deadlines. Jobs already created keep the deadlines they were given; new jobs, and jobs whose priority changes, get the new ones.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'job_type.manage',
  params: noSchema,
  query: noSchema,
  body: z.object({
    rules: z
      .array(
        z
          .object({
            priority: workOrderPrioritySchema,
            responseMinutes: z.number().int().min(1).max(DEADLINE_MINUTES_MAX).nullable(),
            completionMinutes: z.number().int().min(1).max(DEADLINE_MINUTES_MAX).nullable(),
            clock: z.enum(DEADLINE_CLOCKS),
            warnMinutes: z.number().int().min(0).max(DEADLINE_WARN_MINUTES_MAX),
          })
          .refine(
            (rule) => rule.responseMinutes !== null || rule.completionMinutes !== null,
            'Set a response time, a completion time, or both',
          )
          .refine(
            (rule) =>
              rule.responseMinutes === null ||
              rule.completionMinutes === null ||
              rule.completionMinutes >= rule.responseMinutes,
            'Completion cannot be due before response',
          ),
      )
      .max(WORK_ORDER_PRIORITIES.length)
      .refine(
        (rules) => new Set(rules.map((rule) => rule.priority)).size === rules.length,
        'One rule per priority',
      ),
  }),
  responses: { 200: { description: 'The rules.', schema: rulesBodySchema } },
  handler: async ({ body }, context) => {
    const saved = await withTenant(context.principal.tenantId, async (tx) => {
      const rules = await tx.deadlines.replaceRules(body.rules, context.principal.userId);
      await audit(
        tx,
        context,
        'deadline_rules.updated',
        'tenant_settings',
        context.principal.tenantId,
        {
          priorities: body.rules.map((rule) => rule.priority),
        },
      );
      const hours = await tx.deadlines.workingHours();
      return {
        rules: rules.map(ruleBody),
        workingHours: { ...hours, days: [...hours.days] },
        defaults: { warnMinutes: DEFAULT_DEADLINE_WARN_MINUTES },
        can: { manage: true },
      };
    });
    return { status: 200, body: saved };
  },
});

const summarySchema = z.object({
  jobs: z.number().int(),
  responseDue: z.number().int(),
  respondedOnTime: z.number().int(),
  completionDue: z.number().int(),
  completedOnTime: z.number().int(),
  missed: z.number().int(),
  averageResponseMinutes: z.number().int().nullable(),
});

const missSchema = z.object({
  workOrder: z.object({
    id: z.uuid(),
    reference: z.string(),
    title: z.string(),
    state: z.string(),
  }),
  customer: z.object({ id: z.uuid(), name: z.string() }),
  kind: z.enum(['response', 'completion']),
  priority: workOrderPrioritySchema,
  dueAt: z.string(),
  /** Null when it was never met. */
  metAt: z.string().nullable(),
  recordedAt: z.string(),
});

function complianceOf(row: DeadlineReportRow): ComplianceJob {
  return {
    responseDueAt: row.responseDueAt,
    respondedAt: row.respondedAt,
    completionDueAt: row.completionDueAt,
    completedAt: row.completedAt,
    responseMissed: row.responseMissedAt !== null,
    completionMissed: row.completionMissedAt !== null,
    createdAt: row.createdAt,
  };
}

export const deadlineReportRoute = defineRoute({
  method: 'get',
  path: '/v1/deadline-report',
  operationId: 'getDeadlineReport',
  summary: 'How the company did against its deadlines',
  description:
    'Jobs with deadlines created between `from` and `to` (company days, inclusive; at most 366 days; the last 30 days by default): the totals, the totals per customer, and every recorded miss.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.read_all',
  params: noSchema,
  query: z.object({
    from: calendarDaySchema.optional(),
    to: calendarDaySchema.optional(),
    customerId: z.uuid().optional(),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'The report.',
      schema: z.object({
        from: z.string(),
        to: z.string(),
        totals: summarySchema,
        customers: z.array(
          z.object({
            customer: z.object({ id: z.uuid(), name: z.string() }),
            summary: summarySchema,
          }),
        ),
        misses: z.array(missSchema),
      }),
    },
    422: { description: 'The range is reversed or too long (`deadline_range_invalid`).' },
  },
  handler: async ({ query }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const today = await companyToday(tx);
      const from = query.from ?? addDays(today, -29);
      const to = query.to ?? today;
      if (to < from || addDays(from, 366) < to) {
        throw unprocessable('deadline_range_invalid', 'Choose a range of at most a year.', [
          {
            field: 'query.to',
            code: 'deadline_range_invalid',
            message: 'Choose a range of at most a year.',
          },
        ]);
      }
      const { timezone } = await tx.settings.get();
      const rows = await tx.deadlines.report({
        from: zonedInstant(from, 0, timezone),
        to: zonedInstant(addDays(to, 1), 0, timezone),
        ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
      });
      const customers = await tx.customers.findMany([
        ...new Set(rows.map((row) => row.customerId)),
      ]);
      const customerName = new Map(customers.map((customer) => [customer.id, customer.name]));
      const byCustomer = new Map<string, DeadlineReportRow[]>();
      for (const row of rows) {
        byCustomer.set(row.customerId, [...(byCustomer.get(row.customerId) ?? []), row]);
      }
      const misses = rows.flatMap((row) => {
        const base = {
          workOrder: {
            id: row.workOrderId,
            reference: formatWorkOrderReference(row.reference),
            title: row.title,
            state: row.state,
          },
          customer: { id: row.customerId, name: customerName.get(row.customerId) ?? '' },
          priority: row.priority,
        };
        return [
          ...(row.responseMissedAt === null || row.responseDueAt === null
            ? []
            : [
                {
                  ...base,
                  kind: 'response' as const,
                  dueAt: iso(row.responseDueAt),
                  metAt: isoOrNull(row.respondedAt),
                  recordedAt: iso(row.responseMissedAt),
                },
              ]),
          ...(row.completionMissedAt === null || row.completionDueAt === null
            ? []
            : [
                {
                  ...base,
                  kind: 'completion' as const,
                  dueAt: iso(row.completionDueAt),
                  metAt: isoOrNull(row.completedAt),
                  recordedAt: iso(row.completionMissedAt),
                },
              ]),
        ];
      });
      return {
        from,
        to,
        totals: complianceSummary(rows.map(complianceOf)),
        customers: [...byCustomer.entries()]
          .map(([customerId, list]) => ({
            customer: { id: customerId, name: customerName.get(customerId) ?? '' },
            summary: complianceSummary(list.map(complianceOf)),
          }))
          .sort(
            (a, b) =>
              b.summary.missed - a.summary.missed || a.customer.name.localeCompare(b.customer.name),
          ),
        misses: misses.sort((a, b) => b.dueAt.localeCompare(a.dueAt)),
      };
    });
    return { status: 200, body };
  },
});

export const deadlineRoutes = [
  getDeadlineRulesRoute,
  replaceDeadlineRulesRoute,
  deadlineReportRoute,
];
