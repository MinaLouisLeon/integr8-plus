import { withTenant } from '@integr8/db';
import type { JobHandlers } from './worker.js';

/**
 * The job handlers this build knows.
 *
 * One entry today, and it is real work rather than a placeholder: writing an
 * audit entry from a background job is how a slow or failure-prone side effect
 * stops blocking the request that caused it.
 *
 * Later phases add to this map. A job whose queue has no handler here is
 * dead-lettered rather than retried, because another attempt will not teach
 * this process a handler it does not have.
 */
export const jobHandlers: JobHandlers = {
  'audit.record': async (payload, context) => {
    await withTenant(context.tenantId, (tx) =>
      tx.auditLog.append({
        actorKind: 'system',
        actorLabel: 'system',
        action: text(payload, 'action') ?? 'system.event',
        resourceType: text(payload, 'resourceType') ?? 'system',
        resourceId: text(payload, 'resourceId'),
        metadata: { jobId: context.jobId, ...object(payload, 'metadata') },
      }),
    );
  },
};

/**
 * Reads a string out of a job payload.
 *
 * A payload is `unknown` by the time it comes back from the database — it was
 * JSON when it went in and a later build may have changed what it writes. These
 * two helpers make that explicit rather than coercing whatever is there into
 * `[object Object]`.
 */
function text(payload: Record<string, unknown>, key: string): string | null {
  const value = payload[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

function object(payload: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = payload[key];
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
