import type { PlatformSessionScope } from '@integr8/core';
import { getPlatformDataSource } from '@integr8/db';
import { recordPlatformAction } from '../routes/v1/platform/audit.js';
import { ApiError } from './errors.js';
import type { AnyRoute, PlatformRequestContext } from './routes.js';

/**
 * Keeping a staff session limited to test companies inside them (0077, P38).
 *
 * The developer MCP server signs in with `scope: "test_companies"`. Such a
 * session may call only the platform routes that list that scope in
 * `platformScopes`, and on a route whose path names a company, only for a
 * company created as a test company. Everything else answers 403
 * `session_scope`, and the refusal is written to the platform audit log, so
 * a tool that tried is on record. The check is the API's, not the tool's:
 * the tool cannot be trusted to keep its own rules.
 */

/** The scope a route allows when it says nothing: the dashboard's. */
export const DEFAULT_PLATFORM_SCOPES: readonly PlatformSessionScope[] = ['full'];

export function routeAllows(route: Pick<AnyRoute, 'platformScopes'>, scope: PlatformSessionScope) {
  return (route.platformScopes ?? DEFAULT_PLATFORM_SCOPES).includes(scope);
}

/** The company a route's path names, if it names one. */
export function companyInPath(params: unknown): string | undefined {
  if (typeof params !== 'object' || params === null) {
    return undefined;
  }
  const tenantId = (params as { tenantId?: unknown }).tenantId;
  return typeof tenantId === 'string' ? tenantId : undefined;
}

export async function assertWithinSessionScope(
  route: Pick<AnyRoute, 'platformScopes' | 'method' | 'path'>,
  params: unknown,
  context: PlatformRequestContext,
): Promise<void> {
  const scope = context.platform.scope;
  if (scope === 'full') {
    return;
  }
  const refuse = async (why: 'route' | 'company', tenantId: string | null) => {
    await recordPlatformAction(context, {
      action: 'platform.session_scope_refused',
      tenantId,
      targetKind: 'route',
      targetId: `${route.method.toUpperCase()} ${route.path}`,
      metadata: { scope, why },
    });
    return new ApiError(
      403,
      'session_scope',
      why === 'route'
        ? 'This staff session is limited to test companies and may not use this route.'
        : 'This staff session is limited to test companies, and this company is not one.',
    );
  };
  if (!routeAllows(route, scope)) {
    throw await refuse('route', null);
  }
  const tenantId = companyInPath(params);
  if (tenantId === undefined) {
    return;
  }
  const tenant = await getPlatformDataSource().tenants.findById(tenantId);
  if (tenant?.isTest !== true) {
    // A company that does not exist is refused the same way, so the answer
    // does not say which real companies exist.
    throw await refuse('company', tenant === undefined ? null : tenant.id);
  }
}
