-- Chart of accounts, journals, periods, year-end closes and postings.
--
-- Part of the 2.0.0 baseline (P41), generated from the schema that migrations
-- 0001-0079 of release 1.4.0 built; their history and reasoning are in git
-- before 2.0.0. Comments on tables and columns below carry the why.

-- SQL functions may name tables a later module creates; Postgres checks
-- their bodies when they are first called rather than here.
set local check_function_bodies = false;

-- ---------------------------------------------------------------------------
-- Functions
-- ---------------------------------------------------------------------------

CREATE FUNCTION public.assign_journal_reference() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

CREATE FUNCTION public.erp_journal_lines_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

CREATE FUNCTION public.erp_journals_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  settings     erp_ledger_settings%rowtype;
  total_debit  numeric;
  total_credit numeric;
  line_count   integer;
  reversed     erp_journals%rowtype;
  closing      boolean;
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
  -- A year's closing journal, and the reversal that reopens the year, are
  -- dated on its last day and may go into a locked month: closing a year
  -- comes after its months are locked. Nothing else does.
  if new.kind = 'reversal' then
    select * into reversed from erp_journals where tenant_id = new.tenant_id and id = new.reversal_of;
  end if;
  closing := new.kind = 'closing' or (new.kind = 'reversal' and reversed.kind = 'closing');
  if closing then
    if extract(month from new.entry_date + 1)::integer <> settings.fiscal_start_month
       or extract(day from new.entry_date + 1)::integer <> 1 then
      raise exception 'A closing journal is dated on the last day of a fiscal year'
        using errcode = 'check_violation', constraint = 'erp_journals_closing_date';
    end if;
    if exists (select 1 from erp_journal_lines l
                 join erp_ledger_accounts a on a.tenant_id = l.tenant_id and a.id = l.account_id
                where l.tenant_id = new.tenant_id and l.journal_id = new.id
                  and a.type not in ('income', 'expense')
                  and a.id <> settings.retained_earnings_account_id) then
      raise exception 'A closing journal moves income and expenses to retained earnings, nothing else'
        using errcode = 'check_violation', constraint = 'erp_journals_closing_accounts';
    end if;
  elsif erp_ledger_period_locked(new.tenant_id, new.entry_date) then
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
    if reversed.status is distinct from 'posted' then
      raise exception 'Only a posted journal is reversed'
        using errcode = 'check_violation', constraint = 'erp_journals_reversal_not_posted';
    end if;
  end if;

  return new;
end;
$$;

CREATE FUNCTION public.erp_ledger_accounts_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

SET default_tablespace = '';

SET default_table_access_method = heap;

CREATE FUNCTION public.erp_ledger_period_locked(p_tenant uuid, p_date date) RETURNS boolean
    LANGUAGE sql STABLE
    SET search_path TO 'pg_catalog', 'public'
    AS $$
  select coalesce(
    (select p.locked from erp_ledger_periods p
      where p.tenant_id = p_tenant and p.period_start = date_trunc('month', p_date)::date),
    false);
$$;

CREATE FUNCTION public.erp_ledger_postings_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

CREATE FUNCTION public.erp_ledger_settings_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if (new.start_date <> old.start_date or new.fiscal_start_month <> old.fiscal_start_month)
     and exists (select 1 from erp_journals j where j.tenant_id = old.tenant_id and j.status = 'posted') then
    raise exception 'The start date and fiscal year are fixed once a journal is posted'
      using errcode = 'check_violation', constraint = 'erp_ledger_settings_fixed';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE erp_ledger_settings (
    tenant_id uuid NOT NULL,
    start_date date NOT NULL,
    fiscal_start_month smallint DEFAULT 1 NOT NULL,
    auto_post_sales boolean DEFAULT true NOT NULL,
    auto_post_stock boolean DEFAULT true NOT NULL,
    allow_self_approval boolean DEFAULT false NOT NULL,
    receivables_account_id uuid NOT NULL,
    revenue_services_account_id uuid NOT NULL,
    revenue_goods_account_id uuid NOT NULL,
    vat_output_account_id uuid NOT NULL,
    cash_account_id uuid NOT NULL,
    bank_account_id uuid NOT NULL,
    other_receipts_account_id uuid NOT NULL,
    inventory_account_id uuid NOT NULL,
    goods_received_account_id uuid NOT NULL,
    parts_cost_account_id uuid NOT NULL,
    stock_adjustments_account_id uuid NOT NULL,
    opening_balances_account_id uuid NOT NULL,
    retained_earnings_account_id uuid NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auto_post_expenses boolean DEFAULT true NOT NULL,
    auto_post_payroll boolean DEFAULT true NOT NULL,
    staff_claims_payable_account_id uuid NOT NULL,
    staff_expenses_account_id uuid NOT NULL,
    salaries_expense_account_id uuid NOT NULL,
    employer_insurance_expense_account_id uuid NOT NULL,
    salaries_payable_account_id uuid NOT NULL,
    payroll_tax_payable_account_id uuid NOT NULL,
    social_insurance_payable_account_id uuid NOT NULL,
    martyrs_fund_payable_account_id uuid NOT NULL,
    assembly_absorbed_account_id uuid NOT NULL,
    CONSTRAINT erp_ledger_settings_fiscal_month_range CHECK (((fiscal_start_month >= 1) AND (fiscal_start_month <= 12))),
    CONSTRAINT erp_ledger_settings_start_first_of_month CHECK ((EXTRACT(day FROM start_date) = (1)::numeric)),
    CONSTRAINT erp_ledger_settings_version_positive CHECK ((version > 0))
);

