import { toPlatformUserId, toTenantId } from '@integr8/core';
import {
  getPlatformDataSource,
  type TenantDeletion,
  type TenantExport,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { conflict, notFound } from '../../../http/errors.js';
import { defineRoute, noSchema } from '../../../http/routes.js';
import { forgetTenantStatus } from '../../../http/suspension.js';
import { EXPORT_QUEUE } from '../../../platform/export.js';
import { iso, isoOrNull } from '../schemas.js';
import { recordPlatformAction } from './audit.js';
import { deletionSchema, exportSchema, platformListSchema } from './schemas.js';

/**
 * Taking a company's data out, and taking a company out (P15).
 *
 * The shape of deletion was a decision with four options and one defensible
 * answer: export, wait, then purge. Nothing is removed at the moment somebody
 * clicks; an export is taken first, a schedule is written with a cooling-off
 * period, and cancelling any time before it runs undoes the whole thing. The
 * cost is that a customer who wants their data gone today waits a week for it.
 * The benefit is that the one mistake nobody can undo becomes one that anybody
 * can.
 *
 * The database enforces the order rather than trusting these handlers:
 * `tenant_deletions.export_id` is not null, so a schedule without a finished
 * export cannot be written, and `purge_tenant()` refuses unless a schedule
 * exists and is due.
 */

/** How long a company sits in the bin before its rows are removed. */
export const PURGE_COOLING_OFF_DAYS = 7;

export const startExportRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/companies/:tenantId/exports',
  operationId: 'startCompanyExport',
  summary: 'Export everything this company has',
  description:
    'Queues the export and returns immediately; it can take a while for a busy company. Poll the export or watch the list.',
  tags: ['platform'],
  security: 'platform',
  // Not `idempotent`: the dedupe table is tenant-scoped and a platform request
  // has no tenant to scope it to. Two exports of the same company are wasteful
  // rather than wrong — each is a separate row with its own archive.
  params: z.object({ tenantId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    202: { description: 'The export was queued.', schema: exportSchema },
    404: { description: 'No such company.' },
  },
  handler: async ({ params }, context) => {
    const platform = getPlatformDataSource();
    const tenant = await platform.tenants.findById(params.tenantId);
    if (tenant === undefined) {
      throw notFound(`No company with id ${params.tenantId}`);
    }

    const started = await platform.lifecycle.startExport({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      requestedBy: toPlatformUserId(context.platform.platformUserId),
    });

    // Queued inside the company, because the worker runs every job in that
    // company's connection: an export that read rows as the schema owner would
    // be an export that RLS never checked.
    await withTenant(toTenantId(tenant.id), async (tx) =>
      tx.jobs.enqueue({ queue: EXPORT_QUEUE, payload: { exportId: started.id } }),
    );

    await recordPlatformAction(context, {
      action: 'tenant.export_started',
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      targetKind: 'tenant_export',
      targetId: started.id,
    });

    return { status: 202, body: toExport(started) };
  },
});

export const listExportsRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/companies/:tenantId/exports',
  operationId: 'listCompanyExports',
  summary: 'Exports taken of this company',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The exports, newest first.', schema: platformListSchema(exportSchema) },
  },
  handler: async ({ params }, context) => {
    void context;
    const exports = await getPlatformDataSource().lifecycle.listExports(params.tenantId);
    return { status: 200, body: { items: exports.map(toExport) } };
  },
});

