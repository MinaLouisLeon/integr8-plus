-- Integr8's own records: staff sessions and audit, billing, sign-up, exports and deletions.
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

CREATE FUNCTION public.purge_tenant(p_tenant uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    SET session_replication_role TO 'replica'
    AS $_$
declare
  scheduled uuid;
  doomed    text[];
  candidate text;
begin
  -- Still set for anything that asks; with triggers off, nothing here does.
  perform set_config('integr8.purging', p_tenant::text, true);

  select d.id into scheduled
    from public.tenant_deletions d
   where d.tenant_id = p_tenant
     and d.cancelled_at is null
     and d.completed_at is null
     and d.purge_after <= now();

  if scheduled is null then
    raise exception 'tenant % is not scheduled for deletion, or its cooling-off has not passed', p_tenant
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  -- Every table with a tenant_id foreign key to tenants, in `public` only. The
  -- schema predicates matter: the delete below names `public.%I`, so a table
  -- of the same name in another schema would either raise undefined_table and
  -- stop every purge for ever, or name a real public table that was never
  -- meant to be in the list. A year partition is emptied through its parent.
  select array_agg(distinct child.relname::text)
    into doomed
    from pg_constraint con
    join pg_class child on child.oid = con.conrelid
    join pg_class parent on parent.oid = con.confrelid
    join pg_attribute att on att.attrelid = child.oid and att.attnum = any (con.conkey)
   where con.contype = 'f'
     and parent.relname = 'tenants'
     and parent.relnamespace = 'public'::regnamespace
     and child.relnamespace = 'public'::regnamespace
     and not child.relispartition
     and att.attname = 'tenant_id';

  foreach candidate in array coalesce(doomed, array[]::text[]) loop
    execute format('delete from public.%I where tenant_id = $1', candidate) using p_tenant;
  end loop;

  delete from public.tenants where id = p_tenant;

  update public.tenant_deletions set completed_at = now() where id = scheduled;

  perform set_config('integr8.purging', '', true);
end;
$_$;

CREATE FUNCTION public.reject_platform_audit_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
begin
  raise exception 'platform_audit_log is append-only; % is not allowed', tg_op
    using errcode = 'insufficient_privilege';
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE announcements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid,
    severity text DEFAULT 'info'::text NOT NULL,
    message jsonb NOT NULL,
    starts_at timestamp with time zone DEFAULT now() NOT NULL,
    ends_at timestamp with time zone,
    dismissible boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT announcements_message_is_object CHECK ((jsonb_typeof(message) = 'object'::text)),
    CONSTRAINT announcements_message_not_empty CHECK ((message <> '{}'::jsonb)),
    CONSTRAINT announcements_severity_known CHECK ((severity = ANY (ARRAY['info'::text, 'warning'::text, 'critical'::text]))),
    CONSTRAINT announcements_window_ordered CHECK (((ends_at IS NULL) OR (ends_at > starts_at)))
);

CREATE TABLE billing_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    provider_event_id text NOT NULL,
    type text NOT NULL,
    tenant_id uuid,
    payload jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    error text
);

CREATE TABLE platform_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    platform_user_id uuid,
    actor_label text NOT NULL,
    action text NOT NULL,
    tenant_id uuid,
    tenant_slug text,
    target_kind text,
    target_id text,
    reason text,
    request_id text,
    ip_address inet,
    user_agent text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT platform_audit_log_action_not_blank CHECK ((btrim(action) <> ''::text)),
    CONSTRAINT platform_audit_log_actor_label_not_blank CHECK ((btrim(actor_label) <> ''::text)),
    CONSTRAINT platform_audit_log_metadata_is_object CHECK ((jsonb_typeof(metadata) = 'object'::text))
)
PARTITION BY RANGE (occurred_at);

CREATE TABLE platform_refresh_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    session_id uuid NOT NULL,
    token_hash text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    used_at timestamp with time zone,
    replaced_by uuid,
    CONSTRAINT platform_refresh_tokens_expires_after_creation CHECK ((expires_at > created_at))
);

