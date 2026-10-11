import {
  basisPointsSchema,
  currencyCodeSchema,
  decimalAmountSchema,
  holds,
  OPPORTUNITY_EVENT_KINDS,
  opportunityEventKind,
  opportunityMoveAllowed,
  opportunityStatusSchema,
  STAGE_OUTCOMES,
  type Principal,
} from '@integr8/core';
import {
  type Opportunity,
  type OpportunityEvent,
  type OpportunityInput,
  type PipelineStage,
  type TenantTransaction,
  withTenant,
} from '@integr8/db';
import { z } from 'zod';
import { ApiError, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema } from '../../http/routes.js';
import {
  crmAudit,
  decodeDateCursor,
  encodeDateCursor,
  FEATURE,
  requireAssignableMember,
  TAGS,
  versionConflict,
} from './crm-shared.js';
import { booleanQuery, many } from './operations.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Opportunities and the pipeline (CRM/ERP plan, phase C3).
 *
 * An opportunity's amount is an estimate with its own currency, carried as a
 * decimal string; a forecast is never revenue, and winning one creates no
 * invoice and no job. Details change by PATCH with `expectedVersion`; stages
 * change only through `/transitions`, which records every move.
 */

// ---------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------

export const stageSchema = z.object({
  id: z.uuid(),
  /** Stable; screens translate the built-in keys. */
  key: z.string(),
  label: z.string(),
  position: z.number().int(),
  /** The usual chance of winning from this stage, in basis points (2500 = 25 %). */
  probabilityBp: z.number().int(),
  outcome: z.enum(STAGE_OUTCOMES),
  archived: z.boolean(),
});

export const pipelineSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  isDefault: z.boolean(),
  stages: z.array(stageSchema),
});

export function stageBody(stage: PipelineStage): z.infer<typeof stageSchema> {
  return {
    id: stage.id,
    key: stage.key,
    label: stage.label,
    position: stage.position,
    probabilityBp: stage.probabilityBp,
    outcome: stage.outcome,
    archived: stage.archivedAt !== null,
  };
}

export const opportunitySchema = z.object({
  id: z.uuid(),
  title: z.string(),
  customer: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  lead: z.object({ id: z.uuid(), displayName: z.string() }).nullable(),
  pipelineId: z.uuid(),
  stage: stageSchema,
  ownerId: z.uuid().nullable(),
  /** An estimate as a decimal string, such as `125000.5`. Not revenue. */
  amount: z.string().nullable(),
  currencyCode: z.string(),
  /** `YYYY-MM-DD`. */
  expectedCloseDate: z.string().nullable(),
  probabilityBp: z.number().int(),
  status: opportunityStatusSchema,
  lostReason: z.string().nullable(),
  description: z.string().nullable(),
  closedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});

export type OpportunityBody = z.infer<typeof opportunitySchema>;

/** Opportunities with their customer, lead and stage, looked up once for the lot. */
export async function opportunityBodies(
  tx: TenantTransaction,
  items: readonly Opportunity[],
): Promise<OpportunityBody[]> {
  const [customers, leads, stages] = await Promise.all([
    tx.customers.findMany(
      items.flatMap((item) => (item.customerId === null ? [] : [item.customerId])),
    ),
    tx.crmLeads.findMany(items.flatMap((item) => (item.leadId === null ? [] : [item.leadId]))),
    tx.crmPipelines.findStages(items.map((item) => item.stageId)),
  ]);
  const customer = new Map(customers.map((row) => [row.id, row]));
  const lead = new Map(leads.map((row) => [row.id, row]));
  const stage = new Map(stages.map((row) => [row.id, row]));
  return items.map((item) => {
    const linkedCustomer = item.customerId === null ? undefined : customer.get(item.customerId);
    const linkedLead = item.leadId === null ? undefined : lead.get(item.leadId);
    return {
      id: item.id,
      title: item.title,
      customer:
        linkedCustomer === undefined ? null : { id: linkedCustomer.id, name: linkedCustomer.name },
      lead:
        linkedLead === undefined
          ? null
          : { id: linkedLead.id, displayName: linkedLead.displayName },
      pipelineId: item.pipelineId,
      stage: stageBody(stage.get(item.stageId)!),
      ownerId: item.ownerId,
      amount: item.amount,
      currencyCode: item.currencyCode,
      expectedCloseDate: item.expectedCloseDate,
      probabilityBp: item.probabilityBp,
      status: item.status,
      lostReason: item.lostReason,
      description: item.description,
      closedAt: isoOrNull(item.closedAt),
      version: item.version,
      createdBy: item.createdBy,
      createdAt: iso(item.createdAt),
      updatedAt: iso(item.updatedAt),
      archivedAt: isoOrNull(item.archivedAt),
    };
  });
}

