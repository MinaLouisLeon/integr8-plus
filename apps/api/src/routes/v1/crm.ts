import {
  currencyCodeSchema,
  decimalAmountSchema,
  holds,
  leadSourceSchema,
  leadStatusSchema,
  leadTransitionAllowed,
  OPEN_LEAD_STATUSES,
} from '@integr8/core';
import { type Lead, type LeadInput, type TenantTransaction, withTenant } from '@integr8/db';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import { booleanQuery, many } from './operations.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * The CRM (CRM/ERP plan): leads in phase C1.
 *
 * Every route here needs the company's `crm` module as well as the seat's
 * permission (`feature: 'crm'`); see `http/features.ts`. Leads are archived,
 * never deleted, and edited with optimistic concurrency: an edit names the
 * version it read and loses, with 409 `version_conflict`, to a newer one.
 */

const TAGS = ['crm'];
const FEATURE = 'crm' as const;

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * Appends an audit entry for a CRM change. When Integr8 staff are acting as
 * the company, the entry says so: the seat's user did not make this change by
 * themselves, and a company reading its own history is owed that difference.
 */
export async function crmAudit(
  tx: TenantTransaction,
  context: RequestContext,
  action: string,
  resourceType: string,
  resourceId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  const { principal } = context;
  await tx.auditLog.append({
    actorKind: 'tenant_user',
    actorId: principal.userId,
    actorLabel: principal.userId,
    action,
    resourceType,
    resourceId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata:
      principal.impersonatedBy === undefined
        ? metadata
        : { ...metadata, impersonatedBy: principal.impersonatedBy },
  });
}

/** A member a lead (or anything else in the CRM) may be assigned to: in this company, and active. */
async function requireAssignableMember(tx: TenantTransaction, userId: string): Promise<void> {
  const member = await tx.tenantUsers.findByUserId(userId);
  if (member?.status !== 'active') {
    throw unprocessable(
      'assignee_not_member',
      'Assign the lead to an active member of your company.',
      [
        {
          field: 'body.assignedTo',
          code: 'assignee_not_member',
          message: 'Assign the lead to an active member of your company.',
        },
      ],
    );
  }
}

const versionConflict = () =>
  conflict(
    'version_conflict',
    'Somebody changed this since you opened it. Reload to see their change, then try again.',
  );

/** Opaque cursors for newest-first lists. */
function encodeDateCursor(next: { createdAt: Date; id: string } | undefined): string | null {
  return next === undefined
    ? null
    : Buffer.from(
        JSON.stringify({ at: next.createdAt.toISOString(), id: next.id }),
        'utf8',
      ).toString('base64url');
}

