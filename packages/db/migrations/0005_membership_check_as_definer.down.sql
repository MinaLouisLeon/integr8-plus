-- 0005 — down.
--
-- Restores 0001's definition exactly, including the defect: the runtime role
-- cannot insert into tenant_users once this has run.

alter function reject_platform_user_membership() reset search_path;
alter function reject_platform_user_membership() security invoker;

comment on function reject_platform_user_membership() is null;
