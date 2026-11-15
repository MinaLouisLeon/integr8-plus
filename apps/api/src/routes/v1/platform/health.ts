import { MAX_PLAN_FAILURES } from '@integr8/core';
import { getPlatformDataSource } from '@integr8/db';
import { z } from 'zod';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { iso } from '../schemas.js';

/**
 * What is failing quietly, in one place (P19).
 *
 * Things the review found going wrong without anybody being told: a phone
 * that cannot get its work to the server, background work that gave up, and a
 * maintenance plan the worker cannot make jobs for. Each has a table that
 * knows; none had a screen. This is that screen's data, over a window.
 *
 * Nothing here identifies a person beyond their user id, which the dashboard
 * already shows elsewhere; the point is which phone, not who.
 */

const syncTroubleSchema = z.object({
  tenantId: z.string(),
  userId: z.string(),
  runs: z.number().int(),
  failedRuns: z.number().int(),
  partialRuns: z.number().int(),
  rejected: z.number().int(),
  conflicts: z.number().int(),
  uploadsFailed: z.number().int(),
  queueDepth: z.number().int(),
  pendingUploads: z.number().int(),
  lastOutcome: z.string(),
  lastReportAt: z.string(),
  appVersion: z.string().nullable(),
});

const healthSchema = z.object({
  since: z.string(),
  sync: z.object({ items: z.array(syncTroubleSchema) }),
  jobs: z.object({ deadLettered: z.number().int(), retrying: z.number().int() }),
  /**
   * Maintenance plans the worker could not make jobs for (0063), latest first,
   * whenever they failed: a plan stays here until it succeeds or is edited.
   */
  maintenance: z.object({
    items: z.array(
      z.object({
        tenantId: z.string(),
        companyName: z.string(),
        planId: z.string(),
        title: z.string(),
        error: z.string(),
        failedAt: z.string(),
        failureCount: z.number().int(),
        /** The worker has stopped retrying until someone edits the plan. */
        gaveUp: z.boolean(),
      }),
    ),
  }),
});

export const platformHealthRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/health',
  operationId: 'getPlatformHealth',
  summary: 'What is failing quietly',
  description:
    'Phones whose sync runs show trouble, background work that gave up — over the last few days, across every company — and maintenance plans the worker currently cannot make jobs for. The things that look fine from the office until a customer rings.',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: z.object({
    days: z.coerce.number().int().min(1).max(90).default(7),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  body: noSchema,
  responses: {
    200: { description: 'The window, and what went wrong in it.', schema: healthSchema },
  },
  handler: async ({ query }, context) => {
    void context;
    const since = new Date(Date.now() - query.days * 24 * 60 * 60 * 1000);
    const platform = getPlatformDataSource();

    const [sync, jobs, plans] = await Promise.all([
      platform.health.syncTrouble(since, query.limit),
      platform.health.jobs(since),
      platform.health.maintenanceFailures(query.limit),
    ]);

    return {
      status: 200,
      body: {
        since: iso(since),
        sync: {
          items: sync.map((row) => ({ ...row, lastReportAt: iso(row.lastReportAt) })),
        },
        jobs,
        maintenance: {
          items: plans.map((plan) => ({
            tenantId: plan.tenantId,
            companyName: plan.tenantName,
            planId: plan.planId,
            title: plan.title,
            error: plan.error,
            failedAt: iso(plan.failedAt),
            failureCount: plan.failureCount,
            gaveUp: plan.failureCount >= MAX_PLAN_FAILURES,
          })),
        },
      },
    };
  },
});

export const platformHealthRoutes = [platformHealthRoute];
