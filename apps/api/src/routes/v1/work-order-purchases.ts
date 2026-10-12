import { decimalAmountSchema, holds, positiveQuantitySchema } from '@integr8/core';
import {
  type TenantTransaction,
  type WorkOrder,
  type WorkOrderPurchase,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { ApiError, conflict, forbidden, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { crmAudit as audit } from './crm-shared.js';
import { FEATURE, itemSummary, itemSummarySchema, seesCosts, TAGS } from './inventory.js';
import {
  attachmentBodies,
  attachmentSchema,
  peopleOf,
  personBody,
  personSchema,
  readableWorkOrder,
  requireWork,
} from './operations.js';
import { iso, isoOrNull } from './schemas.js';
import { workOrderParams } from './work-orders.js';

/**
 * Parts bought from a merchant for a job (eighth round; ADR-0012): recorded
 * on the job with the price paid and a photo of the receipt — from the phone
 * offline too, through `POST /v1/sync/push` (`work_order.purchase`, then
 * `work_order.purchase_receipt`). They count in the job's cost; nothing
 * enters stock. Paying the engineer back stays an expense claim.
 */

export const purchaseInputSchema = z.object({
  /** Chosen by the client, so a resend lands once. */
  id: z.uuid(),
  description: z.string().trim().min(1).max(300),
  /** A non-stock item or service from the catalogue, when it is one. */
  itemId: z.uuid().nullable().optional(),
  merchant: z.string().trim().max(200).nullable().optional(),
  quantity: positiveQuantitySchema,
  /** Paid for one, in the company currency. */
  unitPrice: decimalAmountSchema,
  note: z.string().trim().max(1000).nullable().optional(),
  occurredAt: z.iso.datetime().optional(),
});
export type PurchaseInput = z.infer<typeof purchaseInputSchema>;

export const purchaseSchema = z.object({
  id: z.uuid(),
  workOrderId: z.uuid(),
  item: itemSummarySchema.nullable(),
  description: z.string(),
  merchant: z.string().nullable(),
  quantity: z.string(),
  /** Null to seats that may not see costs, other than whoever recorded it. */
  unitPrice: z.string().nullable(),
  note: z.string().nullable(),
  recordedBy: personSchema,
  occurredAt: z.iso.datetime(),
  cancelledAt: z.iso.datetime().nullable(),
  receipts: z.array(attachmentSchema),
});

export async function purchaseBodies(
  tx: TenantTransaction,
  context: RequestContext,
  purchases: readonly WorkOrderPurchase[],
): Promise<z.infer<typeof purchaseSchema>[]> {
  if (purchases.length === 0) {
    return [];
  }
  const people = await peopleOf(tx);
  const items = new Map(
    (await tx.inventoryCatalogue.findItems(purchases.flatMap((row) => row.itemId ?? []))).map(
      (item) => [item.id, item],
    ),
  );
  const costs = seesCosts(context.principal);
  return Promise.all(
    purchases.map(async (purchase) => {
      const item = purchase.itemId === null ? undefined : items.get(purchase.itemId);
      return {
        id: purchase.id,
        workOrderId: purchase.workOrderId,
        item: item === undefined ? null : itemSummary(item),
        description: purchase.description,
        merchant: purchase.merchant,
        quantity: purchase.quantity,
        unitPrice:
          costs || purchase.recordedBy === context.principal.userId ? purchase.unitPrice : null,
        note: purchase.note,
        recordedBy: personBody(purchase.recordedBy, people),
        occurredAt: iso(purchase.occurredAt),
        cancelledAt: isoOrNull(purchase.cancelledAt),
        receipts: await attachmentBodies(
          tx,
          await tx.attachments.list({ workOrderPurchaseId: purchase.id }),
          people,
        ),
      };
    }),
  );
}

export type PurchaseOutcome =
  | { outcome: 'recorded'; purchase: WorkOrderPurchase }
  | { outcome: 'already_recorded'; purchase: WorkOrderPurchase };

/**
 * Records a purchase on a job the caller works. A repeat of the same id for
 * the same job is the same purchase; the same id elsewhere is refused.
 */
export async function recordPurchase(
  tx: TenantTransaction,
  context: RequestContext,
  job: WorkOrder,
  input: PurchaseInput,
): Promise<PurchaseOutcome> {
  const earlier = await tx.workOrderPurchases.find(input.id);
  if (earlier !== undefined) {
    if (earlier.workOrderId !== job.id) {
      throw conflict('purchase_id_taken', 'This purchase id belongs to another job.');
    }
    return { outcome: 'already_recorded', purchase: earlier };
  }
  if (typeof input.itemId === 'string') {
    const item = await tx.inventoryCatalogue.findItem(input.itemId);
    if (item === undefined) {
      throw new ApiError(404, 'item_not_found', 'This item does not exist.', [
        { field: 'body.itemId', code: 'item_not_found', message: 'This item does not exist.' },
      ]);
    }
    if (item.kind === 'stock_item') {
      throw unprocessable(
        'stock_item_bought',
        'A stock item comes from a location as a part used, not as a purchase.',
        [{ field: 'body.itemId', code: 'stock_item_bought', message: 'Record it as a part used.' }],
      );
    }
  }
  const purchase = await tx.workOrderPurchases.create(
    {
      id: input.id,
      workOrderId: job.id,
      itemId: input.itemId ?? null,
      description: input.description,
      merchant: input.merchant ?? null,
      quantity: input.quantity,
      unitPrice: input.unitPrice,
      note: input.note ?? null,
      occurredAt: input.occurredAt === undefined ? undefined : new Date(input.occurredAt),
    },
    context.principal.userId,
  );
  await audit(tx, context, 'work_order.part_bought', 'work_order', job.id, {
    purchaseId: purchase.id,
    ...(purchase.itemId === null ? {} : { itemId: purchase.itemId }),
  });
  return { outcome: 'recorded', purchase };
}

/** Adds a receipt photo, already uploaded, to a purchase. Repeats of one attachment id land once. */
export async function addPurchaseReceipt(
  tx: TenantTransaction,
  context: RequestContext,
  purchase: WorkOrderPurchase,
  input: { attachmentId?: string | undefined; fileId: string; title: string },
): Promise<void> {
  if (input.attachmentId !== undefined) {
    const existing = await tx.attachments.findAny(input.attachmentId);
    if (existing !== undefined) {
      if (
        'workOrderPurchaseId' in existing.owner &&
        existing.owner.workOrderPurchaseId === purchase.id &&
        existing.fileId === input.fileId
      ) {
        return;
      }
      throw conflict('attachment_id_taken', 'This receipt id belongs to another file.');
    }
  }
  const file = await tx.files.find(input.fileId);
  if (file?.deletedAt !== null) {
    throw notFound('This file does not exist.');
  }
  await tx.attachments.add(
    { workOrderPurchaseId: purchase.id },
    {
      ...(input.attachmentId === undefined ? {} : { id: input.attachmentId }),
      fileId: file.id,
      title: input.title,
      kind: 'photo',
    },
    context.principal.userId,
  );
}

async function workedJob(tx: TenantTransaction, context: RequestContext, workOrderId: string) {
  const job = await readableWorkOrder(tx, context.principal, workOrderId);
  await requireWork(tx, context.principal, job);
  return job;
}

async function requirePurchase(tx: TenantTransaction, workOrderId: string, purchaseId: string) {
  const purchase = await tx.workOrderPurchases.find(purchaseId);
  if (purchase?.workOrderId !== workOrderId) {
    throw notFound('This job has no such purchase.');
  }
  return purchase;
}

const listBody = z.object({ items: z.array(purchaseSchema), total: z.string().nullable() });

async function listFor(tx: TenantTransaction, context: RequestContext, jobId: string) {
  return {
    items: await purchaseBodies(tx, context, await tx.workOrderPurchases.forJob(jobId)),
    total: seesCosts(context.principal) ? await tx.workOrderPurchases.totalForJob(jobId) : null,
  };
}

export const listPurchasesRoute = defineRoute({
  method: 'get',
  path: '/v1/work-orders/:workOrderId/purchases',
  operationId: 'listWorkOrderPurchases',
  summary: 'Parts bought from a merchant for a job',
  description:
    'Oldest first, cancelled ones included, each with its receipts. `total` is what they cost, cancelled ones left out, for those who see costs.',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: ['inventory.consume', 'inventory.read'],
  feature: FEATURE,
  params: workOrderParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The purchases.', schema: listBody },
    404: { description: 'No such job this person may see.' },
  },
  handler: async ({ params }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, context.principal, params.workOrderId);
      return listFor(tx, context, job.id);
    });
    return { status: 200, body };
  },
});

