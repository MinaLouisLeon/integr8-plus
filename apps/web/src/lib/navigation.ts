import type { NavPath, PlatformNavPath } from '@integr8/core';

/**
 * The web app's side of the shared navigation model.
 *
 * `@integr8/core` says which sections exist and who sees them; this file says
 * where each one lives in this app, and works out from a pathname which
 * section a page belongs to and whether it is nested inside it. Pure functions,
 * so the top bar's title and back link are testable without a browser.
 */

/** The web routes for every section the web app draws. Forms and branding are desktop-only. */
export const NAV_PATHS: Readonly<Record<Exclude<NavPath, 'forms' | 'branding'>, string>> = {
  dashboard: '/dashboard',
  fill: '/fill',
  submissions: '/submissions',
  workOrders: '/work-orders',
  timesheets: '/timesheets',
  customers: '/customers',
  imports: '/imports',
  jobTypes: '/settings/job-types',
  getStarted: '/get-started',
  people: '/settings/people',
  companySettings: '/settings/company',
  storage: '/storage',
  billing: '/billing',
};

/**
 * Routes that belong to a section without living under its path. A site is
 * reached from its customer, so `/sites/[id]` goes back to the customers list.
 */
export const NAV_ALIASES: Readonly<Partial<Record<NavPath, readonly string[]>>> = {
  customers: ['/sites'],
};

export const PLATFORM_NAV_PATHS: Readonly<Record<PlatformNavPath, string>> = {
  companies: '/platform',
  funnel: '/platform/funnel',
  storage: '/platform/storage',
  plans: '/platform/plans',
  audit: '/platform/audit',
  flags: '/platform/flags',
  announcements: '/platform/announcements',
  templates: '/platform/templates',
  releases: '/platform/releases',
  health: '/platform/health',
};

export const PLATFORM_NAV_ALIASES: Readonly<Partial<Record<PlatformNavPath, readonly string[]>>> = {
  companies: ['/platform/companies'],
};

/** What the shell needs to know about one route to mark it current and name it. */
export interface ShellRoute {
  key: string;
  href: string;
  /** Current only on exactly this path (`/platform`, which every platform page is under). */
  exact?: boolean;
  /** Other paths that belong to this section. */
  aliases?: readonly string[];
}

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** Whether a route is the current one, for `aria-current`. */
export function isCurrentRoute(route: ShellRoute, pathname: string): boolean {
  if (route.exact === true ? pathname === route.href : under(pathname, route.href)) {
    return true;
  }
  return (route.aliases ?? []).some((alias) => under(pathname, alias));
}

export interface ResolvedRoute<R extends ShellRoute> {
  route: R;
  /** Deeper than the section's own page, so the top bar offers a way back. */
  nested: boolean;
}

/**
 * The section a pathname belongs to: the longest matching path wins, so
 * `/settings/people` is people and not whatever `/settings` might be.
 */
export function routeForPathname<R extends ShellRoute>(
  routes: readonly R[],
  pathname: string,
): ResolvedRoute<R> | null {
  let best: { route: R; length: number } | null = null;
  for (const route of routes) {
    const candidates = [route.href, ...(route.aliases ?? [])];
    for (const candidate of candidates) {
      const exactOnly = route.exact === true && candidate === route.href;
      const matches = exactOnly ? pathname === candidate : under(pathname, candidate);
      if (matches && (best === null || candidate.length > best.length)) {
        best = { route, length: candidate.length };
      }
    }
  }
  if (best === null) {
    return null;
  }
  return { route: best.route, nested: pathname !== best.route.href };
}

/** `/work-orders/abc/` and `/work-orders/abc` are the same page. */
export function normalisePathname(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/u, '');
  return trimmed === '' ? '/' : trimmed;
}
