-- Removes the identity module (see the up file).

drop view if exists auth_memberships;
drop table if exists
  push_devices,
  identity_deletions,
  account_locks,
  login_attempts,
  impersonation_grants,
  invitations,
  offline_grants,
  refresh_tokens,
  sessions,
  audit_log,
  member_grants,
  tenant_roles,
  tenant_users
cascade;
drop function if exists reject_audit_log_mutation();
drop function if exists reject_platform_user_membership();
drop function if exists tenant_roles_guard();
drop function if exists tenant_users_custom_role_guard();
