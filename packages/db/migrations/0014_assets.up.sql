-- Customer assets and their history.
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

CREATE FUNCTION public.assign_asset_reference() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if tg_op = 'UPDATE' then
    if new.reference is distinct from old.reference then
      raise exception 'An asset keeps its number'
        using errcode = 'check_violation', constraint = 'erp_assets_reference_fixed';
    end if;
    return new;
  end if;
  insert into public.asset_reference_counters as counter (tenant_id, last_reference)
  values (new.tenant_id, 1)
  on conflict (tenant_id) do update set last_reference = counter.last_reference + 1
  returning last_reference into new.reference;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE asset_reference_counters (
    tenant_id uuid NOT NULL,
    last_reference integer NOT NULL
);

CREATE TABLE erp_asset_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    kind text NOT NULL,
    from_customer_id uuid,
    from_site_id uuid,
    from_status text,
    to_status text,
    condition text,
    changes jsonb,
    work_order_id uuid,
    note text,
    actor_id uuid NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    recorded_at timestamp with time zone DEFAULT now() NOT NULL,
    client_action_id text,
    CONSTRAINT erp_asset_events_changes_shape CHECK (((changes IS NULL) OR (jsonb_typeof(changes) = 'object'::text))),
    CONSTRAINT erp_asset_events_client_action_length CHECK (((client_action_id IS NULL) OR ((char_length(client_action_id) >= 1) AND (char_length(client_action_id) <= 100)))),
    CONSTRAINT erp_asset_events_condition_known CHECK (((condition IS NULL) OR (condition = ANY (ARRAY['good'::text, 'fair'::text, 'poor'::text, 'unusable'::text])))),
    CONSTRAINT erp_asset_events_condition_shape CHECK (((kind = 'condition_recorded'::text) = (condition IS NOT NULL))),
    CONSTRAINT erp_asset_events_kind_known CHECK ((kind = ANY (ARRAY['registered'::text, 'updated'::text, 'relocated'::text, 'status_changed'::text, 'condition_recorded'::text, 'tag_reissued'::text]))),
    CONSTRAINT erp_asset_events_note_length CHECK (((note IS NULL) OR (char_length(note) <= 1000))),
    CONSTRAINT erp_asset_events_relocated_shape CHECK ((((kind = 'relocated'::text) = (from_site_id IS NOT NULL)) AND ((from_site_id IS NULL) = (from_customer_id IS NULL)))),
    CONSTRAINT erp_asset_events_status_known CHECK ((((from_status IS NULL) OR (from_status = ANY (ARRAY['active'::text, 'out_of_service'::text, 'retired'::text]))) AND ((to_status IS NULL) OR (to_status = ANY (ARRAY['active'::text, 'out_of_service'::text, 'retired'::text]))))),
    CONSTRAINT erp_asset_events_status_shape CHECK ((((kind = 'status_changed'::text) = (to_status IS NOT NULL)) AND ((to_status IS NULL) = (from_status IS NULL))))
);

CREATE TABLE erp_asset_settings (
    tenant_id uuid NOT NULL,
    warranty_alert_days integer DEFAULT 60 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_asset_settings_alert_range CHECK (((warranty_alert_days >= 0) AND (warranty_alert_days <= 365))),
    CONSTRAINT erp_asset_settings_version_positive CHECK ((version > 0))
);