export const scheduleDeletionRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/companies/:tenantId/deletion',
  operationId: 'scheduleCompanyDeletion',
  summary: 'Schedule this company to be purged',
  description:
    'Needs a finished export, which is the point: nobody deletes a customer without their data in hand first. Suspends the company immediately and purges it after the cooling-off period, until which cancelling undoes everything.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: noSchema,
  body: z.object({
    /** Must be `ready`; a pending or failed export is not an export. */
    exportId: z.uuid(),
    reason: z.string().min(10).max(500),
  }),
  responses: {
    201: { description: 'Scheduled.', schema: deletionSchema },
    404: { description: 'No such company or export.' },
    409: { description: 'The export is not ready, or a deletion is already scheduled.' },
  },
  handler: async ({ params, body }, context) => {
    const platform = getPlatformDataSource();
    const tenant = await platform.tenants.findById(params.tenantId);
    if (tenant === undefined) {
      throw notFound(`No company with id ${params.tenantId}`);
    }

    // An export belonging to another company is "not found" rather than
    // "forbidden": the two answers differ only in what they tell a caller about
    // an id they should not have.
    const taken = await platform.lifecycle.findExport(body.exportId);
    if (taken?.tenantId !== tenant.id) {
      throw notFound(`No export ${body.exportId} for this company`);
    }
    if (taken.status !== 'ready') {
      throw conflict(
        'export_not_ready',
        `Export ${body.exportId} is ${taken.status}; a company cannot be scheduled for deletion until its export is ready.`,
      );
    }
    if ((await platform.lifecycle.pendingFor(tenant.id)) !== undefined) {
      throw conflict('deletion_scheduled', 'This company is already scheduled for deletion.');
    }

    const scheduled = await platform.lifecycle.schedule({
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      exportId: taken.id,
      requestedBy: toPlatformUserId(context.platform.platformUserId),
      reason: body.reason,
      purgeAfter: new Date(Date.now() + PURGE_COOLING_OFF_DAYS * 24 * 60 * 60 * 1000),
    });

    // Stopped serving from now, not from the purge: a company on its way out
    // should not be accruing data somebody then has to decide what to do with.
    await platform.tenants.suspend(tenant.id, 'Scheduled for deletion');
    forgetTenantStatus(tenant.id);

    await recordPlatformAction(context, {
      action: 'tenant.deletion_scheduled',
      tenantId: tenant.id,
      tenantSlug: tenant.slug,
      targetKind: 'tenant_deletion',
      targetId: scheduled.id,
      reason: body.reason,
      metadata: { purgeAfter: iso(scheduled.purgeAfter), exportId: taken.id },
    });

    return { status: 201, body: toDeletion(scheduled) };
  },
});

export const cancelDeletionRoute = defineRoute({
  method: 'post',
  path: '/v1/platform/companies/:tenantId/deletion/cancel',
  operationId: 'cancelCompanyDeletion',
  summary: 'Call off a scheduled purge',
  description:
    'Works until the purge runs, and puts the company back to suspended rather than active: whoever called the deletion off decides separately whether to start serving them again.',
  tags: ['platform'],
  security: 'platform',
  params: z.object({ tenantId: z.uuid() }),
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'Cancelled.', schema: deletionSchema },
    404: { description: 'Nothing was scheduled.' },
  },
  handler: async ({ params }, context) => {
    const cancelled = await getPlatformDataSource().lifecycle.cancel({
      tenantId: params.tenantId,
      cancelledBy: toPlatformUserId(context.platform.platformUserId),
    });
    if (cancelled === undefined) {
      throw notFound('No deletion is scheduled for this company');
    }

    await recordPlatformAction(context, {
      action: 'tenant.deletion_cancelled',
      tenantId: cancelled.tenantId,
      tenantSlug: cancelled.tenantSlug,
      targetKind: 'tenant_deletion',
      targetId: cancelled.id,
    });

    return { status: 200, body: toDeletion(cancelled) };
  },
});

export const listDeletionsRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/deletions',
  operationId: 'listDeletions',
  summary: 'Companies on their way out',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'The schedules, newest first.',
      schema: platformListSchema(deletionSchema),
    },
  },
  handler: async (_input, context) => {
    void context;
    const deletions = await getPlatformDataSource().lifecycle.listDeletions();
    return { status: 200, body: { items: deletions.map(toDeletion) } };
  },
});

function toExport(row: TenantExport): z.infer<typeof exportSchema> {
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantSlug: row.tenantSlug,
    status: row.status,
    createdAt: iso(row.createdAt),
    completedAt: isoOrNull(row.completedAt),
    objectKey: row.objectKey,
    byteSize: row.byteSize,
    contents: row.contents,
    expiresAt: isoOrNull(row.expiresAt),
    error: row.error,
  };
}

function toDeletion(row: TenantDeletion): z.infer<typeof deletionSchema> {
  return {
    id: row.id,
    tenantId: row.tenantId,
    tenantSlug: row.tenantSlug,
    purgeAfter: iso(row.purgeAfter),
    createdAt: iso(row.createdAt),
    reason: row.reason,
    exportId: row.exportId,
    cancelledAt: isoOrNull(row.cancelledAt),
    completedAt: isoOrNull(row.completedAt),
  };
}

export const platformLifecycleRoutes = [
  startExportRoute,
  listExportsRoute,
  scheduleDeletionRoute,
  cancelDeletionRoute,
  listDeletionsRoute,
];
