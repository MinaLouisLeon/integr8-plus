import type { TenantTransaction } from '@integr8/db';
import { z } from 'zod';
import { conflict, unprocessable } from '../../http/errors.js';
import type { RequestContext } from '../../http/routes.js';

/**
 * What every CRM route file shares: the tag and module every route declares,
 * the audit helper, the assignee check, the version-conflict refusal and the
 * newest-first cursor.
 */

export const TAGS = ['crm'];
export const FEATURE = 'crm' as const;

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
export async function requireAssignableMember(
  tx: TenantTransaction,
  userId: string,
  field = 'body.assignedTo',
): Promise<void> {
  const member = await tx.tenantUsers.findByUserId(userId);
  if (member?.status !== 'active') {
    throw unprocessable('assignee_not_member', 'Assign it to an active member of your company.', [
      {
        field,
        code: 'assignee_not_member',
        message: 'Assign it to an active member of your company.',
      },
    ]);
  }
}

export const alreadyConverted = () =>
  conflict(
    'lead_already_converted',
    'This lead has already been converted. Its details now live on the customer.',
  );

export const versionConflict = () =>
  conflict(
    'version_conflict',
    'Somebody changed this since you opened it. Reload to see their change, then try again.',
  );

/** Opaque cursors for newest-first lists. */
export function encodeDateCursor(next: { createdAt: Date; id: string } | undefined): string | null {
  return next === undefined
    ? null
    : Buffer.from(
        JSON.stringify({ at: next.createdAt.toISOString(), id: next.id }),
        'utf8',
      ).toString('base64url');
}

export function decodeDateCursor(
  cursor: string | undefined,
): { createdAt: Date; id: string } | undefined {
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
