import {
  calendarDaySchema,
  expiryState,
  holds,
  HOLDING_STATUSES,
  QUALIFICATION_KINDS,
  QUALIFICATION_WARNING_DAYS_MAX,
  QUALIFICATION_WARNING_DAYS_MIN,
  requirementsMet,
  visitDays,
} from '@integr8/core';
import type {
  MemberQualification,
  MemberQualificationWrite,
  QualificationType,
  QualificationTypeWrite,
  TenantTransaction,
} from '@integr8/db';
import { withTenant } from '@integr8/db';
import { z } from 'zod';
import { conflict, notFound, unprocessable } from '../../http/errors.js';
import { defineRoute, noSchema, type RequestContext } from '../../http/routes.js';
import {
  attachmentBodies,
  attachmentSchema,
  booleanQuery,
  many,
  peopleOf,
  type People,
  personBody,
  personSchema,
  readableWorkOrder,
} from './operations.js';
import { companyClock } from './qualification-check.js';
import { iso, isoOrNull } from './schemas.js';

/**
 * Skills and certificates (P26).
 *
 * The company keeps a list of qualifications; people hold them; job types and
 * jobs say which they need. Owners, admins and HR managers keep the records
 * (`qualification.manage`); the dispatcher and anyone else who plans reads them
 * (`qualification.read`). Everyone sees their own, which is what the phone shows.
 *
 * Not part of the HR module: a company without it needs them too.
 */

const TAGS = ['qualifications'];

const kindSchema = z.enum(QUALIFICATION_KINDS);
const typeParams = z.object({ qualificationTypeId: z.uuid() });
const recordParams = z.object({ qualificationId: z.uuid() });

const typeSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: kindSchema,
  description: z.string().nullable(),
  version: z.number().int(),
  archived: z.boolean(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
});

const settingsSchema = z.object({
  /** Days before a certificate expires that its holder and the managers are warned. */
  warningDays: z.number().int(),
});

