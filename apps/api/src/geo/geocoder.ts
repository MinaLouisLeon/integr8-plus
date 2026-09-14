import { createHash } from 'node:crypto';

/**
 * Turning a site's address into coordinates.
 *
 * Behind an interface so the provider is a configuration value: Mapbox in
 * production, a deterministic fake in development and tests, where a network
 * call would make every run depend on somebody else's service.
 *
 * Geocoding happens in the worker, after a site is saved, never in the request:
 * a slow or failing provider must not stop a dispatcher recording a new site.
 */

export interface GeocodeQuery {
  /** The address as one line. */
  address: string;
  /** ISO 3166-1 alpha-2, to keep "Springfield" in the right country. */
  countryCode: string | null;
}

export interface GeocodeMatch {
  latitude: number;
  longitude: number;
  /**
   * How precise the match is, in the provider's words: `rooftop`,
   * `parcel`, `street`, `postcode`, `place`. A dispatcher is shown this, because
   * a postcode centroid is not a front door.
   */
  accuracy: string;
}

export interface Geocoder {
  readonly provider: string;
  /** The best match, or `undefined` if the address matched nothing. Throws when the provider fails. */
  geocode(query: GeocodeQuery): Promise<GeocodeMatch | undefined>;
}

/**
 * Coordinates derived from the address text, so the same address always lands
 * in the same place. An address containing "nowhere" matches nothing, so the
 * not-found path can be exercised; one containing "geocoder down" throws.
 */
export class FakeGeocoder implements Geocoder {
  readonly provider = 'fake';

  geocode(query: GeocodeQuery): Promise<GeocodeMatch | undefined> {
    const text = query.address.toLowerCase();
    if (text.includes('geocoder down')) {
      return Promise.reject(new Error('The fake geocoder was asked to fail.'));
    }
    if (text.includes('nowhere') || text.trim() === '') {
      return Promise.resolve(undefined);
    }
    const digest = createHash('sha256')
      .update(`${query.countryCode ?? ''}|${text}`)
      .digest();
    // Near the Pennines, spread across a few tens of kilometres.
    const latitude = 53.8 + (digest.readUInt16BE(0) / 65535) * 0.4;
    const longitude = -1.9 + (digest.readUInt16BE(2) / 65535) * 0.6;
    return Promise.resolve({
      latitude: Math.round(latitude * 1e6) / 1e6,
      longitude: Math.round(longitude * 1e6) / 1e6,
      accuracy: 'address',
    });
  }
}

interface MapboxFeature {
  geometry?: { coordinates?: [number, number] };
  properties?: {
    feature_type?: string;
    coordinates?: { latitude?: number; longitude?: number; accuracy?: string };
  };
}

/**
 * Mapbox Geocoding API v6, forward search.
 *
 * `permanent=true` is required: Mapbox's terms allow storing results only from
 * permanent geocoding, and a site's coordinates are stored for as long as the
 * site exists. It is billed differently from temporary geocoding.
 */
export class MapboxGeocoder implements Geocoder {
  readonly provider = 'mapbox';
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: { accessToken: string; fetch?: typeof fetch }) {
    this.#token = options.accessToken;
    this.#fetch = options.fetch ?? fetch;
  }

  async geocode(query: GeocodeQuery): Promise<GeocodeMatch | undefined> {
    const url = new URL('https://api.mapbox.com/search/geocode/v6/forward');
    url.searchParams.set('q', query.address);
    url.searchParams.set('limit', '1');
    url.searchParams.set('permanent', 'true');
    url.searchParams.set('types', 'address,street,postcode,place');
    if (query.countryCode !== null) {
      url.searchParams.set('country', query.countryCode.toLowerCase());
    }
    url.searchParams.set('access_token', this.#token);

    const response = await this.#fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
      throw new Error(`Mapbox geocoding answered ${String(response.status)}.`);
    }
    const body = (await response.json()) as { features?: MapboxFeature[] };
    const feature = body.features?.[0];
    const coordinates = feature?.properties?.coordinates;
    const latitude = coordinates?.latitude ?? feature?.geometry?.coordinates?.[1];
    const longitude = coordinates?.longitude ?? feature?.geometry?.coordinates?.[0];
    if (feature === undefined || latitude === undefined || longitude === undefined) {
      return undefined;
    }
    return {
      latitude: Math.round(latitude * 1e6) / 1e6,
      longitude: Math.round(longitude * 1e6) / 1e6,
      accuracy: coordinates?.accuracy ?? feature.properties?.feature_type ?? 'unknown',
    };
  }
}
