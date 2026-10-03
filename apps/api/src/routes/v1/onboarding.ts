import { toUserId } from '@integr8/core';
import { withTenant } from '@integr8/db';
import { z } from 'zod';
import { defineRoute, noSchema } from '../../http/routes.js';

/**
 * The first hour in a new company (P18).
 *
 * The plan is blunt about why this matters more than the landing page:
 * *companies churn in week one because nothing happened, not because the
 * marketing was weak.* So the product has to know what a company has and has
 * not done yet, and say so.
 *
 * **The checklist is computed, never stored.** There is no `has_invited_someone`
 * column anywhere, because a stored flag drifts from the truth the first time
 * somebody removes the only engineer they invited — and then the checklist
 * cheerfully says a step is done that is not. Each step is a count, asked at
 * the moment the screen loads. It costs a handful of cheap queries once a day
 * per company and it cannot be wrong.
 */

const TAGS = ['workspace'];

const stepSchema = z.object({
  key: z.enum(['job_type', 'form', 'member', 'customer', 'submission']),
  done: z.boolean(),
  /** What has been done so far, for a screen that wants to say "2 of 3". */
  count: z.number().int(),
});

const progressSchema = z.object({
  steps: z.array(stepSchema),
  /** True once every step is done. The screen stops nagging. */
  complete: z.boolean(),
  /** Whether sample data is currently loaded, and how much. */
  demo: z.object({
    loaded: z.boolean(),
    customers: z.number().int(),
    sites: z.number().int(),
    workOrders: z.number().int(),
  }),
});

export const firstRunRoute = defineRoute({
  method: 'get',
  path: '/v1/onboarding',
  operationId: 'getOnboardingProgress',
  summary: 'What this company has set up so far',
  description:
    'Computed from what actually exists, not from stored flags: a flag would say "you have invited somebody" long after that person was removed.',
  tags: TAGS,
  security: 'authenticated',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'The checklist.', schema: progressSchema } },
  handler: async (_input, context) => {
    const progress = await withTenant(context.principal.tenantId, async (tx) => {
      const [jobTypes, forms, members, customers, submissions, demo] = await Promise.all([
        tx.jobTypes.list(),
        tx.forms.listForms(),
        tx.tenantUsers.list(),
        tx.customers.list({ limit: 1 }),
        tx.submissions.countSince(new Date(0)),
        tx.demo.counts(),
      ]);

      return {
        jobTypes: jobTypes.length,
        forms: forms.length,
        // The owner does not count as having invited anybody: they were here
        // already, and a checklist that ticks itself teaches nothing.
        members: Math.max(0, members.length - 1),
        customers: customers.items.length,
        submissions,
        demo,
      };
    });

    const steps = [
      { key: 'job_type' as const, count: progress.jobTypes },
      { key: 'form' as const, count: progress.forms },
      { key: 'member' as const, count: progress.members },
      { key: 'customer' as const, count: progress.customers },
      { key: 'submission' as const, count: progress.submissions },
    ].map((step) => ({ ...step, done: step.count > 0 }));

    return {
      status: 200,
      body: {
        steps,
        complete: steps.every((step) => step.done),
        demo: {
          loaded: progress.demo.customers > 0,
          customers: progress.demo.customers,
          sites: progress.demo.sites,
          workOrders: progress.demo.workOrders,
        },
      },
    };
  },
});

const demoSchema = z.object({
  customers: z.number().int(),
  sites: z.number().int(),
  workOrders: z.number().int(),
});

export const loadDemoDataRoute = defineRoute({
  method: 'post',
  path: '/v1/onboarding/demo',
  operationId: 'loadDemoData',
  summary: 'Put some sample data in',
  description:
    'Three customers with a site and a job each, all marked as samples. Loading twice does nothing: a company that already has them gets them back unchanged rather than doubled.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.manage',
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'What is now loaded.', schema: demoSchema } },
  handler: async (_input, context) => {
    const counts = await withTenant(context.principal.tenantId, async (tx) => {
      const jobTypes = await tx.jobTypes.list();
      return tx.demo.load(toUserId(context.principal.userId), jobTypes[0]?.id ?? null);
    });

    return { status: 200, body: counts };
  },
});

export const removeDemoDataRoute = defineRoute({
  method: 'delete',
  path: '/v1/onboarding/demo',
  operationId: 'removeDemoData',
  summary: 'Take the sample data away',
  description:
    'Removes only rows still marked as samples. Anything edited into real work has had that mark cleared and is left alone — which is why the mark lives on the row rather than in a list of ids kept somewhere.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.manage',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: { 200: { description: 'What was removed.', schema: demoSchema } },
  handler: async (_input, context) => {
    const removed = await withTenant(context.principal.tenantId, async (tx) => {
      const counts = await tx.demo.remove();
      await tx.auditLog.append({
        actorKind: 'tenant_user',
        actorId: context.principal.userId,
        actorLabel: context.principal.userId,
        action: 'demo_data.removed',
        resourceType: 'tenant',
        resourceId: context.principal.tenantId,
        metadata: { ...counts },
      });
      return counts;
    });

    return { status: 200, body: removed };
  },
});

export const onboardingRoutes = [firstRunRoute, loadDemoDataRoute, removeDemoDataRoute];
