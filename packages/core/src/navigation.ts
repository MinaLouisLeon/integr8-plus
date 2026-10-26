import { hasFeature, type ModuleFeature } from './crm.js';
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
  | 'truck'
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
  | 'layers'
  | 'factory'
  | 'calendar-check'
  | 'file-text'
  | 'receipt'
  | 'wallet'
  | 'qr-code'
  | 'heart'
  | 'book'
  | 'bar-chart'
  | 'id-card'
  | 'banknote'
  | 'clipboard-check'
  | 'calculator'
  | 'scale'
  | 'barcode'
  | 'sparkles';

export type NavGroup =
  | 'overview'
  | 'work'
  | 'crm'
  | 'sales'
  | 'finance'
  | 'accounting'
  | 'hr'
  | 'inventory'
  | 'operations'
  | 'setup'
  | 'company';

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
  /**
   * Shown only to a company with this module switched on (the CRM). The
   * permission still applies as well: the module says the company has it, the
   * permission says this seat may use it.
   */
  feature?: ModuleFeature;
  /**
   * Shown only when the assistant is on for this seat in this app (docs/ai;
   * ADR-0001): the plan, the company's override, the company's switch for the
   * app and the member's own switch all say yes, as `/v1/ai/capabilities`
   * reports. Off is the default, so a caller that has not asked shows nothing.
   */
  assistant?: boolean;
}

export type NavPath =
  | 'dashboard'
  | 'assistant'
  | 'forms'
  | 'fill'
  | 'submissions'
  | 'workOrders'
  | 'schedule'
  | 'qualifications'
  | 'customers'
  | 'imports'
  | 'timesheets'
  | 'jobTypes'
  | 'branding'
  | 'eInvoicingSwitch'
  | 'getStarted'
  | 'people'
  | 'companySettings'
  | 'websiteAccess'
  | 'storage'
  | 'billing'
  | 'crm'
  | 'leads'
  | 'opportunities'
  | 'activities'
  | 'pipelines'
  | 'crmReports'
  | 'inventory'
  | 'items'
  | 'stockLocations'
  | 'partsUsage'
  | 'vanRequests'
  | 'serialLookup'
  | 'suppliers'
  | 'purchaseOrders'
  | 'reorder'
  | 'boms'
  | 'assemblyOrders'
  | 'materialPlans'
  | 'quotes'
  | 'salesOrders'
  | 'invoices'
  | 'payments'
  | 'ledger'
  | 'journals'
  | 'ledgerReports'
  | 'employees'
  | 'myProfile'
  | 'myExpenses'
  | 'expenseClaims'
  | 'payRuns'
  | 'payrollRules'
  | 'myPayslips'
  | 'assets'
  | 'documents'
  | 'eInvoicing';

