-- Seventh round (ADR-0011): bills of materials, assembly and disassembly
-- orders, and material planning.
--
-- A stock item's bill lists its components and a labour and overhead cost per
-- unit. Bills are versioned: a change is a new version, and the one it
-- replaces is kept, superseded, for the orders that used it. An assembly
-- order builds units of an item at a location from its bill; a disassembly
-- order takes units apart into their components. Completing one writes its
-- stock movements together — the parts out, the item in, or the reverse —
-- with the order's id as their posting, and never takes stock below zero. A
-- plan is a snapshot of what to build and buy, kept with who ran it.
--
-- The ledger: an order's movements post as one 'assembly' document rather
-- than as stock: inventory up by the labour and overhead an assembly adds,
-- against "assembly labour and overhead absorbed".

-- ---------------------------------------------------------------------------
-- Items: how long they take
-- ---------------------------------------------------------------------------

-- Days to build (an item with a bill) or to arrive (one bought); for one
-- bought, the preferred supplier's lead time when null (0027).
alter table erp_items
  add column lead_time_days integer,
  add constraint erp_items_lead_time_sane check (lead_time_days is null or lead_time_days between 0 and 3650);

-- ---------------------------------------------------------------------------
-- The stock ledger learns two kinds
-- ---------------------------------------------------------------------------

alter table erp_stock_movements drop constraint erp_stock_movements_kind_known;
alter table erp_stock_movements add constraint erp_stock_movements_kind_known check (kind in (
  'receipt', 'issue', 'transfer_out', 'transfer_in', 'adjustment', 'count_adjustment',
  'consumption', 'consumption_return', 'return_to_supplier',
  'assembly_consumption', 'assembly_output'));
alter table erp_stock_movements drop constraint erp_stock_movements_quantity_signed;
alter table erp_stock_movements add constraint erp_stock_movements_quantity_signed check (
  quantity <> 0 and case
    when kind in ('receipt', 'transfer_in', 'consumption_return', 'assembly_output') then quantity > 0
    when kind in ('issue', 'transfer_out', 'consumption', 'return_to_supplier', 'assembly_consumption') then quantity < 0
    else true
  end);

-- ---------------------------------------------------------------------------
-- Bills of materials
-- ---------------------------------------------------------------------------

create table erp_boms (
  id             uuid           primary key default gen_random_uuid(),
  tenant_id      uuid           not null references tenants (id) on delete restrict,
  item_id        uuid           not null,
  version        integer        not null,
  -- Per unit built, in the company currency.
  labour_cost    numeric(20,4)  not null default 0,
  overhead_cost  numeric(20,4)  not null default 0,
  note           text,
  created_by     uuid           not null,
  created_at     timestamptz    not null default now(),
  superseded_at  timestamptz,
  superseded_by  uuid,
  constraint erp_boms_tenant_id_unique unique (tenant_id, id),
  constraint erp_boms_version_unique unique (tenant_id, item_id, version),
  constraint erp_boms_item_fk foreign key (tenant_id, item_id) references erp_items (tenant_id, id),
  constraint erp_boms_costs_not_negative check (labour_cost >= 0 and overhead_cost >= 0),
  constraint erp_boms_version_positive check (version > 0),
  constraint erp_boms_note_length check (note is null or char_length(note) <= 1000),
  constraint erp_boms_superseded_pairing check ((superseded_at is null) = (superseded_by is null))
);
-- One version in use per item.
create unique index erp_boms_active_unique on erp_boms (tenant_id, item_id) where superseded_at is null;
comment on table erp_boms is
  'Bill of materials versions (ADR-0011). Never changed: a change is a new version, and the old one is superseded.';

