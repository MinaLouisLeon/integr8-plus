-- Employees, expense claims and payroll.
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

CREATE FUNCTION public.assign_expense_reference() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

CREATE FUNCTION public.hr_expense_claims_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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
    if new.approved_amount is not null or new.amount_note is not null then
      raise exception 'An approved amount is set when approving'
        using errcode = 'check_violation', constraint = 'hr_expense_claims_frozen';
    end if;
    return new;
  end if;
  if (new.claimant_id, new.category_id, new.work_order_id, new.spent_on, new.amount, new.currency,
      new.description, new.submitted_at, new.client_action_id, new.submission_id, new.form_action_id)
     is distinct from
     (old.claimant_id, old.category_id, old.work_order_id, old.spent_on, old.amount, old.currency,
      old.description, old.submitted_at, old.client_action_id, old.submission_id, old.form_action_id) then
    raise exception 'A submitted claim does not change; withdraw it and claim again'
      using errcode = 'check_violation', constraint = 'hr_expense_claims_frozen';
  end if;
  if (new.approved_amount, new.amount_note) is distinct from (old.approved_amount, old.amount_note)
     and not (old.status = 'submitted' and new.status = 'approved') then
    raise exception 'An approved amount is set when approving and never changes'
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

CREATE FUNCTION public.hr_expense_claims_ledger_capture() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
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

CREATE FUNCTION public.hr_payroll_lines_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  run_status text;
begin
  if integr8_purging(coalesce(new.tenant_id, old.tenant_id)) then
    return coalesce(new, old);
  end if;
  select r.status into run_status from hr_payroll_runs r
   where r.tenant_id = coalesce(new.tenant_id, old.tenant_id) and r.id = coalesce(new.run_id, old.run_id);
  -- Gone already: the draft is being discarded.
  if run_status is not null and run_status <> 'draft' then
    raise exception 'An approved pay run does not change'
      using errcode = 'check_violation', constraint = 'hr_payroll_runs_frozen';
  end if;
  return coalesce(new, old);
end;
$$;

CREATE FUNCTION public.hr_payroll_rule_sets_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if tg_op = 'DELETE' then
    -- integr8_purging() is null outside a purge.
    if old.confirmed_at is not null and not coalesce(integr8_purging(old.tenant_id), false) then
      raise exception 'A confirmed rule set is never deleted'
        using errcode = 'check_violation', constraint = 'hr_payroll_rule_sets_frozen';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' then
    if new.confirmed_at is not null then
      raise exception 'A rule set is confirmed after it is created'
        using errcode = 'check_violation', constraint = 'hr_payroll_rule_sets_frozen';
    end if;
    return new;
  end if;
  if old.confirmed_at is not null and (
       (new.name, new.effective_from, new.rules, new.confirmed_by, new.confirmed_at, new.confirmation_note)
       is distinct from
       (old.name, old.effective_from, old.rules, old.confirmed_by, old.confirmed_at, old.confirmation_note)) then
    raise exception 'A confirmed rule set does not change; add a new one from a later month'
      using errcode = 'check_violation', constraint = 'hr_payroll_rule_sets_frozen';
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.hr_payroll_runs_guard() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
declare
  rule_set hr_payroll_rule_sets%rowtype;
begin
  if tg_op = 'DELETE' then
    if old.status = 'approved' and not coalesce(integr8_purging(old.tenant_id), false) then
      raise exception 'An approved pay run is never deleted'
        using errcode = 'check_violation', constraint = 'hr_payroll_runs_frozen';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and old.status = 'approved' then
    raise exception 'An approved pay run does not change'
      using errcode = 'check_violation', constraint = 'hr_payroll_runs_frozen';
  end if;
  if tg_op = 'INSERT' and new.status <> 'draft' then
    raise exception 'A pay run starts as a draft'
      using errcode = 'check_violation', constraint = 'hr_payroll_runs_frozen';
  end if;
  select * into rule_set from hr_payroll_rule_sets
   where tenant_id = new.tenant_id and id = new.rule_set_id;
  if rule_set.confirmed_at is null or rule_set.effective_from > new.period_start then
    raise exception 'A pay run uses a confirmed rule set in force for its month'
      using errcode = 'check_violation', constraint = 'hr_payroll_runs_rule_set_usable';
  end if;
  return new;
