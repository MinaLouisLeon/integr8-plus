-- The AI assistant: conversations, actions, usage and cost.
--
-- Part of the 2.0.0 baseline (P41), generated from the schema that migrations
-- 0001-0079 of release 1.4.0 built; their history and reasoning are in git
-- before 2.0.0. Comments on tables and columns below carry the why.

-- SQL functions may name tables a later module creates; Postgres checks
-- their bodies when they are first called rather than here.
set local check_function_bodies = false;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE ai_action_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    proposal_id uuid NOT NULL,
    actor_user_id uuid,
    action text NOT NULL,
    code text,
    request_id text,
    details jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
)
PARTITION BY RANGE (created_at);

CREATE TABLE ai_action_proposals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    tool_key text NOT NULL,
    typed_payload jsonb NOT NULL,
    payload_schema_version integer DEFAULT 1 NOT NULL,
    display_summary jsonb NOT NULL,
    request_digest text NOT NULL,
    resource_versions jsonb DEFAULT '{}'::jsonb NOT NULL,
    state text DEFAULT 'pending'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    confirmed_at timestamp with time zone,
    result_resource_type text,
    result_resource_id uuid,
    result_summary jsonb,
    execution_idempotency_key text,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_action_proposals_state_known CHECK ((state = ANY (ARRAY['pending'::text, 'confirmed'::text, 'executing'::text, 'completed'::text, 'rejected'::text, 'expired'::text, 'failed'::text]))),
    CONSTRAINT ai_action_proposals_tool_key_shape CHECK ((tool_key ~ '^[a-z][a-z0-9_]{0,63}$'::text))
);

CREATE TABLE ai_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    created_by_user_id uuid NOT NULL,
    title text,
    locale text DEFAULT 'en'::text NOT NULL,
    level_at_creation text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT ai_conversations_level_known CHECK ((level_at_creation = ANY (ARRAY['help'::text, 'insights'::text, 'agent'::text]))),
    CONSTRAINT ai_conversations_locale_known CHECK ((locale = ANY (ARRAY['en'::text, 'ar'::text]))),
    CONSTRAINT ai_conversations_title_length CHECK (((title IS NULL) OR (length(title) <= 200)))
);

CREATE TABLE ai_cost_periods (
    tenant_id uuid NOT NULL,
    period_start_utc date NOT NULL,
    reserved_microusd bigint DEFAULT 0 NOT NULL,
    spent_microusd bigint DEFAULT 0 NOT NULL,
    unknown_microusd bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_cost_periods_non_negative CHECK (((reserved_microusd >= 0) AND (spent_microusd >= 0) AND (unknown_microusd >= 0)))
);

CREATE TABLE ai_help_articles (
    article_key text NOT NULL,
    locale text NOT NULL,
    module text NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    body text NOT NULL,
    keywords text[] DEFAULT '{}'::text[] NOT NULL,
    app_route text,
    help_url text,
    feature text,
    min_permission text,
    source_commit text,
    content_hash text NOT NULL,
    status text DEFAULT 'published'::text NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_help_articles_body_length CHECK ((length(body) <= 20000)),
    CONSTRAINT ai_help_articles_key_shape CHECK ((article_key ~ '^[a-z][a-z0-9_]{0,63}$'::text)),
    CONSTRAINT ai_help_articles_locale_known CHECK ((locale = ANY (ARRAY['en'::text, 'ar'::text]))),
    CONSTRAINT ai_help_articles_status_known CHECK ((status = ANY (ARRAY['published'::text, 'disabled'::text])))
);

CREATE TABLE ai_member_cost_periods (
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    period_start_utc date NOT NULL,
    reserved_microusd bigint DEFAULT 0 NOT NULL,
    spent_microusd bigint DEFAULT 0 NOT NULL,
    unknown_microusd bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_member_cost_periods_non_negative CHECK (((reserved_microusd >= 0) AND (spent_microusd >= 0) AND (unknown_microusd >= 0)))
);

CREATE TABLE ai_member_limits (
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    share_percent integer,
    monthly_cost_cap_microusd bigint,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT ai_member_limits_cost_cap_positive CHECK (((monthly_cost_cap_microusd IS NULL) OR (monthly_cost_cap_microusd > 0))),
    CONSTRAINT ai_member_limits_share_range CHECK (((share_percent IS NULL) OR ((share_percent >= 1) AND (share_percent <= 100)))),
    CONSTRAINT ai_member_limits_version_positive CHECK ((version > 0))
);