CREATE TABLE erp_journal_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    journal_id uuid NOT NULL,
    entry_date date NOT NULL,
    line_no integer NOT NULL,
    account_id uuid NOT NULL,
    debit numeric(20,4) DEFAULT 0 NOT NULL,
    credit numeric(20,4) DEFAULT 0 NOT NULL,
    memo text,
    customer_id uuid,
    foreign_amount numeric(20,4),
    CONSTRAINT erp_journal_lines_foreign_not_negative CHECK (((foreign_amount IS NULL) OR (foreign_amount >= (0)::numeric))),
    CONSTRAINT erp_journal_lines_line_no_positive CHECK ((line_no > 0)),
    CONSTRAINT erp_journal_lines_memo_length CHECK (((memo IS NULL) OR (char_length(memo) <= 500))),
    CONSTRAINT erp_journal_lines_one_side CHECK (((debit >= (0)::numeric) AND (credit >= (0)::numeric) AND ((debit > (0)::numeric) <> (credit > (0)::numeric))))
)
PARTITION BY RANGE (entry_date);

CREATE TABLE erp_journals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reference integer,
    status text DEFAULT 'draft'::text NOT NULL,
    kind text NOT NULL,
    entry_date date NOT NULL,
    memo text,
    source_kind text,
    source_id uuid,
    reversal_of uuid,
    foreign_currency text,
    exchange_rate numeric(20,10),
    rate_source text,
    drafted_by uuid NOT NULL,
    drafted_at timestamp with time zone DEFAULT now() NOT NULL,
    posted_by uuid,
    posted_at timestamp with time zone,
    self_approved boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_journals_foreign_pairing CHECK ((((foreign_currency IS NULL) = (exchange_rate IS NULL)) AND ((exchange_rate IS NULL) = (rate_source IS NULL)))),
    CONSTRAINT erp_journals_foreign_shape CHECK ((((foreign_currency IS NULL) OR (foreign_currency ~ '^[A-Z]{3}$'::text)) AND ((exchange_rate IS NULL) OR (exchange_rate > (0)::numeric)) AND ((rate_source IS NULL) OR ((btrim(rate_source) <> ''::text) AND (char_length(rate_source) <= 200))))),
    CONSTRAINT erp_journals_kind_known CHECK ((kind = ANY (ARRAY['manual'::text, 'opening'::text, 'automatic'::text, 'reversal'::text, 'closing'::text]))),
    CONSTRAINT erp_journals_memo_length CHECK (((memo IS NULL) OR (char_length(memo) <= 2000))),
    CONSTRAINT erp_journals_posted_pairing CHECK ((((status = 'posted'::text) = (posted_by IS NOT NULL)) AND ((posted_by IS NULL) = (posted_at IS NULL)) AND ((posted_at IS NULL) = (reference IS NULL)))),
    CONSTRAINT erp_journals_reversal_pairing CHECK (((kind = 'reversal'::text) = (reversal_of IS NOT NULL))),
    CONSTRAINT erp_journals_source_kind_known CHECK (((source_kind IS NULL) OR (source_kind = ANY (ARRAY['invoice'::text, 'credit_note'::text, 'invoice_void'::text, 'payment'::text, 'stock'::text, 'expense_claim'::text, 'expense_payment'::text, 'payroll_run'::text, 'assembly'::text, 'payment_reversal'::text])))),
    CONSTRAINT erp_journals_source_pairing CHECK ((((kind = 'automatic'::text) = (source_kind IS NOT NULL)) AND ((source_kind IS NULL) = (source_id IS NULL)))),
    CONSTRAINT erp_journals_status_known CHECK ((status = ANY (ARRAY['draft'::text, 'posted'::text])))
);

