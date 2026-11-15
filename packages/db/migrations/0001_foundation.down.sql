-- Removes the foundation module (see the up file).

drop table if exists
  rate_limit_buckets,
  idempotency_keys,
  jobs,
  scheduled_task_runs,
  plan_allowances,
  tenant_feature_flags,
  feature_flags,
  tenant_settings,
  platform_users,
  tenants
cascade;
drop function if exists ensure_year_partitions(p_years_ahead integer);
drop function if exists create_year_partition(p_parent regclass, p_year integer);
drop function if exists app_current_tenant_id();
drop function if exists erp_credit_note_total(uuid, uuid);
drop function if exists erp_invoice_total(uuid, uuid);
drop function if exists erp_ledger_backfill_more(uuid, date, text);
drop function if exists erp_ledger_currency(uuid);
drop function if exists erp_ledger_proposal_more(uuid, text, uuid);
drop function if exists erp_ledger_source_label_more(uuid, text, uuid);
drop function if exists erp_ledger_timezone(uuid);
drop function if exists erp_line_total(numeric, numeric, integer, integer);
drop function if exists erp_line_total(numeric, numeric, integer, integer, integer);
drop function if exists set_updated_at();
drop function if exists tenants_is_test_fixed();
alter default privileges in schema public revoke all on tables from integr8_platform;
alter default privileges in schema public revoke all on sequences from integr8_platform;
drop extension if exists btree_gist;
drop schema if exists extensions;
revoke usage on schema public from integr8_app, integr8_auth, integr8_platform;