CREATE TABLE ai_message_reservations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    client_request_id text NOT NULL,
    request_fingerprint text NOT NULL,
    period_day date NOT NULL,
    period_month date NOT NULL,
    state text DEFAULT 'reserved'::text NOT NULL,
    reserved_message_units integer DEFAULT 1 NOT NULL,
    reserved_cost_microusd bigint DEFAULT 0 NOT NULL,
    settled_cost_microusd bigint,
    provider_attempts integer DEFAULT 0 NOT NULL,
    last_error_code text,
    response_message_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    settled_at timestamp with time zone,
    reserved_tokens bigint DEFAULT 0 NOT NULL,
    used_tokens bigint DEFAULT 0 NOT NULL,
    CONSTRAINT ai_message_reservations_cost_non_negative CHECK (((reserved_cost_microusd >= 0) AND ((settled_cost_microusd IS NULL) OR (settled_cost_microusd >= 0)))),
    CONSTRAINT ai_message_reservations_request_id_length CHECK (((length(client_request_id) >= 1) AND (length(client_request_id) <= 200))),
    CONSTRAINT ai_message_reservations_state_known CHECK ((state = ANY (ARRAY['reserved'::text, 'completed'::text, 'released'::text, 'expired'::text, 'uncertain'::text]))),
    CONSTRAINT ai_message_reservations_tokens_non_negative CHECK (((reserved_tokens >= 0) AND (used_tokens >= 0))),
    CONSTRAINT ai_message_reservations_units_one CHECK ((reserved_message_units = 1))
);

CREATE TABLE ai_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    conversation_id uuid NOT NULL,
    user_id uuid,
    role text NOT NULL,
    content text NOT NULL,
    source_refs jsonb DEFAULT '[]'::jsonb NOT NULL,
    tool_summaries jsonb DEFAULT '[]'::jsonb NOT NULL,
    action_proposal_id uuid,
    usage_reservation_id uuid,
    redacted boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_messages_content_length CHECK ((length(content) <= 20000)),
    CONSTRAINT ai_messages_role_known CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text, 'tool_summary'::text])))
)
PARTITION BY RANGE (created_at);

CREATE TABLE ai_plan_policies (
    plan text NOT NULL,
    level text DEFAULT 'off'::text NOT NULL,
    quota_mode text,
    daily_limit integer,
    monthly_limit integer,
    per_user_daily_limit integer,
    per_user_monthly_limit integer,
    unlimited_messages boolean DEFAULT false NOT NULL,
    monthly_cost_cap_microusd bigint,
    max_input_tokens integer DEFAULT 4000 NOT NULL,
    max_output_tokens integer DEFAULT 600 NOT NULL,
    max_tool_steps integer DEFAULT 1 NOT NULL,
    max_provider_calls integer DEFAULT 1 NOT NULL,
    allow_history boolean DEFAULT true NOT NULL,
    retention_days integer DEFAULT 30 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    daily_token_limit bigint,
    monthly_token_limit bigint,
    answer_source text DEFAULT 'model'::text NOT NULL,
    CONSTRAINT ai_plan_policies_answer_source_known CHECK ((answer_source = ANY (ARRAY['model'::text, 'library'::text]))),
    CONSTRAINT ai_plan_policies_level_known CHECK ((level = ANY (ARRAY['off'::text, 'help'::text, 'insights'::text, 'agent'::text]))),
    CONSTRAINT ai_plan_policies_limits_positive CHECK ((((daily_limit IS NULL) OR (daily_limit > 0)) AND ((monthly_limit IS NULL) OR (monthly_limit > 0)) AND ((per_user_daily_limit IS NULL) OR (per_user_daily_limit > 0)) AND ((per_user_monthly_limit IS NULL) OR (per_user_monthly_limit > 0)) AND ((monthly_cost_cap_microusd IS NULL) OR (monthly_cost_cap_microusd > 0)) AND (max_input_tokens > 0) AND (max_output_tokens > 0) AND (max_tool_steps > 0) AND (max_provider_calls > 0) AND (retention_days > 0) AND (version > 0))),
    CONSTRAINT ai_plan_policies_mode_consistent CHECK (((level = 'off'::text) OR (unlimited_messages AND (quota_mode IS NULL) AND ((monthly_cost_cap_microusd IS NOT NULL) OR (answer_source = 'library'::text))) OR ((quota_mode = 'daily'::text) AND (daily_limit IS NOT NULL)) OR ((quota_mode = 'monthly'::text) AND (monthly_limit IS NOT NULL)) OR ((quota_mode = 'daily_and_monthly'::text) AND (daily_limit IS NOT NULL) AND (monthly_limit IS NOT NULL)))),
    CONSTRAINT ai_plan_policies_plan_known CHECK ((plan = ANY (ARRAY['trial'::text, 'starter'::text, 'standard'::text, 'enterprise'::text]))),
    CONSTRAINT ai_plan_policies_quota_mode_known CHECK (((quota_mode IS NULL) OR (quota_mode = ANY (ARRAY['daily'::text, 'monthly'::text, 'daily_and_monthly'::text])))),
    CONSTRAINT ai_plan_policies_token_limits_positive CHECK ((((daily_token_limit IS NULL) OR (daily_token_limit > 0)) AND ((monthly_token_limit IS NULL) OR (monthly_token_limit > 0))))
);

