-- 0002 — row-level security and runtime grants.
--
-- RLS is the backstop, not the primary control. The repository layer in
-- @integr8/db is the primary control: it injects `tenant_id` into every query,
-- and lint forbids raw query access outside that package. These policies exist
-- so that a bug in the repository layer is contained rather than catastrophic.
--
-- The two controls are tested independently. The repository suite runs as the
-- table owner, where RLS does not apply, so deleting a `tenant_id` filter leaks
-- and the suite fails. The RLS suite issues deliberately unfiltered SQL as
-- `integr8_app` and proves nothing crosses.
--
-- Ownership matters here. Tables are `enable row level security` but not
-- `force`, so the owner bypasses policies — that is what makes the repository
-- suite meaningful. The runtime therefore must never connect as the owner, and
-- `assertRlsEnforced()` in @integr8/db checks exactly that on every pool it
-- opens, refusing to serve traffic otherwise.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'integr8_app') then
    raise exception
      'Role integr8_app does not exist. Run: pnpm --filter @integr8/db db bootstrap (see docs/database/runbook-supabase-setup.md)'
      using errcode = 'undefined_object';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The tenant context.
-- ---------------------------------------------------------------------------

-- Reads the tenant the current transaction is acting for.
--
-- The value is set by `set_config('app.tenant_id', $1, true)` — transaction
-- local, the `true` — as the first statement of every tenant transaction. It is
-- copied there from the verified JWT's `tenant_id` claim (P03); the database
-- never parses a token itself, because the API is the only client Postgres has
-- and it holds the signing key.
--
-- Transaction-local is not a style preference. Supavisor runs in transaction
-- mode, so a session-level GUC would survive into the next tenant's query on
-- the same physical connection.
--
-- Unset context yields NULL, and `tenant_id = NULL` is NULL, not true. No
-- context therefore means no rows: the failure mode is a blank screen, not a
-- leak.
create function app_current_tenant_id() returns uuid
language sql
stable
set search_path = pg_catalog
as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid;
$$;

comment on function app_current_tenant_id() is
  'The tenant_id of the current transaction, from the app.tenant_id GUC. NULL when unset, which every policy treats as no access.';

-- ---------------------------------------------------------------------------
-- Grants. Explicit, per table, per migration.
-- ---------------------------------------------------------------------------
--
-- There is no `alter default privileges` here on purpose. A table added by a
-- later migration is invisible to the runtime until someone writes its grant,
-- which is the correct default for a multi-tenant schema: new tables fail
-- closed, and granting one is a line a reviewer sees.

grant usage on schema public to integr8_app;

-- Read-only, and only its own row. Companies are provisioned through the
-- platform data source, which connects as the owner.
grant select on tenants to integr8_app;

grant select, insert, update, delete on tenant_users to integr8_app;

-- Append-only for everyone; the trigger from 0001 blocks the rest regardless.
grant select, insert on audit_log to integr8_app;

-- platform_users gets no grant at all. Super-admin identity is not readable
-- from a tenant request under any circumstance.

-- ---------------------------------------------------------------------------
-- Policies.
-- ---------------------------------------------------------------------------

alter table tenants enable row level security;

create policy tenants_own_row on tenants
  for select
  to integr8_app
  using (id = app_current_tenant_id());

alter table tenant_users enable row level security;

create policy tenant_users_isolation on tenant_users
  for all
  to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table audit_log enable row level security;

create policy audit_log_read_own on audit_log
  for select
  to integr8_app
  using (tenant_id = app_current_tenant_id());

create policy audit_log_append_own on audit_log
  for insert
  to integr8_app
  with check (tenant_id = app_current_tenant_id());

-- No policy, no grant, RLS on. Three independent reasons a tenant request
-- cannot read a super admin.
alter table platform_users enable row level security;
