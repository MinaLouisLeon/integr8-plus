import type { Permission } from './permissions.js';

/**
 * The dashboard's map, as data.
 *
 * The web app and the desktop app each draw a side menu, and the two must not
 * drift: a section one of them forgets is a section half the company cannot
 * find. So the sections live here, once, with the permission that reveals each
 * and the icon that names it, and each app draws them with its own primitives.
 * No React in this package, by the repo's rule; a `path` is a key the app maps
 * to its own route, since the web uses `/work-orders` and the desktop a hash.
 *
 * `label` and `hint` are i18n keys under `nav.*`, not words.
 */

export type NavIcon =
  | 'home'
  | 'clipboard'
  | 'pen'
  | 'inbox'
  | 'briefcase'
  | 'users'
  | 'map-pin'
  | 'upload'
  | 'clock'
  | 'tag'
  | 'palette'
  | 'user-plus'
  | 'building'
  | 'database'
  | 'credit-card'
  | 'rocket'
  | 'funnel'
  | 'list'
  | 'flag'
  | 'megaphone'
  | 'layout'
  | 'package'
  | 'heart';

export type NavGroup = 'overview' | 'work' | 'operations' | 'setup' | 'company';

/** One entry in the side menu. */
export interface NavSection {
  /** A stable key; also the i18n suffix: `nav.section.<key>` and `nav.hint.<key>`. */
  key: string;
  group: NavGroup;
  /** The app's route key. The web maps it to a path, the desktop to a hash route. */
  path: NavPath;
  icon: NavIcon;
  /** Shown only to a seat holding this; absent means everybody signed in. */
  permission?: Permission;
  /** Only the desktop app has this screen (the form builder, company branding). */
  desktopOnly?: boolean;
  /** Only the web app has this screen (billing, storage, people, get started). */
  webOnly?: boolean;
}

export type NavPath =
  | 'dashboard'
  | 'forms'
  | 'fill'
  | 'submissions'
  | 'workOrders'
  | 'customers'
  | 'imports'
  | 'timesheets'
  | 'jobTypes'
  | 'branding'
  | 'getStarted'
  | 'people'
  | 'companySettings'
  | 'storage'
  | 'billing';

export const NAV_GROUPS: readonly NavGroup[] = [
  'overview',
  'work',
  'operations',
  'setup',
  'company',
];

/**
 * Every signed-in section, in menu order.
 *
 * Forms and job types stay visible to everybody who may read them; the menu
 * shows what exists, and the screen says what Integr8 does for the company.
 * Branding is the exception: a screen only staff can act on is shown only to
 * staff, because a read-only branding page would be an invitation to ask why.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  { key: 'dashboard', group: 'overview', path: 'dashboard', icon: 'home' },

  { key: 'fill', group: 'work', path: 'fill', icon: 'pen', permission: 'submission.fill' },
  {
    key: 'submissions',
    group: 'work',
    path: 'submissions',
    icon: 'inbox',
    permission: 'form.read',
  },
  { key: 'workOrders', group: 'work', path: 'workOrders', icon: 'briefcase' },
  {
    key: 'timesheets',
    group: 'work',
    path: 'timesheets',
    icon: 'clock',
    permission: 'work_order.manage',
  },

  {
    key: 'customers',
    group: 'operations',
    path: 'customers',
    icon: 'users',
    permission: 'customer.read',
  },
  {
    key: 'imports',
    group: 'operations',
    path: 'imports',
    icon: 'upload',
    permission: 'import.run',
  },

  {
    key: 'forms',
    group: 'setup',
    path: 'forms',
    icon: 'clipboard',
    permission: 'form.read',
    desktopOnly: true,
  },
  { key: 'jobTypes', group: 'setup', path: 'jobTypes', icon: 'tag' },
  {
    key: 'branding',
    group: 'setup',
    path: 'branding',
    icon: 'palette',
    permission: 'branding.manage',
    desktopOnly: true,
  },

  { key: 'getStarted', group: 'company', path: 'getStarted', icon: 'rocket', webOnly: true },
  {
    key: 'people',
    group: 'company',
    path: 'people',
    icon: 'user-plus',
    permission: 'member.read',
    webOnly: true,
  },
  {
    key: 'companySettings',
    group: 'company',
    path: 'companySettings',
    icon: 'building',
    permission: 'tenant.update',
    webOnly: true,
  },
  {
    key: 'storage',
    group: 'company',
    path: 'storage',
    icon: 'database',
    permission: 'storage.read',
    webOnly: true,
  },
  {
    key: 'billing',
    group: 'company',
    path: 'billing',
    icon: 'credit-card',
    permission: 'billing.read',
    webOnly: true,
  },
];

/** The platform dashboard's sections (Integr8's own), one group. */
export type PlatformNavPath =
  | 'companies'
  | 'funnel'
  | 'storage'
  | 'plans'
  | 'audit'
  | 'flags'
  | 'announcements'
  | 'templates'
  | 'releases'
  | 'health'
  | 'staff';

export interface PlatformNavSection {
  key: PlatformNavPath;
  icon: NavIcon;
}

export const PLATFORM_NAV_SECTIONS: readonly PlatformNavSection[] = [
  { key: 'companies', icon: 'building' },
  { key: 'funnel', icon: 'funnel' },
  { key: 'storage', icon: 'database' },
  { key: 'plans', icon: 'credit-card' },
  { key: 'audit', icon: 'list' },
  { key: 'flags', icon: 'flag' },
  { key: 'announcements', icon: 'megaphone' },
  { key: 'templates', icon: 'layout' },
  { key: 'releases', icon: 'package' },
  { key: 'health', icon: 'heart' },
  { key: 'staff', icon: 'users' },
];

export type NavApp = 'web' | 'desktop';

/**
 * The sections one seat sees in one app, grouped and in order. Empty groups
 * are dropped, so a viewer never sees a "Set-up" heading with nothing under it.
 */
export function visibleNavigation(
  app: NavApp,
  permissions: readonly Permission[],
): { group: NavGroup; sections: NavSection[] }[] {
  const held = new Set(permissions);
  const shown = NAV_SECTIONS.filter(
    (section) =>
      (section.permission === undefined || held.has(section.permission)) &&
      !(section.desktopOnly === true && app !== 'desktop') &&
      !(section.webOnly === true && app !== 'web'),
  );
  return NAV_GROUPS.map((group) => ({
    group,
    sections: shown.filter((section) => section.group === group),
  })).filter((entry) => entry.sections.length > 0);
}