create table erp_bom_components (
  tenant_id  uuid           not null references tenants (id) on delete restrict,
  bom_id     uuid           not null,
  line_no    integer        not null,
  item_id    uuid           not null,
  -- Per unit built.
  quantity   numeric(20,4)  not null,
  constraint erp_bom_components_pkey primary key (tenant_id, bom_id, line_no),
  constraint erp_bom_components_item_unique unique (tenant_id, bom_id, item_id),
  constraint erp_bom_components_bom_fk foreign key (tenant_id, bom_id) references erp_boms (tenant_id, id),
  constraint erp_bom_components_item_fk foreign key (tenant_id, item_id) references erp_items (tenant_id, id),
  constraint erp_bom_components_quantity_positive check (quantity > 0),
  constraint erp_bom_components_line_positive check (line_no > 0)
);

-- A bill is for a stock item, of stock and non-stock items, never itself; a
-- version never changes once written, except to be superseded once.
create function erp_boms_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  item_kind text;
begin
  if tg_op = 'DELETE' then
    if coalesce(integr8_purging(old.tenant_id), false) then
      return old;
    end if;
    raise exception 'A bill of materials is never deleted; supersede it'
      using errcode = 'check_violation', constraint = 'erp_boms_frozen';
  end if;
  if tg_op = 'INSERT' then
    select kind into item_kind from erp_items where tenant_id = new.tenant_id and id = new.item_id;
    if item_kind is distinct from 'stock_item' then
      raise exception 'Only a stock item is built from a bill'
        using errcode = 'check_violation', constraint = 'erp_boms_stock_item';
    end if;
    if new.superseded_at is not null then
      raise exception 'A bill starts in use'
        using errcode = 'check_violation', constraint = 'erp_boms_frozen';
    end if;
    return new;
  end if;
  if old.superseded_at is not null
     or (new.item_id, new.version, new.labour_cost, new.overhead_cost, new.note, new.created_by, new.created_at)
        is distinct from
        (old.item_id, old.version, old.labour_cost, old.overhead_cost, old.note, old.created_by, old.created_at) then
    raise exception 'A bill of materials does not change; save a new version'
      using errcode = 'check_violation', constraint = 'erp_boms_frozen';
  end if;
  return new;
end;
$$;
create trigger erp_boms_guard
  before insert or update or delete on erp_boms
  for each row execute function erp_boms_guard();

create function erp_bom_components_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  bom_item  uuid;
  item_kind text;
begin
  if tg_op <> 'INSERT' then
    if coalesce(integr8_purging(old.tenant_id), false) then
      return coalesce(new, old);
    end if;
    raise exception 'A bill of materials does not change; save a new version'
      using errcode = 'check_violation', constraint = 'erp_boms_frozen';
  end if;
  select item_id into bom_item from erp_boms where tenant_id = new.tenant_id and id = new.bom_id;
  if bom_item = new.item_id then
    raise exception 'An item is not a component of itself'
      using errcode = 'check_violation', constraint = 'erp_bom_components_not_itself';
  end if;
  select kind into item_kind from erp_items where tenant_id = new.tenant_id and id = new.item_id;
  if item_kind not in ('stock_item', 'non_stock_item') then
    raise exception 'A component is a stock or non-stock item'
      using errcode = 'check_violation', constraint = 'erp_bom_components_item_kind';
  end if;
  return new;
end;
$$;
create trigger erp_bom_components_guard
  before insert or update or delete on erp_bom_components
  for each row execute function erp_bom_components_guard();

-- ---------------------------------------------------------------------------
-- Assembly and disassembly orders
-- ---------------------------------------------------------------------------

create table assembly_reference_counters (
  tenant_id       uuid    primary key references tenants (id) on delete restrict,
  last_reference  integer not null
);
comment on table assembly_reference_counters is
  'The last assembly order number handed out per company. Written only by assign_assembly_reference.';

create function assign_assembly_reference() returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' then
    if new.reference is distinct from old.reference then
      raise exception 'An assembly order keeps its number'
        using errcode = 'check_violation', constraint = 'erp_assembly_orders_reference_fixed';
    end if;
    return new;
  end if;
  insert into public.assembly_reference_counters as counter (tenant_id, last_reference)
  values (new.tenant_id, 1)
  on conflict (tenant_id) do update set last_reference = counter.last_reference + 1
  returning last_reference into new.reference;
  return new;
