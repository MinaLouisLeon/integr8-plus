import { toTenantId } from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTenant } from '../connection.js';
import {
  EXPORTED_TABLES,
  NOT_EXPORTED_TABLES,
  WITHHELD_COLUMNS,
} from '../repositories/tenant-data-export.js';
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
 * The export a company is handed before it is deleted (P15).
 *
 * The list of exported tables is written by hand on purpose, which is also how
 * it once fell eight migrations behind: documents, e-invoices with their Tax
 * Authority history, visits and the company's own settings were all missing.
 * This suite makes forgetting a table fail: every table whose `tenant_id`
 * references `tenants` is either exported or named, with a reason, as not.
 */

const USER = '00000000-0000-4000-8000-00000000f901';

/** The tables purge_tenant() empties, which are exactly a company's rows. */
const COMPANY_TABLES_SQL = `
  select distinct child.relname::text as name
    from pg_constraint con
    join pg_class child on child.oid = con.conrelid
    join pg_class parent on parent.oid = con.confrelid
    join pg_attribute att on att.attrelid = child.oid and att.attnum = any (con.conkey)
   where con.contype = 'f'
     and parent.relname = 'tenants'
     and parent.relnamespace = 'public'::regnamespace
     and child.relnamespace = 'public'::regnamespace
     and att.attname = 'tenant_id'
   order by 1`;

let owner: pg.Client;
let northwind: TenantFixture;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  northwind = await createTenant('export-northwind');
});

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

describe('the export list', () => {
  it('names every company table, as exported or as not exported with a reason', async () => {
    const companyTables = (await owner.query<{ name: string }>(COMPANY_TABLES_SQL)).rows.map(
      (row) => row.name,
    );
    const exported = new Set<string>(EXPORTED_TABLES);
    const notExported = new Set(Object.keys(NOT_EXPORTED_TABLES));

    const forgotten = companyTables.filter(
      (table) => !exported.has(table) && !notExported.has(table),
    );
    expect(forgotten, 'company tables in neither list').toEqual([]);

    const both = [...exported].filter((table) => notExported.has(table));
    expect(both, 'tables in both lists').toEqual([]);

    // A name left behind by a dropped or renamed table hides nothing today but
    // would let the lists drift from the schema without anybody noticing.
    const known = new Set(companyTables);
    expect([...exported, ...notExported].filter((table) => !known.has(table))).toEqual([]);

    for (const [table, reason] of Object.entries(NOT_EXPORTED_TABLES)) {
      expect(reason.trim().length, `reason for ${table}`).toBeGreaterThan(10);
    }
  });

  it('withholds columns that exist, so renaming one cannot quietly export it', async () => {
    for (const [table, columns] of Object.entries(WITHHELD_COLUMNS)) {
      const result = await owner.query<{ name: string }>(
        `select attname::text as name from pg_attribute
          where attrelid = $1::regclass and attnum > 0 and not attisdropped`,
        [`public.${table}`],
      );
      const present = new Set(result.rows.map((row) => row.name));
      for (const column of columns ?? []) {
        expect(present.has(column), `${table}.${column}`).toBe(true);
      }
    }
  });
});

describe('reading a company', () => {
  it('reads every exported table through the company connection, without sealed values', async () => {
    await owner.query(
      `insert into tenant_settings (tenant_id, timezone, currency) values ($1, 'Africa/Cairo', 'EGP')
       on conflict (tenant_id) do nothing`,
      [northwind.id],
    );
    await withUnprotectedRepositories(toTenantId(northwind.id), (tx) =>
      tx.eta.saveCredentials(
        { clientId: 'sealed-client-id', clientSecret: 'sealed-client-secret', hint: 'ab12' },
        USER,
      ),
    );

    const { tables, counts } = await withTenant(northwind.id, (tx) => tx.dataExport.readAll());

    expect(Object.keys(tables).sort()).toEqual([...EXPORTED_TABLES].sort());
    expect(counts.tenant_settings).toBe(1);
    expect(tables.tenant_settings?.[0]).toMatchObject({ timezone: 'Africa/Cairo' });

    expect(counts.eta_settings).toBe(1);
    const eta = tables.eta_settings?.[0] as Record<string, unknown>;
    expect(eta).toMatchObject({ credentials_hint: 'ab12', credentials_version: 1 });
    expect(eta).not.toHaveProperty('client_id_sealed');
    expect(eta).not.toHaveProperty('client_secret_sealed');
    // Columns that are not withheld still arrive, including ones added later.
    expect(eta).toHaveProperty('pinned_certificates');
    expect(JSON.stringify(tables)).not.toContain('sealed-client');
  });
});
