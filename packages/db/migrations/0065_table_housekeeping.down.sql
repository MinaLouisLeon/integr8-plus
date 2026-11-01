-- The deleted idempotency records are not restored: they held fingerprints of
-- passwords, and nothing depends on them.
delete from scheduled_task_runs where task = 'housekeeping.tables';

drop index if exists login_attempts_occurred_at_idx;
