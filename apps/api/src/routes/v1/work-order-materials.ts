import { positiveQuantitySchema } from '@integr8/core';
import { type TenantTransaction, withTenant } from '@integr8/db';
import { z } from 'zod';
import { notFound } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import { FEATURE, TAGS } from './inventory.js';
import {
  assertTakesParts,
  materialBodies,
  materialSchema,
  recordUse,
  resolveUse,
  returnUse,
  seesCosts,
} from './materials.js';
import { peopleOf, readableWorkOrder, requireWork } from './operations.js';
import { lotSpecsSchema } from './stock-lots.js';
import { detailBody, detailSchema, workOrderParams } from './work-orders.js';

/**
 * Parts used on a job, over HTTP (CRM/ERP plan, phase E2; ADR-0005). The
 * phone records the same thing offline through `POST /v1/sync/push`
 * (`work_order.material`); the rules live in `materials.ts` and are the same.
 * Every route answers with the job as it now is, like the rest of the job's
 * routes, so a screen refreshes in one go.
 */

const materialParams = workOrderParams.extend({ materialId: z.uuid() });

async function requireMaterial(tx: TenantTransaction, workOrderId: string, materialId: string) {
  const material = await tx.inventoryMaterials.lock(materialId);
  if (material?.workOrderId !== workOrderId) {
    throw notFound('This job has no such part.');
  }
  return material;
}

export const recordMaterialRoute = defineRoute({
  method: 'post',
  path: '/v1/work-orders/:workOrderId/materials',
  operationId: 'recordWorkOrderMaterial',
  summary: 'Record a part used on a job',
  description:
    "A stock item is taken from the engineer's van (or the location a dispatcher names) and posted to the ledger at the item's average cost. When the location does not hold enough, nothing is posted and the use is kept as a conflict (`status: conflict`) for the office to resolve; stock never goes negative. Services and non-stock items are recorded without touching stock. Needs `Idempotency-Key`.",
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.consume',
  feature: FEATURE,
  idempotent: 'required',
  params: workOrderParams,
  query: noSchema,
  body: z.object({
    itemId: z.uuid(),
    /** A dispatcher says where from; an engineer's parts come from their van. */
    locationId: z.uuid().optional(),
    quantity: positiveQuantitySchema,
    note: z.string().trim().max(1000).nullable().optional(),
    /** For a serial-numbered or batched item: which ones; the batch expiring first when none are named. */
    lots: lotSpecsSchema.optional(),
    /** Use an expired batch anyway; the note says why. */
    allowExpired: z.boolean().optional(),
  }),
  responses: {
    201: {
      description: 'The job, with the use recorded or kept as a conflict.',
      schema: detailSchema,
    },
    403: { description: 'Not on this job, or not your van.' },
    404: { description: 'No such job (this person may see) or item.' },
    409: {
      description:
        'The job is completed, reviewed or cancelled (`work_order_closed`), or already invoiced (`work_order_invoiced`): a part recorded now would never be billed. Returning unused parts stays allowed.',
    },
    422: {
      description:
        'No van assigned (`no_van`), no location given by a dispatcher (`location_required`), the item is archived, or its serial numbers or batches do not fit (`serial_single_unit`, `lots_quantity_mismatch`, `lot_repeated`, `batch_expired`, `item_not_tracked`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, context.principal, params.workOrderId);
      await requireWork(tx, context.principal, job);
      await assertTakesParts(tx, job);
      await recordUse(tx, context, job, {
        itemId: body.itemId,
        locationId: body.locationId ?? null,
        quantity: body.quantity,
        note: body.note ?? null,
        lots: body.lots,
        allowExpired: body.allowExpired,
      });
      return detailBody(tx, context.principal, job);
    });
    return { status: 201, body: detail };
  },
});

