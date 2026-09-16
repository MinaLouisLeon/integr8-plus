import { getPlatformDataSource, type TenantPlan, type TenantStatus } from '@integr8/db';
import { ApiError } from './errors.js';

/**
 * A suspended company is blocked at the door (P15).
 *
 * The decision was between read-only and refusing everything, and refusing
 * everything won: a suspension is a commercial event, not a maintenance window,
 * and "you can still read your data but not change it" is a state nobody in the
 * field can act on. Every request gets one clear answer instead.
 *
 * Checked after authentication, because until then there is no company to
 * check, and before anything else the handler would do.
 *
 * The status is cached for {@link CACHE_TTL_MS}, which is the whole reason the
 * exit criterion says "within one minute" rather than "immediately": the
 * alternative is a `tenants` read on every single request for a state that
 * changes a handful of times a year.
 *
 * The same cached row carries the company's plan (P16). The door-check already
 * reads `tenants` on every authenticated request; the quota check needs the
 * plan off that same row, and reading it twice would be two connections' work
 * for one fact that changes about as often as the status does.
 */

const CACHE_TTL_MS = 30_000;

interface CachedStatus {
  status: TenantStatus;
  reason: string | null;
  plan: TenantPlan;
  readAt: number;
}

const cache = new Map<string, CachedStatus>();

export class TenantSuspendedError extends ApiError {
  constructor(reason: string | null) {
    super(
      423,
      'tenant_suspended',
      reason === null
        ? 'This account is suspended. Please contact support.'
        : `This account is suspended: ${reason}`,
    );
  }
}

/** Throws {@link TenantSuspendedError} if this company may not be served. */
export async function assertTenantServable(tenantId: string, now = Date.now()): Promise<void> {
  const cached = cache.get(tenantId);
  const fresh =
    cached !== undefined && now - cached.readAt < CACHE_TTL_MS ? cached : await read(tenantId, now);

  if (fresh.status !== 'active') {
    throw new TenantSuspendedError(fresh.reason);
  }
}

/**
 * Forgets what is cached about one company, or all of them.
 *
 * Called when the dashboard suspends or reactivates somebody, so the admin who
 * just did it sees the effect at once rather than waiting out the TTL. It only
 * clears this process's cache; other instances catch up within the TTL, which
 * is what the one-minute criterion allows for.
 */
/**
 * The company's plan, off the row the door-check already read.
 *
 * Falls back to `trial` for a company that has gone: the caller is about to be
 * refused by the suspension check anyway, and the tightest plan is the safe
 * thing to assume if it somehow is not.
 */
export async function planFor(tenantId: string, now = Date.now()): Promise<TenantPlan> {
  const cached = cache.get(tenantId);
  const fresh =
    cached !== undefined && now - cached.readAt < CACHE_TTL_MS ? cached : await read(tenantId, now);

  return fresh.plan;
}

export function forgetTenantStatus(tenantId?: string): void {
  if (tenantId === undefined) {
    cache.clear();
    return;
  }
  cache.delete(tenantId);
}

async function read(tenantId: string, now: number): Promise<CachedStatus> {
  const tenant = await getPlatformDataSource().tenants.findById(tenantId);
  const entry: CachedStatus = {
    // A company that no longer exists is not servable either, and `cancelled`
    // is the status that says so.
    status: tenant?.status ?? 'cancelled',
    reason: tenant?.suspendedReason ?? null,
    plan: tenant?.plan ?? 'trial',
    readAt: now,
  };
  cache.set(tenantId, entry);
  return entry;
}
