-- P27: maintenance plans, service contracts and response deadlines.
--
--   service_contracts            what a customer has agreed to, numbered CT-000001
--   service_contract_sites       the sites it covers, when not all of them
--   service_contract_assets      the assets it covers, when not all of them
--   service_contract_job_types   the job types it covers, when not all of them
--   maintenance_plans            recurring servicing of one asset
--   maintenance_occurrences      each due date a plan produced, and its job
--   work_order_coverage          whether a job is covered by a contract, and why not
--   deadline_rules               the company's response and completion times per priority
--   work_order_deadlines         one job's deadlines, and when they were met or missed
--
-- A plan creates its jobs ahead of time, unplanned, from the worker. The due
-- dates are counted in the API (packages/core), in the company's time zone;
-- here they are only stored. maintenance_occurrences is unique per plan and due
-- date, so a second run of the worker cannot create a second job.
--
-- Coverage and deadlines are worked out by the API when a job is created. What
-- this file enforces is what must hold for every client: a deadline is met by
-- the job's own state changes, whoever makes them, and a miss is written into
-- the job's history, which only triggers can write.

-- ---------------------------------------------------------------------------
-- Contracts
-- ---------------------------------------------------------------------------

create table service_contract_counters (
  tenant_id       uuid    primary key references tenants (id) on delete restrict,
  last_reference  integer not null
);
comment on table service_contract_counters is
  'The last contract number handed out per company. Written only by assign_service_contract_reference.';

create table service_contracts (
  id                    uuid          primary key default gen_random_uuid(),
  tenant_id             uuid          not null references tenants (id) on delete restrict,
  -- Per company, from 1, shown as CT-000001. Assigned by trigger.
  reference             integer       not null default 0,
  customer_id           uuid          not null,
  title                 text          not null,
  starts_on             date          not null,
  -- The last day it covers.
  ends_on               date          not null,
  -- What the customer pays for the term, in the company's currency. For information only.
  value                 numeric(14,2),
  notes                 text,
  renewal_notice_days   integer       not null default 60,
  -- Empty coverage lists mean everything of that kind.
  all_sites             boolean       not null default true,
  all_assets            boolean       not null default true,
  all_job_types         boolean       not null default true,
  -- Call-outs (jobs not from a maintenance plan) included per contract year. Null: no limit.
  included_callouts     integer,
  -- The contract this one renews. A contract is renewed at most once.
  renewed_from_id       uuid,
  -- Cancelling ends coverage from this day.
  cancelled_on          date,
  cancelled_at          timestamptz,
  cancelled_by          uuid,
  cancel_reason         text,
  -- When the renewal reminders went out, so each goes once. Cleared when the end date changes.
  renewal_warned_at     timestamptz,
  end_alerted_at        timestamptz,
  version               integer       not null default 1,
  created_by            uuid          not null,
  created_at            timestamptz   not null default now(),
  updated_at            timestamptz   not null default now(),

  constraint service_contracts_tenant_id_unique unique (tenant_id, id),
  constraint service_contracts_tenant_customer_id_unique unique (tenant_id, customer_id, id),
  constraint service_contracts_customer_fk
    foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete restrict,
  constraint service_contracts_renewed_from_fk
    foreign key (tenant_id, renewed_from_id) references service_contracts (tenant_id, id) on delete restrict,
  constraint service_contracts_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint service_contracts_notes_length check (notes is null or char_length(notes) <= 4000),
  constraint service_contracts_dates_ordered check (ends_on >= starts_on),
  constraint service_contracts_value_positive check (value is null or value >= 0),
  constraint service_contracts_notice_range check (renewal_notice_days between 0 and 365),
  constraint service_contracts_callouts_range check (included_callouts is null or included_callouts between 0 and 10000),
  constraint service_contracts_cancel_complete check (
    (cancelled_at is null) = (cancelled_by is null)
    and (cancelled_at is null) = (cancelled_on is null)
    and (cancelled_at is null) = (cancel_reason is null)),
  constraint service_contracts_cancel_reason_length
    check (cancel_reason is null or char_length(btrim(cancel_reason)) between 1 and 500)
);

