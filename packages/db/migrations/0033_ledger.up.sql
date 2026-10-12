-- CRM/ERP plan, phase A1: the general ledger (ERP-08; ADR-0009). Authorized
-- by the product owner on 2026-10-12.
--
-- A management ledger in the company's currency: a chart of accounts, monthly
-- periods locked by hand, and journals that balance, are numbered when posted
-- and never change afterwards — a mistake is corrected by a reversal. Every
-- balance and report is derived from posted journal lines; none is stored.
--
-- A journal is written as a draft, its lines added, then posted by changing
-- its status. Posting is where the database checks everything: that the ledger
-- is set up, the date is on or after its start and in an open month, the
-- journal balances, its accounts are in use, a manual journal is approved by a
-- second person (unless the company allows self-approval), and a reversal
-- reverses a posted journal once. Automatic postings (A1b) go through the same
-- door.

insert into feature_flags (key, description, default_enabled)
values
  ('ledger',
   'Ledger: the company''s general ledger — chart of accounts, journals, periods and reports. A management ledger, not statutory accounts. Off until Integr8 switches it on for a company.',
   false);

-- ---------------------------------------------------------------------------
-- Accounts
-- ---------------------------------------------------------------------------

create table erp_ledger_accounts (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants (id) on delete restrict,
  code         text        not null,
  name         text        not null,
  -- Where it is reported and which side is its normal balance.
  type         text        not null,
  archived_at  timestamptz,
  archived_by  uuid,
  version      integer     not null default 1,
  created_by   uuid        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint erp_ledger_accounts_tenant_id_unique unique (tenant_id, id),
  constraint erp_ledger_accounts_code_unique unique (tenant_id, code),
  constraint erp_ledger_accounts_type_known check (type in ('asset', 'liability', 'equity', 'income', 'expense')),
  constraint erp_ledger_accounts_code_shape check (code ~ '^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$'),
  constraint erp_ledger_accounts_name_present check (btrim(name) <> '' and char_length(name) <= 200),
  constraint erp_ledger_accounts_archived_pairing check ((archived_at is null) = (archived_by is null)),
  constraint erp_ledger_accounts_version_positive check (version > 0)
);
comment on table erp_ledger_accounts is
  'A company''s chart of accounts. Archived, never deleted; an account''s type is fixed once anything is posted to it.';

create trigger erp_ledger_accounts_set_updated_at
  before update on erp_ledger_accounts
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Settings: a row means the ledger is set up
-- ---------------------------------------------------------------------------

