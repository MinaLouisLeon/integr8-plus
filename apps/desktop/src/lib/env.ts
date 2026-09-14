/**
 * Build-time configuration.
 *
 * Vite inlines `import.meta.env` at build time, so these are constants in the
 * shipped bundle rather than values read at startup. That is correct for a
 * desktop binary: there is no environment to read on a customer's laptop.
 */

export const API_BASE_URL: string =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? 'http://localhost:3000';

/**
 * The build, sent as `x-client-version` and used as the Sentry release.
 *
 * P20 sets it from the release process. Without it a reported error cannot be
 * tied to a build, which is what P05's fourth exit criterion is about.
 */
export const APP_VERSION: string =
  (import.meta.env.VITE_APP_VERSION as string | undefined) ?? '0.1.0';

export const APP_ENV: string =
  (import.meta.env.VITE_APP_ENV as string | undefined) ?? 'development';

export const SENTRY_DSN: string | undefined = import.meta.env.VITE_SENTRY_DSN as string | undefined;

/**
 * Where site maps load tiles from: `VITE_MAP_TILES_URL` with
 * `VITE_MAP_TILES_ATTRIBUTION`, such as a Mapbox raster style. In development
 * only, OpenStreetMap's own tiles stand in; their usage policy does not allow a
 * product to rely on them. Without either, sites are placed by coordinates and
 * device location, with no map.
 */
export const MAP_TILES: { url: string; attribution: string } | undefined =
  (import.meta.env.VITE_MAP_TILES_URL as string | undefined) !== undefined
    ? {
        url: import.meta.env.VITE_MAP_TILES_URL as string,
        attribution: (import.meta.env.VITE_MAP_TILES_ATTRIBUTION as string | undefined) ?? '',
      }
    : import.meta.env.DEV
      ? {
          url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          attribution: '© OpenStreetMap contributors',
        }
      : undefined;