export const resolveMaterialRoute = defineRoute({
  method: 'post',
  path: '/v1/work-orders/:workOrderId/materials/:materialId/resolve',
  operationId: 'resolveWorkOrderMaterial',
  summary: 'Settle a part use the location could not cover',
  description:
    '`cancel` drops the use (the person who recorded it, or the office). `retry` posts it again, optionally with another quantity or location, after the stock has been put right (office only); it may be refused again and stay a conflict.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.consume',
  feature: FEATURE,
  params: materialParams,
  query: noSchema,
  body: z.discriminatedUnion('action', [
    z.object({ action: z.literal('cancel') }),
    z.object({
      action: z.literal('retry'),
      quantity: positiveQuantitySchema.optional(),
      locationId: z.uuid().optional(),
      /** Other serial numbers or batches; those first asked for when the quantity is unchanged. */
      lots: lotSpecsSchema.optional(),
      allowExpired: z.boolean().optional(),
      /** Why an expired batch is used. */
      reason: z.string().trim().max(1000).optional(),
    }),
  ]),
  responses: {
    200: { description: 'The job as it now is.', schema: detailSchema },
    403: { description: 'Not allowed to resolve this use.' },
    404: { description: 'No such job or part.' },
    409: { description: 'Not a conflict (`not_a_conflict`).' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, context.principal, params.workOrderId);
      const material = await requireMaterial(tx, job.id, params.materialId);
      await resolveUse(tx, context, job, material, body);
      return detailBody(tx, context.principal, job);
    });
    return { status: 200, body: detail };
  },
});

export const returnMaterialRoute = defineRoute({
  method: 'post',
  path: '/v1/work-orders/:workOrderId/materials/:materialId/return',
  operationId: 'returnWorkOrderMaterial',
  summary: 'Put an unused part back',
  description:
    'Returns part or all of a posted use to the location it came from, as a reversal of the use; never more than was used (422 `over_returned`). Needs `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.consume',
  feature: FEATURE,
  idempotent: 'required',
  params: materialParams,
  query: noSchema,
  body: z.object({
    quantity: positiveQuantitySchema,
    reason: z.string().trim().max(1000).nullable().optional(),
    /** Which serial numbers or batches come back; by default, those used. */
    lots: lotSpecsSchema.optional(),
  }),
  responses: {
    201: { description: 'The job as it now is.', schema: detailSchema },
    404: { description: 'No such job or part.' },
    409: { description: 'Not a posted use (`not_posted`).' },
    422: { description: 'More than was used (`over_returned`).' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, context.principal, params.workOrderId);
      await requireWork(tx, context.principal, job);
      const material = await requireMaterial(tx, job.id, params.materialId);
      await returnUse(tx, context, job, material, {
        quantity: body.quantity,
        reason: body.reason ?? null,
        idempotencyKey: context.idempotencyKey!,
        lots: body.lots,
      });
      return detailBody(tx, context.principal, job);
    });
    return { status: 201, body: detail };
  },
});

export const conflictSchema = materialSchema.extend({
  workOrder: z.object({ id: z.uuid(), referenceLabel: z.string(), title: z.string() }),
});

export const listMaterialConflictsRoute = defineRoute({
  method: 'get',
  path: '/v1/inventory/materials/conflicts',
  operationId: 'listMaterialConflicts',
  summary: 'Part uses waiting for the office',
  description:
    'Every use a location could not cover, newest first, across jobs: what was asked for, what was there, and which job.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.move',
  feature: FEATURE,
  params: noSchema,
  query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
  body: noSchema,
  responses: {
    200: {
      description: 'The conflicts.',
      schema: z.object({ items: z.array(conflictSchema) }),
    },
  },
  handler: async ({ query }, context) => {
    const items = await withTenant(context.principal.tenantId, async (tx) => {
      const conflicts = await tx.inventoryMaterials.listConflicts(query.limit);
      const [bodies, jobs] = await Promise.all([
        materialBodies(tx, conflicts, seesCosts(context.principal), await peopleOf(tx)),
        tx.workOrders.findMany([...new Set(conflicts.map((row) => row.workOrderId))]),
      ]);
      const job = new Map(jobs.map((row) => [row.id, row]));
      return bodies.flatMap((body, index) => {
        const found = job.get(conflicts[index]!.workOrderId);
        return found === undefined
          ? []
          : [
              {
                ...body,
                workOrder: {
                  id: found.id,
                  referenceLabel: `WO-${String(found.reference).padStart(6, '0')}`,
                  title: found.title,
                },
              },
            ];
      });
    });
    return { status: 200, body: { items } };
  },
});

export const materialRoutes = [
  recordMaterialRoute,
  resolveMaterialRoute,
  returnMaterialRoute,
  listMaterialConflictsRoute,
];
