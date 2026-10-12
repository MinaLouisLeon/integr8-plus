# ADR-0010 — HR, staff expenses and Egyptian payroll

**Status:** Accepted (seventh round planning, 2026-10-12)

## Context

The plan defers ERP-09 (HR, expense management and payroll) and says payroll
must not ship before a country's legal, tax and benefit rules are reviewed.
On 2026-10-12 the product owner authorized ERP-09 with full Egyptian payroll,
and ERP-10 (ADR-0011), and took the decisions below one at a time.

The repository already has members (`tenant_users`), roles, shifts and
timesheets, media storage, the phone's offline outbox, and a general ledger
with automatic postings and an unposted list (ADR-0009). HR builds on these
and never creates a second login.

Integr8 is not a payroll bureau and has had no legal review. Payroll ships
with its figures as data a company confirms before use, and every screen and
payslip says the calculation must be checked by the company's accountant.

## Decision — modules and access

- **Switches:** three new feature flags, all off until Integr8 switches them
  on: `hr` (profiles and expense claims), `payroll` (needs `hr`) and
  `manufacturing` (needs `inventory`; ADR-0011).
- **New roles:** `hr_manager` and `inventory_manager` join owner, admin,
  dispatcher, engineer and viewer. Both rank below admin and above
  dispatcher. An HR manager has HR, expense approval and payroll and nothing
  else; an inventory manager has inventory, purchasing and manufacturing and
  nothing else.
- **Grants:** the same two capabilities can be granted on top of any role
  (for example a dispatcher who also keeps the store). Only the owner gives or
  removes the HR manager role or grant; the owner or an admin gives or
  removes the inventory manager role or grant. Every change is audited and
  shown on the people screen. The new roles take a seat like any member.

| Permission        | Owner | Admin | HR manager (role or grant) | Others           |
| ----------------- | :---: | :---: | :------------------------: | ---------------- |
| `hr.read`         |   ✓   |   ✓   |             ✓              | own profile only |
| `hr.sensitive`    |   ✓   |   —   |             ✓              | own profile only |
| `hr.manage`       |   ✓   |   —   |             ✓              | —                |
| `expense.submit`  |   ✓   |   ✓   |             ✓              | every member     |
| `expense.approve` |   ✓   |   ✓   |             ✓              | —                |
| `payroll.run`     |   ✓   |   —   |             ✓              | —                |
| `payroll.approve` |   ✓   |   —   |             ✓              | —                |

Admins see job details (title, department, dates) but not pay or ID numbers.
Every member sees their own profile, claims and payslips.

## Decision — HR profiles

- An employee profile either links to a member or stands alone for someone
  who never signs in (helpers, drivers); a standalone employee takes no seat.
  When one later gets a seat, the profile is linked to the new member and
  keeps its history.
- It holds: employee number, name (from the member when linked), job title,
  department, hire date, end date and reason, national ID, social insurance
  number, bank name and account (IBAN) for salary, emergency contact, and the
  pay terms used by payroll (ADR below).
- **Encrypted at rest:** national ID, social insurance number and bank
  account are encrypted with AES-256-GCM (the repository's existing sealed
  secret pattern) under a new server key, `HR_DATA_KEY`, required at start-up
  when the `hr` module is used. The last four characters are kept in clear for
  lists. Revealing a full value is audited. Losing the key loses those fields;
  the deployment guide says to keep it with the backups.
- Pay and ID fields are masked in lists; only `hr.sensitive` reads them.

## Decision — staff expense claims

- Any member, engineers included and from the phone offline, submits a
  claim: date, category, amount and currency (the company's), description,
  optional job, and receipt photos through the existing media storage.
- An owner, admin or HR manager approves or rejects it with a reason; nobody
  approves their own claim.
- An approved claim is paid back by cash or bank transfer (recorded), or
  added to the next pay run, which then pays it.
- Categories are a company list, each naming the ledger expense account it
  posts to.

## Decision — payroll (Egypt)

- **Rule sets:** income tax bands, the personal exemption, the high-income
  tiers, social insurance rates and the minimum and maximum insurable wage,
  and the Martyrs' Fund rate live in a rule set with an effective date. A
  company cannot run payroll until an owner confirms a rule set in force,
  recording who checked it. Rules change by adding a new dated set, never by
  editing one that has been used.
- **Seeded 2026 figures** (from secondary sources: payroll firms' guides and
  calculators, not the official text; to be confirmed): annual taxable income
  bands 0–40,000 at 0%, 40,000–55,000 at 10%, 55,000–70,000 at 15%,
  70,000–200,000 at 20%, 200,000–400,000 at 22.5%, 400,000–1,200,000 at 25%,
  above 1,200,000 at 27.5%; personal exemption EGP 20,000 a year; above
  EGP 600,000 of annual taxable income the lower bands drop out in steps
  (seeded as tiers: 600,000–700,000, 700,000–800,000, 800,000–900,000,
  900,000–1,200,000, above 1,200,000), as the 2024 amendment (Law 7 of 2024)
  is described; social insurance 11% employee and 18.75% employer on an
  insurable wage between EGP 2,700 and 16,700 a month (Law 148 of 2019, limits
  from January 2026); Martyrs' Fund 0.05% of gross.
- **A pay run** is monthly. For each active employee: basic salary and fixed
  allowances from their pay terms, overtime hours from approved timesheets at
  the employee's overtime rate, one-off bonuses and deductions typed for the
  run, approved expense claims set to be paid through payroll, and unpaid
  leave days deducted at a daily rate. Employee social insurance is taken on
  the insurable wage within the limits; income tax is worked out on the
  annualised taxable pay (gross less employee insurance and the exemption)
  and divided back to the month; the Martyrs' Fund is taken from gross.
  Employer insurance is recorded as a cost, not deducted.
- **Approval:** the person who prepares a run cannot approve it; another HR
  manager or the owner approves. An approved run is final and never changes;
  a mistake is corrected in the next run.
- **Outputs:** printable payslips in Arabic and English, a monthly social
  insurance contributions report, a bank transfer list (CSV, with the CSV
  protections), and one ledger journal per run. All amounts are exact decimal
  strings, never floats.
- **No legal claim:** every payslip and screen says the figures must be
  checked by the company's accountant; Integr8 does not file with the Tax
  Authority or NOSI.

## Decision — the ledger

Expense claims, their payment, pay runs and assembly orders (ADR-0011) join
the automatic posting and unposted list of ADR-0009, each area with its own
switch beside sales and stock. New posting accounts are added to the chart of
companies already set up: staff claims payable, salaries expense, employer
social insurance expense, salaries payable, income tax payable, social
insurance payable, Martyrs' Fund payable, and assembly labour and overhead
absorbed.

- An approved claim: debit its category's expense, credit staff claims
  payable. Paid back: debit staff claims payable, credit cash or bank. Paid
  through payroll: the run clears it.
- A pay run: debit salaries expense (gross) and employer insurance expense;
  credit income tax, social insurance (both shares) and Martyrs' Fund
  payable, staff claims payable cleared by the run, and salaries payable (net).

## Decision — delivery

One branch from `main`, slices pushed as each is done (H1a roles, grants and
profiles; H1b expenses; H1c payroll; M1a bills of materials and assembly; M1b
planning), one pull request against `main`, then stop.

## Consequences

Sensitive data needs a new server key and a backup routine for it. Payroll's
correctness depends on the rule set a company confirms; the seeded figures
are a starting point, not advice. Leave balances, end-of-service
calculations, annual tax settlements and filing with the authorities are left
for later.
