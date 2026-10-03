-- 0003 — down.
--
-- Dropped in dependency order: the view first, then the tables that reference
-- one another, then the constraint added to audit_log in 0002's table.

drop view if exists auth_memberships;

revoke all on login_attempts from integr8_auth;
revoke all on account_locks from integr8_auth;

drop table if exists account_locks;
drop table if exists login_attempts;

-- sessions gained a foreign key to impersonation_grants after that table
-- existed, so it comes off before either can be dropped.
alter table sessions drop constraint if exists sessions_impersonation_grant_fk;

drop table if exists impersonation_grants;
drop table if exists invitations;
drop table if exists offline_grants;
drop table if exists refresh_tokens;
drop table if exists sessions;

alter table audit_log drop constraint if exists audit_log_tenant_id_unique;

revoke usage on schema public from integr8_auth;