create table erp_ledger_settings (
  tenant_id                     uuid        primary key references tenants (id) on delete restrict,
  -- The first day of a month. Nothing dated before it is posted.
  start_date                    date        not null,
  -- The month the fiscal year starts, 1 (January) to 12.
  fiscal_start_month            smallint    not null default 1,
  auto_post_sales               boolean     not null default true,
  auto_post_stock               boolean     not null default true,
  -- A one-person company may post its own manual journals; each says so.
  allow_self_approval           boolean     not null default false,
  receivables_account_id        uuid        not null,
  revenue_services_account_id   uuid        not null,
  revenue_goods_account_id      uuid        not null,
  vat_output_account_id         uuid        not null,
  cash_account_id               uuid        not null,
  bank_account_id               uuid        not null,
  other_receipts_account_id     uuid        not null,
  inventory_account_id          uuid        not null,
  goods_received_account_id     uuid        not null,
  parts_cost_account_id         uuid        not null,
  stock_adjustments_account_id  uuid        not null,
  opening_balances_account_id   uuid        not null,
  retained_earnings_account_id  uuid        not null,
  version                       integer     not null default 1,
  created_by                    uuid        not null,
  created_at                    timestamptz not null default now(),
  updated_by                    uuid,
  updated_at                    timestamptz not null default now(),
  constraint erp_ledger_settings_start_first_of_month check (extract(day from start_date) = 1),
  constraint erp_ledger_settings_fiscal_month_range check (fiscal_start_month between 1 and 12),
  constraint erp_ledger_settings_version_positive check (version > 0),
  constraint erp_ledger_settings_receivables_fk
    foreign key (tenant_id, receivables_account_id) references erp_ledger_accounts (tenant_id, id),
  constraint erp_ledger_settings_revenue_services_fk
    foreign key (tenant_id, revenue_services_account_id) references erp_ledger_accounts (tenant_id, id),
  constraint erp_ledger_settings_revenue_goods_fk
    foreign key (tenant_id, revenue_goods_account_id) references erp_ledger_accounts (tenant_id, id),
  constraint erp_ledger_settings_vat_output_fk
    foreign key (tenant_id, vat_output_account_id) references erp_ledger_accounts (tenant_id, id),
  constraint erp_ledger_settings_cash_fk
    foreign key (tenant_id, cash_account_id) references erp_ledger_accounts (tenant_id, id),
  constraint erp_ledger_settings_bank_fk
    foreign key (tenant_id, bank_account_id) references erp_ledger_accounts (tenant_id, id),
  constraint erp_ledger_settings_other_receipts_fk
    foreign key (tenant_id, other_receipts_account_id) references erp_ledger_accounts (tenant_id, id),
  constraint erp_ledger_settings_inventory_fk
    foreign key (tenant_id, inventory_account_id) references erp_ledger_accounts (tenant_id, id),
  constraint erp_ledger_settings_goods_received_fk
    foreign key (tenant_id, goods_received_account_id) references erp_ledger_accounts (tenant_id, id),
  constraint erp_ledger_settings_parts_cost_fk
    foreign key (tenant_id, parts_cost_account_id) references erp_ledger_accounts (tenant_id, id),
  constraint erp_ledger_settings_stock_adjustments_fk
    foreign key (tenant_id, stock_adjustments_account_id) references erp_ledger_accounts (tenant_id, id),
  constraint erp_ledger_settings_opening_balances_fk
    foreign key (tenant_id, opening_balances_account_id) references erp_ledger_accounts (tenant_id, id),
  constraint erp_ledger_settings_retained_earnings_fk
    foreign key (tenant_id, retained_earnings_account_id) references erp_ledger_accounts (tenant_id, id)
);
comment on table erp_ledger_settings is
  'The ledger''s set-up: its start date, fiscal year, automatic posting switches and the account each automatic posting uses.';

create trigger erp_ledger_settings_set_updated_at
  before update on erp_ledger_settings
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- Periods: one row per month that has ever been locked
-- ---------------------------------------------------------------------------

create table erp_ledger_periods (
  tenant_id     uuid        not null references tenants (id) on delete restrict,
  -- The first day of the month.
  period_start  date        not null,
  locked        boolean     not null,
  changed_by    uuid        not null,
  changed_at    timestamptz not null default now(),
  constraint erp_ledger_periods_pkey primary key (tenant_id, period_start),
  constraint erp_ledger_periods_first_of_month check (extract(day from period_start) = 1)
);
comment on table erp_ledger_periods is
  'Which months are locked. A month without a row is open. Every change appends erp_ledger_period_events.';

create table erp_ledger_period_events (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete restrict,
  period_start  date        not null,
  kind          text        not null,
  reason        text,
  actor_id      uuid        not null,
  occurred_at   timestamptz not null default now(),
  constraint erp_ledger_period_events_kind_known check (kind in ('locked', 'unlocked')),
  -- An unlock always says why.
  constraint erp_ledger_period_events_reason_shape check (
    (kind = 'unlocked') <= (reason is not null and btrim(reason) <> '')
    and (reason is null or char_length(reason) <= 1000))
);
create index erp_ledger_period_events_by_period on erp_ledger_period_events (tenant_id, period_start, occurred_at desc);

