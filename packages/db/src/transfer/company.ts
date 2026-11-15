import type pg from 'pg';
import { loadMigrations } from '../migrator/files.js';
import { type TransferTable, transferTables } from './tables.js';

/**
 * Reading one company out of a database and writing it into another (P41).
 *
 * Both sides run as the schema owner, because both have to see and write past
 * what every other role is held to: the reader takes rows the runtime role may
 * not read (number counters, Integr8's own records), and the writer inserts
 * with triggers off (`session_replication_role = replica`) so that a posted
 * journal stays posted, a job keeps its number and history is not written a
 * second time. That switch also stops foreign keys being checked, so the writer
 * checks every one of them itself before it commits.
 *
 * Rows travel as JSON text that Postgres writes and Postgres reads back, never
 * parsed here: a JavaScript Date keeps milliseconds where Postgres keeps
 * microseconds, and a JavaScript number cannot hold every `numeric`.
 *
 * The archive around these rows (files, sign-in accounts, the container) is
 * the API's transfer command's business; this file knows only rows.
 */

/** The archive format this build writes and the newest it reads. */
export const TRANSFER_FORMAT_VERSION = 1;

/** Rows read per round trip. */
const BATCH = 2_000;

export interface TableHeader {
  name: string;
  module: string;
  columns: string[];
}

/** The newest migration this build ships, which an archive records as its schema. */
export function schemaVersion(): string {
  return loadMigrations().at(-1)?.version ?? '0000';
}

/**
 * Every row of one company, table by table, a batch at a time, each row one
 * line of JSON.
 *
 * Paged by primary key, never by offset: the hundredth page costs what the
 * first did. Read in one repeatable-read transaction, so the archive is one
 * moment of the company even while people keep working.
 */
export async function readCompany(
  client: pg.Client,
  tenantId: string,
  each: (table: TransferTable, lines: string[]) => Promise<void>,
  /** Told the tables before any row is read, for a manifest that goes first. */
  onTables?: (tables: TransferTable[]) => Promise<void>,
): Promise<{ tables: TransferTable[]; counts: Record<string, number> }> {
  await client.query('begin isolation level repeatable read read only');
  try {
    const tables = await transferTables(client);
    await onTables?.(tables);
    const counts: Record<string, number> = {};
    for (const table of tables) {
      counts[table.name] = 0;
      const tenantColumn = table.name === 'tenants' ? 'id' : 'tenant_id';
      const select = table.columns.map(quote).join(', ');
      const key = table.key.map(quote).join(', ');
      const keyText = table.key
        .map((column, index) => `r.${quote(column)}::text as k${String(index)}`)
        .join(', ');
      let after: string[] | undefined;
      for (;;) {
        const params: unknown[] = [tenantId];
        let where = `${quote(tenantColumn)} = $1`;
        if (after !== undefined) {
          const placeholders = after
            .map((_, index) => `$${String(index + 2)}::${table.keyTypes[index] ?? 'text'}`)
            .join(', ');
          where += ` and (${key}) > (${placeholders})`;
          params.push(...after);
        }
        const result = await client.query<Record<string, string>>(
          `select to_jsonb(r)::text as line, ${keyText}
             from (select ${select} from ${quote(table.name)} where ${where}
                    order by ${key} limit ${String(BATCH)}) r`,
          params,
        );
        if (result.rows.length === 0) break;
        counts[table.name] = (counts[table.name] ?? 0) + result.rows.length;
        await each(
          table,
          result.rows.map((row) => row.line ?? ''),
        );
        if (result.rows.length < BATCH) break;
        const last = result.rows.at(-1) ?? {};
        after = table.key.map((_, index) => last[`k${String(index)}`] ?? '');
      }
    }
    await client.query('commit');
    return { tables, counts };
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

export interface WriteReport {
  /** Rows written per table. */
  counts: Record<string, number>;
  /** Columns the archive had that this schema no longer does; their values were left out. */
  droppedColumns: string[];
  /** Tables the archive had that this schema no longer does. */
  droppedTables: string[];
}

export class TransferRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransferRefusedError';
  }
}

/**
 * Writes one company's rows, all or nothing.
 *
 * Columns are matched by name: a column this schema added since the archive
 * was made takes its default, one it removed is reported and left out. That is
 * what keeps an older archive loadable by a newer release, as long as
 * migrations follow the expand/contract rule (docs/database/migrations.md):
 * new columns have defaults or allow null, and nothing is renamed in place.
 */
