-- Reverses 0077. Test companies become ordinary companies again in the older
-- shape (nothing marks them), and what their outbox held is dropped.

drop table if exists test_outbox;

alter table impersonation_grants drop column from_limited_session;

alter table platform_sessions
  drop constraint platform_sessions_scope_known,
  drop column scope;

drop trigger if exists tenants_is_test_fixed on tenants;
drop function if exists tenants_is_test_fixed();

alter table tenants drop column is_test;
