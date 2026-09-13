-- 0005 — let the membership check read what it checks.
--
-- 0001 added `reject_platform_user_membership()` so that a super admin can never
-- hold a company membership. The function looks the new `user_id` up in
-- `platform_users`, and it ran with the privileges of whoever fired the trigger.
--
-- For the owner that worked. For `integr8_app` — the role every tenant request
-- uses, and which by design holds no privilege on `platform_users` at all — it
-- failed with "permission denied for table platform_users". So every insert into
-- `tenant_users` through the runtime path was refused: accepting an invitation,
-- adding a member, seeding through a repository. The integration suite found it
-- the first time it ran against a real database.
--
-- The fix is not a grant. Giving the runtime role `select` on `platform_users`
-- would let any tenant request enumerate super-admin identities, which is the
-- thing 0002 exists to prevent. Instead the function runs as its owner, and the
-- only thing it can report back is whether one id is present.
--
-- `search_path` is pinned because a security-definer function that resolves
-- names through the caller's path can be handed a lookalike `platform_users` in
-- a schema the caller controls. Qualified names alone are not enough; operators
-- resolve through the path too.
--
-- Forward-only rather than an edit to 0001, per docs/database/migrations.md.

alter function reject_platform_user_membership() security definer;
alter function reject_platform_user_membership() set search_path = pg_catalog, public;

comment on function reject_platform_user_membership() is
  'Refuses a tenant membership for a platform_users identity. Security definer so the runtime role, which cannot read platform_users, can still be checked against it; search_path is pinned.';
