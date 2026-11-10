import { describe, expect, it } from 'vitest';
import { loadApiConfig } from '../config.js';
import { allRoutes } from '../routes/index.js';
import { companyInPath, routeAllows } from './session-scope.js';

/**
 * What a staff session limited to test companies may reach (P38), pinned.
 *
 * Platform routes are closed to it unless they say otherwise, so the danger
 * is a route opened by accident. This list changes only on purpose: when it
 * fails, decide whether the developer MCP server really needs the route, and
 * whether the route is safe for it (a company in the path is checked to be a
 * test company; anything else is not), then update the list. The same way
 * the schema-invariant suite pins what `integr8_auth` may reach.
 */

const OPEN_TO_TEST_COMPANY_SESSIONS = [
  'GET /v1/platform/companies',
  'GET /v1/platform/companies/:tenantId',
  'GET /v1/platform/companies/:tenantId/impersonations',
  'GET /v1/platform/companies/:tenantId/test-audit',
  'GET /v1/platform/companies/:tenantId/test-outbox',
  'GET /v1/platform/me',
  'POST /v1/platform/auth/sign-out',
  'POST /v1/platform/companies/:tenantId/impersonate',
  'POST /v1/platform/companies/:tenantId/impersonate/:grantId/end',
];

const routes = allRoutes(loadApiConfig({}));
const key = (route: { method: string; path: string }) =>
  `${route.method.toUpperCase()} ${route.path}`;

describe('routes open to a session limited to test companies', () => {
  it('are exactly the pinned list', () => {
    const open = routes
      .filter((route) => routeAllows(route, 'test_companies'))
      .map(key)
      .sort();
    expect(open).toEqual([...OPEN_TO_TEST_COMPANY_SESSIONS].sort());
  });

  it('are all platform routes, every one still open to the dashboard', () => {
    for (const route of routes.filter((candidate) => candidate.platformScopes !== undefined)) {
      expect(route.security, key(route)).toBe('platform');
      expect(routeAllows(route, 'full'), key(route)).toBe(true);
    }
  });

  it('name a company only as :tenantId, which the scope check reads', () => {
    for (const route of routes.filter((candidate) => routeAllows(candidate, 'test_companies'))) {
      if (route.path.includes('/companies/:')) {
        expect(route.path, key(route)).toMatch(/\/companies\/:tenantId(\/|$)/u);
      }
    }
  });

  it('every other platform route is closed to it by default', () => {
    const closed = routes.filter(
      (route) => route.security === 'platform' && !routeAllows(route, 'test_companies'),
    );
    expect(closed.length).toBeGreaterThan(40);
  });
});

describe('the company a route names', () => {
  it('is read from :tenantId', () => {
    expect(companyInPath({ tenantId: 'abc' })).toBe('abc');
    expect(companyInPath({ grantId: 'abc' })).toBeUndefined();
    expect(companyInPath(undefined)).toBeUndefined();
  });
});
