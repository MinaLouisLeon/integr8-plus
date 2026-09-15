import type { SqlDriver } from './sql.js';

/**
 * The local schema, one version at a time.
 *
 * A phone can go weeks without an update and then jump several versions in one
 * install, carrying work that has never reached the server. So:
 *
 * - **Every migration runs in its own transaction with its version number.**
 *   SQLite's schema changes are transactional, and `user_version` is part of the
 *   same file, so a migration that fails leaves the database exactly at the
 *   version before it — never half-changed, never wiped.
 * - **Migrations only ever add or reshape; they never drop unsent work.** Tables
 *   of downloaded data can be rebuilt from the server. `drafts` and files
 *   waiting to upload cannot, and every migration is tested against a database
 *   holding them at each earlier version (`migrations.test.ts`).
 * - **A database newer than the app is left alone.** That happens when an app is
 *   rolled back; opening it would mean guessing at a schema this build has never
 *   seen, and the work in it is still intact for the build that wrote it.
 * - **Statements are listed one by one** rather than split on `;`, because a
 *   trigger body contains semicolons.
 *
 * The local schema is shaped for the phone's reads, not copied from the server:
 * a job row carries its customer's and site's names so the job list is one
 * query with no joins, and access notes are columns because they are the first
 * thing on the job screen. The download (P11) and sync (P12) translate.
 */

export interface Migration {
  version: number;
  name: string;
  statements: readonly string[];
}

export class LocalDatabaseTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `The local database is at version ${String(found)}, newer than this app understands (${String(supported)}).`,
    );
    this.name = 'LocalDatabaseTooNewError';
  }
}

