/**
 * The order and grouping of what the public pages list (Low 3). The words are
 * in `@integr8/i18n` (`site.*`); this says which keys, in which order, so the
 * features page and the home page's highlights cannot disagree about it, and
 * a test can check every key has words in both languages.
 */

export type FeatureGroup = 'field' | 'office' | 'business' | 'platform';

export interface FeatureEntry {
  key:
    | 'offline'
    | 'workOrders'
    | 'schedule'
    | 'forms'
    | 'submissions'
    | 'customers'
    | 'contracts'
    | 'crm'
    | 'inventory'
    | 'finance'
    | 'people'
    | 'documents'
    | 'assistant'
    | 'branding'
    | 'data';
  group: FeatureGroup;
}

/** The fifteen features, in the order the features page shows them. */
export const FEATURES: readonly FeatureEntry[] = [
  { key: 'offline', group: 'field' },
  { key: 'workOrders', group: 'field' },
  { key: 'schedule', group: 'field' },
  { key: 'forms', group: 'field' },
  { key: 'submissions', group: 'field' },
  { key: 'customers', group: 'office' },
  { key: 'contracts', group: 'office' },
  { key: 'crm', group: 'office' },
  { key: 'inventory', group: 'office' },
  { key: 'finance', group: 'business' },
  { key: 'people', group: 'business' },
  { key: 'documents', group: 'business' },
  { key: 'assistant', group: 'platform' },
  { key: 'branding', group: 'platform' },
  { key: 'data', group: 'platform' },
];

/** The six the home page shows. */
export const HIGHLIGHTS: readonly FeatureEntry['key'][] = [
  'offline',
  'workOrders',
  'forms',
  'contracts',
  'documents',
  'branding',
];

export const FEATURE_GROUPS: readonly FeatureGroup[] = ['field', 'office', 'business', 'platform'];

/** The colour each group's chip wears, from the company site's palette. */
export const GROUP_COLOUR: Readonly<Record<FeatureGroup, string>> = {
  field: 'var(--site-lime)',
  office: 'var(--site-cyan)',
  business: 'var(--site-pink)',
  platform: 'var(--site-violet)',
};
