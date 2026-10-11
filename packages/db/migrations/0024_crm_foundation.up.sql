-- 0024 — the CRM foundation (CRM/ERP plan, phase F1).
--
-- Three things:
--
--   * The `crm` module switch. A feature flag, off by default: Integr8 staff
--     turn it on per company. Every CRM route checks it as well as the seat's
--     permission, so hiding the menu is never the only thing in the way.
--
--   * EGP as the company currency. `tenant_settings.currency` (0018) defaulted
--     to GBP, which nobody chose. The product owner decided on 2026-10-11 that
--     every company, existing and new, uses EGP; an owner can still change it
--     on the Company settings page. CRM amounts start in this currency.
--
--   * crm_leads: prospects that are not customers yet. A lead converts once,
--     into an existing customer or exactly one new one (ADR-0002); there is no
--     CRM account or contact table beside `customers`.
--
-- Lead statuses and sources are the same lists as LEAD_STATUSES and
-- LEAD_SOURCES in @integr8/core (crm.ts); the schema-invariant suite compares
-- them.

-- ---------------------------------------------------------------------------
-- The module switch
-- ---------------------------------------------------------------------------

insert into feature_flags (key, description, default_enabled)
values (
  'crm',
  'CRM: leads, opportunities, activities and the pipeline. Off until Integr8 switches it on for a company.',
  false
)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Company currency
-- ---------------------------------------------------------------------------

alter table tenant_settings alter column currency set default 'EGP';
update tenant_settings set currency = 'EGP' where currency <> 'EGP';

-- ---------------------------------------------------------------------------
-- crm_leads
-- ---------------------------------------------------------------------------

create table crm_leads (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references tenants (id) on delete restrict,
  display_name          text          not null,
  company_name          text,
  email                 text,
  phone                 text,
  source                text          not null default 'manual',
  status                text          not null default 'new',
  assigned_to           uuid,
  estimated_value       numeric(20, 4),
  currency_code         text,
  notes                 text,
  unqualified_reason    text,
  converted_customer_id uuid,
  converted_contact_id  uuid,
  converted_at          timestamptz,
  converted_by          uuid,
  version               integer       not null default 1,
  created_by            uuid          not null,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),
  archived_at           timestamptz,
  -- For suggesting an existing customer at conversion, never for merging.
  email_normalized      text generated always as (lower(btrim(email))) stored,
  phone_digits          text generated always as (
    nullif(regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g'), '')
  ) stored,
  search                tsvector generated always as (
    to_tsvector('simple'::regconfig,
      coalesce(display_name, '') || ' ' || coalesce(company_name, '') || ' ' ||
      coalesce(email, '') || ' ' || coalesce(phone, ''))
  ) stored,

  constraint crm_leads_tenant_id_unique unique (tenant_id, id),
  constraint crm_leads_assignee_fk
    foreign key (tenant_id, assigned_to) references tenant_users (tenant_id, user_id) on delete restrict,
  constraint crm_leads_customer_fk
    foreign key (tenant_id, converted_customer_id) references customers (tenant_id, id) on delete restrict,
  -- The contact must belong to the customer the lead became.
  constraint crm_leads_contact_fk
    foreign key (tenant_id, converted_customer_id, converted_contact_id)
    references customer_contacts (tenant_id, customer_id, id) on delete restrict,

  constraint crm_leads_display_name_present
    check (btrim(display_name) <> '' and char_length(display_name) <= 200),
  constraint crm_leads_company_name_length
    check (company_name is null or char_length(company_name) <= 200),
  constraint crm_leads_email_length check (email is null or char_length(email) <= 320),
  constraint crm_leads_phone_length check (phone is null or char_length(phone) <= 50),
  constraint crm_leads_notes_length check (notes is null or char_length(notes) <= 10000),
  constraint crm_leads_unqualified_reason_length
    check (unqualified_reason is null or char_length(unqualified_reason) <= 1000),
  constraint crm_leads_source_known
    check (source in ('manual', 'referral', 'web', 'import', 'other')),
  constraint crm_leads_status_known
    check (status in ('new', 'contacted', 'qualified', 'unqualified', 'converted')),
  constraint crm_leads_value_not_negative check (estimated_value is null or estimated_value >= 0),
  constraint crm_leads_currency_shape check (currency_code is null or currency_code ~ '^[A-Z]{3}$'),
  constraint crm_leads_value_has_currency check (estimated_value is null or currency_code is not null),
  constraint crm_leads_version_positive check (version > 0),
  -- Converted exactly when it points at the customer it became, and when.
  constraint crm_leads_converted_pairing
    check ((status = 'converted') = (converted_customer_id is not null and converted_at is not null)),
  constraint crm_leads_converter_pairing
    check ((converted_at is null) = (converted_by is null))
);

comment on table crm_leads is
  'A prospect that is not a customer yet. Converts once into a customer (existing or new); archived rather than deleted.';
comment on column crm_leads.version is
  'Optimistic concurrency: an edit names the version it read, and loses to a newer one.';

create index crm_leads_status_idx on crm_leads (tenant_id, status, created_at desc, id);
create index crm_leads_assignee_idx on crm_leads (tenant_id, assigned_to, status);
create index crm_leads_email_idx on crm_leads (tenant_id, email_normalized)
  where email_normalized is not null;
create index crm_leads_phone_idx on crm_leads (tenant_id, phone_digits)
  where phone_digits is not null;
create index crm_leads_customer_idx on crm_leads (tenant_id, converted_customer_id)
  where converted_customer_id is not null;
create index crm_leads_search_idx on crm_leads using gin (search);

create trigger crm_leads_set_updated_at
  before update on crm_leads
  for each row execute function set_updated_at();

-- A converted lead is a historical record: what it became, when and by whom
-- does not change, and it does not become a prospect again. Enforced here
-- rather than trusted to the API, because the customer it became may already
-- have work against it.
create function crm_leads_guard_conversion() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if old.status = 'converted' and (
       new.status is distinct from old.status
       or new.converted_customer_id is distinct from old.converted_customer_id
       or new.converted_contact_id is distinct from old.converted_contact_id
       or new.converted_at is distinct from old.converted_at
       or new.converted_by is distinct from old.converted_by
     ) then
    raise exception 'A converted lead keeps its conversion'
      using errcode = 'check_violation', constraint = 'crm_leads_conversion_final';
  end if;
  return new;
end;
$$;

create trigger crm_leads_guard_conversion
  before update on crm_leads
  for each row execute function crm_leads_guard_conversion();

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

-- No delete: a lead is archived, so the audit log and any activity keep
-- pointing at something.
grant select, insert, update on crm_leads to integr8_app;

alter table crm_leads enable row level security;
create policy crm_leads_isolation on crm_leads
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
