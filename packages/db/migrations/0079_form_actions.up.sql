-- P40: form actions. A form version says what happens when one of its
-- submissions is submitted: expense claims made from its answers, and another
-- form opened for the same job. Proposed defaults for the owner's open
-- decisions are in plan/v1.5-form-actions/P40-form-actions.md.
--
-- Actions sit beside the definition, not inside it: the server makes the
-- claims, so phones never read that part, and the definition's format and its
-- conformance suite stay as they are. A published version is immutable
-- (0006), so its actions are too: a change of rules reaches new submissions
-- only.

alter table form_versions
  add column actions jsonb not null default '[]'::jsonb,
  add constraint form_versions_actions_shape check (
    jsonb_typeof(actions) = 'array' and jsonb_array_length(actions) <= 10);

comment on column form_versions.actions is
  'What a submit of this version does (P40): expense claims and follow-up forms. Checked by @integr8/form-package; the server alone reads it.';

-- ---------------------------------------------------------------------------
-- Claims a form made, and the accountant's approved amount
-- ---------------------------------------------------------------------------

alter table hr_expense_claims
  add column submission_id uuid,
  add column form_action_id text,
  -- The amount the approver settled on, when it differs from the claim.
  add column approved_amount numeric(20,4),
  add column amount_note text,
  add constraint hr_expense_claims_submission_fk
    foreign key (tenant_id, submission_id) references submissions (tenant_id, id),
  add constraint hr_expense_claims_form_action_pairing check (
    (submission_id is null) = (form_action_id is null)
    and (form_action_id is null or form_action_id ~ '^[a-z][a-z0-9_]{0,39}$')),
  -- A correction is a different amount, says why, and is part of approving.
  add constraint hr_expense_claims_approved_amount_shape check (
    (approved_amount is null) = (amount_note is null)
    and (approved_amount is null or (approved_amount > 0 and approved_amount <> amount))
    and (amount_note is null or (btrim(amount_note) <> '' and char_length(amount_note) <= 1000))
    and (approved_amount is null or status in ('approved', 'paid')));

-- One claim per action of a submission, whatever path made it.
create unique index hr_expense_claims_form_action_unique
  on hr_expense_claims (tenant_id, submission_id, form_action_id) where submission_id is not null;

comment on column hr_expense_claims.approved_amount is
  'Set only when approving, with amount_note: what is posted and paid back instead of amount. Null pays the amount claimed.';

-- As in 0037, with the form link frozen from insert and the approved amount
-- written only by the submitted → approved step.
create or replace function hr_expense_claims_guard() returns trigger
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

-- As in 0039, with a claim posted and paid at its approved amount.
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
    select coalesce(c.account_id, s.staff_expenses_account_id), coalesce(x.approved_amount, x.amount),
           0::numeric, null::uuid
      from hr_expense_claims x
      join hr_expense_categories c on c.tenant_id = x.tenant_id and c.id = x.category_id
     where x.tenant_id = p_tenant and x.id = p_source
    union all
    select s.staff_claims_payable_account_id, 0::numeric, coalesce(x.approved_amount, x.amount), null::uuid
      from hr_expense_claims x where x.tenant_id = p_tenant and x.id = p_source;
    return;
  end if;

  if p_kind = 'expense_payment' then
    return query
    select s.staff_claims_payable_account_id, coalesce(x.approved_amount, x.amount), 0::numeric, null::uuid
      from hr_expense_claims x where x.tenant_id = p_tenant and x.id = p_source
    union all
    select case x.paid_via when 'cash' then s.cash_account_id else s.bank_account_id end,
           0::numeric, coalesce(x.approved_amount, x.amount), null::uuid
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

-- ---------------------------------------------------------------------------
-- Follow-up forms: the submission an action opened from another
-- ---------------------------------------------------------------------------