CREATE TABLE platform_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    platform_user_id uuid NOT NULL,
    user_agent text,
    ip_address inet,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    revoked_reason text,
    scope text DEFAULT 'full'::text NOT NULL,
    CONSTRAINT platform_sessions_expires_after_creation CHECK ((expires_at > created_at)),
    CONSTRAINT platform_sessions_revoked_pair CHECK (((revoked_at IS NULL) = (revoked_reason IS NULL))),
    CONSTRAINT platform_sessions_revoked_reason_known CHECK (((revoked_reason IS NULL) OR (revoked_reason = ANY (ARRAY['signed_out'::text, 'signed_out_everywhere'::text, 'refresh_token_reuse'::text, 'account_disabled'::text, 'password_changed'::text])))),
    CONSTRAINT platform_sessions_scope_known CHECK ((scope = ANY (ARRAY['full'::text, 'test_companies'::text])))
);

CREATE TABLE signup_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    step text NOT NULL,
    signup_id uuid,
    tenant_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
)
PARTITION BY RANGE (occurred_at);

CREATE TABLE signup_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    company_name text NOT NULL,
    token_hash text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    verified_at timestamp with time zone,
    tenant_id uuid,
    ip_address inet,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resend_count integer DEFAULT 0 NOT NULL,
    CONSTRAINT signup_requests_email_shape CHECK ((POSITION(('@'::text) IN (email)) > 1)),
    CONSTRAINT signup_requests_resend_count_sane CHECK ((resend_count >= 0)),
    CONSTRAINT signup_requests_status_known CHECK ((status = ANY (ARRAY['pending'::text, 'verifying'::text, 'verified'::text, 'expired'::text, 'abandoned'::text]))),
    CONSTRAINT signup_requests_verified_pair CHECK (((status = 'verified'::text) = (verified_at IS NOT NULL)))
);

CREATE TABLE subscriptions (
    tenant_id uuid NOT NULL,
    provider text NOT NULL,
    provider_customer_id text,
    provider_subscription_id text,
    status text DEFAULT 'trialing'::text NOT NULL,
    plan text DEFAULT 'trial'::text NOT NULL,
    billing_interval text,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false NOT NULL,
    trial_ends_at timestamp with time zone,
    past_due_since timestamp with time zone,
    grace_ends_at timestamp with time zone,
    reminders_sent integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT subscriptions_dunning_pair CHECK (((past_due_since IS NULL) = (grace_ends_at IS NULL))),
    CONSTRAINT subscriptions_interval_known CHECK (((billing_interval IS NULL) OR (billing_interval = ANY (ARRAY['month'::text, 'year'::text])))),
    CONSTRAINT subscriptions_period_order CHECK (((current_period_start IS NULL) OR (current_period_end IS NULL) OR (current_period_end > current_period_start))),
    CONSTRAINT subscriptions_plan_known CHECK ((plan = ANY (ARRAY['trial'::text, 'starter'::text, 'standard'::text, 'enterprise'::text]))),
    CONSTRAINT subscriptions_reminders_sane CHECK ((reminders_sent >= 0)),
    CONSTRAINT subscriptions_status_known CHECK ((status = ANY (ARRAY['trialing'::text, 'active'::text, 'past_due'::text, 'canceled'::text, 'incomplete'::text])))
);

CREATE TABLE tenant_deletions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    tenant_slug text NOT NULL,
    export_id uuid NOT NULL,
    requested_by uuid,
    reason text NOT NULL,
    purge_after timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    cancelled_at timestamp with time zone,
    cancelled_by uuid,
    completed_at timestamp with time zone,
    CONSTRAINT tenant_deletions_cancelled_pair CHECK (((cancelled_at IS NULL) = (cancelled_by IS NULL))),
    CONSTRAINT tenant_deletions_not_both_ways CHECK (((cancelled_at IS NULL) OR (completed_at IS NULL))),
    CONSTRAINT tenant_deletions_reason_meaningful CHECK ((length(btrim(reason)) >= 10))
);

