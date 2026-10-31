-- 0058 — down. The role itself stays: roles belong to the cluster and the
-- bootstrap, not to a migration. Without these grants it reaches nothing.

alter default privileges in schema public
  revoke usage, select, update on sequences from integr8_platform;
alter default privileges in schema public
  revoke select, insert, update, delete on tables from integr8_platform;

revoke execute on function purge_tenant(uuid) from integr8_platform;
revoke all on all sequences in schema public from integr8_platform;
revoke all on all tables in schema public from integr8_platform;
revoke usage on schema public from integr8_platform;