end;
$$;
comment on function assign_assembly_reference() is
  'Numbers an assembly order when it is drafted, and keeps the number. Security definer: the runtime role cannot write the counter.';

create table erp_mrp_plans (
  id           uuid        primary key default gen_random_uuid(),
  tenant_id    uuid        not null references tenants (id) on delete restrict,
  -- Demand and supply up to this day count.
  horizon_end  date        not null,
  run_by       uuid        not null,
  run_at       timestamptz not null default now(),
  constraint erp_mrp_plans_tenant_id_unique unique (tenant_id, id)
);
comment on table erp_mrp_plans is
  'A planning run (ADR-0011): a snapshot of what to build and buy, not a schedule.';

create table erp_assembly_orders (
  id             uuid           primary key default gen_random_uuid(),
  tenant_id      uuid           not null references tenants (id) on delete restrict,
  -- Per company, from 1, shown as AO-000123.
  reference      integer        not null default 0,
  direction      text           not null default 'assemble',
  item_id        uuid           not null,
  -- The bill version it builds from, or takes apart by.
  bom_id         uuid           not null,
  location_id    uuid           not null,
  quantity       numeric(20,4)  not null,
  status         text           not null default 'draft',
  -- When it should be done, if a plan said so.
  planned_for    date,
  plan_id        uuid,
  note           text,
  -- At completion: the cost of one unit of the item, and for an assembly the
  -- labour and overhead added per unit.
  unit_cost      numeric(20,4),
  labour_cost    numeric(20,4),
  overhead_cost  numeric(20,4),
  created_by     uuid           not null,
  created_at     timestamptz    not null default now(),
  completed_by   uuid,
  completed_at   timestamptz,
  cancelled_by   uuid,
  cancelled_at   timestamptz,
  version        integer        not null default 1,
  updated_at     timestamptz    not null default now(),
  constraint erp_assembly_orders_tenant_id_unique unique (tenant_id, id),
  constraint erp_assembly_orders_reference_unique unique (tenant_id, reference),
  constraint erp_assembly_orders_item_fk foreign key (tenant_id, item_id) references erp_items (tenant_id, id),
  constraint erp_assembly_orders_bom_fk foreign key (tenant_id, bom_id) references erp_boms (tenant_id, id),
  constraint erp_assembly_orders_location_fk
    foreign key (tenant_id, location_id) references erp_stock_locations (tenant_id, id),
  constraint erp_assembly_orders_plan_fk foreign key (tenant_id, plan_id) references erp_mrp_plans (tenant_id, id),
  constraint erp_assembly_orders_direction_known check (direction in ('assemble', 'disassemble')),
  constraint erp_assembly_orders_status_known check (status in ('draft', 'completed', 'cancelled')),
  constraint erp_assembly_orders_quantity_positive check (quantity > 0),
  constraint erp_assembly_orders_completion_pairing check (
    (status = 'completed') = (completed_at is not null)
    and (completed_at is null) = (completed_by is null)
    and (completed_at is null) = (unit_cost is null)
    and (status = 'completed' and direction = 'assemble') = (labour_cost is not null)
    and (labour_cost is null) = (overhead_cost is null)),
  constraint erp_assembly_orders_cancel_pairing check (
    (status = 'cancelled') = (cancelled_at is not null)
    and (cancelled_at is null) = (cancelled_by is null)),
  constraint erp_assembly_orders_costs_not_negative check (
    (unit_cost is null or unit_cost >= 0) and (labour_cost is null or labour_cost >= 0)
    and (overhead_cost is null or overhead_cost >= 0)),
  constraint erp_assembly_orders_note_length check (note is null or char_length(note) <= 1000),
  constraint erp_assembly_orders_version_positive check (version > 0)
);
create index erp_assembly_orders_open on erp_assembly_orders (tenant_id, status, created_at desc);
create index erp_assembly_orders_item on erp_assembly_orders (tenant_id, item_id);
create trigger erp_assembly_orders_number
  before insert or update on erp_assembly_orders
  for each row execute function assign_assembly_reference();
