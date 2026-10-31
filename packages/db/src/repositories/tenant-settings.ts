import { type Kysely, type Selectable, sql } from 'kysely';
import type { CompanyTheme, Database, TenantSettingsTable } from '../schema.js';

/**
 * How one company works (P18).
 *
 * Branding, where they are, and when they work. On the tenant connection,
 * because these are the company's own to read and change — unlike the plan,
 * which is what they are allowed and is the platform's.
 *
 * A row is created for every company at onboarding and backfilled for the ones
 * that already existed, so nothing downstream has to cope with its absence. The
 * getter still tolerates a missing row and returns the defaults, because the
 * alternative is a company whose settings screen refuses to load.
 */

export interface TenantSettings {
  tenantId: string;
  logoMediaId: string | null;
  brandColour: string | null;
  /** The dashboard shell colour, `#RRGGBB`. Null means the product default (0022). */
  shellColour: string | null;
  /** The theme every app of this company opens in (0022). */
  defaultTheme: CompanyTheme;
  /** The company's own website, https only (0022). */
  websiteUrl: string | null;
  /** A square image for the installer and phone icons; Integr8's when null (0022). */
  appIconMediaId: string | null;
  /** Whether the release pipeline builds this company's own apps (0022). */
  appsEnabled: boolean;
  /** An IANA name, e.g. `Europe/London`. */
  timezone: string;
  currency: string;
  locale: string;
  /** Minutes from midnight, in `timezone`. */
  workDayStarts: number;
  workDayEnds: number;
  /** ISO weekday numbers; 1 is Monday. Empty means the company is closed. */
  workingDays: number[];
  /** Which of the company's apps show the assistant (0044; ADR-0001). Each narrows the platform grant. */
  aiWebEnabled: boolean;
  aiDesktopEnabled: boolean;
  aiMobileEnabled: boolean;
  websiteFilesEnabled: boolean;
  websiteJobsEnabled: boolean;
  websiteQuotesEnabled: boolean;
  websiteInvoicesEnabled: boolean;
  /** Days before a certificate expires that its holder and the managers are warned (0052). */
  qualificationWarningDays: number;
}

export const DEFAULT_SETTINGS: Omit<TenantSettings, 'tenantId'> = {
  logoMediaId: null,
  brandColour: null,
  shellColour: null,
  defaultTheme: 'system',
  websiteUrl: null,
  appIconMediaId: null,
  appsEnabled: false,
  // Cairo time and a Sunday-to-Thursday week since 0057, matching the column
  // defaults: the companies Integr8 serves are Egyptian, and a UTC Monday-to-
  // Friday week ran their deadlines and maintenance through Fridays.
  timezone: 'Africa/Cairo',
  // EGP since 0024 (CRM/ERP plan decision, 2026-10-11), matching the column default.
  currency: 'EGP',
  locale: 'en',
  workDayStarts: 8 * 60,
  workDayEnds: 17 * 60,
  // ISO weekday numbers: 7 is Sunday.
  workingDays: [7, 1, 2, 3, 4],
  aiWebEnabled: false,
  aiDesktopEnabled: false,
  aiMobileEnabled: false,
  websiteFilesEnabled: false,
  websiteJobsEnabled: false,
  websiteQuotesEnabled: false,
  websiteInvoicesEnabled: false,
  qualificationWarningDays: 30,
};

