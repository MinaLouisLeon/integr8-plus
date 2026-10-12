-- CRM/ERP plan, phase A1 (ADR-0009): closing a fiscal year.
--
-- Months are locked as they are finished, so a year's closing journal —
-- dated on its last day, moving income and expenses into retained earnings —
-- would meet a locked month. It, and the reversal that reopens the year, are
-- the only journals that may: dated on the last day of a fiscal year, and on
-- income, expense and the retained earnings account alone. Who may close and
-- reopen is the API's (ledger.manage, and ledger.unlock with a reason); one
-- close per year at a time is erp_ledger_year_closes_open_unique.

create or replace function erp_journals_guard() returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
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
