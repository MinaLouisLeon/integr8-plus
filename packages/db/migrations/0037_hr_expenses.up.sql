-- Seventh round (ADR-0010): staff expense claims, and the ledger's posting
-- accounts for expenses, payroll and assembly.
--
-- A claim is submitted with its receipts (attachments), approved or rejected
-- by somebody other than its claimant, or withdrawn by its claimant while it
-- waits. An approved claim is paid back directly (cash or bank transfer) or
-- through the next pay run. Claims are in the company's currency.
--
-- The ledger: new posting accounts (staff claims payable, staff expenses,
-- salaries, employer insurance, salaries, tax, insurance and Martyrs' Fund
-- payable, assembly absorbed) are added to every chart already set up, and
-- two switches — expenses and payroll — join sales and stock. An approved
-- claim posts its category's expense against staff claims payable; paying it
-- back directly posts staff claims payable against cash or bank. The ledger's
-- functions from 0034 now hand anything newer to `_more` functions, which the
-- payroll and assembly migrations replace rather than the whole function.

-- ---------------------------------------------------------------------------
-- Posting accounts and switches
-- ---------------------------------------------------------------------------

alter table erp_ledger_settings
  add column auto_post_expenses boolean not null default true,
  add column auto_post_payroll boolean not null default true,
  add column staff_claims_payable_account_id uuid,
  add column staff_expenses_account_id uuid,
  add column salaries_expense_account_id uuid,
  add column employer_insurance_expense_account_id uuid,
  add column salaries_payable_account_id uuid,
  add column payroll_tax_payable_account_id uuid,
  add column social_insurance_payable_account_id uuid,
  add column martyrs_fund_payable_account_id uuid,
  add column assembly_absorbed_account_id uuid;

-- Every chart already set up gets the accounts the default chart now has: the
-- account with the default code when it is of the right type, otherwise a new
-- one beside it. Names in English; the company renames them as it likes.
do $$
declare
  s        record;
  want     record;
  found_id uuid;
  v_code   text;
begin
  for s in select tenant_id, created_by from erp_ledger_settings loop
    for want in
      select * from (values
        ('staff_claims_payable_account_id', '2410', 'liability', 'Staff expense claims payable'),
        ('staff_expenses_account_id', '6900', 'expense', 'Other expenses'),
        ('salaries_expense_account_id', '6100', 'expense', 'Salaries and wages'),
        ('employer_insurance_expense_account_id', '6110', 'expense', 'Employer social insurance'),
        ('salaries_payable_account_id', '2400', 'liability', 'Salaries payable'),
        ('payroll_tax_payable_account_id', '2310', 'liability', 'Salary income tax payable'),
        ('social_insurance_payable_account_id', '2320', 'liability', 'Social insurance payable'),
        ('martyrs_fund_payable_account_id', '2330', 'liability', 'Martyrs’ Fund payable'),
        ('assembly_absorbed_account_id', '5300', 'expense', 'Assembly labour and overhead absorbed')
      ) as w(col, code, type, name)
    loop
      v_code := want.code;
      found_id := null;
      select a.id into found_id from erp_ledger_accounts a
       where a.tenant_id = s.tenant_id and a.code = v_code and a.type = want.type and a.archived_at is null;
      if found_id is null then
        -- The default code is free, or taken by an account of another type.
        if exists (select 1 from erp_ledger_accounts a where a.tenant_id = s.tenant_id and a.code = v_code) then
          v_code := v_code || '-1';
        end if;
        insert into erp_ledger_accounts (tenant_id, code, name, type, created_by)
        values (s.tenant_id, v_code, want.name, want.type, s.created_by)
        returning id into found_id;
      end if;
      execute format('update erp_ledger_settings set %I = $1 where tenant_id = $2', want.col)
        using found_id, s.tenant_id;
    end loop;
  end loop;
end;
$$;

