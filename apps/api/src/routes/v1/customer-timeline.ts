import { holds, type Principal } from '@integr8/core';
import { TIMELINE_SOURCES, type TimelineSource, withTenant } from '@integr8/db';
import { z } from 'zod';
import { notFound } from '../../http/errors.js';
import { isFeatureEnabled } from '../../http/features.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { iso } from './schemas.js';

/**
 * Customer 360's timeline (eighth round; ADR-0012): one customer's activities,
 * job events, submitted forms and documents, newest first, read-only. Each
 * source appears only to a seat that may read it, with its module on.
 */

const TIMELINE_KINDS = [
  'activity',
  'job_event',
  'submission',
  'quote_issued',
  'quote_answered',
  'order_confirmed',
  'invoice_issued',
  'invoice_voided',
  'payment_received',
] as const;

const entrySchema = z.object({
  kind: z.enum(TIMELINE_KINDS),
  at: z.iso.datetime(),
  recordId: z.uuid(),
  reference: z.number().int().nullable(),
  title: z.string().nullable(),
  /** An activity's kind, a job event's kind, a quote's answer, or a payment's amount and currency. */
  detail: z.string().nullable(),
  workOrderId: z.uuid().nullable(),
});

/** What this seat may see on the timeline. */
async function sourcesFor(principal: Principal): Promise<TimelineSource[]> {
  const [crm, sales, finance] = await Promise.all([
    isFeatureEnabled(principal.tenantId, 'crm'),
    isFeatureEnabled(principal.tenantId, 'sales'),
    isFeatureEnabled(principal.tenantId, 'finance'),
  ]);
  return TIMELINE_SOURCES.filter((source) => {
    switch (source) {
      case 'activities':
        return crm && holds(principal, 'crm.read');
      case 'jobs':
        return holds(principal, 'work_order.read_all');
      case 'submissions':
        return holds(principal, 'submission.read_all');
      case 'sales':
        return sales && holds(principal, 'sales.read');
      case 'finance':
        return finance && holds(principal, 'finance.read');
    }
  });
}

function encodeCursor(next: { at: string; key: string } | undefined): string | null {
  return next === undefined
    ? null
    : Buffer.from(JSON.stringify(next), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): { at: string; key: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    const parsed = z
      .object({ at: z.iso.datetime(), key: z.string().max(200) })
      .safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export const customerTimelineRoute = defineRoute({
  method: 'get',
  path: '/v1/customers/:customerId/timeline',
  operationId: 'getCustomerTimeline',
  summary: 'A customer’s history: activities, jobs, forms and documents, newest first',
  description:
    'Each source shows only to a seat that may read it, with its module on: activities (`crm.read`), job events (`work_order.read_all`), submitted forms (`submission.read_all`), quotes and orders (`sales.read`), invoices and payments (`finance.read`). `sources` narrows it further. `sources` in the answer says what was included.',
  tags: ['customers'],
  security: 'authenticated',
  permission: 'customer.read',
  params: z.object({ customerId: z.uuid() }),
  query: z.object({
    sources: z
      .union([z.enum(TIMELINE_SOURCES), z.array(z.enum(TIMELINE_SOURCES))])
      .optional()
      .transform((value) => (value === undefined ? undefined : [value].flat())),
    cursor: z.string().max(400).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page.',
      schema: z.object({
        items: z.array(entrySchema),
        nextCursor: z.string().nullable(),
        sources: z.array(z.enum(TIMELINE_SOURCES)),
      }),
    },
    404: { description: 'No such customer.' },
  },
  handler: async ({ params, query }, context) => {
    const { principal } = context;
    const allowed = await sourcesFor(principal);
    const sources =
      query.sources === undefined
        ? allowed
        : allowed.filter((source) => query.sources?.includes(source));
    const body = await withTenant(principal.tenantId, async (tx) => {
      if ((await tx.customers.find(params.customerId)) === undefined) {
        throw notFound('No such customer.');
      }
      const page = await tx.customerTimeline.entries(params.customerId, {
        sources,
        before: decodeCursor(query.cursor),
        limit: query.limit,
      });
      return {
        items: page.items.map((entry) => ({
          kind: entry.kind,
          at: iso(entry.at),
          recordId: entry.recordId,
          reference: entry.reference,
          title: entry.title,
          detail: entry.detail,
          workOrderId: entry.workOrderId,
        })),
        nextCursor: encodeCursor(page.next),
        sources,
      };
    });
    return { status: 200, body };
  },
});
