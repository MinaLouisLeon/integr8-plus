import { parseArgs } from 'node:util';
import {
  closeDatabase,
  configureDatabase,
  getPlatformDataSource,
  loadDatabaseConfig,
  requireAdminConnectionString,
} from '@integr8/db';
import { buildIdentityProvider, buildMediaStorage } from '../composition.js';
import { loadApiConfig } from '../config.js';
import { exportCompany, importCompany, inspectArchive } from './company-transfer.js';

const USAGE = `
Move one company from one Integr8 server to another (P41). Staff only.

  transfer export <company slug or id> --out <file.tar.gz> [--without-files] [--without-passwords]
  transfer import <file.tar.gz> [--continue]
  transfer inspect <file.tar.gz>

export   Writes the company's rows, its files and its people's sign-in
         accounts (with password hashes, so everyone keeps their password) to
         one archive. The archive is a credential: keep it like a password and
         delete it once the move is done. --without-passwords leaves the
         accounts out (people sign in with an emailed code instead);
         --without-files leaves the files out (only when both servers share the
         same storage bucket).
import   Recreates the company on this server: rows in one transaction with
         every reference checked, then the accounts and the files. Refuses a
         company this server already has, and an archive from a newer release.
         --continue finishes an import that stopped after its rows.
inspect  Prints what an archive holds, without importing it.

Runs where both the owner's connection (DATABASE_URL_ADMIN) and the API's
settings (storage, Auth) are present: the "transfer" service in
deploy/compose.yml. See the setup guide, "Moving a company to another server".
`.trim();

async function main(argv: readonly string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      out: { type: 'string' },
      'without-files': { type: 'boolean', default: false },
      'without-passwords': { type: 'boolean', default: false },
      continue: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  const [command, target] = positionals;
  if (values.help || command === undefined || target === undefined) {
    console.log(USAGE);
    return values.help ? 0 : 1;
  }

  if (command === 'inspect') {
    const manifest = await inspectArchive(target);
    console.log(
      JSON.stringify(
        {
          company: manifest.company,
          release: manifest.release,
          schemaVersion: manifest.schemaVersion,
          formatVersion: manifest.formatVersion,
          exportedAt: manifest.exportedAt,
          includes: manifest.includes,
          modules: Object.fromEntries(
            Object.entries(manifest.modules).map(([module, tables]) => [module, tables.length]),
          ),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const databaseConfig = loadDatabaseConfig(process.env);
  configureDatabase(databaseConfig);
  const admin = requireAdminConnectionString(databaseConfig);
  const config = loadApiConfig();
  const media = buildMediaStorage(config);

  if (command === 'export') {
    if (values.out === undefined) {
      console.error('export needs --out <file.tar.gz>');
      return 1;
    }
    const platform = getPlatformDataSource();
    const tenant =
      (await platform.tenants.findBySlug(target)) ??
      (/^[0-9a-f-]{36}$/u.test(target) ? await platform.tenants.findById(target) : undefined);
    if (tenant === undefined) {
      console.error(`There is no company "${target}" on this server.`);
      return 1;
    }
    const report = await exportCompany({
      adminConnectionString: admin,
      media,
      tenantId: tenant.id,
      out: values.out,
      withFiles: !values['without-files'],
      withPasswords: !values['without-passwords'],
    });
    console.log(JSON.stringify({ company: tenant.slug, file: values.out, ...report }, null, 2));
    return 0;
  }

  if (command === 'import') {
    const report = await importCompany({
      adminConnectionString: admin,
      media,
      identity: buildIdentityProvider(config, process.env),
      file: target,
      continueAfterRows: values.continue,
    });
    console.log(
      JSON.stringify(
        {
          company: report.manifest.company,
          from: { release: report.manifest.release, schemaVersion: report.manifest.schemaVersion },
          rows: report.rows?.counts === undefined ? 'already here' : sum(report.rows.counts),
          droppedColumns: report.rows?.droppedColumns ?? [],
          droppedTables: report.rows?.droppedTables ?? [],
          files: report.files,
          accounts: report.accounts,
        },
        null,
        2,
      ),
    );
    console.log(
      'Phones and desktop apps must sign in again on this server; phones sync their jobs from scratch.',
    );
    return 0;
  }

  console.error(USAGE);
  return 1;
}

function sum(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, n) => total + n, 0);
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