CREATE TABLE erp_ledger_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    code text NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    archived_at timestamp with time zone,
    archived_by uuid,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_ledger_accounts_archived_pairing CHECK (((archived_at IS NULL) = (archived_by IS NULL))),
    CONSTRAINT erp_ledger_accounts_code_shape CHECK ((code ~ '^[0-9A-Za-z][0-9A-Za-z.-]{0,19}$'::text)),
    CONSTRAINT erp_ledger_accounts_name_present CHECK (((btrim(name) <> ''::text) AND (char_length(name) <= 200))),
    CONSTRAINT erp_ledger_accounts_type_known CHECK ((type = ANY (ARRAY['asset'::text, 'liability'::text, 'equity'::text, 'income'::text, 'expense'::text]))),
    CONSTRAINT erp_ledger_accounts_version_positive CHECK ((version > 0))
);

CREATE TABLE erp_ledger_period_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    period_start date NOT NULL,
    kind text NOT NULL,
    reason text,
    actor_id uuid NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_ledger_period_events_kind_known CHECK ((kind = ANY (ARRAY['locked'::text, 'unlocked'::text]))),
    CONSTRAINT erp_ledger_period_events_reason_shape CHECK ((((kind = 'unlocked'::text) <= ((reason IS NOT NULL) AND (btrim(reason) <> ''::text))) AND ((reason IS NULL) OR (char_length(reason) <= 1000))))
);

CREATE TABLE erp_ledger_periods (
    tenant_id uuid NOT NULL,
    period_start date NOT NULL,
    locked boolean NOT NULL,
    changed_by uuid NOT NULL,
    changed_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_ledger_periods_first_of_month CHECK ((EXTRACT(day FROM period_start) = (1)::numeric))
);

CREATE TABLE erp_ledger_postings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    source_kind text NOT NULL,
    source_id uuid NOT NULL,
    document_date date NOT NULL,
    currency text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    reason text,
    detail text,
    journal_id uuid,
    resolved_by uuid,
    resolved_at timestamp with time zone,
    skip_reason text,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT erp_ledger_postings_currency_shape CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT erp_ledger_postings_reason_known CHECK (((reason IS NULL) OR (reason = ANY (ARRAY['queued'::text, 'auto_off'::text, 'before_set_up'::text, 'foreign_currency'::text, 'cost_unknown'::text, 'period_locked'::text, 'waits_for_invoice'::text, 'failed'::text])))),
    CONSTRAINT erp_ledger_postings_source_kind_known CHECK ((source_kind = ANY (ARRAY['invoice'::text, 'credit_note'::text, 'invoice_void'::text, 'payment'::text, 'stock'::text, 'expense_claim'::text, 'expense_payment'::text, 'payroll_run'::text, 'assembly'::text, 'payment_reversal'::text]))),
    CONSTRAINT erp_ledger_postings_status_known CHECK ((status = ANY (ARRAY['pending'::text, 'posted'::text, 'skipped'::text]))),
    CONSTRAINT erp_ledger_postings_status_shape CHECK ((((status = 'pending'::text) = (reason IS NOT NULL)) AND ((status = 'pending'::text) = (resolved_at IS NULL)) AND ((status = 'posted'::text) = (journal_id IS NOT NULL)) AND ((status = 'skipped'::text) = (skip_reason IS NOT NULL)) AND ((detail IS NULL) OR (reason = 'failed'::text)))),
    CONSTRAINT erp_ledger_postings_text_lengths CHECK ((((detail IS NULL) OR (char_length(detail) <= 1000)) AND ((skip_reason IS NULL) OR ((btrim(skip_reason) <> ''::text) AND (char_length(skip_reason) <= 1000)))))
);