create trigger erp_assembly_orders_set_updated_at
  before update on erp_assembly_orders
  for each row execute function set_updated_at();

-- A draft's item, bill, location, quantity and note may change; it is then
-- completed or cancelled, once, and never changes again or goes away.
create function erp_assembly_orders_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
declare
  bom_item uuid;
begin
  if tg_op = 'DELETE' then
    if coalesce(integr8_purging(old.tenant_id), false) then
      return old;
    end if;
    raise exception 'An assembly order is never deleted; cancel it'
      using errcode = 'check_violation', constraint = 'erp_assembly_orders_frozen';
  end if;
  if tg_op = 'INSERT' and new.status <> 'draft' then
    raise exception 'An assembly order starts as a draft'
      using errcode = 'check_violation', constraint = 'erp_assembly_orders_frozen';
  end if;
  if tg_op = 'UPDATE' then
    if old.status <> 'draft' then
      raise exception 'A completed or cancelled assembly order does not change'
        using errcode = 'check_violation', constraint = 'erp_assembly_orders_frozen';
    end if;
    if (new.direction, new.created_by, new.created_at, new.plan_id)
       is distinct from (old.direction, old.created_by, old.created_at, old.plan_id) then
      raise exception 'An assembly order keeps its direction and origin'
        using errcode = 'check_violation', constraint = 'erp_assembly_orders_frozen';
    end if;
  end if;
  select item_id into bom_item from erp_boms where tenant_id = new.tenant_id and id = new.bom_id;
  if bom_item is distinct from new.item_id then
    raise exception 'An assembly order uses a bill of its own item'
      using errcode = 'check_violation', constraint = 'erp_assembly_orders_bom_item';
  end if;
  return new;
end;
$$;
create trigger erp_assembly_orders_guard
  before insert or update or delete on erp_assembly_orders
  for each row execute function erp_assembly_orders_guard();

-- ---------------------------------------------------------------------------
-- Planning
-- ---------------------------------------------------------------------------

create table erp_mrp_suggestions (
  id               uuid           primary key default gen_random_uuid(),
  tenant_id        uuid           not null references tenants (id) on delete restrict,
  plan_id          uuid           not null,
  item_id          uuid           not null,
  action           text           not null,
  -- 0 for what is sold, 1 for its parts, and so on.
  level            integer        not null,
  required         numeric(20,4)  not null,
  available        numeric(20,4)  not null,
  on_order         numeric(20,4)  not null,
  reorder_minimum  numeric(20,4)  not null,
  quantity         numeric(20,4)  not null,
  need_by          date           not null,
  order_by         date           not null,
  lead_time_days   integer        not null,
  supplier_id      uuid,
  bom_id           uuid,
  -- In words, what the suggestion is based on.
  basis            text           not null,
  -- The order drafted from it, if one was.
  drafted_kind     text,
  drafted_id       uuid,
  drafted_at       timestamptz,
  constraint erp_mrp_suggestions_tenant_id_unique unique (tenant_id, id),
  constraint erp_mrp_suggestions_plan_fk
    foreign key (tenant_id, plan_id) references erp_mrp_plans (tenant_id, id) on delete cascade,
  constraint erp_mrp_suggestions_item_fk foreign key (tenant_id, item_id) references erp_items (tenant_id, id),
  constraint erp_mrp_suggestions_supplier_fk
    foreign key (tenant_id, supplier_id) references erp_suppliers (tenant_id, id),
  constraint erp_mrp_suggestions_bom_fk foreign key (tenant_id, bom_id) references erp_boms (tenant_id, id),
  constraint erp_mrp_suggestions_action_known check (action in ('build', 'buy')),
  constraint erp_mrp_suggestions_build_has_bill check ((action = 'build') = (bom_id is not null)),
  constraint erp_mrp_suggestions_quantities check (
    required >= 0 and on_order >= 0 and reorder_minimum >= 0 and quantity > 0 and level >= 0),
  constraint erp_mrp_suggestions_dates check (order_by <= need_by),
  constraint erp_mrp_suggestions_basis_length check (char_length(basis) <= 2000),
  constraint erp_mrp_suggestions_drafted_known check (
    drafted_kind is null or drafted_kind in ('assembly_order', 'purchase_order')),
  constraint erp_mrp_suggestions_drafted_pairing check (
    (drafted_kind is null) = (drafted_id is null) and (drafted_id is null) = (drafted_at is null))
);
create index erp_mrp_suggestions_plan on erp_mrp_suggestions (tenant_id, plan_id, level, item_id);