comment on table service_contracts is
  'A customer''s service agreement: its term and what it covers. Cancelled rather than deleted; renewed by a new contract that names this one.';

create unique index service_contracts_reference_unique
  on service_contracts (tenant_id, reference);
create unique index service_contracts_renewed_once
  on service_contracts (tenant_id, renewed_from_id) where renewed_from_id is not null;
create index service_contracts_customer_idx
  on service_contracts (tenant_id, customer_id, starts_on);
create index service_contracts_ends_idx
  on service_contracts (tenant_id, ends_on) where cancelled_at is null;

create trigger service_contracts_set_updated_at
  before update on service_contracts
  for each row execute function set_updated_at();

create function assign_service_contract_reference() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
begin
  insert into public.service_contract_counters as counter (tenant_id, last_reference)
  values (new.tenant_id, 1)
  on conflict (tenant_id) do update set last_reference = counter.last_reference + 1
  returning last_reference into new.reference;
  return new;
end;
$$;
comment on function assign_service_contract_reference() is
  'Numbers a contract when it is created. Security definer: the runtime role cannot write the counter.';

create trigger service_contracts_assign_reference
  before insert on service_contracts
  for each row execute function assign_service_contract_reference();

create function guard_service_contract() returns trigger
language plpgsql
as $$
begin
  if new.reference is distinct from old.reference
     or new.customer_id is distinct from old.customer_id
     or new.renewed_from_id is distinct from old.renewed_from_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'contract % keeps its number, customer, predecessor and creator', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if old.cancelled_at is not null then
    raise exception 'contract % was cancelled', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- A new end date: the reminders are about a different day now.
  if new.ends_on is distinct from old.ends_on or new.renewal_notice_days is distinct from old.renewal_notice_days then
    new.renewal_warned_at := null;
    new.end_alerted_at := null;
  end if;
  -- The worker noting a reminder is not an edit: whoever has the contract open
  -- can still save it.
  if (to_jsonb(new) - 'renewal_warned_at' - 'end_alerted_at' - 'updated_at' - 'version')
     is distinct from (to_jsonb(old) - 'renewal_warned_at' - 'end_alerted_at' - 'updated_at' - 'version') then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

comment on function guard_service_contract() is
  'Keeps a contract''s number, customer and predecessor, refuses changing a cancelled one, resets the renewal reminders when the end date changes, and counts versions of edits.';

create trigger service_contracts_guard
  before update on service_contracts
  for each row execute function guard_service_contract();

create table service_contract_sites (
  tenant_id     uuid        not null references tenants (id) on delete restrict,
  contract_id   uuid        not null,
  customer_id   uuid        not null,
  site_id       uuid        not null,
  created_at    timestamptz not null default now(),

  primary key (tenant_id, contract_id, site_id),
  constraint service_contract_sites_contract_fk
    foreign key (tenant_id, customer_id, contract_id)
    references service_contracts (tenant_id, customer_id, id) on delete cascade,
  -- The site must be the contract's customer's.
  constraint service_contract_sites_site_fk
    foreign key (tenant_id, customer_id, site_id) references sites (tenant_id, customer_id, id) on delete restrict
);
comment on table service_contract_sites is
  'The sites a contract covers, when it does not cover all of its customer''s sites.';

create table service_contract_assets (
  tenant_id     uuid        not null references tenants (id) on delete restrict,
  contract_id   uuid        not null,
  asset_id      uuid        not null,
  created_at    timestamptz not null default now(),

  primary key (tenant_id, contract_id, asset_id),
  constraint service_contract_assets_contract_fk
    foreign key (tenant_id, contract_id) references service_contracts (tenant_id, id) on delete cascade,
  constraint service_contract_assets_asset_fk
    foreign key (tenant_id, asset_id) references erp_assets (tenant_id, id) on delete restrict
);
comment on table service_contract_assets is
  'The assets a contract covers, when it does not cover all assets at its sites.';

