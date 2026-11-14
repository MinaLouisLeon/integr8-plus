-- Reverses 0079. Approved amounts are lost with their columns: a claim
-- already posted keeps its journal, which records the amount approved.

drop table submission_action_results;
drop function submission_action_results_guard();
drop table submission_links;
drop function submission_links_guard();

-- 0039's posting of claims, at the amount claimed.
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

-- 0037's guard.
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

drop index hr_expense_claims_form_action_unique;
alter table hr_expense_claims
  drop constraint hr_expense_claims_approved_amount_shape,
  drop constraint hr_expense_claims_form_action_pairing,
  drop constraint hr_expense_claims_submission_fk,
  drop column amount_note,
  drop column approved_amount,
  drop column form_action_id,
  drop column submission_id;

alter table form_versions
  drop constraint form_versions_actions_shape,
  drop column actions;