CREATE TABLE tenant_exports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    tenant_slug text NOT NULL,
    requested_by uuid,
    status text DEFAULT 'pending'::text NOT NULL,
    object_key text,
    byte_size bigint,
    contents jsonb DEFAULT '{}'::jsonb NOT NULL,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone,
    CONSTRAINT tenant_exports_byte_size_sane CHECK (((byte_size IS NULL) OR (byte_size >= 0))),
    CONSTRAINT tenant_exports_contents_is_object CHECK ((jsonb_typeof(contents) = 'object'::text)),
    CONSTRAINT tenant_exports_ready_has_object CHECK (((status <> 'ready'::text) OR (object_key IS NOT NULL))),
    CONSTRAINT tenant_exports_status_known CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'ready'::text, 'failed'::text])))
);

CREATE TABLE test_outbox (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    channel text NOT NULL,
    recipient text NOT NULL,
    subject text,
    body text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT test_outbox_body_length CHECK ((char_length(body) <= 100000)),
    CONSTRAINT test_outbox_channel_known CHECK ((channel = ANY (ARRAY['email'::text, 'push'::text]))),
    CONSTRAINT test_outbox_recipient_length CHECK (((char_length(recipient) >= 1) AND (char_length(recipient) <= 320))),
    CONSTRAINT test_outbox_subject_length CHECK (((subject IS NULL) OR (char_length(subject) <= 500)))
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);

ALTER TABLE ONLY billing_events
    ADD CONSTRAINT billing_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY billing_events
    ADD CONSTRAINT billing_events_provider_event_unique UNIQUE (provider, provider_event_id);

ALTER TABLE platform_audit_log
    ADD CONSTRAINT platform_audit_log_pkey PRIMARY KEY (id, occurred_at);

ALTER TABLE ONLY platform_refresh_tokens
    ADD CONSTRAINT platform_refresh_tokens_hash_unique UNIQUE (token_hash);

ALTER TABLE ONLY platform_refresh_tokens
    ADD CONSTRAINT platform_refresh_tokens_pkey PRIMARY KEY (id);

ALTER TABLE ONLY platform_sessions
    ADD CONSTRAINT platform_sessions_pkey PRIMARY KEY (id);

ALTER TABLE signup_events
    ADD CONSTRAINT signup_events_pkey PRIMARY KEY (id, occurred_at);

ALTER TABLE ONLY signup_requests
    ADD CONSTRAINT signup_requests_pkey PRIMARY KEY (id);

ALTER TABLE ONLY signup_requests
    ADD CONSTRAINT signup_requests_token_unique UNIQUE (token_hash);

ALTER TABLE ONLY subscriptions
    ADD CONSTRAINT subscriptions_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY subscriptions
    ADD CONSTRAINT subscriptions_provider_subscription_unique UNIQUE (provider, provider_subscription_id);

ALTER TABLE ONLY tenant_deletions
    ADD CONSTRAINT tenant_deletions_pkey PRIMARY KEY (id);

ALTER TABLE ONLY tenant_exports
    ADD CONSTRAINT tenant_exports_pkey PRIMARY KEY (id);

ALTER TABLE ONLY test_outbox
    ADD CONSTRAINT test_outbox_pkey PRIMARY KEY (id);

ALTER TABLE ONLY test_outbox
    ADD CONSTRAINT test_outbox_tenant_id_unique UNIQUE (tenant_id, id);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX announcements_live_idx ON announcements USING btree (starts_at, ends_at);

CREATE INDEX billing_events_recent_idx ON billing_events USING btree (received_at DESC);

CREATE INDEX billing_events_unprocessed_idx ON billing_events USING btree (received_at) WHERE (processed_at IS NULL);

CREATE INDEX platform_audit_log_actor_idx ON platform_audit_log USING btree (platform_user_id, occurred_at DESC);

CREATE INDEX platform_audit_log_recent_idx ON platform_audit_log USING btree (occurred_at DESC);

CREATE INDEX platform_audit_log_tenant_idx ON platform_audit_log USING btree (tenant_id, occurred_at DESC);

CREATE INDEX platform_refresh_tokens_session_idx ON platform_refresh_tokens USING btree (session_id);

CREATE INDEX platform_sessions_live_idx ON platform_sessions USING btree (platform_user_id) WHERE (revoked_at IS NULL);

