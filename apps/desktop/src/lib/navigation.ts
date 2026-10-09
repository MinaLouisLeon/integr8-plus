import {
  type NavGroup,
  type NavPath,
  type NavSection,
  type Permission,
  visibleNavigation,
} from '@integr8/core';

/**
 * The shared menu model, mapped onto this app's hash routes.
 *
 * `@integr8/core` says which sections exist and who sees each; this file says
 * where each one lives here, and works the other way too — from the route on
 * screen back to the section it belongs to — so the sidebar can mark the right
 * row and the top bar can offer the way back from a detail screen.
 */

/** Where each section lives in this app. Web-only sections have no home here. */
export const NAV_ROUTES: Readonly<Record<NavPath, string | null>> = {
  dashboard: '/dashboard',
  forms: '/forms',
  fill: '/fill',
  submissions: '/submissions',
  workOrders: '/work-orders',
  timesheets: '/timesheets',
  customers: '/customers',
  imports: '/imports',
  jobTypes: '/settings/job-types',
  branding: '/settings/branding',
  getStarted: null,
  people: null,
  companySettings: null,
  storage: null,
  billing: null,
};

/**
 * Routes that belong to a section without starting with its root. A site is
 * reached through its customer, so it reads as part of "Customers".
 */
const ADOPTED_PREFIXES: readonly { prefix: string; path: NavPath }[] = [
  { prefix: '/sites/', path: 'customers' },
];

export interface DesktopNavSection extends NavSection {
  to: string;
}

export interface DesktopNavGroup {
  group: NavGroup;
  sections: DesktopNavSection[];
}

/** The groups and sections this seat sees, each with its route. */
export function desktopNavigation(permissions: readonly Permission[]): DesktopNavGroup[] {
  return visibleNavigation('desktop', permissions)
    .map(({ group, sections }) => ({
      group,
      sections: sections.flatMap((section) => {
        const to = NAV_ROUTES[section.path];
        return to === null ? [] : [{ ...section, to }];
      }),
    }))
    .filter((entry) => entry.sections.length > 0);
}

const ROOTS: readonly { path: NavPath; root: string }[] = (
  Object.entries(NAV_ROUTES) as [NavPath, string | null][]
)
  .flatMap(([path, root]) => (root === null ? [] : [{ path, root }]))
  // Longest first, so `/settings/job-types` is found before any shorter root
  // that might one day share its prefix.
  .sort((a, b) => b.root.length - a.root.length);

/** The section a route belongs to, by its root or an adopted prefix. */
export function sectionPathFor(pathname: string): NavPath | undefined {
  const clean = pathname.replace(/\/+$/u, '') || '/';
  for (const { path, root } of ROOTS) {
    if (clean === root || clean.startsWith(`${root}/`)) {
      return path;
    }
  }
  for (const { prefix, path } of ADOPTED_PREFIXES) {
    if (clean.startsWith(prefix)) {
      return path;
    }
  }
  return undefined;
}

export interface RouteChrome {
  /** The section the route is in; undefined off the map. */
  section: NavPath | undefined;
  /** Where "back" leads from a nested route, and the section it names; undefined at a section root. */
  back: { to: string; section: NavPath } | undefined;
}

/**
 * What the top bar needs to know about a route: its section, and whether it
 * is nested under one. A route under `/settings/` that is not itself a
 * section leads back to the dashboard.
 */
export function routeChrome(pathname: string): RouteChrome {
  const clean = pathname.replace(/\/+$/u, '') || '/';
  const section = sectionPathFor(clean);
  if (section === undefined) {
    if (clean.startsWith('/settings/')) {
      return {
        section: undefined,
        back: { to: NAV_ROUTES.dashboard ?? '/', section: 'dashboard' },
      };
    }
    return { section: undefined, back: undefined };
  }
  const root = NAV_ROUTES[section];
  if (root === null || clean === root) {
    return { section, back: undefined };
  }
  // The form builder and a published version carry their own way back, in
  // the builder's toolbar; a second one in the top bar would be noise.
  if (section === 'forms') {
    return { section, back: undefined };
  }
  return { section, back: { to: root, section } };
}
