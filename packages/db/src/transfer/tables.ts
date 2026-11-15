import type pg from 'pg';
import { loadMigrations } from '../migrator/files.js';

/**
 * Which tables a company transfer carries, and in what order (P41).
 *
 * Worked out from the catalogue rather than listed: every table whose
 * `tenant_id` points at `tenants` belongs to a company, so a table a later
 * feature adds travels from the day it exists, with nobody having to remember
 * it. What stays behind is named in {@link NOT_TRANSFERRED}, each with the
 * reason, and the suite fails on a name there that is no longer a table.
 *
 * A transfer is not the customer's export (`EXPORTED_TABLES`), which leaves out
 * Integr8's own records about the company. A transfer moves the whole company
 * to another server of ours, so it takes those too (plan, feature switches,
 * the assistant's allowance, number counters, derived balances), and leaves
 * out only what is bound to the server it came from.
 */
export const NOT_TRANSFERRED: Readonly<Record<string, string>> = {
  sessions: 'Signed in on the old server; people sign in again on the new one.',
  refresh_tokens: 'Signed in on the old server; people sign in again on the new one.',
  offline_grants: "Signed with the old server's keys, which the new one does not hold.",
  invitations: 'Pending invitations carry links to the old server.',
  push_devices: 'Phones register again with the new server when they next sign in.',
  impersonation_grants: 'Staff access on the old server, ended by the move.',
  jobs: "The old server's background queue.",
  idempotency_keys: 'Replies the old server kept for retried requests.',
  sync_touches: "The old server's change log; phones sync from scratch after a move.",
  sync_log_marks: "The old server's change log; phones sync from scratch after a move.",
  sync_reports: 'Diagnostics of syncs with the old server.',
  upload_intents: 'Uploads begun on the old server and never finished.',
  ai_message_reservations: 'Assistant replies in flight on the old server.',
  test_outbox: 'What a test company would have sent, kept a week on the old server.',
  billing_events: "The billing provider's notices to the old server.",
  tenant_storage: 'Which bucket the old server keeps the files in; the import provisions its own.',
  tenant_storage_usage: 'Recounted by the new server from the files it receives.',
  tenant_storage_samples: "The old server's daily storage readings.",
  storage_reconciliations: "The old server's comparisons with Cloudflare's bill.",
  ai_provider_calls: "The old server's calls to the model provider, kept for its cost reports.",
};

export interface TransferTable {
  name: string;
  /** The module that creates it: the name of its baseline or later migration. */
  module: string;
  /** Columns written to and read from the archive: everything but generated ones. */
  columns: string[];
  /** Its primary key, which the reader pages by, and the key columns' types. */
  key: string[];
  keyTypes: string[];
  /** Columns filled by an identity, which an insert must override. */
  identity: string[];
}

/** `tenants` first, then every company table, parents before children. */
export async function transferTables(client: pg.Client): Promise<TransferTable[]> {
  const companyTables = (
    await client.query<{ name: string }>(`
      select distinct child.relname::text as name
        from pg_constraint con
        join pg_class child on child.oid = con.conrelid
        join pg_class parent on parent.oid = con.confrelid
        join pg_attribute att on att.attrelid = child.oid and att.attnum = any (con.conkey)
       where con.contype = 'f'
         and parent.relname = 'tenants'
         and parent.relnamespace = 'public'::regnamespace
         and child.relnamespace = 'public'::regnamespace
         and not child.relispartition
         and att.attname = 'tenant_id'`)
  ).rows
    .map((row) => row.name)
    .filter((name) => !(name in NOT_TRANSFERRED));

  const names = ['tenants', ...companyTables.sort()];
  const edges = (
    await client.query<{ child: string; parent: string }>(
      `select distinct c.relname::text as child, p.relname::text as parent
         from pg_constraint con
         join pg_class c on c.oid = con.conrelid
         join pg_class p on p.oid = con.confrelid
        where con.contype = 'f' and c.relname = any ($1) and p.relname = any ($1)
          and c.relname <> p.relname and not c.relispartition`,
      [names],
    )
  ).rows;

  const columns = await client.query<{
    table: string;
    column: string;
    generated: string;
    identity: string;
  }>(
    `select c.relname::text as table, a.attname::text as column,
            a.attgenerated::text as generated, a.attidentity::text as identity
       from pg_class c
       join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where c.relnamespace = 'public'::regnamespace and c.relname = any ($1)
      order by c.relname, a.attnum`,
    [names],
  );
  const keys = await client.query<{ table: string; column: string; type: string }>(
    `select c.relname::text as table, a.attname::text as column,
            format_type(a.atttypid, a.atttypmod) as type
       from pg_index i
       join pg_class c on c.oid = i.indrelid
       cross join lateral unnest(i.indkey) with ordinality as k (attnum, ord)
       join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
      where i.indisprimary and c.relnamespace = 'public'::regnamespace and c.relname = any ($1)
      order by c.relname, k.ord`,
    [names],
  );

  const moduleOf = moduleOfTables();
  const tables = new Map<string, TransferTable>(
    names.map((name) => [
      name,
      {
        name,
        module: moduleOf.get(name) ?? 'unknown',
        columns: [],
        key: [],
        keyTypes: [],
        identity: [],
      },
    ]),
  );
  for (const row of columns.rows) {
    const table = tables.get(row.table);
    if (table === undefined || row.generated !== '') continue;
    table.columns.push(row.column);
    if (row.identity !== '') table.identity.push(row.column);
  }
  for (const row of keys.rows) {
    tables.get(row.table)?.key.push(row.column);
    tables.get(row.table)?.keyTypes.push(row.type);
  }
  for (const table of tables.values()) {
    if (table.key.length === 0) {
      throw new Error(`${table.name} has no primary key; every transferred table needs one.`);
    }
  }

  return dependencyOrder(names, edges).map((name) => tables.get(name)!);
}

/** Parents before children; a cycle (there are none today) keeps alphabetical order. */
function dependencyOrder(
  names: readonly string[],
  edges: readonly { child: string; parent: string }[],
): string[] {
  const placed = new Set<string>();
  const order: string[] = [];
  let remaining = [...names];
  while (remaining.length > 0) {
    const ready = remaining.filter((name) =>
      edges.every((edge) => edge.child !== name || placed.has(edge.parent)),
    );
    const next = ready.length > 0 ? ready : [remaining[0]!];
    for (const name of next) {
      placed.add(name);
      order.push(name);
    }
    remaining = remaining.filter((name) => !placed.has(name));
  }
  return order;
}

/** Table name → the migration that creates it, from the files this build ships. */
export function moduleOfTables(): Map<string, string> {
  const map = new Map<string, string>();
  for (const migration of loadMigrations()) {
    for (const match of migration.up.matchAll(/^CREATE TABLE (\w+) \(/gimu)) {
      const name = match[1];
      if (name !== undefined && !map.has(name.toLowerCase())) {
        map.set(name.toLowerCase(), migration.name);
      }
    }
  }
  return map;
}