alter table erp_ledger_settings
  alter column staff_claims_payable_account_id set not null,
  alter column staff_expenses_account_id set not null,
  alter column salaries_expense_account_id set not null,
  alter column employer_insurance_expense_account_id set not null,
  alter column salaries_payable_account_id set not null,
  alter column payroll_tax_payable_account_id set not null,
  alter column social_insurance_payable_account_id set not null,
  alter column martyrs_fund_payable_account_id set not null,
  alter column assembly_absorbed_account_id set not null,
  add constraint erp_ledger_settings_staff_claims_payable_fk
    foreign key (tenant_id, staff_claims_payable_account_id) references erp_ledger_accounts (tenant_id, id),
  add constraint erp_ledger_settings_staff_expenses_fk
    foreign key (tenant_id, staff_expenses_account_id) references erp_ledger_accounts (tenant_id, id),
  add constraint erp_ledger_settings_salaries_expense_fk
    foreign key (tenant_id, salaries_expense_account_id) references erp_ledger_accounts (tenant_id, id),
  add constraint erp_ledger_settings_employer_insurance_expense_fk
    foreign key (tenant_id, employer_insurance_expense_account_id) references erp_ledger_accounts (tenant_id, id),
  add constraint erp_ledger_settings_salaries_payable_fk
    foreign key (tenant_id, salaries_payable_account_id) references erp_ledger_accounts (tenant_id, id),
  add constraint erp_ledger_settings_payroll_tax_payable_fk
    foreign key (tenant_id, payroll_tax_payable_account_id) references erp_ledger_accounts (tenant_id, id),
  add constraint erp_ledger_settings_social_insurance_payable_fk
    foreign key (tenant_id, social_insurance_payable_account_id) references erp_ledger_accounts (tenant_id, id),
  add constraint erp_ledger_settings_martyrs_fund_payable_fk
    foreign key (tenant_id, martyrs_fund_payable_account_id) references erp_ledger_accounts (tenant_id, id),
  add constraint erp_ledger_settings_assembly_absorbed_fk
    foreign key (tenant_id, assembly_absorbed_account_id) references erp_ledger_accounts (tenant_id, id);

-- What a journal and a captured document may come from.
alter table erp_journals drop constraint erp_journals_source_kind_known;
alter table erp_journals add constraint erp_journals_source_kind_known check (
  source_kind is null or source_kind in (
    'invoice', 'credit_note', 'invoice_void', 'payment', 'stock',
    'expense_claim', 'expense_payment', 'payroll_run', 'assembly'));
alter table erp_ledger_postings drop constraint erp_ledger_postings_source_kind_known;
alter table erp_ledger_postings add constraint erp_ledger_postings_source_kind_known check (
  source_kind in (
    'invoice', 'credit_note', 'invoice_void', 'payment', 'stock',
    'expense_claim', 'expense_payment', 'payroll_run', 'assembly'));

-- ---------------------------------------------------------------------------
-- Expense categories and claims
-- ---------------------------------------------------------------------------

create table hr_expense_categories (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants (id) on delete restrict,
  name         text        not null,
  -- The expense account an approved claim posts to; the staff expenses
  -- account when none.
  account_id   uuid,
  archived_at  timestamptz,
  version      integer     not null default 1,
  created_by   uuid        not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint hr_expense_categories_tenant_id_unique unique (tenant_id, id),
  constraint hr_expense_categories_account_fk
    foreign key (tenant_id, account_id) references erp_ledger_accounts (tenant_id, id),
  constraint hr_expense_categories_name_present check (btrim(name) <> '' and char_length(name) <= 100),
  constraint hr_expense_categories_version_positive check (version > 0)
);
create unique index hr_expense_categories_name_unique on hr_expense_categories (tenant_id, lower(name))
  where archived_at is null;
create trigger hr_expense_categories_set_updated_at
  before update on hr_expense_categories
  for each row execute function set_updated_at();

create table expense_reference_counters (
  tenant_id       uuid    primary key references tenants (id) on delete restrict,
  last_reference  integer not null
);
comment on table expense_reference_counters is
  'The last expense claim number handed out per company. Written only by assign_expense_reference.';

create function assign_expense_reference() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.reference is distinct from old.reference then
      raise exception 'An expense claim keeps its number'
        using errcode = 'check_violation', constraint = 'hr_expense_claims_reference_fixed';
    end if;
    return new;
  end if;
  insert into public.expense_reference_counters as counter (tenant_id, last_reference)
  values (new.tenant_id, 1)
  on conflict (tenant_id) do update set last_reference = counter.last_reference + 1
  returning last_reference into new.reference;
  return new;
