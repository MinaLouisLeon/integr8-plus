-- Eighth round (ADR-0012), inventory and the field: site locations that
-- hold our stock or record the customer's, item images and datasheets,
-- supplier price lists with quantity breaks, deliveries by hand on sales
-- orders, van replenishment requests, and parts bought from a merchant for a
-- job.
--
-- Stock held as the customer's is a record: its movements never reach the
-- ledger, and moving our stock there issues it from ours. A delivery by hand
-- and stock left with a customer as theirs post their cost as "cost of parts
-- used", like parts used on a job, rather than as an adjustment.

-- ---------------------------------------------------------------------------
-- Site locations: whose stock
-- ---------------------------------------------------------------------------

alter table erp_stock_locations
  add column ownership text not null default 'ours',
  add constraint erp_stock_locations_ownership_known check (ownership in ('ours', 'customer')),
  add constraint erp_stock_locations_customer_is_site check (ownership = 'ours' or kind = 'site');
comment on column erp_stock_locations.ownership is
  'ours: counted and valued; customer: a record of what the customer holds at their site, never valued (ADR-0012).';

-- ---------------------------------------------------------------------------
-- Supplier price lists
-- ---------------------------------------------------------------------------

create table erp_supplier_prices (
  id            uuid           primary key default gen_random_uuid(),
  tenant_id     uuid           not null references tenants (id) on delete restrict,
  supplier_id   uuid           not null,
  item_id       uuid           not null,
  currency_code text           not null,
  -- The least quantity on one order line this price is for: a break.
  min_quantity  numeric(20,4)  not null default 1,
  unit_price    numeric(20,4)  not null,
  valid_from    date           not null,
  valid_to      date,
  created_by    uuid           not null,
  created_at    timestamptz    not null default now(),
  updated_at    timestamptz    not null default now(),
  constraint erp_supplier_prices_tenant_id_unique unique (tenant_id, id),
  constraint erp_supplier_prices_supplier_fk
    foreign key (tenant_id, supplier_id) references erp_suppliers (tenant_id, id) on delete restrict,
  constraint erp_supplier_prices_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint erp_supplier_prices_currency_format check (currency_code ~ '^[A-Z]{3}$'),
  constraint erp_supplier_prices_min_positive check (min_quantity > 0),
  constraint erp_supplier_prices_price_not_negative check (unit_price >= 0),
  constraint erp_supplier_prices_dates_ordered check (valid_to is null or valid_to >= valid_from)
);
create trigger erp_supplier_prices_set_updated_at
  before update on erp_supplier_prices
  for each row execute function set_updated_at();
create index erp_supplier_prices_item_idx on erp_supplier_prices (tenant_id, item_id, supplier_id);
create index erp_supplier_prices_supplier_idx on erp_supplier_prices (tenant_id, supplier_id);
comment on table erp_supplier_prices is
  'What a supplier charges for an item, in its currency, between two days, from a quantity on (ADR-0012).';

-- ---------------------------------------------------------------------------
-- Deliveries by hand on sales orders
-- ---------------------------------------------------------------------------

alter table sales_document_counters drop constraint sales_document_counters_kind_known;
alter table sales_document_counters add constraint sales_document_counters_kind_known
  check (kind in ('quote', 'sales_order', 'delivery'));

create table erp_sales_deliveries (
  id            uuid        primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete restrict,
  reference     integer     not null default 0,
  order_id      uuid        not null,
  location_id   uuid        not null,
  notes         text,
  delivered_by  uuid        not null,
  delivered_at  timestamptz not null default now(),
  constraint erp_sales_deliveries_tenant_id_unique unique (tenant_id, id),
  constraint erp_sales_deliveries_reference_unique unique (tenant_id, reference),
  constraint erp_sales_deliveries_order_fk
    foreign key (tenant_id, order_id) references erp_sales_orders (tenant_id, id) on delete restrict,
  constraint erp_sales_deliveries_location_fk
    foreign key (tenant_id, location_id) references erp_stock_locations (tenant_id, id) on delete restrict,
  constraint erp_sales_deliveries_notes_length check (notes is null or char_length(notes) <= 2000)
);
create index erp_sales_deliveries_order_idx on erp_sales_deliveries (tenant_id, order_id);
create trigger erp_sales_deliveries_assign_reference
  before insert on erp_sales_deliveries
  for each row execute function assign_sales_reference('delivery');
comment on table erp_sales_deliveries is
  'Goods handed over on a sales order from a location, by whoever manages orders (ADR-0012). Never changed.';