CREATE TABLE ai_platform_cost_periods (
    period_start_utc date NOT NULL,
    reserved_microusd bigint DEFAULT 0 NOT NULL,
    spent_microusd bigint DEFAULT 0 NOT NULL,
    unknown_microusd bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_platform_cost_periods_non_negative CHECK (((reserved_microusd >= 0) AND (spent_microusd >= 0) AND (unknown_microusd >= 0)))
);

CREATE TABLE ai_provider_calls (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reservation_id uuid NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    attempt_number integer DEFAULT 1 NOT NULL,
    purpose text NOT NULL,
    input_tokens integer,
    output_tokens integer,
    cached_tokens integer,
    reasoning_tokens integer,
    tokens_estimated boolean DEFAULT true NOT NULL,
    cost_microusd bigint DEFAULT 0 NOT NULL,
    price_version text NOT NULL,
    status text NOT NULL,
    error_code text,
    started_at timestamp with time zone NOT NULL,
    ended_at timestamp with time zone,
    CONSTRAINT ai_provider_calls_non_negative CHECK (((attempt_number > 0) AND (cost_microusd >= 0) AND ((input_tokens IS NULL) OR (input_tokens >= 0)) AND ((output_tokens IS NULL) OR (output_tokens >= 0)) AND ((cached_tokens IS NULL) OR (cached_tokens >= 0)) AND ((reasoning_tokens IS NULL) OR (reasoning_tokens >= 0)))),
    CONSTRAINT ai_provider_calls_purpose_known CHECK ((purpose = ANY (ARRAY['help'::text, 'insights'::text, 'agent'::text, 'other'::text]))),
    CONSTRAINT ai_provider_calls_status_known CHECK ((status = ANY (ARRAY['success'::text, 'failed'::text, 'timeout'::text, 'unknown'::text])))
)
PARTITION BY RANGE (started_at);

