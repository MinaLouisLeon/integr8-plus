import {
  holds,
  opportunityStatusSchema as stageOutcomeSchema,
  STAGE_OUTCOMES,
} from '@integr8/core';
import { type Pipeline, type TenantTransaction, withTenant } from '@integr8/db';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { pipelineSchema, stageBody, stageSchema } from './crm-opportunities.js';
import { crmAudit as audit, FEATURE, TAGS } from './crm-shared.js';

/**
 * Editing pipelines and their stages (eighth round; ADR-0012).
 *
 * Owners and admins add, rename, reorder and archive pipelines and stages.
 * A stage's key never changes and is never reused, so history keeps pointing
 * at what it meant; a stage is archived, not deleted. Archiving one that
 * holds open opportunities moves them to another open stage first, through
 * the same move that records their history. A pipeline always keeps an open,
 * a won and a lost stage, and the default pipeline is never archived.
 */

const stageWithCountsSchema = stageSchema.extend({
  /** Opportunities standing in it now: still open, and won or lost. */
  openCount: z.number().int(),
  closedCount: z.number().int(),
});

const pipelineDetailSchema = pipelineSchema.extend({
  stages: z.array(stageWithCountsSchema),
  can: z.object({ edit: z.boolean() }),
});

const pipelineParams = z.object({ pipelineId: z.uuid() });
const stageParams = z.object({ pipelineId: z.uuid(), stageId: z.uuid() });
const nameSchema = z.string().trim().min(1).max(100);
const labelSchema = z.string().trim().min(1).max(100);
const probabilitySchema = z.number().int().min(0).max(10_000);

async function pipelineDetail(
  tx: TenantTransaction,
  context: RequestContext,
  pipeline: Pipeline,
): Promise<z.infer<typeof pipelineDetailSchema>> {
  const counts = await tx.crmPipelines.occupancy(pipeline.id);
  return {
    id: pipeline.id,
    name: pipeline.name,
    isDefault: pipeline.isDefault,
    stages: pipeline.stages.map((stage) => ({
      ...stageBody(stage),
      openCount: counts.get(stage.id)?.open ?? 0,
      closedCount: counts.get(stage.id)?.closed ?? 0,
    })),
    can: { edit: holds(context.principal, 'crm.pipeline.manage') },
  };
}

async function pipelineOrMissing(
  tx: TenantTransaction,
  pipelineId: string,
  lock = false,
): Promise<Pipeline> {
  const pipeline = lock
    ? await tx.crmPipelines.lock(pipelineId)
    : await tx.crmPipelines.find(pipelineId);
  if (pipeline === undefined) {
    throw notFound('No such pipeline.');
  }
  return pipeline;
}

/** Whether, without these stages, the pipeline still has an open, a won and a lost one. */
function keepsEveryOutcome(pipeline: Pipeline, without: string): boolean {
  const current = pipeline.stages.filter(
    (stage) => stage.archivedAt === null && stage.id !== without,
  );
  return STAGE_OUTCOMES.every((outcome) => current.some((stage) => stage.outcome === outcome));
}

export const getPipelineRoute = defineRoute({
  method: 'get',
  path: '/v1/crm/pipelines/:pipelineId',
  operationId: 'getPipeline',
  summary: 'A pipeline, its stages and how many opportunities stand in each',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.read',
  feature: FEATURE,
  params: pipelineParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The pipeline.', schema: pipelineDetailSchema },
    404: { description: 'No such pipeline.' },
  },
  handler: async ({ params }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) =>
      pipelineDetail(tx, context, await pipelineOrMissing(tx, params.pipelineId)),
    );
    return { status: 200, body };
  },
});

