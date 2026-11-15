-- Removes the platform module (see the up file).

drop table if exists
  test_outbox,
  signup_events,
  signup_requests,
  billing_events,
  subscriptions,
  tenant_deletions,
  tenant_exports,
  announcements,
  platform_audit_log,
  platform_refresh_tokens,
  platform_sessions
cascade;
drop function if exists purge_tenant(uuid);
drop function if exists reject_platform_audit_mutation();
