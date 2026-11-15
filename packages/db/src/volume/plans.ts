import pg from 'pg';

/**
 * Asks Postgres how it would run every statement the application has issued,
 * on a database with real volume, and lists the ones that read a whole large
 * table (P41).
 *
 * The statements come from `pg_stat_statements`, so they are exactly what the
 * code sends, parameters included as `$1`, with no list to keep up to date: run
 * the test suites or click through the app with the extension on, then run
 * this. Each statement is planned with `EXPLAIN (GENERIC_PLAN)` (Postgres 16),
 * as the runtime role acting for the largest company, so row-level security is
 * in the plan as it is in production. Nothing is executed.
 *
 * A finding is a sequential scan of a table the planner expects to hold more
 * than `largeRows` rows in a plan that is not cheap, or a plan whose estimated
 * cost passes `maxCost`. Small tables are read whole on purpose and are not
 * findings.
 */

export interface PlanOptions {
  /** Owner connection to the database with volume (reads the catalogue). */
  adminConnectionString: string;
  /** Runtime-role connection to the same database, so RLS is in the plans. */
  appConnectionString: string;
  /** Which database's recorded statements to plan, `*` for all; the volume database by default. */
  sourceDatabase?: string | undefined;
  /** The company to plan as; the one with the most work orders by default. */
  tenantId?: string | undefined;
  largeRows?: number;
  maxCost?: number;
}

export interface PlanFinding {
  query: string;
  calls: number;
  meanMs: number;
  cost: number;
  seqScans: { table: string; rows: number }[];
}

export interface PlanReport {
  tenantId: string;
  planned: number;
  skipped: number;
  failed: { query: string; error: string }[];
  findings: PlanFinding[];
}

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Total Cost': number;
  Plans?: PlanNode[];
}

/** Below this estimated cost a plan is fast whatever it reads. */
const CHEAP_PLAN_COST = 1_000;

const PLANNABLE = /^\s*(with|select|insert|update|delete)\b/iu;

/** Statements that only make sense as the platform, as the owner, or not at all. */
const NOT_A_COMPANY_STATEMENT =
  /\b(pg_catalog|pg_class|pg_namespace|pg_attribute|pg_constraint|pg_roles|pg_stat|information_schema|schema_migrations|set_config|pg_advisory|pg_temp|current_setting)\b/iu;

export async function planStatements(options: PlanOptions): Promise<PlanReport> {
  const largeRows = options.largeRows ?? 50_000;
  const maxCost = options.maxCost ?? 50_000;
  const admin = new pg.Client({ connectionString: options.adminConnectionString });
  const app = new pg.Client({ connectionString: options.appConnectionString });
  await admin.connect();
  await app.connect();
  try {
    await admin.query('create extension if not exists pg_stat_statements');
    const tenantId =
      options.tenantId ??
      (
        await admin.query<{ tenant_id: string }>(
          `select tenant_id from work_orders group by tenant_id order by count(*) desc limit 1`,
        )
      ).rows[0]?.tenant_id;
    if (tenantId === undefined) {
      throw new Error('No company with work orders: run db:volume first.');
    }

    const sizes = new Map(
      (
        await admin.query<{ name: string; rows: string }>(
          `select c.relname as name, greatest(c.reltuples, 0)::bigint::text as rows
             from pg_class c
            where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')`,
        )
      ).rows.map((row) => [row.name, Number(row.rows)]),
    );
    const partitionParent = new Map(
      (
        await admin.query<{ child: string; parent: string }>(
          `select c.relname as child, p.relname as parent
             from pg_inherits i join pg_class p on p.oid = i.inhparent join pg_class c on c.oid = i.inhrelid
            where p.relnamespace = 'public'::regnamespace`,
        )
      ).rows.map((row) => [row.child, row.parent]),
    );

    const source =
      options.sourceDatabase ??
      (await admin.query<{ db: string }>('select current_database() as db')).rows[0]?.db;
    const statements = (
      await admin.query<{ query: string; calls: string; mean: number }>(
        `select s.query, sum(s.calls)::text as calls, avg(s.mean_exec_time) as mean
           from pg_stat_statements s left join pg_database d on d.oid = s.dbid
          where $1 = '*' or d.datname = $1
          group by s.query`,
        [source],
      )
    ).rows;

    const report: PlanReport = { tenantId, planned: 0, skipped: 0, failed: [], findings: [] };
    for (const statement of statements) {
      if (!PLANNABLE.test(statement.query) || NOT_A_COMPANY_STATEMENT.test(statement.query)) {
        report.skipped += 1;
        continue;
      }
      try {
        const plan = await explain(app, admin, statement.query, tenantId);
        report.planned += 1;
        if (plan === undefined) {
          continue;
        }
        const seqScans: { table: string; rows: number }[] = [];
        walk(plan, (node) => {
          if (node['Node Type'] === 'Seq Scan' && node['Relation Name'] !== undefined) {
            // A partition is judged by its own size: reading an empty default
            // partition whole costs nothing.
            const relation = node['Relation Name'];
            const table = partitionParent.get(relation) ?? relation;
            const rows = sizes.get(relation) ?? 0;
            if (rows > largeRows && !seqScans.some((scan) => scan.table === table)) {
              seqScans.push({ table, rows });
            }
          }
        });
        // A whole-table read under a cheap plan is an `exists` or a `limit 1`
        // that stops at the first row, which is what it should do.
        const cheap = plan['Total Cost'] < CHEAP_PLAN_COST;
        if ((seqScans.length > 0 && !cheap) || plan['Total Cost'] > maxCost) {
          report.findings.push({
            query: statement.query,
            calls: Number(statement.calls),
            meanMs: statement.mean,
            cost: plan['Total Cost'],
            seqScans,
          });
        }
      } catch (error) {
        report.failed.push({
          query: statement.query,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    report.findings.sort((a, b) => b.cost - a.cost);
    return report;
  } finally {
    await admin.end();
    await app.end();
  }
}

/**
 * The plan as the runtime role acting for the company, with its policies; a
 * statement that role may not run is a staff or platform one, planned as the
 * owner, which reads past policies as the platform role does.
 */
async function explain(
  app: pg.Client,
  admin: pg.Client,
  query: string,
  tenantId: string,
): Promise<PlanNode | undefined> {
  try {
    await app.query('begin');
    await app.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await app.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
      `explain (generic_plan, format json) ${query}`,
    );
    return result.rows[0]?.['QUERY PLAN'][0]?.Plan;
  } catch (error) {
    if ((error as { code?: unknown }).code !== '42501') throw error;
  } finally {
    await app.query('rollback');
  }
  const result = await admin.query<{ 'QUERY PLAN': { Plan: PlanNode }[] }>(
    `explain (generic_plan, format json) ${query}`,
  );
  return result.rows[0]?.['QUERY PLAN'][0]?.Plan;
}

function walk(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) {
    walk(child, visit);
  }
}