end;
$$;

CREATE FUNCTION public.hr_payroll_runs_ledger_capture() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'pg_catalog', 'public'
    AS $$
begin
  if old.status = 'draft' and new.status = 'approved' then
    perform erp_ledger_capture(new.tenant_id, 'payroll_run', new.id, new.period_end, new.currency, new.approved_by);
  end if;
  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

CREATE TABLE expense_reference_counters (
    tenant_id uuid NOT NULL,
    last_reference integer NOT NULL
);

CREATE TABLE hr_employees (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    user_id uuid,
    employee_number text,
    full_name text NOT NULL,
    job_title text,
    department text,
    phone text,
    hire_date date NOT NULL,
    end_date date,
    end_reason text,
    national_id_sealed text,
    national_id_last4 text,
    insurance_number_sealed text,
    insurance_number_last4 text,
    bank_name text,
    bank_account_sealed text,
    bank_account_last4 text,
    emergency_contact_name text,
    emergency_contact_phone text,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hr_employees_end_after_hire CHECK (((end_date IS NULL) OR (end_date >= hire_date))),
    CONSTRAINT hr_employees_end_pairing CHECK (((end_date IS NULL) = (end_reason IS NULL))),
    CONSTRAINT hr_employees_last4_shape CHECK ((((national_id_last4 IS NULL) OR ((char_length(national_id_last4) >= 1) AND (char_length(national_id_last4) <= 4))) AND ((insurance_number_last4 IS NULL) OR ((char_length(insurance_number_last4) >= 1) AND (char_length(insurance_number_last4) <= 4))) AND ((bank_account_last4 IS NULL) OR ((char_length(bank_account_last4) >= 1) AND (char_length(bank_account_last4) <= 4))))),
    CONSTRAINT hr_employees_name_present CHECK (((btrim(full_name) <> ''::text) AND (char_length(full_name) <= 200))),
    CONSTRAINT hr_employees_sealed_pairing CHECK ((((national_id_sealed IS NULL) = (national_id_last4 IS NULL)) AND ((insurance_number_sealed IS NULL) = (insurance_number_last4 IS NULL)) AND ((bank_account_sealed IS NULL) = (bank_account_last4 IS NULL)))),
    CONSTRAINT hr_employees_sealed_shape CHECK ((((national_id_sealed IS NULL) OR (national_id_sealed ~ '^hr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'::text)) AND ((insurance_number_sealed IS NULL) OR (insurance_number_sealed ~ '^hr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'::text)) AND ((bank_account_sealed IS NULL) OR (bank_account_sealed ~ '^hr1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'::text)))),
    CONSTRAINT hr_employees_text_lengths CHECK ((((employee_number IS NULL) OR ((btrim(employee_number) <> ''::text) AND (char_length(employee_number) <= 40))) AND ((job_title IS NULL) OR (char_length(job_title) <= 200)) AND ((department IS NULL) OR (char_length(department) <= 200)) AND ((phone IS NULL) OR (char_length(phone) <= 40)) AND ((end_reason IS NULL) OR (char_length(end_reason) <= 1000)) AND ((bank_name IS NULL) OR (char_length(bank_name) <= 200)) AND ((emergency_contact_name IS NULL) OR (char_length(emergency_contact_name) <= 200)) AND ((emergency_contact_phone IS NULL) OR (char_length(emergency_contact_phone) <= 40)))),
    CONSTRAINT hr_employees_version_positive CHECK ((version > 0))
);

CREATE TABLE hr_expense_categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    account_id uuid,
    archived_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hr_expense_categories_name_present CHECK (((btrim(name) <> ''::text) AND (char_length(name) <= 100))),
    CONSTRAINT hr_expense_categories_version_positive CHECK ((version > 0))
);