end;
$$;
comment on function assign_expense_reference() is
  'Numbers an expense claim when it is submitted, and keeps the number. Security definer: the runtime role cannot write the counter.';

create table hr_expense_claims (
  id                 uuid           primary key default gen_random_uuid(),
  tenant_id          uuid           not null references tenants (id) on delete restrict,
  -- Per company, from 1, shown as EX-000123.
  reference          integer        not null default 0,
  claimant_id        uuid           not null,
  category_id        uuid           not null,
  work_order_id      uuid,
  spent_on           date           not null,
  amount             numeric(20,4)  not null,
  currency           text           not null,
  description        text           not null,
  status             text           not null default 'submitted',
  -- The phone's id for submitting it, so a resent claim lands once.
  client_action_id   uuid,
  submitted_at       timestamptz    not null default now(),
  decided_by         uuid,
  decided_at         timestamptz,
  reject_reason      text,
  -- How an approved claim is to be paid back.
  settle_via         text,
  paid_via           text,
  paid_by            uuid,
  paid_at            timestamptz,
  payment_reference  text,
  version            integer        not null default 1,
  updated_at         timestamptz    not null default now(),
  constraint hr_expense_claims_tenant_id_unique unique (tenant_id, id),
  constraint hr_expense_claims_reference_unique unique (tenant_id, reference),
  constraint hr_expense_claims_client_action_unique unique (tenant_id, client_action_id),
  constraint hr_expense_claims_claimant_fk
    foreign key (tenant_id, claimant_id) references tenant_users (tenant_id, user_id),
  constraint hr_expense_claims_category_fk
    foreign key (tenant_id, category_id) references hr_expense_categories (tenant_id, id),
  constraint hr_expense_claims_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id),
  constraint hr_expense_claims_amount_positive check (amount > 0),
  constraint hr_expense_claims_currency_shape check (currency ~ '^[A-Z]{3}$'),
  constraint hr_expense_claims_description_present check (
    btrim(description) <> '' and char_length(description) <= 1000),
  constraint hr_expense_claims_status_known check (
    status in ('submitted', 'approved', 'rejected', 'withdrawn', 'paid')),
  constraint hr_expense_claims_settle_via_known check (
    settle_via is null or settle_via in ('direct', 'payroll')),
  constraint hr_expense_claims_paid_via_known check (
    paid_via is null or paid_via in ('cash', 'bank_transfer', 'payroll')),
  -- Decided once, by somebody, with a reason when rejected; never by the claimant.
  constraint hr_expense_claims_decision_pairing check (
    (status in ('approved', 'rejected', 'paid')) = (decided_by is not null)
    and (decided_by is null) = (decided_at is null)
    and (status = 'rejected') = (reject_reason is not null)
    and (status in ('approved', 'paid')) = (settle_via is not null)),
  constraint hr_expense_claims_not_self_approved check (decided_by is null or decided_by <> claimant_id),
  constraint hr_expense_claims_paid_pairing check (
    (status = 'paid') = (paid_via is not null)
    and (paid_via is null) = (paid_at is null)
    and (paid_via is null or paid_via = 'payroll' or paid_by is not null)
    and (paid_via is null or (paid_via = 'payroll') = (settle_via = 'payroll'))),
  constraint hr_expense_claims_text_lengths check (
    (reject_reason is null or (btrim(reject_reason) <> '' and char_length(reject_reason) <= 1000))
    and (payment_reference is null or char_length(payment_reference) <= 200)),
  constraint hr_expense_claims_version_positive check (version > 0)
);
create index hr_expense_claims_claimant on hr_expense_claims (tenant_id, claimant_id, submitted_at desc);
create index hr_expense_claims_open on hr_expense_claims (tenant_id, status) where status in ('submitted', 'approved');
create trigger hr_expense_claims_number
  before insert or update on hr_expense_claims
  for each row execute function assign_expense_reference();
create trigger hr_expense_claims_set_updated_at
  before update on hr_expense_claims
  for each row execute function set_updated_at();