export const NAV_GROUPS: readonly NavGroup[] = [
  'overview',
  'work',
  'crm',
  'sales',
  'finance',
  'accounting',
  'hr',
  'inventory',
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
  { key: 'assistant', group: 'overview', path: 'assistant', icon: 'sparkles', assistant: true },

  { key: 'fill', group: 'work', path: 'fill', icon: 'pen', permission: 'submission.fill' },
  {
    key: 'submissions',
    group: 'work',
    path: 'submissions',
    icon: 'inbox',
    permission: 'form.read',
  },
  // PDF documents made from submissions (documents ADR-0001): the `documents` module.
  {
    key: 'documents',
    group: 'work',
    path: 'documents',
    icon: 'file-text',
    permission: 'document.read',
    feature: 'documents',
  },
  { key: 'workOrders', group: 'work', path: 'workOrders', icon: 'briefcase' },
  // The scheduling board (P25): a calendar of visits, on the desktop only.
  {
    key: 'schedule',
    group: 'work',
    path: 'schedule',
    icon: 'calendar-check',
    permission: 'work_order.read_all',
    desktopOnly: true,
  },
  // Skills and certificates (P26): who holds what, and what is running out.
  {
    key: 'qualifications',
    group: 'work',
    path: 'qualifications',
    icon: 'id-card',
    permission: 'qualification.read',
  },
  {
    key: 'timesheets',
    group: 'work',
    path: 'timesheets',
    icon: 'clock',
    permission: 'work_order.manage',
  },

  {
    key: 'crm',
    group: 'crm',
    path: 'crm',
    icon: 'funnel',
    permission: 'crm.read',
    feature: 'crm',
  },
  {
    key: 'leads',
    group: 'crm',
    path: 'leads',
    icon: 'user-plus',
    permission: 'crm.read',
    feature: 'crm',
  },
  {
    key: 'opportunities',
    group: 'crm',
    path: 'opportunities',
    icon: 'layout',
    permission: 'crm.read',
    feature: 'crm',
  },
  {
    key: 'activities',
    group: 'crm',
    path: 'activities',
    icon: 'list',
    permission: 'crm.read',
    feature: 'crm',
  },
  // The pipelines editor is for those who keep the stages; everybody else
  // reads them from the board. The reports read what the CRM holds.
  {
    key: 'pipelines',
    group: 'crm',
    path: 'pipelines',
    icon: 'layers',
    permission: 'crm.pipeline.manage',
    feature: 'crm',
  },
  {
    key: 'crmReports',
    group: 'crm',
    path: 'crmReports',
    icon: 'bar-chart',
    permission: 'crm.read',
    feature: 'crm',
  },

  // Sales (CRM/ERP plan, phase S1): the company's `sales` module.
  {
    key: 'quotes',
    group: 'sales',
    path: 'quotes',
    icon: 'file-text',
    permission: 'sales.read',
    feature: 'sales',
  },
  {
    key: 'salesOrders',
    group: 'sales',
    path: 'salesOrders',
    icon: 'clipboard',
    permission: 'sales.read',
    feature: 'sales',
  },

  // Finance (CRM/ERP plan, phase B1): the company's `finance` module.
  {
    key: 'invoices',
    group: 'finance',
    path: 'invoices',
    icon: 'receipt',
    permission: 'finance.read',
    feature: 'finance',
  },
  {
    key: 'payments',
    group: 'finance',
    path: 'payments',
    icon: 'wallet',
    permission: 'finance.read',
    feature: 'finance',
  },
  // Egyptian e-invoicing (ADR-0014): the company's `e_invoicing` module.
  {
    key: 'eInvoicing',
    group: 'finance',
    path: 'eInvoicing',
    icon: 'scale',
    permission: 'eta.read',
    feature: 'e_invoicing',
  },

  // Accounting (CRM/ERP plan, phase A1; ADR-0009): the company's `ledger` module.
  {
    key: 'ledger',
    group: 'accounting',
    path: 'ledger',
    icon: 'book',
    permission: 'ledger.read',
    feature: 'ledger',
  },
  {
    key: 'journals',
    group: 'accounting',
    path: 'journals',
    icon: 'file-text',
    permission: 'ledger.read',
    feature: 'ledger',
  },
  {
    key: 'ledgerReports',
    group: 'accounting',
    path: 'ledgerReports',
    icon: 'bar-chart',
    permission: 'ledger.read',
    feature: 'ledger',
  },

  // HR (seventh round; ADR-0010): the company's `hr` module. Everybody has
  // their own profile and claims their own expenses; the list of employees is
  // for those who read everybody's, and everybody's claims for those who
  // approve them.
  {
    key: 'employees',
    group: 'hr',
    path: 'employees',
    icon: 'users',
    permission: 'hr.read',
    feature: 'hr',
  },
  {
    key: 'expenseClaims',
    group: 'hr',
    path: 'expenseClaims',
    icon: 'clipboard-check',
    permission: 'expense.approve',
    feature: 'hr',
  },
  // Payroll (ADR-0010): the company's `payroll` module, on top of HR. Those
  // who keep payroll prepare runs and keep the rules; everybody reads their
  // own payslips.
  {
    key: 'payRuns',
    group: 'hr',
    path: 'payRuns',
    icon: 'calculator',
    permission: 'payroll.run',
    feature: 'payroll',
  },
  {
    key: 'payrollRules',
    group: 'hr',
    path: 'payrollRules',
    icon: 'scale',
    permission: 'payroll.run',
    feature: 'payroll',
  },
  { key: 'myProfile', group: 'hr', path: 'myProfile', icon: 'id-card', feature: 'hr' },
  {
    key: 'myExpenses',
    group: 'hr',
    path: 'myExpenses',
    icon: 'banknote',
    permission: 'expense.submit',
    feature: 'hr',
  },
  { key: 'myPayslips', group: 'hr', path: 'myPayslips', icon: 'file-text', feature: 'payroll' },

  // Inventory (CRM/ERP plan, phase E1): the company's `inventory` module.
  {
    key: 'inventory',
    group: 'inventory',
    path: 'inventory',
    icon: 'package',
    permission: 'inventory.read',
    feature: 'inventory',
  },
  {
    key: 'items',
    group: 'inventory',
    path: 'items',
    icon: 'tag',
    permission: 'inventory.read',
    feature: 'inventory',
  },
  {
    key: 'stockLocations',
    group: 'inventory',
    path: 'stockLocations',
    icon: 'map-pin',
    permission: 'inventory.read',
    feature: 'inventory',
  },
  {
    key: 'partsUsage',
    group: 'inventory',
    path: 'partsUsage',
    icon: 'clipboard-check',
    permission: 'inventory.read',
    feature: 'inventory',
  },
  // The store's queue: those who move stock. An engineer asks from the field app.
  {
    key: 'vanRequests',
    group: 'inventory',
    path: 'vanRequests',
    icon: 'truck',
    permission: 'inventory.move',
    feature: 'inventory',
  },
  // Serial numbers and batches (ninth round; ADR-0013): find one, follow its path.
  {
    key: 'serialLookup',
    group: 'inventory',
    path: 'serialLookup',
    icon: 'barcode',
    permission: 'inventory.read',
    feature: 'inventory',
  },
  // Purchasing (CRM/ERP plan, phase E2): the company's `purchasing` module.
  {
    key: 'suppliers',
    group: 'inventory',
    path: 'suppliers',
    icon: 'truck',
    permission: 'purchasing.read',
    feature: 'purchasing',
  },
  {
    key: 'purchaseOrders',
    group: 'inventory',
    path: 'purchaseOrders',
    icon: 'clipboard',
    permission: 'purchasing.read',
    feature: 'purchasing',
  },
  // A reorder list is per location: the entry asks which one, then opens it.
  {
    key: 'reorder',
    group: 'inventory',
    path: 'reorder',
    icon: 'list',
    permission: 'purchasing.manage',
    feature: 'purchasing',
  },
  // Manufacturing (seventh round; ADR-0011): the company's `manufacturing`
  // module, which works only with `inventory` on.
  {
    key: 'boms',
    group: 'inventory',
    path: 'boms',
    icon: 'layers',
    permission: 'manufacturing.read',
    feature: 'manufacturing',
  },
  {
    key: 'assemblyOrders',
    group: 'inventory',
    path: 'assemblyOrders',
    icon: 'factory',
    permission: 'manufacturing.read',
    feature: 'manufacturing',
  },
  {
    key: 'materialPlans',
    group: 'inventory',
    path: 'materialPlans',
    icon: 'calendar-check',
    permission: 'manufacturing.read',
    feature: 'manufacturing',
  },

  {
    key: 'customers',
    group: 'operations',
    path: 'customers',
    icon: 'users',
    permission: 'customer.read',
  },
  // Assets (CRM/ERP plan, phase E3): the company's `assets` module.
  {
    key: 'assets',
    group: 'operations',
    path: 'assets',
    icon: 'qr-code',
    permission: 'asset.read',
    feature: 'assets',
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
  // Whether the company has e-invoicing at all (ADR-0014): Integr8's switch,
  // shown only to staff acting as the company, and whatever the module's state.
  {
    key: 'eInvoicingSwitch',
    group: 'setup',
    path: 'eInvoicingSwitch',
    icon: 'scale',
    permission: 'eta.switch',
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
    key: 'websiteAccess',
    group: 'company',
    path: 'websiteAccess',
    icon: 'building',
    permission: 'website.access.manage',
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
  /**
   * The company's resolved feature flags, as `/v1/me` returns them. A section
   * gated on a module is hidden when this is left out, so a caller that has
   * not been taught about modules shows nothing it should not.
   */
  features?: Readonly<Record<string, boolean>>,
  /** Whether the assistant is on for this seat in this app; off when not asked. */
  options: { assistant?: boolean } = {},
): { group: NavGroup; sections: NavSection[] }[] {
  const held = new Set(permissions);
  const shown = NAV_SECTIONS.filter(
    (section) =>
      (section.permission === undefined || held.has(section.permission)) &&
      (section.feature === undefined || hasFeature(features, section.feature)) &&
      (section.assistant !== true || options.assistant === true) &&
      !(section.desktopOnly === true && app !== 'desktop') &&
      !(section.webOnly === true && app !== 'web'),
  );
  return NAV_GROUPS.map((group) => ({
    group,
    sections: shown.filter((section) => section.group === group),
  })).filter((entry) => entry.sections.length > 0);
}
