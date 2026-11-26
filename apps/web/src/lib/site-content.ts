/**
 * The features the public site names (Low 3). The words are in
 * `@integr8/i18n` (`site.features.*`); this says which keys exist and which
 * the home page highlights, so a test can check every key has words in both
 * languages.
 *
 * The full product story, without prices, is the marketing page on the
 * Integr8 Media website; this site links there and no longer has its own
 * features or pricing pages.
 */

/** Integr8 Plus's marketing page, on the Integr8 Media website. */
export const PRODUCT_PAGE_URL = 'https://www.integr8-media.com/integr8-plus';

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

/** The fifteen features the catalogue describes, grouped. */
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
