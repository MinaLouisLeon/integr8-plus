import type { PlatformUserId } from '@integr8/core';
import { type Kysely, type Selectable, sql } from 'kysely';
import type {
  AnnouncementSeverity,
  AnnouncementsTable,
  Database,
  FeatureFlagsTable,
} from '../schema.js';

/**
 * The two things the platform sets and every company reads: which features are
 * turned on for them, and what banner they are shown.
 *
 * Both are written as the platform and read by a company about itself — flags
 * through a select-only grant with the usual policy, announcements through the
 * API, because a null company means every company and that cannot be expressed
 * as row-level security.
 */

export interface FeatureFlag {
  key: string;
  description: string;
  defaultEnabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface Announcement {
  id: string;
  /** Null is every company. */
  tenantId: string | null;
  severity: AnnouncementSeverity;
  /** The text, by language tag: `{ en: 'Maintenance at 22:00 UTC' }`. */
  message: Record<string, string>;
  startsAt: Date;
  endsAt: Date | null;
  dismissible: boolean;
  createdBy: PlatformUserId | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertFeatureFlagInput {
  key: string;
  description: string;
  defaultEnabled: boolean;
}

export interface CreateAnnouncementInput {
  tenantId?: string | null;
  severity?: AnnouncementSeverity;
  message: Record<string, string>;
  startsAt?: Date;
  endsAt?: Date | null;
  dismissible?: boolean;
  createdBy: PlatformUserId | string | null;
}

/** Flags and announcements, as the platform writes them. */
export class PlatformSettingsRepository {
  constructor(private readonly db: Kysely<Database>) {}

  async listFlags(): Promise<FeatureFlag[]> {
    return (await this.db.selectFrom('feature_flags').selectAll().orderBy('key').execute()).map(
      toFlag,
    );
  }

  async upsertFlag(input: UpsertFeatureFlagInput): Promise<FeatureFlag> {
    const row = await this.db
      .insertInto('feature_flags')
      .values({
        key: input.key,
        description: input.description.trim(),
        default_enabled: input.defaultEnabled,
      })
      .onConflict((conflict) =>
        conflict.column('key').doUpdateSet({
          description: input.description.trim(),
          default_enabled: input.defaultEnabled,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return toFlag(row);
  }

  /** What one company has been given, by flag key. Absent means the flag's default. */
  async flagsFor(tenantId: string): Promise<Record<string, boolean>> {
    const rows = await this.db
      .selectFrom('tenant_feature_flags')
      .select(['key', 'enabled'])
      .where('tenant_id', '=', tenantId)
      .execute();

    return Object.fromEntries(rows.map((row) => [row.key, row.enabled]));
  }

  /** Every company's answers for one flag, for the screen that shows who has it. */
  async tenantsWithFlag(key: string): Promise<{ tenantId: string; enabled: boolean }[]> {
    const rows = await this.db
      .selectFrom('tenant_feature_flags')
      .select(['tenant_id', 'enabled'])
      .where('key', '=', key)
      .execute();

    return rows.map((row) => ({ tenantId: row.tenant_id, enabled: row.enabled }));
  }

  /** Turns a flag on or off for one company. `undefined` puts it back to the default. */
  async setFlag(input: {
    tenantId: string;
    key: string;
    enabled: boolean | undefined;
    updatedBy: PlatformUserId | string | null;
  }): Promise<void> {
    if (input.enabled === undefined) {
      await this.db
        .deleteFrom('tenant_feature_flags')
        .where('tenant_id', '=', input.tenantId)
        .where('key', '=', input.key)
        .execute();
      return;
    }
    await this.db
      .insertInto('tenant_feature_flags')
      .values({
        tenant_id: input.tenantId,
        key: input.key,
        enabled: input.enabled,
        updated_by: input.updatedBy ?? null,
      })
      .onConflict((conflict) =>
        conflict.columns(['tenant_id', 'key']).doUpdateSet({
          enabled: input.enabled,
          updated_by: input.updatedBy ?? null,
        }),
      )
      .execute();
  }

  async createAnnouncement(input: CreateAnnouncementInput): Promise<Announcement> {
    const row = await this.db
      .insertInto('announcements')
      .values({
        tenant_id: input.tenantId ?? null,
        ...(input.severity === undefined ? {} : { severity: input.severity }),
        message: JSON.stringify(input.message) as never,
        ...(input.startsAt === undefined ? {} : { starts_at: input.startsAt }),
        ends_at: input.endsAt ?? null,
        ...(input.dismissible === undefined ? {} : { dismissible: input.dismissible }),
        created_by: input.createdBy ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();

    return toAnnouncement(row);
  }

  async listAnnouncements(
    options: { includeFinished?: boolean; now?: Date } = {},
  ): Promise<Announcement[]> {
    const now = options.now ?? new Date();
    let select = this.db.selectFrom('announcements').selectAll();
    if (options.includeFinished !== true) {
      select = select.where((where) =>
        where.or([where('ends_at', 'is', null), where('ends_at', '>', now)]),
      );
    }
    return (await select.orderBy('starts_at', 'desc').execute()).map(toAnnouncement);
  }

  /** What one company should be shown right now: theirs, and everybody's. */
  async announcementsFor(tenantId: string, at?: Date): Promise<Announcement[]> {
    // The database's clock by default, not this process's.
    //
    // `starts_at` defaults to `now()` in Postgres, so comparing it against a
    // `Date` from Node means comparing two clocks. A few milliseconds of skew
    // the wrong way and an announcement somebody has just posted is invisible
    // until the skew is made up — which is the worst possible moment for the
    // banner saying the system is about to go down.
    const now = at ?? sql<Date>`now()`;

    const rows = await this.db
      .selectFrom('announcements')
      .selectAll()
      .where((where) =>
        where.or([where('tenant_id', 'is', null), where('tenant_id', '=', tenantId)]),
      )
      .where('starts_at', '<=', now)
      .where((where) => where.or([where('ends_at', 'is', null), where('ends_at', '>', now)]))
      .orderBy('severity')
      .orderBy('starts_at', 'desc')
      .execute();

    return rows.map(toAnnouncement);
  }

  /** Ends an announcement now, rather than deleting it: it was shown, and that is history. */
  async endAnnouncement(id: string, now = new Date()): Promise<Announcement | undefined> {
    const row = await this.db
      .updateTable('announcements')
      .set({ ends_at: now })
      .where('id', '=', id)
      .where((where) => where.or([where('ends_at', 'is', null), where('ends_at', '>', now)]))
      .returningAll()
      .executeTakeFirst();

    return row === undefined ? undefined : toAnnouncement(row);
  }
}

/**
 * What a company may read about itself: the flags it has, resolved against
 * their defaults. Select-only, behind the usual policy.
 */
export class FeatureFlagsReader {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly tenantId: string,
  ) {}

  async resolved(): Promise<Record<string, boolean>> {
    const [flags, own] = await Promise.all([
      this.db.selectFrom('feature_flags').select(['key', 'default_enabled']).execute(),
      this.db
        .selectFrom('tenant_feature_flags')
        .select(['key', 'enabled'])
        .where('tenant_id', '=', this.tenantId)
        .execute(),
    ]);

    const resolved = Object.fromEntries(flags.map((flag) => [flag.key, flag.default_enabled]));
    for (const row of own) {
      resolved[row.key] = row.enabled;
    }
    return resolved;
  }
}

function toFlag(row: Selectable<FeatureFlagsTable>): FeatureFlag {
  return {
    key: row.key,
    description: row.description,
    defaultEnabled: row.default_enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toAnnouncement(row: Selectable<AnnouncementsTable>): Announcement {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    severity: row.severity,
    message: row.message,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    dismissible: row.dismissible,
    createdBy: row.created_by as PlatformUserId | null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