CREATE TABLE hr_expense_claims (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    reference integer DEFAULT 0 NOT NULL,
    claimant_id uuid NOT NULL,
    category_id uuid NOT NULL,
    work_order_id uuid,
    spent_on date NOT NULL,
    amount numeric(20,4) NOT NULL,
    currency text NOT NULL,
    description text NOT NULL,
    status text DEFAULT 'submitted'::text NOT NULL,
    client_action_id uuid,
    submitted_at timestamp with time zone DEFAULT now() NOT NULL,
    decided_by uuid,
    decided_at timestamp with time zone,
    reject_reason text,
    settle_via text,
    paid_via text,
    paid_by uuid,
    paid_at timestamp with time zone,
    payment_reference text,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    payroll_run_id uuid,
    submission_id uuid,
    form_action_id text,
    approved_amount numeric(20,4),
    amount_note text,
    CONSTRAINT hr_expense_claims_amount_positive CHECK ((amount > (0)::numeric)),
    CONSTRAINT hr_expense_claims_approved_amount_shape CHECK ((((approved_amount IS NULL) = (amount_note IS NULL)) AND ((approved_amount IS NULL) OR ((approved_amount > (0)::numeric) AND (approved_amount <> amount))) AND ((amount_note IS NULL) OR ((btrim(amount_note) <> ''::text) AND (char_length(amount_note) <= 1000))) AND ((approved_amount IS NULL) OR (status = ANY (ARRAY['approved'::text, 'paid'::text]))))),
    CONSTRAINT hr_expense_claims_currency_shape CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT hr_expense_claims_decision_pairing CHECK ((((status = ANY (ARRAY['approved'::text, 'rejected'::text, 'paid'::text])) = (decided_by IS NOT NULL)) AND ((decided_by IS NULL) = (decided_at IS NULL)) AND ((status = 'rejected'::text) = (reject_reason IS NOT NULL)) AND ((status = ANY (ARRAY['approved'::text, 'paid'::text])) = (settle_via IS NOT NULL)))),
    CONSTRAINT hr_expense_claims_description_present CHECK (((btrim(description) <> ''::text) AND (char_length(description) <= 1000))),
    CONSTRAINT hr_expense_claims_form_action_pairing CHECK ((((submission_id IS NULL) = (form_action_id IS NULL)) AND ((form_action_id IS NULL) OR (form_action_id ~ '^[a-z][a-z0-9_]{0,39}$'::text)))),
    CONSTRAINT hr_expense_claims_not_self_approved CHECK (((decided_by IS NULL) OR (decided_by <> claimant_id))),
    CONSTRAINT hr_expense_claims_paid_pairing CHECK ((((status = 'paid'::text) = (paid_via IS NOT NULL)) AND ((paid_via IS NULL) = (paid_at IS NULL)) AND ((paid_via IS NULL) OR (paid_via = 'payroll'::text) OR (paid_by IS NOT NULL)) AND ((paid_via IS NULL) OR ((paid_via = 'payroll'::text) = (settle_via = 'payroll'::text))))),
    CONSTRAINT hr_expense_claims_paid_via_known CHECK (((paid_via IS NULL) OR (paid_via = ANY (ARRAY['cash'::text, 'bank_transfer'::text, 'payroll'::text])))),
    CONSTRAINT hr_expense_claims_payroll_pairing CHECK ((COALESCE((paid_via = 'payroll'::text), false) = (payroll_run_id IS NOT NULL))),
    CONSTRAINT hr_expense_claims_settle_via_known CHECK (((settle_via IS NULL) OR (settle_via = ANY (ARRAY['direct'::text, 'payroll'::text])))),
    CONSTRAINT hr_expense_claims_status_known CHECK ((status = ANY (ARRAY['submitted'::text, 'approved'::text, 'rejected'::text, 'withdrawn'::text, 'paid'::text]))),
    CONSTRAINT hr_expense_claims_text_lengths CHECK ((((reject_reason IS NULL) OR ((btrim(reject_reason) <> ''::text) AND (char_length(reject_reason) <= 1000))) AND ((payment_reference IS NULL) OR (char_length(payment_reference) <= 200)))),
    CONSTRAINT hr_expense_claims_version_positive CHECK ((version > 0))
);

