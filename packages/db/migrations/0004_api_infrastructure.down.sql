-- 0004 — down.

drop policy if exists rate_limit_buckets_gateway on rate_limit_buckets;
drop policy if exists jobs_isolation on jobs;
drop policy if exists idempotency_keys_isolation on idempotency_keys;

revoke all on rate_limit_buckets from integr8_auth;
revoke all on jobs from integr8_app;
revoke all on idempotency_keys from integr8_app;

drop table if exists rate_limit_buckets;
drop table if exists jobs;
drop table if exists idempotency_keys;
