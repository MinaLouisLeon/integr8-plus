import { addressLine, withTenant } from '@integr8/db';
import type { Geocoder } from './geocoder.js';

export const GEOCODE_QUEUE = 'site.geocode';

/** Attempts before a provider failure is recorded as `failed` rather than retried. */
export const GEOCODE_ATTEMPTS = 3;

export type GeocodeOutcome = 'found' | 'not_found' | 'failed' | 'skipped';

/**
 * Looks up one site's address and records the answer.
 *
 * Only a site still `pending` is looked up — a pinned site is left alone — and
 * the answer is recorded only if the address is unchanged since it was sent, so
 * an edit made while the lookup was out is looked up again rather than
 * overwritten with coordinates for the old address.
 */
export async function geocodeSite(
  geocoder: Geocoder,
  tenantId: string,
  siteId: string,
  attempt: number,
): Promise<GeocodeOutcome> {
  const site = await withTenant(tenantId, (tx) => tx.sites.find(siteId));
  if (site?.geocodeStatus !== 'pending') {
    return 'skipped';
  }
  const address = addressLine(site.address);

  let match;
  try {
    match = await geocoder.geocode({ address, countryCode: site.address.countryCode });
  } catch (error) {
    if (attempt < GEOCODE_ATTEMPTS) {
      throw error;
    }
    await withTenant(tenantId, (tx) => tx.sites.recordGeocode(siteId, address, 'failed'));
    return 'failed';
  }

  const recorded = await withTenant(tenantId, (tx) =>
    tx.sites.recordGeocode(
      siteId,
      address,
      match === undefined
        ? 'not_found'
        : {
            location: { latitude: match.latitude, longitude: match.longitude },
            accuracy: match.accuracy,
          },
    ),
  );
  if (recorded === undefined) {
    return 'skipped';
  }
  return match === undefined ? 'not_found' : 'found';
}