create table erp_sales_delivery_lines (
  id             uuid           primary key default gen_random_uuid(),
  tenant_id      uuid           not null references tenants (id) on delete restrict,
  delivery_id    uuid           not null,
  order_line_id  uuid           not null,
  quantity       numeric(20,4)  not null,
  -- What one cost when it left, for a stock item; null otherwise.
  unit_cost      numeric(20,4),
  constraint erp_sales_delivery_lines_tenant_id_unique unique (tenant_id, id),
  constraint erp_sales_delivery_lines_line_unique unique (tenant_id, delivery_id, order_line_id),
  constraint erp_sales_delivery_lines_delivery_fk
    foreign key (tenant_id, delivery_id) references erp_sales_deliveries (tenant_id, id) on delete restrict,
  constraint erp_sales_delivery_lines_order_line_fk
    foreign key (tenant_id, order_line_id) references erp_sales_order_lines (tenant_id, id) on delete restrict,
  constraint erp_sales_delivery_lines_quantity_positive check (quantity > 0)
);

-- ---------------------------------------------------------------------------
-- Van replenishment
-- ---------------------------------------------------------------------------

create table erp_van_requests (
  id                uuid        primary key default gen_random_uuid(),
  tenant_id         uuid        not null references tenants (id) on delete restrict,
  van_location_id   uuid        not null,
  status            text        not null default 'open',
  notes             text,
  requested_by      uuid        not null,
  from_location_id  uuid,
  picked_by         uuid,
  picked_at         timestamptz,
  cancelled_by      uuid,
  cancelled_at      timestamptz,
  version           integer     not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint erp_van_requests_tenant_id_unique unique (tenant_id, id),
  constraint erp_van_requests_van_fk
    foreign key (tenant_id, van_location_id) references erp_stock_locations (tenant_id, id) on delete restrict,
  constraint erp_van_requests_from_fk
    foreign key (tenant_id, from_location_id) references erp_stock_locations (tenant_id, id) on delete restrict,
  constraint erp_van_requests_status_known check (status in ('open', 'picked', 'cancelled')),
  constraint erp_van_requests_picked_pairing check (
    (status = 'picked') = (picked_at is not null and picked_by is not null and from_location_id is not null)),
  constraint erp_van_requests_cancelled_pairing check (
    (status = 'cancelled') = (cancelled_at is not null and cancelled_by is not null)),
  constraint erp_van_requests_notes_length check (notes is null or char_length(notes) <= 1000),
  constraint erp_van_requests_version_positive check (version > 0)
);
create trigger erp_van_requests_set_updated_at
  before update on erp_van_requests
  for each row execute function set_updated_at();
create index erp_van_requests_open_idx on erp_van_requests (tenant_id, created_at) where status = 'open';
create index erp_van_requests_van_idx on erp_van_requests (tenant_id, van_location_id, created_at desc);
comment on table erp_van_requests is
  'An engineer asking for stock for their van; a store person picks it from a warehouse, which transfers it (ADR-0012). Online only.';

create table erp_van_request_lines (
  tenant_id           uuid           not null references tenants (id) on delete restrict,
  request_id          uuid           not null,
  item_id             uuid           not null,
  quantity_requested  numeric(20,4)  not null,
  -- What was sent, once picked: possibly less, possibly none.
  quantity_picked     numeric(20,4),
  constraint erp_van_request_lines_pkey primary key (tenant_id, request_id, item_id),
  constraint erp_van_request_lines_request_fk
    foreign key (tenant_id, request_id) references erp_van_requests (tenant_id, id) on delete restrict,
  constraint erp_van_request_lines_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint erp_van_request_lines_requested_positive check (quantity_requested > 0),
  constraint erp_van_request_lines_picked_sane check (
    quantity_picked is null or (quantity_picked >= 0 and quantity_picked <= quantity_requested))
);

-- ---------------------------------------------------------------------------
-- Parts bought from a merchant for a job
-- ---------------------------------------------------------------------------

create table erp_work_order_purchases (
  -- Chosen by the phone that recorded it, so a resend lands once.
  id             uuid           primary key,
  tenant_id      uuid           not null references tenants (id) on delete restrict,
  work_order_id  uuid           not null,
  -- A non-stock item or service from the catalogue, when it is one; never stock.
  item_id        uuid,
  description    text           not null,
  merchant       text,
  quantity       numeric(20,4)  not null,
  -- What one cost, paid, in the company currency.
  unit_price     numeric(20,4)  not null,
  note           text,
  recorded_by    uuid           not null,
  occurred_at    timestamptz    not null default now(),
  recorded_at    timestamptz    not null default now(),
  cancelled_by   uuid,
  cancelled_at   timestamptz,
  constraint erp_work_order_purchases_tenant_id_unique unique (tenant_id, id),
  constraint erp_work_order_purchases_work_order_fk
    foreign key (tenant_id, work_order_id) references work_orders (tenant_id, id) on delete restrict,
  constraint erp_work_order_purchases_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id) on delete restrict,
  constraint erp_work_order_purchases_description_present
    check (btrim(description) <> '' and char_length(description) <= 300),
  constraint erp_work_order_purchases_merchant_length check (merchant is null or char_length(merchant) <= 200),
  constraint erp_work_order_purchases_note_length check (note is null or char_length(note) <= 1000),
  constraint erp_work_order_purchases_quantity_positive check (quantity > 0),
  constraint erp_work_order_purchases_price_not_negative check (unit_price >= 0),
  constraint erp_work_order_purchases_cancelled_pairing check ((cancelled_at is null) = (cancelled_by is null))
);
create index erp_work_order_purchases_job_idx on erp_work_order_purchases (tenant_id, work_order_id);
comment on table erp_work_order_purchases is
  'Parts bought from a merchant for a job, with the price paid (ADR-0012). On the job and its cost; never in stock.';