CREATE INDEX signup_events_signup_idx ON signup_events USING btree (signup_id) WHERE (signup_id IS NOT NULL);

CREATE INDEX signup_events_step_idx ON signup_events USING btree (step, occurred_at DESC);

CREATE INDEX signup_requests_email_idx ON signup_requests USING btree (lower(email), created_at DESC);

CREATE INDEX signup_requests_pending_idx ON signup_requests USING btree (expires_at) WHERE (status = 'pending'::text);

CREATE INDEX subscriptions_dunning_idx ON subscriptions USING btree (grace_ends_at) WHERE (grace_ends_at IS NOT NULL);

CREATE INDEX subscriptions_trial_idx ON subscriptions USING btree (trial_ends_at) WHERE (status = 'trialing'::text);

CREATE UNIQUE INDEX tenant_deletions_pending_idx ON tenant_deletions USING btree (tenant_id) WHERE ((cancelled_at IS NULL) AND (completed_at IS NULL));

CREATE INDEX tenant_exports_tenant_idx ON tenant_exports USING btree (tenant_id, created_at DESC);

CREATE INDEX test_outbox_recent ON test_outbox USING btree (tenant_id, created_at DESC);

CREATE INDEX test_outbox_retention ON test_outbox USING btree (created_at);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY announcements
    ADD CONSTRAINT announcements_created_by_fkey FOREIGN KEY (created_by) REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE ONLY announcements
    ADD CONSTRAINT announcements_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY billing_events
    ADD CONSTRAINT billing_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL;

ALTER TABLE platform_audit_log
    ADD CONSTRAINT platform_audit_log_platform_user_id_fkey FOREIGN KEY (platform_user_id) REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE ONLY platform_refresh_tokens
    ADD CONSTRAINT platform_refresh_tokens_replaced_by_fkey FOREIGN KEY (replaced_by) REFERENCES platform_refresh_tokens(id) ON DELETE SET NULL;

ALTER TABLE ONLY platform_refresh_tokens
    ADD CONSTRAINT platform_refresh_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES platform_sessions(id) ON DELETE CASCADE;

ALTER TABLE ONLY platform_sessions
    ADD CONSTRAINT platform_sessions_platform_user_id_fkey FOREIGN KEY (platform_user_id) REFERENCES platform_users(id) ON DELETE CASCADE;

ALTER TABLE signup_events
    ADD CONSTRAINT signup_events_signup_id_fkey FOREIGN KEY (signup_id) REFERENCES signup_requests(id) ON DELETE SET NULL;

ALTER TABLE signup_events
    ADD CONSTRAINT signup_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL;

ALTER TABLE ONLY signup_requests
    ADD CONSTRAINT signup_requests_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL;

ALTER TABLE ONLY subscriptions
    ADD CONSTRAINT subscriptions_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY tenant_deletions
    ADD CONSTRAINT tenant_deletions_cancelled_by_fkey FOREIGN KEY (cancelled_by) REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE ONLY tenant_deletions
    ADD CONSTRAINT tenant_deletions_export_id_fkey FOREIGN KEY (export_id) REFERENCES tenant_exports(id) ON DELETE RESTRICT;

ALTER TABLE ONLY tenant_deletions
    ADD CONSTRAINT tenant_deletions_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE ONLY tenant_exports
    ADD CONSTRAINT tenant_exports_requested_by_fkey FOREIGN KEY (requested_by) REFERENCES platform_users(id) ON DELETE SET NULL;

ALTER TABLE ONLY test_outbox
    ADD CONSTRAINT test_outbox_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER announcements_set_updated_at BEFORE UPDATE ON announcements FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER platform_audit_log_no_delete BEFORE DELETE ON platform_audit_log FOR EACH STATEMENT EXECUTE FUNCTION reject_platform_audit_mutation();

CREATE TRIGGER platform_audit_log_no_truncate BEFORE TRUNCATE ON platform_audit_log FOR EACH STATEMENT EXECUTE FUNCTION reject_platform_audit_mutation();

