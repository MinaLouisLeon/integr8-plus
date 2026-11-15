-- Leads, pipelines, opportunities and activities.
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

CREATE FUNCTION public.crm_leads_guard_conversion() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

CREATE FUNCTION public.crm_opportunities_check_stage() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

CREATE FUNCTION public.crm_opportunity_record_amount() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if tg_op = 'UPDATE'
     and new.amount is not distinct from old.amount
     and new.currency_code is not distinct from old.currency_code then
    return new;
  end if;
  insert into crm_opportunity_amounts (tenant_id, opportunity_id, amount, currency_code)
  values (new.tenant_id, new.id, new.amount, new.currency_code);
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE crm_activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    kind text NOT NULL,
    subject text NOT NULL,
    detail text,
    outcome text,
    status text DEFAULT 'open'::text NOT NULL,
    assigned_to uuid,
    due_at timestamp with time zone,
    completed_at timestamp with time zone,
    completed_by uuid,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_activities_detail_length CHECK (((detail IS NULL) OR (char_length(detail) <= 10000))),
    CONSTRAINT crm_activities_done_pairing CHECK (((status = 'done'::text) = ((completed_at IS NOT NULL) AND (completed_by IS NOT NULL)))),
    CONSTRAINT crm_activities_kind_known CHECK ((kind = ANY (ARRAY['call'::text, 'email'::text, 'meeting'::text, 'note'::text, 'follow_up'::text, 'task'::text]))),
    CONSTRAINT crm_activities_outcome_length CHECK (((outcome IS NULL) OR (char_length(outcome) <= 2000))),
    CONSTRAINT crm_activities_status_known CHECK ((status = ANY (ARRAY['open'::text, 'done'::text, 'cancelled'::text]))),
    CONSTRAINT crm_activities_subject_present CHECK (((btrim(subject) <> ''::text) AND (char_length(subject) <= 200))),
    CONSTRAINT crm_activities_version_positive CHECK ((version > 0))
);

CREATE TABLE crm_activity_customers (
    tenant_id uuid NOT NULL,
    activity_id uuid NOT NULL,
    customer_id uuid NOT NULL
);

CREATE TABLE crm_activity_leads (
    tenant_id uuid NOT NULL,
    activity_id uuid NOT NULL,
    lead_id uuid NOT NULL
);

CREATE TABLE crm_activity_opportunities (
    tenant_id uuid NOT NULL,
    activity_id uuid NOT NULL,
    opportunity_id uuid NOT NULL
);