const recordSchema = z.object({
  id: z.uuid(),
  person: personSchema,
  qualificationType: z.object({ id: z.uuid(), name: z.string(), kind: kindSchema }),
  /** The certificate's number. */
  reference: z.string().nullable(),
  /** Calendar days, `YYYY-MM-DD`. The expiry is the last day it is valid. */
  issuedOn: z.string().nullable(),
  expiresOn: z.string().nullable(),
  notes: z.string().nullable(),
  /** Where it stands today, in the company's time zone and warning period. */
  state: z.enum(['no_expiry', 'valid', 'expiring', 'expired', 'removed']),
  version: z.number().int(),
  /** Scans of the certificate. */
  attachments: z.array(attachmentSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  removedAt: z.string().nullable(),
  removedBy: personSchema.nullable(),
});

const requirementSchema = z.object({
  qualificationTypeId: z.uuid(),
  name: z.string(),
  kind: kindSchema,
  /** An archived qualification is nobody's requirement any more; shown so it can be taken off. */
  archived: z.boolean(),
});

const typeIdsSchema = z
  .array(z.uuid())
  .max(20)
  .refine((ids) => new Set(ids).size === ids.length, 'Each qualification once');

const dateInput = calendarDaySchema.nullable().optional();

// ---------------------------------------------------------------------------

function typeBody(type: QualificationType) {
  return {
    id: type.id,
    name: type.name,
    kind: type.kind,
    description: type.description,
    version: type.version,
    archived: type.archivedAt !== null,
    archivedAt: isoOrNull(type.archivedAt),
    createdAt: iso(type.createdAt),
  };
}

async function recordBodies(
  tx: TenantTransaction,
  records: readonly MemberQualification[],
  people?: People,
) {
  if (records.length === 0) {
    return [];
  }
  const [types, names, settings, clock] = await Promise.all([
    tx.qualifications.findTypes(records.map((record) => record.qualificationTypeId)),
    people === undefined ? peopleOf(tx) : Promise.resolve(people),
    tx.settings.get(),
    companyClock(tx),
  ]);
  const typeById = new Map(types.map((type) => [type.id, type]));
  return Promise.all(
    records.map(async (record) => {
      const type = typeById.get(record.qualificationTypeId);
      return {
        id: record.id,
        person: personBody(record.userId, names),
        qualificationType: {
          id: record.qualificationTypeId,
          name: type?.name ?? '',
          kind: type?.kind ?? 'certificate',
        },
        reference: record.reference,
        issuedOn: record.issuedOn,
        expiresOn: record.expiresOn,
        notes: record.notes,
        state:
          record.removedAt !== null
            ? ('removed' as const)
            : expiryState(record.expiresOn, clock.today, settings.qualificationWarningDays),
        version: record.version,
        attachments: await attachmentBodies(
          tx,
          await tx.attachments.list({ memberQualificationId: record.id }),
          names,
        ),
        createdAt: iso(record.createdAt),
        updatedAt: iso(record.updatedAt),
        removedAt: isoOrNull(record.removedAt),
        removedBy: record.removedBy === null ? null : personBody(record.removedBy, names),
      };
    }),
  );
}

async function requirementBodies(tx: TenantTransaction, typeIds: readonly string[]) {
  const types = new Map(
    (await tx.qualifications.findTypes(typeIds)).map((type) => [type.id, type]),
  );
  return typeIds.flatMap((typeId) => {
    const type = types.get(typeId);
    return type === undefined
      ? []
      : [
          {
            qualificationTypeId: type.id,
            name: type.name,
            kind: type.kind,
            archived: type.archivedAt !== null,
          },
        ];
  });
}

/** Every qualification named exists and is still in use. */
async function requireLiveTypes(tx: TenantTransaction, typeIds: readonly string[]) {
  const types = new Map(
    (await tx.qualifications.findTypes(typeIds)).map((type) => [type.id, type]),
  );
  typeIds.forEach((typeId, index) => {
    const type = types.get(typeId);
    if (type === undefined) {
      throw unprocessable('qualification_type_unknown', 'A qualification named does not exist.', [
        {
          field: `body.qualificationTypeIds.${String(index)}`,
          code: 'qualification_type_unknown',
          message: 'Choose one of the company’s qualifications.',
        },
      ]);
    }
    if (type.archivedAt !== null) {
      throw unprocessable(
        'qualification_type_archived',
        `${type.name} is archived. Restore it first.`,
        [
          {
            field: `body.qualificationTypeIds.${String(index)}`,
            code: 'qualification_type_archived',
            message: `${type.name} is archived.`,
          },
        ],
      );
    }
  });
}

function typeRefusal(result: Exclude<QualificationTypeWrite, { outcome: 'written' }>): never {
  switch (result.outcome) {
    case 'not_found':
      throw notFound('This qualification does not exist.');
    case 'conflict':
      throw conflict(
        'qualification_type_changed',
        'This qualification was changed elsewhere since you loaded it. Reload and try again.',
      );
    case 'name_taken':
      throw unprocessable('qualification_name_taken', 'Another qualification has this name.', [
        {
          field: 'body.name',
          code: 'qualification_name_taken',
          message: 'Another qualification has this name.',
        },
      ]);
  }
}

function recordRefusal(result: Exclude<MemberQualificationWrite, { outcome: 'written' }>): never {
  switch (result.outcome) {
    case 'not_found':
      throw notFound('This record does not exist.');
    case 'conflict':
      throw conflict(
        'qualification_changed',
        'This record was changed elsewhere since you loaded it. Reload and try again.',
      );
    case 'removed':
      throw conflict(
        'qualification_removed',
        'This record was removed, so it can no longer change. Add a new one instead.',
      );
    case 'type_unknown':
      throw unprocessable('qualification_type_unknown', 'This qualification does not exist.', [
        {
          field: 'body.qualificationTypeId',
          code: 'qualification_type_unknown',
          message: 'Choose one of the company’s qualifications.',
        },
      ]);
    case 'type_archived':
      throw unprocessable(
        'qualification_type_archived',
        'This qualification is archived. Restore it first.',
        [
          {
            field: 'body.qualificationTypeId',
            code: 'qualification_type_archived',
            message: 'This qualification is archived.',
          },
        ],
      );
    case 'member_unknown':
      throw unprocessable('qualification_member_unknown', 'This person is not in the company.', [
        {
          field: 'body.userId',
          code: 'qualification_member_unknown',
          message: 'Choose a member of the company.',
        },
      ]);
    case 'skill_expires':
      throw unprocessable('qualification_skill_expires', 'A skill does not expire.', [
        {
          field: 'body.expiresOn',
          code: 'qualification_skill_expires',
          message: 'Leave the expiry empty for a skill.',
        },
      ]);
    case 'dates_reversed':
      throw unprocessable(
        'qualification_dates_reversed',
        'The expiry date must be on or after the issue date.',
        [
          {
            field: 'body.expiresOn',
            code: 'qualification_dates_reversed',
            message: 'Choose a later expiry date.',
          },
        ],
      );
  }
}

async function auditQualification(
  tx: TenantTransaction,
  context: RequestContext,
  action: string,
  resourceId: string,
  resourceType: 'qualification_type' | 'member_qualification' | 'job_type' | 'tenant_settings',
  metadata: Record<string, unknown>,
) {
  await tx.auditLog.append({
    actorKind: 'tenant_user',
    actorId: context.principal.userId,
    actorLabel: context.principal.userId,
    action,
    resourceType,
    resourceId,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata,
  });
}

// ---------------------------------------------------------------------------
// The company's list
// ---------------------------------------------------------------------------

export const listQualificationTypesRoute = defineRoute({
  method: 'get',
  path: '/v1/qualification-types',
  operationId: 'listQualificationTypes',
  summary: 'The company’s skills and certificates',
  description:
    'By name. Archived ones only with `includeArchived`. With the expiry warning period, and whether this person may change them.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'qualification.read',
  params: noSchema,
  query: z.object({ includeArchived: booleanQuery }),
  body: noSchema,
  responses: {
    200: {
      description: 'The list.',
      schema: z.object({
        items: z.array(typeSchema),
        settings: settingsSchema,
        can: z.object({ manage: z.boolean() }),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const [types, settings] = await Promise.all([
        tx.qualifications.listTypes({ includeArchived: query.includeArchived === 'true' }),
        tx.settings.get(),
      ]);
      return {
        items: types.map(typeBody),
        settings: { warningDays: settings.qualificationWarningDays },
        can: { manage: holds(context.principal, 'qualification.manage') },
      };
    });
    return { status: 200, body };
  },
});

export const createQualificationTypeRoute = defineRoute({
  method: 'post',
  path: '/v1/qualification-types',
  operationId: 'createQualificationType',
  summary: 'Add a skill or certificate to the company’s list',
  description:
    'A skill never expires; a certificate may. The kind cannot change afterwards. Names are unique, whatever their case.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'qualification.manage',
  params: noSchema,
  query: noSchema,
  body: z.object({
    name: z.string().trim().min(1).max(120),
    kind: kindSchema,
    description: z.string().trim().max(1000).nullable().optional(),
  }),
  responses: {
    201: { description: 'The qualification.', schema: typeSchema },
    422: { description: 'The name is taken (`qualification_name_taken`).' },
  },
  handler: async ({ body }, context) => {
    const created = await withTenant(context.principal.tenantId, async (tx) => {
      const result = await tx.qualifications.createType(
        { name: body.name, kind: body.kind, description: body.description ?? null },
        context.principal.userId,
      );
      if (result.outcome !== 'written') {
        typeRefusal(result);
      }
      await auditQualification(
        tx,
        context,
        'qualification_type.created',
        result.type.id,
        'qualification_type',
        {
          name: result.type.name,
          kind: result.type.kind,
        },
      );
      return typeBody(result.type);
    });
    return { status: 201, body: created };
  },
});

export const updateQualificationTypeRoute = defineRoute({
  method: 'patch',
  path: '/v1/qualification-types/:qualificationTypeId',
  operationId: 'updateQualificationType',
  summary: 'Rename, describe, archive or restore a qualification',
  description:
    'An archived qualification takes no new records and stops being required by any job; records already held stay.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'qualification.manage',
  params: typeParams,
  query: noSchema,
  body: z
    .object({
      expectedVersion: z.number().int().min(1),
      name: z.string().trim().min(1).max(120).optional(),
      description: z.string().trim().max(1000).nullable().optional(),
      archived: z.boolean().optional(),
    })
    .refine(
      (value) =>
        value.name !== undefined || value.description !== undefined || value.archived !== undefined,
      'Change at least one thing',
    ),
  responses: {
    200: { description: 'The qualification.', schema: typeSchema },
    404: { description: 'No such qualification.' },
    409: { description: 'Changed elsewhere (`qualification_type_changed`).' },
    422: { description: 'The name is taken (`qualification_name_taken`).' },
  },
  handler: async ({ params, body }, context) => {
    const updated = await withTenant(context.principal.tenantId, async (tx) => {
      const result = await tx.qualifications.updateType(
        params.qualificationTypeId,
        body.expectedVersion,
        {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.description === undefined ? {} : { description: body.description }),
          ...(body.archived === undefined ? {} : { archived: body.archived }),
        },
      );
      if (result.outcome !== 'written') {
        typeRefusal(result);
      }
      await auditQualification(
        tx,
        context,
        'qualification_type.updated',
        result.type.id,
        'qualification_type',
        {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.archived === undefined ? {} : { archived: body.archived }),
        },
      );
      return typeBody(result.type);
    });
    return { status: 200, body: updated };
  },
});

