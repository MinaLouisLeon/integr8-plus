-- Removes the hr module (see the up file).

drop table if exists
  hr_payroll_lines,
  hr_payroll_runs,
  hr_pay_terms,
  hr_payroll_rule_sets,
  hr_expense_claims,
  expense_reference_counters,
  hr_expense_categories,
  hr_employees
cascade;
drop function if exists assign_expense_reference();
drop function if exists hr_expense_claims_guard();
drop function if exists hr_expense_claims_ledger_capture();
drop function if exists hr_payroll_lines_guard();
drop function if exists hr_payroll_rule_sets_guard();
drop function if exists hr_payroll_runs_guard();
drop function if exists hr_payroll_runs_ledger_capture();
