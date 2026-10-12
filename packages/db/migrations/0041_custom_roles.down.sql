-- Reverses 0041.

drop trigger tenant_users_custom_role_guard on tenant_users;
drop function tenant_users_custom_role_guard();
drop index tenant_users_custom_role_idx;
alter table tenant_users
  drop constraint tenant_users_custom_role_fk,
  drop column custom_role_id;
drop trigger tenant_roles_guard on tenant_roles;
drop function tenant_roles_guard();
drop table tenant_roles;
