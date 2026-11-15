import { getPlatformDataSource, withTenant } from '@integr8/db';
import { ApiError, conflict, notFound } from '../http/errors.js';
import type { AppReleases } from './app-releases.js';

/**
 * An owner is invited only once their company's own desktop app exists (P42,
 * the owner's decision D6).
 *
 * The office works in the company's desktop app and nowhere else, and the
 * invitation page ends with "carry on in your company's app" and its download
 * links. An invitation sent before the app is built would lead to a dead end,
 * so staff build the company's app first (the company page's Build apps) and
 * invite after. The company page says the same before anybody presses the
 * button; this is the rule holding for whatever presses it.
 *
 * Not applied to a test company (P38), which gets no app builds, nor when the
 * deployment reads no releases (`APP_RELEASES=off`, development only).
 */

export interface CompanyForGate {
  slug: string;
  isTest: boolean;
  appsEnabled: boolean;
}

export type CompanyAppReadiness = 'ready' | 'apps_off' | 'not_built' | 'unavailable';

export async function companyAppReadiness(
  company: CompanyForGate,
  releases: AppReleases,
): Promise<CompanyAppReadiness> {
  if (company.isTest) {
    return 'ready';
  }
  const state = await releases.companyDesktopApp(company.slug);
  if (state === 'not_checked') {
    return 'ready';
  }
  if (!company.appsEnabled) {
    return 'apps_off';
  }
  if (state === 'unavailable') {
    return 'unavailable';
  }
  return state === 'built' ? 'ready' : 'not_built';
}

/** Throws unless the company's people have an app to sign in to. */
export async function assertCompanyAppReady(
  company: CompanyForGate,
  releases: AppReleases,
): Promise<void> {
  const readiness = await companyAppReadiness(company, releases);
  if (readiness === 'apps_off') {
    throw conflict(
      'company_app_not_built',
      "This company's own apps are switched off. Switch them on and build them before inviting anybody.",
    );
  }
  if (readiness === 'not_built') {
    throw conflict(
      'company_app_not_built',
      "This company's desktop app has not been built yet. Build its apps and wait for the release before inviting anybody.",
    );
  }
  if (readiness === 'unavailable') {
    throw new ApiError(
      503,
      'releases_unavailable',
      "The app releases could not be read just now, so whether this company's desktop app exists is unknown. Try again in a minute.",
    );
  }
}

/**
 * The same rule for a company by id, for the invitation routes on either
 * side: staff sending the owner's from the staff app, and anybody sending one
 * from inside the company (staff acting as the company could otherwise invite
 * the owner from its People screen before its app exists).
 */
export async function assertCompanyAppReadyFor(
  tenantId: string,
  releases: AppReleases,
): Promise<void> {
  const tenant = await getPlatformDataSource().tenants.findById(tenantId);
  if (tenant === undefined) {
    throw notFound(`No company with id ${tenantId}`);
  }
  const settings = await withTenant(tenantId, (tx) => tx.settings.get());
  await assertCompanyAppReady(
    { slug: tenant.slug, isTest: tenant.isTest, appsEnabled: settings.appsEnabled },
    releases,
  );
}
