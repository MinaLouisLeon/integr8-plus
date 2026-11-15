-- Service contracts, maintenance plans and deadlines.
--
-- Part of the 2.0.0 baseline (P41), generated from the schema that migrations
-- 0001-0079 of release 1.4.0 built; their history and reasoning are in git
-- before 2.0.0. Comments on tables and columns below carry the why.

-- SQL functions may name tables a later module creates; Postgres checks
-- their bodies when they are first called rather than here.
set local check_function_bodies = false;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.assign_service_contract_reference() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  insert into public.service_contract_counters as counter (tenant_id, last_reference)
  values (new.tenant_id, 1)
  on conflict (tenant_id) do update set last_reference = counter.last_reference + 1
  returning last_reference into new.reference;
  return new;
end;
$$;

CREATE FUNCTION public.guard_maintenance_plan() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
declare
  bookkeeping text[] := array['next_due_on', 'next_sequence', 'updated_at', 'version',
                              'last_error', 'last_error_at', 'failure_count'];
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
  -- The worker moving the next due date along, or noting a failure, is not an
  -- edit: whoever has the plan open can still save it.
  if (to_jsonb(new) - bookkeeping) is distinct from (to_jsonb(old) - bookkeeping) then
    new.version := old.version + 1;
    new.last_error := null;
    new.last_error_at := null;
    new.failure_count := 0;
  else
    new.version := old.version;
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.guard_service_contract() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.guard_work_order_deadlines() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
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

CREATE FUNCTION public.record_coverage_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  previous jsonb;
begin
  if tg_op = 'INSERT' then
    -- Worked out when the job was created: not a change. An override of a job
    -- that had no coverage yet is one.
    if new.reason <> 'override' then
      return null;
    end if;
    previous := null;
  else
    if (new.status, new.reason, new.contract_id) is not distinct from (old.status, old.reason, old.contract_id)
       and new.override_reason is not distinct from old.override_reason then
      return null;
    end if;
    previous := jsonb_build_object('status', old.status, 'reason', old.reason, 'contractId', old.contract_id);
  end if;
  insert into public.work_order_events (tenant_id, work_order_id, kind, actor_id, reason, details)
  values (new.tenant_id, new.work_order_id, 'coverage_changed',
          coalesce(new.overridden_by,
                   (select w.last_actor from public.work_orders w
                     where w.tenant_id = new.tenant_id and w.id = new.work_order_id)),
          new.override_reason,
          jsonb_build_object('from', previous,
                             'to', jsonb_build_object('status', new.status, 'reason', new.reason,
                                                      'contractId', new.contract_id)));
  return null;
end;
$$;

CREATE FUNCTION public.record_deadline_miss() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

CREATE FUNCTION public.record_maintenance_occurrence() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

CREATE FUNCTION public.reject_maintenance_occurrence_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  if tg_op = 'DELETE' and current_setting('integr8.purging', true) = old.tenant_id::text then
    return old;
  end if;
  raise exception 'maintenance_occurrences is append-only; % is not permitted', tg_op
    using errcode = 'object_not_in_prerequisite_state';
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE deadline_rules (
    tenant_id uuid NOT NULL,
    priority text NOT NULL,
    response_minutes integer,
    completion_minutes integer,
    clock text DEFAULT 'always'::text NOT NULL,
    warn_minutes integer DEFAULT 30 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_by uuid NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deadline_rules_clock_known CHECK ((clock = ANY (ARRAY['always'::text, 'working_hours'::text]))),
    CONSTRAINT deadline_rules_minutes_range CHECK ((((response_minutes IS NULL) OR ((response_minutes >= 1) AND (response_minutes <= 525600))) AND ((completion_minutes IS NULL) OR ((completion_minutes >= 1) AND (completion_minutes <= 525600))) AND ((warn_minutes >= 0) AND (warn_minutes <= 10080)))),
    CONSTRAINT deadline_rules_order CHECK (((response_minutes IS NULL) OR (completion_minutes IS NULL) OR (completion_minutes >= response_minutes))),
    CONSTRAINT deadline_rules_priority_known CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT deadline_rules_something_set CHECK (((response_minutes IS NOT NULL) OR (completion_minutes IS NOT NULL)))
);

