import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  connectAsOwner,
  createTenant,
  releaseTestDatabase,
  type TenantFixture,
  truncateAll,
  useTestDatabase,
  withUnprotectedRepositories,
} from './harness.js';

/**
 * Migration 0055: closing a company removes every one of its rows, whatever
 * guards and triggers its tables carry, and nothing of anybody else's.
 *
 * The purge suspends triggers and foreign-key checks while it runs, which is
 * only safe while two things hold: it deletes from every table that holds a
 * company's rows, and no table it leaves alone points at a row it deletes. The
 * first describe block pins both, so a new table that breaks either fails here
 * rather than leaving orphans in production.
 */

const USER = '00000000-0000-4000-8000-00000000f801';

/** Keep a company's history after it has gone; tenant_id there has no key. */
const HISTORY_TABLES = ['platform_audit_log', 'tenant_deletions', 'tenant_exports'];

/** The list purge_tenant() works out for itself. */
const PURGED_TABLES_SQL = `
  select distinct child.relname::text as name
    from pg_constraint con
    join pg_class child on child.oid = con.conrelid
    join pg_class parent on parent.oid = con.confrelid
    join pg_attribute att on att.attrelid = child.oid and att.attnum = any (con.conkey)
   where con.contype = 'f'
     and parent.relname = 'tenants'
     and parent.relnamespace = 'public'::regnamespace
     and child.relnamespace = 'public'::regnamespace
     and att.attname = 'tenant_id'`;

let owner: pg.Client;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
});

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

async function tablesWithTenantId(): Promise<string[]> {
  const result = await owner.query<{ name: string }>(
    `select c.relname::text as name
       from pg_class c
       join pg_attribute a on a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped
      where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace
      order by 1`,
  );
  return result.rows.map((row) => row.name);
}

async function rowsPerTable(tenantId: string): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of await tablesWithTenantId()) {
    if (HISTORY_TABLES.includes(table)) continue;
    const result = await owner.query<{ n: number }>(
      `select count(*)::int as n from public.${table} where tenant_id = $1`,
      [tenantId],
    );
    counts[table] = result.rows[0]?.n ?? 0;
  }
  return counts;
}

/**
 * A customer and a site (whose deletion writes sync records), and a form with a
 * published version, which refuses DELETE for every role.
 */
async function seed(tenant: TenantFixture): Promise<void> {
  const customer = await withUnprotectedRepositories(tenant.id, (tx) =>
    tx.customers.create({ name: `${tenant.name} customer` }, USER),
  );
  await withUnprotectedRepositories(tenant.id, (tx) =>
    tx.sites.create(customer.id, { name: 'Plant room', address: { line1: '1 River Road' } }, USER),
  );
  const form = await owner.query<{ id: string }>(
    `insert into forms (tenant_id, title, created_by) values ($1, 'Boiler service', $2) returning id`,
    [tenant.id, USER],
  );
  await owner.query(
    `insert into form_versions
       (tenant_id, form_id, status, version_number, definition, definition_schema_version,
        created_by, published_at, published_by, reportable_fields)
     values ($1, $2, 'published', 1, '{"schemaVersion":1}', 1, $3, now(), $3, '[]')`,
    [tenant.id, form.rows[0]!.id, USER],
  );
}

async function scheduleDeletion(tenant: TenantFixture): Promise<void> {
  const exported = await owner.query<{ id: string }>(
    `insert into tenant_exports (tenant_id, tenant_slug, status, object_key)
     values ($1, $2, 'ready', 'exports/purge.zip') returning id`,
    [tenant.id, tenant.slug],
  );
  await owner.query(
    `insert into tenant_deletions (tenant_id, tenant_slug, export_id, reason, purge_after)
     values ($1, $2, $3, 'Integration test of the purge', now() - interval '1 minute')`,
    [tenant.id, tenant.slug, exported.rows[0]!.id],
  );
}

describe('what the purge relies on', () => {
  it('reaches every table that holds company rows, except the ones keeping its history', async () => {
    const purged = (await owner.query<{ name: string }>(PURGED_TABLES_SQL)).rows.map(
      (row) => row.name,
    );
    const missed = (await tablesWithTenantId()).filter((table) => !purged.includes(table));
    expect(missed.sort()).toEqual([...HISTORY_TABLES].sort());
  });

  it('leaves no table outside its list pointing at a table inside it', async () => {
    const result = await owner.query<{ referencing: string; referenced: string }>(
      `with purged as (${PURGED_TABLES_SQL})
       select src.relname::text as referencing, dst.relname::text as referenced
         from pg_constraint con
         join pg_class src on src.oid = con.conrelid
         join pg_class dst on dst.oid = con.confrelid
        where con.contype = 'f'
          and dst.relname in (select name from purged)
          and src.relname not in (select name from purged)
          and dst.relname <> 'tenants'`,
    );
    expect(result.rows).toEqual([]);
  });
});

describe('purging a company', () => {
  it('removes a company with a published form and sites, and nobody else’s rows', async () => {
    const doomed = await createTenant('purge-doomed');
    const neighbour = await createTenant('purge-neighbour');
    await seed(doomed);
    await seed(neighbour);
    const neighbourBefore = await rowsPerTable(neighbour.id);
    await scheduleDeletion(doomed);

    await owner.query('select purge_tenant($1)', [doomed.id]);

    const left = Object.entries(await rowsPerTable(doomed.id)).filter(([, n]) => n > 0);
    expect(left).toEqual([]);
    const tenants = await owner.query('select 1 from tenants where id = $1', [doomed.id]);
    expect(tenants.rowCount).toBe(0);
    const deletion = await owner.query<{ done: boolean }>(
      'select completed_at is not null as done from tenant_deletions where tenant_id = $1',
      [doomed.id],
    );
    expect(deletion.rows).toEqual([{ done: true }]);

    expect(await rowsPerTable(neighbour.id)).toEqual(neighbourBefore);
    expect(neighbourBefore.form_versions).toBe(1);
  });

  it('puts triggers back on for the rest of the connection', async () => {
    const doomed = await createTenant('purge-triggers');
    await seed(doomed);
    await scheduleDeletion(doomed);

    await owner.query('select purge_tenant($1)', [doomed.id]);

    const setting = await owner.query<{ role: string }>(
      `select current_setting('session_replication_role') as role`,
    );
    expect(setting.rows[0]?.role).toBe('origin');
    // A published version still refuses deletion once the purge is over.
    const survivor = await createTenant('purge-survivor');
    await seed(survivor);
    await expect(
      owner.query('delete from form_versions where tenant_id = $1', [survivor.id]),
    ).rejects.toThrow(/published and immutable/);
  });
});