-- Never stock: a stock item comes from a location as a part used.
create function erp_work_order_purchases_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if new.item_id is not null and exists (
    select 1 from erp_items i where i.tenant_id = new.tenant_id and i.id = new.item_id and i.kind = 'stock_item'
  ) then
    raise exception 'A part bought for a job is not a stock item'
      using errcode = 'check_violation', constraint = 'erp_work_order_purchases_not_stock';
  end if;
  return new;
end;
$$;
create trigger erp_work_order_purchases_guard
  before insert or update on erp_work_order_purchases
  for each row execute function erp_work_order_purchases_guard();

-- ---------------------------------------------------------------------------
-- Attachments: item images and datasheets, merchant receipts
-- ---------------------------------------------------------------------------

alter table attachments
  add column item_id uuid,
  add column work_order_purchase_id uuid,
  -- The item's main image: the one the phone keeps.
  add column is_main boolean not null default false,
  add constraint attachments_item_fk
    foreign key (tenant_id, item_id) references erp_items (tenant_id, id),
  add constraint attachments_work_order_purchase_fk
    foreign key (tenant_id, work_order_purchase_id) references erp_work_order_purchases (tenant_id, id),
  drop constraint attachments_one_owner,
  add constraint attachments_one_owner check (num_nonnulls(
    customer_id, site_id, work_order_id, asset_id, expense_claim_id, item_id, work_order_purchase_id) = 1),
  add constraint attachments_main_is_item check (not is_main or item_id is not null);
create index attachments_item_idx on attachments (tenant_id, item_id) where item_id is not null;
create index attachments_work_order_purchase_idx on attachments (tenant_id, work_order_purchase_id)
  where work_order_purchase_id is not null;
create unique index attachments_item_main_unique on attachments (tenant_id, item_id)
  where is_main and removed_at is null;

-- ---------------------------------------------------------------------------
-- The ledger
-- ---------------------------------------------------------------------------

create or replace function erp_stock_movements_ledger_capture() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  -- Stock held as the customer's never reaches the ledger (ADR-0012).
  if exists (select 1 from erp_stock_locations l
              where l.tenant_id = new.tenant_id and l.id = new.location_id and l.ownership = 'customer') then
    return null;
  end if;
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
         -- Stock held as the customer's is a record, never valued (0040).
         and not exists (select 1 from erp_stock_locations l
                          where l.tenant_id = m.tenant_id and l.id = m.location_id
                            and l.ownership = 'customer')
    ), signed as (
      select s.inventory_account_id as account, v.value as amount from valued v
      union all
      select case
               when v.kind = 'receipt' and v.source_key like 'receipt-line:%' then s.goods_received_account_id
               -- Handed to the customer: delivered on a sales order, or left
               -- at their site as theirs (0040).
               when v.kind = 'issue' and (v.source_key like 'delivery-line:%'
                                          or v.source_key like 'customer-site:%') then s.parts_cost_account_id
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


-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on erp_supplier_prices to integr8_app;
grant select, insert on erp_sales_deliveries to integr8_app;
grant select, insert on erp_sales_delivery_lines to integr8_app;
grant select, insert, update on erp_van_requests to integr8_app;
grant select, insert, update on erp_van_request_lines to integr8_app;
grant select, insert, update on erp_work_order_purchases to integr8_app;

alter table erp_supplier_prices enable row level security;
create policy erp_supplier_prices_isolation on erp_supplier_prices
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_sales_deliveries enable row level security;
create policy erp_sales_deliveries_isolation on erp_sales_deliveries
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_sales_delivery_lines enable row level security;
create policy erp_sales_delivery_lines_isolation on erp_sales_delivery_lines
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_van_requests enable row level security;
create policy erp_van_requests_isolation on erp_van_requests
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_van_request_lines enable row level security;
create policy erp_van_request_lines_isolation on erp_van_request_lines
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());

alter table erp_work_order_purchases enable row level security;
create policy erp_work_order_purchases_isolation on erp_work_order_purchases
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
