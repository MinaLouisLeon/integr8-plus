import { getPlatformDataSource } from '@integr8/db';
import { z } from 'zod';
import {
  defineRoute,
  noSchema,
  type PlatformRequestContext,
  type PublicRequestContext,
} from '../../../http/routes.js';
import { iso, isoOrNull } from '../schemas.js';
import { platformAuditEntrySchema, platformAuditPageSchema } from './schemas.js';

/**
 * The platform audit log, and the one way to write to it (P15).
 *
 * Everything a super admin does goes through {@link recordPlatformAction}.
 * The table refuses update, delete and truncate for every role including the
 * schema owner, so this is append-only in the database rather than by
 * convention — which is what makes it worth anything in an investigation.
 *
 * Where an action concerns a company, the company's own `audit_log` gets an
 * entry too. That one is the customer's record and they can see it; this one is
 * ours and outlives the company.
 */

export interface PlatformActionInput {
  action: string;
  tenantId?: string | null;
  tenantSlug?: string | null;
  targetKind?: string | null;
  targetId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  /** Only sign-in knows who it is before the context does. */
  platformUserId?: string | null;
  actorLabel?: string;
}

/**
 * Writes one entry, filling in who and from where from the request.
 *
 * Deliberately not fire-and-forget: if the audit write fails the action must
 * fail with it. An action nobody can see afterwards is worse than an action
 * that did not happen.
 */
export async function recordPlatformAction(
  context: PlatformRequestContext | PublicRequestContext,
  input: PlatformActionInput,
): Promise<void> {
  const platformUserId = input.platformUserId ?? context.platform?.platformUserId ?? null;
  const label =
    input.actorLabel ??
    (platformUserId === null
      ? 'unknown'
      : ((await getPlatformDataSource().platformUsers.findById(platformUserId))?.email ??
        platformUserId));

  await getPlatformDataSource().platformAudit.append({
    platformUserId,
    actorLabel: label,
    action: input.action,
    tenantId: input.tenantId ?? null,
    tenantSlug: input.tenantSlug ?? null,
    targetKind: input.targetKind ?? null,
    targetId: input.targetId ?? null,
    reason: input.reason ?? null,
    requestId: context.requestId,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: input.metadata ?? {},
  });
}

export const platformAuditRoute = defineRoute({
  method: 'get',
  path: '/v1/platform/audit',
  operationId: 'platformAuditLog',
  summary: 'Search the platform audit log',
  description:
    'Newest first, by keyset rather than offset, so paging through a log that is being written to cannot repeat or skip an entry.',
  tags: ['platform'],
  security: 'platform',
  params: noSchema,
  query: z.object({
    search: z.string().max(200).optional(),
    action: z.string().max(100).optional(),
    tenantId: z.uuid().optional(),
    platformUserId: z.uuid().optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
    /** The `next` value from the previous page. */
    beforeOccurredAt: z.iso.datetime().optional(),
    beforeId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  body: noSchema,
  responses: {
    200: { description: 'A page of entries.', schema: platformAuditPageSchema },
  },
  handler: async ({ query }, context) => {
    void context;
    const page = await getPlatformDataSource().platformAudit.list({
      ...(query.search === undefined ? {} : { search: query.search }),
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.tenantId === undefined ? {} : { tenantId: query.tenantId }),
      ...(query.platformUserId === undefined ? {} : { platformUserId: query.platformUserId }),
      ...(query.from === undefined ? {} : { from: new Date(query.from) }),
      ...(query.to === undefined ? {} : { to: new Date(query.to) }),
      ...(query.beforeOccurredAt === undefined || query.beforeId === undefined
        ? {}
        : { before: { occurredAt: new Date(query.beforeOccurredAt), id: query.beforeId } }),
      limit: query.limit,
    });

    return {
      status: 200,
      body: {
        entries: page.entries.map((entry) => ({
          id: entry.id,
          occurredAt: iso(entry.occurredAt),
          platformUserId: entry.platformUserId,
          actorLabel: entry.actorLabel,
          action: entry.action,
          tenantId: entry.tenantId,
          tenantSlug: entry.tenantSlug,
          targetKind: entry.targetKind,
          targetId: entry.targetId,
          reason: entry.reason,
          requestId: entry.requestId,
          ipAddress: entry.ipAddress,
          metadata: entry.metadata,
        })),
        next:
          page.next === undefined
            ? null
            : { occurredAt: iso(page.next.occurredAt), id: page.next.id },
      },
    };
  },
});

export const platformAuditRoutes = [platformAuditRoute];

/** Re-exported so the impersonation routes can shape an entry the same way. */
export { platformAuditEntrySchema, isoOrNull };
