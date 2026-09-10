import { ROLES } from '@integr8/core';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PLATFORM_TABLES, SECURITY_DEFINER_VIEWS, TENANT_SCOPED_TABLES } from '../schema.js';
import { connectAsOwner } from './harness.js';

/**
 * Rules about the schema as a whole, checked against the live catalogue.
 *
 * These are the tests that keep working after P02 is finished. Every phase from
 * here to P35 adds tables, and each one is an opportunity to add a table with
 * no `tenant_id`, or with one that is nullable, or with RLS left off. Reviewing
 * for that by eye works until the afternoon it does not.
 *
 * A new table is therefore tenant-scoped by default as far as this suite is
 * concerned, and opting out means adding its name to `PLATFORM_TABLES` — one
 * line, in a file about tenancy, that a reviewer will read.
 */

let owner: pg.Client;

beforeAll(async () => {
  owner = await connectAsOwner();
});

afterAll(async () => {
  await owner.end();
});

async function publicTables(): Promise<string[]> {
  const result = await owner.query<{ table_name: string }>(`
    select c.relname::text as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
    order by c.relname
  `);
  return result.rows.map((row) => row.table_name);
}

describe('the shape of every table', () => {
  it('has row-level security enabled on every table in public, with no exceptions', async () => {
    const result = await owner.query<{ table_name: string }>(`
      select c.relname::text as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
      order by c.relname
    `);

    expect(result.rows.map((row) => row.table_name)).toEqual([]);
  });

  it('gives every tenant-scoped table a non-null tenant_id', async () => {
    const tables = (await publicTables()).filter(
      (table) => !(PLATFORM_TABLES as readonly string[]).includes(table),
    );

    for (const table of tables) {
      const result = await owner.query<{ is_nullable: string }>(
        `select is_nullable from information_schema.columns
         where table_schema = 'public' and table_name = $1 and column_name = 'tenant_id'`,
        [table],
      );

      expect(result.rows[0], `${table} has no tenant_id column`).toBeDefined();
      expect(result.rows[0]?.is_nullable, `${table}.tenant_id is nullable`).toBe('NO');
    }
  });

  it('gives every tenant_id a foreign key to tenants', async () => {
    const tables = (await publicTables()).filter(
      (table) => !(PLATFORM_TABLES as readonly string[]).includes(table),
    );

    for (const table of tables) {
      const result = await owner.query<{ constraint_name: string }>(
        `select con.conname::text as constraint_name
         from pg_constraint con
         join pg_class child on child.oid = con.conrelid
         join pg_class parent on parent.oid = con.confrelid
         join pg_attribute att on att.attrelid = child.oid and att.attnum = any(con.conkey)
         where con.contype = 'f'
           and child.relname = $1
           and parent.relname = 'tenants'
           and att.attname = 'tenant_id'`,
        [table],
      );

      expect(result.rows.length, `${table}.tenant_id has no FK to tenants`).toBeGreaterThan(0);
    }
  });

  it('gives every tenant-scoped table a policy keyed on the tenant context', async () => {
    for (const table of TENANT_SCOPED_TABLES) {
      const result = await owner.query<{ policyname: string; qual: string | null }>(
        `select policyname::text, qual::text from pg_policies
         where schemaname = 'public' and tablename = $1`,
        [table],
      );

      expect(result.rows.length, `${table} has no policy`).toBeGreaterThan(0);
      expect(
        result.rows.some((row) => row.qual?.includes('app_current_tenant_id') === true),
        `${table} has no policy using app_current_tenant_id()`,
      ).toBe(true);
    }
  });

  it('lists exactly the tables the TypeScript schema declares', async () => {
    const expected = [...PLATFORM_TABLES, ...TENANT_SCOPED_TABLES].sort((a, b) =>
      a.localeCompare(b),
    );

    expect(await publicTables()).toEqual(expected);
  });
});