const opportunityParams = z.object({ opportunityId: z.uuid() });

const partyRequired = () =>
  unprocessable('party_required', 'An opportunity is for a customer, a lead, or both.', [
    {
      field: 'body.customerId',
      code: 'party_required',
      message: 'Choose a customer or a lead.',
    },
  ]);

/** Checks a customer and a lead named by a request are this company's. */
async function requireParties(
  tx: TenantTransaction,
  customerId: string | null | undefined,
  leadId: string | null | undefined,
): Promise<void> {
  if (typeof customerId === 'string' && (await tx.customers.find(customerId)) === undefined) {
    throw new ApiError(404, 'customer_not_found', 'This customer does not exist.', [
      {
        field: 'body.customerId',
        code: 'customer_not_found',
        message: 'This customer does not exist.',
      },
    ]);
  }
  if (typeof leadId === 'string' && (await tx.crmLeads.find(leadId)) === undefined) {
    throw new ApiError(404, 'lead_not_found', 'This lead does not exist.', [
      { field: 'body.leadId', code: 'lead_not_found', message: 'This lead does not exist.' },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

export const listPipelinesRoute = defineRoute({
  method: 'get',
  path: '/v1/crm/pipelines',
  operationId: 'listPipelines',
  summary: 'The company’s pipelines and their stages',
  description:
    'The default pipeline first. A company that has none yet gets the standard one (New, Qualified, Proposal, Negotiation, Won, Lost) on first use.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.read',
  feature: FEATURE,
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: {
      description: 'Pipelines in order.',
      schema: z.object({ items: z.array(pipelineSchema) }),
    },
  },
  handler: async (_input, context) => {
    const pipelines = await withTenant(context.principal.tenantId, (tx) => tx.crmPipelines.list());
    return {
      status: 200,
      body: {
        items: pipelines.map((pipeline) => ({
          id: pipeline.id,
          name: pipeline.name,
          isDefault: pipeline.isDefault,
          stages: pipeline.stages.map(stageBody),
        })),
      },
    };
  },
});

// ---------------------------------------------------------------------------
// Opportunities
// ---------------------------------------------------------------------------

export const listOpportunitiesRoute = defineRoute({
  method: 'get',
  path: '/v1/crm/opportunities',
  operationId: 'listOpportunities',
  summary: 'Find opportunities',
  description:
    'Newest first, a page at a time. `q` matches words or their beginnings in the title or description. `ownerId` takes a member id, `me`, or `none` for those nobody owns.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    q: z.string().trim().max(200).optional(),
    status: many(opportunityStatusSchema, 3),
    stageId: z.uuid().optional(),
    ownerId: z.union([z.uuid(), z.literal('me'), z.literal('none')]).optional(),
    customerId: z.uuid().optional(),
    leadId: z.uuid().optional(),
    includeArchived: booleanQuery,
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of opportunities.',
      schema: z.object({ items: z.array(opportunitySchema), nextCursor: z.string().nullable() }),
    },
  },
  handler: async ({ query }, context) => {
    const after = decodeDateCursor(query.cursor);
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const page = await tx.crmOpportunities.list({
        ...(query.q === undefined ? {} : { text: query.q }),
        statuses: query.status,
        ...(query.stageId === undefined ? {} : { stageId: query.stageId }),
        ...(query.ownerId === undefined
          ? {}
          : {
              ownerId:
                query.ownerId === 'me'
                  ? context.principal.userId
                  : query.ownerId === 'none'
                    ? null
                    : query.ownerId,
            }),
        ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
        ...(query.leadId === undefined ? {} : { leadId: query.leadId }),
        includeArchived: query.includeArchived === 'true',
        ...(after === undefined ? {} : { after }),
        limit: query.limit,
      });
      return {
        items: await opportunityBodies(tx, page.items),
        nextCursor: encodeDateCursor(page.next),
      };
    });
    return { status: 200, body };
  },
});

