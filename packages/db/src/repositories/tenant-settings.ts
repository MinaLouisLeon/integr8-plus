import type { Kysely, Selectable } from 'kysely';
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
}

export const DEFAULT_SETTINGS: Omit<TenantSettings, 'tenantId'> = {
  logoMediaId: null,
  brandColour: null,
  shellColour: null,
  defaultTheme: 'system',
  websiteUrl: null,
  appIconMediaId: null,
  appsEnabled: false,
  timezone: 'UTC',
  currency: 'GBP',
  locale: 'en',
  workDayStarts: 8 * 60,
  workDayEnds: 17 * 60,
  workingDays: [1, 2, 3, 4, 5],
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
    };

    const row = await this.db
      .insertInto('tenant_settings')
      .values({ tenant_id: this.tenantId, ...values })
      .onConflict((conflict) => conflict.column('tenant_id').doUpdateSet(values))
      .returningAll()
      .executeTakeFirstOrThrow();

    return toSettings(row);
  }
}

/** Creates the row for a company that has just been made. Platform connection. */
export class TenantSettingsWriter {
  constructor(private readonly db: Kysely<Database>) {}

  async ensure(tenantId: string, input: { websiteUrl?: string | null } = {}): Promise<void> {
    await this.db
      .insertInto('tenant_settings')
      .values({
        tenant_id: tenantId,
        ...(input.websiteUrl === undefined ? {} : { website_url: input.websiteUrl }),
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
  };
}