describe('views, the easiest way to lose isolation', () => {
  /**
   * A view created without `security_invoker` runs with its owner's privileges,
   * so it reads past every RLS policy on the tables underneath it. That is
   * occasionally exactly what is wanted — `auth_memberships` exists because
   * sign-in has to see across companies — and it is otherwise a cross-tenant
   * read added by accident, in a diff that looks like a convenience.
   *
   * So views are allow-listed, and an unlisted one fails the build.
   */
  it('has no view in public that is not declared in SECURITY_DEFINER_VIEWS', async () => {
    const result = await owner.query<{ view_name: string }>(`
      select c.relname::text as view_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('v', 'm')
      order by c.relname
    `);

    expect(result.rows.map((row) => row.view_name)).toEqual(
      [...SECURITY_DEFINER_VIEWS].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('exposes only identity, company, role and status through auth_memberships', async () => {
    const result = await owner.query<{ column_name: string }>(
      `select column_name::text as column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'auth_memberships'
       order by column_name`,
    );

    // Adding a column here — an email address, say — would widen the one
    // deliberate cross-tenant read in the schema.
    expect(result.rows.map((row) => row.column_name)).toEqual([
      'role',
      'status',
      'tenant_id',
      'user_id',
    ]);
  });
});

describe('the pre-authentication role', () => {
  async function authPrivileges(): Promise<{ table: string; privilege: string }[]> {
    const result = await owner.query<{ table_name: string; privilege_type: string }>(
      `select table_name::text as table_name, privilege_type::text as privilege_type
       from information_schema.role_table_grants
       where grantee = 'integr8_auth' and table_schema = 'public'
       order by table_name, privilege_type`,
    );
    return result.rows.map((row) => ({ table: row.table_name, privilege: row.privilege_type }));
  }

  it('reaches exactly four objects and no more', async () => {
    const reachable = [...new Set((await authPrivileges()).map((entry) => entry.table))].sort(
      (a, b) => a.localeCompare(b),
    );

    // Every name here is a deliberate exception to tenant scoping, so the list
    // is asserted exactly rather than loosely. Adding one is a line a reviewer
    // sees, in a test about the thing being widened.
    expect(reachable).toEqual([
      'account_locks',
      'auth_memberships',
      'login_attempts',
      'rate_limit_buckets',
    ]);
  });

  it('holds no privilege on any tenant-scoped table', async () => {
    const scoped = (await authPrivileges()).filter((entry) =>
      (TENANT_SCOPED_TABLES as readonly string[]).includes(entry.table),
    );

    expect(scoped).toEqual([]);
  });

  it('can read memberships but not write them', async () => {
    const onView = (await authPrivileges())
      .filter((entry) => entry.table === 'auth_memberships')
      .map((entry) => entry.privilege);

    expect(onView).toEqual(['SELECT']);
  });

  it('cannot delete a login attempt, so the record of an attack survives it', async () => {
    const onAttempts = (await authPrivileges())
      .filter((entry) => entry.table === 'login_attempts')
      .map((entry) => entry.privilege);

    expect(onAttempts).toEqual(['INSERT', 'SELECT']);
  });

  it('is neither a superuser nor a BYPASSRLS role nor an owner', async () => {
    const role = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `select rolsuper, rolbypassrls from pg_roles where rolname = 'integr8_auth'`,
    );

    expect(role.rows[0]?.rolsuper).toBe(false);
    expect(role.rows[0]?.rolbypassrls).toBe(false);

    const owned = await owner.query(
      `select 1 from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and pg_get_userbyid(c.relowner) = 'integr8_auth'`,
    );

    expect(owned.rowCount).toBe(0);
  });
});

describe('tenant-scoped foreign keys carry the tenant', () => {
  /**
   * `references sessions (id)` alone would let a refresh token in one company
   * name a session in another: both are valid uuids and nothing would object.
   * Every foreign key between two tenant-scoped tables therefore includes
   * `tenant_id`, which turns that from a leak RLS has to catch on the way out
   * into a foreign-key violation on the way in.
   */
  it('includes tenant_id in every foreign key between two tenant-scoped tables', async () => {
    const result = await owner.query<{
      constraint_name: string;
      child: string;
      parent: string;
      columns: string[];
    }>(
      `select
         con.conname::text                                as constraint_name,
         child.relname::text                              as child,
         parent.relname::text                             as parent,
         array_agg(att.attname::text order by att.attnum) as columns
       from pg_constraint con
       join pg_class child  on child.oid  = con.conrelid
       join pg_class parent on parent.oid = con.confrelid
       join pg_attribute att on att.attrelid = child.oid and att.attnum = any(con.conkey)
       where con.contype = 'f'
         and child.relname  = any($1::text[])
         and parent.relname = any($1::text[])
       group by 1, 2, 3`,
      [[...TENANT_SCOPED_TABLES]],
    );

    const missing = result.rows.filter((row) => !row.columns.includes('tenant_id'));

    expect(missing.map((row) => `${row.constraint_name} (${row.child} -> ${row.parent})`)).toEqual(
      [],
    );
    // And there is at least one such key, so the check is not vacuous.
    expect(result.rows.length).toBeGreaterThan(0);
  });
});

describe('what the runtime role may do', () => {
  async function privileges(table: string): Promise<string[]> {
    const result = await owner.query<{ privilege_type: string }>(
      `select privilege_type from information_schema.role_table_grants
       where grantee = 'integr8_app' and table_schema = 'public' and table_name = $1
       order by privilege_type`,
      [table],
    );
    return result.rows.map((row) => row.privilege_type);
  }

  it('has no privilege whatsoever on platform_users', async () => {
    expect(await privileges('platform_users')).toEqual([]);
  });

  it('has no privilege on the migration history', async () => {
    expect(await privileges('schema_migrations')).toEqual([]);
  });

  it('cannot reach the pre-authentication tables or the cross-tenant view', async () => {
    expect(await privileges('login_attempts')).toEqual([]);
    expect(await privileges('account_locks')).toEqual([]);
    expect(await privileges('auth_memberships')).toEqual([]);
    expect(await privileges('rate_limit_buckets')).toEqual([]);
  });

  it('cannot delete a session, an invitation or an impersonation grant', async () => {
    // Revocation sets a timestamp and a reason. "Revoked at 14:02 for
    // refresh_token_reuse" is what an incident needs, and a deleted row cannot
    // say it.
    for (const table of [
      'sessions',
      'refresh_tokens',
      'offline_grants',
      'invitations',
      'impersonation_grants',
      'idempotency_keys',
      'jobs',
    ]) {
      expect(await privileges(table), table).toEqual(['INSERT', 'SELECT', 'UPDATE']);
    }
  });

  it('may delete only rate-limit counters, and only through the gateway role', async () => {
    // The single exception to append-or-revoke in this schema. A spent counter
    // has no evidentiary value; a login attempt does, which is why that one is
    // insert-only.
    const onBuckets = (
      await owner.query<{ privilege_type: string }>(
        `select privilege_type::text as privilege_type
       from information_schema.role_table_grants
       where grantee = 'integr8_auth' and table_name = 'rate_limit_buckets'
       order by privilege_type`,
      )
    ).rows.map((row) => row.privilege_type);

    expect(onBuckets).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE']);
  });

  it('may only read tenants', async () => {
    expect(await privileges('tenants')).toEqual(['SELECT']);
  });

  it('may read and append audit_log, and nothing else', async () => {
    expect(await privileges('audit_log')).toEqual(['INSERT', 'SELECT']);
  });

  it('is neither a superuser nor a BYPASSRLS role nor an owner', async () => {
    const role = await owner.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `select rolsuper, rolbypassrls from pg_roles where rolname = 'integr8_app'`,
    );

    expect(role.rows[0]?.rolsuper).toBe(false);
    expect(role.rows[0]?.rolbypassrls).toBe(false);

    const owned = await owner.query(
      `select 1 from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and pg_get_userbyid(c.relowner) = 'integr8_app'`,
    );

    expect(owned.rowCount).toBe(0);
  });
});

describe('vocabularies shared with the application', () => {
  it('accepts exactly the roles @integr8/core defines', async () => {
    const result = await owner.query<{ definition: string }>(
      `select pg_get_constraintdef(oid)::text as definition
       from pg_constraint where conname = 'tenant_users_role_known'`,
    );

    const definition = result.rows[0]?.definition ?? '';
    for (const role of ROLES) {
      expect(definition, `the database rejects the role "${role}"`).toContain(`'${role}'`);
    }

    // And nothing beyond them: one quoted literal per known role.
    expect((definition.match(/'[a-z_]+'/gu) ?? []).length).toBe(ROLES.length);
  });

  it('refuses a role the application does not define', async () => {
    await expect(
      owner.query(
        `insert into tenant_users (tenant_id, user_id, email, display_name, role)
         select id, gen_random_uuid(), 'x@y.example', 'X', 'superadmin' from tenants limit 1`,
      ),
    ).rejects.toThrow(/tenant_users_role_known/u);
  });
});

describe('the two identity spaces', () => {
  it('refuses to give a platform user a company membership', async () => {
    const platform = await owner.query<{ id: string }>(
      `insert into platform_users (email, display_name)
       values ('invariant.check@integr8.example', 'Invariant Check')
       on conflict (email) do update set display_name = excluded.display_name
       returning id`,
    );
    const platformUserId = platform.rows[0]?.id;
    expect(platformUserId).toBeDefined();

    const tenant = await owner.query<{ id: string }>(
      `insert into tenants (slug, name) values ('invariant-check', 'Invariant Check Ltd')
       on conflict (slug) do update set name = excluded.name
       returning id`,
    );

    await expect(
      owner.query(
        `insert into tenant_users (tenant_id, user_id, email, display_name, role)
         values ($1, $2, 'invariant.check@integr8.example', 'Invariant Check', 'owner')`,
        [tenant.rows[0]?.id, platformUserId],
      ),
    ).rejects.toThrow(/cannot hold a tenant membership/u);
  });
});