-- What a claim says never changes once submitted; its status moves forward
-- only: submitted → approved, rejected or withdrawn; approved → paid.
create function hr_expense_claims_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    if integr8_purging(old.tenant_id) then
      return old;
    end if;
    raise exception 'An expense claim is never deleted'
      using errcode = 'check_violation', constraint = 'hr_expense_claims_frozen';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'submitted' then
      raise exception 'An expense claim starts submitted'
        using errcode = 'check_violation', constraint = 'hr_expense_claims_transition';
    end if;
    return new;
  end if;
  if (new.claimant_id, new.category_id, new.work_order_id, new.spent_on, new.amount, new.currency,
      new.description, new.submitted_at, new.client_action_id)
     is distinct from
     (old.claimant_id, old.category_id, old.work_order_id, old.spent_on, old.amount, old.currency,
      old.description, old.submitted_at, old.client_action_id) then
    raise exception 'A submitted claim does not change; withdraw it and claim again'
      using errcode = 'check_violation', constraint = 'hr_expense_claims_frozen';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'submitted' and new.status in ('approved', 'rejected', 'withdrawn'))
    or (old.status = 'approved' and new.status = 'paid')) then
    raise exception 'An expense claim cannot go from % to %', old.status, new.status
      using errcode = 'check_violation', constraint = 'hr_expense_claims_transition';
  end if;
  if old.status in ('rejected', 'withdrawn', 'paid') then
    raise exception 'A settled claim does not change'
      using errcode = 'check_violation', constraint = 'hr_expense_claims_frozen';
  end if;
  return new;
end;
$$;
create trigger hr_expense_claims_guard
  before insert or update or delete on hr_expense_claims
  for each row execute function hr_expense_claims_guard();

-- Receipts are files attached to the claim.
alter table attachments
  add column expense_claim_id uuid,
  add constraint attachments_expense_claim_fk
    foreign key (tenant_id, expense_claim_id) references hr_expense_claims (tenant_id, id),
  drop constraint attachments_one_owner,
  add constraint attachments_one_owner
    check (num_nonnulls(customer_id, site_id, work_order_id, asset_id, expense_claim_id) = 1);
create index attachments_expense_claim_idx on attachments (tenant_id, expense_claim_id)
  where expense_claim_id is not null;

-- ---------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------

-- Which switch a captured document follows.
create function erp_ledger_auto_on(s erp_ledger_settings, p_kind text) returns boolean
  language sql
  immutable
  set search_path = pg_catalog, public
as $$
  select case
    when p_kind in ('stock', 'assembly') then s.auto_post_stock
    when p_kind in ('expense_claim', 'expense_payment') then s.auto_post_expenses
    when p_kind = 'payroll_run' then s.auto_post_payroll
    else s.auto_post_sales
  end;
$$;

-- What documents added after 0034 post. Replaced, whole, by later migrations
-- as kinds arrive; always in the company's currency.
create function erp_ledger_proposal_more(p_tenant uuid, p_kind text, p_source uuid)
  returns table (account_id uuid, debit numeric, credit numeric, customer_id uuid)
  language plpgsql
  stable
  set search_path = pg_catalog, public
as $$
declare
  s erp_ledger_settings%rowtype;
begin
  select * into s from erp_ledger_settings where tenant_id = p_tenant;
  if not found then
    return;
  end if;

  if p_kind = 'expense_claim' then
    return query
    select coalesce(c.account_id, s.staff_expenses_account_id), x.amount, 0::numeric, null::uuid
      from hr_expense_claims x
      join hr_expense_categories c on c.tenant_id = x.tenant_id and c.id = x.category_id
     where x.tenant_id = p_tenant and x.id = p_source
    union all
    select s.staff_claims_payable_account_id, 0::numeric, x.amount, null::uuid
      from hr_expense_claims x where x.tenant_id = p_tenant and x.id = p_source;
    return;
  end if;

  if p_kind = 'expense_payment' then
    return query
    select s.staff_claims_payable_account_id, x.amount, 0::numeric, null::uuid
      from hr_expense_claims x where x.tenant_id = p_tenant and x.id = p_source
    union all
    select case x.paid_via when 'cash' then s.cash_account_id else s.bank_account_id end,
           0::numeric, x.amount, null::uuid
      from hr_expense_claims x where x.tenant_id = p_tenant and x.id = p_source;
    return;
  end if;