export const updateQualificationSettingsRoute = defineRoute({
  method: 'patch',
  path: '/v1/qualification-settings',
  operationId: 'updateQualificationSettings',
  summary: 'How early people hear that a certificate is expiring',
  description: `Between ${String(QUALIFICATION_WARNING_DAYS_MIN)} and ${String(QUALIFICATION_WARNING_DAYS_MAX)} days. Certificates already warned about are not warned again.`,
  tags: TAGS,
  security: 'authenticated',
  permission: 'qualification.manage',
  params: noSchema,
  query: noSchema,
  body: z.object({
    warningDays: z
      .number()
      .int()
      .min(QUALIFICATION_WARNING_DAYS_MIN)
      .max(QUALIFICATION_WARNING_DAYS_MAX),
  }),
  responses: {
    200: { description: 'The settings.', schema: settingsSchema },
  },
  handler: async ({ body }, context) => {
    const settings = await withTenant(context.principal.tenantId, async (tx) => {
      const saved = await tx.settings.update({ qualificationWarningDays: body.warningDays });
      await auditQualification(
        tx,
        context,
        'qualification_settings.updated',
        context.principal.tenantId,
        'tenant_settings',
        {
          warningDays: body.warningDays,
        },
      );
      return { warningDays: saved.qualificationWarningDays };
    });
    return { status: 200, body: settings };
  },
});