create index service_contract_assets_asset_idx on service_contract_assets (tenant_id, asset_id);

create table service_contract_job_types (
  tenant_id     uuid        not null references tenants (id) on delete restrict,
  contract_id   uuid        not null,
  job_type_id   uuid        not null,
  created_at    timestamptz not null default now(),

  primary key (tenant_id, contract_id, job_type_id),
  constraint service_contract_job_types_contract_fk
    foreign key (tenant_id, contract_id) references service_contracts (tenant_id, id) on delete cascade,
  constraint service_contract_job_types_job_type_fk
    foreign key (tenant_id, job_type_id) references job_types (tenant_id, id) on delete restrict
);
comment on table service_contract_job_types is
  'The job types a contract covers, when it does not cover them all.';

-- ---------------------------------------------------------------------------
-- Maintenance plans
-- ---------------------------------------------------------------------------

create table maintenance_plans (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references tenants (id) on delete restrict,
  asset_id            uuid        not null,
  job_type_id         uuid        not null,
  contract_id         uuid,
  title               text        not null,
  instructions        text,
  interval_count      integer     not null,
  interval_unit       text        not null,
  -- 'calendar': every interval from the start date, whatever happened.
  -- 'completion': one interval after the previous job was completed.
  counting            text        not null,
  starts_on           date        not null,
  -- The last day a job can be due. Null: no end.
  ends_on             date,
  -- The job's due window around each due date, in days.
  window_before_days  integer     not null default 7,
  window_after_days   integer     not null default 7,
  -- How many days before the due date the job is created.
  lead_days           integer     not null default 30,
  -- Whether its jobs may be combined with other plans' at the same site.
  can_share           boolean     not null default true,
  status              text        not null default 'active',
  -- The next due date with no job yet. Null for a 'completion' plan whose
  -- last job is still open: the next date depends on when it is completed.
  next_due_on         date,
  -- For a 'calendar' plan, which interval next_due_on is (0 is the start date),
  -- so a month that has no 31st does not shift every later date.
  next_sequence       integer     not null default 0,
  version             integer     not null default 1,
  created_by          uuid        not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  ended_at            timestamptz,
  ended_by            uuid,

  constraint maintenance_plans_tenant_id_unique unique (tenant_id, id),
  constraint maintenance_plans_asset_fk
    foreign key (tenant_id, asset_id) references erp_assets (tenant_id, id) on delete restrict,
  constraint maintenance_plans_job_type_fk
    foreign key (tenant_id, job_type_id) references job_types (tenant_id, id) on delete restrict,
  constraint maintenance_plans_contract_fk
    foreign key (tenant_id, contract_id) references service_contracts (tenant_id, id) on delete restrict,
  constraint maintenance_plans_title_length check (char_length(btrim(title)) between 1 and 200),
  constraint maintenance_plans_instructions_length
    check (instructions is null or char_length(instructions) <= 10000),
  constraint maintenance_plans_interval_range check (interval_count between 1 and 120),
  constraint maintenance_plans_interval_unit_known check (interval_unit in ('day', 'week', 'month', 'year')),
  constraint maintenance_plans_counting_known check (counting in ('calendar', 'completion')),
  constraint maintenance_plans_dates_ordered check (ends_on is null or ends_on >= starts_on),
  constraint maintenance_plans_window_range
    check (window_before_days between 0 and 365 and window_after_days between 0 and 365),
  constraint maintenance_plans_lead_range check (lead_days between 0 and 365),
  constraint maintenance_plans_status_known check (status in ('active', 'paused', 'ended')),
  constraint maintenance_plans_sequence_positive check (next_sequence >= 0),
  constraint maintenance_plans_ended_complete check (
    (status = 'ended') = (ended_at is not null) and (ended_at is null) = (ended_by is null))
);

