/**
 * The help library's shape (docs/ai §7.2; ADR-0001; Low 12).
 *
 * One library, read in two places: the API seeds it into `ai_help_articles`
 * for the in-app assistant, and the web app's public Help centre shows the
 * articles marked `public`. It lives in `@integr8/i18n` because it is
 * user-facing text in both languages, which the repository keeps here, and
 * because both apps already depend on this package while neither may import
 * the other. It is a subpath (`@integr8/i18n/help`) so no screen but the help
 * page carries it in its bundle, and it imports nothing, so the API reads it
 * without React.
 */

/** One language's text of an article. Plain text: paragraphs are separated by a blank line. */
export interface HelpArticleText {
  title: string;
  summary: string;
  body: string;
  keywords: string[];
}

/** Where an article sits in the public Help centre. */
export const PUBLIC_HELP_CATEGORIES = [
  'getting-started',
  'field-work',
  'phone-app',
  'forms-documents',
  'sales-finance',
  'stock-assets',
  'people-hr',
  'account-billing',
] as const;
export type PublicHelpCategory = (typeof PUBLIC_HELP_CATEGORIES)[number];

/** An article as the public Help centre shows it: under a category, as a question. */
export interface PublicHelpPlacement {
  category: PublicHelpCategory;
  question: { en: string; ar: string };
}

/** A curated help article the assistant may cite and the Help centre may show. */
export interface HelpArticleSource {
  /** Stable key: ^[a-z][a-z0-9_]{0,63}$. The public slug is this with `-` for `_`. */
  key: string;
  /** Product area: 'overview' | 'account' | 'customers' | 'work_orders' | 'mobile' | 'forms' | 'documents' | 'crm' | 'sales' | 'inventory' | 'purchasing' | 'finance' | 'e_invoicing' | 'ledger' | 'assets' | 'hr' | 'payroll' | 'manufacturing' | 'website' | 'subscription' | 'troubleshooting' */
  module: string;
  /**
   * The module flag a company must have for the assistant to offer this
   * article, or null for everybody: one of MODULE_FEATURES in
   * packages/core/src/crm.ts.
   */
  feature: string | null;
  /**
   * The switchable modules (MODULE_FEATURES) this article explains, when that
   * is more than its `feature`: an article about the company website covers
   * all four website switches without being hidden behind one of them. A test
   * in the API checks every module is covered by at least one article.
   */
  covers?: readonly string[];
  /** The permission a seat needs for this article to be offered (one of PERMISSIONS in packages/core/src/permissions.ts), or null when everybody signed in may read it. */
  minPermission: string | null;
  /** The app route key the article is about (a NavPath from packages/core/src/navigation.ts), or null. Clients map it to their own screen. */
  appRoute: string | null;
  /** Shown in the public Help centre, under this category and question; null keeps it in the app only. */
  public: PublicHelpPlacement | null;
  en: HelpArticleText;
  ar: HelpArticleText;
}