export class MigrationFailedError extends Error {
  constructor(
    readonly version: number,
    readonly migrationName: string,
    cause: unknown,
  ) {
    super(
      `Local migration ${String(version)} (${migrationName}) failed; the database is unchanged.`,
      { cause },
    );
    this.name = 'MigrationFailedError';
  }
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    statements: [
      `create table meta (
        key text primary key,
        value text not null
      ) strict`,

      `create table customers (
        id text primary key,
        name text not null,
        account_number text,
        status text not null,
        phone text,
        email text,
        address_text text not null,
        data text not null,
        downloaded_at text not null
      ) strict`,

      `create table sites (
        id text primary key,
        customer_id text not null,
        name text not null,
        address_text text not null,
        latitude real,
        longitude real,
        gate_code text,
        parking text,
        ask_for text,
        hazards text,
        access_notes text,
        data text not null,
        downloaded_at text not null
      ) strict`,
      `create index sites_by_customer on sites (customer_id)`,

      `create table work_orders (
        id text primary key,
        reference integer not null,
        reference_label text not null,
        title text not null,
        state text not null,
        priority text not null,
        customer_id text not null,
        customer_name text not null,
        site_id text not null,
        site_name text not null,
        site_address text not null,
        job_type_name text not null,
        due_from text,
        due_by text,
        closed_at text,
        data text not null,
        downloaded_at text not null
      ) strict`,
      `create index work_orders_open_by_due on work_orders (closed_at, due_by)`,
      `create index work_orders_by_customer on work_orders (customer_id)`,
      `create index work_orders_by_site on work_orders (site_id)`,

      `create table forms (
        id text primary key,
        title text not null,
        live_version_id text,
        downloaded_at text not null
      ) strict`,

      `create table form_versions (
        id text primary key,
        form_id text not null,
        version_number integer,
        definition text not null,
        downloaded_at text not null
      ) strict`,
      `create index form_versions_by_form on form_versions (form_id)`,

      // Unsent work. Never replaced by a download and never evicted.
      `create table drafts (
        id text primary key,
        form_id text not null,
        form_version_id text not null,
        work_order_id text,
        answers text not null,
        created_at text not null,
        updated_at text not null
      ) strict`,

      `create table files (
        id text primary key,
        owner_kind text not null check (owner_kind in ('work_order', 'customer', 'site', 'draft')),
        owner_id text not null,
        name text not null,
        content_type text not null,
        byte_size integer not null check (byte_size >= 0),
        local_path text not null,
        state text not null check (state in ('downloaded', 'pending_upload')),
        created_at text not null
      ) strict`,
      `create index files_by_owner on files (owner_kind, owner_id)`,
    ],
  },
  {
    version: 2,
    name: 'search',
    statements: [
      // unicode61 with diacritics removed: "Cafe" finds "Café", and Arabic is
      // split into words like any other script.
      `create virtual table search using fts5(
        kind unindexed,
        entity_id unindexed,
        title,
        detail,
        tokenize = 'unicode61 remove_diacritics 2'
      )`,

      `create trigger work_orders_search_insert after insert on work_orders begin
        insert into search (kind, entity_id, title, detail)
        values ('work_order', new.id, new.reference_label || ' ' || new.reference || ' ' || new.title,
                new.customer_name || ' ' || new.site_name || ' ' || new.site_address || ' ' || new.job_type_name);
      end`,
      `create trigger work_orders_search_update after update on work_orders begin
        delete from search where kind = 'work_order' and entity_id = old.id;
        insert into search (kind, entity_id, title, detail)
        values ('work_order', new.id, new.reference_label || ' ' || new.reference || ' ' || new.title,
                new.customer_name || ' ' || new.site_name || ' ' || new.site_address || ' ' || new.job_type_name);
      end`,
      `create trigger work_orders_search_delete after delete on work_orders begin
        delete from search where kind = 'work_order' and entity_id = old.id;
      end`,

      `create trigger customers_search_insert after insert on customers begin
        insert into search (kind, entity_id, title, detail)
        values ('customer', new.id, new.name,
                coalesce(new.account_number, '') || ' ' || coalesce(new.phone, '') || ' ' ||
                coalesce(new.email, '') || ' ' || new.address_text);
      end`,
      `create trigger customers_search_update after update on customers begin
        delete from search where kind = 'customer' and entity_id = old.id;
        insert into search (kind, entity_id, title, detail)
        values ('customer', new.id, new.name,
                coalesce(new.account_number, '') || ' ' || coalesce(new.phone, '') || ' ' ||
                coalesce(new.email, '') || ' ' || new.address_text);
      end`,
      `create trigger customers_search_delete after delete on customers begin
        delete from search where kind = 'customer' and entity_id = old.id;
      end`,

      // Whatever was downloaded before this version becomes searchable too.
      `insert into search (kind, entity_id, title, detail)
       select 'work_order', id, reference_label || ' ' || reference || ' ' || title,
              customer_name || ' ' || site_name || ' ' || site_address || ' ' || job_type_name
       from work_orders`,
      `insert into search (kind, entity_id, title, detail)
       select 'customer', id, name,
              coalesce(account_number, '') || ' ' || coalesce(phone, '') || ' ' ||
              coalesce(email, '') || ' ' || address_text
       from customers`,
    ],
  },
  {
    version: 3,
    name: 'storage budget',
    statements: [
      // Downloaded files are evicted least recently opened first; a file from
      // before this version counts as opened when it arrived.
      `alter table files add column last_opened_at text`,
      `update files set last_opened_at = created_at`,
      `create index files_by_state_and_opened on files (state, last_opened_at)`,
      `create index drafts_by_work_order on drafts (work_order_id)`,
    ],
  },
  {
    version: 4,
    name: 'sync',
    statements: [
      // Every change made on the phone, in the order it was made, until the
      // server has applied it (P12). `id` is the server's dedupe key.
      `create table outbox (
        seq integer primary key autoincrement,
        id text not null unique,
        kind text not null,
        entity_key text not null,
        entity_id text not null,
        work_order_id text,
        payload text not null,
        base text,
        waits_for text not null default '[]',
        recorded_at text not null,
        state text not null check (state in ('pending', 'conflict', 'failed', 'done')),
        attempts integer not null default 0,
        next_attempt_at text,
        last_error text,
        conflict text,
        created_at text not null,
        done_at text
      ) strict`,
      `create index outbox_by_state on outbox (state, seq)`,
      `create index outbox_by_entity on outbox (entity_key, state, seq)`,
      `create index outbox_by_work_order on outbox (work_order_id, state)`,

      // Files on their way to the server, kept apart from changes so a large
      // video never holds up a completed job.
      `create table uploads (
        media_id text primary key,
        local_path text not null,
        content_type text not null,
        byte_size integer not null check (byte_size > 0),
        work_order_id text,
        state text not null check (state in ('queued', 'confirmed', 'failed')),
        kind text check (kind in ('single', 'multipart')),
        part_size integer,
        part_count integer,
        parts_done text not null default '[]',
        bytes_sent integer not null default 0,
        attempts integer not null default 0,
        next_attempt_at text,
        last_error text,
        created_at text not null,
        confirmed_at text
      ) strict`,
      `create index uploads_by_state on uploads (state, created_at)`,
      `create index uploads_by_work_order on uploads (work_order_id, state)`,

      // Forms as the server holds them, and as the engineer is filling them.
      // server_revision and server_answers are what the next change is merged
      // against; null until the server has the form.
      `create table submissions (
        id text primary key,
        form_id text not null,
        form_version_id text not null,
        work_order_id text,
        status text not null check (status in ('draft', 'submitted', 'reopened')),
        answers text not null,
        server_revision integer,
        server_answers text,
        submitted_by text,
        submitted_at text,
        updated_at text not null
      ) strict`,
      `create index submissions_by_work_order on submissions (work_order_id)`,

      // Each sync run, until it has been reported to the server.
      `create table sync_runs (
        id text primary key,
        started_at text not null,
        duration_ms integer not null,
        trigger text not null,
        outcome text not null,
        pushed integer not null,
        conflicts integer not null,
        rejected integer not null,
        retried integer not null,
        pulled integer not null,
        uploads_completed integer not null,
        uploads_failed integer not null,
        uploaded_bytes integer not null,
        queue_depth integer not null,
        pending_uploads integer not null,
        network_type text,
        clock_offset_ms integer,
        reported integer not null default 0
      ) strict`,

      // Drafts from before sync become forms the server has not seen yet; the
      // engine queues them on its first run. Files that were waiting to upload
      // join the upload queue. Nothing is dropped.
      `insert into submissions (id, form_id, form_version_id, work_order_id, status, answers, updated_at)
       select id, form_id, form_version_id, work_order_id, 'draft', answers, updated_at from drafts`,
      `insert into uploads (media_id, local_path, content_type, byte_size, work_order_id, state, created_at)
       select id, local_path, content_type, byte_size,
              case when owner_kind = 'work_order' then owner_id
                   when owner_kind = 'draft' then (select work_order_id from drafts where drafts.id = files.owner_id)
              end, 'queued', created_at
       from files where state = 'pending_upload' and byte_size > 0`,
    ],
  },
  {
    version: 5,
    name: 'forms on the phone',
    statements: [
      // When a change was handed to the network. An autosave is folded into an
      // earlier unsent one, but never into one the server may already have
      // applied under its id (P13).
      `alter table outbox add column sent_at text`,
      // A small copy of a photo, made on the phone, shown while the original
      // waits to upload and after. Relative to the files directory, like
      // local_path.
      `alter table uploads add column thumbnail_path text`,
      `create index submissions_by_form on submissions (form_id, status)`,
    ],
  },
];

