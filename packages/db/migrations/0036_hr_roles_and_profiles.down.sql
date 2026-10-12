-- Reverses 0036. Members holding a new role become viewers, and forms forget
-- the new roles, so the five-role checks hold again. Drops employee profiles
-- and grants: on a live database, take a company export first.

drop table hr_employees;
drop table member_grants;

update tenant_users set role = 'viewer' where role in ('hr_manager', 'inventory_manager');
update invitations set role = 'viewer' where role in ('hr_manager', 'inventory_manager');
update forms
   set fill_roles = array_remove(array_remove(fill_roles, 'hr_manager'), 'inventory_manager')
 where fill_roles && array['hr_manager', 'inventory_manager'];

alter table forms drop constraint forms_fill_roles_known;
alter table forms add constraint forms_fill_roles_known
  check (fill_roles <@ array['owner', 'admin', 'dispatcher', 'engineer', 'viewer']);
alter table invitations drop constraint invitations_role_known;
alter table invitations add constraint invitations_role_known
  check (role in ('owner', 'admin', 'dispatcher', 'engineer', 'viewer'));
alter table tenant_users drop constraint tenant_users_role_known;
alter table tenant_users add constraint tenant_users_role_known
  check (role in ('owner', 'admin', 'dispatcher', 'engineer', 'viewer'));

delete from feature_flags where key in ('hr', 'payroll', 'manufacturing');