-- Whether a month is locked for this company.
create function erp_ledger_period_locked(p_tenant uuid, p_date date) returns boolean
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select coalesce(
    (select p.locked from erp_ledger_periods p
      where p.tenant_id = p_tenant and p.period_start = date_trunc('month', p_date)::date),
    false);
$$;

-- ---------------------------------------------------------------------------
-- Journal numbers
-- ---------------------------------------------------------------------------

create table journal_reference_counters (
  tenant_id       uuid    primary key references tenants (id) on delete restrict,
  last_reference  integer not null
);
comment on table journal_reference_counters is
  'The last journal number handed out per company. Written only by assign_journal_reference.';

-- ---------------------------------------------------------------------------
-- Journals
-- ---------------------------------------------------------------------------

create table erp_journals (
  id                uuid           primary key default gen_random_uuid(),
  tenant_id         uuid           not null references tenants (id) on delete restrict,
  -- Per company, from 1, shown as JV-000123; given when posted.
  reference         integer,
  status            text           not null default 'draft',
  kind              text           not null,
  entry_date        date           not null,
  memo              text,
  -- The document an automatic journal posts, once.
  source_kind       text,
  source_id         uuid,
  reversal_of       uuid,
  -- A document in another currency: its currency and the rate typed for it.
  foreign_currency  text,
  exchange_rate     numeric(20, 10),
  rate_source       text,
  drafted_by        uuid           not null,
  drafted_at        timestamptz    not null default now(),
  posted_by         uuid,
  posted_at         timestamptz,
  -- Posted by the person who drafted it, as the company's settings allow.
  self_approved     boolean        not null default false,
  created_at        timestamptz    not null default now(),
  updated_at        timestamptz    not null default now(),
  constraint erp_journals_tenant_id_unique unique (tenant_id, id),
  constraint erp_journals_reference_unique unique (tenant_id, reference),
  constraint erp_journals_status_known check (status in ('draft', 'posted')),
  constraint erp_journals_kind_known check (kind in ('manual', 'opening', 'automatic', 'reversal', 'closing')),
  constraint erp_journals_source_kind_known check (
    source_kind is null or source_kind in ('invoice', 'credit_note', 'invoice_void', 'payment', 'stock')),
  constraint erp_journals_source_pairing check (
    (kind = 'automatic') = (source_kind is not null)
    and (source_kind is null) = (source_id is null)),
  constraint erp_journals_reversal_pairing check ((kind = 'reversal') = (reversal_of is not null)),
  constraint erp_journals_posted_pairing check (
    (status = 'posted') = (posted_by is not null)
    and (posted_by is null) = (posted_at is null)
    and (posted_at is null) = (reference is null)),
  constraint erp_journals_foreign_pairing check (
    (foreign_currency is null) = (exchange_rate is null)
    and (exchange_rate is null) = (rate_source is null)),
  constraint erp_journals_foreign_shape check (
    (foreign_currency is null or foreign_currency ~ '^[A-Z]{3}$')
    and (exchange_rate is null or exchange_rate > 0)
    and (rate_source is null or (btrim(rate_source) <> '' and char_length(rate_source) <= 200))),
  constraint erp_journals_memo_length check (memo is null or char_length(memo) <= 2000),
  constraint erp_journals_reversal_fk
    foreign key (tenant_id, reversal_of) references erp_journals (tenant_id, id) on delete no action
);
comment on table erp_journals is
  'Double-entry journals. Posted ones are numbered, balanced and never change; a mistake is reversed.';

-- A document posts once; a journal is reversed once; a company has one opening journal.
create unique index erp_journals_source_unique
  on erp_journals (tenant_id, source_kind, source_id) where source_kind is not null;
create unique index erp_journals_reversal_unique
  on erp_journals (tenant_id, reversal_of) where reversal_of is not null;
create unique index erp_journals_opening_unique
  on erp_journals (tenant_id) where kind = 'opening';