CREATE TABLE crm_leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    display_name text NOT NULL,
    company_name text,
    email text,
    phone text,
    source text DEFAULT 'manual'::text NOT NULL,
    status text DEFAULT 'new'::text NOT NULL,
    assigned_to uuid,
    estimated_value numeric(20,4),
    currency_code text,
    notes text,
    unqualified_reason text,
    converted_customer_id uuid,
    converted_contact_id uuid,
    converted_at timestamp with time zone,
    converted_by uuid,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    email_normalized text GENERATED ALWAYS AS (lower(btrim(email))) STORED,
    phone_digits text GENERATED ALWAYS AS (NULLIF(regexp_replace(COALESCE(phone, ''::text), '[^0-9]'::text, ''::text, 'g'::text), ''::text)) STORED,
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, ((((((COALESCE(display_name, ''::text) || ' '::text) || COALESCE(company_name, ''::text)) || ' '::text) || COALESCE(email, ''::text)) || ' '::text) || COALESCE(phone, ''::text)))) STORED,
    CONSTRAINT crm_leads_company_name_length CHECK (((company_name IS NULL) OR (char_length(company_name) <= 200))),
    CONSTRAINT crm_leads_converted_pairing CHECK (((status = 'converted'::text) = ((converted_customer_id IS NOT NULL) AND (converted_at IS NOT NULL)))),
    CONSTRAINT crm_leads_converter_pairing CHECK (((converted_at IS NULL) = (converted_by IS NULL))),
    CONSTRAINT crm_leads_currency_shape CHECK (((currency_code IS NULL) OR (currency_code ~ '^[A-Z]{3}$'::text))),
    CONSTRAINT crm_leads_display_name_present CHECK (((btrim(display_name) <> ''::text) AND (char_length(display_name) <= 200))),
    CONSTRAINT crm_leads_email_length CHECK (((email IS NULL) OR (char_length(email) <= 320))),
    CONSTRAINT crm_leads_notes_length CHECK (((notes IS NULL) OR (char_length(notes) <= 10000))),
    CONSTRAINT crm_leads_phone_length CHECK (((phone IS NULL) OR (char_length(phone) <= 50))),
    CONSTRAINT crm_leads_source_known CHECK ((source = ANY (ARRAY['manual'::text, 'referral'::text, 'web'::text, 'import'::text, 'other'::text]))),
    CONSTRAINT crm_leads_status_known CHECK ((status = ANY (ARRAY['new'::text, 'contacted'::text, 'qualified'::text, 'unqualified'::text, 'converted'::text]))),
    CONSTRAINT crm_leads_unqualified_reason_length CHECK (((unqualified_reason IS NULL) OR (char_length(unqualified_reason) <= 1000))),
    CONSTRAINT crm_leads_value_has_currency CHECK (((estimated_value IS NULL) OR (currency_code IS NOT NULL))),
    CONSTRAINT crm_leads_value_not_negative CHECK (((estimated_value IS NULL) OR (estimated_value >= (0)::numeric))),
    CONSTRAINT crm_leads_version_positive CHECK ((version > 0))
);

CREATE TABLE crm_opportunities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    title text NOT NULL,
    customer_id uuid,
    lead_id uuid,
    pipeline_id uuid NOT NULL,
    stage_id uuid NOT NULL,
    owner_id uuid,
    amount numeric(20,4),
    currency_code text NOT NULL,
    expected_close_date date,
    probability_bp integer NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    lost_reason text,
    description text,
    closed_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    search tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, ((COALESCE(title, ''::text) || ' '::text) || COALESCE(description, ''::text)))) STORED,
    CONSTRAINT crm_opportunities_amount_not_negative CHECK (((amount IS NULL) OR (amount >= (0)::numeric))),
    CONSTRAINT crm_opportunities_closed_pairing CHECK (((status = 'open'::text) = (closed_at IS NULL))),
    CONSTRAINT crm_opportunities_currency_shape CHECK ((currency_code ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT crm_opportunities_description_length CHECK (((description IS NULL) OR (char_length(description) <= 10000))),
    CONSTRAINT crm_opportunities_has_party CHECK (((customer_id IS NOT NULL) OR (lead_id IS NOT NULL))),
    CONSTRAINT crm_opportunities_lost_reason CHECK (((lost_reason IS NULL) OR ((status = 'lost'::text) AND (char_length(lost_reason) <= 1000)))),
    CONSTRAINT crm_opportunities_probability_range CHECK (((probability_bp >= 0) AND (probability_bp <= 10000))),
    CONSTRAINT crm_opportunities_status_known CHECK ((status = ANY (ARRAY['open'::text, 'won'::text, 'lost'::text]))),
    CONSTRAINT crm_opportunities_title_present CHECK (((btrim(title) <> ''::text) AND (char_length(title) <= 200))),
    CONSTRAINT crm_opportunities_version_positive CHECK ((version > 0))
);

CREATE TABLE crm_opportunity_amounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    opportunity_id uuid NOT NULL,
    amount numeric(20,4),
    currency_code text NOT NULL,
    baseline boolean DEFAULT false NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE crm_opportunity_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    opportunity_id uuid NOT NULL,
    kind text NOT NULL,
    from_stage_id uuid,
    to_stage_id uuid,
    from_status text,
    to_status text,
    reason text,
    actor_id uuid NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT crm_opportunity_events_from_status_known CHECK (((from_status IS NULL) OR (from_status = ANY (ARRAY['open'::text, 'won'::text, 'lost'::text])))),
    CONSTRAINT crm_opportunity_events_kind_known CHECK ((kind = ANY (ARRAY['created'::text, 'stage_changed'::text, 'won'::text, 'lost'::text, 'reopened'::text]))),
    CONSTRAINT crm_opportunity_events_reason_length CHECK (((reason IS NULL) OR (char_length(reason) <= 1000))),
    CONSTRAINT crm_opportunity_events_to_status_known CHECK (((to_status IS NULL) OR (to_status = ANY (ARRAY['open'::text, 'won'::text, 'lost'::text]))))
);