-- A plan is a snapshot: only what was drafted from it is written later, once.
create function erp_mrp_suggestions_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'UPDATE' and (
       old.drafted_id is not null
       or (new.plan_id, new.item_id, new.action, new.level, new.required, new.available, new.on_order,
           new.reorder_minimum, new.quantity, new.need_by, new.order_by, new.lead_time_days,
           new.supplier_id, new.bom_id, new.basis)
          is distinct from
          (old.plan_id, old.item_id, old.action, old.level, old.required, old.available, old.on_order,
           old.reorder_minimum, old.quantity, old.need_by, old.order_by, old.lead_time_days,
           old.supplier_id, old.bom_id, old.basis)) then
    raise exception 'A plan is a snapshot; run planning again'
      using errcode = 'check_violation', constraint = 'erp_mrp_suggestions_frozen';
  end if;
  return new;
end;
$$;
create trigger erp_mrp_suggestions_guard
  before update on erp_mrp_suggestions
  for each row execute function erp_mrp_suggestions_guard();

-- ---------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------

create or replace function erp_stock_movements_ledger_capture() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  -- An assembly order's movements post as the order (ADR-0011).
  if new.kind in ('assembly_consumption', 'assembly_output') then
    perform erp_ledger_capture(
      new.tenant_id, 'assembly', new.posting_id,
      (new.occurred_at at time zone erp_ledger_timezone(new.tenant_id))::date,
      erp_ledger_currency(new.tenant_id), new.actor_id);
  elsif new.kind not in ('transfer_out', 'transfer_in') then
    perform erp_ledger_capture(
      new.tenant_id, 'stock', new.posting_id,
      (new.occurred_at at time zone erp_ledger_timezone(new.tenant_id))::date,
      erp_ledger_currency(new.tenant_id), new.actor_id);
  end if;
  return null;
end;
$$;
create or replace function erp_ledger_proposal_more(p_tenant uuid, p_kind text, p_source uuid)
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

  -- Salaries and employer insurance, and the claims paid back, against what
  -- is now owed to the authorities and to the staff.
  if p_kind = 'payroll_run' then
    return query
    with t as (
      select coalesce(sum(l.gross), 0) as gross, coalesce(sum(l.si_employer), 0) as employer,
             coalesce(sum(l.si_employee), 0) as employee, coalesce(sum(l.income_tax), 0) as tax,
             coalesce(sum(l.martyrs_fund), 0) as fund, coalesce(sum(l.reimbursements), 0) as claims,
             coalesce(sum(l.net), 0) as net
        from hr_payroll_lines l where l.tenant_id = p_tenant and l.run_id = p_source
    ), signed as (
      select 1 as ord, s.salaries_expense_account_id as account, t.gross as amount from t
      union all select 2, s.employer_insurance_expense_account_id, t.employer from t
      union all select 3, s.staff_claims_payable_account_id, t.claims from t
      union all select 4, s.social_insurance_payable_account_id, -(t.employee + t.employer) from t
      union all select 5, s.payroll_tax_payable_account_id, -t.tax from t
      union all select 6, s.martyrs_fund_payable_account_id, -t.fund from t
      union all select 7, s.salaries_payable_account_id, -t.net from t
    )
    select x.account, greatest(x.amount, 0), greatest(-x.amount, 0), null::uuid
      from signed x where x.amount <> 0
     order by x.ord;
    return;
  end if;

  -- An assembly's parts leave stock at their cost and the item comes in at
  -- that cost plus labour and overhead: inventory rises by those, absorbed.
  -- A disassembly moves value within inventory; any rounding is absorbed too.
  if p_kind = 'assembly' then
    return query
    with t as (
      select coalesce(sum(round(m.quantity * m.unit_cost, 4)), 0) as added
        from erp_stock_movements m
       where m.tenant_id = p_tenant and m.posting_id = p_source
         and m.kind in ('assembly_consumption', 'assembly_output')
    ), signed as (
      select 1 as ord, s.inventory_account_id as account, t.added as amount from t
      union all select 2, s.assembly_absorbed_account_id, -t.added from t
    )
    select x.account, greatest(x.amount, 0), greatest(-x.amount, 0), null::uuid
      from signed x where x.amount <> 0
     order by x.amount < 0, x.ord;
    return;
  end if;