comment on table maintenance_plans is
  'Recurring servicing of one asset. The worker creates each job ahead of its due date. Ended rather than deleted.';

create index maintenance_plans_asset_idx on maintenance_plans (tenant_id, asset_id);
create index maintenance_plans_due_idx
  on maintenance_plans (tenant_id, next_due_on) where status = 'active';
create index maintenance_plans_contract_idx
  on maintenance_plans (tenant_id, contract_id) where contract_id is not null;

create trigger maintenance_plans_set_updated_at
  before update on maintenance_plans
  for each row execute function set_updated_at();

create function guard_maintenance_plan() returns trigger
language plpgsql
as $$
begin
  if new.asset_id is distinct from old.asset_id
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'maintenance plan % keeps its asset and creator', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  if old.status = 'ended' then
    raise exception 'maintenance plan % has ended; add a new one instead', old.id
      using errcode = 'object_not_in_prerequisite_state';
  end if;
  -- The worker moving the next due date along is not an edit: whoever has the
  -- plan open can still save it.
  if (to_jsonb(new) - 'next_due_on' - 'next_sequence' - 'updated_at' - 'version')
     is distinct from (to_jsonb(old) - 'next_due_on' - 'next_sequence' - 'updated_at' - 'version') then
    new.version := old.version + 1;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

comment on function guard_maintenance_plan() is
  'Keeps a plan''s asset, refuses changing an ended plan, and counts versions.';

create trigger maintenance_plans_guard
  before update on maintenance_plans
  for each row execute function guard_maintenance_plan();

create table maintenance_occurrences (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  plan_id        uuid        not null,
  due_on         date        not null,
  -- Several plans' occurrences can share one job.
  work_order_id  uuid,
  -- 'created': a job was made for it. 'skipped': the worker passed over it,
  -- for the reason given (the asset was retired, the contract had ended).
  status         text        not null,
  skip_reason    text,
  created_at     timestamptz not null default now(),

  constraint maintenance_occurrences_plan_fk
    foreign key (tenant_id, plan_id) references maintenance_plans (tenant_id, id) on delete restrict,
  constraint maintenance_occurrences_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict,
  constraint maintenance_occurrences_status_known check (status in ('created', 'skipped')),
  constraint maintenance_occurrences_status_shape check (
    (status = 'created') = (work_order_id is not null)
    and (status = 'skipped') = (skip_reason is not null)),
  constraint maintenance_occurrences_skip_reason_known
    check (skip_reason is null or skip_reason in ('asset_retired', 'contract_ended', 'plan_ended'))
);

comment on table maintenance_occurrences is
  'Each due date a maintenance plan produced: the job made for it, or why none was. One per plan and date, so the worker never makes two. Append-only.';

create unique index maintenance_occurrences_plan_due_unique
  on maintenance_occurrences (tenant_id, plan_id, due_on);
create index maintenance_occurrences_work_order_idx
  on maintenance_occurrences (tenant_id, work_order_id) where work_order_id is not null;

create function reject_maintenance_occurrence_mutation() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' and current_setting('integr8.purging', true) = old.tenant_id::text then
    return old;
  end if;
  raise exception 'maintenance_occurrences is append-only; % is not permitted', tg_op
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

comment on function reject_maintenance_occurrence_mutation() is
  'Refuses changing or deleting an occurrence, except deleting while its company is purged.';

create trigger maintenance_occurrences_append_only
  before update or delete on maintenance_occurrences
  for each row execute function reject_maintenance_occurrence_mutation();

-- The phone shows that a job is planned maintenance.
create trigger maintenance_occurrences_touch_sync
  after insert on maintenance_occurrences
  for each row execute function touch_sync('work_order', 'work_order_id');

-- ---------------------------------------------------------------------------
-- Coverage
-- ---------------------------------------------------------------------------