CREATE TABLE hr_pay_terms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    effective_from date NOT NULL,
    basic numeric(20,4) NOT NULL,
    allowances numeric(20,4) DEFAULT 0 NOT NULL,
    insured boolean DEFAULT true NOT NULL,
    insurable_wage numeric(20,4),
    standard_hours numeric(8,2) DEFAULT 208 NOT NULL,
    overtime_rate numeric(20,4),
    pay_method text DEFAULT 'bank_transfer'::text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT hr_pay_terms_amounts CHECK (((basic >= (0)::numeric) AND (allowances >= (0)::numeric) AND ((insurable_wage IS NULL) OR (insurable_wage > (0)::numeric)) AND (standard_hours > (0)::numeric) AND ((overtime_rate IS NULL) OR (overtime_rate >= (0)::numeric)))),
    CONSTRAINT hr_pay_terms_pay_method_known CHECK ((pay_method = ANY (ARRAY['bank_transfer'::text, 'cash'::text]))),
    CONSTRAINT hr_pay_terms_version_positive CHECK ((version > 0))
);

CREATE TABLE hr_payroll_lines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    run_id uuid NOT NULL,
    employee_id uuid NOT NULL,
    basic numeric(20,4) NOT NULL,
    allowances numeric(20,4) NOT NULL,
    clocked_hours numeric(10,2) DEFAULT 0 NOT NULL,
    overtime_hours numeric(10,2) DEFAULT 0 NOT NULL,
    overtime_rate numeric(20,4) DEFAULT 0 NOT NULL,
    bonus numeric(20,4) DEFAULT 0 NOT NULL,
    deduction numeric(20,4) DEFAULT 0 NOT NULL,
    unpaid_days numeric(6,2) DEFAULT 0 NOT NULL,
    reimbursements numeric(20,4) DEFAULT 0 NOT NULL,
    declared_insurable_wage numeric(20,4),
    insured boolean NOT NULL,
    pay_method text NOT NULL,
    note text,
    overtime_pay numeric(20,4) NOT NULL,
    unpaid_leave numeric(20,4) NOT NULL,
    gross numeric(20,4) NOT NULL,
    insurable_wage numeric(20,4) NOT NULL,
    si_employee numeric(20,4) NOT NULL,
    si_employer numeric(20,4) NOT NULL,
    taxable numeric(20,4) NOT NULL,
    income_tax numeric(20,4) NOT NULL,
    martyrs_fund numeric(20,4) NOT NULL,
    net numeric(20,4) NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hr_payroll_lines_balance CHECK ((net = ((((gross - si_employee) - income_tax) - martyrs_fund) + reimbursements))),
    CONSTRAINT hr_payroll_lines_inputs CHECK (((basic >= (0)::numeric) AND (allowances >= (0)::numeric) AND (clocked_hours >= (0)::numeric) AND (overtime_hours >= (0)::numeric) AND (overtime_rate >= (0)::numeric) AND (bonus >= (0)::numeric) AND (deduction >= (0)::numeric) AND (reimbursements >= (0)::numeric) AND ((unpaid_days >= (0)::numeric) AND (unpaid_days <= (30)::numeric)) AND ((declared_insurable_wage IS NULL) OR (declared_insurable_wage > (0)::numeric)))),
    CONSTRAINT hr_payroll_lines_note_length CHECK (((note IS NULL) OR (char_length(note) <= 1000))),
    CONSTRAINT hr_payroll_lines_outputs CHECK (((overtime_pay >= (0)::numeric) AND (unpaid_leave >= (0)::numeric) AND (gross >= (0)::numeric) AND (insurable_wage >= (0)::numeric) AND (si_employee >= (0)::numeric) AND (si_employer >= (0)::numeric) AND (taxable >= (0)::numeric) AND (income_tax >= (0)::numeric) AND (martyrs_fund >= (0)::numeric))),
    CONSTRAINT hr_payroll_lines_pay_method_known CHECK ((pay_method = ANY (ARRAY['bank_transfer'::text, 'cash'::text]))),
    CONSTRAINT hr_payroll_lines_version_positive CHECK ((version > 0))
);

