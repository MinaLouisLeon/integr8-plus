-- Reverses 0056: puts the 0016 retention windows back on plans that have none.

update plan_allowances set retention_days = 90 where plan = 'trial' and retention_days is null;
update plan_allowances set retention_days = 365 where plan = 'starter' and retention_days is null;
update plan_allowances set retention_days = 730 where plan = 'standard' and retention_days is null;