CREATE TABLE maintenance_occurrences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    due_on date NOT NULL,
    work_order_id uuid,
    status text NOT NULL,
    skip_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT maintenance_occurrences_skip_reason_known CHECK (((skip_reason IS NULL) OR (skip_reason = ANY (ARRAY['asset_retired'::text, 'contract_ended'::text, 'plan_ended'::text])))),
    CONSTRAINT maintenance_occurrences_status_known CHECK ((status = ANY (ARRAY['created'::text, 'skipped'::text]))),
    CONSTRAINT maintenance_occurrences_status_shape CHECK ((((status = 'created'::text) = (work_order_id IS NOT NULL)) AND ((status = 'skipped'::text) = (skip_reason IS NOT NULL))))
);

CREATE TABLE maintenance_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    job_type_id uuid NOT NULL,
    contract_id uuid,
    title text NOT NULL,
    instructions text,
    interval_count integer NOT NULL,
    interval_unit text NOT NULL,
    counting text NOT NULL,
    starts_on date NOT NULL,
    ends_on date,
    window_before_days integer DEFAULT 7 NOT NULL,
    window_after_days integer DEFAULT 7 NOT NULL,
    lead_days integer DEFAULT 30 NOT NULL,
    can_share boolean DEFAULT true NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    next_due_on date,
    next_sequence integer DEFAULT 0 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    ended_at timestamp with time zone,
    ended_by uuid,
    last_error text,
    last_error_at timestamp with time zone,
    failure_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT maintenance_plans_counting_known CHECK ((counting = ANY (ARRAY['calendar'::text, 'completion'::text]))),
    CONSTRAINT maintenance_plans_dates_ordered CHECK (((ends_on IS NULL) OR (ends_on >= starts_on))),
    CONSTRAINT maintenance_plans_ended_complete CHECK ((((status = 'ended'::text) = (ended_at IS NOT NULL)) AND ((ended_at IS NULL) = (ended_by IS NULL)))),
    CONSTRAINT maintenance_plans_failure_count_range CHECK ((failure_count >= 0)),
    CONSTRAINT maintenance_plans_instructions_length CHECK (((instructions IS NULL) OR (char_length(instructions) <= 10000))),
    CONSTRAINT maintenance_plans_interval_range CHECK (((interval_count >= 1) AND (interval_count <= 120))),
    CONSTRAINT maintenance_plans_interval_unit_known CHECK ((interval_unit = ANY (ARRAY['day'::text, 'week'::text, 'month'::text, 'year'::text]))),
    CONSTRAINT maintenance_plans_last_error_length CHECK (((last_error IS NULL) OR (char_length(last_error) <= 2000))),
    CONSTRAINT maintenance_plans_last_error_pairing CHECK (((last_error IS NULL) = (last_error_at IS NULL))),
    CONSTRAINT maintenance_plans_lead_range CHECK (((lead_days >= 0) AND (lead_days <= 365))),
    CONSTRAINT maintenance_plans_sequence_positive CHECK ((next_sequence >= 0)),
    CONSTRAINT maintenance_plans_status_known CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'ended'::text]))),
    CONSTRAINT maintenance_plans_title_length CHECK (((char_length(btrim(title)) >= 1) AND (char_length(btrim(title)) <= 200))),
    CONSTRAINT maintenance_plans_window_range CHECK ((((window_before_days >= 0) AND (window_before_days <= 365)) AND ((window_after_days >= 0) AND (window_after_days <= 365))))
);

