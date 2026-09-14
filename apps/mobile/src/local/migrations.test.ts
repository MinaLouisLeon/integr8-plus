import { describe, expect, it } from 'vitest';
import { LocalDatabase } from './database';
import { evict } from './eviction';
import {
  LATEST_VERSION,
  LocalDatabaseTooNewError,
  migrate,
  type Migration,
  MigrationFailedError,
  MIGRATIONS,
  schemaVersion,
} from './migrations';
import { job, openJobs, storageSummary } from './queries';
import { searchLocal } from './search';
import type { SqlDriver } from './sql';
import { NodeSqlDriver } from './testing/node-driver';

/**
 * "Upgrading the app across two local schema versions preserves all unsent
 * work" (P11).
 *
 * For every version an older build could have left on a phone, this writes
 * unsent work the way that build would have — with that version's columns —
 * then upgrades straight to the newest schema and reads the work back through
 * today's queries. A new migration cannot land without a fixture for the
 * version before it, so the guarantee holds for every future upgrade too.
 */

const DRAFT = 'draft-0001';
const PENDING_PHOTO = 'file-pending-0001';
const JOB = 'job-0001';
const FORM_VERSION = 'form-version-0001';

/** Unsent work as each schema version stored it. */
const UNSENT_WORK_AT: Record<number, (driver: SqlDriver) => Promise<void>> = {
  1: async (driver) => {
    await driver.run(
      `insert into customers (id, name, account_number, status, phone, email, address_text, data, downloaded_at)
       values ('customer-1', 'Riverside Housing', 'RH-001', 'active', null, null, '1 River Road, Leeds', '{}', '2026-07-01T09:00:00.000Z')`,
    );
    await driver.run(
      `insert into work_orders (id, reference, reference_label, title, state, priority, customer_id, customer_name,
                                site_id, site_name, site_address, job_type_name, due_from, due_by, closed_at, data, downloaded_at)
       values (?, 42, 'WO-000042', 'Boiler service', 'complete', 'normal', 'customer-1', 'Riverside Housing',
               'site-1', 'Block A', '1 River Road, Leeds', 'Boiler service', null, null,
               '2026-06-01T09:00:00.000Z', ?, '2026-07-01T09:00:00.000Z')`,
      [JOB, JSON.stringify({ workOrder: { id: JOB }, forms: [] })],
    );
    await driver.run(
      `insert into form_versions (id, form_id, version_number, definition, downloaded_at)
       values (?, 'form-1', 1, '{}', '2026-07-01T09:00:00.000Z')`,
      [FORM_VERSION],
    );
    await driver.run(
      `insert into drafts (id, form_id, form_version_id, work_order_id, answers, created_at, updated_at)
       values (?, 'form-1', ?, ?, '{"note":"Flue cracked"}', '2026-06-01T08:00:00.000Z', '2026-06-01T08:30:00.000Z')`,
      [DRAFT, FORM_VERSION, JOB],
    );
    await driver.run(
      `insert into files (id, owner_kind, owner_id, name, content_type, byte_size, local_path, state, created_at)
       values (?, 'draft', ?, 'flue.jpg', 'image/jpeg', 2400000, 'files/flue.jpg', 'pending_upload', '2026-06-01T08:10:00.000Z')`,
      [PENDING_PHOTO, DRAFT],
    );
  },
  // Version 2 added search and changed none of these tables.
  2: (driver) => UNSENT_WORK_AT[1]!(driver),
};

async function databaseAt(version: number): Promise<NodeSqlDriver> {
  const driver = new NodeSqlDriver();
  await migrate(
    driver,
    MIGRATIONS.filter((migration) => migration.version <= version),
  );
  expect(await schemaVersion(driver)).toBe(version);
  return driver;
}