CREATE TABLE erp_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reference integer DEFAULT 0 NOT NULL,
    customer_id uuid NOT NULL,
    site_id uuid NOT NULL,
    item_id uuid,
    name text NOT NULL,
    make text,
    model text,
    serial_number text,
    location_note text,
    install_date date,
    warranty_expires_on date,
    status text DEFAULT 'active'::text NOT NULL,
    condition text,
    condition_recorded_at timestamp with time zone,
    condition_recorded_by uuid,
    tag_code text NOT NULL,
    notes text,
    client_action_id text,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone,
    retired_by uuid,
    CONSTRAINT erp_assets_client_action_length CHECK (((client_action_id IS NULL) OR ((char_length(client_action_id) >= 1) AND (char_length(client_action_id) <= 100)))),
    CONSTRAINT erp_assets_condition_known CHECK (((condition IS NULL) OR (condition = ANY (ARRAY['good'::text, 'fair'::text, 'poor'::text, 'unusable'::text])))),
    CONSTRAINT erp_assets_condition_pairing CHECK ((((condition IS NULL) = (condition_recorded_at IS NULL)) AND ((condition_recorded_at IS NULL) = (condition_recorded_by IS NULL)))),
    CONSTRAINT erp_assets_name_present CHECK (((btrim(name) <> ''::text) AND (char_length(name) <= 200))),
    CONSTRAINT erp_assets_retired_pairing CHECK ((((status = 'retired'::text) = (retired_at IS NOT NULL)) AND ((retired_at IS NULL) = (retired_by IS NULL)))),
    CONSTRAINT erp_assets_status_known CHECK ((status = ANY (ARRAY['active'::text, 'out_of_service'::text, 'retired'::text]))),
    CONSTRAINT erp_assets_tag_code_shape CHECK ((tag_code ~ '^[0-9A-HJKMNP-TV-Z]{12}$'::text)),
    CONSTRAINT erp_assets_text_lengths CHECK ((((make IS NULL) OR (char_length(make) <= 200)) AND ((model IS NULL) OR (char_length(model) <= 200)) AND ((serial_number IS NULL) OR ((btrim(serial_number) <> ''::text) AND (char_length(serial_number) <= 200))) AND ((location_note IS NULL) OR (char_length(location_note) <= 500)) AND ((notes IS NULL) OR (char_length(notes) <= 2000)))),
    CONSTRAINT erp_assets_version_positive CHECK ((version > 0))
);