end;
$$;

create function erp_ledger_source_label_more(p_tenant uuid, p_kind text, p_source uuid) returns text
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select case p_kind
    when 'expense_claim' then (select 'EX-' || lpad(x.reference::text, 6, '0') from hr_expense_claims x
                                where x.tenant_id = p_tenant and x.id = p_source)
    when 'expense_payment' then (select 'EX-' || lpad(x.reference::text, 6, '0') || ' paid' from hr_expense_claims x
                                  where x.tenant_id = p_tenant and x.id = p_source)
    else null
  end;
$$;

-- What was recorded on or after the start, of kinds added after 0034.
create function erp_ledger_backfill_more(p_tenant uuid, p_start date, p_tz text) returns integer
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
declare
  added integer;
begin
  with found as (
    select 'expense_claim' as kind, x.id, (x.decided_at at time zone p_tz)::date as day, x.currency
      from hr_expense_claims x
     where x.tenant_id = p_tenant and x.status in ('approved', 'paid')
       and (x.decided_at at time zone p_tz)::date >= p_start
    union all
    select 'expense_payment', x.id, (x.paid_at at time zone p_tz)::date, x.currency
      from hr_expense_claims x
     where x.tenant_id = p_tenant and x.status = 'paid' and x.paid_via in ('cash', 'bank_transfer')
       and (x.paid_at at time zone p_tz)::date >= p_start
  ), inserted as (
    insert into erp_ledger_postings (tenant_id, source_kind, source_id, document_date, currency, reason)
    select p_tenant, f.kind, f.id, f.day, f.currency, 'before_set_up' from found f
    on conflict (tenant_id, source_kind, source_id) do nothing
    returning 1
  )
  select count(*) into added from inserted;
  return added;
end;
$$;
comment on function erp_ledger_backfill_more(uuid, date, text) is
  'Queues documents of kinds added after 0034 for review. Security definer: the runtime role cannot write the queue.';

create or replace function erp_ledger_proposal(p_tenant uuid, p_kind text, p_source uuid)
  returns table (account_id uuid, debit numeric, credit numeric, customer_id uuid)
  language plpgsql
  stable
  set search_path = pg_catalog, public
as $$
declare
  s          erp_ledger_settings%rowtype;
  invoice_id uuid;
  customer   uuid;
  total      numeric;
  sign       integer;