create table work_order_coverage (
  tenant_id        uuid        not null references tenants (id) on delete restrict,
  work_order_id    uuid        not null,
  -- The contract that covers the job, or the one that was checked and did not.
  contract_id      uuid,
  status           text        not null,
  -- Covered: 'contract' or 'maintenance_plan'. Chargeable: why not.
  -- 'override' when office staff decided.
  reason           text        not null,
  override_reason  text,
  overridden_by    uuid,
  overridden_at    timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  primary key (tenant_id, work_order_id),
  constraint work_order_coverage_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete cascade,
  constraint work_order_coverage_contract_fk
    foreign key (tenant_id, contract_id) references service_contracts (tenant_id, id) on delete restrict,
  constraint work_order_coverage_status_known check (status in ('covered', 'chargeable')),
  constraint work_order_coverage_reason_known check (reason in (
    'contract', 'maintenance_plan', 'no_contract', 'contract_ended', 'site_not_covered',
    'asset_not_covered', 'job_type_not_covered', 'callouts_used', 'override')),
  constraint work_order_coverage_reason_matches check (
    (status = 'covered' and reason in ('contract', 'maintenance_plan', 'override'))
    or (status = 'chargeable' and reason not in ('contract', 'maintenance_plan'))),
  constraint work_order_coverage_covered_names_contract
    check (status <> 'covered' or reason = 'override' or contract_id is not null),
  constraint work_order_coverage_override_complete check (
    (reason = 'override') = (override_reason is not null)
    and (override_reason is null) = (overridden_by is null)
    and (overridden_by is null) = (overridden_at is null)),
  constraint work_order_coverage_override_length
    check (override_reason is null or char_length(btrim(override_reason)) between 1 and 500)
);

comment on table work_order_coverage is
  'Whether a job is covered by the customer''s contract, worked out when the job is created. Absent when the customer has never had a contract. Office staff can override it, with a reason.';

create index work_order_coverage_contract_idx
  on work_order_coverage (tenant_id, contract_id, created_at) where contract_id is not null;

create trigger work_order_coverage_set_updated_at
  before update on work_order_coverage
  for each row execute function set_updated_at();

create trigger work_order_coverage_touch_sync
  after insert or update on work_order_coverage
  for each row execute function touch_sync('work_order', 'work_order_id');

-- ---------------------------------------------------------------------------
-- Deadlines
-- ---------------------------------------------------------------------------

create table deadline_rules (
  tenant_id            uuid        not null references tenants (id) on delete restrict,
  priority             text        not null,
  -- From the job's creation to its first dispatch.
  response_minutes     integer,
  -- From the job's creation to its completion.
  completion_minutes   integer,
  -- 'always': every minute counts. 'working_hours': only the company's working hours.
  clock                text        not null default 'always',
  -- How long before a deadline the warning goes out.
  warn_minutes         integer     not null default 30,
  version              integer     not null default 1,
  updated_by           uuid        not null,
  updated_at           timestamptz not null default now(),

  primary key (tenant_id, priority),
  constraint deadline_rules_priority_known check (priority in ('low', 'normal', 'high', 'urgent')),
  constraint deadline_rules_clock_known check (clock in ('always', 'working_hours')),
  constraint deadline_rules_something_set check (response_minutes is not null or completion_minutes is not null),
  constraint deadline_rules_minutes_range check (
    (response_minutes is null or response_minutes between 1 and 525600)
    and (completion_minutes is null or completion_minutes between 1 and 525600)
    and warn_minutes between 0 and 10080),
  constraint deadline_rules_order check (
    response_minutes is null or completion_minutes is null or completion_minutes >= response_minutes)
);

comment on table deadline_rules is
  'A company''s response and completion times for jobs of one priority. A priority without a row has no deadlines.';

