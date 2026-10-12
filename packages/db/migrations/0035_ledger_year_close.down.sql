-- Reverses 0035: the guard as 0033 wrote it.

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
