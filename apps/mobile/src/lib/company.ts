import Constants from 'expo-constants';
import { type CompanyBuild, parseCompanyBuild } from './company-config';

/**
 * The company this build was made for, or undefined in the generic app.
 *
 * `app.config.ts` copies `company.json` into `extra.company` at build time, so
 * the first screen knows whose app it is before the phone has made a request.
 * Read defensively: a config is data, and a build with a half-written file is
 * the generic app rather than a crash on launch.
 */
export const COMPANY: CompanyBuild | undefined = parseCompanyBuild(
  Constants.expoConfig?.extra?.company,
);

/** Where the public brand endpoint's relative paths resolve to. */
export function publicUrl(baseUrl: string, path: string | null): string | null {
  return path === null
    ? null
    : `${baseUrl.replace(/\/+$/u, '')}${path.startsWith('/') ? path : `/${path}`}`;
}
