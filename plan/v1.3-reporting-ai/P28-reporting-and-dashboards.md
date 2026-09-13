# P28 — Reporting and dashboards

**Version:** v1.3 Reporting, Comms and AI
**Status:** `NOT STARTED`
**Depends on:** P21

## Goal

A company owner opens the product and immediately sees whether their operation is healthy.

## Scope

The renewal argument. Owners who never open the app do not renew.

## Tasks

- [ ] Operations dashboard: open jobs, overdue, completed this week, engineer utilisation, jobs by status
- [ ] Submission reports with filters over reportable form fields, exportable to CSV and Excel
- [ ] Engineer performance: jobs per day, average on-site time, first-time-fix rate
- [ ] SLA compliance by customer and contract
- [ ] Inventory reports: usage, valuation, shrinkage, slow-moving stock
- [ ] Charts with period-over-period comparison
- [ ] Saved views and filters, shared across the team
- [ ] Scheduled reports emailed weekly or monthly
- [ ] Custom report builder across any form field an admin defined

## Exit criteria

- [ ] A report over a year of submissions for the largest tenant returns in under three seconds
- [ ] Every figure on the dashboard can be drilled into down to the individual job
- [ ] A scheduled report arrives on time with correct data for a company in a non-UTC timezone

## Notes

- The custom report builder is the hard one and the reason people stay. It is only
  possible because form definitions are structured data — this is the payoff for P06.