export const createPipelineRoute = defineRoute({
  method: 'post',
  path: '/v1/crm/pipelines',
  operationId: 'createPipeline',
  summary: 'Add a pipeline, starting from the standard stages',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.pipeline.manage',
  feature: FEATURE,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: z.object({ name: nameSchema }),
  responses: {
    201: { description: 'The pipeline.', schema: pipelineDetailSchema },
    409: { description: 'The name is taken (`name_taken`).' },
  },
  handler: async ({ body }, context) => {
    const created = await withTenant(context.principal.tenantId, async (tx) => {
      await tx.crmPipelines.ensureDefault();
      const pipeline = await tx.crmPipelines.create(body.name);
      if (pipeline === 'name_taken') {
        throw conflict('name_taken', 'Another pipeline has this name.');
      }
      await audit(tx, context, 'crm.pipeline_created', 'crm_pipeline', pipeline.id, {
        name: pipeline.name,
      });
      return pipelineDetail(tx, context, pipeline);
    });
    return { status: 201, body: created };
  },
});

export const updatePipelineRoute = defineRoute({
  method: 'patch',
  path: '/v1/crm/pipelines/:pipelineId',
  operationId: 'updatePipeline',
  summary: 'Rename a pipeline, or make it the default for new opportunities',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.pipeline.manage',
  feature: FEATURE,
  params: pipelineParams,
  query: noSchema,
  body: z.object({ name: nameSchema.optional(), isDefault: z.literal(true).optional() }),
  responses: {
    200: { description: 'The pipeline.', schema: pipelineDetailSchema },
    404: { description: 'No such pipeline.' },
    409: { description: 'The name is taken (`name_taken`).' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const pipeline = await pipelineOrMissing(tx, params.pipelineId, true);
      if (body.name !== undefined && (await tx.crmPipelines.rename(pipeline.id, body.name))) {
        throw conflict('name_taken', 'Another pipeline has this name.');
      }
      if (body.isDefault === true && !pipeline.isDefault) {
        await tx.crmPipelines.makeDefault(pipeline.id);
      }
      await audit(tx, context, 'crm.pipeline_updated', 'crm_pipeline', pipeline.id, {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.isDefault === undefined ? {} : { isDefault: true }),
      });
      return pipelineDetail(tx, context, await pipelineOrMissing(tx, pipeline.id));
    });
    return { status: 200, body: detail };
  },
});

export const archivePipelineRoute = defineRoute({
  method: 'delete',
  path: '/v1/crm/pipelines/:pipelineId',
  operationId: 'archivePipeline',
  summary: 'Archive a pipeline with no open opportunities',
  description:
    'Never the default (409 `default_pipeline`); not while it holds open opportunities (409 `pipeline_has_open`). Its history stays.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.pipeline.manage',
  feature: FEATURE,
  params: pipelineParams,
  query: noSchema,
  body: noSchema,
  responses: {
    204: { description: 'Archived.' },
    404: { description: 'No such pipeline.' },
    409: { description: 'The default, or it holds open opportunities.' },
  },
  handler: async ({ params }, context) => {
    await withTenant(context.principal.tenantId, async (tx) => {
      const pipeline = await pipelineOrMissing(tx, params.pipelineId, true);
      if (pipeline.isDefault) {
        throw conflict('default_pipeline', 'Make another pipeline the default first.');
      }
      const counts = await tx.crmPipelines.occupancy(pipeline.id);
      if ([...counts.values()].some((count) => count.open > 0)) {
        throw conflict(
          'pipeline_has_open',
          'Close or move its open opportunities before archiving the pipeline.',
        );
      }
      await tx.crmPipelines.archive(pipeline.id);
      await audit(tx, context, 'crm.pipeline_archived', 'crm_pipeline', pipeline.id);
    });
    return { status: 204, body: undefined };
  },
});