const opportunityFields = {
  title: z.string().trim().min(1).max(200),
  customerId: z.uuid().nullable().optional(),
  leadId: z.uuid().nullable().optional(),
  ownerId: z.uuid().nullable().optional(),
  amount: decimalAmountSchema.nullable().optional(),
  /** Defaults to the company's currency. */
  currencyCode: currencyCodeSchema.optional(),
  expectedCloseDate: z.iso.date().nullable().optional(),
  /** Defaults to the stage's usual chance. */
  probabilityBp: basisPointsSchema.optional(),
  description: z.string().max(10_000).nullable().optional(),
};

const createOpportunitySchema = z.object({
  ...opportunityFields,
  /** An open stage of a pipeline; the default pipeline's first stage if left out. */
  stageId: z.uuid().optional(),
});

/** What the request carries, without what it left out. */
function toInput(body: Readonly<Record<string, unknown>>): Partial<OpportunityInput> {
  const input: Partial<OpportunityInput> = {};
  for (const key of Object.keys(opportunityFields) as (keyof typeof opportunityFields)[]) {
    const value = body[key];
    if (value !== undefined) {
      (input as Record<string, unknown>)[key] = value;
    }
  }
  return input;
}

/** Creates an open opportunity, as the create route and lead conversion both do. */
export async function createOpportunity(
  tx: TenantTransaction,
  principal: Principal,
  input: OpportunityInput,
  stageId: string | undefined,
): Promise<Opportunity> {
  let stage: PipelineStage | undefined;
  if (stageId === undefined) {
    stage = (await tx.crmPipelines.ensureDefault()).stages.find(
      (candidate) => candidate.outcome === 'open' && candidate.archivedAt === null,
    );
  } else {
    stage = await tx.crmPipelines.findStage(stageId);
    if (stage === undefined) {
      throw unprocessable('stage_not_found', 'This stage does not exist.', [
        { field: 'body.stageId', code: 'stage_not_found', message: 'This stage does not exist.' },
      ]);
    }
  }
  if (stage?.outcome !== 'open' || stage.archivedAt !== null) {
    throw unprocessable(
      'stage_not_open',
      'A new opportunity starts at an open stage. Win or lose it afterwards.',
    );
  }
  if (typeof input.ownerId === 'string') {
    await requireAssignableMember(tx, input.ownerId, 'body.ownerId');
  }
  return tx.crmOpportunities.create(
    { ...input, currencyCode: input.currencyCode ?? (await tx.settings.get()).currency },
    stage,
    principal.userId,
  );
}

export const createOpportunityRoute = defineRoute({
  method: 'post',
  path: '/v1/crm/opportunities',
  operationId: 'createOpportunity',
  summary: 'Add an opportunity',
  description:
    'For a customer, a lead, or both. A lead that became a customer brings its customer along. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.opportunity.manage',
  feature: FEATURE,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: createOpportunitySchema,
  responses: {
    201: { description: 'The opportunity.', schema: opportunitySchema },
    404: {
      description: 'The customer (`customer_not_found`) or lead (`lead_not_found`) does not exist.',
    },
    422: {
      description:
        'Invalid; neither a customer nor a lead (`party_required`); an unknown stage (`stage_not_found`) or one that is not open (`stage_not_open`); or the owner is not an active member (`assignee_not_member`).',
    },
  },
  handler: async ({ body }, context) => {
    const { principal } = context;
    const created = await withTenant(principal.tenantId, async (tx) => {
      await requireParties(tx, body.customerId, body.leadId);
      let customerId = body.customerId ?? null;
      const leadId = body.leadId ?? null;
      if (customerId === null && leadId !== null) {
        customerId = (await tx.crmLeads.find(leadId))?.convertedCustomerId ?? null;
      }
      if (customerId === null && leadId === null) {
        throw partyRequired();
      }
      const opportunity = await createOpportunity(
        tx,
        principal,
        { ...toInput(body), title: body.title, customerId, leadId },
        body.stageId,
      );
      await crmAudit(tx, context, 'crm_opportunity.created', 'crm_opportunity', opportunity.id, {
        title: opportunity.title,
        customerId,
        leadId,
      });
      return (await opportunityBodies(tx, [opportunity]))[0]!;
    });
    return { status: 201, body: created };
  },
});