CREATE TABLE crm_pipeline_stages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    pipeline_id uuid NOT NULL,
    key text NOT NULL,
    label text NOT NULL,
    "position" integer NOT NULL,
    probability_bp integer NOT NULL,
    outcome text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT crm_pipeline_stages_key_shape CHECK ((key ~ '^[a-z][a-z0-9_]{0,39}$'::text)),
    CONSTRAINT crm_pipeline_stages_label_present CHECK (((btrim(label) <> ''::text) AND (char_length(label) <= 100))),
    CONSTRAINT crm_pipeline_stages_outcome_known CHECK ((outcome = ANY (ARRAY['open'::text, 'won'::text, 'lost'::text]))),
    CONSTRAINT crm_pipeline_stages_position_positive CHECK (("position" > 0)),
    CONSTRAINT crm_pipeline_stages_probability_range CHECK (((probability_bp >= 0) AND (probability_bp <= 10000)))
);

CREATE TABLE crm_pipelines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    archived_at timestamp with time zone,
    CONSTRAINT crm_pipelines_default_is_current CHECK ((NOT (is_default AND (archived_at IS NOT NULL)))),
    CONSTRAINT crm_pipelines_name_present CHECK (((btrim(name) <> ''::text) AND (char_length(name) <= 100)))
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY crm_activities
    ADD CONSTRAINT crm_activities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY crm_activities
    ADD CONSTRAINT crm_activities_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY crm_activity_customers
    ADD CONSTRAINT crm_activity_customers_pkey PRIMARY KEY (tenant_id, activity_id, customer_id);

ALTER TABLE ONLY crm_activity_leads
    ADD CONSTRAINT crm_activity_leads_pkey PRIMARY KEY (tenant_id, activity_id, lead_id);

ALTER TABLE ONLY crm_activity_opportunities
    ADD CONSTRAINT crm_activity_opportunities_pkey PRIMARY KEY (tenant_id, activity_id, opportunity_id);

ALTER TABLE ONLY crm_leads
    ADD CONSTRAINT crm_leads_pkey PRIMARY KEY (id);

ALTER TABLE ONLY crm_leads
    ADD CONSTRAINT crm_leads_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY crm_opportunities
    ADD CONSTRAINT crm_opportunities_pkey PRIMARY KEY (id);

ALTER TABLE ONLY crm_opportunities
    ADD CONSTRAINT crm_opportunities_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY crm_opportunity_amounts
    ADD CONSTRAINT crm_opportunity_amounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY crm_opportunity_amounts
    ADD CONSTRAINT crm_opportunity_amounts_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY crm_opportunity_events
    ADD CONSTRAINT crm_opportunity_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY crm_pipeline_stages
    ADD CONSTRAINT crm_pipeline_stages_key_unique UNIQUE (tenant_id, pipeline_id, key);

ALTER TABLE ONLY crm_pipeline_stages
    ADD CONSTRAINT crm_pipeline_stages_pipeline_id_unique UNIQUE (tenant_id, pipeline_id, id);

ALTER TABLE ONLY crm_pipeline_stages
    ADD CONSTRAINT crm_pipeline_stages_pkey PRIMARY KEY (id);

ALTER TABLE ONLY crm_pipeline_stages
    ADD CONSTRAINT crm_pipeline_stages_position_unique UNIQUE (tenant_id, pipeline_id, "position");