CREATE TABLE erp_ledger_year_closes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    year_start date NOT NULL,
    closing_journal_id uuid NOT NULL,
    closed_by uuid NOT NULL,
    closed_at timestamp with time zone DEFAULT now() NOT NULL,
    reopened_by uuid,
    reopened_at timestamp with time zone,
    reopen_reason text,
    reopening_journal_id uuid,
    CONSTRAINT erp_ledger_year_closes_first_of_month CHECK ((EXTRACT(day FROM year_start) = (1)::numeric)),
    CONSTRAINT erp_ledger_year_closes_reason_length CHECK (((reopen_reason IS NULL) OR ((btrim(reopen_reason) <> ''::text) AND (char_length(reopen_reason) <= 1000)))),
    CONSTRAINT erp_ledger_year_closes_reopen_pairing CHECK ((((reopened_at IS NULL) = (reopened_by IS NULL)) AND ((reopened_by IS NULL) = (reopen_reason IS NULL)) AND ((reopen_reason IS NULL) = (reopening_journal_id IS NULL))))
);

CREATE TABLE journal_reference_counters (
    tenant_id uuid NOT NULL,
    last_reference integer NOT NULL
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE erp_journal_lines
    ADD CONSTRAINT erp_journal_lines_line_unique UNIQUE (tenant_id, journal_id, line_no, entry_date);

ALTER TABLE erp_journal_lines
    ADD CONSTRAINT erp_journal_lines_pkey PRIMARY KEY (tenant_id, id, entry_date);

ALTER TABLE ONLY erp_journals
    ADD CONSTRAINT erp_journals_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_journals
    ADD CONSTRAINT erp_journals_reference_unique UNIQUE (tenant_id, reference);

ALTER TABLE ONLY erp_journals
    ADD CONSTRAINT erp_journals_tenant_id_unique UNIQUE (tenant_id, id);

-- Lines carry their journal's date, which places them in a year partition;
-- this key lets their foreign key follow a draft that is re-dated.
ALTER TABLE ONLY erp_journals
    ADD CONSTRAINT erp_journals_dated_unique UNIQUE (tenant_id, id, entry_date);

ALTER TABLE ONLY erp_ledger_accounts
    ADD CONSTRAINT erp_ledger_accounts_code_unique UNIQUE (tenant_id, code);

ALTER TABLE ONLY erp_ledger_accounts
    ADD CONSTRAINT erp_ledger_accounts_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_ledger_accounts
    ADD CONSTRAINT erp_ledger_accounts_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_ledger_period_events
    ADD CONSTRAINT erp_ledger_period_events_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_ledger_periods
    ADD CONSTRAINT erp_ledger_periods_pkey PRIMARY KEY (tenant_id, period_start);

ALTER TABLE ONLY erp_ledger_postings
    ADD CONSTRAINT erp_ledger_postings_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_ledger_postings
    ADD CONSTRAINT erp_ledger_postings_source_unique UNIQUE (tenant_id, source_kind, source_id);

ALTER TABLE ONLY erp_ledger_postings
    ADD CONSTRAINT erp_ledger_postings_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY erp_ledger_year_closes
    ADD CONSTRAINT erp_ledger_year_closes_pkey PRIMARY KEY (id);

ALTER TABLE ONLY erp_ledger_year_closes
    ADD CONSTRAINT erp_ledger_year_closes_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY journal_reference_counters
    ADD CONSTRAINT journal_reference_counters_pkey PRIMARY KEY (tenant_id);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE INDEX erp_journal_lines_by_account ON erp_journal_lines USING btree (tenant_id, account_id, entry_date);

CREATE INDEX erp_journal_lines_by_customer ON erp_journal_lines USING btree (tenant_id, customer_id) WHERE (customer_id IS NOT NULL);

CREATE INDEX erp_journals_by_date ON erp_journals USING btree (tenant_id, entry_date, reference) WHERE (status = 'posted'::text);

CREATE INDEX erp_journals_drafts ON erp_journals USING btree (tenant_id, drafted_at DESC) WHERE (status = 'draft'::text);

CREATE UNIQUE INDEX erp_journals_opening_unique ON erp_journals USING btree (tenant_id) WHERE (kind = 'opening'::text);

CREATE UNIQUE INDEX erp_journals_reversal_unique ON erp_journals USING btree (tenant_id, reversal_of) WHERE (reversal_of IS NOT NULL);

CREATE UNIQUE INDEX erp_journals_source_unique ON erp_journals USING btree (tenant_id, source_kind, source_id) WHERE (source_kind IS NOT NULL);

CREATE INDEX erp_ledger_period_events_by_period ON erp_ledger_period_events USING btree (tenant_id, period_start, occurred_at DESC);

CREATE INDEX erp_ledger_postings_pending ON erp_ledger_postings USING btree (tenant_id, document_date) WHERE (status = 'pending'::text);

CREATE UNIQUE INDEX erp_ledger_year_closes_open_unique ON erp_ledger_year_closes USING btree (tenant_id, year_start) WHERE (reopened_at IS NULL);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE erp_journal_lines
    ADD CONSTRAINT erp_journal_lines_account_fk FOREIGN KEY (tenant_id, account_id) REFERENCES erp_ledger_accounts(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE erp_journal_lines
    ADD CONSTRAINT erp_journal_lines_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers(tenant_id, id) ON DELETE RESTRICT;

ALTER TABLE erp_journal_lines
    ADD CONSTRAINT erp_journal_lines_journal_fk FOREIGN KEY (tenant_id, journal_id, entry_date) REFERENCES erp_journals(tenant_id, id, entry_date) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE erp_journal_lines
    ADD CONSTRAINT erp_journal_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_journals
    ADD CONSTRAINT erp_journals_reversal_fk FOREIGN KEY (tenant_id, reversal_of) REFERENCES erp_journals(tenant_id, id);

ALTER TABLE ONLY erp_journals
    ADD CONSTRAINT erp_journals_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_ledger_accounts
    ADD CONSTRAINT erp_ledger_accounts_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_ledger_period_events
    ADD CONSTRAINT erp_ledger_period_events_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_ledger_periods
    ADD CONSTRAINT erp_ledger_periods_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_ledger_postings
    ADD CONSTRAINT erp_ledger_postings_journal_fk FOREIGN KEY (tenant_id, journal_id) REFERENCES erp_journals(tenant_id, id);

ALTER TABLE ONLY erp_ledger_postings
    ADD CONSTRAINT erp_ledger_postings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_assembly_absorbed_fk FOREIGN KEY (tenant_id, assembly_absorbed_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_bank_fk FOREIGN KEY (tenant_id, bank_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_cash_fk FOREIGN KEY (tenant_id, cash_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_employer_insurance_expense_fk FOREIGN KEY (tenant_id, employer_insurance_expense_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_goods_received_fk FOREIGN KEY (tenant_id, goods_received_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_inventory_fk FOREIGN KEY (tenant_id, inventory_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_martyrs_fund_payable_fk FOREIGN KEY (tenant_id, martyrs_fund_payable_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_opening_balances_fk FOREIGN KEY (tenant_id, opening_balances_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_other_receipts_fk FOREIGN KEY (tenant_id, other_receipts_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_parts_cost_fk FOREIGN KEY (tenant_id, parts_cost_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_payroll_tax_payable_fk FOREIGN KEY (tenant_id, payroll_tax_payable_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_receivables_fk FOREIGN KEY (tenant_id, receivables_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_retained_earnings_fk FOREIGN KEY (tenant_id, retained_earnings_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_revenue_goods_fk FOREIGN KEY (tenant_id, revenue_goods_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_revenue_services_fk FOREIGN KEY (tenant_id, revenue_services_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_salaries_expense_fk FOREIGN KEY (tenant_id, salaries_expense_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_salaries_payable_fk FOREIGN KEY (tenant_id, salaries_payable_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_social_insurance_payable_fk FOREIGN KEY (tenant_id, social_insurance_payable_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_staff_claims_payable_fk FOREIGN KEY (tenant_id, staff_claims_payable_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_staff_expenses_fk FOREIGN KEY (tenant_id, staff_expenses_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_stock_adjustments_fk FOREIGN KEY (tenant_id, stock_adjustments_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY erp_ledger_settings
    ADD CONSTRAINT erp_ledger_settings_vat_output_fk FOREIGN KEY (tenant_id, vat_output_account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY erp_ledger_year_closes
    ADD CONSTRAINT erp_ledger_year_closes_closing_fk FOREIGN KEY (tenant_id, closing_journal_id) REFERENCES erp_journals(tenant_id, id);

ALTER TABLE ONLY erp_ledger_year_closes
    ADD CONSTRAINT erp_ledger_year_closes_reopening_fk FOREIGN KEY (tenant_id, reopening_journal_id) REFERENCES erp_journals(tenant_id, id);

ALTER TABLE ONLY erp_ledger_year_closes
    ADD CONSTRAINT erp_ledger_year_closes_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY journal_reference_counters
    ADD CONSTRAINT journal_reference_counters_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER erp_journal_lines_guard BEFORE INSERT OR DELETE OR UPDATE ON erp_journal_lines FOR EACH ROW EXECUTE FUNCTION erp_journal_lines_guard();

CREATE TRIGGER erp_journals_guard BEFORE INSERT OR DELETE OR UPDATE ON erp_journals FOR EACH ROW EXECUTE FUNCTION erp_journals_guard();

CREATE TRIGGER erp_journals_number BEFORE UPDATE ON erp_journals FOR EACH ROW EXECUTE FUNCTION assign_journal_reference();

CREATE TRIGGER erp_journals_set_updated_at BEFORE UPDATE ON erp_journals FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_ledger_accounts_guard BEFORE UPDATE ON erp_ledger_accounts FOR EACH ROW EXECUTE FUNCTION erp_ledger_accounts_guard();

CREATE TRIGGER erp_ledger_accounts_set_updated_at BEFORE UPDATE ON erp_ledger_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_ledger_postings_guard BEFORE DELETE OR UPDATE ON erp_ledger_postings FOR EACH ROW EXECUTE FUNCTION erp_ledger_postings_guard();

CREATE TRIGGER erp_ledger_postings_set_updated_at BEFORE UPDATE ON erp_ledger_postings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER erp_ledger_settings_guard BEFORE UPDATE ON erp_ledger_settings FOR EACH ROW EXECUTE FUNCTION erp_ledger_settings_guard();

CREATE TRIGGER erp_ledger_settings_set_updated_at BEFORE UPDATE ON erp_ledger_settings FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE erp_journal_lines ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_journals ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_ledger_accounts ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_ledger_period_events ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_ledger_periods ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_ledger_postings ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_ledger_settings ENABLE ROW LEVEL SECURITY;

ALTER TABLE erp_ledger_year_closes ENABLE ROW LEVEL SECURITY;

ALTER TABLE journal_reference_counters ENABLE ROW LEVEL SECURITY;

CREATE POLICY erp_journal_lines_isolation ON erp_journal_lines TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_journals_isolation ON erp_journals TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_ledger_accounts_isolation ON erp_ledger_accounts TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_ledger_period_events_isolation ON erp_ledger_period_events TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_ledger_periods_isolation ON erp_ledger_periods TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_ledger_postings_isolation ON erp_ledger_postings TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_ledger_settings_isolation ON erp_ledger_settings TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY erp_ledger_year_closes_isolation ON erp_ledger_year_closes TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY journal_reference_counters_isolation ON journal_reference_counters FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON COLUMN erp_journal_lines.entry_date IS 'The journal''s entry date, kept equal by the foreign key (on update cascade); it places the line in its year partition (P41).';

COMMENT ON FUNCTION assign_journal_reference() IS 'Numbers a journal when it is posted. Security definer: the runtime role cannot write the counter.';

COMMENT ON TABLE erp_ledger_settings IS 'The ledger''s set-up: its start date, fiscal year, automatic posting switches and the account each automatic posting uses.';

COMMENT ON TABLE erp_journals IS 'Double-entry journals. Posted ones are numbered, balanced and never change; a mistake is reversed.';

COMMENT ON TABLE erp_ledger_accounts IS 'A company''s chart of accounts. Archived, never deleted; an account''s type is fixed once anything is posted to it.';

COMMENT ON TABLE erp_ledger_periods IS 'Which months are locked. A month without a row is open. Every change appends erp_ledger_period_events.';

COMMENT ON TABLE erp_ledger_postings IS 'Documents the ledger posts, captured by the database. Pending ones are the unposted list; posted and set-aside ones never change.';

COMMENT ON TABLE journal_reference_counters IS 'The last journal number handed out per company. Written only by assign_journal_reference.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT,INSERT,UPDATE ON TABLE erp_ledger_settings TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_ledger_settings TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_journal_lines TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_journal_lines TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_journals TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_journals TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_ledger_accounts TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_ledger_accounts TO integr8_platform;

GRANT SELECT,INSERT ON TABLE erp_ledger_period_events TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_ledger_period_events TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_ledger_periods TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_ledger_periods TO integr8_platform;

GRANT SELECT,UPDATE ON TABLE erp_ledger_postings TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_ledger_postings TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE erp_ledger_year_closes TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE erp_ledger_year_closes TO integr8_platform;

GRANT SELECT ON TABLE journal_reference_counters TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE journal_reference_counters TO integr8_platform;

-- ---------------------------------------------------------------------------
-- Year partitions for the tables above (see 0001)
-- ---------------------------------------------------------------------------

SELECT ensure_year_partitions();
