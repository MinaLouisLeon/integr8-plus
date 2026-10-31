-- 0058 — the platform role: cross-company work without the owner's powers.
--
-- Until now the API and the worker reached everything outside one company —
-- staff screens, creating a company, the job queue, metering, dunning, the
-- purge, the first step of sign-in — as `postgres`, the schema owner and a
-- superuser. A process that only needs to read and write rows held the power
-- to drop the schema, lift the append-only triggers, read files on the
-- database server and reach every other database in the cluster.
--
-- `integr8_platform` replaces it there. The migrator's bootstrap creates it
-- with BYPASSRLS (only a superuser can give that, so it cannot be done here),
-- and this migration gives it rows and nothing more:
--
--   - select, insert, update and delete on every table and view in `public`;
--   - only select on the migration history, which the readiness check reads;
--   - usage on the sequences, for the one identity column;
--   - execute on purge_tenant(), the one function the runtime calls that is
--     closed to public. It is security definer, owned by the superuser that
--     runs migrations, so `session_replication_role` still works inside it.
--
-- It owns nothing, so it cannot alter, drop, truncate, disable a trigger or
-- grant. The append-only and immutability triggers bind it like every role.
--
-- Unlike the two narrow roles, which get each table by hand (0002), tables
-- made by later migrations reach this one through default privileges. It
-- stands where the owner stood, and a new table the platform code reads would
-- otherwise fail in production only, where this role is in use. The schema
-- invariant suite checks that every table is covered.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'integr8_platform') then
    raise exception
      'Role integr8_platform does not exist. Run: pnpm --filter @integr8/db db bootstrap with INTEGR8_PLATFORM_PASSWORD set (see docs/database/README.md)'
      using errcode = 'undefined_object';
  end if;
end;
$$;

grant usage on schema public to integr8_platform;

grant select, insert, update, delete on all tables in schema public to integr8_platform;
revoke insert, update, delete on schema_migrations from integr8_platform;
revoke insert, update, delete on auth_memberships from integr8_platform;

grant usage, select, update on all sequences in schema public to integr8_platform;

grant execute on function purge_tenant(uuid) to integr8_platform;

-- For tables and sequences the migrations create from here on. They apply to
-- objects created by the role running this migration, which is the role that
-- runs every migration.
alter default privileges in schema public
  grant select, insert, update, delete on tables to integr8_platform;
alter default privileges in schema public
  grant usage, select, update on sequences to integr8_platform;
