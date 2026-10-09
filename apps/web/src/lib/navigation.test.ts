import { describe, expect, it } from 'vitest';
import { isCurrentRoute, normalisePathname, routeForPathname, type ShellRoute } from './navigation';

/**
 * The top bar's title and back link come from these, so a wrong answer is a
 * page that says it is somewhere it is not.
 */
const ROUTES: ShellRoute[] = [
  { key: 'dashboard', href: '/dashboard' },
  { key: 'workOrders', href: '/work-orders' },
  { key: 'customers', href: '/customers', aliases: ['/sites'] },
  { key: 'jobTypes', href: '/settings/job-types' },
  { key: 'people', href: '/settings/people' },
];

const PLATFORM: ShellRoute[] = [
  { key: 'companies', href: '/platform', exact: true, aliases: ['/platform/companies'] },
  { key: 'funnel', href: '/platform/funnel' },
];

describe('which section a page belongs to', () => {
  it('names the section and says it is its own page', () => {
    expect(routeForPathname(ROUTES, '/work-orders')).toEqual({
      route: ROUTES[1],
      nested: false,
    });
  });

  it('treats a detail page as nested in its section', () => {
    expect(routeForPathname(ROUTES, '/work-orders/abc')).toEqual({
      route: ROUTES[1],
      nested: true,
    });
    expect(routeForPathname(ROUTES, '/work-orders/new')?.nested).toBe(true);
  });

  it('follows an alias back to the section that owns it', () => {
    expect(routeForPathname(ROUTES, '/sites/abc')).toEqual({ route: ROUTES[2], nested: true });
  });

  it('prefers the longest match', () => {
    expect(routeForPathname(ROUTES, '/settings/people')?.route.key).toBe('people');
    expect(routeForPathname(ROUTES, '/settings/job-types/x')?.route.key).toBe('jobTypes');
  });

  it('knows nothing about a path outside the map', () => {
    expect(routeForPathname(ROUTES, '/elsewhere')).toBeNull();
  });

  it('matches an exact route only on its own path, and through its aliases', () => {
    expect(routeForPathname(PLATFORM, '/platform')?.route.key).toBe('companies');
    expect(routeForPathname(PLATFORM, '/platform/funnel')?.route.key).toBe('funnel');
    expect(routeForPathname(PLATFORM, '/platform/companies/t1')).toEqual({
      route: PLATFORM[0],
      nested: true,
    });
    expect(routeForPathname(PLATFORM, '/platform/health')).toBeNull();
  });
});

describe('the current item', () => {
  it('is current on its own page and below it', () => {
    expect(isCurrentRoute(ROUTES[1]!, '/work-orders')).toBe(true);
    expect(isCurrentRoute(ROUTES[1]!, '/work-orders/abc')).toBe(true);
    expect(isCurrentRoute(ROUTES[1]!, '/work-orders-archive')).toBe(false);
  });

  it('is not current everywhere under an exact route', () => {
    expect(isCurrentRoute(PLATFORM[0]!, '/platform')).toBe(true);
    expect(isCurrentRoute(PLATFORM[0]!, '/platform/funnel')).toBe(false);
    expect(isCurrentRoute(PLATFORM[0]!, '/platform/companies/t1')).toBe(true);
  });
});

describe('pathnames', () => {
  it('drops a trailing slash', () => {
    expect(normalisePathname('/work-orders/')).toBe('/work-orders');
    expect(normalisePathname('/')).toBe('/');
  });
});