CREATE TABLE hr_payroll_rule_sets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    effective_from date NOT NULL,
    rules jsonb NOT NULL,
    confirmed_by uuid,
    confirmed_at timestamp with time zone,
    confirmation_note text,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    CONSTRAINT hr_payroll_rule_sets_confirmation_pairing CHECK ((((confirmed_by IS NULL) = (confirmed_at IS NULL)) AND ((confirmed_by IS NULL) = (confirmation_note IS NULL)))),
    CONSTRAINT hr_payroll_rule_sets_month_start CHECK ((EXTRACT(day FROM effective_from) = (1)::numeric)),
    CONSTRAINT hr_payroll_rule_sets_name_present CHECK (((btrim(name) <> ''::text) AND (char_length(name) <= 200))),
    CONSTRAINT hr_payroll_rule_sets_note_length CHECK (((confirmation_note IS NULL) OR ((btrim(confirmation_note) <> ''::text) AND (char_length(confirmation_note) <= 1000)))),
    CONSTRAINT hr_payroll_rule_sets_rules_shape CHECK ((jsonb_typeof(rules) = 'object'::text)),
    CONSTRAINT hr_payroll_rule_sets_version_positive CHECK ((version > 0))
);

CREATE TABLE hr_payroll_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    period_start date NOT NULL,
    period_end date NOT NULL,
    rule_set_id uuid NOT NULL,
    currency text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    pay_date date,
    note text,
    prepared_by uuid NOT NULL,
    prepared_at timestamp with time zone DEFAULT now() NOT NULL,
    approved_by uuid,
    approved_at timestamp with time zone,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT hr_payroll_runs_approval_pairing CHECK ((((status = 'approved'::text) = (approved_by IS NOT NULL)) AND ((approved_by IS NULL) = (approved_at IS NULL)))),
    CONSTRAINT hr_payroll_runs_currency_shape CHECK ((currency ~ '^[A-Z]{3}$'::text)),
    CONSTRAINT hr_payroll_runs_month CHECK (((EXTRACT(day FROM period_start) = (1)::numeric) AND (period_end = (((period_start + '1 mon'::interval) - '1 day'::interval))::date))),
    CONSTRAINT hr_payroll_runs_not_self_approved CHECK (((approved_by IS NULL) OR (approved_by <> prepared_by))),
    CONSTRAINT hr_payroll_runs_note_length CHECK (((note IS NULL) OR (char_length(note) <= 1000))),
    CONSTRAINT hr_payroll_runs_status_known CHECK ((status = ANY (ARRAY['draft'::text, 'approved'::text]))),
    CONSTRAINT hr_payroll_runs_version_positive CHECK ((version > 0))
);

-- ---------------------------------------------------------------------------
-- Keys and constraints
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY expense_reference_counters
    ADD CONSTRAINT expense_reference_counters_pkey PRIMARY KEY (tenant_id);

ALTER TABLE ONLY hr_employees
    ADD CONSTRAINT hr_employees_pkey PRIMARY KEY (id);

ALTER TABLE ONLY hr_employees
    ADD CONSTRAINT hr_employees_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY hr_expense_categories
    ADD CONSTRAINT hr_expense_categories_pkey PRIMARY KEY (id);

ALTER TABLE ONLY hr_expense_categories
    ADD CONSTRAINT hr_expense_categories_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY hr_expense_claims
    ADD CONSTRAINT hr_expense_claims_client_action_unique UNIQUE (tenant_id, client_action_id);

ALTER TABLE ONLY hr_expense_claims
    ADD CONSTRAINT hr_expense_claims_pkey PRIMARY KEY (id);

ALTER TABLE ONLY hr_expense_claims
    ADD CONSTRAINT hr_expense_claims_reference_unique UNIQUE (tenant_id, reference);