export const recordPurchaseRoute = defineRoute({
  method: 'post',
  path: '/v1/work-orders/:workOrderId/purchases',
  operationId: 'recordWorkOrderPurchase',
  summary: 'Record a part bought from a merchant for a job',
  description:
    'With the price paid for one, in the company currency. Never a stock item (422 `stock_item_bought`): those are parts used from a location. Resending the same `id` changes nothing. The phone records the same thing offline through `/v1/sync/push`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.consume',
  feature: FEATURE,
  params: workOrderParams,
  query: noSchema,
  body: purchaseInputSchema,
  responses: {
    201: { description: 'The job’s purchases as they are now.', schema: listBody },
    403: { description: 'Not on this job.' },
    404: { description: 'No such job or item.' },
    409: { description: 'The id belongs to another job (`purchase_id_taken`).' },
    422: { description: 'A stock item (`stock_item_bought`).' },
  },
  handler: async ({ params, body }, context) => {
    const result = await withTenant(context.principal.tenantId, async (tx) => {
      const job = await workedJob(tx, context, params.workOrderId);
      await recordPurchase(tx, context, job, body);
      return listFor(tx, context, job.id);
    });
    return { status: 201, body: result };
  },
});

const purchaseParams = workOrderParams.extend({ purchaseId: z.uuid() });