export class TenantSettingsRepository {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly tenantId: string,
  ) {}

  async get(): Promise<TenantSettings> {
    const row = await this.db
      .selectFrom('tenant_settings')
      .selectAll()
      .where('tenant_id', '=', this.tenantId)
      .executeTakeFirst();

    return row === undefined ? { tenantId: this.tenantId, ...DEFAULT_SETTINGS } : toSettings(row);
  }

  /**
   * Writes what was sent, and leaves the rest.
   *
   * Every field optional and an absent one untouched, so a screen that edits
   * branding cannot blank the working hours it never showed.
   */
  async update(input: {
    logoMediaId?: string | null | undefined;
    brandColour?: string | null | undefined;
    shellColour?: string | null | undefined;
    defaultTheme?: CompanyTheme | undefined;
    websiteUrl?: string | null | undefined;
    appIconMediaId?: string | null | undefined;
    appsEnabled?: boolean | undefined;
    timezone?: string | undefined;
    currency?: string | undefined;
    locale?: string | undefined;
    workDayStarts?: number | undefined;
    workDayEnds?: number | undefined;
    workingDays?: number[] | undefined;
    aiWebEnabled?: boolean | undefined;
    aiDesktopEnabled?: boolean | undefined;
    aiMobileEnabled?: boolean | undefined;
    websiteFilesEnabled?: boolean | undefined;
    websiteJobsEnabled?: boolean | undefined;
    websiteQuotesEnabled?: boolean | undefined;
    websiteInvoicesEnabled?: boolean | undefined;
    qualificationWarningDays?: number | undefined;
  }): Promise<TenantSettings> {
    const values = {
      ...(input.logoMediaId === undefined ? {} : { logo_media_id: input.logoMediaId }),
      ...(input.brandColour === undefined ? {} : { brand_colour: input.brandColour }),
      ...(input.shellColour === undefined ? {} : { shell_colour: input.shellColour }),
      ...(input.defaultTheme === undefined ? {} : { default_theme: input.defaultTheme }),
      ...(input.websiteUrl === undefined ? {} : { website_url: input.websiteUrl }),
      ...(input.appIconMediaId === undefined ? {} : { app_icon_media_id: input.appIconMediaId }),
      ...(input.appsEnabled === undefined ? {} : { apps_enabled: input.appsEnabled }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
      ...(input.currency === undefined ? {} : { currency: input.currency.toUpperCase() }),
      ...(input.locale === undefined ? {} : { locale: input.locale }),
      ...(input.workDayStarts === undefined ? {} : { work_day_starts: input.workDayStarts }),
      ...(input.workDayEnds === undefined ? {} : { work_day_ends: input.workDayEnds }),
      ...(input.workingDays === undefined ? {} : { working_days: input.workingDays }),
      ...(input.qualificationWarningDays === undefined
        ? {}
        : { qualification_warning_days: input.qualificationWarningDays }),
      ...(input.aiWebEnabled === undefined ? {} : { ai_web_enabled: input.aiWebEnabled }),
      ...(input.aiDesktopEnabled === undefined
        ? {}
        : { ai_desktop_enabled: input.aiDesktopEnabled }),
      ...(input.aiMobileEnabled === undefined ? {} : { ai_mobile_enabled: input.aiMobileEnabled }),
      ...(input.websiteFilesEnabled === undefined
        ? {}
        : { website_files_enabled: input.websiteFilesEnabled }),
      ...(input.websiteJobsEnabled === undefined
        ? {}
        : { website_jobs_enabled: input.websiteJobsEnabled }),
      ...(input.websiteQuotesEnabled === undefined
        ? {}
        : { website_quotes_enabled: input.websiteQuotesEnabled }),
      ...(input.websiteInvoicesEnabled === undefined
        ? {}
        : { website_invoices_enabled: input.websiteInvoicesEnabled }),
    };

    const row = await this.db
      .insertInto('tenant_settings')
      .values({ tenant_id: this.tenantId, ...values })
      .onConflict((conflict) => conflict.column('tenant_id').doUpdateSet(values))
      .returningAll()
      .executeTakeFirstOrThrow();

    return toSettings(row);
  }

  /**
   * Which kinds of money record the company already holds, in
   * {@link MONEY_RECORD_KINDS} order; empty when it holds none.
   *
   * The company currency is the unit of its books, and the ledger reads it
   * live rather than storing it on every posting. Changing it once these exist
   * would relabel amounts without converting them: stock costs and journals,
   * which carry no currency of their own, would turn from pounds into dollars
   * overnight, and documents that do carry one would stop posting as "another
   * currency". The API refuses the change while this is not empty.
   */
  async moneyRecordKinds(): Promise<MoneyRecordKind[]> {
    const row = await this.db
      .selectNoFrom((eb) => {
        const held = (table: MoneyRecordTable) =>
          eb.exists(
            eb
              .selectFrom(table)
              .select(sql`1`.as('one'))
              .where(`${table}.tenant_id`, '=', this.tenantId),
          );
        return [
          held('crm_quotes').as('quote'),
          held('erp_sales_orders').as('sales_order'),
          held('erp_invoices').as('invoice'),
          held('erp_credit_notes').as('credit_note'),
          held('erp_payment_receipts').as('payment'),
          held('erp_purchase_orders').as('purchase_order'),
          held('erp_journals').as('journal'),
          eb
            .exists(
              eb
                .selectFrom('erp_stock_movements')
                .select(sql`1`.as('one'))
                .where('erp_stock_movements.tenant_id', '=', this.tenantId)
                .where('erp_stock_movements.unit_cost', 'is not', null),
            )
            .as('stock_cost'),
          held('hr_expense_claims').as('expense_claim'),
          held('hr_payroll_runs').as('pay_run'),
        ];
      })
      .executeTakeFirstOrThrow();
    return MONEY_RECORD_KINDS.filter((kind) => row[kind]);
  }
}

/**
 * The records that tie a company to its currency (see
 * {@link TenantSettingsRepository.moneyRecordKinds}): every document with an
 * amount in it, the ledger's own journals, stock that has a cost, and HR's
 * claims and pay runs. Price lists, leads and opportunities are left out: each
 * carries its own currency, and none of them is in the books.
 */
export const MONEY_RECORD_KINDS = [
  'quote',
  'sales_order',
  'invoice',
  'credit_note',
  'payment',
  'purchase_order',
  'journal',
  'stock_cost',
  'expense_claim',
  'pay_run',
] as const;

export type MoneyRecordKind = (typeof MONEY_RECORD_KINDS)[number];

type MoneyRecordTable =
  | 'crm_quotes'
  | 'erp_sales_orders'
  | 'erp_invoices'
  | 'erp_credit_notes'
  | 'erp_payment_receipts'
  | 'erp_purchase_orders'
  | 'erp_journals'
  | 'hr_expense_claims'
  | 'hr_payroll_runs';

