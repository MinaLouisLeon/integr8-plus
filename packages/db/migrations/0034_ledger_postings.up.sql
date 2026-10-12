-- CRM/ERP plan, phase A1 (ADR-0009), second part: automatic postings and the
-- unposted list.
--
-- Every document that carries money into the ledger — an issued invoice, an
-- issued credit note, a voided invoice, a recorded payment, and a stock
-- posting other than a transfer — is captured by the database itself into
-- `erp_ledger_postings`, so no code path can skip one. Captured documents are
-- posted at once, in the same transaction, when the company's switch for
-- their kind is on and nothing stands in the way; otherwise they wait in the
-- unposted list with the reason (switched off, another currency, a stock cost
-- unknown, a locked month, the invoice they depend on not posted yet).
--
-- A posting failure never blocks the document: the attempt runs in its own
-- subtransaction and, if it fails, the document waits with the error.
--
-- `erp_ledger_proposal()` is the one definition of what each document posts;
-- the unposted list shows it and the API posts it, with any changes the
-- accountant makes.

-- ---------------------------------------------------------------------------
-- The queue
-- ---------------------------------------------------------------------------

create table erp_ledger_postings (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants (id) on delete restrict,
  source_kind    text        not null,
  -- The invoice, credit note or payment; for stock, the movements' posting id.
  source_id      uuid        not null,
  -- In the company's calendar: when the journal is dated unless changed.
  document_date  date        not null,
  currency       text        not null,
  status         text        not null default 'pending',
  -- Why it waits.
  reason         text,
  -- The error, when an automatic attempt failed.
  detail         text,
  journal_id     uuid,
  -- Who posted or set it aside; null when the system set aside an empty one.
  resolved_by    uuid,
  resolved_at    timestamptz,
  skip_reason    text,
  captured_at    timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint erp_ledger_postings_tenant_id_unique unique (tenant_id, id),
  constraint erp_ledger_postings_source_unique unique (tenant_id, source_kind, source_id),
  constraint erp_ledger_postings_journal_fk
    foreign key (tenant_id, journal_id) references erp_journals (tenant_id, id),
  constraint erp_ledger_postings_source_kind_known check (
    source_kind in ('invoice', 'credit_note', 'invoice_void', 'payment', 'stock')),
  constraint erp_ledger_postings_status_known check (status in ('pending', 'posted', 'skipped')),
  constraint erp_ledger_postings_reason_known check (
    reason is null or reason in (
      'queued', 'auto_off', 'before_set_up', 'foreign_currency', 'cost_unknown',
      'period_locked', 'waits_for_invoice', 'failed')),
  constraint erp_ledger_postings_currency_shape check (currency ~ '^[A-Z]{3}$'),
  constraint erp_ledger_postings_status_shape check (
    (status = 'pending') = (reason is not null)
    and (status = 'pending') = (resolved_at is null)
    and (status = 'posted') = (journal_id is not null)
    and (status = 'skipped') = (skip_reason is not null)
    and (detail is null or reason = 'failed')),
  constraint erp_ledger_postings_text_lengths check (
    (detail is null or char_length(detail) <= 1000)
    and (skip_reason is null or (btrim(skip_reason) <> '' and char_length(skip_reason) <= 1000)))
);
comment on table erp_ledger_postings is
  'Documents the ledger posts, captured by the database. Pending ones are the unposted list; posted and set-aside ones never change.';

create index erp_ledger_postings_pending on erp_ledger_postings (tenant_id, document_date)
  where status = 'pending';

create trigger erp_ledger_postings_set_updated_at
  before update on erp_ledger_postings
  for each row execute function set_updated_at();

-- Posted and set aside are final.
create function erp_ledger_postings_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    if integr8_purging(old.tenant_id) or old.status = 'pending' and current_user <> 'integr8_app' then
      return old;
    end if;
    raise exception 'A captured document is never deleted'
      using errcode = 'check_violation', constraint = 'erp_ledger_postings_final';
  end if;
  if old.status <> 'pending' then
    raise exception 'A posted or set-aside document does not change'
      using errcode = 'check_violation', constraint = 'erp_ledger_postings_final';
  end if;
  if new.source_kind <> old.source_kind or new.source_id <> old.source_id
     or new.tenant_id <> old.tenant_id or new.currency <> old.currency then
    raise exception 'A captured document stays the document it is'
      using errcode = 'check_violation', constraint = 'erp_ledger_postings_final';
  end if;
  return new;
end;
$$;
create trigger erp_ledger_postings_guard
  before update or delete on erp_ledger_postings
  for each row execute function erp_ledger_postings_guard();

-- ---------------------------------------------------------------------------
-- The company's calendar and currency
-- ---------------------------------------------------------------------------

create function erp_ledger_timezone(p_tenant uuid) returns text
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select coalesce((select s.timezone from tenant_settings s where s.tenant_id = p_tenant), 'UTC');
$$;

create function erp_ledger_currency(p_tenant uuid) returns text
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select coalesce((select s.currency from tenant_settings s where s.tenant_id = p_tenant), 'EGP');
$$;

-- ---------------------------------------------------------------------------
-- What each document posts
-- ---------------------------------------------------------------------------

-- The journal a document would post, as lines in the document's currency:
-- an account, a debit or a credit, and the customer of a receivables line.
-- Debits equal credits by construction: tax is the total less the nets, and
-- stock's counter-entries are the inventory movement's own values.
create function erp_ledger_proposal(p_tenant uuid, p_kind text, p_source uuid)
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
end;
$$;
comment on function erp_ledger_proposal(uuid, text, uuid) is
  'The journal lines a document posts, in its own currency. The one definition the automatic posting, the unposted list and the API share.';

