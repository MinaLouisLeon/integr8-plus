-- Undoes 0017.
--
-- `billing_events` is the record of what the provider told us and when, and
-- `subscriptions` is what each company is paying for. Neither can be
-- reconstructed from anything else here — the provider holds its own copy, but
-- the mapping from its customer ids to companies lives only in these tables.
-- Rolling back therefore means re-linking every paying company by hand.
--
-- Read-only is lifted rather than left behind: after the columns go there is
-- nothing to say why a company was refused writes, and a company silently
-- stuck read-only with no record of the reason is worse than one that is not.

update tenants set read_only_since = null, read_only_reason = null;

delete from scheduled_task_runs where task = 'billing.dunning';

drop policy if exists billing_events_platform_only on billing_events;
drop policy if exists subscriptions_isolation on subscriptions;

drop table if exists billing_events;
drop table if exists subscriptions;

alter table tenants
  drop constraint if exists tenants_read_only_pair;

alter table tenants
  drop column if exists read_only_reason,
  drop column if exists read_only_since;

alter table plan_allowances
  drop constraint if exists plan_allowances_currency_shape,
  drop constraint if exists plan_allowances_currency_pair,
  drop constraint if exists plan_allowances_price_sane,
  drop constraint if exists plan_allowances_submissions_sane,
  drop constraint if exists plan_allowances_seats_sane;

alter table plan_allowances
  drop column if exists provider_price_yearly,
  drop column if exists provider_price_monthly,
  drop column if exists currency,
  drop column if exists price_cents,
  drop column if exists submissions_per_month,
  drop column if exists seats;