// ---------------------------------------------------------------------------
// What people hold
// ---------------------------------------------------------------------------

export const listQualificationsRoute = defineRoute({
  method: 'get',
  path: '/v1/qualifications',
  operationId: 'listQualifications',
  summary: 'Who holds what',
  description:
    'Every current record, or those of the people (`userId`) and qualifications (`qualificationTypeId`) asked for; removed ones only with `includeRemoved`. With the active members and the company’s list, so a screen can show who holds nothing.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'qualification.read',
  params: noSchema,
  query: z.object({
    userId: many(z.uuid(), 200),
    qualificationTypeId: many(z.uuid(), 200),
    includeRemoved: booleanQuery,
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'The records.',
      schema: z.object({
        items: z.array(recordSchema),
        people: z.array(z.object({ id: z.uuid(), name: z.string(), role: z.string() })),
        qualificationTypes: z.array(typeSchema),
        settings: settingsSchema,
        /** Today in the company's time zone, which `state` is judged against. */
        today: z.string(),
        can: z.object({ manage: z.boolean() }),
      }),
    },
  },
  handler: async ({ query }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const [records, members, types, settings, clock, people] = await Promise.all([
        // `many` turns a missing filter into an empty list, which means "all" here.
        tx.qualifications.listRecords({
          ...(query.userId.length === 0 ? {} : { userIds: query.userId }),
          ...(query.qualificationTypeId.length === 0 ? {} : { typeIds: query.qualificationTypeId }),
          includeRemoved: query.includeRemoved === 'true',
        }),
        tx.tenantUsers.list(),
        tx.qualifications.listTypes({ includeArchived: true }),
        tx.settings.get(),
        companyClock(tx),
        peopleOf(tx),
      ]);
      return {
        items: await recordBodies(tx, records, people),
        people: members
          .filter((member) => member.status === 'active')
          .map((member) => ({ id: member.userId, name: member.displayName, role: member.role })),
        qualificationTypes: types.map(typeBody),
        settings: { warningDays: settings.qualificationWarningDays },
        today: clock.today,
        can: { manage: holds(context.principal, 'qualification.manage') },
      };
    });
    return { status: 200, body };
  },
});

