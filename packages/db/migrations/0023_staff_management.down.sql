-- Reverses 0023. Accounts added from the dashboard stay; they simply become
-- indistinguishable from terminal ones, as every account was before.

drop index platform_users_added_by_idx;

alter table platform_users
  drop column added_by_platform_user_id,
  drop column can_manage_staff;