ALTER TABLE ONLY hr_expense_claims
    ADD CONSTRAINT hr_expense_claims_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY hr_pay_terms
    ADD CONSTRAINT hr_pay_terms_from_unique UNIQUE (tenant_id, employee_id, effective_from);

ALTER TABLE ONLY hr_pay_terms
    ADD CONSTRAINT hr_pay_terms_pkey PRIMARY KEY (id);

ALTER TABLE ONLY hr_pay_terms
    ADD CONSTRAINT hr_pay_terms_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY hr_payroll_lines
    ADD CONSTRAINT hr_payroll_lines_employee_unique UNIQUE (tenant_id, run_id, employee_id);

ALTER TABLE ONLY hr_payroll_lines
    ADD CONSTRAINT hr_payroll_lines_pkey PRIMARY KEY (id);

ALTER TABLE ONLY hr_payroll_lines
    ADD CONSTRAINT hr_payroll_lines_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY hr_payroll_rule_sets
    ADD CONSTRAINT hr_payroll_rule_sets_from_unique UNIQUE (tenant_id, effective_from);

ALTER TABLE ONLY hr_payroll_rule_sets
    ADD CONSTRAINT hr_payroll_rule_sets_pkey PRIMARY KEY (id);

ALTER TABLE ONLY hr_payroll_rule_sets
    ADD CONSTRAINT hr_payroll_rule_sets_tenant_id_unique UNIQUE (tenant_id, id);

ALTER TABLE ONLY hr_payroll_runs
    ADD CONSTRAINT hr_payroll_runs_period_unique UNIQUE (tenant_id, period_start);

ALTER TABLE ONLY hr_payroll_runs
    ADD CONSTRAINT hr_payroll_runs_pkey PRIMARY KEY (id);

ALTER TABLE ONLY hr_payroll_runs
    ADD CONSTRAINT hr_payroll_runs_tenant_id_unique UNIQUE (tenant_id, id);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX hr_employees_member_unique ON hr_employees USING btree (tenant_id, user_id) WHERE (user_id IS NOT NULL);

CREATE UNIQUE INDEX hr_employees_number_unique ON hr_employees USING btree (tenant_id, lower(employee_number)) WHERE (employee_number IS NOT NULL);

CREATE UNIQUE INDEX hr_expense_categories_name_unique ON hr_expense_categories USING btree (tenant_id, lower(name)) WHERE (archived_at IS NULL);

CREATE INDEX hr_expense_claims_claimant ON hr_expense_claims USING btree (tenant_id, claimant_id, submitted_at DESC);

CREATE UNIQUE INDEX hr_expense_claims_form_action_unique ON hr_expense_claims USING btree (tenant_id, submission_id, form_action_id) WHERE (submission_id IS NOT NULL);

CREATE INDEX hr_expense_claims_open ON hr_expense_claims USING btree (tenant_id, status) WHERE (status = ANY (ARRAY['submitted'::text, 'approved'::text]));

CREATE INDEX hr_expense_claims_payroll_run ON hr_expense_claims USING btree (tenant_id, payroll_run_id) WHERE (payroll_run_id IS NOT NULL);

CREATE INDEX hr_payroll_lines_employee ON hr_payroll_lines USING btree (tenant_id, employee_id);

-- ---------------------------------------------------------------------------
-- Foreign keys
-- ---------------------------------------------------------------------------

ALTER TABLE ONLY attachments
    ADD CONSTRAINT attachments_expense_claim_fk FOREIGN KEY (tenant_id, expense_claim_id) REFERENCES hr_expense_claims(tenant_id, id);

ALTER TABLE ONLY expense_reference_counters
    ADD CONSTRAINT expense_reference_counters_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY hr_employees
    ADD CONSTRAINT hr_employees_member_fk FOREIGN KEY (tenant_id, user_id) REFERENCES tenant_users(tenant_id, user_id);

ALTER TABLE ONLY hr_employees
    ADD CONSTRAINT hr_employees_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY hr_expense_categories
    ADD CONSTRAINT hr_expense_categories_account_fk FOREIGN KEY (tenant_id, account_id) REFERENCES erp_ledger_accounts(tenant_id, id);