begin
  select * into s from erp_ledger_settings where tenant_id = p_tenant;
  if not found then
    return;
  end if;

  if p_kind in ('invoice', 'invoice_void') then
    select i.customer_id, erp_invoice_total(i.tenant_id, i.id) into customer, total
      from erp_invoices i where i.tenant_id = p_tenant and i.id = p_source;
    sign := case when p_kind = 'invoice' then 1 else -1 end;
    return query
    with nets as (
      select case when it.kind in ('stock_item', 'non_stock_item')
                  then s.revenue_goods_account_id else s.revenue_services_account_id end as account,
             round(g.gross - round(g.gross * l.discount_bp / 10000, 4), 4) as net
        from erp_invoice_lines l
        cross join lateral (select round(l.quantity * l.unit_price, 4) as gross) g
        left join erp_items it on it.tenant_id = l.tenant_id and it.id = l.item_id
       where l.tenant_id = p_tenant and l.invoice_id = p_source
    ), signed as (
      select 1 as ord, s.receivables_account_id as account, total * sign as amount, customer as customer
      union all
      select 2, n.account, -sum(n.net) * sign, null::uuid from nets n group by n.account
      union all
      select 3, s.vat_output_account_id, -(total - coalesce((select sum(n.net) from nets n), 0)) * sign, null::uuid
    )
    select x.account, greatest(x.amount, 0), greatest(-x.amount, 0), x.customer
      from signed x
      join erp_ledger_accounts a on a.tenant_id = p_tenant and a.id = x.account
     where x.amount <> 0
     order by x.ord, a.code;
    return;
  end if;

  if p_kind = 'credit_note' then
    select c.invoice_id, i.customer_id, erp_credit_note_total(c.tenant_id, c.id)
      into invoice_id, customer, total
      from erp_credit_notes c
      join erp_invoices i on i.tenant_id = c.tenant_id and i.id = c.invoice_id
     where c.tenant_id = p_tenant and c.id = p_source;
    return query
    with nets as (
      select case when it.kind in ('stock_item', 'non_stock_item')
                  then s.revenue_goods_account_id else s.revenue_services_account_id end as account,
             round(g.gross - round(g.gross * l.discount_bp / 10000, 4), 4) as net
        from erp_credit_note_lines l
        cross join lateral (select round(l.quantity * l.unit_price, 4) as gross) g
        left join erp_items it on it.tenant_id = l.tenant_id and it.id = l.item_id
       where l.tenant_id = p_tenant and l.credit_note_id = p_source
    ), signed as (
      select 3 as ord, s.receivables_account_id as account, -total as amount, customer as customer
      union all
      select 1, n.account, sum(n.net), null::uuid from nets n group by n.account
      union all
      select 2, s.vat_output_account_id, total - coalesce((select sum(n.net) from nets n), 0), null::uuid
    )
    select x.account, greatest(x.amount, 0), greatest(-x.amount, 0), x.customer
      from signed x
      join erp_ledger_accounts a on a.tenant_id = p_tenant and a.id = x.account
     where x.amount <> 0
     order by x.ord, a.code;
    return;
  end if;

  if p_kind = 'payment' then
    return query
    with signed as (
      select 1 as ord,
             case r.method when 'cash' then s.cash_account_id
                           when 'bank_transfer' then s.bank_account_id
                           else s.other_receipts_account_id end as account,
             r.amount as amount, null::uuid as customer
        from erp_payment_receipts r where r.tenant_id = p_tenant and r.id = p_source
      union all
      select 2, s.receivables_account_id, -r.amount, r.customer_id
        from erp_payment_receipts r where r.tenant_id = p_tenant and r.id = p_source
    )
    select x.account, greatest(x.amount, 0), greatest(-x.amount, 0), x.customer
      from signed x
      join erp_ledger_accounts a on a.tenant_id = p_tenant and a.id = x.account
     where x.amount <> 0
     order by x.ord, a.code;
    return;
  end if;

  if p_kind = 'stock' then
    return query
    with valued as (
      select m.kind, m.source_key, round(m.quantity * m.unit_cost, 4) as value
        from erp_stock_movements m
       where m.tenant_id = p_tenant and m.posting_id = p_source
         and m.kind not in ('transfer_out', 'transfer_in')
    ), signed as (
      select s.inventory_account_id as account, v.value as amount from valued v
      union all
      select case
               when v.kind = 'receipt' and v.source_key like 'receipt-line:%' then s.goods_received_account_id
               when v.kind = 'return_to_supplier' then s.goods_received_account_id
               when v.kind in ('consumption', 'consumption_return') then s.parts_cost_account_id
               else s.stock_adjustments_account_id
             end,
             -v.value
        from valued v
    ), grouped as (
      select g.account, sum(g.amount) as amount from signed g group by g.account
    )
    select x.account, greatest(x.amount, 0), greatest(-x.amount, 0), null::uuid
      from grouped x
      join erp_ledger_accounts a on a.tenant_id = p_tenant and a.id = x.account
     where x.amount <> 0
     order by x.amount < 0, a.code;
    return;
  end if;

  -- Documents added after 0034 (expense claims, pay runs, assemblies).
  return query select * from erp_ledger_proposal_more(p_tenant, p_kind, p_source);
end;
$$;

create or replace function erp_ledger_source_label(p_tenant uuid, p_kind text, p_source uuid) returns text
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select case p_kind
    when 'invoice' then (select 'INV-' || lpad(i.reference::text, 6, '0') from erp_invoices i
                          where i.tenant_id = p_tenant and i.id = p_source)
    when 'invoice_void' then (select 'INV-' || lpad(i.reference::text, 6, '0') || ' void' from erp_invoices i
                               where i.tenant_id = p_tenant and i.id = p_source)
    when 'credit_note' then (select 'CN-' || lpad(c.reference::text, 6, '0') from erp_credit_notes c
                              where c.tenant_id = p_tenant and c.id = p_source)
    when 'payment' then (select 'RC-' || lpad(r.reference::text, 6, '0') from erp_payment_receipts r
                          where r.tenant_id = p_tenant and r.id = p_source)
    else erp_ledger_source_label_more(p_tenant, p_kind, p_source)
  end;