/** A member's own records, as `/v1/me/qualifications` and a sync give them. */
export const myQualificationsSchema = z.object({
  items: z.array(recordSchema),
  settings: settingsSchema,
  today: z.string(),
});

export const myQualificationsRoute = defineRoute({
  method: 'get',
  path: '/v1/me/qualifications',
  operationId: 'listMyQualifications',
  summary: 'The skills and certificates I hold',
  description:
    'Everyone may read their own. Current records only, with where each stands today. The phone also receives these with every sync.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'tenant.read',
  params: noSchema,
  query: noSchema,
  body: noSchema,
  responses: {
    200: { description: 'Their records.', schema: myQualificationsSchema },
  },
  handler: async (_input, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) =>
      myQualificationsBody(tx, context.principal.userId),
    );
    return { status: 200, body };
  },
});

/** A member's own current records: the `/v1/me` answer, and what a sync carries. */
export async function myQualificationsBody(tx: TenantTransaction, userId: string) {
  const [records, settings, clock] = await Promise.all([
    tx.qualifications.listRecords({ userIds: [userId] }),
    tx.settings.get(),
    companyClock(tx),
  ]);
  return {
    items: await recordBodies(tx, records),
    settings: { warningDays: settings.qualificationWarningDays },
    today: clock.today,
  };
}

export const addQualificationRoute = defineRoute({
  method: 'post',
  path: '/v1/qualifications',
  operationId: 'addQualification',
  summary: 'Record a skill or certificate someone holds',
  description:
    'A renewal is a new record: the old one stays, expired, as the history of what was held. Attach a scan with `POST /v1/attachments` and `{ memberQualificationId }`.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'qualification.manage',
  params: noSchema,
  query: noSchema,
  body: z.object({
    userId: z.uuid(),
    qualificationTypeId: z.uuid(),
    reference: z.string().trim().max(120).nullable().optional(),
    issuedOn: dateInput,
    expiresOn: dateInput,
    notes: z.string().trim().max(1000).nullable().optional(),
  }),
  responses: {
    201: { description: 'The record.', schema: recordSchema },
    422: {
      description:
        'No such qualification (`qualification_type_unknown`) or it is archived (`qualification_type_archived`); no such member (`qualification_member_unknown`); an expiry on a skill (`qualification_skill_expires`); an expiry before the issue date (`qualification_dates_reversed`).',
    },
  },
  handler: async ({ body }, context) => {
    const created = await withTenant(context.principal.tenantId, async (tx) => {
      const member = (await tx.tenantUsers.list()).find((entry) => entry.userId === body.userId);
      if (member === undefined) {
        recordRefusal({ outcome: 'member_unknown' });
      }
      const result = await tx.qualifications.addRecord(
        {
          userId: body.userId,
          qualificationTypeId: body.qualificationTypeId,
          reference: body.reference ?? null,
          issuedOn: body.issuedOn ?? null,
          expiresOn: body.expiresOn ?? null,
          notes: body.notes ?? null,
        },
        context.principal.userId,
      );
      if (result.outcome !== 'written') {
        recordRefusal(result);
      }
      await auditQualification(
        tx,
        context,
        'member_qualification.added',
        result.record.id,
        'member_qualification',
        {
          userId: body.userId,
          qualificationTypeId: body.qualificationTypeId,
          expiresOn: body.expiresOn ?? null,
        },
      );
      const [shaped] = await recordBodies(tx, [result.record]);
      return shaped!;
    });
    return { status: 201, body: created };
  },
});

