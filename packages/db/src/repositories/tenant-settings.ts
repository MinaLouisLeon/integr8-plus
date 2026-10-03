import type { Kysely, Selectable } from 'kysely';
import type { Database, TenantSettingsTable } from '../schema.js';

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

  async ensure(tenantId: string): Promise<void> {
    await this.db
      .insertInto('tenant_settings')
      .values({ tenant_id: tenantId })
      .onConflict((conflict) => conflict.column('tenant_id').doNothing())
      .execute();
  }
}

function toSettings(row: Selectable<TenantSettingsTable>): TenantSettings {
  return {
    tenantId: row.tenant_id,
    logoMediaId: row.logo_media_id,
    brandColour: row.brand_colour,
    timezone: row.timezone,
    currency: row.currency,
    locale: row.locale,
    workDayStarts: row.work_day_starts,
    workDayEnds: row.work_day_ends,
    workingDays: row.working_days,
  };
}
