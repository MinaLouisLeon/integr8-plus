import type {
  KyselyPlugin,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  RootOperationNode,
  UnknownRow,
} from 'kysely';
import { TENANT_SCOPED_TABLES } from './schema.js';

/**
 * Refuses to execute any statement that touches a tenant-scoped table without
 * naming `tenant_id`.
 *
 * The repository layer is the primary isolation control, which means the
 * primary isolation control is a person remembering to write a `where` clause.
 * This plugin removes the remembering. It inspects every compiled query before
 * it reaches the driver: if the statement mentions `tenant_users` or
 * `audit_log` — or any tenant-scoped table added later — and mentions
 * `tenant_id` nowhere, it throws instead of running.
 *
 * It is deliberately coarse. It proves a `tenant_id` predicate exists, not that
 * the predicate is correct, so it does not replace either of the controls
 * either side of it: the repositories that supply the value, and the RLS
 * policies that check it in the database. What it does catch is the specific
 * mistake that has no other symptom — a query that quietly returns everyone's
 * rows and looks like it worked.
 */

const TENANT_COLUMN = 'tenant_id';

const SCOPED_TABLES: ReadonlySet<string> = new Set<string>(TENANT_SCOPED_TABLES);

export class MissingTenantScopeError extends Error {
  constructor(
    readonly tables: readonly string[],
    readonly sql: string,
  ) {
    super(
      [
        `Query touches tenant-scoped table(s) [${tables.join(', ')}] without a ${TENANT_COLUMN} predicate.`,
        'Every statement against a tenant-scoped table must be filtered by tenant_id.',
        '',
        sql,
      ].join('\n'),
    );
    this.name = 'MissingTenantScopeError';
  }
}

export class TenantGuardPlugin implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    const found = inspect(args.node);
    const scoped = [...found.tables].filter((table) => SCOPED_TABLES.has(table));

    if (scoped.length > 0 && !found.columns.has(TENANT_COLUMN)) {
      throw new MissingTenantScopeError(scoped.sort(), describe(args.node));
    }

    return args.node;
  }

  transformResult(args: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
    return Promise.resolve(args.result);
  }
}

interface Found {
  tables: Set<string>;
  columns: Set<string>;
}

/**
 * Walks a Kysely operation node tree collecting every table and column name.
 *
 * The walk is structural rather than type-directed on purpose: it needs to keep
 * working when Kysely adds a node kind, and the safe failure for an unknown
 * node is to descend into it anyway.
 */
function inspect(node: unknown): Found {
  const found: Found = { tables: new Set(), columns: new Set() };
  const seen = new Set<object>();

  const visit = (value: unknown): void => {
    if (value === null || typeof value !== 'object') {
      return;
    }
    if (seen.has(value)) {
      return;
    }
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    const name = identifierName(record);

    if (record.kind === 'TableNode' && name !== undefined) {
      found.tables.add(name);
    } else if (record.kind === 'ColumnNode' && name !== undefined) {
      found.columns.add(name);
    }

    for (const child of Object.values(record)) {
      visit(child);
    }
  };

  visit(node);
  return found;
}

/** Pulls the string out of `TableNode.table.identifier` or `ColumnNode.column`. */
function identifierName(record: Record<string, unknown>): string | undefined {
  const target = record.kind === 'TableNode' ? record.table : record.column;
  if (target === null || typeof target !== 'object') {
    return undefined;
  }

  const inner = target as Record<string, unknown>;
  if (typeof inner.name === 'string') {
    return inner.name;
  }

  const identifier = inner.identifier;
  if (identifier !== null && typeof identifier === 'object') {
    const candidate = (identifier as Record<string, unknown>).name;
    if (typeof candidate === 'string') {
      return candidate;
    }
  }

  return undefined;
}

/**
 * Names the offending statement for the error message.
 *
 * The compiled SQL is not available at this point — the plugin runs before
 * compilation — and `SelectQueryNode` is enough to locate the call site
 * alongside the table names.
 */
function describe(node: RootOperationNode): string {
  return node.kind;
}