$$;

create or replace function erp_ledger_try_post(p_posting uuid, p_actor uuid, p_force boolean default false)
  returns text
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
declare
  p          erp_ledger_postings%rowtype;
  s          erp_ledger_settings%rowtype;
  parent     uuid;
  parent_row erp_ledger_postings%rowtype;
  journal    uuid;
  debits     numeric;
  lines      integer;
  outcome    text;
begin
  select * into p from erp_ledger_postings where id = p_posting for update;
  if not found or p.status <> 'pending' then
    return coalesce(p.status, 'missing');
  end if;
  select * into s from erp_ledger_settings where tenant_id = p.tenant_id;
  if not found then
    return 'not_set_up';
  end if;

  -- A credit note or a void follows its invoice: it is set aside with it, and
  -- waits while it waits.
  parent := erp_ledger_parent_invoice(p.tenant_id, p.source_kind, p.source_id);
  if parent is not null then
    select * into parent_row from erp_ledger_postings
     where tenant_id = p.tenant_id and source_kind = 'invoice' and source_id = parent;
    if parent_row.status = 'skipped' then
      update erp_ledger_postings
         set status = 'skipped', reason = null, detail = null, resolved_at = now(),
             resolved_by = p_actor, skip_reason = 'Its invoice was set aside'
       where id = p.id;
      return 'skipped';
    end if;
  end if;

  outcome := case
    when not p_force and not erp_ledger_auto_on(s, p.source_kind) then 'auto_off'
    when p.currency <> erp_ledger_currency(p.tenant_id) then 'foreign_currency'
    when p.source_kind = 'stock' and exists (
      select 1 from erp_stock_movements m
       where m.tenant_id = p.tenant_id and m.posting_id = p.source_id
         and m.kind not in ('transfer_out', 'transfer_in') and m.unit_cost is null) then 'cost_unknown'
    when erp_ledger_period_locked(p.tenant_id, p.document_date) then 'period_locked'
    else null
  end;

  if outcome is null and parent_row.status = 'pending' then
    outcome := 'waits_for_invoice';
  end if;

  if outcome is not null then
    update erp_ledger_postings set reason = outcome, detail = null where id = p.id;
    return outcome;
  end if;

  select coalesce(sum(x.debit), 0), count(*) into debits, lines
    from erp_ledger_proposal(p.tenant_id, p.source_kind, p.source_id) x;
  if lines = 0 or debits = 0 then
    update erp_ledger_postings
       set status = 'skipped', reason = null, detail = null, resolved_at = now(),
           resolved_by = null, skip_reason = 'Nothing to post'
     where id = p.id;
    return 'skipped';
  end if;

  begin
    insert into erp_journals (tenant_id, kind, entry_date, memo, source_kind, source_id, drafted_by)
    values (p.tenant_id, 'automatic', p.document_date,
            erp_ledger_source_label(p.tenant_id, p.source_kind, p.source_id),
            p.source_kind, p.source_id, p_actor)
    returning id into journal;
    insert into erp_journal_lines (tenant_id, journal_id, line_no, account_id, debit, credit, customer_id)
    select p.tenant_id, journal, x.n, x.account_id, x.debit, x.credit, x.customer_id
      from erp_ledger_proposal(p.tenant_id, p.source_kind, p.source_id)
           with ordinality as x(account_id, debit, credit, customer_id, n);
    update erp_journals set status = 'posted', posted_by = p_actor, posted_at = now()
     where tenant_id = p.tenant_id and id = journal;
    update erp_ledger_postings
       set status = 'posted', journal_id = journal, reason = null, detail = null,
           resolved_by = p_actor, resolved_at = now()
     where id = p.id;
  exception when others then
    update erp_ledger_postings set reason = 'failed', detail = left(sqlerrm, 1000) where id = p.id;
    return 'failed';
  end;

  -- An invoice posted: what was waiting for it may go now.
  if p.source_kind = 'invoice' then
    perform erp_ledger_try_post(w.id, p_actor, p_force)
       from erp_ledger_postings w
      where w.tenant_id = p.tenant_id and w.status = 'pending' and w.reason = 'waits_for_invoice'
        and erp_ledger_parent_invoice(w.tenant_id, w.source_kind, w.source_id) = p.source_id;
  end if;
  return 'posted';