export const updateQualificationRoute = defineRoute({
  method: 'patch',
  path: '/v1/qualifications/:qualificationId',
  operationId: 'updateQualification',
  summary: 'Correct a record’s number, dates or notes',
  description:
    'For a mistake. A renewed certificate is a new record. New dates mean the expiry alerts go out again when due.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'qualification.manage',
  params: recordParams,
  query: noSchema,
  body: z
    .object({
      expectedVersion: z.number().int().min(1),
      reference: z.string().trim().max(120).nullable().optional(),
      issuedOn: dateInput,
      expiresOn: dateInput,
      notes: z.string().trim().max(1000).nullable().optional(),
    })
    .refine(
      (value) =>
        value.reference !== undefined ||
        value.issuedOn !== undefined ||
        value.expiresOn !== undefined ||
        value.notes !== undefined,
      'Change at least one thing',
    ),
  responses: {
    200: { description: 'The record.', schema: recordSchema },
    404: { description: 'No such record.' },
    409: {
      description:
        'Changed elsewhere (`qualification_changed`), or removed (`qualification_removed`).',
    },
    422: {
      description:
        'An expiry on a skill (`qualification_skill_expires`), or before the issue date (`qualification_dates_reversed`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const updated = await withTenant(context.principal.tenantId, async (tx) => {
      const result = await tx.qualifications.updateRecord(
        params.qualificationId,
        body.expectedVersion,
        {
          ...(body.reference === undefined ? {} : { reference: body.reference }),
          ...(body.issuedOn === undefined ? {} : { issuedOn: body.issuedOn }),
          ...(body.expiresOn === undefined ? {} : { expiresOn: body.expiresOn }),
          ...(body.notes === undefined ? {} : { notes: body.notes }),
        },
      );
      if (result.outcome !== 'written') {
        recordRefusal(result);
      }
      await auditQualification(
        tx,
        context,
        'member_qualification.updated',
        result.record.id,
        'member_qualification',
        {
          ...(body.issuedOn === undefined ? {} : { issuedOn: body.issuedOn }),
          ...(body.expiresOn === undefined ? {} : { expiresOn: body.expiresOn }),
        },
      );
      const [shaped] = await recordBodies(tx, [result.record]);
      return shaped!;
    });
    return { status: 200, body: updated };
  },
});

export const removeQualificationRoute = defineRoute({
  method: 'post',
  path: '/v1/qualifications/:qualificationId/remove',
  operationId: 'removeQualification',
  summary: 'Take a record away',
  description:
    'Final. The record stays in the history, marked removed, and no longer counts for any visit.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'qualification.manage',
  params: recordParams,
  query: noSchema,
  body: z.object({ expectedVersion: z.number().int().min(1) }),
  responses: {
    200: { description: 'The record, removed.', schema: recordSchema },
    404: { description: 'No such record.' },
    409: {
      description:
        'Changed elsewhere (`qualification_changed`), or already removed (`qualification_removed`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const removed = await withTenant(context.principal.tenantId, async (tx) => {
      const result = await tx.qualifications.removeRecord(
        params.qualificationId,
        body.expectedVersion,
        context.principal.userId,
      );
      if (result.outcome !== 'written') {
        recordRefusal(result);
      }
      await auditQualification(
        tx,
        context,
        'member_qualification.removed',
        result.record.id,
        'member_qualification',
        {
          userId: result.record.userId,
          qualificationTypeId: result.record.qualificationTypeId,
        },
      );
      const [shaped] = await recordBodies(tx, [result.record]);
      return shaped!;
    });
    return { status: 200, body: removed };
  },
});