create table work_order_deadlines (
  tenant_id                uuid        not null references tenants (id) on delete restrict,
  work_order_id            uuid        not null,
  -- The rule as it was applied, so a later change to the rules does not rewrite it.
  priority                 text        not null,
  clock                    text        not null,
  warn_minutes             integer     not null,
  response_due_at          timestamptz,
  completion_due_at        timestamptz,
  -- When the job was first dispatched and first completed. Set by trigger.
  responded_at             timestamptz,
  completed_at             timestamptz,
  -- When the warnings went out, so each goes once. Cleared when the deadline moves.
  response_warned_at       timestamptz,
  completion_warned_at     timestamptz,
  -- When a miss was recorded: by the worker once a deadline passed unmet, or
  -- by trigger when the job was dispatched or completed late. Never cleared.
  response_missed_at       timestamptz,
  completion_missed_at     timestamptz,
  -- Cancelled: no deadline runs. Cleared if the job is reinstated.
  closed_at                timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),

  primary key (tenant_id, work_order_id),
  constraint work_order_deadlines_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete cascade,
  constraint work_order_deadlines_priority_known check (priority in ('low', 'normal', 'high', 'urgent')),
  constraint work_order_deadlines_clock_known check (clock in ('always', 'working_hours')),
  constraint work_order_deadlines_something_due
    check (response_due_at is not null or completion_due_at is not null),
  constraint work_order_deadlines_missed_needs_due check (
    (response_missed_at is null or response_due_at is not null)
    and (completion_missed_at is null or completion_due_at is not null))
);

comment on table work_order_deadlines is
  'One job''s response and completion deadlines, worked out from the company''s rules when it was created, and when each was met or missed.';

create index work_order_deadlines_open_response_idx
  on work_order_deadlines (tenant_id, response_due_at)
  where responded_at is null and closed_at is null and response_due_at is not null;
create index work_order_deadlines_open_completion_idx
  on work_order_deadlines (tenant_id, completion_due_at)
  where completed_at is null and closed_at is null and completion_due_at is not null;

create trigger work_order_deadlines_set_updated_at
  before update on work_order_deadlines
  for each row execute function set_updated_at();

create trigger work_order_deadlines_touch_sync
  after insert or update on work_order_deadlines
  for each row execute function touch_sync('work_order', 'work_order_id');

create function guard_work_order_deadlines() returns trigger
language plpgsql
as $$
declare
  job_state text;
begin
  if tg_op = 'INSERT' then
    -- Usually the job was just created. When a priority change gives an older
    -- job its first deadlines, what it already did counts, from its history.
    select min(e.occurred_at) filter (where e.to_state = 'dispatched'),
           min(e.occurred_at) filter (where e.to_state = 'complete')
      into new.responded_at, new.completed_at
      from work_order_events e
     where e.tenant_id = new.tenant_id and e.work_order_id = new.work_order_id and e.kind = 'transitioned';
    select w.state into job_state
      from work_orders w
     where w.tenant_id = new.tenant_id and w.id = new.work_order_id;
    new.closed_at := case when job_state = 'cancelled' then now() end;
    new.response_warned_at := null;
    new.completion_warned_at := null;
    new.response_missed_at := null;
    new.completion_missed_at := null;
    if new.responded_at is not null and new.response_due_at is not null
       and new.responded_at > new.response_due_at then
      new.response_missed_at := now();
    end if;
    if new.completed_at is not null and new.completion_due_at is not null
       and new.completed_at > new.completion_due_at then
      new.completion_missed_at := now();
    end if;
    return new;
  end if;
  -- A recorded miss stays recorded, whatever happens to the deadline afterwards.
  if old.response_missed_at is not null and new.response_missed_at is distinct from old.response_missed_at then
    new.response_missed_at := old.response_missed_at;
  end if;
  if old.completion_missed_at is not null and new.completion_missed_at is distinct from old.completion_missed_at then
    new.completion_missed_at := old.completion_missed_at;
  end if;
  -- Met once is met: a reopened job keeps its first completion.
  if old.responded_at is not null then new.responded_at := old.responded_at; end if;
  if old.completed_at is not null then new.completed_at := old.completed_at; end if;
  -- A moved deadline warns again.
  if new.response_due_at is distinct from old.response_due_at then new.response_warned_at := null; end if;
  if new.completion_due_at is distinct from old.completion_due_at then new.completion_warned_at := null; end if;
  -- Met late: a miss, recorded as it is met.
  if new.response_missed_at is null and new.responded_at is not null
     and new.response_due_at is not null and new.responded_at > new.response_due_at then
    new.response_missed_at := now();
  end if;
  if new.completion_missed_at is null and new.completed_at is not null
     and new.completion_due_at is not null and new.completed_at > new.completion_due_at then
    new.completion_missed_at := now();
  end if;
  return new;
