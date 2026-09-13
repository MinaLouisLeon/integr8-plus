-- 0002 — down.

drop policy if exists audit_log_append_own on audit_log;
drop policy if exists audit_log_read_own on audit_log;
drop policy if exists tenant_users_isolation on tenant_users;
drop policy if exists tenants_own_row on tenants;

alter table platform_users disable row level security;
alter table audit_log disable row level security;
alter table tenant_users disable row level security;
alter table tenants disable row level security;

revoke all on audit_log from integr8_app;
revoke all on tenant_users from integr8_app;
revoke all on tenants from integr8_app;
revoke usage on schema public from integr8_app;

drop function if exists app_current_tenant_id();