const eventSchema = z.object({
  kind: z.enum(OPPORTUNITY_EVENT_KINDS),
  fromStage: stageSchema.nullable(),
  toStage: stageSchema.nullable(),
  fromStatus: opportunityStatusSchema.nullable(),
  toStatus: opportunityStatusSchema.nullable(),
  reason: z.string().nullable(),
  actorId: z.uuid(),
  occurredAt: z.iso.datetime(),
});

export const opportunityDetailSchema = z.object({
  opportunity: opportunitySchema,
  /** Newest first. */
  events: z.array(eventSchema),
  /** The stages it can move to, in order: its own pipeline's. */
  stages: z.array(stageSchema),
  can: z.object({ edit: z.boolean() }),
});

async function eventBodies(tx: TenantTransaction, events: readonly OpportunityEvent[]) {
  const stages = new Map(
    (
      await tx.crmPipelines.findStages(
        events.flatMap((event) =>
          [event.fromStageId, event.toStageId].filter((id): id is string => id !== null),
        ),
      )
    ).map((stage) => [stage.id, stage]),
  );
  const stageOf = (id: string | null) => {
    const stage = id === null ? undefined : stages.get(id);
    return stage === undefined ? null : stageBody(stage);
  };
  return events.map((event) => ({
    kind: event.kind,
    fromStage: stageOf(event.fromStageId),
    toStage: stageOf(event.toStageId),
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    reason: event.reason,
    actorId: event.actorId,
    occurredAt: iso(event.occurredAt),
  }));
}

async function opportunityDetail(tx: TenantTransaction, principal: Principal, item: Opportunity) {
  const [body, events, stages] = await Promise.all([
    opportunityBodies(tx, [item]),
    tx.crmOpportunities.events(item.id),
    tx.crmPipelines.stages(item.pipelineId),
  ]);
  return {
    opportunity: body[0]!,
    events: await eventBodies(tx, events),
    stages: stages.map(stageBody),
    can: { edit: holds(principal, 'crm.opportunity.manage') },
  };
}

export const getOpportunityRoute = defineRoute({
  method: 'get',
  path: '/v1/crm/opportunities/:opportunityId',
  operationId: 'getOpportunity',
  summary: 'An opportunity, its history and the stages it can move to',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.read',
  feature: FEATURE,
  params: opportunityParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The opportunity.', schema: opportunityDetailSchema },
    404: { description: 'No such opportunity.' },
  },
  handler: async ({ params }, context) => {
    const { principal } = context;
    const body = await withTenant(principal.tenantId, async (tx) => {
      const item = await tx.crmOpportunities.find(params.opportunityId);
      if (item === undefined) {
        throw notFound('This opportunity does not exist.');
      }
      return opportunityDetail(tx, principal, item);
    });
    return { status: 200, body };
  },
});

const updateOpportunitySchema = z
  .object({
    ...opportunityFields,
    title: opportunityFields.title.optional(),
    /** The `version` of the opportunity as it was read. */
    expectedVersion: z.number().int().positive(),
    /** Archive (`true`) or restore (`false`). */
    archived: z.boolean().optional(),
  })
  .strict();

export const updateOpportunityRoute = defineRoute({
  method: 'patch',
  path: '/v1/crm/opportunities/:opportunityId',
  operationId: 'updateOpportunity',
  summary: 'Change an opportunity’s details',
  description:
    'Not its stage: that is `/transitions`, which records the move. Send `expectedVersion` as read; a newer version wins and this one is refused with 409 `version_conflict`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.opportunity.manage',
  feature: FEATURE,
  params: opportunityParams,
  query: noSchema,
  body: updateOpportunitySchema,
  responses: {
    200: { description: 'The opportunity as it is now.', schema: opportunitySchema },
    404: { description: 'No such opportunity, customer or lead.' },
    409: { description: 'Changed by somebody else since it was read (`version_conflict`).' },
    422: {
      description:
        'Invalid; it would be for neither a customer nor a lead (`party_required`); or the owner is not an active member (`assignee_not_member`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const updated = await withTenant(context.principal.tenantId, async (tx) => {
      const current = await tx.crmOpportunities.find(params.opportunityId);
      if (current === undefined) {
        throw notFound('This opportunity does not exist.');
      }
      await requireParties(tx, body.customerId, body.leadId);
      const customerId = body.customerId === undefined ? current.customerId : body.customerId;
      const leadId = body.leadId === undefined ? current.leadId : body.leadId;
      if (customerId === null && leadId === null) {
        throw partyRequired();
      }
      if (typeof body.ownerId === 'string') {
        await requireAssignableMember(tx, body.ownerId, 'body.ownerId');
      }

      const result = await tx.crmOpportunities.update(current.id, body.expectedVersion, {
        ...toInput(body),
        ...(body.archived === undefined ? {} : { archived: body.archived }),
      });
      if (result === 'not_found') {
        throw notFound('This opportunity does not exist.');
      }
      if (result === 'version_conflict') {
        throw versionConflict();
      }
      await crmAudit(tx, context, 'crm_opportunity.updated', 'crm_opportunity', result.id, {
        fields: Object.keys(body).filter(
          (key) =>
            key !== 'expectedVersion' && (body as Record<string, unknown>)[key] !== undefined,
        ),
        version: result.version,
      });
      return (await opportunityBodies(tx, [result]))[0]!;
    });
    return { status: 200, body: updated };
  },
});