export const addStageRoute = defineRoute({
  method: 'post',
  path: '/v1/crm/pipelines/:pipelineId/stages',
  operationId: 'addPipelineStage',
  summary: 'Add a stage at the end of a pipeline',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.pipeline.manage',
  feature: FEATURE,
  idempotent: true,
  params: pipelineParams,
  query: noSchema,
  body: z.object({
    label: labelSchema,
    probabilityBp: probabilitySchema,
    outcome: stageOutcomeSchema.default('open'),
  }),
  responses: {
    201: { description: 'The pipeline.', schema: pipelineDetailSchema },
    404: { description: 'No such pipeline.' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const pipeline = await pipelineOrMissing(tx, params.pipelineId, true);
      const stage = await tx.crmPipelines.addStage(pipeline.id, body);
      await audit(tx, context, 'crm.stage_added', 'crm_pipeline', pipeline.id, {
        stageId: stage.id,
        label: stage.label,
      });
      return pipelineDetail(tx, context, await pipelineOrMissing(tx, pipeline.id));
    });
    return { status: 201, body: detail };
  },
});

export const updateStageRoute = defineRoute({
  method: 'patch',
  path: '/v1/crm/pipelines/:pipelineId/stages/:stageId',
  operationId: 'updatePipelineStage',
  summary: 'Rename a stage, or change its usual chance or what reaching it means',
  description:
    'The outcome changes only for a stage no opportunity has been in (409 `stage_in_use`), and never leaves the pipeline without an open, a won and a lost stage (409 `stage_needed`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.pipeline.manage',
  feature: FEATURE,
  params: stageParams,
  query: noSchema,
  body: z.object({
    label: labelSchema.optional(),
    probabilityBp: probabilitySchema.optional(),
    outcome: stageOutcomeSchema.optional(),
  }),
  responses: {
    200: { description: 'The pipeline.', schema: pipelineDetailSchema },
    404: { description: 'No such pipeline or stage.' },
    409: { description: 'The outcome cannot change.' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const pipeline = await pipelineOrMissing(tx, params.pipelineId, true);
      const stage = pipeline.stages.find(
        (candidate) => candidate.id === params.stageId && candidate.archivedAt === null,
      );
      if (stage === undefined) {
        throw notFound('No such stage in this pipeline.');
      }
      if (body.outcome !== undefined && body.outcome !== stage.outcome) {
        if (await tx.crmPipelines.stageUsed(stage.id)) {
          throw conflict(
            'stage_in_use',
            'Opportunities have been in this stage; add a new stage instead of changing what it means.',
          );
        }
        if (!keepsEveryOutcome(pipeline, stage.id)) {
          throw conflict('stage_needed', 'A pipeline keeps an open, a won and a lost stage.');
        }
      }
      await tx.crmPipelines.updateStage(stage.id, body);
      await audit(tx, context, 'crm.stage_updated', 'crm_pipeline', pipeline.id, {
        stageId: stage.id,
        ...body,
      });
      return pipelineDetail(tx, context, await pipelineOrMissing(tx, pipeline.id));
    });
    return { status: 200, body: detail };
  },
});

export const reorderStagesRoute = defineRoute({
  method: 'put',
  path: '/v1/crm/pipelines/:pipelineId/stages/order',
  operationId: 'reorderPipelineStages',
  summary: 'Put a pipeline’s current stages in a new order',
  description: 'Every current stage, once (422 `order_incomplete`). Archived stages keep the end.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.pipeline.manage',
  feature: FEATURE,
  params: pipelineParams,
  query: noSchema,
  body: z.object({ stageIds: z.array(z.uuid()).min(1).max(50) }),
  responses: {
    200: { description: 'The pipeline.', schema: pipelineDetailSchema },
    404: { description: 'No such pipeline.' },
    422: { description: 'Not every current stage, or one twice.' },
  },
  handler: async ({ params, body }, context) => {
    const detail = await withTenant(context.principal.tenantId, async (tx) => {
      const pipeline = await pipelineOrMissing(tx, params.pipelineId, true);
      const current = pipeline.stages
        .filter((stage) => stage.archivedAt === null)
        .map((stage) => stage.id);
      if (
        body.stageIds.length !== current.length ||
        new Set(body.stageIds).size !== body.stageIds.length ||
        body.stageIds.some((id) => !current.includes(id))
      ) {
        throw unprocessable(
          'order_incomplete',
          'List every current stage of the pipeline exactly once.',
        );
      }
      await tx.crmPipelines.reorder(pipeline.id, body.stageIds);
      await audit(tx, context, 'crm.stages_reordered', 'crm_pipeline', pipeline.id);
      return pipelineDetail(tx, context, await pipelineOrMissing(tx, pipeline.id));
    });
    return { status: 200, body: detail };
  },
});

