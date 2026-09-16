-- Undoes 0016.
--
-- The samples are the only thing here that cannot be recomputed: the ledger
-- gives today's bytes, but not what they were on a Tuesday in March, and P17
-- bills overage from them. Rolling back therefore loses billing history, which
-- is worth knowing before running it anywhere that has been up for a month.

drop policy if exists storage_reconciliations_isolation on storage_reconciliations;
drop policy if exists tenant_storage_samples_isolation on tenant_storage_samples;

drop table if exists scheduled_task_runs;
drop table if exists storage_reconciliations;
drop table if exists tenant_storage_samples;
drop table if exists plan_allowances;