ALTER TABLE ONLY hr_expense_categories
    ADD CONSTRAINT hr_expense_categories_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY hr_expense_claims
    ADD CONSTRAINT hr_expense_claims_category_fk FOREIGN KEY (tenant_id, category_id) REFERENCES hr_expense_categories(tenant_id, id);

ALTER TABLE ONLY hr_expense_claims
    ADD CONSTRAINT hr_expense_claims_claimant_fk FOREIGN KEY (tenant_id, claimant_id) REFERENCES tenant_users(tenant_id, user_id);

ALTER TABLE ONLY hr_expense_claims
    ADD CONSTRAINT hr_expense_claims_payroll_run_fk FOREIGN KEY (tenant_id, payroll_run_id) REFERENCES hr_payroll_runs(tenant_id, id);

ALTER TABLE ONLY hr_expense_claims
    ADD CONSTRAINT hr_expense_claims_submission_fk FOREIGN KEY (tenant_id, submission_id) REFERENCES submissions(tenant_id, id);

ALTER TABLE ONLY hr_expense_claims
    ADD CONSTRAINT hr_expense_claims_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY hr_expense_claims
    ADD CONSTRAINT hr_expense_claims_work_order_fk FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_orders(tenant_id, id);

ALTER TABLE ONLY hr_pay_terms
    ADD CONSTRAINT hr_pay_terms_employee_fk FOREIGN KEY (tenant_id, employee_id) REFERENCES hr_employees(tenant_id, id);

ALTER TABLE ONLY hr_pay_terms
    ADD CONSTRAINT hr_pay_terms_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY hr_payroll_lines
    ADD CONSTRAINT hr_payroll_lines_employee_fk FOREIGN KEY (tenant_id, employee_id) REFERENCES hr_employees(tenant_id, id);

ALTER TABLE ONLY hr_payroll_lines
    ADD CONSTRAINT hr_payroll_lines_run_fk FOREIGN KEY (tenant_id, run_id) REFERENCES hr_payroll_runs(tenant_id, id) ON DELETE CASCADE;

ALTER TABLE ONLY hr_payroll_lines
    ADD CONSTRAINT hr_payroll_lines_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY hr_payroll_rule_sets
    ADD CONSTRAINT hr_payroll_rule_sets_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY hr_payroll_runs
    ADD CONSTRAINT hr_payroll_runs_rule_set_fk FOREIGN KEY (tenant_id, rule_set_id) REFERENCES hr_payroll_rule_sets(tenant_id, id);

ALTER TABLE ONLY hr_payroll_runs
    ADD CONSTRAINT hr_payroll_runs_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE ONLY submission_action_results
    ADD CONSTRAINT submission_action_results_claim_fk FOREIGN KEY (tenant_id, claim_id) REFERENCES hr_expense_claims(tenant_id, id);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------

CREATE TRIGGER hr_employees_set_updated_at BEFORE UPDATE ON hr_employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER hr_expense_categories_set_updated_at BEFORE UPDATE ON hr_expense_categories FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER hr_expense_claims_guard BEFORE INSERT OR DELETE OR UPDATE ON hr_expense_claims FOR EACH ROW EXECUTE FUNCTION hr_expense_claims_guard();

CREATE TRIGGER hr_expense_claims_ledger_capture AFTER UPDATE OF status ON hr_expense_claims FOR EACH ROW EXECUTE FUNCTION hr_expense_claims_ledger_capture();

CREATE TRIGGER hr_expense_claims_number BEFORE INSERT OR UPDATE ON hr_expense_claims FOR EACH ROW EXECUTE FUNCTION assign_expense_reference();

CREATE TRIGGER hr_expense_claims_set_updated_at BEFORE UPDATE ON hr_expense_claims FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER hr_pay_terms_set_updated_at BEFORE UPDATE ON hr_pay_terms FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER hr_payroll_lines_guard BEFORE INSERT OR DELETE OR UPDATE ON hr_payroll_lines FOR EACH ROW EXECUTE FUNCTION hr_payroll_lines_guard();

