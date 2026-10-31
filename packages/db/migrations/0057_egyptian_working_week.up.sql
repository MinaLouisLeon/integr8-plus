-- A new company works on Cairo time, Sunday to Thursday (P25, P27).
--
-- 0018 gave every new company UTC and a Monday-to-Friday week. The companies
-- Integr8 sells to are Egyptian: they work Sunday to Thursday on Cairo time,
-- two hours ahead of UTC (three in summer). Until somebody changed the
-- settings, a response deadline counted in working hours ran through Friday
-- and stopped on Sunday, a maintenance visit could fall due on a Friday, the
-- schedule greyed out the wrong days, and anything dated by the company's day
-- (the ledger, contract years, coverage) rolled over at two or three in the
-- morning, Cairo time.
--
-- Only the defaults change. A company that already exists keeps the settings
-- it has, whatever they are: they may have been chosen on purpose, and moving
-- a company's clock under it would move dates already shown to its customers.
-- Integr8 changes an existing company from its settings screen, deliberately.

alter table tenant_settings alter column timezone set default 'Africa/Cairo';
-- ISO weekday numbers: 7 is Sunday, 4 is Thursday.
alter table tenant_settings alter column working_days set default '{7,1,2,3,4}';

-- The ledger's fallback for a company with no settings row, kept in step with
-- the column default. Onboarding always writes the row, so this is a safety
-- net rather than a path anything takes.
create or replace function erp_ledger_timezone(p_tenant uuid) returns text
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select coalesce((select s.timezone from tenant_settings s where s.tenant_id = p_tenant), 'Africa/Cairo');
$$;