function decodeDateCursor(cursor: string | undefined): { createdAt: Date; id: string } | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    const result = z.object({ at: z.iso.datetime(), id: z.uuid() }).safeParse(parsed);
    return result.success ? { createdAt: new Date(result.data.at), id: result.data.id } : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export const leadSchema = z.object({
  id: z.uuid(),
  displayName: z.string(),
  companyName: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  source: leadSourceSchema,
  status: leadStatusSchema,
  assignedTo: z.uuid().nullable(),
  /** A decimal string, such as `1250.5`. Never a JSON number, so nothing rounds it. */
  estimatedValue: z.string().nullable(),
  currencyCode: z.string().nullable(),
  notes: z.string().nullable(),
  unqualifiedReason: z.string().nullable(),
  convertedCustomerId: z.uuid().nullable(),
  convertedContactId: z.uuid().nullable(),
  convertedAt: z.iso.datetime().nullable(),
  version: z.number().int(),
  createdBy: z.uuid(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
});

export function leadBody(lead: Lead): z.infer<typeof leadSchema> {
  return {
    id: lead.id,
    displayName: lead.displayName,
    companyName: lead.companyName,
    email: lead.email,
    phone: lead.phone,
    source: lead.source,
    status: lead.status,
    assignedTo: lead.assignedTo,
    estimatedValue: lead.estimatedValue,
    currencyCode: lead.currencyCode,
    notes: lead.notes,
    unqualifiedReason: lead.unqualifiedReason,
    convertedCustomerId: lead.convertedCustomerId,
    convertedContactId: lead.convertedContactId,
    convertedAt: isoOrNull(lead.convertedAt),
    version: lead.version,
    createdBy: lead.createdBy,
    createdAt: iso(lead.createdAt),
    updatedAt: iso(lead.updatedAt),
    archivedAt: isoOrNull(lead.archivedAt),
  };
}

const leadFields = {
  displayName: z.string().trim().min(1).max(200),
  companyName: z.string().trim().max(200).nullable().optional(),
  email: z.email().max(320).nullable().optional(),
  phone: z.string().trim().max(50).nullable().optional(),
  source: leadSourceSchema.optional(),
  /** Any status but `converted`, which only converting a lead reaches. */
  status: z.enum(OPEN_LEAD_STATUSES).optional(),
  assignedTo: z.uuid().nullable().optional(),
  estimatedValue: decimalAmountSchema.nullable().optional(),
  /** Defaults to the company's currency when a value is given without one. */
  currencyCode: currencyCodeSchema.nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
  unqualifiedReason: z.string().trim().max(1000).nullable().optional(),
};

const createLeadSchema = z.object(leadFields);

const updateLeadSchema = z
  .object({
    ...leadFields,
    displayName: leadFields.displayName.optional(),
    /** The `version` of the lead as it was read. */
    expectedVersion: z.number().int().positive(),
    /** Archive (`true`) or restore (`false`). */
    archived: z.boolean().optional(),
  })
  .strict();

/** What may still change on a converted lead: it is history, but annotatable and filable. */
const CONVERTED_EDITABLE = new Set(['notes', 'assignedTo', 'archived', 'expectedVersion']);

/** The lead fields a body carries, without the ones it left out. */
function toLeadInput(body: Readonly<Record<string, unknown>>): Partial<LeadInput> {
  const input: Partial<LeadInput> = {};
  for (const key of Object.keys(leadFields) as (keyof typeof leadFields)[]) {
    const value = body[key];
    if (value !== undefined) {
      (input as Record<string, unknown>)[key] = value;
    }
  }
  return input;
}

const leadParams = z.object({ leadId: z.uuid() });

export const listLeadsRoute = defineRoute({
  method: 'get',
  path: '/v1/crm/leads',
  operationId: 'listLeads',
  summary: 'Find leads',
  description:
    'Newest first, a page at a time. `q` matches words or their beginnings in the name, company, email or phone. Archived leads are left out unless `includeArchived=true`. `assignedTo` is a member id, `me`, or `none`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.read',
  feature: FEATURE,
  params: noSchema,
  query: z.object({
    q: z.string().trim().max(200).optional(),
    status: many(leadStatusSchema, 5),
    source: many(leadSourceSchema, 5),
    assignedTo: z.union([z.uuid(), z.literal('me'), z.literal('none')]).optional(),
    includeArchived: booleanQuery,
    cursor: z.string().max(500).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'A page of leads.',
      schema: z.object({ items: z.array(leadSchema), nextCursor: z.string().nullable() }),
    },
  },
  handler: async ({ query }, context) => {
    const after = decodeDateCursor(query.cursor);
    const assignedTo =
      query.assignedTo === undefined
        ? undefined
        : query.assignedTo === 'me'
          ? context.principal.userId
          : query.assignedTo === 'none'
            ? null
            : query.assignedTo;
    const page = await withTenant(context.principal.tenantId, (tx) =>
      tx.crmLeads.list({
        ...(query.q === undefined ? {} : { text: query.q }),
        statuses: query.status,
        sources: query.source,
        ...(assignedTo === undefined ? {} : { assignedTo }),
        includeArchived: query.includeArchived === 'true',
        ...(after === undefined ? {} : { after }),
        limit: query.limit,
      }),
    );
    return {
      status: 200,
      body: { items: page.items.map(leadBody), nextCursor: encodeDateCursor(page.next) },
    };
  },
});

export const createLeadRoute = defineRoute({
  method: 'post',
  path: '/v1/crm/leads',
  operationId: 'createLead',
  summary: 'Add a lead',
  description:
    'Saving a lead never creates a customer; converting it does. A value given without a currency is in the company’s currency. Honours `Idempotency-Key`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.lead.manage',
  feature: FEATURE,
  idempotent: true,
  params: noSchema,
  query: noSchema,
  body: createLeadSchema,
  responses: {
    201: { description: 'The lead.', schema: leadSchema },
    422: {
      description: 'Invalid, or the assignee is not an active member (`assignee_not_member`).',
    },
  },
  handler: async ({ body }, context) => {
    const lead = await withTenant(context.principal.tenantId, async (tx) => {
      if (body.assignedTo !== undefined && body.assignedTo !== null) {
        await requireAssignableMember(tx, body.assignedTo);
      }
      const input = toLeadInput(body);
      if (
        input.estimatedValue !== undefined &&
        input.estimatedValue !== null &&
        !input.currencyCode
      ) {
        input.currencyCode = (await tx.settings.get()).currency;
      }
      const created = await tx.crmLeads.create(
        { ...input, displayName: body.displayName },
        context.principal.userId,
      );
      await crmAudit(tx, context, 'crm_lead.created', 'crm_lead', created.id, {
        displayName: created.displayName,
        source: created.source,
        status: created.status,
      });
      return created;
    });
    return { status: 201, body: leadBody(lead) };
  },
});

export const leadDetailSchema = z.object({
  lead: leadSchema,
  can: z.object({
    edit: z.boolean(),
    convert: z.boolean(),
  }),
});

export const getLeadRoute = defineRoute({
  method: 'get',
  path: '/v1/crm/leads/:leadId',
  operationId: 'getLead',
  summary: 'A lead',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.read',
  feature: FEATURE,
  params: leadParams,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'The lead, and what this seat may do with it.', schema: leadDetailSchema },
    404: { description: 'No such lead.' },
  },
  handler: async ({ params }, context) => {
    const lead = await withTenant(context.principal.tenantId, (tx) =>
      tx.crmLeads.find(params.leadId),
    );
    if (lead === undefined) {
      throw notFound('This lead does not exist.');
    }
    const { principal } = context;
    return {
      status: 200,
      body: {
        lead: leadBody(lead),
        can: {
          edit: holds(principal, 'crm.lead.manage'),
          convert:
            holds(principal, 'crm.lead.convert') &&
            lead.status !== 'converted' &&
            lead.archivedAt === null,
        },
      },
    };
  },
});

