import type { ApiConfig } from '../config.js';
import type { AnyRoute } from '../http/routes.js';
import { healthRoutes } from './health.js';
import { authRoutes } from './v1/auth.js';
import { formRoutes } from './v1/forms.js';
import { mediaRoutes } from './v1/media.js';
import { submissionRoutes } from './v1/submissions.js';
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
    ...workspaceRoutes,
    ...formRoutes,
    ...submissionRoutes,
    ...mediaRoutes,
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