/** Creates the row for a company that has just been made. Platform connection. */
export class TenantSettingsWriter {
  constructor(private readonly db: Kysely<Database>) {}

  async ensure(
    tenantId: string,
    input: {
      websiteUrl?: string | null;
      /** Which of its apps show the assistant, chosen at onboarding (ADR-0001). */
      aiChannels?: { web: boolean; desktop: boolean; mobile: boolean };
    } = {},
  ): Promise<void> {
    await this.db
      .insertInto('tenant_settings')
      .values({
        tenant_id: tenantId,
        ...(input.websiteUrl === undefined ? {} : { website_url: input.websiteUrl }),
        ...(input.aiChannels === undefined
          ? {}
          : {
              ai_web_enabled: input.aiChannels.web,
              ai_desktop_enabled: input.aiChannels.desktop,
              ai_mobile_enabled: input.aiChannels.mobile,
            }),
      })
      .onConflict((conflict) => conflict.column('tenant_id').doNothing())
      .execute();
  }

  /**
   * The brand of one company, by its slug, for the public brand endpoint and
   * the build pipeline. Platform connection: there is no session behind the
   * request, so there is no tenant connection to ask.
   */
  async brandBySlug(slug: string): Promise<(TenantSettings & { name: string }) | undefined> {
    const row = await this.db
      .selectFrom('tenants')
      .leftJoin('tenant_settings', 'tenant_settings.tenant_id', 'tenants.id')
      .select(['tenants.id as tenant_id', 'tenants.name'])
      .selectAll('tenant_settings')
      .where('tenants.slug', '=', slug.trim().toLowerCase())
      .where('tenants.deleted_at', 'is', null)
      .executeTakeFirst();

    if (row === undefined) {
      return undefined;
    }
    const { name, ...rest } = row;
    const settings =
      rest.tenant_id === null || rest.default_theme === null
        ? { tenantId: row.tenant_id, ...DEFAULT_SETTINGS }
        : toSettings(rest as Selectable<TenantSettingsTable>);
    return { ...settings, tenantId: row.tenant_id, name };
  }

  /** The brand of one company by id, with its slug, for a public page that found the company another way. */
  async brandByTenantId(
    tenantId: string,
  ): Promise<(TenantSettings & { name: string; slug: string }) | undefined> {
    const row = await this.db
      .selectFrom('tenants')
      .leftJoin('tenant_settings', 'tenant_settings.tenant_id', 'tenants.id')
      .select(['tenants.id as tenant_id', 'tenants.name', 'tenants.slug'])
      .selectAll('tenant_settings')
      .where('tenants.id', '=', tenantId)
      .where('tenants.deleted_at', 'is', null)
      .executeTakeFirst();
    if (row === undefined) {
      return undefined;
    }
    const { name, slug, ...rest } = row;
    const settings =
      rest.tenant_id === null || rest.default_theme === null
        ? { tenantId: row.tenant_id, ...DEFAULT_SETTINGS }
        : toSettings(rest as Selectable<TenantSettingsTable>);
    return { ...settings, tenantId: row.tenant_id, name, slug };
  }

  /** Every live company whose apps the pipeline builds (0022). */
  async companiesWithApps(): Promise<{ tenantId: string; slug: string; name: string }[]> {
    const rows = await this.db
      .selectFrom('tenant_settings')
      .innerJoin('tenants', 'tenants.id', 'tenant_settings.tenant_id')
      .select(['tenants.id', 'tenants.slug', 'tenants.name'])
      .where('tenant_settings.apps_enabled', '=', true)
      .where('tenants.deleted_at', 'is', null)
      .where('tenants.status', '=', 'active')
      .orderBy('tenants.slug', 'asc')
      .execute();
    return rows.map((row) => ({ tenantId: row.id, slug: row.slug, name: row.name }));
  }
}

function toSettings(row: Selectable<TenantSettingsTable>): TenantSettings {
  return {
    tenantId: row.tenant_id,
    logoMediaId: row.logo_media_id,
    brandColour: row.brand_colour,
    shellColour: row.shell_colour,
    defaultTheme: row.default_theme,
    websiteUrl: row.website_url,
    appIconMediaId: row.app_icon_media_id,
    appsEnabled: row.apps_enabled,
    timezone: row.timezone,
    currency: row.currency,
    locale: row.locale,
    workDayStarts: row.work_day_starts,
    workDayEnds: row.work_day_ends,
    workingDays: row.working_days,
    aiWebEnabled: row.ai_web_enabled,
    aiDesktopEnabled: row.ai_desktop_enabled,
    aiMobileEnabled: row.ai_mobile_enabled,
    websiteFilesEnabled: row.website_files_enabled,
    websiteJobsEnabled: row.website_jobs_enabled,
    websiteQuotesEnabled: row.website_quotes_enabled,
    websiteInvoicesEnabled: row.website_invoices_enabled,
    qualificationWarningDays: row.qualification_warning_days,
  };
}
