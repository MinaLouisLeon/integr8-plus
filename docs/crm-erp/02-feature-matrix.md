# 02 — Feature matrix and MVP scope lock

`EXISTING` is already in the product and is reused as is; `EXTEND` is existing
and gains something; `NEW` is built in the named phase; `DEFERRED` and
`NOT AUTHORIZED` are out of this branch.

## MVP scope lock (this branch)

The MVP is **F1 + C1 + C2 + C3**: a company with the CRM switched on can capture
a lead, qualify it, convert it once into an existing or new customer, open an
opportunity, move it through stages to won or lost, log follow-ups, and see it
all on the customer's page. Nothing in the ERP columns below is built here.

| Capability                                  | Status     | Phase | Reuses                                                    |
| ------------------------------------------- | ---------- | ----- | --------------------------------------------------------- |
| Customers, contacts, sites                  | `EXISTING` | —     | `customers`, `customer_contacts`, `sites` (0010)          |
| Work orders, forms, submissions, timesheets | `EXISTING` | —     | Unchanged by the CRM                                      |
| Tenancy, roles, audit log, impersonation    | `EXISTING` | —     | `tenant_users`, `audit_log`, impersonation grants         |
| Feature flags per company                   | `EXTEND`   | F1    | `feature_flags`; adds server-side enforcement             |
| Permission matrix                           | `EXTEND`   | F1    | Adds `crm.*` for all five roles                           |
| Side navigation (web, desktop)              | `EXTEND`   | F1    | Adds a CRM group, gated by permission and feature         |
| Company default currency                    | `EXTEND`   | F1    | `tenant_settings.currency`, default changed to EGP        |
| Leads                                       | `NEW`      | C1    | —                                                         |
| Lead → customer conversion                  | `NEW`      | C2    | Creates through the customers repository, never around it |
| Customer page CRM summary                   | `EXTEND`   | C2/C3 | `CustomerScreen` in `operations-dom`                      |
| Pipelines and stages                        | `NEW`      | C3    | Seeded per company, one default pipeline                  |
| Opportunities and stage history             | `NEW`      | C3    | —                                                         |
| Activities and follow-ups                   | `NEW`      | C3    | Separate from job checklists                              |
| CRM dashboard                               | `NEW`      | C3    | Counts and weighted pipeline, labelled as an estimate     |

## After the MVP

| Capability                               | Status           | Phase                   |
| ---------------------------------------- | ---------------- | ----------------------- |
| Catalogue, units, categories             | `NEW`            | E1                      |
| Stock locations and immutable ledger     | `NEW`            | E1                      |
| Suppliers, purchase orders, receipts     | `NEW`            | E2                      |
| Work-order materials (web/desktop)       | `NEW`            | E2                      |
| Work-order materials from the phone      | `NEW`            | E2, separately approved |
| Quotes and sales orders                  | `NEW`            | S1                      |
| Company invoices, payments, credit notes | `NEW`            | B1                      |
| Job costing                              | `NEW`            | B1                      |
| Asset register and service history       | `NEW`            | E3                      |
| General ledger                           | `NOT AUTHORIZED` | A1                      |
| Campaigns and marketing automation       | `DEFERRED`       | —                       |
| HR, expenses, payroll                    | `DEFERRED`       | —                       |
| Manufacturing                            | `DEFERRED`       | —                       |