create table submission_links (
  id                  uuid        primary key default gen_random_uuid(),
  tenant_id           uuid        not null references tenants (id) on delete restrict,
  from_submission_id  uuid        not null,
  to_submission_id    uuid        not null,
  form_action_id      text        not null,
  -- Copied from the action: a required follow-up holds the job open.
  required            boolean     not null,
  created_at          timestamptz not null default now(),
  constraint submission_links_tenant_id_unique unique (tenant_id, id),
  constraint submission_links_from_fk
    foreign key (tenant_id, from_submission_id) references submissions (tenant_id, id),
  constraint submission_links_to_fk
    foreign key (tenant_id, to_submission_id) references submissions (tenant_id, id),
  constraint submission_links_action_unique unique (tenant_id, from_submission_id, form_action_id),
  constraint submission_links_to_unique unique (tenant_id, to_submission_id),
  constraint submission_links_not_self check (from_submission_id <> to_submission_id),
  constraint submission_links_action_shape check (form_action_id ~ '^[a-z][a-z0-9_]{0,39}$')
);

comment on table submission_links is
  'A follow-up submission a form action opened (P40). Written once by the server; never changed.';

create index submission_links_by_to on submission_links (tenant_id, to_submission_id);

create function submission_links_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' and integr8_purging(old.tenant_id) then
    return old;
  end if;
  raise exception 'A link between submissions never changes'
    using errcode = 'check_violation', constraint = 'submission_links_frozen';
end;
$$;

create trigger submission_links_guard
  before update or delete on submission_links
  for each row execute function submission_links_guard();

grant select, insert on submission_links to integr8_app;
alter table submission_links enable row level security;
create policy submission_links_isolation on submission_links for all to integr8_app
  using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id());

-- ---------------------------------------------------------------------------
-- What each action of a submission did, so the office sees a claim not made
-- ---------------------------------------------------------------------------

create table submission_action_results (
  tenant_id       uuid        not null references tenants (id) on delete restrict,
  submission_id   uuid        not null,
  form_action_id  text        not null,
  kind            text        not null,
  -- made: done; skipped: its condition did not hold or the amount was nothing;
  -- failed: could not be done, with the reason in words.
  outcome         text        not null,
  claim_id        uuid,
  link_id         uuid,
  reason_code     text,
  reason          text,
  attempts        integer     not null default 1,
  attempted_by    uuid        not null,
  attempted_at    timestamptz not null default now(),
  constraint submission_action_results_pkey primary key (tenant_id, submission_id, form_action_id),
  constraint submission_action_results_submission_fk
    foreign key (tenant_id, submission_id) references submissions (tenant_id, id),
  constraint submission_action_results_claim_fk
    foreign key (tenant_id, claim_id) references hr_expense_claims (tenant_id, id),
  constraint submission_action_results_link_fk
    foreign key (tenant_id, link_id) references submission_links (tenant_id, id),
  constraint submission_action_results_kind_known check (kind in ('expense_claim', 'open_form')),
  constraint submission_action_results_outcome_known check (outcome in ('made', 'skipped', 'failed')),
  constraint submission_action_results_action_shape check (form_action_id ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint submission_action_results_pairing check (
    (outcome = 'made') = (claim_id is not null or link_id is not null)
    and (claim_id is null or kind = 'expense_claim')
    and (link_id is null or kind = 'open_form')
    and (outcome = 'failed') = (reason_code is not null)
    and (reason_code is null) = (reason is null)
    and (reason is null or char_length(reason) <= 1000)),
  constraint submission_action_results_attempts_positive check (attempts > 0)
);

comment on table submission_action_results is
  'The last outcome of each action of a submitted form (P40). A failed one is retried from the office ("Make it now").';

-- A made action stays made.
create function submission_action_results_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  if tg_op = 'DELETE' then
    if integr8_purging(old.tenant_id) then
      return old;
    end if;
    raise exception 'An action''s outcome is never deleted'
      using errcode = 'check_violation', constraint = 'submission_action_results_frozen';
  end if;
  if old.outcome = 'made' then
    raise exception 'A made action does not change'
      using errcode = 'check_violation', constraint = 'submission_action_results_frozen';
  end if;
  return new;
end;
$$;

create trigger submission_action_results_guard
  before update or delete on submission_action_results
  for each row execute function submission_action_results_guard();

grant select, insert, update on submission_action_results to integr8_app;
alter table submission_action_results enable row level security;
create policy submission_action_results_isolation on submission_action_results for all to integr8_app
  using (tenant_id = app_current_tenant_id()) with check (tenant_id = app_current_tenant_id());
