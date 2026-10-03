import { SYNC_OUTCOMES, SYNC_TRIGGERS, withTenant } from '@integr8/db';
import { z } from 'zod';
import { defineRoute, noSchema } from '../../http/routes.js';
import { pullPage } from '../../sync/pull.js';
import { applyMutations, mutationSchema, resultSchema } from '../../sync/push.js';
import { customerDetailSchema } from './customers.js';
import { formDetailSchema } from './forms.js';
import { answersSchema } from './submissions.js';
import { shiftSchema } from './time.js';
import { detailSchema as workOrderDetailSchema } from './work-orders.js';

/**
 * Offline sync for the mobile app (P12).
 *
 * - `GET  /v1/sync/pull`    — what changed for this person since a cursor.
 * - `POST /v1/sync/push`    — what the phone did offline, applied once each, in order.
 * - `POST /v1/sync/reports` — how sync is going on the phone.
 *
 * Every response carries the server's time, so a phone can measure how far its
 * own clock is out and never has to trust it.
 */

const TAGS = ['sync'];

const submissionSyncSchema = z.object({
  id: z.uuid(),
  formId: z.uuid(),
  formVersionId: z.uuid(),
  workOrderId: z.uuid().nullable(),
  status: z.enum(['draft', 'submitted', 'reopened']),
  revision: z.number().int(),
  answers: answersSchema,
  submittedBy: z.object({ id: z.uuid(), name: z.string() }),
  submittedAt: z.string().nullable(),
  updatedAt: z.string(),
});

export const pullRoute = defineRoute({
  method: 'get',
  path: '/v1/sync/pull',
  operationId: 'syncPull',
  summary: 'What changed for me since my last pull',
  description:
    'Only the caller’s own work: jobs they are on, open or closed within `retentionDays`, with their customers, forms and the caller’s submissions. Pass the last `cursor`; follow `page` until it is null, then keep the final `cursor`. `reset` means this is everything in scope, so anything not included should be removed; otherwise `removedWorkOrderIds` lists jobs the caller was taken off.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: noSchema,
  query: z.object({
    cursor: z.string().max(40).optional(),
    page: z.string().max(400).optional(),
    retentionDays: z.coerce.number().int().min(1).max(90).default(30),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of changes.',
      schema: z.object({
        reset: z.boolean(),
        cursor: z.string().nullable(),
        page: z.string().nullable(),
        serverTime: z.string(),
        workOrders: z.array(workOrderDetailSchema),
        removedWorkOrderIds: z.array(z.uuid()),
        customers: z.array(customerDetailSchema),
        forms: z.array(formDetailSchema),
        submissions: z.array(submissionSyncSchema),
        /** The caller's shifts from the last day and a half, on the first page only (P14). */
        shifts: z.array(shiftSchema),
      }),
    },
    422: { description: 'A cursor or page token the server did not issue.' },
  },
  handler: async ({ query }, context) => {
    const body = await withTenant(context.principal.tenantId, (tx) =>
      pullPage(tx, context.principal, {
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.page === undefined ? {} : { page: query.page }),
        retentionDays: query.retentionDays,
        now: new Date(),
      }),
    );
    return { status: 200, body };
  },
});

export const pushRoute = defineRoute({
  method: 'post',
  path: '/v1/sync/push',
  operationId: 'syncPush',
  summary: 'Apply changes made offline',
  description:
    'Each change has an id chosen by the phone and is applied at most once: sending it again returns the stored result. Changes are applied in order; when one is not applied, later changes to the same record in this batch come back as `retry`. `conflict` carries both versions for the engineer to decide; `rejected` will not succeed if sent again.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  bodyLimit: 5 * 1024 * 1024,
  params: noSchema,
  query: noSchema,
  body: z.object({
    /** When the phone sent this, by the phone's clock. With each change's `recordedAt`, how long ago it was made. */
    sentAt: z.iso.datetime({ offset: true }),
    mutations: z.array(mutationSchema).min(1).max(50),
  }),
  responses: {
    200: {
      description: 'What happened to each change, in the order sent.',
      schema: z.object({ serverTime: z.string(), results: z.array(resultSchema) }),
    },
  },
  handler: async ({ body }, context) => {
    const received = Date.now();
    const sentAt = Date.parse(body.sentAt);
    // The phone's clock may be hours out, but it measures elapsed time well
    // enough: how long before sending something happened, subtracted from when
    // the server received it. Never in the future, and never before a month ago.
    const phoneTime = (at: string) => {
      const age = Math.max(0, sentAt - Date.parse(at));
      return new Date(received - Math.min(age, 31 * 24 * 60 * 60 * 1000));
    };
    const results = await applyMutations(body.mutations, {
      context,
      recordedAt: (mutation) => phoneTime(mutation.recordedAt),
      phoneTime,
    });
    return { status: 200, body: { serverTime: new Date().toISOString(), results } };
  },
});

const reportSchema = z.object({
  reportId: z.uuid(),
  /** Already corrected by the phone's measured clock offset. */
  startedAt: z.iso.datetime({ offset: true }),
  durationMs: z
    .number()
    .int()
    .min(0)
    .max(24 * 60 * 60 * 1000),
  trigger: z.enum(SYNC_TRIGGERS),
  outcome: z.enum(SYNC_OUTCOMES),
  pushed: z.number().int().min(0),
  conflicts: z.number().int().min(0),
  rejected: z.number().int().min(0),
  retried: z.number().int().min(0),
  pulled: z.number().int().min(0),
  uploadsCompleted: z.number().int().min(0),
  uploadsFailed: z.number().int().min(0),
  uploadedBytes: z.number().int().min(0),
  queueDepth: z.number().int().min(0),
  pendingUploads: z.number().int().min(0),
  networkType: z.string().max(40).nullable(),
  clockOffsetMs: z.number().int().nullable(),
  appVersion: z.string().max(40).nullable(),
});

export const reportsRoute = defineRoute({
  method: 'post',
  // Telemetry about a sync run, not the company's data — and while a company
  // is read-only it is the one signal that says their phones are stuck (P17).
  allowedWhenReadOnly: true,
  path: '/v1/sync/reports',
  operationId: 'syncReports',
  summary: 'Report how sync went on this phone',
  description:
    'Duration, what moved, what is still waiting, the network and the measured clock offset, one entry per sync run. Each report has an id, so resending one stores it once.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'customer.read',
  params: noSchema,
  query: noSchema,
  body: z.object({ reports: z.array(reportSchema).min(1).max(100) }),
  responses: {
    200: {
      description: 'How many were new.',
      schema: z.object({ recorded: z.number().int(), duplicates: z.number().int() }),
    },
  },
  handler: async ({ body }, context) => {
    const now = Date.now();
    const outcome = await withTenant(context.principal.tenantId, async (tx) => {
      let recorded = 0;
      for (const report of body.reports) {
        const started = Date.parse(report.startedAt);
        // A report from a phone whose correction went wrong is kept, dated when it arrived.
        const plausible =
          started <= now + 5 * 60 * 1000 && started >= now - 31 * 24 * 60 * 60 * 1000;
        const stored = await tx.sync.recordReport({
          ...report,
          userId: context.principal.userId,
          startedAt: new Date(plausible ? started : now),
        });
        if (stored === 'recorded') {
          recorded += 1;
        }
      }
      return { recorded, duplicates: body.reports.length - recorded };
    });
    return { status: 200, body: outcome };
  },
});

export const syncRoutes = [pullRoute, pushRoute, reportsRoute];