export const archiveStageRoute = defineRoute({
  method: 'post',
  path: '/v1/crm/pipelines/:pipelineId/stages/:stageId/archive',
  operationId: 'archivePipelineStage',
  summary: 'Archive a stage, moving its open opportunities to another open stage',
  description:
    'Open opportunities in it need `moveToStageId`, a current open stage of the same pipeline (422 `move_required`, `move_target_not_open`); each move is recorded in its history. The pipeline keeps an open, a won and a lost stage (409 `stage_needed`).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.pipeline.manage',
  feature: FEATURE,
  params: stageParams,
  query: noSchema,
  body: z.object({ moveToStageId: z.uuid().optional() }),
  responses: {
    200: {
      description: 'The pipeline, and how many opportunities moved.',
      schema: z.object({ pipeline: pipelineDetailSchema, moved: z.number().int() }),
    },
    404: { description: 'No such pipeline or stage.' },
    409: { description: 'The last stage of its outcome.' },
    422: { description: 'Where to move its opportunities is missing or not open.' },
  },
  handler: async ({ params, body }, context) => {
    const result = await withTenant(context.principal.tenantId, async (tx) => {
      const pipeline = await pipelineOrMissing(tx, params.pipelineId, true);
      const stage = pipeline.stages.find(
        (candidate) => candidate.id === params.stageId && candidate.archivedAt === null,
      );
      if (stage === undefined) {
        throw notFound('No such stage in this pipeline.');
      }
      if (!keepsEveryOutcome(pipeline, stage.id)) {
        throw conflict('stage_needed', 'A pipeline keeps an open, a won and a lost stage.');
      }
      const open = await tx.crmPipelines.openInStage(stage.id);
      let moved = 0;
      if (open.length > 0) {
        const target = pipeline.stages.find(
          (candidate) =>
            candidate.id === body.moveToStageId &&
            candidate.archivedAt === null &&
            candidate.id !== stage.id,
        );
        if (body.moveToStageId === undefined) {
          throw unprocessable(
            'move_required',
            'This stage holds open opportunities: choose the stage they move to.',
          );
        }
        if (target?.outcome !== 'open') {
          throw unprocessable(
            'move_target_not_open',
            'Open opportunities move to another open stage of this pipeline.',
          );
        }
        for (const opportunity of open) {
          const result = await tx.crmOpportunities.move(opportunity.id, opportunity.version, {
            from: stage,
            to: target,
            kind: 'stage_changed',
            lostReason: null,
            actorId: context.principal.userId,
          });
          if (typeof result === 'string') {
            throw conflict('version_conflict', 'An opportunity changed meanwhile. Try again.');
          }
          moved += 1;
        }
      }
      await tx.crmPipelines.archiveStage(stage.id);
      await audit(tx, context, 'crm.stage_archived', 'crm_pipeline', pipeline.id, {
        stageId: stage.id,
        moved,
        ...(body.moveToStageId === undefined ? {} : { moveToStageId: body.moveToStageId }),
      });
      return {
        pipeline: await pipelineDetail(tx, context, await pipelineOrMissing(tx, pipeline.id)),
        moved,
      };
    });
    return { status: 200, body: result };
  },
});

export const pipelineEditRoutes = [
  getPipelineRoute,
  createPipelineRoute,
  updatePipelineRoute,
  archivePipelineRoute,
  addStageRoute,
  updateStageRoute,
  reorderStagesRoute,
  archiveStageRoute,
];
