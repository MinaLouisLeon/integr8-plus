# P03 — Authentication and roles

**Version:** v0.1 Foundation
**Status:** `NOT STARTED`
**Depends on:** P02

## Goal
A person signs in once and the system knows which company they belong to, what they may
do, and — separately — whether they are you.

## Scope
Two identity spaces: tenant users and platform (super admin) users. They never mix.

## Tasks
- [ ] Supabase Auth wired for email/password and magic link
- [ ] Custom JWT claims carrying `tenant_id` and `role`, populated on sign-in and on tenant switch
- [ ] Roles: Company Owner, Admin, Dispatcher, Engineer, Viewer — with a permission matrix in code, not scattered `if` statements
- [ ] `platform_users` table and a separate sign-in path for super admin
- [ ] Impersonation: time-limited token, mandatory reason, audit entry written before access is granted
- [ ] Invite flow: admin invites by email with role preset; invite expires; acceptance binds the user to the tenant
- [ ] Refresh-token rotation; tokens stored in the OS keychain on desktop and SecureStore on mobile — never in local storage
- [ ] Offline authentication: a signed token valid for a configurable number of days so the mobile app opens without signal
- [ ] Password policy, rate-limited attempts, lockout with admin unlock
- [ ] Session listing and remote revocation

## Exit criteria
- [ ] A user's JWT cannot be edited to reach another tenant — verified by a test that tries
- [ ] Impersonation writes an audit entry that cannot be deleted through the application
- [ ] A super admin has no membership row inside any tenant, verified by a test
- [ ] The mobile app opens and shows cached work after seven days with no network

## Notes
- Do not use per-tenant Supabase Auth instances. One identity system, one login, or
  super-admin impersonation becomes unworkable.
- Decide the offline token lifetime with the security tradeoff written down: a longer
  window is friendlier to engineers and worse if a phone is stolen.
