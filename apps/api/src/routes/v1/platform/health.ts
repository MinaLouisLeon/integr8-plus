import { getPlatformDataSource } from '@integr8/db';
import { z } from 'zod';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { iso } from '../schemas.js';

/**
 * What is failing quietly, in one place (P19).
 *
 * Three things the review found going wrong without anybody being told: a
 * phone that cannot get its work to the server, a billing delivery that was
 * recorded but not applied, and background work that gave up. Each has a table
 * that knows; none had a screen. This is that screen's data, over a window.
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

const webhookEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  tenantId: z.string().nullable(),
  receivedAt: z.string(),
  processedAt: z.string().nullable(),
  outcome: z.enum(['applied', 'failed', 'unmatched', 'pending']),
  error: z.string().nullable(),
});

const healthSchema = z.object({
  since: z.string(),
  sync: z.object({ items: z.array(syncTroubleSchema) }),
  webhooks: z.object({
    received: z.number().int(),
    applied: z.number().int(),
    failed: z.number().int(),
    unmatched: z.number().int(),
    pending: z.number().int(),
    items: z.array(webhookEventSchema),
  }),
  jobs: z.object({ deadLettered: z.number().int(), retrying: z.number().int() }),
});

type WebhookOutcome = z.infer<typeof webhookEventSchema>['outcome'];

/**
 * What became of a recorded delivery.
 *
 * Read from the row's own columns rather than from the wording of its error,
 * because the wording is written for a person and changes; the columns do not.
 * A delivery with no company is unmatched whatever else is true of it, because
 * it is the one that cannot be fixed by retrying.
 */
function webhookOutcome(event: {
  tenantId: string | null;
  processedAt: Date | null;
  error: string | null;
}): WebhookOutcome {
  if (event.tenantId === null) {
    return 'unmatched';
  }
  if (event.error !== null) {
    return 'failed';
  }
  return event.processedAt === null ? 'pending' : 'applied';
}

export const platformHealthRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/health',
  operationId: 'getPlatformHealth',
  summary: 'What is failing quietly',
  description:
    'Phones whose sync runs show trouble, billing deliveries that were recorded but not applied, and background work that gave up — over the last few days, across every company. The things that look fine from the office until a customer rings.',
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

    const [sync, jobs, events] = await Promise.all([
      platform.health.syncTrouble(since, query.limit),
      platform.health.jobs(since),
      platform.billing.recentEvents(500),
    ]);

    const inWindow = events.filter((event) => event.receivedAt >= since);
    const items = inWindow.slice(0, query.limit).map((event) => ({
      id: event.id,
      type: event.type,
      tenantId: event.tenantId,
      receivedAt: iso(event.receivedAt),
      processedAt: event.processedAt === null ? null : iso(event.processedAt),
      outcome: webhookOutcome(event),
      error: event.error,
    }));
    const count = (outcome: WebhookOutcome) =>
      inWindow.filter((event) => webhookOutcome(event) === outcome).length;

    return {
      status: 200,
      body: {
        since: iso(since),
        sync: {
          items: sync.map((row) => ({ ...row, lastReportAt: iso(row.lastReportAt) })),
        },
        webhooks: {
          received: inWindow.length,
          applied: count('applied'),
          failed: count('failed'),
          unmatched: count('unmatched'),
          pending: count('pending'),
          items,
        },
        jobs,
      },
    };
  },
});

export const platformHealthRoutes = [platformHealthRoute];
