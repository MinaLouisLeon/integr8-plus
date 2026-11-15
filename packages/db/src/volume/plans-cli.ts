import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadDatabaseConfig, requireAdminConnectionString } from '../config.js';
import { planStatements } from './plans.js';

const USAGE = `
Plan every statement the application has issued against a database with volume,
and list the ones that read a whole large table (P41). Executes nothing.

  pnpm --filter @integr8/db db:plans [--source <database>] [--tenant <id>]
                                     [--large-rows 50000] [--max-cost 50000] [--json <file>]

  --source      Database whose recorded statements to plan (pg_stat_statements is
                shared by the whole server), e.g. the one the test suites ran on.
                \`*\` plans every database's, including dropped test databases'.
                Defaults to the database in DATABASE_URL_ADMIN.
  --tenant      Company to plan as; the one with the most work orders by default.
  --json        Also write the full report to a file.

Needs Postgres started with shared_preload_libraries=pg_stat_statements,
DATABASE_URL_ADMIN and DATABASE_URL pointing at the database with volume
(pnpm --filter @integr8/db db:volume).
`.trim();

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      source: { type: 'string' },
      tenant: { type: 'string' },
      'large-rows': { type: 'string', default: '50000' },
      'max-cost': { type: 'string', default: '50000' },
      json: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const config = loadDatabaseConfig();
  const report = await planStatements({
    adminConnectionString: requireAdminConnectionString(config),
    appConnectionString: config.DATABASE_URL,
    sourceDatabase: values.source,
    tenantId: values.tenant,
    largeRows: Number.parseInt(values['large-rows'], 10),
    maxCost: Number.parseInt(values['max-cost'], 10),
  });

  console.log(
    `Planned ${String(report.planned)} statements as company ${report.tenantId} ` +
      `(${String(report.skipped)} not company statements, ${String(report.failed.length)} not plannable as the runtime role).`,
  );
  for (const finding of report.findings) {
    const scans = finding.seqScans
      .map((scan) => `${scan.table} (~${String(scan.rows)} rows)`)
      .join(', ');
    console.log(
      `\ncost ${finding.cost.toFixed(0)}${scans === '' ? '' : `, reads whole: ${scans}`}, ` +
        `${String(finding.calls)} calls\n  ${finding.query.replace(/\s+/gu, ' ').slice(0, 400)}`,
    );
  }
  if (values.json !== undefined) {
    writeFileSync(values.json, JSON.stringify(report, null, 2));
  }
  console.log(`\n${String(report.findings.length)} finding(s).`);
  return report.findings.length === 0 ? 0 : 2;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