export const LATEST_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export interface MigrationOutcome {
  from: number;
  to: number;
}

/** Brings the database up to the newest version this build knows, one version at a time. */
export async function migrate(
  driver: SqlDriver,
  migrations: readonly Migration[] = MIGRATIONS,
): Promise<MigrationOutcome> {
  assertContiguous(migrations);
  const latest = migrations.at(-1)?.version ?? 0;
  const from = await schemaVersion(driver);

  if (from > latest) {
    throw new LocalDatabaseTooNewError(from, latest);
  }

  for (const migration of migrations.filter((candidate) => candidate.version > from)) {
    await driver.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of migration.statements) {
        await driver.exec(statement);
      }
      await driver.exec(`PRAGMA user_version = ${String(migration.version)}`);
      await driver.exec('COMMIT');
    } catch (error) {
      await driver.exec('ROLLBACK');
      throw new MigrationFailedError(migration.version, migration.name, error);
    }
  }

  return { from, to: latest };
}

export async function schemaVersion(driver: SqlDriver): Promise<number> {
  const row = await driver.get<{ user_version: number }>('PRAGMA user_version');
  return row?.user_version ?? 0;
}

function assertContiguous(migrations: readonly Migration[]): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new Error(
        `Local migrations must be numbered 1, 2, 3… with no gaps; found ${String(migration.version)} at position ${String(index + 1)}.`,
      );
    }
  });
}