end;
$$;

comment on function guard_work_order_deadlines() is
  'Keeps a recorded miss and the first time a deadline was met, re-arms the warning when a deadline moves, and records a miss when a deadline is met late.';

create trigger work_order_deadlines_guard
  before insert or update on work_order_deadlines
  for each row execute function guard_work_order_deadlines();

-- The job's own state changes meet its deadlines, whichever client made them.
create function track_work_order_deadlines() returns trigger
language plpgsql
as $$
begin
  if new.state is not distinct from old.state then
    return null;
  end if;
  update work_order_deadlines d
     set responded_at = case
           when d.responded_at is null and new.state = 'dispatched' then new.state_changed_at
           else d.responded_at end,
         completed_at = case
           when d.completed_at is null and new.state = 'complete' then new.state_changed_at
           else d.completed_at end,
         closed_at = case
           when new.state = 'cancelled' then new.state_changed_at
           when old.state = 'cancelled' then null
           else d.closed_at end
   where d.tenant_id = new.tenant_id and d.work_order_id = new.id;
  return null;
end;
$$;

comment on function track_work_order_deadlines() is
  'Records when a job was first dispatched (response) and first completed, and closes its deadlines while it is cancelled.';

create trigger work_orders_track_deadlines
  after update of state on work_orders
  for each row execute function track_work_order_deadlines();

-- ---------------------------------------------------------------------------
-- The job's history
-- ---------------------------------------------------------------------------

alter table work_order_events
  drop constraint work_order_events_kind_known,
  add constraint work_order_events_kind_known check (kind in (
    'created', 'transitioned', 'rescheduled', 'updated', 'assigned', 'unassigned', 'lead_changed', 'signed_off',
    'visit_scheduled', 'visit_rescheduled', 'visit_done', 'visit_cancelled', 'visit_assigned', 'visit_unassigned',
    'qualification_override',
    'maintenance_planned', 'coverage_changed', 'deadline_missed'
  ));

create function record_maintenance_occurrence() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  plan_asset   uuid;
  plan_title   text;
  plan_creator uuid;
begin
  if new.work_order_id is null then
    return null;
  end if;
  select p.asset_id, p.title, p.created_by into plan_asset, plan_title, plan_creator
    from public.maintenance_plans p
   where p.tenant_id = new.tenant_id and p.id = new.plan_id;
  insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, details)
  values (new.tenant_id, new.work_order_id, 'maintenance_planned', plan_creator,
          jsonb_build_object('planId', new.plan_id, 'title', plan_title, 'assetId', plan_asset,
                             'dueOn', new.due_on));
  return null;
end;
$$;

comment on function record_maintenance_occurrence() is
  'Writes the job''s history when a maintenance plan makes or joins a job. Security definer: the runtime role cannot write the history.';

create trigger maintenance_occurrences_record
  after insert on maintenance_occurrences
  for each row execute function record_maintenance_occurrence();

create function record_coverage_change() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
declare
  before jsonb;
