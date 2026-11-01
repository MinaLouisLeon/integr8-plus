-- Back to 0018's defaults for new companies. Rows written meanwhile keep
-- whatever they hold.

create or replace function erp_ledger_timezone(p_tenant uuid) returns text
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select coalesce((select s.timezone from tenant_settings s where s.tenant_id = p_tenant), 'UTC');
$$;

alter table tenant_settings alter column working_days set default '{1,2,3,4,5}';
alter table tenant_settings alter column timezone set default 'UTC';
