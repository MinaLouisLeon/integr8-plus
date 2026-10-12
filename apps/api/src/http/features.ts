import { hasFeature, type ModuleFeature } from '@integr8/core';
import { withTenant } from '@integr8/db';
import { ApiError } from './errors.js';

/**
 * Whole modules a company may or may not have, enforced at the door (CRM/ERP
 * plan, phase F1).
 *
 * A route that names a `feature` is refused to a company without it, after
 * the permission check and whatever the seat's role. Both are needed: the
 * permission says what the seat may do, the module says whether the company
 * has the thing at all. Hiding a menu entry is never the only thing in the way.
 *
 * The company's resolved flags are cached for {@link CACHE_TTL_MS}, as the
 * suspension status is and for the same reason: the alternative is two flag
 * reads on every CRM request for a setting that changes a handful of times in
 * a company's life. Switching a module on or off from the dashboard clears
 * this process's entry at once; other instances catch up within the TTL.
 */

const CACHE_TTL_MS = 30_000;

interface CachedFeatures {
  features: Readonly<Record<string, boolean>>;
  readAt: number;
}

const cache = new Map<string, CachedFeatures>();

export class FeatureDisabledError extends ApiError {
  constructor(feature: ModuleFeature) {
    super(
      403,
      'feature_disabled',
      `This part of the product is not switched on for your company (${feature}). Ask Integr8 to turn it on.`,
    );
  }
}

/** Throws {@link FeatureDisabledError} unless this company has the module switched on. */
export async function assertFeatureEnabled(
  tenantId: string,
  feature: ModuleFeature,
  now = Date.now(),
): Promise<void> {
  if (!(await isFeatureEnabled(tenantId, feature, now))) {
    throw new FeatureDisabledError(feature);
  }
}

/** Whether this company has the module switched on, for a body that shows more when it does. */
export async function isFeatureEnabled(
  tenantId: string,
  feature: ModuleFeature,
  now = Date.now(),
): Promise<boolean> {
  const cached = cache.get(tenantId);
  const fresh =
    cached !== undefined && now - cached.readAt < CACHE_TTL_MS ? cached : await read(tenantId, now);
  return hasFeature(fresh.features, feature);
}

/** Forgets what is cached about one company's modules, or every company's. */
export function forgetTenantFeatures(tenantId?: string): void {
  if (tenantId === undefined) {
    cache.clear();
  } else {
    cache.delete(tenantId);
  }
}

async function read(tenantId: string, now: number): Promise<CachedFeatures> {
  const features = await withTenant(tenantId, (tx) => tx.featureFlags.resolved());
  const entry = { features, readAt: now };
  cache.set(tenantId, entry);
  return entry;
}