begin
  if tg_op = 'INSERT' then
    -- Worked out when the job was created: not a change. An override of a job
    -- that had no coverage yet is one.
    if new.reason <> 'override' then
      return null;
    end if;
    before := null;
  else
    if (new.status, new.reason, new.contract_id) is not distinct from (old.status, old.reason, old.contract_id)
       and new.override_reason is not distinct from old.override_reason then
      return null;
    end if;
    before := jsonb_build_object('status', old.status, 'reason', old.reason, 'contractId', old.contract_id);
  end if;
  insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, reason, details)
  values (new.tenant_id, new.work_order_id, 'coverage_changed',
          coalesce(new.overridden_by,
                   (select w.last_actor from public.work_orders w
                     where w.tenant_id = new.tenant_id and w.id = new.work_order_id)),
          new.override_reason,
          jsonb_build_object('from', before,
                             'to', jsonb_build_object('status', new.status, 'reason', new.reason,
                                                      'contractId', new.contract_id)));
  return null;
end;
$$;

comment on function record_coverage_change() is
  'Writes the job''s history when its coverage is changed. Security definer: the runtime role cannot write the history.';

create trigger work_order_coverage_record
  after insert or update on work_order_coverage
  for each row execute function record_coverage_change();

create function record_deadline_miss() returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  actor uuid;
begin
  select w.last_actor into actor
    from public.work_orders w
   where w.tenant_id = new.tenant_id and w.id = new.work_order_id;
  -- On insert OLD is null, so a miss recorded as the row is made counts too.
  if new.response_missed_at is not null and (tg_op = 'INSERT' or old.response_missed_at is null) then
    insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, details)
    values (new.tenant_id, new.work_order_id, 'deadline_missed', actor,
            jsonb_build_object('deadline', 'response', 'dueAt', new.response_due_at,
                               'metAt', new.responded_at, 'priority', new.priority));
  end if;
  if new.completion_missed_at is not null and (tg_op = 'INSERT' or old.completion_missed_at is null) then
    insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, details)
    values (new.tenant_id, new.work_order_id, 'deadline_missed', actor,
            jsonb_build_object('deadline', 'completion', 'dueAt', new.completion_due_at,
                               'metAt', new.completed_at, 'priority', new.priority));
  end if;
  return null;
end;
$$;

comment on function record_deadline_miss() is
  'Writes the job''s history when a response or completion deadline is missed. Security definer: the runtime role cannot write the history.';

create trigger work_order_deadlines_record
  after insert or update on work_order_deadlines
  for each row execute function record_deadline_miss();

-- ---------------------------------------------------------------------------
-- Grants and row-level security
-- ---------------------------------------------------------------------------

grant select on service_contract_counters to integr8_app;
grant select, insert, update on service_contracts to integr8_app;
-- Coverage lists are sets: an entry is there or it is not.
grant select, insert, delete on service_contract_sites to integr8_app;
grant select, insert, delete on service_contract_assets to integr8_app;
grant select, insert, delete on service_contract_job_types to integr8_app;
grant select, insert, update on maintenance_plans to integr8_app;
grant select, insert on maintenance_occurrences to integr8_app;
grant select, insert, update on work_order_coverage to integr8_app;
grant select, insert, update, delete on deadline_rules to integr8_app;
grant select, insert, update on work_order_deadlines to integr8_app;

alter table service_contract_counters enable row level security;
create policy service_contract_counters_isolation on service_contract_counters
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table service_contracts enable row level security;
create policy service_contracts_isolation on service_contracts
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table service_contract_sites enable row level security;
create policy service_contract_sites_isolation on service_contract_sites
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table service_contract_assets enable row level security;
create policy service_contract_assets_isolation on service_contract_assets
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table service_contract_job_types enable row level security;
create policy service_contract_job_types_isolation on service_contract_job_types
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table maintenance_plans enable row level security;
create policy maintenance_plans_isolation on maintenance_plans
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table maintenance_occurrences enable row level security;
create policy maintenance_occurrences_isolation on maintenance_occurrences
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table work_order_coverage enable row level security;
create policy work_order_coverage_isolation on work_order_coverage
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table deadline_rules enable row level security;
create policy deadline_rules_isolation on deadline_rules
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table work_order_deadlines enable row level security;
create policy work_order_deadlines_isolation on work_order_deadlines
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
