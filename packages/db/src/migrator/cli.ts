import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadDatabaseConfig, requireAdminConnectionString } from '../config.js';
import { defaultMigrationsDir, loadMigrations } from './files.js';
import { Migrator } from './runner.js';

const { Client } = pg;

const USAGE = `
integr8 database CLI — run with: pnpm --filter @integr8/db db <command>

Commands
  status                 Show every migration and whether it has been applied
  verify                 Fail if an applied migration no longer matches its file
  up [--to NNNN]         Apply pending migrations
  down [--steps N]       Roll back the most recent N migrations (default 1)
  down --to NNNN         Roll back everything above NNNN
  new <slug>             Scaffold the next up/down pair
  bootstrap              Create the integr8_app runtime role (needs INTEGR8_APP_PASSWORD)

All commands except "new" connect as DATABASE_URL_ADMIN, the schema owner.
`.trim();

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      to: { type: 'string' },
      steps: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const command = positionals[0];

  if (values.help === true || command === undefined) {
    console.log(USAGE);
    return command === undefined ? 1 : 0;
  }

  if (command === 'new') {
    return scaffold(positionals[1]);
  }

  const config = loadDatabaseConfig();
  const client = new Client({
    connectionString: requireAdminConnectionString(config),
    application_name: 'integr8-migrator',
  });
  await client.connect();

  try {
    if (command === 'bootstrap') {
      return await bootstrap(client);
    }

    const migrator = new Migrator(client, loadMigrations());

    switch (command) {
      case 'status':
        return await status(migrator);
      case 'verify':
        await migrator.verify();
        console.log('All applied migrations match their files.');
        return 0;
      case 'up':
        return report(await migrator.up(toOption(values.to)), 'Nothing to apply.');
      case 'down':
        return report(
          await migrator.down({
            ...toOption(values.to),
            ...(values.steps === undefined ? {} : { steps: Number.parseInt(values.steps, 10) }),
          }),
          'Nothing to roll back.',
        );
      default:
        console.error(`Unknown command "${command}".\n\n${USAGE}`);
        return 1;
    }
  } finally {
    await client.end();
  }
}

function toOption(to: string | undefined): { to?: string } {
  return to === undefined ? {} : { to };
}

async function status(migrator: Migrator): Promise<number> {
  const rows = await migrator.status();

  if (rows.length === 0) {
    console.log('No migrations found.');
    return 0;
  }

  for (const row of rows) {
    const when = row.appliedAt === undefined ? '' : `  ${row.appliedAt.toISOString()}`;
    console.log(`${row.state.padEnd(18)} ${row.version}_${row.name}${when}`);
  }

  const broken = rows.filter(
    (row) => row.state === 'checksum-mismatch' || row.state === 'missing-file',
  );
  return broken.length > 0 ? 1 : 0;
}

function report(
  outcomes: readonly { version: string; name: string; direction: string; durationMs: number }[],
  emptyMessage: string,
): number {
  if (outcomes.length === 0) {
    console.log(emptyMessage);
    return 0;
  }
  for (const outcome of outcomes) {
    console.log(
      `${outcome.direction === 'up' ? 'applied ' : 'rolled back'} ${outcome.version}_${outcome.name} in ${String(outcome.durationMs)}ms`,
    );
  }
  return 0;
}

/**
 * Creates the runtime role.
 *
 * Roles are cluster-level, not schema-level, so they cannot live in a migration
 * — a migration is per-database and a password has no business in git. This
 * command is idempotent and is step 3 of
 * docs/database/runbook-supabase-setup.md.
 *
 * The password reaches Postgres through a GUC rather than string interpolation,
 * so a password containing a quote cannot become SQL.
 */
async function bootstrap(client: pg.Client): Promise<number> {
  const password = process.env.INTEGR8_APP_PASSWORD;
  if (password === undefined || password.trim() === '') {
    console.error(
      'INTEGR8_APP_PASSWORD is not set. Generate one (openssl rand -base64 32) and export it.',
    );
    return 1;
  }

  await client.query('select set_config($1, $2, false)', ['integr8.bootstrap_password', password]);
  await client.query(`
    do $$
    declare
      secret text := current_setting('integr8.bootstrap_password');
    begin
      if exists (select 1 from pg_roles where rolname = 'integr8_app') then
        execute format('alter role integr8_app login password %L', secret);
        raise notice 'integr8_app already existed; password reset';
      else
        execute format('create role integr8_app login password %L', secret);
        raise notice 'integr8_app created';
      end if;

      -- Role-level defaults survive Supavisor's transaction pooling, where a
      -- session-level SET would not.
      execute format('alter role integr8_app set search_path = %L', 'public');
      execute 'grant connect on database ' || quote_ident(current_database()) || ' to integr8_app';
    end;
    $$;
  `);
  await client.query('select set_config($1, $2, false)', ['integr8.bootstrap_password', '']);

  console.log('Role integr8_app is ready. Run "up" next to apply migrations and grants.');
  return 0;
}

function scaffold(slug: string | undefined): number {
  if (slug === undefined || !/^[a-z0-9_]+$/u.test(slug)) {
    console.error('Usage: db new <lower_snake_case_slug>');
    return 1;
  }

  const dir = defaultMigrationsDir();
  const existing = loadMigrations(dir);
  const last = existing.at(-1);
  const version = String(last === undefined ? 1 : Number.parseInt(last.version, 10) + 1).padStart(
    4,
    '0',
  );

  const header = `-- ${version} — ${slug.replaceAll('_', ' ')}.`;
  writeFileSync(
    join(dir, `${version}_${slug}.up.sql`),
    `${header}\n--\n-- Expand/contract: see docs/database/migrations.md before changing an\n-- existing column or table.\n\n`,
    'utf8',
  );
  writeFileSync(join(dir, `${version}_${slug}.down.sql`), `-- ${version} — down.\n\n`, 'utf8');

  console.log(`Created ${version}_${slug}.up.sql and ${version}_${slug}.down.sql`);
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
