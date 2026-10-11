import type { ApiConfig } from '../config.js';
import type { AnyRoute } from '../http/routes.js';
import { healthRoutes } from './health.js';
import { authRoutes } from './v1/auth.js';
import { billingRoutes } from './v1/billing.js';
import { memberRoutes } from './v1/members.js';
import { onboardingRoutes } from './v1/onboarding.js';
import { settingsRoutes } from './v1/settings.js';
import { signupRoutes } from './v1/signup.js';
import { activityRoutes } from './v1/crm-activities.js';
import { opportunityRoutes } from './v1/crm-opportunities.js';
import { crmRoutes } from './v1/crm.js';
import { stockRoutes } from './v1/inventory-stock.js';
import { catalogueRoutes } from './v1/inventory.js';
import { purchasingRoutes } from './v1/purchasing.js';
import { invoiceRoutes } from './v1/finance-invoices.js';
import { paymentRoutes } from './v1/finance-payments.js';
import { salesOrderRoutes } from './v1/sales-orders.js';
import { salesPublicRoutes } from './v1/sales-public.js';
import { quoteRoutes } from './v1/sales-quotes.js';
import { materialRoutes } from './v1/work-order-materials.js';
import { customerRoutes } from './v1/customers.js';
import { importRoutes } from './v1/imports.js';
import { jobTypeRoutes } from './v1/job-types.js';
import { workOrderRoutes } from './v1/work-orders.js';
import { formRoutes } from './v1/forms.js';
import { mediaRoutes } from './v1/media.js';
import { platformRoutes } from './v1/platform/index.js';
import { publicBrandRoutes } from './v1/public-brand.js';
import { submissionRoutes } from './v1/submissions.js';
import { syncRoutes } from './v1/sync.js';
import { timeRoutes } from './v1/time.js';
import { workspaceRoutes } from './v1/workspace.js';

/**
 * Every route this deployment serves.
 *
 * One list, in one place, because it is also the input to the OpenAPI document
 * — so "what does this API expose" has a single answer that cannot be
 * incomplete.
 */
export function allRoutes(config: ApiConfig): AnyRoute[] {
  return [
    ...healthRoutes(config.APP_ENV),
    ...authRoutes,
    ...billingRoutes,
    ...memberRoutes,
    ...signupRoutes,
    ...settingsRoutes,
    ...publicBrandRoutes,
    ...onboardingRoutes,
    ...workspaceRoutes,
    ...formRoutes,
    ...submissionRoutes,
    ...mediaRoutes,
    ...customerRoutes,
    ...crmRoutes,
    ...opportunityRoutes,
    ...activityRoutes,
    ...catalogueRoutes,
    ...stockRoutes,
    ...purchasingRoutes,
    ...materialRoutes,
    ...quoteRoutes,
    ...salesOrderRoutes,
    ...salesPublicRoutes,
    ...invoiceRoutes,
    ...paymentRoutes,
    ...jobTypeRoutes,
    ...workOrderRoutes,
    ...importRoutes,
    ...syncRoutes,
    ...timeRoutes,
    ...platformRoutes,
  ];
}

/**
 * The routes that appear in the published contract.
 *
 * Health endpoints are excluded: they are for an orchestrator, they are not
 * versioned, and a client generated from this document has no business calling
 * them.
 */
export function documentedRoutes(config: ApiConfig): AnyRoute[] {
  return allRoutes(config).filter((route) => route.path.startsWith('/v1'));
}
