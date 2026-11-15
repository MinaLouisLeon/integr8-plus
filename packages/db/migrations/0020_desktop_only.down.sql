-- Puts back what 0020 removed, empty: the columns and tables as 0001 and 0003
-- made them. The rows they held are gone.

INSERT INTO scheduled_task_runs (task, last_run_at) VALUES
    ('billing.dunning', '1970-01-01 00:00:00+00'),
    ('signup.expire', '1970-01-01 00:00:00+00')
ON CONFLICT (task) DO NOTHING;

ALTER TABLE tenant_settings ADD COLUMN ai_web_enabled boolean DEFAULT false NOT NULL;
COMMENT ON COLUMN tenant_settings.ai_web_enabled IS 'Whether members see the assistant in the web app (ADR-0001). Narrows the platform grant; never widens it.';

ALTER TABLE tenants
    ADD COLUMN billing_mode text DEFAULT 'self_serve'::text NOT NULL,
    ADD CONSTRAINT tenants_billing_mode_known CHECK ((billing_mode = ANY (ARRAY['self_serve'::text, 'invoiced'::text])));
COMMENT ON COLUMN tenants.billing_mode IS 'self_serve: subscribes in the app via the billing provider. invoiced: Integr8 invoices directly; the plan is set from the platform dashboard.';

ALTER TABLE plan_allowances
    ADD COLUMN provider_price_monthly text,
    ADD COLUMN provider_price_yearly text;

ALTER TABLE subscriptions
    ADD COLUMN provider text NOT NULL DEFAULT 'none',
    ADD COLUMN provider_customer_id text,
    ADD COLUMN provider_subscription_id text,
    ADD COLUMN billing_interval text,
    ADD COLUMN current_period_start timestamp with time zone,
    ADD COLUMN current_period_end timestamp with time zone,
    ADD COLUMN cancel_at_period_end boolean DEFAULT false NOT NULL,
    ADD COLUMN past_due_since timestamp with time zone,
    ADD COLUMN grace_ends_at timestamp with time zone,
    ADD COLUMN reminders_sent integer DEFAULT 0 NOT NULL;
ALTER TABLE subscriptions ALTER COLUMN provider DROP DEFAULT;

ALTER TABLE subscriptions
    ADD CONSTRAINT subscriptions_dunning_pair CHECK (((past_due_since IS NULL) = (grace_ends_at IS NULL))),
    ADD CONSTRAINT subscriptions_interval_known CHECK (((billing_interval IS NULL) OR (billing_interval = ANY (ARRAY['month'::text, 'year'::text])))),
    ADD CONSTRAINT subscriptions_period_order CHECK (((current_period_start IS NULL) OR (current_period_end IS NULL) OR (current_period_end > current_period_start))),
    ADD CONSTRAINT subscriptions_reminders_sane CHECK ((reminders_sent >= 0)),
    ADD CONSTRAINT subscriptions_provider_subscription_unique UNIQUE (provider, provider_subscription_id);

CREATE INDEX subscriptions_dunning_idx ON subscriptions USING btree (grace_ends_at) WHERE (grace_ends_at IS NOT NULL);

COMMENT ON TABLE subscriptions IS 'What one company is paying for and where it stands (0017). The provider is a string rather than a type, because a market needing a regional provider must not need a migration; nothing above this table learns which one it is.';

CREATE TABLE billing_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    provider_event_id text NOT NULL,
    type text NOT NULL,
    tenant_id uuid,
    payload jsonb NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    error text,
    CONSTRAINT billing_events_pkey PRIMARY KEY (id),
    CONSTRAINT billing_events_provider_event_unique UNIQUE (provider, provider_event_id),
    CONSTRAINT billing_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);
CREATE INDEX billing_events_recent_idx ON billing_events USING btree (received_at DESC);
CREATE INDEX billing_events_unprocessed_idx ON billing_events USING btree (received_at) WHERE (processed_at IS NULL);
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY billing_events_platform_only ON billing_events USING (false);
COMMENT ON TABLE billing_events IS 'Every webhook the billing provider delivered, kept whether or not it was understood (0017). The unique constraint on the provider event id is what makes a duplicate delivery a no-op.';
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE billing_events TO integr8_platform;

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
    CONSTRAINT signup_requests_verified_pair CHECK (((status = 'verified'::text) = (verified_at IS NOT NULL))),
    CONSTRAINT signup_requests_pkey PRIMARY KEY (id),
    CONSTRAINT signup_requests_token_unique UNIQUE (token_hash),
    CONSTRAINT signup_requests_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
);
CREATE INDEX signup_requests_email_idx ON signup_requests USING btree (lower(email), created_at DESC);
CREATE INDEX signup_requests_pending_idx ON signup_requests USING btree (expires_at) WHERE (status = 'pending'::text);
ALTER TABLE signup_requests ENABLE ROW LEVEL SECURITY;
CREATE POLICY signup_requests_platform_only ON signup_requests USING (false);
COMMENT ON TABLE signup_requests IS 'Somebody asking for a company, before one exists (0018). Nothing is provisioned until the emailed token comes back: no tenant, no bucket, no trial. A request nobody verifies simply expires.';
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE signup_requests TO integr8_platform;

CREATE TABLE signup_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    step text NOT NULL,
    signup_id uuid,
    tenant_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT signup_events_pkey PRIMARY KEY (id, occurred_at),
    CONSTRAINT signup_events_signup_id_fkey FOREIGN KEY (signup_id) REFERENCES signup_requests(id) ON DELETE SET NULL,
    CONSTRAINT signup_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
)
PARTITION BY RANGE (occurred_at);
CREATE INDEX signup_events_signup_idx ON signup_events USING btree (signup_id) WHERE (signup_id IS NOT NULL);
CREATE INDEX signup_events_step_idx ON signup_events USING btree (step, occurred_at DESC);
ALTER TABLE signup_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY signup_events_platform_only ON signup_events USING (false);
COMMENT ON TABLE signup_events IS 'The signup funnel (0018). Deliberately not the audit log: audit_log is tenant-scoped and every interesting step here happens before a tenant exists. Carries no personal data — it answers how many gave up at a step, never who.';
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE signup_events TO integr8_platform;

SELECT ensure_year_partitions();