end;
$$;

create or replace function erp_ledger_backfill(p_tenant uuid) returns integer
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
declare
  start  date;
  tz     text;
  added  integer;
begin
  select s.start_date into start from erp_ledger_settings s where s.tenant_id = p_tenant;
  if start is null then
    return 0;
  end if;
  tz := erp_ledger_timezone(p_tenant);
  delete from erp_ledger_postings
   where tenant_id = p_tenant and status = 'pending' and document_date < start;

  with found as (
    select 'invoice' as kind, i.id, i.issue_date as day, i.currency_code as currency
      from erp_invoices i
     where i.tenant_id = p_tenant and i.status <> 'draft' and i.issue_date >= start
    union all
    select 'invoice_void', i.id, (i.voided_at at time zone tz)::date, i.currency_code
      from erp_invoices i
     where i.tenant_id = p_tenant and i.status = 'void' and (i.voided_at at time zone tz)::date >= start
    union all
    select 'credit_note', c.id, c.issue_date, i.currency_code
      from erp_credit_notes c
      join erp_invoices i on i.tenant_id = c.tenant_id and i.id = c.invoice_id
     where c.tenant_id = p_tenant and c.status = 'issued' and c.issue_date >= start
    union all
    select 'payment', r.id, r.received_on, r.currency_code
      from erp_payment_receipts r
     where r.tenant_id = p_tenant and r.received_on >= start
    union all
    select distinct on (m.posting_id) 'stock', m.posting_id, (m.occurred_at at time zone tz)::date,
           erp_ledger_currency(p_tenant)
      from erp_stock_movements m
     where m.tenant_id = p_tenant and m.kind not in ('transfer_out', 'transfer_in')
       and (m.occurred_at at time zone tz)::date >= start
  ), inserted as (
    insert into erp_ledger_postings (tenant_id, source_kind, source_id, document_date, currency, reason)
    select p_tenant, f.kind, f.id, f.day, f.currency, 'before_set_up' from found f
    on conflict (tenant_id, source_kind, source_id) do nothing
    returning 1
  )
  select count(*) into added from inserted;
  return added + erp_ledger_backfill_more(p_tenant, start, tz);
end;
$$;

-- An approved claim posts; paying it back directly posts again.
create function hr_expense_claims_ledger_capture() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if old.status = 'submitted' and new.status = 'approved' then
    perform erp_ledger_capture(
      new.tenant_id, 'expense_claim', new.id,
      (new.decided_at at time zone erp_ledger_timezone(new.tenant_id))::date,
      new.currency, new.decided_by);
  elsif old.status = 'approved' and new.status = 'paid' and new.paid_via in ('cash', 'bank_transfer') then
    perform erp_ledger_capture(
      new.tenant_id, 'expense_payment', new.id,
      (new.paid_at at time zone erp_ledger_timezone(new.tenant_id))::date,
      new.currency, new.paid_by);
  end if;
  return null;
end;
$$;
create trigger hr_expense_claims_ledger_capture
  after update of status on hr_expense_claims
  for each row execute function hr_expense_claims_ledger_capture();

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------

-- Archived, never deleted.
grant select, insert, update on hr_expense_categories to integr8_app;
grant select on expense_reference_counters to integr8_app;
-- Settled, never deleted; the guard refuses the rest.
grant select, insert, update on hr_expense_claims to integr8_app;

alter table hr_expense_categories enable row level security;
create policy hr_expense_categories_isolation on hr_expense_categories
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table expense_reference_counters enable row level security;
create policy expense_reference_counters_isolation on expense_reference_counters
  for select to integr8_app
  using (tenant_id = app_current_tenant_id());

alter table hr_expense_claims enable row level security;
create policy hr_expense_claims_isolation on hr_expense_claims
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