CREATE TABLE ai_tenant_policies (
    tenant_id uuid NOT NULL,
    mode text DEFAULT 'inherit'::text NOT NULL,
    level text DEFAULT 'off'::text NOT NULL,
    quota_mode text,
    daily_limit integer,
    monthly_limit integer,
    per_user_daily_limit integer,
    per_user_monthly_limit integer,
    unlimited_messages boolean DEFAULT false NOT NULL,
    monthly_cost_cap_microusd bigint,
    max_input_tokens integer DEFAULT 4000 NOT NULL,
    max_output_tokens integer DEFAULT 600 NOT NULL,
    max_tool_steps integer DEFAULT 1 NOT NULL,
    max_provider_calls integer DEFAULT 1 NOT NULL,
    allow_history boolean DEFAULT true NOT NULL,
    retention_days integer DEFAULT 30 NOT NULL,
    company_data_to_provider boolean DEFAULT false NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    reason text,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    daily_token_limit bigint,
    monthly_token_limit bigint,
    answer_source text DEFAULT 'model'::text NOT NULL,
    CONSTRAINT ai_tenant_policies_answer_source_known CHECK ((answer_source = ANY (ARRAY['model'::text, 'library'::text]))),
    CONSTRAINT ai_tenant_policies_level_known CHECK ((level = ANY (ARRAY['off'::text, 'help'::text, 'insights'::text, 'agent'::text]))),
    CONSTRAINT ai_tenant_policies_limits_positive CHECK ((((daily_limit IS NULL) OR (daily_limit > 0)) AND ((monthly_limit IS NULL) OR (monthly_limit > 0)) AND ((per_user_daily_limit IS NULL) OR (per_user_daily_limit > 0)) AND ((per_user_monthly_limit IS NULL) OR (per_user_monthly_limit > 0)) AND ((monthly_cost_cap_microusd IS NULL) OR (monthly_cost_cap_microusd > 0)) AND (max_input_tokens > 0) AND (max_output_tokens > 0) AND (max_tool_steps > 0) AND (max_provider_calls > 0) AND (retention_days > 0) AND (version > 0))),
    CONSTRAINT ai_tenant_policies_mode_consistent CHECK (((mode = 'inherit'::text) OR (level = 'off'::text) OR (unlimited_messages AND (quota_mode IS NULL) AND ((monthly_cost_cap_microusd IS NOT NULL) OR (answer_source = 'library'::text))) OR ((quota_mode = 'daily'::text) AND (daily_limit IS NOT NULL)) OR ((quota_mode = 'monthly'::text) AND (monthly_limit IS NOT NULL)) OR ((quota_mode = 'daily_and_monthly'::text) AND (daily_limit IS NOT NULL) AND (monthly_limit IS NOT NULL)))),
    CONSTRAINT ai_tenant_policies_mode_known CHECK ((mode = ANY (ARRAY['inherit'::text, 'custom'::text]))),
    CONSTRAINT ai_tenant_policies_quota_mode_known CHECK (((quota_mode IS NULL) OR (quota_mode = ANY (ARRAY['daily'::text, 'monthly'::text, 'daily_and_monthly'::text])))),
    CONSTRAINT ai_tenant_policies_token_limits_positive CHECK ((((daily_token_limit IS NULL) OR (daily_token_limit > 0)) AND ((monthly_token_limit IS NULL) OR (monthly_token_limit > 0))))
);

CREATE TABLE ai_token_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    period_type text NOT NULL,
    period_start_utc date NOT NULL,
    used_tokens bigint DEFAULT 0 NOT NULL,
    reserved_tokens bigint DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_token_periods_non_negative CHECK (((used_tokens >= 0) AND (reserved_tokens >= 0))),
    CONSTRAINT ai_token_periods_period_known CHECK ((period_type = ANY (ARRAY['day'::text, 'month'::text]))),
    CONSTRAINT ai_token_periods_subject_known CHECK ((subject_type = ANY (ARRAY['tenant'::text, 'user'::text])))
);

