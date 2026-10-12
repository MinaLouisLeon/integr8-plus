-- Seventh round (ADR-0010, ADR-0011): two new roles, grants on top of a role,
-- the hr, payroll and manufacturing switches, and employee profiles.
--
-- Roles: `hr_manager` keeps HR and payroll, `inventory_manager` keeps the
-- store, purchasing and manufacturing; both rank between admin and
-- dispatcher. The same two capabilities can be granted on top of any role
-- (`member_grants`). Who may give which is the API's (the HR one is the
-- owner's alone); the database keeps the vocabulary.
--
-- Employee profiles link to a member or stand alone for someone who never
-- signs in. National ID, social insurance number and bank account arrive
-- already encrypted by the API (AES-256-GCM under HR_DATA_KEY, bound to the
-- company, the employee and the field); the database keeps only ciphertext
-- and the last four characters.

-- ---------------------------------------------------------------------------
-- Switches
-- ---------------------------------------------------------------------------

insert into feature_flags (key, description, default_enabled)
values
  ('hr',
   'HR: employee profiles and staff expense claims. Off until Integr8 switches it on for a company.',
   false),
  ('payroll',
   'Payroll: Egyptian pay runs from rule sets the company confirms, payslips and reports. Needs HR. No legal review by Integr8. Off until Integr8 switches it on for a company.',
   false),
  ('manufacturing',
   'Manufacturing: bills of materials, assembly and disassembly, and material planning. Needs inventory. Off until Integr8 switches it on for a company.',
   false);

-- ---------------------------------------------------------------------------
-- Roles
-- ---------------------------------------------------------------------------

-- Mirrors ROLES in @integr8/core, most privileged first. The schema-invariant
-- suite fails if the two drift apart.
alter table tenant_users drop constraint tenant_users_role_known;
alter table tenant_users add constraint tenant_users_role_known
  check (role in ('owner', 'admin', 'hr_manager', 'inventory_manager', 'dispatcher', 'engineer', 'viewer'));

alter table invitations drop constraint invitations_role_known;
alter table invitations add constraint invitations_role_known
  check (role in ('owner', 'admin', 'hr_manager', 'inventory_manager', 'dispatcher', 'engineer', 'viewer'));

-- Existing forms keep the fill roles they have; a form may now name the new ones.
alter table forms drop constraint forms_fill_roles_known;
alter table forms add constraint forms_fill_roles_known
  check (fill_roles <@ array['owner', 'admin', 'hr_manager', 'inventory_manager', 'dispatcher', 'engineer', 'viewer']);

-- ---------------------------------------------------------------------------
-- Grants on top of a role
-- ---------------------------------------------------------------------------

create table member_grants (
  tenant_id   uuid        not null references tenants (id) on delete cascade,
  user_id     uuid        not null,
  capability  text        not null,
  granted_by  uuid        not null,
  granted_at  timestamptz not null default now(),
  constraint member_grants_pkey primary key (tenant_id, user_id, capability),
  constraint member_grants_member_fk
    foreign key (tenant_id, user_id) references tenant_users (tenant_id, user_id) on delete cascade,
  -- Mirrors GRANTS in @integr8/core.
  constraint member_grants_capability_known check (capability in ('hr_manager', 'inventory_manager'))
);
comment on table member_grants is
  'Capabilities a member holds on top of their role (ADR-0010). Read when an access token is minted.';

-- ---------------------------------------------------------------------------
-- Employee profiles
-- ---------------------------------------------------------------------------

create table hr_employees (
  id                       uuid        primary key default gen_random_uuid(),
  tenant_id                uuid        not null references tenants (id) on delete restrict,
  -- The member this person signs in as; null for someone who never does.
  user_id                  uuid,
  employee_number          text,
  full_name                text        not null,
  job_title                text,
  department               text,
  phone                    text,
  hire_date                date        not null,
  end_date                 date,
  end_reason               text,
  national_id_sealed       text,
  national_id_last4        text,
  insurance_number_sealed  text,
  insurance_number_last4   text,
  bank_name                text,
  bank_account_sealed      text,
  bank_account_last4       text,
  emergency_contact_name   text,
  emergency_contact_phone  text,
  version                  integer     not null default 1,
  created_by               uuid        not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint hr_employees_tenant_id_unique unique (tenant_id, id),
  constraint hr_employees_member_fk
    foreign key (tenant_id, user_id) references tenant_users (tenant_id, user_id),
  constraint hr_employees_name_present check (btrim(full_name) <> '' and char_length(full_name) <= 200),
  constraint hr_employees_text_lengths check (
    (employee_number is null or (btrim(employee_number) <> '' and char_length(employee_number) <= 40))
    and (job_title is null or char_length(job_title) <= 200)
    and (department is null or char_length(department) <= 200)
    and (phone is null or char_length(phone) <= 40)
    and (end_reason is null or char_length(end_reason) <= 1000)
    and (bank_name is null or char_length(bank_name) <= 200)
    and (emergency_contact_name is null or char_length(emergency_contact_name) <= 200)
    and (emergency_contact_phone is null or char_length(emergency_contact_phone) <= 40)),
  constraint hr_employees_end_after_hire check (end_date is null or end_date >= hire_date),
  constraint hr_employees_end_pairing check ((end_date is null) = (end_reason is null)),
  -- Ciphertext only, and its last four in clear, together or not at all.
  constraint hr_employees_sealed_shape check (
    (national_id_sealed is null or national_id_sealed ~ '^hr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
    and (insurance_number_sealed is null or insurance_number_sealed ~ '^hr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')
    and (bank_account_sealed is null or bank_account_sealed ~ '^hr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$')),
  constraint hr_employees_sealed_pairing check (
    (national_id_sealed is null) = (national_id_last4 is null)
    and (insurance_number_sealed is null) = (insurance_number_last4 is null)
    and (bank_account_sealed is null) = (bank_account_last4 is null)),
  constraint hr_employees_last4_shape check (
    (national_id_last4 is null or char_length(national_id_last4) between 1 and 4)
    and (insurance_number_last4 is null or char_length(insurance_number_last4) between 1 and 4)
    and (bank_account_last4 is null or char_length(bank_account_last4) between 1 and 4)),
  constraint hr_employees_version_positive check (version > 0)
);
-- One profile per member; employee numbers unique per company, ignoring case.
create unique index hr_employees_member_unique on hr_employees (tenant_id, user_id)
  where user_id is not null;
create unique index hr_employees_number_unique on hr_employees (tenant_id, lower(employee_number))
  where employee_number is not null;
create trigger hr_employees_set_updated_at
  before update on hr_employees
  for each row execute function set_updated_at();
comment on table hr_employees is
  'Employee profiles (ADR-0010): linked to a member or standing alone. Sensitive numbers are AES-256-GCM ciphertext written by the API.';

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------

grant select, insert, delete on member_grants to integr8_app;
-- A profile is ended, never deleted.
grant select, insert, update on hr_employees to integr8_app;

alter table member_grants enable row level security;
create policy member_grants_isolation on member_grants
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table hr_employees enable row level security;
create policy hr_employees_isolation on hr_employees
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