export const updateLeadRoute = defineRoute({
  method: 'patch',
  path: '/v1/crm/leads/:leadId',
  operationId: 'updateLead',
  summary: 'Change, assign, qualify or archive a lead',
  description:
    'Send `expectedVersion` as read; a newer version wins and this one is refused with 409 `version_conflict`. A converted lead keeps its details: only notes, the assignee and archiving can change (409 `lead_already_converted` otherwise).',
  tags: TAGS,
  security: 'authenticated',
  permission: 'crm.lead.manage',
  feature: FEATURE,
  params: leadParams,
  query: noSchema,
  body: updateLeadSchema,
  responses: {
    200: { description: 'The lead as it is now.', schema: leadSchema },
    404: { description: 'No such lead.' },
    409: {
      description:
        'Changed by somebody else since it was read (`version_conflict`), or converted (`lead_already_converted`).',
    },
    422: {
      description:
        'Invalid, an impossible status change (`invalid_transition`), or the assignee is not an active member (`assignee_not_member`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const lead = await withTenant(context.principal.tenantId, async (tx) => {
      const current = await tx.crmLeads.find(params.leadId);
      if (current === undefined) {
        throw notFound('This lead does not exist.');
      }

      const sent = Object.keys(body).filter(
        (key) => (body as Record<string, unknown>)[key] !== undefined,
      );
      if (current.status === 'converted' && sent.some((key) => !CONVERTED_EDITABLE.has(key))) {
        throw conflict(
          'lead_already_converted',
          'This lead has been converted. Its details now live on the customer; only notes, the assignee and archiving can change here.',
        );
      }
      if (body.status !== undefined && !leadTransitionAllowed(current.status, body.status)) {
        throw unprocessable(
          'invalid_transition',
          `A lead cannot move from ${current.status} to ${body.status}.`,
        );
      }
      if (body.assignedTo !== undefined && body.assignedTo !== null) {
        await requireAssignableMember(tx, body.assignedTo);
      }

      const input = toLeadInput(body);
      // A value always has a currency: when the lead would end up with one and
      // not the other, the company's currency fills the gap.
      const value =
        input.estimatedValue === undefined ? current.estimatedValue : input.estimatedValue;
      const currency = input.currencyCode === undefined ? current.currencyCode : input.currencyCode;
      if (value !== null && !currency) {
        input.currencyCode = (await tx.settings.get()).currency;
      }

      const updated = await tx.crmLeads.update(current.id, body.expectedVersion, {
        ...input,
        ...(body.archived === undefined ? {} : { archived: body.archived }),
      });
      if (updated === 'not_found') {
        throw notFound('This lead does not exist.');
      }
      if (updated === 'version_conflict') {
        throw versionConflict();
      }

      await crmAudit(tx, context, 'crm_lead.updated', 'crm_lead', updated.id, {
        fields: sent.filter((key) => key !== 'expectedVersion'),
        version: updated.version,
      });
      if (updated.status !== current.status) {
        await crmAudit(tx, context, 'crm_lead.status_changed', 'crm_lead', updated.id, {
          from: current.status,
          to: updated.status,
        });
      }
      if ((current.archivedAt === null) !== (updated.archivedAt === null)) {
        await crmAudit(
          tx,
          context,
          updated.archivedAt === null ? 'crm_lead.restored' : 'crm_lead.archived',
          'crm_lead',
          updated.id,
        );
      }
      return updated;
    });
    return { status: 200, body: leadBody(lead) };
  },
});

export const crmRoutes = [listLeadsRoute, createLeadRoute, getLeadRoute, updateLeadRoute];