CREATE TABLE erp_work_order_assets (
    tenant_id uuid NOT NULL,
    work_order_id uuid NOT NULL,
    asset_id uuid NOT NULL,
    linked_by uuid NOT NULL,
    linked_at timestamp with time zone DEFAULT now() NOT NULL
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY asset_reference_counters
    ADD CONSTRAINT asset_reference_counters_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY erp_asset_events
    ADD CONSTRAINT erp_asset_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_asset_events
    ADD CONSTRAINT erp_asset_events_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_asset_settings
    ADD CONSTRAINT erp_asset_settings_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY erp_assets
    ADD CONSTRAINT erp_assets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_assets
    ADD CONSTRAINT erp_assets_reference_unique UNIQUE (tenant_id, reference);

ALTER TABLE ONLY erp_assets
    ADD CONSTRAINT erp_assets_tag_code_unique UNIQUE (tag_code);

ALTER TABLE ONLY erp_assets
    ADD CONSTRAINT erp_assets_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_work_order_assets
    ADD CONSTRAINT erp_work_order_assets_pkey PRIMARY KEY (tenant_id, work_order_id, asset_id);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX erp_asset_events_by_asset ON erp_asset_events USING btree (tenant_id, asset_id, occurred_at DESC);

CREATE UNIQUE INDEX erp_asset_events_client_action_unique ON erp_asset_events USING btree (tenant_id, client_action_id) WHERE (client_action_id IS NOT NULL);

CREATE INDEX erp_assets_by_customer ON erp_assets USING btree (tenant_id, customer_id, reference);

CREATE INDEX erp_assets_by_site ON erp_assets USING btree (tenant_id, site_id, reference);

CREATE INDEX erp_assets_by_warranty ON erp_assets USING btree (tenant_id, warranty_expires_on) WHERE ((warranty_expires_on IS NOT NULL) AND (status <> 'retired'::text));

CREATE UNIQUE INDEX erp_assets_client_action_unique ON erp_assets USING btree (tenant_id, client_action_id) WHERE (client_action_id IS NOT NULL);

CREATE UNIQUE INDEX erp_assets_serial_unique ON erp_assets USING btree (tenant_id, lower(btrim(serial_number))) WHERE (serial_number IS NOT NULL);

CREATE INDEX erp_work_order_assets_by_asset ON erp_work_order_assets USING btree (tenant_id, asset_id, linked_at DESC);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY asset_reference_counters
    ADD CONSTRAINT asset_reference_counters_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_asset_fk FOREIGN KEY (tenant_id, asset_id) REFERENCES erp_assets(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_asset_events
    ADD CONSTRAINT erp_asset_events_asset_fk FOREIGN KEY (tenant_id, asset_id) REFERENCES erp_assets(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_asset_events
    ADD CONSTRAINT erp_asset_events_from_site_fk FOREIGN KEY (tenant_id, from_customer_id, from_site_id) REFERENCES sites(tenant_id, customer_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_asset_events
    ADD CONSTRAINT erp_asset_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_asset_events
    ADD CONSTRAINT erp_asset_events_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_asset_settings
    ADD CONSTRAINT erp_asset_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_assets
    ADD CONSTRAINT erp_assets_item_fk FOREIGN KEY (tenant_id, item_id) REFERENCES erp_items(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_assets
    ADD CONSTRAINT erp_assets_site_fk FOREIGN KEY (tenant_id, customer_id, site_id) REFERENCES sites(tenant_id, customer_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_assets
    ADD CONSTRAINT erp_assets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_work_order_assets
    ADD CONSTRAINT erp_work_order_assets_asset_fk FOREIGN KEY (tenant_id, asset_id) REFERENCES erp_assets(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_work_order_assets
    ADD CONSTRAINT erp_work_order_assets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_work_order_assets
    ADD CONSTRAINT erp_work_order_assets_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_work_order_materials
    ADD CONSTRAINT erp_work_order_materials_asset_fk FOREIGN KEY (tenant_id, asset_id) REFERENCES erp_assets(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE ONLY submissions
    ADD CONSTRAINT submissions_asset_fk FOREIGN KEY (tenant_id, asset_id) REFERENCES erp_assets(tenant_id, id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER erp_asset_settings_set_updated_at BEFORE UPDATE ON erp_asset_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_assets_assign_reference BEFORE INSERT OR UPDATE ON erp_assets FOR EACH ROW EXECUTE FUNCTION assign_asset_reference();

CREATE TRIGGER erp_assets_set_updated_at BEFORE UPDATE ON erp_assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_assets_touch_sync AFTER INSERT OR UPDATE ON erp_assets FOR EACH ROW EXECUTE FUNCTION touch_sync('site', 'site_id');

CREATE TRIGGER erp_work_order_assets_touch_sync AFTER INSERT OR DELETE ON erp_work_order_assets FOR EACH ROW EXECUTE FUNCTION touch_sync('work_order', 'work_order_id');

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE asset_reference_counters ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_asset_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_asset_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_assets ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_work_order_assets ENABLE ROW LEVEL SECURITY;

CREATE POLICY asset_reference_counters_isolation ON asset_reference_counters FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_asset_events_isolation ON erp_asset_events TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_asset_settings_isolation ON erp_asset_settings TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_assets_isolation ON erp_assets TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_work_order_assets_isolation ON erp_work_order_assets TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION assign_asset_reference() IS 'Numbers an asset when it is created, and keeps the number. Security definer: the runtime role cannot write the counter.';

COMMENT ON TABLE asset_reference_counters IS 'The last asset number handed out per company. Written only by assign_asset_reference.';

COMMENT ON TABLE erp_asset_events IS 'What happened to an asset, appended and never changed: the runtime role may only insert and read.';

COMMENT ON TABLE erp_asset_settings IS 'Per-company asset settings. Absent means the defaults.';

COMMENT ON TABLE erp_assets IS 'A machine a company services, at one customer''s site. Never deleted: retired. Every change that matters appends an erp_asset_events row.';

COMMENT ON TABLE erp_work_order_assets IS 'The assets a job is for: zero or more, at the job''s site when linked.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT ON TABLE asset_reference_counters TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE asset_reference_counters TO integr8_platform;

GRANT SELECT,INSERT ON TABLE erp_asset_events TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_asset_events TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_asset_settings TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_asset_settings TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_assets TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_assets TO integr8_platform;

GRANT SELECT,INSERT,DELETE ON TABLE erp_work_order_assets TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_work_order_assets TO integr8_platform;