CREATE TABLE service_contract_assets (
    tenant_id uuid NOT NULL,
    contract_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE service_contract_counters (
    tenant_id uuid NOT NULL,
    last_reference integer NOT NULL
);

CREATE TABLE service_contract_job_types (
    tenant_id uuid NOT NULL,
    contract_id uuid NOT NULL,
    job_type_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE service_contract_sites (
    tenant_id uuid NOT NULL,
    contract_id uuid NOT NULL,
    customer_id uuid NOT NULL,
    site_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE service_contracts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reference integer DEFAULT 0 NOT NULL,
    customer_id uuid NOT NULL,
    title text NOT NULL,
    starts_on date NOT NULL,
    ends_on date NOT NULL,
    value numeric(14,2),
    notes text,
    renewal_notice_days integer DEFAULT 60 NOT NULL,
    all_sites boolean DEFAULT true NOT NULL,
    all_assets boolean DEFAULT true NOT NULL,
    all_job_types boolean DEFAULT true NOT NULL,
    included_callouts integer,
    renewed_from_id uuid,
    cancelled_on date,
    cancelled_at timestamp with time zone,
    cancelled_by uuid,
    cancel_reason text,
    renewal_warned_at timestamp with time zone,
    end_alerted_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT service_contracts_callouts_range CHECK (((included_callouts IS NULL) OR ((included_callouts >= 0) AND (included_callouts <= 10000)))),
    CONSTRAINT service_contracts_cancel_complete CHECK ((((cancelled_at IS NULL) = (cancelled_by IS NULL)) AND ((cancelled_at IS NULL) = (cancelled_on IS NULL)) AND ((cancelled_at IS NULL) = (cancel_reason IS NULL)))),
    CONSTRAINT service_contracts_cancel_reason_length CHECK (((cancel_reason IS NULL) OR ((char_length(btrim(cancel_reason)) >= 1) AND (char_length(btrim(cancel_reason)) <= 500)))),
    CONSTRAINT service_contracts_dates_ordered CHECK ((ends_on >= starts_on)),
    CONSTRAINT service_contracts_notes_length CHECK (((notes IS NULL) OR (char_length(notes) <= 4000))),
    CONSTRAINT service_contracts_notice_range CHECK (((renewal_notice_days >= 0) AND (renewal_notice_days <= 365))),
    CONSTRAINT service_contracts_title_length CHECK (((char_length(btrim(title)) >= 1) AND (char_length(btrim(title)) <= 200))),
    CONSTRAINT service_contracts_value_positive CHECK (((value IS NULL) OR (value >= (0)::numeric)))
);

CREATE TABLE work_order_coverage (
    tenant_id uuid NOT NULL,
    work_order_id uuid NOT NULL,
    contract_id uuid,
    status text NOT NULL,
    reason text NOT NULL,
    override_reason text,
    overridden_by uuid,
    overridden_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT work_order_coverage_covered_names_contract CHECK (((status <> 'covered'::text) OR (reason = 'override'::text) OR (contract_id IS NOT NULL))),
    CONSTRAINT work_order_coverage_override_complete CHECK ((((reason = 'override'::text) = (override_reason IS NOT NULL)) AND ((override_reason IS NULL) = (overridden_by IS NULL)) AND ((overridden_by IS NULL) = (overridden_at IS NULL)))),
    CONSTRAINT work_order_coverage_override_length CHECK (((override_reason IS NULL) OR ((char_length(btrim(override_reason)) >= 1) AND (char_length(btrim(override_reason)) <= 500)))),
    CONSTRAINT work_order_coverage_reason_known CHECK ((reason = ANY (ARRAY['contract'::text, 'maintenance_plan'::text, 'no_contract'::text, 'contract_ended'::text, 'site_not_covered'::text, 'asset_not_covered'::text, 'job_type_not_covered'::text, 'callouts_used'::text, 'override'::text]))),
    CONSTRAINT work_order_coverage_reason_matches CHECK ((((status = 'covered'::text) AND (reason = ANY (ARRAY['contract'::text, 'maintenance_plan'::text, 'override'::text]))) OR ((status = 'chargeable'::text) AND (reason <> ALL (ARRAY['contract'::text, 'maintenance_plan'::text]))))),
    CONSTRAINT work_order_coverage_status_known CHECK ((status = ANY (ARRAY['covered'::text, 'chargeable'::text])))
);

CREATE TABLE work_order_deadlines (
    tenant_id uuid NOT NULL,
    work_order_id uuid NOT NULL,
    priority text NOT NULL,
    clock text NOT NULL,
    warn_minutes integer NOT NULL,
    response_due_at timestamp with time zone,
    completion_due_at timestamp with time zone,
    responded_at timestamp with time zone,
    completed_at timestamp with time zone,
    response_warned_at timestamp with time zone,
    completion_warned_at timestamp with time zone,
    response_missed_at timestamp with time zone,
    completion_missed_at timestamp with time zone,
    closed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT work_order_deadlines_clock_known CHECK ((clock = ANY (ARRAY['always'::text, 'working_hours'::text]))),
    CONSTRAINT work_order_deadlines_missed_needs_due CHECK ((((response_missed_at IS NULL) OR (response_due_at IS NOT NULL)) AND ((completion_missed_at IS NULL) OR (completion_due_at IS NOT NULL)))),
    CONSTRAINT work_order_deadlines_priority_known CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT work_order_deadlines_something_due CHECK (((response_due_at IS NOT NULL) OR (completion_due_at IS NOT NULL)))
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY deadline_rules
    ADD CONSTRAINT deadline_rules_pkey PRIMARY KEY (tenant_id, priority);

ALTER TABLE ONLY maintenance_occurrences
    ADD CONSTRAINT maintenance_occurrences_pkey PRIMARY KEY (id);

ALTER TABLE ONLY maintenance_plans
    ADD CONSTRAINT maintenance_plans_pkey PRIMARY KEY (id);

ALTER TABLE ONLY maintenance_plans
    ADD CONSTRAINT maintenance_plans_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY service_contract_assets
    ADD CONSTRAINT service_contract_assets_pkey PRIMARY KEY (tenant_id, contract_id, asset_id);

ALTER TABLE ONLY service_contract_counters
    ADD CONSTRAINT service_contract_counters_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY service_contract_job_types
    ADD CONSTRAINT service_contract_job_types_pkey PRIMARY KEY (tenant_id, contract_id, job_type_id);

ALTER TABLE ONLY service_contract_sites
    ADD CONSTRAINT service_contract_sites_pkey PRIMARY KEY (tenant_id, contract_id, site_id);

ALTER TABLE ONLY service_contracts
    ADD CONSTRAINT service_contracts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY service_contracts
    ADD CONSTRAINT service_contracts_tenant_customer_id_unique UNIQUE (tenant_id, customer_id, id);

ALTER TABLE ONLY service_contracts
    ADD CONSTRAINT service_contracts_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY work_order_coverage
    ADD CONSTRAINT work_order_coverage_pkey PRIMARY KEY (tenant_id, work_order_id);

ALTER TABLE ONLY work_order_deadlines
    ADD CONSTRAINT work_order_deadlines_pkey PRIMARY KEY (tenant_id, work_order_id);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX maintenance_occurrences_plan_due_unique ON maintenance_occurrences USING btree (tenant_id, plan_id, due_on);

CREATE INDEX maintenance_occurrences_work_order_idx ON maintenance_occurrences USING btree (tenant_id, work_order_id) WHERE (work_order_id IS NOT NULL);

CREATE INDEX maintenance_plans_asset_idx ON maintenance_plans USING btree (tenant_id, asset_id);

CREATE INDEX maintenance_plans_contract_idx ON maintenance_plans USING btree (tenant_id, contract_id) WHERE (contract_id IS NOT NULL);

CREATE INDEX maintenance_plans_due_idx ON maintenance_plans USING btree (tenant_id, next_due_on) WHERE (status = 'active'::text);

CREATE INDEX maintenance_plans_failing ON maintenance_plans USING btree (tenant_id, last_error_at) WHERE (last_error IS NOT NULL);

CREATE INDEX service_contract_assets_asset_idx ON service_contract_assets USING btree (tenant_id, asset_id);

CREATE INDEX service_contracts_customer_idx ON service_contracts USING btree (tenant_id, customer_id, starts_on);

CREATE INDEX service_contracts_ends_idx ON service_contracts USING btree (tenant_id, ends_on) WHERE (cancelled_at IS NULL);

CREATE UNIQUE INDEX service_contracts_reference_unique ON service_contracts USING btree (tenant_id, reference);

CREATE UNIQUE INDEX service_contracts_renewed_once ON service_contracts USING btree (tenant_id, renewed_from_id) WHERE (renewed_from_id IS NOT NULL);

CREATE INDEX work_order_coverage_contract_idx ON work_order_coverage USING btree (tenant_id, contract_id, created_at) WHERE (contract_id IS NOT NULL);

CREATE INDEX work_order_deadlines_open_completion_idx ON work_order_deadlines USING btree (tenant_id, completion_due_at) WHERE ((completed_at IS NULL) AND (closed_at IS NULL) AND (completion_due_at IS NOT NULL));

CREATE INDEX work_order_deadlines_open_response_idx ON work_order_deadlines USING btree (tenant_id, response_due_at) WHERE ((responded_at IS NULL) AND (closed_at IS NULL) AND (response_due_at IS NOT NULL));

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY deadline_rules
    ADD CONSTRAINT deadline_rules_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY maintenance_occurrences
    ADD CONSTRAINT maintenance_occurrences_plan_fk FOREIGN KEY (tenant_id, plan_id) REFERENCES maintenance_plans(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY maintenance_occurrences
    ADD CONSTRAINT maintenance_occurrences_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY maintenance_occurrences
    ADD CONSTRAINT maintenance_occurrences_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY maintenance_plans
    ADD CONSTRAINT maintenance_plans_asset_fk FOREIGN KEY (tenant_id, asset_id) REFERENCES erp_assets(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY maintenance_plans
    ADD CONSTRAINT maintenance_plans_contract_fk FOREIGN KEY (tenant_id, contract_id) REFERENCES service_contracts(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY maintenance_plans
    ADD CONSTRAINT maintenance_plans_job_type_fk FOREIGN KEY (tenant_id, job_type_id) REFERENCES job_types(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY maintenance_plans
    ADD CONSTRAINT maintenance_plans_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY service_contract_assets
    ADD CONSTRAINT service_contract_assets_asset_fk FOREIGN KEY (tenant_id, asset_id) REFERENCES erp_assets(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY service_contract_assets
    ADD CONSTRAINT service_contract_assets_contract_fk FOREIGN KEY (tenant_id, contract_id) REFERENCES service_contracts(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY service_contract_assets
    ADD CONSTRAINT service_contract_assets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY service_contract_counters
    ADD CONSTRAINT service_contract_counters_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY service_contract_job_types
    ADD CONSTRAINT service_contract_job_types_contract_fk FOREIGN KEY (tenant_id, contract_id) REFERENCES service_contracts(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY service_contract_job_types
    ADD CONSTRAINT service_contract_job_types_job_type_fk FOREIGN KEY (tenant_id, job_type_id) REFERENCES job_types(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY service_contract_job_types
    ADD CONSTRAINT service_contract_job_types_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY service_contract_sites
    ADD CONSTRAINT service_contract_sites_contract_fk FOREIGN KEY (tenant_id, customer_id, contract_id) REFERENCES service_contracts(tenant_id, customer_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY service_contract_sites
    ADD CONSTRAINT service_contract_sites_site_fk FOREIGN KEY (tenant_id, customer_id, site_id) REFERENCES sites(tenant_id, customer_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY service_contract_sites
    ADD CONSTRAINT service_contract_sites_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY service_contracts
    ADD CONSTRAINT service_contracts_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY service_contracts
    ADD CONSTRAINT service_contracts_renewed_from_fk FOREIGN KEY (tenant_id, renewed_from_id) REFERENCES service_contracts(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY service_contracts
    ADD CONSTRAINT service_contracts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_coverage
    ADD CONSTRAINT work_order_coverage_contract_fk FOREIGN KEY (tenant_id, contract_id) REFERENCES service_contracts(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_coverage
    ADD CONSTRAINT work_order_coverage_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_coverage
    ADD CONSTRAINT work_order_coverage_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY work_order_deadlines
    ADD CONSTRAINT work_order_deadlines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY work_order_deadlines
    ADD CONSTRAINT work_order_deadlines_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER maintenance_occurrences_append_only BEFORE DELETE OR UPDATE ON maintenance_occurrences FOR EACH ROW EXECUTE FUNCTION reject_maintenance_occurrence_mutation();

CREATE TRIGGER maintenance_occurrences_record AFTER INSERT ON maintenance_occurrences FOR EACH ROW EXECUTE FUNCTION record_maintenance_occurrence();

CREATE TRIGGER maintenance_occurrences_touch_sync AFTER INSERT ON maintenance_occurrences FOR EACH ROW EXECUTE FUNCTION touch_sync('work_order', 'work_order_id');

CREATE TRIGGER maintenance_plans_guard BEFORE UPDATE ON maintenance_plans FOR EACH ROW EXECUTE FUNCTION guard_maintenance_plan();

CREATE TRIGGER maintenance_plans_set_updated_at BEFORE UPDATE ON maintenance_plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER service_contracts_assign_reference BEFORE INSERT ON service_contracts FOR EACH ROW EXECUTE FUNCTION assign_service_contract_reference();

CREATE TRIGGER service_contracts_guard BEFORE UPDATE ON service_contracts FOR EACH ROW EXECUTE FUNCTION guard_service_contract();

CREATE TRIGGER service_contracts_set_updated_at BEFORE UPDATE ON service_contracts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER work_order_coverage_record AFTER INSERT OR UPDATE ON work_order_coverage FOR EACH ROW EXECUTE FUNCTION record_coverage_change();

CREATE TRIGGER work_order_coverage_set_updated_at BEFORE UPDATE ON work_order_coverage FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER work_order_coverage_touch_sync AFTER INSERT OR UPDATE ON work_order_coverage FOR EACH ROW EXECUTE FUNCTION touch_sync('work_order', 'work_order_id');

CREATE TRIGGER work_order_deadlines_guard BEFORE INSERT OR UPDATE ON work_order_deadlines FOR EACH ROW EXECUTE FUNCTION guard_work_order_deadlines();

CREATE TRIGGER work_order_deadlines_record AFTER INSERT OR UPDATE ON work_order_deadlines FOR EACH ROW EXECUTE FUNCTION record_deadline_miss();

CREATE TRIGGER work_order_deadlines_set_updated_at BEFORE UPDATE ON work_order_deadlines FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER work_order_deadlines_touch_sync AFTER INSERT OR UPDATE ON work_order_deadlines FOR EACH ROW EXECUTE FUNCTION touch_sync('work_order', 'work_order_id');

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE deadline_rules ENABLE ROW LEVEL SECURITY;

ALTER TABLE maintenance_occurrences ENABLE ROW LEVEL SECURITY;

ALTER TABLE maintenance_plans ENABLE ROW LEVEL SECURITY;

ALTER TABLE service_contract_assets ENABLE ROW LEVEL SECURITY;

ALTER TABLE service_contract_counters ENABLE ROW LEVEL SECURITY;

ALTER TABLE service_contract_job_types ENABLE ROW LEVEL SECURITY;

ALTER TABLE service_contract_sites ENABLE ROW LEVEL SECURITY;

ALTER TABLE service_contracts ENABLE ROW LEVEL SECURITY;

ALTER TABLE work_order_coverage ENABLE ROW LEVEL SECURITY;

ALTER TABLE work_order_deadlines ENABLE ROW LEVEL SECURITY;

CREATE POLICY deadline_rules_isolation ON deadline_rules TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY maintenance_occurrences_isolation ON maintenance_occurrences TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY maintenance_plans_isolation ON maintenance_plans TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY service_contract_assets_isolation ON service_contract_assets TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY service_contract_counters_isolation ON service_contract_counters TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY service_contract_job_types_isolation ON service_contract_job_types TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY service_contract_sites_isolation ON service_contract_sites TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY service_contracts_isolation ON service_contracts TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY work_order_coverage_isolation ON work_order_coverage TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY work_order_deadlines_isolation ON work_order_deadlines TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION assign_service_contract_reference() IS 'Numbers a contract when it is created. Security definer: the runtime role cannot write the counter.';

COMMENT ON FUNCTION guard_maintenance_plan() IS 'Keeps a plan''s asset, refuses changing an ended plan, counts versions, and clears a failure on an edit (0063).';

COMMENT ON FUNCTION guard_service_contract() IS 'Keeps a contract''s number, customer and predecessor, refuses changing a cancelled one, resets the renewal reminders when the end date changes, and counts versions of edits.';

COMMENT ON FUNCTION guard_work_order_deadlines() IS 'Keeps a recorded miss and the first time a deadline was met, re-arms the warning when a deadline moves, and records a miss when a deadline is met late.';

COMMENT ON FUNCTION record_coverage_change() IS 'Writes the job''s history when its coverage is changed. Security definer: the runtime role cannot write the history.';

COMMENT ON FUNCTION record_deadline_miss() IS 'Writes the job''s history when a response or completion deadline is missed. Security definer: the runtime role cannot write the history.';

COMMENT ON FUNCTION record_maintenance_occurrence() IS 'Writes the job''s history when a maintenance plan makes or joins a job. Security definer: the runtime role cannot write the history.';

COMMENT ON FUNCTION reject_maintenance_occurrence_mutation() IS 'Refuses changing or deleting an occurrence, except deleting while its company is purged.';

COMMENT ON TABLE deadline_rules IS 'A company''s response and completion times for jobs of one priority. A priority without a row has no deadlines.';

COMMENT ON TABLE maintenance_occurrences IS 'Each due date a maintenance plan produced: the job made for it, or why none was. One per plan and date, so the worker never makes two. Append-only.';

COMMENT ON TABLE maintenance_plans IS 'Recurring servicing of one asset. The worker creates each job ahead of its due date. Ended rather than deleted.';

COMMENT ON COLUMN maintenance_plans.last_error IS 'Why the worker last failed to make this plan''s jobs; null once it succeeds or the plan is edited (0063).';

COMMENT ON COLUMN maintenance_plans.failure_count IS 'Failures in a row. The worker retries the plan alone each cycle until this reaches 5, then waits for an edit (0063).';

COMMENT ON TABLE service_contract_assets IS 'The assets a contract covers, when it does not cover all assets at its sites.';

COMMENT ON TABLE service_contract_counters IS 'The last contract number handed out per company. Written only by assign_service_contract_reference.';

COMMENT ON TABLE service_contract_job_types IS 'The job types a contract covers, when it does not cover them all.';

COMMENT ON TABLE service_contract_sites IS 'The sites a contract covers, when it does not cover all of its customer''s sites.';

COMMENT ON TABLE service_contracts IS 'A customer''s service agreement: its term and what it covers. Cancelled rather than deleted; renewed by a new contract that names this one.';

COMMENT ON TABLE work_order_coverage IS 'Whether a job is covered by the customer''s contract, worked out when the job is created. Absent when the customer has never had a contract. Office staff can override it, with a reason.';

COMMENT ON TABLE work_order_deadlines IS 'One job''s response and completion deadlines, worked out from the company''s rules when it was created, and when each was met or missed.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE deadline_rules TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE deadline_rules TO integr8_platform;

GRANT SELECT,INSERT ON TABLE maintenance_occurrences TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE maintenance_occurrences TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE maintenance_plans TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE maintenance_plans TO integr8_platform;

GRANT SELECT,INSERT,DELETE ON TABLE service_contract_assets TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE service_contract_assets TO integr8_platform;

GRANT SELECT ON TABLE service_contract_counters TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE service_contract_counters TO integr8_platform;

GRANT SELECT,INSERT,DELETE ON TABLE service_contract_job_types TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE service_contract_job_types TO integr8_platform;

GRANT SELECT,INSERT,DELETE ON TABLE service_contract_sites TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE service_contract_sites TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE service_contracts TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE service_contracts TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE work_order_coverage TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE work_order_coverage TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE work_order_deadlines TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE work_order_deadlines TO integr8_platform;
