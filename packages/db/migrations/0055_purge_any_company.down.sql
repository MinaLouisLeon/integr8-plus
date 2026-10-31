-- Reverses 0055: purge_tenant() goes back to its 0030 form, deleting with
-- triggers and foreign keys live and lifting only the four append-only guards.

create or replace function purge_tenant(p_tenant uuid) returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  scheduled  uuid;
  remaining  text[];
  attempt    text[];
  progressed boolean;
  candidate  text;
  guard      text;
begin
  -- Tells the document guards (0029, 0030) that this company is going: they
  -- refuse to delete issued lines and documents for anyone else.
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

  -- Every table with a tenant_id foreign key to tenants, in `public` only.
  -- The schema predicates matter: the delete below names `public.%I`, so a
  -- table of the same name in another schema would either raise undefined_table
  -- and stop every purge for ever, or — worse — name a real public table that
  -- was never meant to be in the list.
  select array_agg(distinct child.relname::text)
    into remaining
    from pg_constraint con
    join pg_class child on child.oid = con.conrelid
    join pg_class parent on parent.oid = con.confrelid
    join pg_attribute att on att.attrelid = child.oid and att.attnum = any (con.conkey)
   where con.contype = 'f'
     and parent.relname = 'tenants'
     and parent.relnamespace = 'public'::regnamespace
     and child.relnamespace = 'public'::regnamespace
     and att.attname = 'tenant_id';

  -- The append-only guards refuse delete for every role, the schema owner
  -- included. That is the point of them, and it makes this function the one
  -- place allowed to lift them: it has already checked that a deletion is
  -- scheduled and due, so a company's history goes only when the company does.
  -- `platform_audit_log` is deliberately not on this list — it has no tenant_id
  -- foreign key and outlives the company it describes.
  foreach guard in array array['audit_log', 'submission_events', 'work_order_events', 'erp_stock_movements'] loop
    execute format('alter table public.%I disable trigger %I', guard, guard || '_no_delete');
  end loop;

  while coalesce(array_length(remaining, 1), 0) > 0 loop
    progressed := false;
    attempt := remaining;
    foreach candidate in array attempt loop
      begin
        execute format('delete from public.%I where tenant_id = $1', candidate) using p_tenant;
        remaining := array_remove(remaining, candidate);
        progressed := true;
      exception
        when foreign_key_violation then
          -- A child of this table still holds rows. Another pass will reach it.
          null;
      end;
    end loop;

    if not progressed then
      raise exception 'could not purge tenant %: % still holds rows', p_tenant, remaining
        using errcode = 'foreign_key_violation';
    end if;
  end loop;

  delete from public.tenants where id = p_tenant;

  update public.tenant_deletions set completed_at = now() where id = scheduled;

  foreach guard in array array['audit_log', 'submission_events', 'work_order_events', 'erp_stock_movements'] loop
    execute format('alter table public.%I enable trigger %I', guard, guard || '_no_delete');
  end loop;

  perform set_config('integr8.purging', '', true);
end;
$$;

comment on function purge_tenant(uuid) is
  'Deletes every row belonging to one company, in an order it works out itself. Refuses unless a deletion is scheduled and its cooling-off has passed.';