CREATE TABLE ai_usage_periods (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid NOT NULL,
    period_type text NOT NULL,
    period_start_utc date NOT NULL,
    used_messages integer DEFAULT 0 NOT NULL,
    reserved_messages integer DEFAULT 0 NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_usage_periods_non_negative CHECK (((used_messages >= 0) AND (reserved_messages >= 0))),
    CONSTRAINT ai_usage_periods_period_known CHECK ((period_type = ANY (ARRAY['day'::text, 'month'::text]))),
    CONSTRAINT ai_usage_periods_subject_known CHECK ((subject_type = ANY (ARRAY['tenant'::text, 'user'::text])))
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ai_action_events
    ADD CONSTRAINT ai_action_events_pkey PRIMARY KEY (tenant_id, id, created_at);

ALTER TABLE ONLY ai_action_proposals
    ADD CONSTRAINT ai_action_proposals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY ai_action_proposals
    ADD CONSTRAINT ai_action_proposals_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY ai_conversations
    ADD CONSTRAINT ai_conversations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY ai_conversations
    ADD CONSTRAINT ai_conversations_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY ai_cost_periods
    ADD CONSTRAINT ai_cost_periods_pkey PRIMARY KEY (tenant_id, period_start_utc);

ALTER TABLE ONLY ai_help_articles
    ADD CONSTRAINT ai_help_articles_pkey PRIMARY KEY (article_key, locale);

ALTER TABLE ONLY ai_member_cost_periods
    ADD CONSTRAINT ai_member_cost_periods_pkey PRIMARY KEY (tenant_id, user_id, period_start_utc);

ALTER TABLE ONLY ai_member_limits
    ADD CONSTRAINT ai_member_limits_pkey PRIMARY KEY (tenant_id, user_id);

ALTER TABLE ONLY ai_message_reservations
    ADD CONSTRAINT ai_message_reservations_one_per_request UNIQUE (tenant_id, user_id, client_request_id);

ALTER TABLE ONLY ai_message_reservations
    ADD CONSTRAINT ai_message_reservations_pkey PRIMARY KEY (id);

ALTER TABLE ONLY ai_message_reservations
    ADD CONSTRAINT ai_message_reservations_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ai_messages
    ADD CONSTRAINT ai_messages_pkey PRIMARY KEY (tenant_id, id, created_at);

ALTER TABLE ONLY ai_plan_policies
    ADD CONSTRAINT ai_plan_policies_pkey PRIMARY KEY (plan);

ALTER TABLE ONLY ai_platform_cost_periods
    ADD CONSTRAINT ai_platform_cost_periods_pkey PRIMARY KEY (period_start_utc);

ALTER TABLE ai_provider_calls
    ADD CONSTRAINT ai_provider_calls_pkey PRIMARY KEY (tenant_id, id, started_at);

ALTER TABLE ONLY ai_tenant_policies
    ADD CONSTRAINT ai_tenant_policies_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY ai_token_periods
    ADD CONSTRAINT ai_token_periods_one_per_period UNIQUE (tenant_id, subject_type, subject_id, period_type, period_start_utc);

ALTER TABLE ONLY ai_token_periods
    ADD CONSTRAINT ai_token_periods_pkey PRIMARY KEY (id);

ALTER TABLE ONLY ai_usage_periods
    ADD CONSTRAINT ai_usage_periods_one_per_period UNIQUE (tenant_id, subject_type, subject_id, period_type, period_start_utc);

ALTER TABLE ONLY ai_usage_periods
    ADD CONSTRAINT ai_usage_periods_pkey PRIMARY KEY (id);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX ai_action_events_by_proposal ON ai_action_events USING btree (tenant_id, proposal_id, created_at);

CREATE INDEX ai_action_proposals_by_user ON ai_action_proposals USING btree (tenant_id, user_id, created_at DESC);

CREATE INDEX ai_conversations_by_owner ON ai_conversations USING btree (tenant_id, created_by_user_id, updated_at DESC) WHERE (deleted_at IS NULL);

CREATE INDEX ai_message_reservations_open ON ai_message_reservations USING btree (tenant_id, expires_at) WHERE (state = ANY (ARRAY['reserved'::text, 'uncertain'::text]));

CREATE INDEX ai_messages_by_conversation ON ai_messages USING btree (tenant_id, conversation_id, created_at, id);

CREATE INDEX ai_provider_calls_by_reservation ON ai_provider_calls USING btree (tenant_id, reservation_id);

CREATE INDEX ai_provider_calls_by_time ON ai_provider_calls USING btree (tenant_id, started_at DESC);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ai_action_events
    ADD CONSTRAINT ai_action_events_proposal_fk FOREIGN KEY (tenant_id, proposal_id) REFERENCES ai_action_proposals(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ai_action_events
    ADD CONSTRAINT ai_action_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY ai_action_proposals
    ADD CONSTRAINT ai_action_proposals_conversation_fk FOREIGN KEY (tenant_id, conversation_id) REFERENCES ai_conversations(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY ai_action_proposals
    ADD CONSTRAINT ai_action_proposals_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY ai_conversations
    ADD CONSTRAINT ai_conversations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY ai_cost_periods
    ADD CONSTRAINT ai_cost_periods_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY ai_member_cost_periods
    ADD CONSTRAINT ai_member_cost_periods_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY ai_member_limits
    ADD CONSTRAINT ai_member_limits_member_fk FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_users(tenant_id, user_id) ON DELETE CASCADE;

ALTER TABLE ONLY ai_member_limits
    ADD CONSTRAINT ai_member_limits_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY ai_message_reservations
    ADD CONSTRAINT ai_message_reservations_conversation_fk FOREIGN KEY (tenant_id, conversation_id) REFERENCES ai_conversations(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY ai_message_reservations
    ADD CONSTRAINT ai_message_reservations_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ai_messages
    ADD CONSTRAINT ai_messages_conversation_fk FOREIGN KEY (tenant_id, conversation_id) REFERENCES ai_conversations(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ai_messages
    ADD CONSTRAINT ai_messages_proposal_fk FOREIGN KEY (tenant_id, action_proposal_id) REFERENCES ai_action_proposals(tenant_id, id) ON DELETE SET NULL;

ALTER TABLE ai_messages
    ADD CONSTRAINT ai_messages_reservation_fk FOREIGN KEY (tenant_id, usage_reservation_id) REFERENCES ai_message_reservations(tenant_id, id) ON DELETE SET NULL;

ALTER TABLE ai_messages
    ADD CONSTRAINT ai_messages_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ai_provider_calls
    ADD CONSTRAINT ai_provider_calls_reservation_fk FOREIGN KEY (tenant_id, reservation_id) REFERENCES ai_message_reservations(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ai_provider_calls
    ADD CONSTRAINT ai_provider_calls_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY ai_tenant_policies
    ADD CONSTRAINT ai_tenant_policies_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY ai_token_periods
    ADD CONSTRAINT ai_token_periods_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE ONLY ai_usage_periods
    ADD CONSTRAINT ai_usage_periods_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE ai_action_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_action_proposals ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_conversations ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_cost_periods ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_help_articles ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_member_cost_periods ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_member_limits ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_message_reservations ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_messages ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_plan_policies ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_platform_cost_periods ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_provider_calls ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_tenant_policies ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_token_periods ENABLE ROW LEVEL SECURITY;

ALTER TABLE ai_usage_periods ENABLE ROW LEVEL SECURITY;

CREATE POLICY ai_action_events_isolation ON ai_action_events TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY ai_action_proposals_isolation ON ai_action_proposals TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY ai_conversations_isolation ON ai_conversations TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY ai_cost_periods_isolation ON ai_cost_periods TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY ai_member_cost_periods_isolation ON ai_member_cost_periods TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY ai_member_limits_isolation ON ai_member_limits TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY ai_message_reservations_isolation ON ai_message_reservations TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY ai_messages_isolation ON ai_messages TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY ai_provider_calls_isolation ON ai_provider_calls TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY ai_tenant_policies_isolation ON ai_tenant_policies FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

CREATE POLICY ai_token_periods_isolation ON ai_token_periods TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY ai_usage_periods_isolation ON ai_usage_periods TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON TABLE ai_action_events IS 'What happened to each proposal, append-only (ADR-0001): the runtime role may insert and read, never change.';

COMMENT ON TABLE ai_action_proposals IS 'An action the assistant prepared and the member has not yet confirmed (ADR-0001). The payload is frozen; a change is a new proposal.';

COMMENT ON TABLE ai_conversations IS 'A member''s private chats with the assistant (ADR-0001). Private to the member who started each; soft-deleted by them, swept by retention.';

COMMENT ON TABLE ai_cost_periods IS 'A company''s provider spend per UTC month (ADR-0001): reserved before a call, settled after, unknown when the provider never said.';

COMMENT ON TABLE ai_help_articles IS 'The curated help the assistant cites (ADR-0001), in both languages, seeded from the checked-in manifest by content hash. Platform-only.';

COMMENT ON TABLE ai_member_cost_periods IS 'One member''s share of the company''s provider spend per UTC month (ADR-0002 D7). The same calls as ai_cost_periods, attributed: never a second charge.';

COMMENT ON TABLE ai_member_limits IS 'Each member''s percentage of the company''s assistant allowance, and an optional platform-set monthly dollar cap (ADR-0002 D6, D7).';

COMMENT ON TABLE ai_message_reservations IS 'One row per admitted chat request (ADR-0001): the idempotent record of whether it was charged. A completed one replays its stored answer.';

COMMENT ON TABLE ai_messages IS 'What was said in a conversation (ADR-0001). Never a provider secret, a raw provider trace or a record the member could not see themselves.';

COMMENT ON TABLE ai_plan_policies IS 'What each subscription plan allows the assistant to do, by default off (ADR-0001). Platform-written; the runtime role holds nothing on it.';

COMMENT ON COLUMN ai_plan_policies.daily_token_limit IS 'Input plus output tokens the whole company may use per UTC day. Null: no token limit on that axis (ADR-0002 D5).';

COMMENT ON COLUMN ai_plan_policies.monthly_token_limit IS 'Input plus output tokens the whole company may use per UTC month. Null: no token limit on that axis (ADR-0002 D5).';

COMMENT ON COLUMN ai_plan_policies.answer_source IS 'Where answers come from: a model, or the help library with no provider (ADR-0002 D9, D10).';

COMMENT ON TABLE ai_platform_cost_periods IS 'The whole deployment''s provider spend per UTC month (ADR-0001), reserved before a company''s share is. The runtime role holds nothing on it.';

COMMENT ON TABLE ai_provider_calls IS 'Every call to a model (ADR-0001): tokens as reported or conservatively estimated, cost in USD micros at a versioned price. Calls can outnumber charged messages.';

COMMENT ON TABLE ai_tenant_policies IS 'A company''s assistant policy when it does not simply inherit its plan''s (ADR-0001). Written only by the platform; readable by the company about itself.';

COMMENT ON COLUMN ai_tenant_policies.answer_source IS 'Where answers come from for this company when its policy is custom (ADR-0002 D9, D10).';

COMMENT ON TABLE ai_token_periods IS 'Tokens used and held per company or member, per UTC day and month (ADR-0002 D5). Held before each model call, settled to the reported total after it, locked in the same order as the message counters.';

COMMENT ON TABLE ai_usage_periods IS 'Messages used and reserved per company or member, per UTC day and month (ADR-0001). Locked in a fixed order when a request is admitted.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT,INSERT ON TABLE ai_action_events TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_action_events TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE ai_action_proposals TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_action_proposals TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_conversations TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_conversations TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE ai_cost_periods TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_cost_periods TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_help_articles TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE ai_member_cost_periods TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_member_cost_periods TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_member_limits TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_member_limits TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE ai_message_reservations TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_message_reservations TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_messages TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_messages TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_plan_policies TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_platform_cost_periods TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE ai_provider_calls TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_provider_calls TO integr8_platform;

GRANT SELECT ON TABLE ai_tenant_policies TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_tenant_policies TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE ai_token_periods TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_token_periods TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE ai_usage_periods TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE ai_usage_periods TO integr8_platform;

-- ---------------------------------------------------------------------------
-- Rows every database starts with
-- ---------------------------------------------------------------------------

INSERT INTO ai_plan_policies (plan, level, quota_mode, daily_limit, monthly_limit, per_user_daily_limit, per_user_monthly_limit, unlimited_messages, monthly_cost_cap_microusd, max_input_tokens, max_output_tokens, max_tool_steps, max_provider_calls, allow_history, retention_days, version, updated_at, updated_by, daily_token_limit, monthly_token_limit, answer_source) VALUES ('trial', 'off', NULL, NULL, NULL, NULL, NULL, false, NULL, 4000, 600, 1, 1, true, 30, 1, '2026-11-14 21:36:23.976798+00', NULL, NULL, NULL, 'model');
INSERT INTO ai_plan_policies (plan, level, quota_mode, daily_limit, monthly_limit, per_user_daily_limit, per_user_monthly_limit, unlimited_messages, monthly_cost_cap_microusd, max_input_tokens, max_output_tokens, max_tool_steps, max_provider_calls, allow_history, retention_days, version, updated_at, updated_by, daily_token_limit, monthly_token_limit, answer_source) VALUES ('starter', 'off', NULL, NULL, NULL, NULL, NULL, false, NULL, 4000, 600, 1, 1, true, 30, 1, '2026-11-14 21:36:23.976798+00', NULL, NULL, NULL, 'model');
INSERT INTO ai_plan_policies (plan, level, quota_mode, daily_limit, monthly_limit, per_user_daily_limit, per_user_monthly_limit, unlimited_messages, monthly_cost_cap_microusd, max_input_tokens, max_output_tokens, max_tool_steps, max_provider_calls, allow_history, retention_days, version, updated_at, updated_by, daily_token_limit, monthly_token_limit, answer_source) VALUES ('standard', 'off', NULL, NULL, NULL, NULL, NULL, false, NULL, 4000, 600, 1, 1, true, 30, 1, '2026-11-14 21:36:23.976798+00', NULL, NULL, NULL, 'model');
INSERT INTO ai_plan_policies (plan, level, quota_mode, daily_limit, monthly_limit, per_user_daily_limit, per_user_monthly_limit, unlimited_messages, monthly_cost_cap_microusd, max_input_tokens, max_output_tokens, max_tool_steps, max_provider_calls, allow_history, retention_days, version, updated_at, updated_by, daily_token_limit, monthly_token_limit, answer_source) VALUES ('enterprise', 'off', NULL, NULL, NULL, NULL, NULL, false, NULL, 4000, 600, 1, 1, true, 30, 1, '2026-11-14 21:36:23.976798+00', NULL, NULL, NULL, 'model');

-- ---------------------------------------------------------------------------
-- Year partitions for the tables above (see 0001)
-- ---------------------------------------------------------------------------

SELECT ensure_year_partitions();
