-- P42 (desktop only): what only self-serve sign-up, card payments and the web
-- app's assistant switch used.
--
-- Companies are onboarded by Integr8 staff and invoiced by Integr8, and the
-- office works in the desktop apps, so nothing reads or writes these any more.
-- No company existed when this was written and every row was test data, so this
-- drops in one release rather than expanding and contracting across two.

-- Self-serve sign-up and its funnel. Dropping the parent drops its year
-- partitions; `ensure_year_partitions()` finds partitioned tables by looking,
-- so it needs no change.
DROP TABLE signup_events;
DROP TABLE signup_requests;

-- What the card provider reported. Plans, seats and limits stay: the API
-- enforces them for every company, whoever sends the invoice.
DROP TABLE billing_events;

ALTER TABLE subscriptions
    DROP CONSTRAINT subscriptions_provider_subscription_unique,
    DROP CONSTRAINT subscriptions_dunning_pair,
    DROP CONSTRAINT subscriptions_interval_known,
    DROP CONSTRAINT subscriptions_period_order,
    DROP CONSTRAINT subscriptions_reminders_sane;

DROP INDEX subscriptions_dunning_idx;

ALTER TABLE subscriptions
    DROP COLUMN provider,
    DROP COLUMN provider_customer_id,
    DROP COLUMN provider_subscription_id,
    DROP COLUMN billing_interval,
    DROP COLUMN current_period_start,
    DROP COLUMN current_period_end,
    DROP COLUMN cancel_at_period_end,
    DROP COLUMN past_due_since,
    DROP COLUMN grace_ends_at,
    DROP COLUMN reminders_sent;

COMMENT ON TABLE subscriptions IS 'What one company is on: its plan and where it stands (0017; 0020 removed the card provider''s columns). Integr8 invoices every company directly; the plan is set from the staff app.';

ALTER TABLE plan_allowances
    DROP COLUMN provider_price_monthly,
    DROP COLUMN provider_price_yearly;

ALTER TABLE tenants
    DROP CONSTRAINT tenants_billing_mode_known,
    DROP COLUMN billing_mode;

-- The web app's assistant switch: the assistant is shown in the desktop and
-- phone apps only.
ALTER TABLE tenant_settings DROP COLUMN ai_web_enabled;

DELETE FROM scheduled_task_runs WHERE task IN ('billing.dunning', 'signup.expire');