ALTER TABLE ONLY crm_pipeline_stages
    ADD CONSTRAINT crm_pipeline_stages_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY crm_pipelines
    ADD CONSTRAINT crm_pipelines_pkey PRIMARY KEY (id);

ALTER TABLE ONLY crm_pipelines
    ADD CONSTRAINT crm_pipelines_tenant_id_unique UNIQUE (tenant_id, id);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX crm_activities_assignee_idx ON crm_activities USING btree (tenant_id, assigned_to, status, due_at);

CREATE INDEX crm_activities_due_idx ON crm_activities USING btree (tenant_id, status, due_at, id);

CREATE INDEX crm_activities_recent_idx ON crm_activities USING btree (tenant_id, created_at DESC, id);

CREATE INDEX crm_activity_customers_customer_idx ON crm_activity_customers USING btree (tenant_id, customer_id);

CREATE INDEX crm_activity_leads_lead_idx ON crm_activity_leads USING btree (tenant_id, lead_id);

CREATE INDEX crm_activity_opportunities_opportunity_idx ON crm_activity_opportunities USING btree (tenant_id, opportunity_id);

CREATE INDEX crm_leads_assignee_idx ON crm_leads USING btree (tenant_id, assigned_to, status);

CREATE INDEX crm_leads_customer_idx ON crm_leads USING btree (tenant_id, converted_customer_id) WHERE (converted_customer_id IS NOT NULL);

CREATE INDEX crm_leads_email_idx ON crm_leads USING btree (tenant_id, email_normalized) WHERE (email_normalized IS NOT NULL);

CREATE INDEX crm_leads_phone_idx ON crm_leads USING btree (tenant_id, phone_digits) WHERE (phone_digits IS NOT NULL);

CREATE INDEX crm_leads_search_idx ON crm_leads USING gin (search);

CREATE INDEX crm_leads_status_idx ON crm_leads USING btree (tenant_id, status, created_at DESC, id);

CREATE INDEX crm_opportunities_close_idx ON crm_opportunities USING btree (tenant_id, expected_close_date) WHERE (status = 'open'::text);

CREATE INDEX crm_opportunities_customer_idx ON crm_opportunities USING btree (tenant_id, customer_id) WHERE (customer_id IS NOT NULL);

CREATE INDEX crm_opportunities_lead_idx ON crm_opportunities USING btree (tenant_id, lead_id) WHERE (lead_id IS NOT NULL);

CREATE INDEX crm_opportunities_list_idx ON crm_opportunities USING btree (tenant_id, created_at DESC, id);

CREATE INDEX crm_opportunities_owner_idx ON crm_opportunities USING btree (tenant_id, owner_id, status);

CREATE INDEX crm_opportunities_search_idx ON crm_opportunities USING gin (search);

CREATE INDEX crm_opportunities_stage_idx ON crm_opportunities USING btree (tenant_id, stage_id, status);

CREATE INDEX crm_opportunity_amounts_by_opportunity ON crm_opportunity_amounts USING btree (tenant_id, opportunity_id, changed_at DESC);

CREATE INDEX crm_opportunity_events_opportunity_idx ON crm_opportunity_events USING btree (tenant_id, opportunity_id, occurred_at DESC);

CREATE UNIQUE INDEX crm_pipelines_name_unique ON crm_pipelines USING btree (tenant_id, lower(name));

