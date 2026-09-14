import { describe, expect, it } from 'vitest';
import { assertProductionReady, loadApiConfig } from '../config.js';
import { FakeGeocoder, MapboxGeocoder } from './geocoder.js';

describe('the fake geocoder', () => {
  it('puts the same address in the same place, and can be told to find nothing or fail', async () => {
    const geocoder = new FakeGeocoder();
    const first = await geocoder.geocode({ address: '1 River Road, Leeds', countryCode: 'GB' });
    const again = await geocoder.geocode({ address: '1 River Road, Leeds', countryCode: 'GB' });
    expect(first).toEqual(again);
    expect(first?.latitude).toBeGreaterThan(53.7);
    expect(
      await geocoder.geocode({ address: '1 Nowhere Street', countryCode: null }),
    ).toBeUndefined();
    await expect(
      geocoder.geocode({ address: 'geocoder down', countryCode: null }),
    ).rejects.toThrow();
  });

  it('is refused in production, and Mapbox without a token is refused anywhere', () => {
    expect(() =>
      assertProductionReady(
        loadApiConfig({ APP_ENV: 'production', SENTRY_DSN: 'x', API_RELEASE: 'abc' }),
      ),
    ).toThrow(/GEOCODER is fake/u);
    expect(() => loadApiConfig({ GEOCODER: 'mapbox' })).toThrow(/MAPBOX_ACCESS_TOKEN/u);
  });
});

describe('Mapbox', () => {
  it('asks for one permanent result in the site’s country, and reads the coordinates and their precision', async () => {
    let asked: URL | undefined;
    const geocoder = new MapboxGeocoder({
      accessToken: 'sk.secret',
      fetch: ((url: URL) => {
        asked = url;
        return Promise.resolve(
          new Response(
            JSON.stringify({
              features: [
                {
                  geometry: { coordinates: [-1.5491, 53.8008] },
                  properties: {
                    feature_type: 'address',
                    coordinates: { latitude: 53.800812, longitude: -1.549077, accuracy: 'rooftop' },
                  },
                },
              ],
            }),
          ),
        );
      }) as unknown as typeof fetch,
    });
    const match = await geocoder.geocode({ address: '1 River Road, Leeds', countryCode: 'GB' });
    expect(match).toEqual({ latitude: 53.800812, longitude: -1.549077, accuracy: 'rooftop' });
    expect(asked?.searchParams.get('permanent')).toBe('true');
    expect(asked?.searchParams.get('country')).toBe('gb');
    expect(asked?.searchParams.get('limit')).toBe('1');
  });

  it('reports no match as nothing, and a failing service as an error the job retries', async () => {
    const empty = new MapboxGeocoder({
      accessToken: 't',
      fetch: () => Promise.resolve(new Response(JSON.stringify({ features: [] }))),
    });
    expect(await empty.geocode({ address: 'x', countryCode: null })).toBeUndefined();
    const down = new MapboxGeocoder({
      accessToken: 't',
      fetch: () => Promise.resolve(new Response('', { status: 503 })),
    });
    await expect(down.geocode({ address: 'x', countryCode: null })).rejects.toThrow(/503/u);
  });
});
