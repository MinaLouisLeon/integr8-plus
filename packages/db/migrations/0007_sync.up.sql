-- Phone sync: the change log and sync reports.
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

CREATE FUNCTION public.prune_sync_touches(tenant uuid, older_than interval) RETURNS bigint
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  boundary xid8;
  removed bigint;
begin
  if tenant is distinct from public.app_current_tenant_id() then
    raise exception 'prune_sync_touches may only prune the current company' using errcode = '42501';
  end if;
  select max(xid) into boundary
  from public.sync_touches
  where tenant_id = tenant and created_at < now() - older_than;
  if boundary is null then
    return 0;
  end if;
  delete from public.sync_touches where tenant_id = tenant and xid <= boundary;
  get diagnostics removed = row_count;
  insert into public.sync_log_marks (tenant_id, pruned_before)
  values (tenant, boundary)
  on conflict (tenant_id) do update
    set pruned_before = greatest(public.sync_log_marks.pruned_before, excluded.pruned_before);
  return removed;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE sync_log_marks (
    tenant_id uuid NOT NULL,
    pruned_before xid8 NOT NULL
);

CREATE TABLE sync_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    report_id uuid NOT NULL,
    started_at timestamp with time zone NOT NULL,
    duration_ms integer NOT NULL,
    trigger text NOT NULL,
    outcome text NOT NULL,
    pushed integer DEFAULT 0 NOT NULL,
    conflicts integer DEFAULT 0 NOT NULL,
    rejected integer DEFAULT 0 NOT NULL,
    retried integer DEFAULT 0 NOT NULL,
    pulled integer DEFAULT 0 NOT NULL,
    uploads_completed integer DEFAULT 0 NOT NULL,
    uploads_failed integer DEFAULT 0 NOT NULL,
    uploaded_bytes bigint DEFAULT 0 NOT NULL,
    queue_depth integer DEFAULT 0 NOT NULL,
    pending_uploads integer DEFAULT 0 NOT NULL,
    network_type text,
    clock_offset_ms integer,
    app_version text,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sync_reports_counts_sane CHECK (((duration_ms >= 0) AND (pushed >= 0) AND (conflicts >= 0) AND (rejected >= 0) AND (retried >= 0) AND (pulled >= 0) AND (uploads_completed >= 0) AND (uploads_failed >= 0) AND (uploaded_bytes >= 0) AND (queue_depth >= 0) AND (pending_uploads >= 0))),
    CONSTRAINT sync_reports_outcome_known CHECK ((outcome = ANY (ARRAY['complete'::text, 'partial'::text, 'offline'::text, 'failed'::text]))),
    CONSTRAINT sync_reports_trigger_known CHECK ((trigger = ANY (ARRAY['launch'::text, 'foreground'::text, 'reconnect'::text, 'background'::text, 'manual'::text, 'change'::text])))
);

CREATE TABLE sync_touches (
    tenant_id uuid NOT NULL,
    entity_kind text NOT NULL,
    entity_id uuid NOT NULL,
    xid xid8 DEFAULT pg_current_xact_id() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sync_touches_kind_known CHECK ((entity_kind = ANY (ARRAY['work_order'::text, 'customer'::text, 'site'::text, 'form'::text])))
)
PARTITION BY RANGE (created_at);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY sync_log_marks
    ADD CONSTRAINT sync_log_marks_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY sync_reports
    ADD CONSTRAINT sync_reports_pkey PRIMARY KEY (id);

ALTER TABLE ONLY sync_reports
    ADD CONSTRAINT sync_reports_report_unique UNIQUE (tenant_id, report_id);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX sync_reports_tenant_idx ON sync_reports USING btree (tenant_id, started_at DESC);

CREATE INDEX sync_touches_by_entity ON sync_touches USING btree (tenant_id, entity_kind, entity_id, xid);

CREATE INDEX sync_touches_by_xid ON sync_touches USING btree (tenant_id, xid);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY sync_log_marks
    ADD CONSTRAINT sync_log_marks_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY sync_reports
    ADD CONSTRAINT sync_reports_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE sync_touches
    ADD CONSTRAINT sync_touches_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE sync_log_marks ENABLE ROW LEVEL SECURITY;

ALTER TABLE sync_reports ENABLE ROW LEVEL SECURITY;

ALTER TABLE sync_touches ENABLE ROW LEVEL SECURITY;

CREATE POLICY sync_log_marks_isolation ON sync_log_marks FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

CREATE POLICY sync_reports_isolation ON sync_reports TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY sync_touches_isolation ON sync_touches FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION prune_sync_touches(tenant uuid, older_than interval) IS 'Deletes the current company''s sync touches older than an interval and records the boundary. Security definer: the runtime role cannot delete from sync_touches.';

COMMENT ON TABLE sync_log_marks IS 'The oldest transaction id still fully covered by sync_touches for a company.';

COMMENT ON TABLE sync_reports IS 'One sync run as a phone reported it: how long, what moved, what is still waiting. started_at is corrected by the phone''s measured clock offset.';

COMMENT ON TABLE sync_touches IS 'Which records each transaction changed, by transaction id. Written by trigger; a pull reads the touches between its cursor and the oldest running transaction.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT ON TABLE sync_log_marks TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sync_log_marks TO integr8_platform;

GRANT SELECT,INSERT ON TABLE sync_reports TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sync_reports TO integr8_platform;

GRANT SELECT ON TABLE sync_touches TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE sync_touches TO integr8_platform;

-- ---------------------------------------------------------------------------
-- Year partitions for the tables above (see 0001)
-- ---------------------------------------------------------------------------

SELECT ensure_year_partitions();
