-- Reverses 0021. A company that was invoiced goes back to looking self-serve,
-- which the code before 0021 understands: its subscription row, if any, stays.

alter table tenants drop constraint tenants_billing_mode_known;
alter table tenants drop column billing_mode;