create index erp_journals_by_date on erp_journals (tenant_id, entry_date, reference) where status = 'posted';
create index erp_journals_drafts on erp_journals (tenant_id, drafted_at desc) where status = 'draft';

create trigger erp_journals_set_updated_at
  before update on erp_journals
  for each row execute function set_updated_at();

create table erp_journal_lines (
  id              uuid           primary key default gen_random_uuid(),
  tenant_id       uuid           not null references tenants (id) on delete restrict,
  journal_id      uuid           not null,
  line_no         integer        not null,
  account_id      uuid           not null,
  debit           numeric(20, 4) not null default 0,
  credit          numeric(20, 4) not null default 0,
  memo            text,
  -- The customer a receivables line belongs to, for the reconciliation.
  customer_id     uuid,
  -- The line in the document's currency, when the journal has one.
  foreign_amount  numeric(20, 4),
  constraint erp_journal_lines_tenant_id_unique unique (tenant_id, id),
  constraint erp_journal_lines_line_unique unique (tenant_id, journal_id, line_no),
  constraint erp_journal_lines_journal_fk
    foreign key (tenant_id, journal_id) references erp_journals (tenant_id, id) on delete cascade,
  constraint erp_journal_lines_account_fk
    foreign key (tenant_id, account_id) references erp_ledger_accounts (tenant_id, id) on delete restrict,
  constraint erp_journal_lines_customer_fk
    foreign key (tenant_id, customer_id) references customers (tenant_id, id) on delete restrict,
  -- A debit or a credit, never both, never nothing.
  constraint erp_journal_lines_one_side check (
    debit >= 0 and credit >= 0 and (debit > 0) <> (credit > 0)),
  constraint erp_journal_lines_foreign_not_negative check (foreign_amount is null or foreign_amount >= 0),
  constraint erp_journal_lines_line_no_positive check (line_no > 0),
  constraint erp_journal_lines_memo_length check (memo is null or char_length(memo) <= 500)
);
create index erp_journal_lines_by_account on erp_journal_lines (tenant_id, account_id);
create index erp_journal_lines_by_customer on erp_journal_lines (tenant_id, customer_id) where customer_id is not null;

-- ---------------------------------------------------------------------------
-- Year-end closes
-- ---------------------------------------------------------------------------

create table erp_ledger_year_closes (
  id                    uuid        primary key default gen_random_uuid(),
  tenant_id             uuid        not null references tenants (id) on delete restrict,
  -- The first day of the fiscal year.
  year_start            date        not null,
  closing_journal_id    uuid        not null,
  closed_by             uuid        not null,
  closed_at             timestamptz not null default now(),
  reopened_by           uuid,
  reopened_at           timestamptz,
  reopen_reason         text,
  reopening_journal_id  uuid,
  constraint erp_ledger_year_closes_tenant_id_unique unique (tenant_id, id),
  constraint erp_ledger_year_closes_closing_fk
    foreign key (tenant_id, closing_journal_id) references erp_journals (tenant_id, id),
  constraint erp_ledger_year_closes_reopening_fk
    foreign key (tenant_id, reopening_journal_id) references erp_journals (tenant_id, id),
  constraint erp_ledger_year_closes_first_of_month check (extract(day from year_start) = 1),
  constraint erp_ledger_year_closes_reopen_pairing check (
    (reopened_at is null) = (reopened_by is null)
    and (reopened_by is null) = (reopen_reason is null)
    and (reopen_reason is null) = (reopening_journal_id is null)),
  constraint erp_ledger_year_closes_reason_length check (
    reopen_reason is null or (btrim(reopen_reason) <> '' and char_length(reopen_reason) <= 1000))
);
-- A year is closed at most once at a time.
create unique index erp_ledger_year_closes_open_unique
  on erp_ledger_year_closes (tenant_id, year_start) where reopened_at is null;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