CREATE TRIGGER platform_audit_log_no_update BEFORE UPDATE ON platform_audit_log FOR EACH STATEMENT EXECUTE FUNCTION reject_platform_audit_mutation();

CREATE TRIGGER subscriptions_set_updated_at BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE announcements ENABLE ROW LEVEL SECURITY;

ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE platform_audit_log ENABLE ROW LEVEL SECURITY;

ALTER TABLE platform_refresh_tokens ENABLE ROW LEVEL SECURITY;

ALTER TABLE platform_sessions ENABLE ROW LEVEL SECURITY;

ALTER TABLE signup_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE signup_requests ENABLE ROW LEVEL SECURITY;

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenant_deletions ENABLE ROW LEVEL SECURITY;

ALTER TABLE tenant_exports ENABLE ROW LEVEL SECURITY;

ALTER TABLE test_outbox ENABLE ROW LEVEL SECURITY;

CREATE POLICY billing_events_platform_only ON billing_events USING (false);

CREATE POLICY signup_events_platform_only ON signup_events USING (false);

CREATE POLICY signup_requests_platform_only ON signup_requests USING (false);

CREATE POLICY subscriptions_isolation ON subscriptions USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY test_outbox_isolation ON test_outbox TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION purge_tenant(p_tenant uuid) IS 'Deletes every row belonging to one company, with triggers and foreign-key checks suspended for the call. Refuses unless a deletion is scheduled and its cooling-off has passed.';

COMMENT ON TABLE announcements IS 'A banner for one company or for every company, between two moments. Written by the platform, read by every client through /v1/me.';

COMMENT ON TABLE billing_events IS 'Every webhook the billing provider delivered, kept whether or not it was understood (0017). The unique constraint on the provider event id is what makes a duplicate delivery a no-op.';

COMMENT ON TABLE platform_audit_log IS 'Every super-admin action, append-only. Tenant-less by design: it outlives the companies it mentions.';

COMMENT ON TABLE platform_refresh_tokens IS 'One row per platform refresh token ever issued, chained. Presenting a spent token is theft, and ends the session.';

COMMENT ON TABLE platform_sessions IS 'One signed-in browser for a super admin. Short-lived by design: this session can reach every company.';

COMMENT ON COLUMN platform_sessions.scope IS 'What the session may reach (0077): ''full'' (the dashboard) or ''test_companies'' (the developer MCP server, 8 hours).';

COMMENT ON TABLE signup_events IS 'The signup funnel (0018). Deliberately not the audit log: audit_log is tenant-scoped and every interesting step here happens before a tenant exists. Carries no personal data — it answers how many gave up at a step, never who.';

COMMENT ON TABLE signup_requests IS 'Somebody asking for a company, before one exists (0018). Nothing is provisioned until the emailed token comes back: no tenant, no bucket, no trial. A request nobody verifies simply expires.';

COMMENT ON TABLE subscriptions IS 'What one company is paying for and where it stands (0017). The provider is a string rather than a type, because a market needing a regional provider must not need a migration; nothing above this table learns which one it is.';

COMMENT ON TABLE tenant_deletions IS 'A company scheduled for deletion: which export was taken first, why, and when the purge may run. Cancelling before then undoes it.';

COMMENT ON TABLE tenant_exports IS 'A full export of one company: every row as JSON, with a manifest of its files. Taken before a company may be deleted.';

COMMENT ON TABLE test_outbox IS 'Mail and push a test company would have sent (0077), kept 7 days for the developer MCP server.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

REVOKE ALL ON FUNCTION purge_tenant(p_tenant uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION purge_tenant(p_tenant uuid) TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE announcements TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE billing_events TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE platform_audit_log TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE platform_refresh_tokens TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE platform_sessions TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE signup_events TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE signup_requests TO integr8_platform;

GRANT SELECT ON TABLE subscriptions TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE subscriptions TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE tenant_deletions TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE tenant_exports TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE test_outbox TO integr8_platform;
GRANT SELECT ON TABLE test_outbox TO integr8_app;

-- ---------------------------------------------------------------------------
-- Year partitions for the tables above (see 0001)
-- ---------------------------------------------------------------------------

SELECT ensure_year_partitions();
