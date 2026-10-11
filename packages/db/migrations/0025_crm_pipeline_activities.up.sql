-- 0025 — opportunities, the pipeline and follow-ups (CRM/ERP plan, phase C3).
--
--   * crm_pipelines and crm_pipeline_stages: each company's sales pipeline.
--     A default one with six stages is created the first time the company's
--     CRM asks for it (CrmPipelinesRepository.ensureDefault), not here: new
--     companies get it the same way as existing ones. A stage's `key` is
--     stable and never reused, so opportunities and their history keep
--     pointing at what they meant; a stage is archived, not deleted. Every
--     stage says what reaching it means: still open, won or lost.
--
--   * crm_opportunities: a deal being worked on, for a customer or a lead
--     (never neither). Its amount is an estimate in numeric(20,4) with its own
--     currency, not booked revenue; winning one creates no invoice and no job.
--     Its status always agrees with its stage's outcome (a trigger checks).
--
--   * crm_opportunity_events: append-only history of each opportunity's stage
--     and status, with who and when.
--
--   * crm_activities and three join tables: calls, emails, meetings, notes,
--     follow-ups and tasks, linked to leads, customers and opportunities
--     through explicit tables rather than a free-form "related id", so every
--     link is a real, same-company foreign key.
--
-- Vocabularies match @integr8/core (crm.ts); the schema-invariant suite
-- compares them.

-- ---------------------------------------------------------------------------
-- crm_pipelines
-- ---------------------------------------------------------------------------

create table crm_pipelines (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants (id) on delete restrict,
  name        text        not null,
  is_default  boolean     not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,

  constraint crm_pipelines_tenant_id_unique unique (tenant_id, id),
  constraint crm_pipelines_name_present check (btrim(name) <> '' and char_length(name) <= 100),
  constraint crm_pipelines_default_is_current check (not (is_default and archived_at is not null))
);

comment on table crm_pipelines is
  'A company''s sales pipeline. The default one is created on first use, with six stages.';

-- One default per company; creating it twice at once leaves one.
create unique index crm_pipelines_one_default on crm_pipelines (tenant_id) where is_default;
create unique index crm_pipelines_name_unique on crm_pipelines (tenant_id, lower(name));

create trigger crm_pipelines_set_updated_at
  before update on crm_pipelines
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- crm_pipeline_stages
-- ---------------------------------------------------------------------------

