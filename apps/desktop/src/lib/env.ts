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
 * Which build this is (0022).
 *
 * One codebase, two installers. `staff` is the one Integr8's own people
 * install: it shows only the staff sign-in, then the company picker.
 * `company` is built once per company with `VITE_COMPANY_SLUG` set: it wears
 * that company's name, icon and colours, shows only the company sign-in, and
 * the API refuses anybody from another company. `development`, the default
 * when nothing is set, shows both doors so a developer can try either.
 *
 * Stamped by CI (`scripts/stamp.mjs` for the native side, these variables for
 * the bundle); never a runtime switch, because the whole point is that a
 * company's installer cannot be turned into anything else.
 */
export type AppFlavor = 'staff' | 'company' | 'development';

export const APP_FLAVOR: AppFlavor = readFlavor(
  import.meta.env.VITE_APP_FLAVOR as string | undefined,
);

/** The company this build is for, by short name. Only set in a `company` build. */
export const COMPANY_SLUG: string | undefined =
  APP_FLAVOR === 'company'
    ? ((import.meta.env.VITE_COMPANY_SLUG as string | undefined) ?? undefined)
    : undefined;

function readFlavor(value: string | undefined): AppFlavor {
  if (value === 'staff' || value === 'company') {
    if (value === 'company' && !(import.meta.env.VITE_COMPANY_SLUG as string | undefined)) {
      throw new Error('A company build needs VITE_COMPANY_SLUG');
    }
    return value;
  }
  return 'development';
}

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
