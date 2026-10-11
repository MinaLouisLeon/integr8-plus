-- Reverses 0024.
--
-- Drops every lead. Fine on a fresh or test database; on a live one, take a
-- backup or a company export first (docs/crm-erp/README.md), because this is
-- not recoverable from the database alone.
--
-- The currency default goes back to GBP for new companies. Companies moved to
-- EGP by the up migration stay on EGP: what each had before is not recorded,
-- and guessing would be worse than leaving the value an owner can see and
-- change on the Company settings page.

drop table crm_leads;
drop function crm_leads_guard_conversion();

alter table tenant_settings alter column currency set default 'GBP';

-- Removes every company's answer for the flag as well (on delete cascade).
delete from feature_flags where key = 'crm';