end;
$$;

create or replace function erp_ledger_source_label_more(p_tenant uuid, p_kind text, p_source uuid) returns text
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select case p_kind
    when 'expense_claim' then (select 'EX-' || lpad(x.reference::text, 6, '0') from hr_expense_claims x
                                where x.tenant_id = p_tenant and x.id = p_source)
    when 'expense_payment' then (select 'EX-' || lpad(x.reference::text, 6, '0') || ' paid' from hr_expense_claims x
                                  where x.tenant_id = p_tenant and x.id = p_source)
    when 'payroll_run' then (select 'PR-' || to_char(r.period_start, 'YYYY-MM') from hr_payroll_runs r
                              where r.tenant_id = p_tenant and r.id = p_source)
    when 'assembly' then (select 'AO-' || lpad(o.reference::text, 6, '0') from erp_assembly_orders o
                           where o.tenant_id = p_tenant and o.id = p_source)
    else null
  end;
$$;

create or replace function erp_ledger_backfill_more(p_tenant uuid, p_start date, p_tz text) returns integer
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
    union all
    select 'payroll_run', r.id, r.period_end, r.currency
      from hr_payroll_runs r
     where r.tenant_id = p_tenant and r.status = 'approved' and r.period_end >= p_start
    union all
    select 'assembly', o.id, (o.completed_at at time zone p_tz)::date, erp_ledger_currency(p_tenant)
      from erp_assembly_orders o
     where o.tenant_id = p_tenant and o.status = 'completed'
       and (o.completed_at at time zone p_tz)::date >= p_start
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
     where m.tenant_id = p_tenant
       and m.kind not in ('transfer_out', 'transfer_in', 'assembly_consumption', 'assembly_output')
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


-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------

-- Versions are written and superseded, never changed or deleted; the guards
-- refuse the rest.
grant select, insert, update on erp_boms to integr8_app;
grant select, insert on erp_bom_components to integr8_app;
grant select on assembly_reference_counters to integr8_app;
grant select, insert, update on erp_assembly_orders to integr8_app;
grant select, insert on erp_mrp_plans to integr8_app;
grant select, insert, update on erp_mrp_suggestions to integr8_app;

alter table erp_boms enable row level security;
create policy erp_boms_isolation on erp_boms
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_bom_components enable row level security;
create policy erp_bom_components_isolation on erp_bom_components
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_assembly_orders enable row level security;
create policy erp_assembly_orders_isolation on erp_assembly_orders
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_mrp_plans enable row level security;
create policy erp_mrp_plans_isolation on erp_mrp_plans
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_mrp_suggestions enable row level security;
create policy erp_mrp_suggestions_isolation on erp_mrp_suggestions
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table assembly_reference_counters enable row level security;
create policy assembly_reference_counters_isolation on assembly_reference_counters
  for select to integr8_app
  using (tenant_id = app_current_tenant_id());
