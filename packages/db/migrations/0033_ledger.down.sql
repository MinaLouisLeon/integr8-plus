-- Reverses 0033. Drops the chart of accounts, every journal, the period locks
-- and year closes. Fine on a fresh or test database; on a live one, take a
-- backup or a company export first.

drop table erp_ledger_year_closes;
drop table erp_journal_lines;
drop table erp_journals;
drop function erp_journal_lines_guard();
drop function erp_journals_guard();
drop function assign_journal_reference();
drop table journal_reference_counters;
drop table erp_ledger_period_events;
drop table erp_ledger_periods;
drop function erp_ledger_period_locked(uuid, date);
drop table erp_ledger_settings;
drop function erp_ledger_settings_guard();
drop table erp_ledger_accounts;
drop function erp_ledger_accounts_guard();

delete from feature_flags where key = 'ledger';
