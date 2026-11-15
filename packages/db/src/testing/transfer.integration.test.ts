import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readCompany, TransferRefusedError, writeCompany } from '../transfer/company.js';
import { NOT_TRANSFERRED, transferTables } from '../transfer/tables.js';
import { generateVolume } from '../volume/generate.js';
import {
  connectAsOwner,
  releaseTestDatabase,
  requireDisposableDatabase,
  truncateAll,
  useTestDatabase,
} from './harness.js';

/**
 * Moving a company out of one database and into another (P41).
 *
 * The suite has one database, so the company makes the round trip through it:
 * read out, purged, written back, and compared with what it was, table by
 * table, as JSON text. Equal text means equal rows, to the microsecond and the
 * last digit of every amount.
 */

let owner: pg.Client;
let tenantId: string;

beforeAll(async () => {
  useTestDatabase();
  await truncateAll();
  owner = await connectAsOwner();
  await generateVolume(requireDisposableDatabase().adminUrl, {
    companies: 1,
    years: 2,
    scale: 0.01,
  });
  const row = await owner.query<{ id: string }>(
    `select id from tenants where slug like 'volume-%'`,
  );
  tenantId = row.rows[0]?.id ?? '';
}, 120_000);

afterAll(async () => {
  await owner.end();
  await releaseTestDatabase();
});

/** Each table's rows of the company, as one fingerprint. */
async function fingerprints(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of await transferTables(owner)) {
    const column = table.name === 'tenants' ? 'id' : 'tenant_id';
    const result = await owner.query<{ sum: string }>(
      `select md5(coalesce(string_agg(to_jsonb(x)::text, '' order by to_jsonb(x)::text), '')) as sum
         from "${table.name}" x where "${column}" = $1`,
      [tenantId],
    );
    out[table.name] = result.rows[0]?.sum ?? '';
  }
  return out;
}

async function purge(id: string): Promise<void> {
  const exported = await owner.query<{ id: string }>(
    `insert into tenant_exports (tenant_id, tenant_slug, status, object_key)
     values ($1, 'moved', 'ready', 'exports/moved.tar.gz') returning id`,
    [id],
  );
  await owner.query(
    `insert into tenant_deletions (tenant_id, tenant_slug, export_id, reason, purge_after)
     values ($1, 'moved', $2, 'Transfer round trip in the suite', now() - interval '1 minute')`,
    [id, exported.rows[0]?.id],
  );
  await owner.query('select purge_tenant($1)', [id]);
}

describe('a company transfer', () => {
  it('carries every company table except the ones bound to the old server, each named with a reason', async () => {
    const carried = (await transferTables(owner)).map((table) => table.name);
    const real = (
      await owner.query<{ name: string }>(
        `select relname::text as name from pg_class
          where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and not relispartition`,
      )
    ).rows.map((row) => row.name);

    expect(carried[0]).toBe('tenants');
    for (const name of Object.keys(NOT_TRANSFERRED)) {
      expect(real, `${name} in NOT_TRANSFERRED is not a table`).toContain(name);
      expect(carried).not.toContain(name);
    }
  });

  it('puts the company back exactly as it was', async () => {
    const before = await fingerprints();
    const batches = new Map<string, string[][]>();
    const { tables } = await readCompany(owner, tenantId, (table, lines) => {
      batches.set(table.name, [...(batches.get(table.name) ?? []), lines]);
      return Promise.resolve();
    });

    await purge(tenantId);
    expect((await owner.query('select 1 from tenants where id = $1', [tenantId])).rowCount).toBe(0);

    await writeCompany(owner, {
      tenantId,
      tables,
      rows: (header) => toAsync(batches.get(header.name) ?? []),
    });

    expect(await fingerprints()).toEqual(before);
  });

  it('refuses a company the server already has, and writes nothing', async () => {
    const { tables } = await readCompany(owner, tenantId, () => Promise.resolve());
    await expect(
      writeCompany(owner, { tenantId, tables, rows: () => toAsync([]) }),
    ).rejects.toThrow(TransferRefusedError);
  });

  it('refuses rows that point at rows the archive does not hold, and writes nothing', async () => {
    const batches = new Map<string, string[][]>();
    const { tables } = await readCompany(owner, tenantId, (table, lines) => {
      batches.set(table.name, [...(batches.get(table.name) ?? []), lines]);
      return Promise.resolve();
    });
    await purge(tenantId);

    // Leave the customers out: every site, job and invoice now points at nothing.
    batches.set('customers', []);
    await expect(
      writeCompany(owner, {
        tenantId,
        tables,
        rows: (header) => toAsync(batches.get(header.name) ?? []),
      }),
    ).rejects.toThrow(/point at rows it does not contain: .*customer/u);
    expect((await owner.query('select 1 from tenants where id = $1', [tenantId])).rowCount).toBe(0);
  });
});

async function* toAsync<T>(items: readonly T[]): AsyncIterable<T> {
  for (const item of items) {
    yield await Promise.resolve(item);
  }
}
