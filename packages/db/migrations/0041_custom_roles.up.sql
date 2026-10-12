-- Ninth round (ADR-0013): the company's own roles.
--
-- A custom role starts from a built-in role (any but the owner) and adds or
-- takes away permissions. A member holds one role: `tenant_users.role` stays
-- the base, so everything that ranks or reads a role keeps working, and
-- `custom_role_id` names the company's role on top. Which permissions a role
-- may add, who defines roles and who gives them out are the API's; the
-- database keeps the base and the member's role in step.

create table tenant_roles (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants (id) on delete cascade,
  name         text        not null,
  description  text,
  base_role    text        not null,
  -- Permission names, as in @integr8/core; checked by the API.
  added        text[]      not null default '{}',
  removed      text[]      not null default '{}',
  version      integer     not null default 1,
  created_by   uuid        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  archived_at  timestamptz,
  constraint tenant_roles_tenant_id_unique unique (tenant_id, id),
  constraint tenant_roles_name_present check (btrim(name) <> '' and char_length(name) <= 60),
  constraint tenant_roles_description_length check (description is null or char_length(description) <= 500),
  -- Mirrors ROLES in @integr8/core, less the owner.
  constraint tenant_roles_base_known check (base_role in (
    'admin', 'hr_manager', 'inventory_manager', 'dispatcher', 'engineer', 'viewer')),
  constraint tenant_roles_lists_sane check (
    cardinality(added) <= 200 and cardinality(removed) <= 200 and not (added && removed)),
  constraint tenant_roles_version_positive check (version > 0)
);
create unique index tenant_roles_name_unique on tenant_roles (tenant_id, lower(btrim(name)))
  where archived_at is null;
create trigger tenant_roles_set_updated_at
  before update on tenant_roles
  for each row execute function set_updated_at();
comment on table tenant_roles is
  'A company''s own roles (ADR-0013): a built-in base and the permissions added to or taken from it. Read when an access token is minted.';

-- A role's base never changes: members holding it rank as that base.
create function tenant_roles_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if new.base_role is distinct from old.base_role then
    raise exception 'A role keeps the base it was built on'
      using errcode = 'check_violation', constraint = 'tenant_roles_base_fixed';
  end if;
  if new.archived_at is not null and old.archived_at is null and exists (
    select 1 from tenant_users u where u.tenant_id = new.tenant_id and u.custom_role_id = new.id
  ) then
    raise exception 'A role somebody holds is not archived'
      using errcode = 'check_violation', constraint = 'tenant_roles_in_use';
  end if;
  return new;
end;
$$;
create trigger tenant_roles_guard
  before update on tenant_roles
  for each row execute function tenant_roles_guard();

alter table tenant_users
  add column custom_role_id uuid,
  add constraint tenant_users_custom_role_fk
    foreign key (tenant_id, custom_role_id) references tenant_roles (tenant_id, id) on delete restrict;
create index tenant_users_custom_role_idx on tenant_users (tenant_id, custom_role_id)
  where custom_role_id is not null;

-- A member's role is their custom role's base, and never the owner's.
create function tenant_users_custom_role_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  base text;
begin
  if new.custom_role_id is null then
    return new;
  end if;
  select r.base_role into base
    from tenant_roles r
   where r.tenant_id = new.tenant_id and r.id = new.custom_role_id and r.archived_at is null;
  if base is null then
    raise exception 'The role does not exist or is archived'
      using errcode = 'check_violation', constraint = 'tenant_users_custom_role_usable';
  end if;
  if new.role is distinct from base then
    raise exception 'A member''s role is their custom role''s base'
      using errcode = 'check_violation', constraint = 'tenant_users_custom_role_base';
  end if;
  return new;
end;
$$;
create trigger tenant_users_custom_role_guard
  before insert or update of role, custom_role_id on tenant_users
  for each row execute function tenant_users_custom_role_guard();

grant select, insert, update on tenant_roles to integr8_app;

alter table tenant_roles enable row level security;
create policy tenant_roles_isolation on tenant_roles
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