export const moveOpportunityRoute = defineRoute({
  method: 'post',
  path: '/v1/crm/opportunities/:opportunityId/transitions',
  operationId: 'moveOpportunity',
  summary: 'Move an opportunity to another stage: forward, back, won, lost or reopened',
  description:
    'Any live stage of its own pipeline. Its status becomes the stage’s outcome and its chance the stage’s usual one; the move is recorded with who and when. Losing needs `lostReason`. Winning creates no invoice and no job.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.opportunity.manage',
  feature: FEATURE,
  params: opportunityParams,
  query: noSchema,
  body: z
    .object({
      expectedVersion: z.number().int().positive(),
      stageId: z.uuid(),
      lostReason: z.string().trim().max(1000).optional(),
    })
    .strict(),
  responses: {
    200: {
      description: 'The opportunity, its history and stages.',
      schema: opportunityDetailSchema,
    },
    404: { description: 'No such opportunity.' },
    409: { description: 'Changed by somebody else since it was read (`version_conflict`).' },
    422: {
      description:
        'Not a live stage of its pipeline, or where it already is (`invalid_transition`); archived (`opportunity_archived`); or lost without a reason (`lost_reason_required`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const { principal } = context;
    const detail = await withTenant(principal.tenantId, async (tx) => {
      const current = await tx.crmOpportunities.find(params.opportunityId);
      if (current === undefined) {
        throw notFound('This opportunity does not exist.');
      }
      if (current.archivedAt !== null) {
        throw unprocessable('opportunity_archived', 'Restore this opportunity before moving it.');
      }
      const [from, to] = await Promise.all([
        tx.crmPipelines.findStage(current.stageId),
        tx.crmPipelines.findStage(body.stageId),
      ]);
      if (from === undefined || to === undefined || !opportunityMoveAllowed(from, to)) {
        throw unprocessable(
          'invalid_transition',
          'Choose another live stage of this opportunity’s pipeline.',
          [
            {
              field: 'body.stageId',
              code: 'invalid_transition',
              message: 'Choose another live stage of this opportunity’s pipeline.',
            },
          ],
        );
      }
      const lostReason =
        body.lostReason === undefined || body.lostReason === '' ? null : body.lostReason;
      if (to.outcome === 'lost' && lostReason === null) {
        throw unprocessable('lost_reason_required', 'Say why it was lost.', [
          {
            field: 'body.lostReason',
            code: 'lost_reason_required',
            message: 'Say why it was lost.',
          },
        ]);
      }
      const kind = opportunityEventKind(from.outcome, to.outcome);
      const moved = await tx.crmOpportunities.move(current.id, body.expectedVersion, {
        from,
        to,
        kind,
        lostReason,
        actorId: principal.userId,
      });
      if (moved === 'not_found') {
        throw notFound('This opportunity does not exist.');
      }
      if (moved === 'version_conflict') {
        throw versionConflict();
      }
      await crmAudit(tx, context, `crm_opportunity.${kind}`, 'crm_opportunity', moved.id, {
        from: from.key,
        to: to.key,
        ...(lostReason === null ? {} : { lostReason }),
      });
      return opportunityDetail(tx, principal, moved);
    });
    return { status: 200, body: detail };
  },
});

export const opportunityRoutes = [
  listPipelinesRoute,
  listOpportunitiesRoute,
  createOpportunityRoute,
  getOpportunityRoute,
  updateOpportunityRoute,
  moveOpportunityRoute,
];