CREATE TRIGGER hr_payroll_lines_set_updated_at BEFORE UPDATE ON hr_payroll_lines FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER hr_payroll_rule_sets_guard BEFORE INSERT OR DELETE OR UPDATE ON hr_payroll_rule_sets FOR EACH ROW EXECUTE FUNCTION hr_payroll_rule_sets_guard();

CREATE TRIGGER hr_payroll_rule_sets_set_updated_at BEFORE UPDATE ON hr_payroll_rule_sets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TRIGGER hr_payroll_runs_guard BEFORE INSERT OR DELETE OR UPDATE ON hr_payroll_runs FOR EACH ROW EXECUTE FUNCTION hr_payroll_runs_guard();

CREATE TRIGGER hr_payroll_runs_ledger_capture AFTER UPDATE OF status ON hr_payroll_runs FOR EACH ROW EXECUTE FUNCTION hr_payroll_runs_ledger_capture();

CREATE TRIGGER hr_payroll_runs_set_updated_at BEFORE UPDATE ON hr_payroll_runs FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

ALTER TABLE expense_reference_counters ENABLE ROW LEVEL SECURITY;

ALTER TABLE hr_employees ENABLE ROW LEVEL SECURITY;

ALTER TABLE hr_expense_categories ENABLE ROW LEVEL SECURITY;

ALTER TABLE hr_expense_claims ENABLE ROW LEVEL SECURITY;

ALTER TABLE hr_pay_terms ENABLE ROW LEVEL SECURITY;

ALTER TABLE hr_payroll_lines ENABLE ROW LEVEL SECURITY;

ALTER TABLE hr_payroll_rule_sets ENABLE ROW LEVEL SECURITY;

ALTER TABLE hr_payroll_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY expense_reference_counters_isolation ON expense_reference_counters FOR SELECT TO integr8_app USING ((tenant_id = app_current_tenant_id()));

CREATE POLICY hr_employees_isolation ON hr_employees TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY hr_expense_categories_isolation ON hr_expense_categories TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY hr_expense_claims_isolation ON hr_expense_claims TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY hr_pay_terms_isolation ON hr_pay_terms TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY hr_payroll_lines_isolation ON hr_payroll_lines TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY hr_payroll_rule_sets_isolation ON hr_payroll_rule_sets TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

CREATE POLICY hr_payroll_runs_isolation ON hr_payroll_runs TO integr8_app USING ((tenant_id = app_current_tenant_id())) WITH CHECK ((tenant_id = app_current_tenant_id()));

-- ---------------------------------------------------------------------------
-- Comments
-- ---------------------------------------------------------------------------

COMMENT ON FUNCTION assign_expense_reference() IS 'Numbers an expense claim when it is submitted, and keeps the number. Security definer: the runtime role cannot write the counter.';

COMMENT ON TABLE expense_reference_counters IS 'The last expense claim number handed out per company. Written only by assign_expense_reference.';

COMMENT ON TABLE hr_employees IS 'Employee profiles (ADR-0010): linked to a member or standing alone. Sensitive numbers are AES-256-GCM ciphertext written by the API.';

COMMENT ON COLUMN hr_expense_claims.approved_amount IS 'Set only when approving, with amount_note: what is posted and paid back instead of amount. Null pays the amount claimed.';

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT ON TABLE expense_reference_counters TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE expense_reference_counters TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE hr_employees TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE hr_employees TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE hr_expense_categories TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE hr_expense_categories TO integr8_platform;

GRANT SELECT,INSERT,UPDATE ON TABLE hr_expense_claims TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE hr_expense_claims TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE hr_pay_terms TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE hr_pay_terms TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE hr_payroll_lines TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE hr_payroll_lines TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE hr_payroll_rule_sets TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE hr_payroll_rule_sets TO integr8_platform;

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE hr_payroll_runs TO integr8_app;
GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE hr_payroll_runs TO integr8_platform;
