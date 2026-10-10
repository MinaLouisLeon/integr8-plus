import type { AnyRoute } from '../../../http/routes.js';
import { platformAuditRoutes } from './audit.js';
import { platformAuthRoutes } from './auth.js';
import { platformCompanyRoutes } from './companies.js';
import { platformImpersonationRoutes } from './impersonation.js';
import { platformLifecycleRoutes } from './lifecycle.js';
import { platformSettingsRoutes } from './settings.js';
import { platformStaffRoutes } from './staff.js';
import { platformStorageRoutes } from './storage.js';
import { funnelRoutes } from './funnel.js';
import { platformHealthRoutes } from './health.js';
import { platformSupportRoutes } from './support.js';
import { platformTemplateRoutes } from './templates.js';

/**
 * The super admin dashboard's API (P15).
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
  ...platformLifecycleRoutes,
  ...platformAuditRoutes,
  ...platformSettingsRoutes,
  ...platformTemplateRoutes,
  ...platformSupportRoutes,
  ...platformStaffRoutes,
  ...platformStorageRoutes,
  ...platformHealthRoutes,
  ...funnelRoutes,
];
