import { parseArgs } from 'node:util';
import { appEnvironmentSchema, optionalEnv } from '@integr8/core';
import { loadDatabaseConfig, requireAdminConnectionString } from '../config.js';
import { generateVolume } from './generate.js';

const USAGE = `
Fill a disposable database with large made-up companies, to see query plans at
real sizes (P41). Never on a database with real companies in it.

  pnpm --filter @integr8/db db:volume [--companies 20] [--years 5] [--scale 1]

  --companies  How many companies; the first is the largest      (default 20)
  --years      Years of history each one has, ending now          (default 5)
  --scale      Multiplies every count; 1 is about 20,000 jobs a year
               for the largest company and ~10 million rows in all (default 1)

Refuses to run unless APP_ENV is development or test. Needs DATABASE_URL_ADMIN.
`.trim();

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      companies: { type: 'string', default: '20' },
      years: { type: 'string', default: '5' },
      scale: { type: 'string', default: '1' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  const environment = appEnvironmentSchema.parse(optionalEnv('APP_ENV', 'development'));
  if (environment !== 'development' && environment !== 'test') {
    console.error(`Refusing to write made-up companies with APP_ENV=${environment}.`);
    return 1;
  }
  const config = loadDatabaseConfig();
  const companies = Number.parseInt(values.companies, 10);
  const years = Number.parseInt(values.years, 10);
  const scale = Number.parseFloat(values.scale);
  if (!(companies >= 1 && years >= 1 && scale > 0)) {
    console.error(USAGE);
    return 1;
  }

  const started = Date.now();
  const reports = await generateVolume(requireAdminConnectionString(config), {
    companies,
    years,
    scale,
    onCompany: (report) => {
      console.log(
        `${report.slug}: ${String(report.workOrders)} work orders in ${String(Math.round(report.milliseconds / 1000))} s`,
      );
    },
  });
  console.log(
    `${String(reports.length)} companies in ${String(Math.round((Date.now() - started) / 1000))} s`,
  );
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