create table crm_pipeline_stages (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  pipeline_id    uuid        not null,
  -- Stable: what the stage means, for translations and reports. Never reused.
  key            text        not null,
  -- The company's own name for it; screens translate the built-in keys.
  label          text        not null,
  position       integer     not null,
  -- The usual chance of winning from here, in basis points (0–10000).
  probability_bp integer     not null,
  outcome        text        not null,
  created_at     timestamptz not null default now(),
  archived_at    timestamptz,

  constraint crm_pipeline_stages_tenant_id_unique unique (tenant_id, id),
  -- What an opportunity references, so its stage is in its own pipeline.
  constraint crm_pipeline_stages_pipeline_id_unique unique (tenant_id, pipeline_id, id),
  constraint crm_pipeline_stages_key_unique unique (tenant_id, pipeline_id, key),
  constraint crm_pipeline_stages_position_unique unique (tenant_id, pipeline_id, position),
  constraint crm_pipeline_stages_pipeline_fk
    foreign key (tenant_id, pipeline_id) references crm_pipelines (tenant_id, id) on delete restrict,
  constraint crm_pipeline_stages_key_shape check (key ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint crm_pipeline_stages_label_present
    check (btrim(label) <> '' and char_length(label) <= 100),
  constraint crm_pipeline_stages_position_positive check (position > 0),
  constraint crm_pipeline_stages_probability_range check (probability_bp between 0 and 10000),
  constraint crm_pipeline_stages_outcome_known check (outcome in ('open', 'won', 'lost'))
);

comment on column crm_pipeline_stages.outcome is
  'What reaching this stage means for an opportunity: still open, won or lost.';

-- ---------------------------------------------------------------------------
-- crm_opportunities
-- ---------------------------------------------------------------------------

create table crm_opportunities (
  id                  uuid          primary key default gen_random_uuid(),
  tenant_id           uuid          not null references tenants (id) on delete restrict,
  title               text          not null,
  customer_id         uuid,
  lead_id             uuid,
  pipeline_id         uuid          not null,
  stage_id            uuid          not null,
  owner_id            uuid,
  -- An estimate, not booked revenue.
  amount              numeric(20, 4),
  currency_code       text          not null,
  expected_close_date date,
  probability_bp      integer       not null,
  status              text          not null default 'open',
  lost_reason         text,
  description         text,
  closed_at           timestamptz,
  version             integer       not null default 1,
  created_by          uuid          not null,
  created_at          timestamptz   not null default now(),
  updated_at          timestamptz   not null default now(),
  archived_at         timestamptz,
  search              tsvector generated always as (
    to_tsvector('simple'::regconfig, coalesce(title, '') || ' ' || coalesce(description, ''))
  ) stored,

  constraint crm_opportunities_tenant_id_unique unique (tenant_id, id),
  constraint crm_opportunities_customer_fk
    foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete restrict,
  constraint crm_opportunities_lead_fk
    foreign key (tenant_id, lead_id) references crm_leads (tenant_id, id) on delete restrict,
  constraint crm_opportunities_stage_fk
    foreign key (tenant_id, pipeline_id, stage_id)
    references crm_pipeline_stages (tenant_id, pipeline_id, id) on delete restrict,
  constraint crm_opportunities_owner_fk
    foreign key (tenant_id, owner_id) references tenant_users (tenant_id, user_id) on delete restrict,

  -- Never detached: it is for a customer, a lead, or both.
  constraint crm_opportunities_has_party check (customer_id is not null or lead_id is not null),
  constraint crm_opportunities_title_present
    check (btrim(title) <> '' and char_length(title) <= 200),
  constraint crm_opportunities_description_length
    check (description is null or char_length(description) <= 10000),
  constraint crm_opportunities_amount_not_negative check (amount is null or amount >= 0),
  constraint crm_opportunities_currency_shape check (currency_code ~ '^[A-Z]{3}$'),
  constraint crm_opportunities_probability_range check (probability_bp between 0 and 10000),
  constraint crm_opportunities_status_known check (status in ('open', 'won', 'lost')),
  constraint crm_opportunities_closed_pairing check ((status = 'open') = (closed_at is null)),
  constraint crm_opportunities_lost_reason
    check (lost_reason is null or (status = 'lost' and char_length(lost_reason) <= 1000)),
  constraint crm_opportunities_version_positive check (version > 0)
);

comment on table crm_opportunities is
  'A deal being worked on. Its amount is an estimate, not revenue; winning it creates nothing by itself.';

create index crm_opportunities_list_idx on crm_opportunities (tenant_id, created_at desc, id);
create index crm_opportunities_stage_idx on crm_opportunities (tenant_id, stage_id, status);
create index crm_opportunities_owner_idx on crm_opportunities (tenant_id, owner_id, status);
create index crm_opportunities_customer_idx on crm_opportunities (tenant_id, customer_id)
  where customer_id is not null;
create index crm_opportunities_lead_idx on crm_opportunities (tenant_id, lead_id)
  where lead_id is not null;
create index crm_opportunities_close_idx on crm_opportunities (tenant_id, expected_close_date)
  where status = 'open';
create index crm_opportunities_search_idx on crm_opportunities using gin (search);

create trigger crm_opportunities_set_updated_at
  before update on crm_opportunities
  for each row execute function set_updated_at();

-- An opportunity's status is its stage's outcome. Checked here, where no
-- client can get it wrong, rather than trusted to every caller.
create function crm_opportunities_check_stage() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  stage_outcome text;
begin
  select outcome into stage_outcome
  from crm_pipeline_stages
  where tenant_id = new.tenant_id and pipeline_id = new.pipeline_id and id = new.stage_id;
  -- Runs before the foreign key, so say what the foreign key would have said.
  if not found then
    raise exception 'The stage is not one of this pipeline''s stages'
      using errcode = 'foreign_key_violation', constraint = 'crm_opportunities_stage_fk';
  end if;
  if stage_outcome is distinct from new.status then
    raise exception 'An opportunity''s status must be its stage''s outcome'
      using errcode = 'check_violation', constraint = 'crm_opportunities_status_matches_stage';
  end if;
  return new;
end;
$$;

create trigger crm_opportunities_check_stage
  before insert or update of stage_id, pipeline_id, status on crm_opportunities
  for each row execute function crm_opportunities_check_stage();

-- ---------------------------------------------------------------------------
-- crm_opportunity_events
-- ---------------------------------------------------------------------------

create table crm_opportunity_events (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  opportunity_id uuid        not null,
  kind           text        not null,
  from_stage_id  uuid,
  to_stage_id    uuid,
  from_status    text,
  to_status      text,
  reason         text,
  actor_id       uuid        not null,
  occurred_at    timestamptz not null default now(),

  constraint crm_opportunity_events_opportunity_fk
    foreign key (tenant_id, opportunity_id) references crm_opportunities (tenant_id, id) on delete restrict,
  constraint crm_opportunity_events_from_stage_fk
    foreign key (tenant_id, from_stage_id) references crm_pipeline_stages (tenant_id, id) on delete restrict,
  constraint crm_opportunity_events_to_stage_fk
    foreign key (tenant_id, to_stage_id) references crm_pipeline_stages (tenant_id, id) on delete restrict,
  constraint crm_opportunity_events_kind_known
    check (kind in ('created', 'stage_changed', 'won', 'lost', 'reopened')),
  constraint crm_opportunity_events_from_status_known
    check (from_status is null or from_status in ('open', 'won', 'lost')),
  constraint crm_opportunity_events_to_status_known
    check (to_status is null or to_status in ('open', 'won', 'lost')),
  constraint crm_opportunity_events_reason_length check (reason is null or char_length(reason) <= 1000)
);

create index crm_opportunity_events_opportunity_idx
  on crm_opportunity_events (tenant_id, opportunity_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- crm_activities and their links
-- ---------------------------------------------------------------------------

create table crm_activities (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants (id) on delete restrict,
  kind         text        not null,
  subject      text        not null,
  detail       text,
  outcome      text,
  status       text        not null default 'open',
  assigned_to  uuid,
  due_at       timestamptz,
  completed_at timestamptz,
  completed_by uuid,
  version      integer     not null default 1,
  created_by   uuid        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint crm_activities_tenant_id_unique unique (tenant_id, id),
  constraint crm_activities_assignee_fk
    foreign key (tenant_id, assigned_to) references tenant_users (tenant_id, user_id) on delete restrict,
  constraint crm_activities_kind_known
    check (kind in ('call', 'email', 'meeting', 'note', 'follow_up', 'task')),
  constraint crm_activities_status_known check (status in ('open', 'done', 'cancelled')),
  constraint crm_activities_subject_present
    check (btrim(subject) <> '' and char_length(subject) <= 200),
  constraint crm_activities_detail_length check (detail is null or char_length(detail) <= 10000),
  constraint crm_activities_outcome_length check (outcome is null or char_length(outcome) <= 2000),
  -- Done exactly when it says when, and by whom.
  constraint crm_activities_done_pairing
    check ((status = 'done') = (completed_at is not null and completed_by is not null)),
  constraint crm_activities_version_positive check (version > 0)
);

comment on table crm_activities is
  'Calls, emails, meetings, notes, follow-ups and tasks, linked to leads, customers and opportunities through join tables.';

create index crm_activities_due_idx on crm_activities (tenant_id, status, due_at, id);
create index crm_activities_assignee_idx on crm_activities (tenant_id, assigned_to, status, due_at);
create index crm_activities_recent_idx on crm_activities (tenant_id, created_at desc, id);

create trigger crm_activities_set_updated_at
  before update on crm_activities
  for each row execute function set_updated_at();

create table crm_activity_leads (
  tenant_id   uuid not null references tenants (id) on delete restrict,
  activity_id uuid not null,
  lead_id     uuid not null,
  primary key (tenant_id, activity_id, lead_id),
  constraint crm_activity_leads_activity_fk
    foreign key (tenant_id, activity_id) references crm_activities (tenant_id, id) on delete restrict,
  constraint crm_activity_leads_lead_fk
    foreign key (tenant_id, lead_id) references crm_leads (tenant_id, id) on delete restrict
);
create index crm_activity_leads_lead_idx on crm_activity_leads (tenant_id, lead_id);

create table crm_activity_customers (
  tenant_id   uuid not null references tenants (id) on delete restrict,
  activity_id uuid not null,
  customer_id uuid not null,
  primary key (tenant_id, activity_id, customer_id),
  constraint crm_activity_customers_activity_fk
    foreign key (tenant_id, activity_id) references crm_activities (tenant_id, id) on delete restrict,
  constraint crm_activity_customers_customer_fk
    foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete restrict
);
create index crm_activity_customers_customer_idx on crm_activity_customers (tenant_id, customer_id);

create table crm_activity_opportunities (
  tenant_id      uuid not null references tenants (id) on delete restrict,
  activity_id    uuid not null,
  opportunity_id uuid not null,
  primary key (tenant_id, activity_id, opportunity_id),
  constraint crm_activity_opportunities_activity_fk
    foreign key (tenant_id, activity_id) references crm_activities (tenant_id, id) on delete restrict,
  constraint crm_activity_opportunities_opportunity_fk
    foreign key (tenant_id, opportunity_id) references crm_opportunities (tenant_id, id) on delete restrict
);
create index crm_activity_opportunities_opportunity_idx
  on crm_activity_opportunities (tenant_id, opportunity_id);

-- ---------------------------------------------------------------------------
-- Access
-- ---------------------------------------------------------------------------

-- Nothing is deleted: stages and pipelines are archived, history is appended,
-- links are made once.
grant select, insert, update on crm_pipelines, crm_pipeline_stages, crm_opportunities, crm_activities
  to integr8_app;
grant select, insert
  on crm_opportunity_events, crm_activity_leads, crm_activity_customers, crm_activity_opportunities
  to integr8_app;

alter table crm_pipelines enable row level security;
create policy crm_pipelines_isolation on crm_pipelines
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table crm_pipeline_stages enable row level security;
create policy crm_pipeline_stages_isolation on crm_pipeline_stages
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table crm_opportunities enable row level security;
create policy crm_opportunities_isolation on crm_opportunities
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table crm_opportunity_events enable row level security;
create policy crm_opportunity_events_isolation on crm_opportunity_events
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table crm_activities enable row level security;
create policy crm_activities_isolation on crm_activities
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table crm_activity_leads enable row level security;
create policy crm_activity_leads_isolation on crm_activity_leads
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table crm_activity_customers enable row level security;
create policy crm_activity_customers_isolation on crm_activity_customers
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table crm_activity_opportunities enable row level security;
create policy crm_activity_opportunities_isolation on crm_activity_opportunities
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
