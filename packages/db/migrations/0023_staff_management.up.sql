-- Integr8 staff managed from the dashboard.
--
-- Until now the only way to make a platform account was the terminal command
-- (`admin-cli create`), run on the server by whoever holds the deployment.
-- The dashboard gains a Staff screen where more people can be added and
-- removed, but that power stays with the accounts the terminal made: a person
-- added from the dashboard can use the dashboard, and cannot add or remove
-- anybody, including themselves.
--
--   can_manage_staff          true only for accounts made by the terminal
--                             command; it alone may add or remove staff
--   added_by_platform_user_id who added this account from the dashboard;
--                             null for terminal accounts

alter table platform_users
  add column can_manage_staff          boolean not null default false,
  add column added_by_platform_user_id uuid
    references platform_users (id) on delete set null;

-- Every account that exists today came from the terminal command or the
-- development seed, so every one of them may manage staff.
update platform_users set can_manage_staff = true;

create index platform_users_added_by_idx on platform_users (added_by_platform_user_id);

comment on column platform_users.can_manage_staff is
  'True for accounts made by the terminal command (admin-cli create). Only these may add or remove staff.';
comment on column platform_users.added_by_platform_user_id is
  'The staff manager who added this account from the dashboard. Null for terminal accounts.';
