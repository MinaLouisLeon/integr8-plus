-- 0001 — core tenancy tables.
--
-- Every table here is either a tenant (`tenants`), a thing outside all tenants
-- (`platform_users`), or a tenant-scoped table carrying a non-null `tenant_id`
-- with a foreign key. There is no fourth category, and later migrations are
-- checked against that rule by the schema-invariant test suite.
--
-- No enum types: role and status vocabularies are `text` with a check
-- constraint, so widening one is a transactional `drop constraint` /
-- `add constraint` pair that expand/contract can express. See
-- docs/database/migrations.md.

-- Stamps `updated_at` on every UPDATE so no caller can forget to.
create function set_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

comment on function set_updated_at() is
  'Trigger function: maintains updated_at. Attached to every table with that column.';

-- ---------------------------------------------------------------------------
-- tenants — one row per company. The root of every isolation decision.
-- ---------------------------------------------------------------------------

create table tenants (
  id          uuid        primary key default gen_random_uuid(),
  slug        text        not null,
  name        text        not null,
  status      text        not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,

  constraint tenants_slug_unique unique (slug),
  -- The slug names this company's R2 bucket (a locked decision), so it is
  -- restricted to what S3-compatible bucket naming accepts.
  constraint tenants_slug_format check (slug ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'),
  constraint tenants_name_not_blank check (btrim(name) <> ''),
  constraint tenants_status_known check (status in ('active', 'suspended', 'cancelled'))
);

comment on table tenants is
  'One row per customer company. `id` is the tenant_id every other table carries.';
comment on column tenants.slug is
  'URL and R2-bucket-safe identifier. Immutable in practice; changing it orphans stored media.';
comment on column tenants.deleted_at is
  'Soft delete. Repositories exclude non-null rows; audit_log holds a restricting FK so history survives.';

create trigger tenants_set_updated_at
  before update on tenants
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- platform_users — super admins. Deliberately outside tenant space.
-- ---------------------------------------------------------------------------

create table platform_users (
  id            uuid        primary key default gen_random_uuid(),
  email         text        not null,
  display_name  text        not null,
  is_active     boolean     not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint platform_users_email_unique unique (email),
  constraint platform_users_email_lowercase check (email = lower(email)),
  constraint platform_users_email_shaped check (email like '%_@_%'),
  constraint platform_users_display_name_not_blank check (btrim(display_name) <> '')
);

comment on table platform_users is
  'Super-admin identities. A platform user never holds a tenant_users row; the trigger on tenant_users enforces it.';

create trigger platform_users_set_updated_at
  before update on platform_users
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- tenant_users — membership of a person in a company.
-- ---------------------------------------------------------------------------

create table tenant_users (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete cascade,
  user_id       uuid        not null,
  email         text        not null,
  display_name  text        not null,
  role          text        not null,
  status        text        not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  constraint tenant_users_membership_unique unique (tenant_id, user_id),
  constraint tenant_users_email_per_tenant_unique unique (tenant_id, email),
  constraint tenant_users_email_lowercase check (email = lower(email)),
  constraint tenant_users_email_shaped check (email like '%_@_%'),
  constraint tenant_users_display_name_not_blank check (btrim(display_name) <> ''),
  -- Mirrors ROLES in @integr8/core, most privileged first. The schema-invariant
  -- suite fails if the two drift apart.
  constraint tenant_users_role_known
    check (role in ('owner', 'admin', 'dispatcher', 'engineer', 'viewer')),
  constraint tenant_users_status_known
    check (status in ('invited', 'active', 'suspended'))
);

comment on table tenant_users is
  'Membership: which person belongs to which company, in what role.';
comment on column tenant_users.user_id is
  'The auth identity (auth.users.id once P03 lands). Not a foreign key: auth lives in another schema.';

create index tenant_users_user_id_idx on tenant_users (user_id);
create index tenant_users_tenant_active_idx on tenant_users (tenant_id) where deleted_at is null;

create trigger tenant_users_set_updated_at
  before update on tenant_users
  for each row execute function set_updated_at();

-- The two identity spaces never mix. P03's exit criterion asks for a test that
-- a super admin holds no membership row; this makes it a constraint instead, so
-- that test confirms an invariant rather than a habit.
create function reject_platform_user_membership() returns trigger
language plpgsql
as $$
begin
  if exists (select 1 from platform_users where id = new.user_id) then
    raise exception
      'user_id % is a platform_users identity and cannot hold a tenant membership', new.user_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger tenant_users_reject_platform_user
  before insert or update of user_id on tenant_users
  for each row execute function reject_platform_user_membership();

-- ---------------------------------------------------------------------------
-- audit_log — append-only, tenant-scoped.
-- ---------------------------------------------------------------------------

create table audit_log (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  occurred_at    timestamptz not null default now(),
  actor_kind     text        not null,
  actor_id       uuid,
  actor_label    text        not null,
  action         text        not null,
  resource_type  text        not null,
  resource_id    text,
  request_id     uuid,
  ip_address     inet,
  user_agent     text,
  metadata       jsonb       not null default '{}'::jsonb,

  constraint audit_log_actor_kind_known
    check (actor_kind in ('tenant_user', 'platform_user', 'system')),
  constraint audit_log_actor_id_present
    check ((actor_kind = 'system') = (actor_id is null)),
  constraint audit_log_action_not_blank check (btrim(action) <> ''),
  constraint audit_log_resource_type_not_blank check (btrim(resource_type) <> '')
);

comment on table audit_log is
  'Append-only record of consequential actions. Updates and deletes are rejected by trigger, for every role including the owner.';
comment on column audit_log.tenant_id is
  'Non-null: every audited action concerns a company. Platform events touching no tenant get their own table when P03 needs one.';
comment on column audit_log.actor_label is
  'Denormalised actor email (or the literal system). Kept verbatim so the log still reads correctly after the actor is renamed or removed.';

create index audit_log_tenant_time_idx on audit_log (tenant_id, occurred_at desc);
create index audit_log_resource_idx on audit_log (tenant_id, resource_type, resource_id);

create function reject_audit_log_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'audit_log is append-only; % is not permitted', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

-- Statement-level triggers fire even when the statement matches no rows, so
-- `delete from audit_log` fails loudly rather than silently succeeding.
create trigger audit_log_no_update
  before update on audit_log
  execute function reject_audit_log_mutation();

create trigger audit_log_no_delete
  before delete on audit_log
  execute function reject_audit_log_mutation();

create trigger audit_log_no_truncate
  before truncate on audit_log
  execute function reject_audit_log_mutation();