// ---------------------------------------------------------------------------
// What jobs need
// ---------------------------------------------------------------------------

const requirementsResponseSchema = z.object({ requiredQualifications: z.array(requirementSchema) });

export const setJobTypeQualificationsRoute = defineRoute({
  method: 'put',
  path: '/v1/job-types/:jobTypeId/qualifications',
  operationId: 'setJobTypeQualifications',
  summary: 'Set what a job type’s jobs need',
  description:
    'Replaces the list. Jobs created afterwards copy it; jobs already created keep their own. Integr8 staff, and the company’s owners, admins and HR managers (product decision, 2026-10-27).',
  tags: TAGS,
  security: 'authenticated',
  anyPermission: ['job_type.manage', 'qualification.manage'],
  params: z.object({ jobTypeId: z.uuid() }),
  query: noSchema,
  body: z.object({ qualificationTypeIds: typeIdsSchema }),
  responses: {
    200: { description: 'The job type’s requirements.', schema: requirementsResponseSchema },
    404: { description: 'No such job type.' },
    422: {
      description:
        'A qualification does not exist (`qualification_type_unknown`) or is archived (`qualification_type_archived`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const result = await withTenant(context.principal.tenantId, async (tx) => {
      if ((await tx.jobTypes.find(params.jobTypeId)) === undefined) {
        throw notFound('This job type does not exist.');
      }
      const current =
        (await tx.qualifications.jobTypeRequirements([params.jobTypeId])).get(params.jobTypeId) ??
        [];
      // An archived one already there may stay; a new one must be in use.
      await requireLiveTypes(
        tx,
        body.qualificationTypeIds.filter((typeId) => !current.includes(typeId)),
      );
      await tx.qualifications.setJobTypeRequirements(
        params.jobTypeId,
        body.qualificationTypeIds,
        context.principal.userId,
      );
      await auditQualification(
        tx,
        context,
        'job_type.qualifications_set',
        params.jobTypeId,
        'job_type',
        {
          qualificationTypeIds: body.qualificationTypeIds,
        },
      );
      return { requiredQualifications: await requirementBodies(tx, body.qualificationTypeIds) };
    });
    return { status: 200, body: result };
  },
});

/** A job type's requirements, for the job type screen. */
export async function jobTypeRequirementBodies(tx: TenantTransaction, jobTypeId: string) {
  const ids = (await tx.qualifications.jobTypeRequirements([jobTypeId])).get(jobTypeId) ?? [];
  return requirementBodies(tx, ids);
}

export const setWorkOrderQualificationsRoute = defineRoute({
  method: 'put',
  path: '/v1/work-orders/:workOrderId/qualifications',
  operationId: 'setWorkOrderQualifications',
  summary: 'Set what one job needs',
  description:
    'Replaces the job’s own list, copied from its job type when it was created. Visits already planned are checked against it from now on; nothing already planned is changed.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.manage',
  params: z.object({ workOrderId: z.uuid() }),
  query: noSchema,
  body: z.object({ qualificationTypeIds: typeIdsSchema }),
  responses: {
    200: { description: 'The job’s requirements.', schema: requirementsResponseSchema },
    404: { description: 'No such work order.' },
    409: { description: 'The job is closed (`work_order_closed`).' },
    422: {
      description:
        'A qualification does not exist (`qualification_type_unknown`) or is archived (`qualification_type_archived`).',
    },
  },
  handler: async ({ params, body }, context) => {
    const result = await withTenant(context.principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, context.principal, params.workOrderId);
      if (['complete', 'reviewed', 'cancelled'].includes(job.state)) {
        throw conflict('work_order_closed', 'This job is closed; what it needs cannot change.');
      }
      await requireLiveTypes(tx, body.qualificationTypeIds);
      await tx.qualifications.setWorkOrderRequirements(
        job.id,
        body.qualificationTypeIds,
        context.principal.userId,
      );
      await tx.auditLog.append({
        actorKind: 'tenant_user',
        actorId: context.principal.userId,
        actorLabel: context.principal.userId,
        action: 'work_order.qualifications_set',
        resourceType: 'work_order',
        resourceId: job.id,
        requestId: context.requestId,
        ipAddress: context.ipAddress,
        userAgent: context.userAgent,
        metadata: { qualificationTypeIds: body.qualificationTypeIds },
      });
      return { requiredQualifications: await requirementBodies(tx, body.qualificationTypeIds) };
    });
    return { status: 200, body: result };
  },
});

