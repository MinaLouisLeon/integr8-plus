-- Removes the ledger module (see the up file).

drop table if exists
  erp_ledger_postings,
  erp_ledger_year_closes,
  erp_journal_lines,
  erp_journals,
  journal_reference_counters,
  erp_ledger_period_events,
  erp_ledger_periods,
  erp_ledger_settings,
  erp_ledger_accounts
cascade;
drop function if exists assign_journal_reference();
drop function if exists erp_journal_lines_guard();
drop function if exists erp_journals_guard();
drop function if exists erp_ledger_accounts_guard();
drop function if exists erp_ledger_period_locked(uuid, date);
drop function if exists erp_ledger_postings_guard();
drop function if exists erp_ledger_settings_guard();