-- Posting: the one moment a journal is checked, then frozen.
create function erp_journals_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  settings     erp_ledger_settings%rowtype;
  total_debit  numeric;
  total_credit numeric;
  line_count   integer;
  reversed     erp_journals%rowtype;
begin
  if tg_op = 'DELETE' then
    if old.status = 'draft' or integr8_purging(old.tenant_id) then
      return old;
    end if;
    raise exception 'A posted journal is never deleted; reverse it'
      using errcode = 'check_violation', constraint = 'erp_journals_frozen';
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' or new.posted_by is not null then
      raise exception 'A journal is written as a draft and then posted'
        using errcode = 'check_violation', constraint = 'erp_journals_insert_draft';
    end if;
    return new;
  end if;

  if old.status = 'posted' then
    raise exception 'A posted journal does not change; reverse it'
      using errcode = 'check_violation', constraint = 'erp_journals_frozen';
  end if;
  if new.status = 'draft' then
    return new;
  end if;

  -- Draft to posted: everything is checked here.
  select * into settings from erp_ledger_settings where tenant_id = new.tenant_id;
  if not found then
    raise exception 'The ledger is not set up'
      using errcode = 'check_violation', constraint = 'erp_journals_ledger_not_set_up';
  end if;
  if new.entry_date < settings.start_date then
    raise exception 'A journal is not dated before the ledger''s start'
      using errcode = 'check_violation', constraint = 'erp_journals_before_start';
  end if;
  if erp_ledger_period_locked(new.tenant_id, new.entry_date) then
    raise exception 'That month is locked'
      using errcode = 'check_violation', constraint = 'erp_journals_period_locked';
  end if;

  select coalesce(sum(l.debit), 0), coalesce(sum(l.credit), 0), count(*)
    into total_debit, total_credit, line_count
    from erp_journal_lines l
   where l.tenant_id = new.tenant_id and l.journal_id = new.id;
  if line_count < 2 or total_debit = 0 or total_debit <> total_credit then
    raise exception 'A journal balances: debits % against credits %', total_debit, total_credit
      using errcode = 'check_violation', constraint = 'erp_journals_unbalanced';
  end if;
  if exists (select 1 from erp_journal_lines l
               join erp_ledger_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
              where l.tenant_id = new.tenant_id and l.journal_id = new.id and a.archived_at is not null) then
    raise exception 'An archived account takes no new postings'
      using errcode = 'check_violation', constraint = 'erp_journals_account_archived';
  end if;

  -- Segregation of duties for what a person writes by hand.
  if new.kind in ('manual', 'opening') then
    if new.posted_by = new.drafted_by then
      if not (new.self_approved and settings.allow_self_approval) then
        raise exception 'A manual journal is posted by someone other than its drafter'
          using errcode = 'check_violation', constraint = 'erp_journals_self_approval';
      end if;
    elsif new.self_approved then
      new.self_approved := false;
    end if;
  elsif new.self_approved then
    new.self_approved := false;
  end if;

  if new.kind = 'reversal' then
    select * into reversed from erp_journals where tenant_id = new.tenant_id and id = new.reversal_of;
    if reversed.status is distinct from 'posted' then
      raise exception 'Only a posted journal is reversed'
        using errcode = 'check_violation', constraint = 'erp_journals_reversal_not_posted';
    end if;
  end if;

  return new;
end;
$$;
create trigger erp_journals_guard
  before insert or update or delete on erp_journals
  for each row execute function erp_journals_guard();

-- Numbered when posted, after the guard has passed it ('guard' < 'number').
create function assign_journal_reference() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
begin
  if old.status = 'posted' or new.status <> 'posted' then
    return new;
  end if;
  insert into public.journal_reference_counters as counter (tenant_id, last_reference)
  values (new.tenant_id, 1)
  on conflict (tenant_id) do update set last_reference = counter.last_reference + 1
  returning last_reference into new.reference;
  return new;