export const workOrderEligibilityRoute = defineRoute({
  method: 'get',
  path: '/v1/work-orders/:workOrderId/eligibility',
  operationId: 'getWorkOrderEligibility',
  summary: 'Who holds what a job needs, for a visit’s dates',
  description:
    'Every active member, with how many of the job’s requirements they meet on the visit’s days and where each stands: those meeting most first, then by name. For the people picker; nobody is left out, since going ahead with a reason is allowed.',
  tags: TAGS,
  security: 'authenticated',
  permission: 'work_order.read_all',
  params: z.object({ workOrderId: z.uuid() }),
  query: z.object({
    startsAt: z.iso.datetime({ offset: true }),
    endsAt: z.iso.datetime({ offset: true }),
  }),
  body: noSchema,
  responses: {
    200: {
      description: 'The requirements, and everyone ranked against them.',
      schema: z.object({
        requirements: z.array(z.object({ qualificationTypeId: z.uuid(), name: z.string() })),
        people: z.array(
          z.object({
            id: z.uuid(),
            name: z.string(),
            role: z.string(),
            met: z.number().int(),
            statuses: z.array(
              z.object({ qualificationTypeId: z.uuid(), status: z.enum(HOLDING_STATUSES) }),
            ),
          }),
        ),
      }),
    },
    404: { description: 'No such work order.' },
  },
  handler: async ({ params, query }, context) => {
    const body = await withTenant(context.principal.tenantId, async (tx) => {
      const job = await readableWorkOrder(tx, context.principal, params.workOrderId);
      const [requirementMap, members, clock] = await Promise.all([
        tx.qualifications.workOrderRequirements([job.id]),
        tx.tenantUsers.list(),
        companyClock(tx),
      ]);
      const requirements = requirementMap.get(job.id) ?? [];
      const active = members.filter((member) => member.status === 'active');
      const holdings =
        requirements.length === 0
          ? []
          : await tx.qualifications.holdings(
              active.map((member) => member.userId),
              requirements.map((requirement) => requirement.qualificationTypeId),
            );
      const days = visitDays(
        { startsAt: new Date(query.startsAt), endsAt: new Date(query.endsAt) },
        clock.timeZone,
      );
      const people = active
        .map((member) => {
          const result = requirementsMet(member.userId, requirements, holdings, days, clock.today);
          return {
            id: member.userId,
            name: member.displayName,
            role: member.role,
            met: result.met,
            statuses: result.statuses,
          };
        })
        .sort((a, b) => b.met - a.met || a.name.localeCompare(b.name));
      return { requirements, people };
    });
    return { status: 200, body };
  },
});

export const qualificationRoutes = [
  listQualificationTypesRoute,
  createQualificationTypeRoute,
  updateQualificationTypeRoute,
  updateQualificationSettingsRoute,
  listQualificationsRoute,
  myQualificationsRoute,
  addQualificationRoute,
  updateQualificationRoute,
  removeQualificationRoute,
  setJobTypeQualificationsRoute,
  setWorkOrderQualificationsRoute,
  workOrderEligibilityRoute,
];
