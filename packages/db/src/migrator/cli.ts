import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadDatabaseConfig, requireAdminConnectionString } from '../config.js';
import { defaultMigrationsDir, loadMigrations } from './files.js';
import { listMigrations, migrationProblems, Migrator } from './runner.js';

const { Client } = pg;

const USAGE = `
integr8 database CLI — run with: pnpm --filter @integr8/db db <command>

Commands
  status                 Show every migration and whether it has been applied
  verify                 Fail if an applied migration no longer matches its file
  up [--to NNNN]         Apply pending migrations (none, with a warning, when a
                         newer release has already migrated the database)
  down [--steps N]       Roll back the most recent N migrations (default 1)
  down --to NNNN         Roll back everything above NNNN
  new <slug>             Scaffold the next up/down pair
  bootstrap              Create the integr8_app and integr8_auth roles
                         (needs INTEGR8_APP_PASSWORD and INTEGR8_AUTH_PASSWORD),
                         and Supabase Auth's role and schema when
                         SUPABASE_AUTH_DB_PASSWORD is set
  deploy                 bootstrap, then up: the one command a hosting
                         platform's pre-deploy hook runs before a new build
                         takes traffic

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

    if (command === 'deploy') {
      // One process rather than two commands joined by a shell, because a
      // platform's pre-deploy field is one command and not every platform runs
      // it through a shell. Bootstrap first: a fresh database has no roles for
      // the API to connect as, and the grants the migrations write name them.
      const created = await bootstrap(client, { thenMigrating: true });
      if (created !== 0) {
        return created;
      }
      return await migrateUp(migrator);
    }

    switch (command) {
      case 'status':
        return await status(migrator);
      case 'verify':
        await migrator.verify();
        console.log('All applied migrations match their files.');
        return 0;
      case 'up':
        return await migrateUp(migrator, toOption(values.to));
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

/**
 * `up`, plus a warning when the database is ahead of this build.
 *
 * After a rollback to the previous image, the `migrate` service runs this with
 * a build that has no files for the newer release's migrations. It succeeds,
 * so the API and worker start, but it says what it found: this warning is the
 * one line in the logs that tells somebody the schema and the code come from
 * different releases.
 */
async function migrateUp(migrator: Migrator, options: { to?: string } = {}): Promise<number> {
  const code = report(await migrator.up(options), 'Nothing to apply.');
  const ahead = await migrator.aheadOfBuild();
  if (ahead.length > 0) {
    console.warn(
      [
        `Warning: the database is ahead of this build. A newer release applied ${listMigrations(ahead)},`,
        'which this build has no files for, so nothing was applied. That is expected after rolling',
        'back to an earlier release, which runs on the newer schema; the newer release finds',
        'nothing to apply when it comes back. To undo those migrations instead, run "down" from',
        'the newer release (docs/database/migrations.md, "Rolling back a release").',
      ].join('\n'),
    );
  }
  return code;
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

  // A schema ahead of the build is reported, not failed: it is what a rollback
  // to the previous release looks like.
  const ahead = rows.filter((row) => row.state === 'ahead-of-build');
  if (ahead.length > 0) {
    console.log(
      `\n${String(ahead.length)} migration(s) from a newer release; this build runs on that schema.`,
    );
  }

  const problems = migrationProblems(rows);
  for (const problem of problems) {
    console.error(problem);
  }
  return problems.length > 0 ? 1 : 0;
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
 * Creates the two login roles, and the self-hosted Auth's when asked for.
 *
 * Roles are cluster-level, not schema-level, so they cannot live in a migration
 * — a migration is per-database and a password has no business in git. This
 * command is idempotent; `deploy/compose.yml` runs it on every start.
 *
 * Passwords reach Postgres through a GUC rather than string interpolation, so a
 * password containing a quote cannot become SQL.
 *
 * Neither role is granted anything here. Table privileges come from the
 * migrations, so a table added later is invisible to both until somebody writes
 * its grant.
 */
async function bootstrap(
  client: pg.Client,
  { thenMigrating = false }: { thenMigrating?: boolean } = {},
): Promise<number> {
  const roles = [
    {
      name: 'integr8_app',
      variable: 'INTEGR8_APP_PASSWORD',
      purpose: 'the tenant runtime role, subject to RLS',
    },
    {
      name: 'integr8_auth',
      variable: 'INTEGR8_AUTH_PASSWORD',
      purpose: 'the pre-authentication role: lockout and membership lookup only',
    },
  ] as const;

  const missing = roles.filter((role) => (process.env[role.variable] ?? '').trim() === '');
  if (missing.length > 0) {
    console.error(
      [
        'Missing role password(s):',
        ...missing.map((role) => `  ${role.variable}  — ${role.purpose}`),
        '',
        'Generate each with: openssl rand -base64 32',
      ].join('\n'),
    );
    return 1;
  }

  for (const role of roles) {
    await client.query('select set_config($1, $2, false)', [
      'integr8.bootstrap_password',
      process.env[role.variable],
    ]);
    await client.query('select set_config($1, $2, false)', ['integr8.bootstrap_role', role.name]);
    await client.query(`
      do $$
      declare
        secret    text := current_setting('integr8.bootstrap_password');
        role_name text := current_setting('integr8.bootstrap_role');
      begin
        if exists (select 1 from pg_roles where rolname = role_name) then
          execute format('alter role %I login password %L', role_name, secret);
          raise notice '% already existed; password reset', role_name;
        else
          execute format('create role %I login password %L', role_name, secret);
          raise notice '% created', role_name;
        end if;

        -- Role-level defaults survive Supavisor's transaction pooling, where a
        -- session-level SET would not.
        execute format('alter role %I set search_path = %L', role_name, 'public');
        execute format(
          'grant connect on database %I to %I', current_database(), role_name);
      end;
      $$;
    `);
    console.log(`Role ${role.name} is ready.`);
  }

  await client.query('select set_config($1, $2, false)', ['integr8.bootstrap_password', '']);
  await client.query('select set_config($1, $2, false)', ['integr8.bootstrap_role', '']);

  await bootstrapSupabaseAuth(client);

  if (!thenMigrating) {
    console.log('Run "up" next to apply migrations and grants.');
  }
  return 0;
}

/**
 * The role and schema the self-hosted Supabase Auth container runs in (P36).
 *
 * Optional, so CI's database job and local setups without Auth keep working:
 * nothing happens unless SUPABASE_AUTH_DB_PASSWORD is set. `deploy/compose.yml`
 * requires it.
 *
 * Auth creates and migrates its own tables at start-up, all inside the `auth`
 * schema. What it cannot do is create the role it logs in as, so that is done
 * here: `supabase_auth_admin` (Supabase's own name for it) owns `auth` and
 * searches it first. It needs `create` on the database because Auth's first
 * migration runs `create schema if not exists`, which Postgres checks for the
 * privilege before it checks whether the schema exists.
 *
 * Neither of our runtime roles gets anything on `auth`, and every isolation
 * check in this package looks only at `public`.
 */
async function bootstrapSupabaseAuth(client: pg.Client): Promise<void> {
  const password = (process.env.SUPABASE_AUTH_DB_PASSWORD ?? '').trim();
  if (password === '') {
    console.log('SUPABASE_AUTH_DB_PASSWORD is not set; skipping the Auth role and schema.');
    return;
  }

  await client.query('select set_config($1, $2, false)', ['integr8.bootstrap_password', password]);
  try {
    await client.query(`
      do $$
      declare
        secret text := current_setting('integr8.bootstrap_password');
      begin
        if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
          execute format('alter role supabase_auth_admin login password %L', secret);
        else
          execute format('create role supabase_auth_admin login password %L', secret);
        end if;

        alter role supabase_auth_admin set search_path = auth;
        execute format(
          'grant connect, create on database %I to supabase_auth_admin', current_database());

        create schema if not exists auth authorization supabase_auth_admin;
        alter schema auth owner to supabase_auth_admin;
      end;
      $$;
    `);
  } finally {
    await client.query('select set_config($1, $2, false)', ['integr8.bootstrap_password', '']);
  }
  console.log('Role supabase_auth_admin and schema auth are ready.');
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
