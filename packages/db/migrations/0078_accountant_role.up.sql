-- 0078 — the accountant, a built-in role that keeps the books.
--
-- Invoices and payments, the general ledger, expense claims and e-invoicing,
-- and nothing of the operation or of HR (what it holds is the matrix in
-- @integr8/core). Ranks between the inventory manager and the dispatcher.
--
-- The database only keeps the vocabulary, so this widens the four checks that
-- name the roles; the schema-invariant suite holds them to ROLES. Expand-only:
-- the previous release never writes the new value, and a member holding it
-- under the previous release fails its role parse rather than gaining
-- anything.

alter table tenant_users drop constraint tenant_users_role_known;
alter table tenant_users add constraint tenant_users_role_known
  check (role in ('owner', 'admin', 'hr_manager', 'inventory_manager', 'accountant', 'dispatcher', 'engineer', 'viewer'));

alter table invitations drop constraint invitations_role_known;
alter table invitations add constraint invitations_role_known
  check (role in ('owner', 'admin', 'hr_manager', 'inventory_manager', 'accountant', 'dispatcher', 'engineer', 'viewer'));

alter table forms drop constraint forms_fill_roles_known;
alter table forms add constraint forms_fill_roles_known
  check (fill_roles <@ array['owner', 'admin', 'hr_manager', 'inventory_manager', 'accountant', 'dispatcher', 'engineer', 'viewer']);

-- A company's own role may start from the accountant too (ADR-0013).
alter table tenant_roles drop constraint tenant_roles_base_known;
alter table tenant_roles add constraint tenant_roles_base_known
  check (base_role in ('admin', 'hr_manager', 'inventory_manager', 'accountant', 'dispatcher', 'engineer', 'viewer'));