export async function writeCompany(
  client: pg.Client,
  source: {
    tenantId: string;
    tables: readonly TableHeader[];
    /** Each table's rows, a batch at a time, one line of JSON each (as {@link readCompany} reads them). */
    rows: (table: TableHeader) => AsyncIterable<string[]>;
  },
): Promise<WriteReport> {
  await client.query('begin');
  try {
    const existing = await client.query('select 1 from tenants where id = $1', [source.tenantId]);
    if (existing.rowCount !== 0) {
      throw new TransferRefusedError(
        `Company ${source.tenantId} already exists on this server. Import into a server that does not have it.`,
      );
    }
    await client.query('set local session_replication_role = replica');
    const here = new Map((await transferTables(client)).map((table) => [table.name, table]));
    const report: WriteReport = { counts: {}, droppedColumns: [], droppedTables: [] };

    for (const header of source.tables) {
      const table = here.get(header.name);
      if (table === undefined) {
        report.droppedTables.push(header.name);
        for await (const batch of source.rows(header)) void batch;
        continue;
      }
      const columns = header.columns.filter((column) => table.columns.includes(column));
      for (const column of header.columns) {
        if (!table.columns.includes(column)) report.droppedColumns.push(`${header.name}.${column}`);
      }
      const list = columns.map(quote).join(', ');
      const overriding = table.identity.some((column) => columns.includes(column))
        ? ' overriding system value'
        : '';
      const owner = header.name === 'tenants' ? 'id' : 'tenant_id';
      report.counts[header.name] = 0;
      for await (const batch of source.rows(header)) {
        if (batch.length === 0) continue;
        const rows = `[${batch.join(',')}]`;
        // Every row must be this company's: an archive is one company.
        const strays = await client.query<{ n: string }>(
          `select count(*)::text as n from jsonb_array_elements($1::jsonb) r
            where r ->> '${owner}' is distinct from $2`,
          [rows, source.tenantId],
        );
        if (strays.rows[0]?.n !== '0') {
          throw new TransferRefusedError(`${header.name} holds rows of another company.`);
        }
        await client.query(
          `insert into ${quote(header.name)} (${list})${overriding}
           select ${list} from jsonb_populate_recordset(null::${quote(header.name)}, $1::jsonb)`,
          [rows],
        );
        report.counts[header.name] = (report.counts[header.name] ?? 0) + batch.length;
      }
    }

    await client.query('set local session_replication_role = origin');
    await verifyReferences(client, source.tenantId, [...here.keys()]);
    // Rows dated in years this server has no partition for yet get their own.
    await client.query('select ensure_year_partitions()');
    await client.query('commit');
    return report;
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}

/**
 * Checks every foreign key of the company's tables, since the writer wrote with
 * them off. One query per key, each an anti-join limited to the company.
 */
async function verifyReferences(
  client: pg.Client,
  tenantId: string,
  tables: readonly string[],
): Promise<void> {
  const keys = await client.query<{
    name: string;
    child: string;
    parent: string;
    child_columns: string[];
    parent_columns: string[];
  }>(
    `select con.conname::text as name, c.relname::text as child, p.relname::text as parent,
            array(select a.attname::text from unnest(con.conkey) with ordinality k(n, o)
                    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.n
                   order by k.o) as child_columns,
            array(select a.attname::text from unnest(con.confkey) with ordinality k(n, o)
                    join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.n
                   order by k.o) as parent_columns
       from pg_constraint con
       join pg_class c on c.oid = con.conrelid
       join pg_class p on p.oid = con.confrelid
      where con.contype = 'f' and c.relname = any ($1) and not c.relispartition
        and con.conparentid = 0 and c.relnamespace = 'public'::regnamespace`,
    [tables],
  );
  const broken: string[] = [];
  for (const key of keys.rows) {
    const tenantColumn = key.child === 'tenants' ? 'id' : 'tenant_id';
    const present = key.child_columns
      .map((column) => `c.${quote(column)} is not null`)
      .join(' and ');
    const match = key.child_columns
      .map((column, index) => `p.${quote(key.parent_columns[index] ?? '')} = c.${quote(column)}`)
      .join(' and ');
    const result = await client.query<{ n: string }>(
      `select count(*)::text as n from ${quote(key.child)} c
        where c.${quote(tenantColumn)} = $1 and ${present}
          and not exists (select 1 from ${quote(key.parent)} p where ${match})`,
      [tenantId],
    );
    const n = Number(result.rows[0]?.n ?? 0);
    if (n > 0) broken.push(`${key.name} (${String(n)} rows of ${key.child})`);
  }
  if (broken.length > 0) {
    throw new TransferRefusedError(
      `The archive's rows point at rows it does not contain: ${broken.join(', ')}. Nothing was imported.`,
    );
  }
}

function quote(identifier: string): string {
  return `"${identifier.replace(/"/gu, '""')}"`;
}
