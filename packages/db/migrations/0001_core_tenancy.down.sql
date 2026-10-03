-- 0001 — down.
--
-- `audit_log` is append-only by trigger, so the triggers come off before the
-- table can go. Dropping a table does not fire its triggers, but leaving them
-- in place while the function is dropped would leave a dangling dependency.

drop trigger if exists audit_log_no_truncate on audit_log;
drop trigger if exists audit_log_no_delete on audit_log;
drop trigger if exists audit_log_no_update on audit_log;
drop table if exists audit_log;
drop function if exists reject_audit_log_mutation();

drop table if exists tenant_users;
drop function if exists reject_platform_user_membership();

drop table if exists platform_users;
drop table if exists tenants;

drop function if exists set_updated_at();
