-- Everything the platform knows goes; the companies themselves are untouched.

drop policy if exists tenant_feature_flags_isolation on tenant_feature_flags;
drop policy if exists feature_flags_readable on feature_flags;

drop function if exists purge_tenant(uuid);

drop table if exists tenant_deletions;
drop table if exists tenant_exports;
drop table if exists announcements;
drop table if exists tenant_feature_flags;
drop table if exists feature_flags;

drop trigger if exists platform_audit_log_no_truncate on platform_audit_log;
drop trigger if exists platform_audit_log_no_delete on platform_audit_log;
drop trigger if exists platform_audit_log_no_update on platform_audit_log;
drop table if exists platform_audit_log;
drop function if exists reject_platform_audit_mutation();

drop table if exists platform_refresh_tokens;
drop table if exists platform_sessions;

-- A suspension is "stopped, and here is why" — one fact, in two columns this
-- migration is about to drop. Rolling back without this leaves companies
-- refused service with nothing left to say why, and leaves rows that 0015
-- would then refuse to re-apply over. So a rollback lifts the suspensions it
-- can no longer describe.
update tenants set status = 'active' where status = 'suspended';

alter table tenants
  drop constraint if exists tenants_suspension_matches_status,
  drop constraint if exists tenants_suspension_pair,
  drop constraint if exists tenants_seats_positive,
  drop constraint if exists tenants_plan_known;

alter table tenants
  drop column if exists onboarded_by,
  drop column if exists suspended_reason,
  drop column if exists suspended_at,
  drop column if exists seats,
  drop column if exists plan;

alter table platform_users
  drop constraint if exists platform_users_totp_pair,
  drop constraint if exists platform_users_failed_attempts_sane;

alter table platform_users
  drop column if exists locked_until,
  drop column if exists failed_attempts,
  drop column if exists last_signed_in_at,
  drop column if exists totp_enrolled_at,
  drop column if exists totp_secret,
  drop column if exists password_changed_at,
  drop column if exists password_hash;
