-- Reverses 0078. Accountants become viewers, as 0036's reversal did for the
-- roles it added: the closest role that can do nothing the accountant could
-- not. Company roles built on it keep their lists on a viewer base, past the
-- guard that otherwise keeps a role on the base it was built on.

update tenant_users set role = 'viewer' where role = 'accountant';
update invitations set role = 'viewer' where role = 'accountant';
alter table tenant_roles disable trigger tenant_roles_guard;
update tenant_roles set base_role = 'viewer' where base_role = 'accountant';
alter table tenant_roles enable trigger tenant_roles_guard;
update forms
   set fill_roles = array_remove(fill_roles, 'accountant')
 where fill_roles && array['accountant'];

alter table tenant_roles drop constraint tenant_roles_base_known;
alter table tenant_roles add constraint tenant_roles_base_known
  check (base_role in ('admin', 'hr_manager', 'inventory_manager', 'dispatcher', 'engineer', 'viewer'));

alter table forms drop constraint forms_fill_roles_known;
alter table forms add constraint forms_fill_roles_known
  check (fill_roles <@ array['owner', 'admin', 'hr_manager', 'inventory_manager', 'dispatcher', 'engineer', 'viewer']);

alter table invitations drop constraint invitations_role_known;
alter table invitations add constraint invitations_role_known
  check (role in ('owner', 'admin', 'hr_manager', 'inventory_manager', 'dispatcher', 'engineer', 'viewer'));

alter table tenant_users drop constraint tenant_users_role_known;
alter table tenant_users add constraint tenant_users_role_known
  check (role in ('owner', 'admin', 'hr_manager', 'inventory_manager', 'dispatcher', 'engineer', 'viewer'));