end;
$$;
comment on function assign_journal_reference() is
  'Numbers a journal when it is posted. Security definer: the runtime role cannot write the counter.';
create trigger erp_journals_number
  before update on erp_journals
  for each row execute function assign_journal_reference();

create function erp_journal_lines_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  journal_status text;
begin
  if integr8_purging(coalesce(new.tenant_id, old.tenant_id)) then
    return coalesce(new, old);
  end if;
  select status into journal_status
    from erp_journals
   where tenant_id = coalesce(new.tenant_id, old.tenant_id) and id = coalesce(new.journal_id, old.journal_id);
  -- A draft's lines change freely, and go with a discarded draft.
  if journal_status is null or journal_status = 'draft' then
    return coalesce(new, old);
  end if;
  raise exception 'A posted journal''s lines do not change'
    using errcode = 'check_violation', constraint = 'erp_journal_lines_frozen';
end;
$$;
create trigger erp_journal_lines_guard
  before insert or update or delete on erp_journal_lines
  for each row execute function erp_journal_lines_guard();

-- An account's type decides the reports; once posted to, it stays.
create function erp_ledger_accounts_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if new.type <> old.type and exists (
    select 1 from erp_journal_lines l
      join erp_journals j on j.tenant_id = l.tenant_id and j.id = l.journal_id
     where l.tenant_id = old.tenant_id and l.account_id = old.id and j.status = 'posted') then
    raise exception 'An account posted to keeps its type'
      using errcode = 'check_violation', constraint = 'erp_ledger_accounts_type_fixed';
  end if;
  return new;
end;
$$;
create trigger erp_ledger_accounts_guard
  before update on erp_ledger_accounts
  for each row execute function erp_ledger_accounts_guard();

-- The start date and the fiscal year are fixed once anything is posted.
create function erp_ledger_settings_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if (new.start_date <> old.start_date or new.fiscal_start_month <> old.fiscal_start_month)
     and exists (select 1 from erp_journals j where j.tenant_id = old.tenant_id and j.status = 'posted') then
    raise exception 'The start date and fiscal year are fixed once a journal is posted'
      using errcode = 'check_violation', constraint = 'erp_ledger_settings_fixed';
  end if;
  return new;
end;
$$;
create trigger erp_ledger_settings_guard
  before update on erp_ledger_settings
  for each row execute function erp_ledger_settings_guard();

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------

-- Archived, never deleted.
grant select, insert, update on erp_ledger_accounts to integr8_app;
grant select, insert, update on erp_ledger_settings to integr8_app;
grant select, insert, update on erp_ledger_periods to integr8_app;
-- Appended, never changed.
grant select, insert on erp_ledger_period_events to integr8_app;
grant select on journal_reference_counters to integr8_app;
-- Drafts are discarded; the guards refuse anything else.
grant select, insert, update, delete on erp_journals to integr8_app;
grant select, insert, update, delete on erp_journal_lines to integr8_app;
grant select, insert, update on erp_ledger_year_closes to integr8_app;

alter table erp_ledger_accounts enable row level security;
create policy erp_ledger_accounts_isolation on erp_ledger_accounts
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_ledger_settings enable row level security;
create policy erp_ledger_settings_isolation on erp_ledger_settings
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_ledger_periods enable row level security;
create policy erp_ledger_periods_isolation on erp_ledger_periods
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_ledger_period_events enable row level security;
create policy erp_ledger_period_events_isolation on erp_ledger_period_events
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table journal_reference_counters enable row level security;
create policy journal_reference_counters_isolation on journal_reference_counters
  for select to integr8_app
  using (tenant_id = app_current_tenant_id());

alter table erp_journals enable row level security;
create policy erp_journals_isolation on erp_journals
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_journal_lines enable row level security;
create policy erp_journal_lines_isolation on erp_journal_lines
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_ledger_year_closes enable row level security;
create policy erp_ledger_year_closes_isolation on erp_ledger_year_closes
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