-- The invoice a credit note or a void depends on.
create function erp_ledger_parent_invoice(p_tenant uuid, p_kind text, p_source uuid) returns uuid
  language sql
  stable
  set search_path = pg_catalog, public
as $$
  select case p_kind
    when 'invoice_void' then p_source
    when 'credit_note' then (select c.invoice_id from erp_credit_notes c
                              where c.tenant_id = p_tenant and c.id = p_source)
  end;
$$;

-- A reference people recognise, kept as the journal's memo.
create function erp_ledger_source_label(p_tenant uuid, p_kind text, p_source uuid) returns text
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
    else null
  end;
$$;

-- ---------------------------------------------------------------------------
-- Posting
-- ---------------------------------------------------------------------------

-- Posts a pending document as its proposal says, or records why it waits.
-- `p_force` posts it whatever the company's switch says (the accountant's
-- "post these"); every other condition still applies.
create function erp_ledger_try_post(p_posting uuid, p_actor uuid, p_force boolean default false)
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
    when not p_force and p.source_kind = 'stock' and not s.auto_post_stock then 'auto_off'
    when not p_force and p.source_kind <> 'stock' and not s.auto_post_sales then 'auto_off'
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
comment on function erp_ledger_try_post(uuid, uuid, boolean) is
  'Posts a captured document from its proposal, or records why it waits. Security definer: the runtime role cannot write the queue''s outcome itself.';

-- Records a document for the ledger and tries to post it. Nothing happens for
-- a company without a ledger, or for a document dated before its start.
create function erp_ledger_capture(
  p_tenant uuid, p_kind text, p_source uuid, p_date date, p_currency text, p_actor uuid)
  returns void
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
declare
  start   date;
  posting uuid;
begin
  select s.start_date into start from erp_ledger_settings s where s.tenant_id = p_tenant;
  if start is null or p_date < start then
    return;
  end if;
  insert into erp_ledger_postings (tenant_id, source_kind, source_id, document_date, currency, reason)
  values (p_tenant, p_kind, p_source, p_date, p_currency, 'queued')
  on conflict (tenant_id, source_kind, source_id) do nothing
  returning id into posting;
  if posting is not null then
    perform erp_ledger_try_post(posting, p_actor, false);
  end if;
end;
$$;
comment on function erp_ledger_capture(uuid, text, uuid, date, text, uuid) is
  'Queues a document for the ledger and posts it when it can. Security definer: the runtime role cannot insert into the queue.';

-- After the ledger is set up or its start moves: documents already recorded
-- on or after the start join the unposted list for review; pending ones now
-- before the start leave it.
create function erp_ledger_backfill(p_tenant uuid) returns integer
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
  return added;
end;
$$;
comment on function erp_ledger_backfill(uuid) is
  'Queues documents recorded on or after the ledger''s start for review, and drops pending ones before it. Security definer: the runtime role cannot write the queue.';

-- ---------------------------------------------------------------------------
-- Capture
-- ---------------------------------------------------------------------------

create function erp_invoices_ledger_capture() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if old.status = 'draft' and new.status = 'issued' then
    perform erp_ledger_capture(new.tenant_id, 'invoice', new.id, new.issue_date, new.currency_code, new.issued_by);
  elsif old.status = 'issued' and new.status = 'void' then
    perform erp_ledger_capture(
      new.tenant_id, 'invoice_void', new.id,
      (new.voided_at at time zone erp_ledger_timezone(new.tenant_id))::date,
      new.currency_code, new.voided_by);
  end if;
  return null;
end;
$$;
create trigger erp_invoices_ledger_capture
  after update of status on erp_invoices
  for each row execute function erp_invoices_ledger_capture();

create function erp_credit_notes_ledger_capture() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if old.status = 'draft' and new.status = 'issued' then
    perform erp_ledger_capture(
      new.tenant_id, 'credit_note', new.id, new.issue_date,
      (select i.currency_code from erp_invoices i where i.tenant_id = new.tenant_id and i.id = new.invoice_id),
      new.issued_by);
  end if;
  return null;
end;
$$;
create trigger erp_credit_notes_ledger_capture
  after update of status on erp_credit_notes
  for each row execute function erp_credit_notes_ledger_capture();

create function erp_payment_receipts_ledger_capture() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  perform erp_ledger_capture(
    new.tenant_id, 'payment', new.id, new.received_on, new.currency_code, new.recorded_by);
  return null;
end;
$$;
create trigger erp_payment_receipts_ledger_capture
  after insert on erp_payment_receipts
  for each row execute function erp_payment_receipts_ledger_capture();

-- At commit, when every movement of the posting is written.
create function erp_stock_movements_ledger_capture() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if new.kind not in ('transfer_out', 'transfer_in') then
    perform erp_ledger_capture(
      new.tenant_id, 'stock', new.posting_id,
      (new.occurred_at at time zone erp_ledger_timezone(new.tenant_id))::date,
      erp_ledger_currency(new.tenant_id), new.actor_id);
  end if;
  return null;
end;
$$;
create constraint trigger erp_stock_movements_ledger_capture
  after insert on erp_stock_movements
  deferrable initially deferred
  for each row execute function erp_stock_movements_ledger_capture();

-- ---------------------------------------------------------------------------
-- Grants and isolation
-- ---------------------------------------------------------------------------

-- Written by the functions above; the runtime role reads it and resolves
-- pending entries (posts with changes, or sets aside), which the guard keeps final.
grant select, update on erp_ledger_postings to integr8_app;

alter table erp_ledger_postings enable row level security;
create policy erp_ledger_postings_isolation on erp_ledger_postings
  for all to integr8_app
  using (tenant_id = app_current_tenant_id())
  with check (tenant_id = app_current_tenant_id());
