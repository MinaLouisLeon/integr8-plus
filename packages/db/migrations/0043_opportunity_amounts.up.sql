-- Opportunity amount history (ninth round; ADR-0013).
--
-- Every change of an opportunity's amount or currency is kept, written by
-- trigger so the record cannot be edited after the fact. Value by stage reads
-- the amount a deal had at each month end. For months before this release
-- nothing was kept: each deal open now gets one row marked `baseline`, its
-- amount on the day the history began, which the report uses for those months
-- and says so.

create table crm_opportunity_amounts (
  id              uuid          primary key default gen_random_uuid(),
  tenant_id       uuid          not null references tenants (id) on delete restrict,
  opportunity_id  uuid          not null,
  amount          numeric(20, 4),
  currency_code   text          not null,
  -- The row written when the history began, standing in for the months before.
  baseline        boolean       not null default false,
  changed_at      timestamptz   not null default now(),
  constraint crm_opportunity_amounts_tenant_id_unique unique (tenant_id, id),
  constraint crm_opportunity_amounts_opportunity_fk
    foreign key (tenant_id, opportunity_id) references crm_opportunities (tenant_id, id) on delete restrict
);
create index crm_opportunity_amounts_by_opportunity
  on crm_opportunity_amounts (tenant_id, opportunity_id, changed_at desc);
comment on table crm_opportunity_amounts is
  'Each amount or currency an opportunity has had, from when it changed (ADR-0013). Written only by trigger.';

create function crm_opportunity_record_amount() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE'
     and new.amount is not distinct from old.amount
     and new.currency_code is not distinct from old.currency_code then
    return new;
  end if;
  insert into crm_opportunity_amounts (tenant_id, opportunity_id, amount, currency_code)
  values (new.tenant_id, new.id, new.amount, new.currency_code);
  return new;
end;
$$;
revoke all on function crm_opportunity_record_amount() from public;
create trigger crm_opportunities_record_amount
  after insert or update of amount, currency_code on crm_opportunities
  for each row execute function crm_opportunity_record_amount();

insert into crm_opportunity_amounts (tenant_id, opportunity_id, amount, currency_code, baseline)
select tenant_id, id, amount, currency_code, true from crm_opportunities;

grant select on crm_opportunity_amounts to integr8_app;

alter table crm_opportunity_amounts enable row level security;
create policy crm_opportunity_amounts_isolation on crm_opportunity_amounts
  for select to integr8_app
  using (tenant_id = app_current_tenant_id());