describe('upgrading with unsent work on the phone', () => {
  it('has unsent work written for every version an older build could have left', () => {
    const olderVersions = MIGRATIONS.map((migration) => migration.version).filter(
      (version) => version < LATEST_VERSION,
    );
    expect(Object.keys(UNSENT_WORK_AT).map(Number)).toEqual(olderVersions);
  });

  it.each(Object.keys(UNSENT_WORK_AT).map(Number))(
    'keeps every draft and pending upload when upgrading from version %i',
    async (from) => {
      const driver = await databaseAt(from);
      await UNSENT_WORK_AT[from]!(driver);

      expect(await migrate(driver)).toEqual({ from, to: LATEST_VERSION });
      const db = new LocalDatabase(driver);

      const drafts = await driver.all<{ id: string; answers: string; work_order_id: string }>(
        'select id, answers, work_order_id from drafts',
      );
      expect(drafts).toEqual([
        { id: DRAFT, answers: '{"note":"Flue cracked"}', work_order_id: JOB },
      ]);

      const files = await driver.all<{ id: string; state: string; last_opened_at: string }>(
        'select id, state, last_opened_at from files',
      );
      expect(files).toEqual([
        { id: PENDING_PHOTO, state: 'pending_upload', last_opened_at: '2026-06-01T08:10:00.000Z' },
      ]);

      // Today's queries read it, and search finds what was downloaded before search existed.
      expect(await db.read(storageSummary)).toMatchObject({ unsentDrafts: 1, pendingUploads: 1 });
      expect(await db.read((sql) => job(sql, JOB))).toBeDefined();
      expect((await db.read((sql) => searchLocal(sql, 'WO-000042'))).workOrders).toHaveLength(1);
      expect((await db.read((sql) => searchLocal(sql, 'riverside'))).customers).toHaveLength(1);

      // The job closed long ago, but a draft points at it: eviction keeps it, and its form version.
      const evicted = await db.write(['work_orders'], (sql) =>
        evict(sql, new Date('2026-09-14T12:00:00.000Z')),
      );
      expect(evicted).toMatchObject({ workOrders: 0, formVersions: 0 });
      expect(await db.read((sql) => job(sql, JOB))).toBeDefined();
    },
  );

  it('opens a fresh phone straight at the newest version', async () => {
    const driver = new NodeSqlDriver();
    expect(await migrate(driver)).toEqual({ from: 0, to: LATEST_VERSION });
    expect(await new LocalDatabase(driver).read(openJobs)).toEqual([]);
    expect(await migrate(driver)).toEqual({ from: LATEST_VERSION, to: LATEST_VERSION });
  });
});

describe('when an upgrade cannot be applied', () => {
  it('leaves the database at the version before a failing migration, with its work intact', async () => {
    const driver = await databaseAt(1);
    await UNSENT_WORK_AT[1]!(driver);
    const broken: Migration[] = [
      ...MIGRATIONS.filter((migration) => migration.version <= 2),
      {
        version: 3,
        name: 'broken',
        statements: [
          'alter table files add column last_opened_at text',
          'delete from drafts',
          'this is not sql',
        ],
      },
    ];

    const failure = await migrate(driver, broken).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(MigrationFailedError);
    expect(failure).toMatchObject({ version: 3, migrationName: 'broken' });

    // Version 2 committed; version 3 rolled back entirely, its delete included.
    expect(await schemaVersion(driver)).toBe(2);
    expect(await driver.all('select id from drafts')).toEqual([{ id: DRAFT }]);
    const columns = await driver.all<{ name: string }>('pragma table_info(files)');
    expect(columns.map((column) => column.name)).not.toContain('last_opened_at');

    // The real migration then applies cleanly.
    expect(await migrate(driver)).toEqual({ from: 2, to: LATEST_VERSION });
  });

  it('refuses a database written by a newer build rather than guessing at it', async () => {
    const driver = await databaseAt(LATEST_VERSION);
    await driver.exec(`PRAGMA user_version = ${String(LATEST_VERSION + 1)}`);
    await expect(migrate(driver)).rejects.toBeInstanceOf(LocalDatabaseTooNewError);
    expect(await schemaVersion(driver)).toBe(LATEST_VERSION + 1);
  });

  it('refuses a migration list with a gap', async () => {
    const gap = [MIGRATIONS[0]!, { ...MIGRATIONS[2]!, version: 3 }];
    await expect(
      migrate(new NodeSqlDriver(), gap.slice(0, 1).concat([{ ...gap[1]!, version: 4 }])),
    ).rejects.toThrow(/no gaps/u);
  });
});