CREATE UNIQUE INDEX crm_pipelines_one_default ON crm_pipelines USING btree (tenant_id) WHERE is_default;

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY crm_activities
    ADD CONSTRAINT crm_activities_assignee_fk FOREIGN KEY (tenant_id, assigned_to) REFERENCES tenant_users(tenant_id, user_id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_activities
    ADD CONSTRAINT crm_activities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_activity_customers
    ADD CONSTRAINT crm_activity_customers_activity_fk FOREIGN KEY (tenant_id, activity_id) REFERENCES crm_activities(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_activity_customers
    ADD CONSTRAINT crm_activity_customers_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_activity_customers
    ADD CONSTRAINT crm_activity_customers_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_activity_leads
    ADD CONSTRAINT crm_activity_leads_activity_fk FOREIGN KEY (tenant_id, activity_id) REFERENCES crm_activities(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_activity_leads
    ADD CONSTRAINT crm_activity_leads_lead_fk FOREIGN KEY (tenant_id, lead_id) REFERENCES crm_leads(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_activity_leads
    ADD CONSTRAINT crm_activity_leads_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_activity_opportunities
    ADD CONSTRAINT crm_activity_opportunities_activity_fk FOREIGN KEY (tenant_id, activity_id) REFERENCES crm_activities(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_activity_opportunities
    ADD CONSTRAINT crm_activity_opportunities_opportunity_fk FOREIGN KEY (tenant_id, opportunity_id) REFERENCES crm_opportunities(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_activity_opportunities
    ADD CONSTRAINT crm_activity_opportunities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_leads
    ADD CONSTRAINT crm_leads_assignee_fk FOREIGN KEY (tenant_id, assigned_to) REFERENCES tenant_users(tenant_id, user_id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_leads
    ADD CONSTRAINT crm_leads_contact_fk FOREIGN KEY (tenant_id, converted_customer_id, converted_contact_id) REFERENCES customer_contacts(tenant_id, customer_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_leads
    ADD CONSTRAINT crm_leads_customer_fk FOREIGN KEY (tenant_id, converted_customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_leads
    ADD CONSTRAINT crm_leads_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_opportunities
    ADD CONSTRAINT crm_opportunities_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_opportunities
    ADD CONSTRAINT crm_opportunities_lead_fk FOREIGN KEY (tenant_id, lead_id) REFERENCES crm_leads(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_opportunities
    ADD CONSTRAINT crm_opportunities_owner_fk FOREIGN KEY (tenant_id, owner_id) REFERENCES tenant_users(tenant_id, user_id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_opportunities
    ADD CONSTRAINT crm_opportunities_stage_fk FOREIGN KEY (tenant_id, pipeline_id, stage_id) REFERENCES crm_pipeline_stages(tenant_id, pipeline_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_opportunities
    ADD CONSTRAINT crm_opportunities_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_opportunity_amounts
    ADD CONSTRAINT crm_opportunity_amounts_opportunity_fk FOREIGN KEY (tenant_id, opportunity_id) REFERENCES crm_opportunities(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_opportunity_amounts
    ADD CONSTRAINT crm_opportunity_amounts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_opportunity_events
    ADD CONSTRAINT crm_opportunity_events_from_stage_fk FOREIGN KEY (tenant_id, from_stage_id) REFERENCES crm_pipeline_stages(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_opportunity_events
    ADD CONSTRAINT crm_opportunity_events_opportunity_fk FOREIGN KEY (tenant_id, opportunity_id) REFERENCES crm_opportunities(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_opportunity_events
    ADD CONSTRAINT crm_opportunity_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_opportunity_events
    ADD CONSTRAINT crm_opportunity_events_to_stage_fk FOREIGN KEY (tenant_id, to_stage_id) REFERENCES crm_pipeline_stages(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_pipeline_stages
    ADD CONSTRAINT crm_pipeline_stages_pipeline_fk FOREIGN KEY (tenant_id, pipeline_id) REFERENCES crm_pipelines(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_pipeline_stages
    ADD CONSTRAINT crm_pipeline_stages_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY crm_pipelines
    ADD CONSTRAINT crm_pipelines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER crm_activities_set_updated_at BEFORE UPDATE ON crm_activities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER crm_leads_guard_conversion BEFORE UPDATE ON crm_leads FOR EACH ROW EXECUTE FUNCTION crm_leads_guard_conversion();

CREATE TRIGGER crm_leads_set_updated_at BEFORE UPDATE ON crm_leads FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER crm_opportunities_check_stage BEFORE INSERT OR UPDATE OF stage_id, pipeline_id, status ON crm_opportunities FOR EACH ROW EXECUTE FUNCTION crm_opportunities_check_stage();

CREATE TRIGGER crm_opportunities_record_amount AFTER INSERT OR UPDATE OF amount, currency_code ON crm_opportunities FOR EACH ROW EXECUTE FUNCTION crm_opportunity_record_amount();

CREATE TRIGGER crm_opportunities_set_updated_at BEFORE UPDATE ON crm_opportunities FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER crm_pipelines_set_updated_at BEFORE UPDATE ON crm_pipelines FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE crm_activities ENABLE ROW LEVEL SECURITY;

ALTER TABLE crm_activity_customers ENABLE ROW LEVEL SECURITY;

ALTER TABLE crm_activity_leads ENABLE ROW LEVEL SECURITY;

ALTER TABLE crm_activity_opportunities ENABLE ROW LEVEL SECURITY;

ALTER TABLE crm_leads ENABLE ROW LEVEL SECURITY;

ALTER TABLE crm_opportunities ENABLE ROW LEVEL SECURITY;

ALTER TABLE crm_opportunity_amounts ENABLE ROW LEVEL SECURITY;

ALTER TABLE crm_opportunity_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE crm_pipeline_stages ENABLE ROW LEVEL SECURITY;

ALTER TABLE crm_pipelines ENABLE ROW LEVEL SECURITY;

CREATE POLICY crm_activities_isolation ON crm_activities TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY crm_activity_customers_isolation ON crm_activity_customers TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY crm_activity_leads_isolation ON crm_activity_leads TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY crm_activity_opportunities_isolation ON crm_activity_opportunities TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY crm_leads_isolation ON crm_leads TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY crm_opportunities_isolation ON crm_opportunities TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY crm_opportunity_amounts_isolation ON crm_opportunity_amounts FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

CREATE POLICY crm_opportunity_events_isolation ON crm_opportunity_events TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY crm_pipeline_stages_isolation ON crm_pipeline_stages TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY crm_pipelines_isolation ON crm_pipelines TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON TABLE crm_activities IS 'Calls, emails, meetings, notes, follow-ups and tasks, linked to leads, customers and opportunities through join tables.';

COMMENT ON TABLE crm_leads IS 'A prospect that is not a customer yet. Converts once into a customer (existing or new); archived rather than deleted.';

COMMENT ON COLUMN crm_leads.version IS 'Optimistic concurrency: an edit names the version it read, and loses to a newer one.';

COMMENT ON TABLE crm_opportunities IS 'A deal being worked on. Its amount is an estimate, not revenue; winning it creates nothing by itself.';

COMMENT ON TABLE crm_opportunity_amounts IS 'Each amount or currency an opportunity has had, from when it changed (ADR-0013). Written only by trigger.';

COMMENT ON COLUMN crm_pipeline_stages.outcome IS 'What reaching this stage means for an opportunity: still open, won or lost.';

COMMENT ON TABLE crm_pipelines IS 'A company''s sales pipeline. The default one is created on first use, with six stages.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION crm_opportunity_record_amount() FROM PUBLIC;

GRANT SELECT,INSERT,UPDATE ON TABLE crm_activities TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE crm_activities TO integr8_platform;

GRANT SELECT,INSERT ON TABLE crm_activity_customers TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE crm_activity_customers TO integr8_platform;

GRANT SELECT,INSERT ON TABLE crm_activity_leads TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE crm_activity_leads TO integr8_platform;

GRANT SELECT,INSERT ON TABLE crm_activity_opportunities TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE crm_activity_opportunities TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE crm_leads TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE crm_leads TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE crm_opportunities TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE crm_opportunities TO integr8_platform;

GRANT SELECT ON TABLE crm_opportunity_amounts TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE crm_opportunity_amounts TO integr8_platform;

GRANT SELECT,INSERT ON TABLE crm_opportunity_events TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE crm_opportunity_events TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE crm_pipeline_stages TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE crm_pipeline_stages TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE crm_pipelines TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE crm_pipelines TO integr8_platform;
