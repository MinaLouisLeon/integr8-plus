import type { AnyRoute } from '../../../http/routes.js';
import { platformAiRoutes } from './ai.js';
import { platformAuditRoutes } from './audit.js';
import { platformAuthRoutes } from './auth.js';
import { platformCompanyRoutes } from './companies.js';
import { platformDownloadsRoutes } from './downloads.js';
import { platformImpersonationRoutes } from './impersonation.js';
import { platformLifecycleRoutes } from './lifecycle.js';
import { platformPhoneAppRoutes } from './phone-apps.js';
import { platformSettingsRoutes } from './settings.js';
import { platformStaffRoutes } from './staff.js';
import { platformStorageRoutes } from './storage.js';
import { platformHealthRoutes } from './health.js';
import { platformSupportRoutes } from './support.js';
import { platformTemplatePackageRoutes } from './template-packages.js';
import { platformTemplateRoutes } from './templates.js';
import { platformTestCompanyRoutes } from './test-companies.js';
import { platformTestTwinRoutes } from './test-twin.js';
import { platformWebsiteKeyRoutes } from './website-keys.js';

/**
 * The staff app's API (P15; the staff desktop app since P42).
 *
 * Every route here is `security: 'platform'` except the three that mint a
 * platform session in the first place. None of them takes a tenant token, and
 * none of the routes anywhere else takes a platform one: the two are different
 * token types verified by different code, so there is no configuration mistake
 * that lets a customer reach these.
 */
export const platformRoutes: AnyRoute[] = [
  ...platformAuthRoutes,
  ...platformCompanyRoutes,
  ...platformImpersonationRoutes,
  ...platformTestCompanyRoutes,
  ...platformTestTwinRoutes,
  ...platformLifecycleRoutes,
  ...platformAuditRoutes,
  ...platformSettingsRoutes,
  ...platformAiRoutes,
  ...platformTemplateRoutes,
  ...platformTemplatePackageRoutes,
  ...platformSupportRoutes,
  ...platformStaffRoutes,
  ...platformStorageRoutes,
  ...platformWebsiteKeyRoutes,
  ...platformHealthRoutes,
  ...platformDownloadsRoutes,
  ...platformPhoneAppRoutes,
];