export const addPurchaseReceiptRoute = defineRoute({
  method: 'post',
  path: '/v1/work-orders/:workOrderId/purchases/:purchaseId/receipts',
  operationId: 'addWorkOrderPurchaseReceipt',
  summary: 'Add a receipt photo to a purchase',
  description: 'The file must already be uploaded and confirmed (`/v1/media`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'inventory.consume',
  feature: FEATURE,
  params: purchaseParams,
  query: noSchema,
  body: z.object({
    attachmentId: z.uuid().optional(),
    fileId: z.uuid(),
    title: z.string().trim().min(1).max(200).default('Receipt'),
  }),
  responses: {
    201: { description: 'The job’s purchases as they are now.', schema: listBody },
    404: { description: 'No such job, purchase or file.' },
    409: { description: 'The attachment id belongs to another file (`attachment_id_taken`).' },
  },
  handler: async ({ params, body }, context) => {
    const result = await withTenant(context.principal.tenantId, async (tx) => {
      const job = await workedJob(tx, context, params.workOrderId);
      const purchase = await requirePurchase(tx, job.id, params.purchaseId);
      await addPurchaseReceipt(tx, context, purchase, body);
      return listFor(tx, context, job.id);
    });
    return { status: 201, body: result };
  },
});

export const cancelPurchaseRoute = defineRoute({
  method: 'post',
  path: '/v1/work-orders/:workOrderId/purchases/:purchaseId/cancel',
  operationId: 'cancelWorkOrderPurchase',
  summary: 'Take a purchase off a job',
  description:
    'By whoever recorded it, or by those who move stock. It stays on the record, cancelled.',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: ['inventory.consume', 'inventory.move'],
  feature: FEATURE,
  params: purchaseParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The job’s purchases as they are now.', schema: listBody },
    403: { description: 'Not this seat’s to cancel.' },
    404: { description: 'No such job or purchase.' },
    409: { description: 'Already cancelled (`purchase_cancelled`).' },
  },
  handler: async ({ params }, context) => {
    const result = await withTenant(context.principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, context.principal, params.workOrderId);
      const purchase = await requirePurchase(tx, job.id, params.purchaseId);
      if (
        !holds(context.principal, 'inventory.move') &&
        purchase.recordedBy !== context.principal.userId
      ) {
        throw forbidden('Only whoever recorded it, or the office, takes a purchase off.');
      }
      if (
        (await tx.workOrderPurchases.cancel(purchase.id, context.principal.userId)) === undefined
      ) {
        throw conflict('purchase_cancelled', 'This purchase was already taken off.');
      }
      await audit(tx, context, 'work_order.part_bought_cancelled', 'work_order', job.id, {
        purchaseId: purchase.id,
      });
      return listFor(tx, context, job.id);
    });
    return { status: 200, body: result };
  },
});

export const workOrderPurchaseRoutes = [
  listPurchasesRoute,
  recordPurchaseRoute,
  addPurchaseReceiptRoute,
  cancelPurchaseRoute,
];
