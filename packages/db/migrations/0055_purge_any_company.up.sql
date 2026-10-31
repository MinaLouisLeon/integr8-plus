-- Closing a company: the purge removes every one of its rows, whatever they are.
--
-- purge_tenant() (0015, last redefined in 0030) deleted table by table with
-- every trigger and foreign key live, lifting only the append-only guards it
-- knew about. Guards and triggers added since stopped it. Run against the 101
-- companies the integration suites leave behind, 20 could not be purged:
--
--   - a published form version refuses DELETE for every role (0006), and every
--     real company has one;
--   - deleting jobs, sites and customers writes fresh sync_touches after that
--     table was emptied, so the final delete of the company broke its key;
--   - an approved purchase order's lines refuse to change;
--   - a quote converted into a sales order and that order point at each
--     other, so neither could go first;
--   - an ON DELETE SET NULL key blanked ai_messages.tenant_id;
--   - a storage usage counter went below zero.
--
-- The application had already emptied the company's bucket by then, and the
-- worker retried the purge on every cycle.
--
-- Now the purge runs with session_replication_role = replica, so no ordinary
-- trigger and no foreign-key check fires inside it, and each table is emptied
-- of the company's rows in one pass, in any order. That is safe because the
-- list is every table whose tenant_id references tenants, and no table outside
-- that list references a table inside it, so nothing is left pointing at a
-- deleted row. The tenant-purge integration suite checks both on every run.
-- The tables that keep a company's history after it has gone (tenant_deletions,
-- tenant_exports, platform_audit_log) carry tenant_id without a foreign key and
-- are not touched.
--
-- The append-only triggers are no longer switched off with ALTER TABLE, which
-- held an exclusive lock on the audit log and three other busy tables, for every
-- company, for as long as a purge ran. Setting session_replication_role needs a
-- superuser; this function runs as the schema owner, which is one.

create or replace function purge_tenant(p_tenant uuid) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
set session_replication_role = replica
as $$
declare
  scheduled uuid;
  doomed    text[];
  candidate text;
begin
  -- Still set for anything that asks; with triggers off, nothing here does.
  perform set_config('integr8.purging', p_tenant::text, true);

  select d.id into scheduled
    from public.tenant_deletions d
   where d.tenant_id = p_tenant
     and d.cancelled_at is null
     and d.completed_at is null
     and d.purge_after <= now();

  if scheduled is null then
    raise exception 'tenant % is not scheduled for deletion, or its cooling-off has not passed', p_tenant
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Every table with a tenant_id foreign key to tenants, in `public` only. The
  -- schema predicates matter: the delete below names `public.%I`, so a table
  -- of the same name in another schema would either raise undefined_table and
  -- stop every purge for ever, or name a real public table that was never
  -- meant to be in the list.
  select array_agg(distinct child.relname::text)
    into doomed
    from pg_constraint con
    join pg_class child on child.oid = con.conrelid
    join pg_class parent on parent.oid = con.confrelid
    join pg_attribute att on att.attrelid = child.oid and att.attnum = any (con.conkey)
   where con.contype = 'f'
     and parent.relname = 'tenants'
     and parent.relnamespace = 'public'::regnamespace
     and child.relnamespace = 'public'::regnamespace
     and att.attname = 'tenant_id';

  foreach candidate in array coalesce(doomed, array[]::text[]) loop
    execute format('delete from public.%I where tenant_id = $1', candidate) using p_tenant;
  end loop;

  delete from public.tenants where id = p_tenant;

  update public.tenant_deletions set completed_at = now() where id = scheduled;

  perform set_config('integr8.purging', '', true);
end;
$$;

comment on function purge_tenant(uuid) is
  'Deletes every row belonging to one company, with triggers and foreign-key checks suspended for the call. Refuses unless a deletion is scheduled and its cooling-off has passed.';
