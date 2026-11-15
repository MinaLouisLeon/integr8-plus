# The modules

Field work and forms are always on. Every other module is a **feature flag**,
off by default per company and switched on by Integr8 staff (the onboarding form
or the company page). Some need another (`MODULE_REQUIRES` in
`packages/core/src/crm.ts`): payroll needs HR, manufacturing needs inventory,
e-invoicing needs finance. A module whose base is off counts as off.

A module is enforced in three places: routes that name a `feature` refuse a
company without it (403 `feature_disabled`), menu sections that name it are
hidden, and the phone's buttons follow it. Staff can also hide single menu tabs
per company (`PUT /v1/platform/companies/{id}/tabs`); switching a tab on turns its
module on, and a module with none of its tabs left on is switched off
(`tabChoice` in `@integr8/core`). Data is guarded by modules and permissions,
never by tabs.

| Flag                                                                  | Module                                 | Tables (migration)                  | Routes                                                |
| --------------------------------------------------------------------- | -------------------------------------- | ----------------------------------- | ----------------------------------------------------- |
| (always on)                                                           | Field work                             | `0005_field_work`, `0017_contracts` | `/v1/customers`, `/v1/work-orders`, `/v1/schedule`, … |
| (always on)                                                           | Forms and submissions                  | `0006_forms`                        | `/v1/forms`, `/v1/submissions`                        |
| `documents`                                                           | PDF documents                          | `0006_forms`                        | `/v1/document-templates`, `/v1/documents`             |
| `crm`                                                                 | CRM                                    | `0008_crm`                          | `/v1/crm`, `/v1/analytics`                            |
| `sales`                                                               | Quotes, orders, deliveries             | `0012_sales`                        | `/v1/sales`                                           |
| `finance`                                                             | Invoices, payments, credit notes       | `0013_finance`                      | `/v1/finance`                                         |
| `ledger`                                                              | General ledger                         | `0009_ledger`                       | `/v1/ledger`                                          |
| `inventory`                                                           | Items and stock                        | `0010_inventory`                    | `/v1/inventory`                                       |
| `purchasing`                                                          | Suppliers and purchase orders          | `0011_purchasing`                   | `/v1/purchasing`                                      |
| `assets`                                                              | Customer assets                        | `0014_assets`                       | `/v1/assets`                                          |
| `hr`                                                                  | Employees and expense claims           | `0015_hr`                           | `/v1/hr`, `/v1/expenses`                              |
| `payroll`                                                             | Egyptian payroll                       | `0015_hr`                           | `/v1/payroll`                                         |
| `manufacturing`                                                       | Bills of materials, assembly, planning | `0016_manufacturing`                | `/v1/manufacturing`                                   |
| `e_invoicing`                                                         | Egyptian Tax Authority e-invoicing     | `0018_e_invoicing`                  | `/v1/eta`                                             |
| `website_files`, `website_jobs`, `website_quotes`, `website_invoices` | What a company's website may read      | `0006_forms` (`website_keys`)       | `/v1/website`                                         |

The assistant is not a module flag: it is switched on by plan, company and seat
([ai/](../ai/README.md)).

---

## Field work

**Customers and sites.** Customers with contacts and tags; sites with access
notes (gate codes, hazards) that the crew may correct while on an open job
there. Addresses are geocoded (`GEOCODER`); a site shows its coordinates and a
Google Maps link (there is no map). A customer's timeline gathers jobs, forms,
CRM activity and documents.

**Job types** (staff-managed) set what a job needs: forms, photos before and
after, the customer's sign-off, required qualifications. INSPECT and INSTALL
types require certificates.

**Work orders.** Numbered per company (`assign_work_order_reference()`), with a
crew, a checklist, notes (office-only or visible to the customer), files,
photos, forms and a history (`work_order_events`, split by year). The states:

```
scheduled ─▶ dispatched ─▶ travelling ─▶ on_site ─▶ in_progress ─▶ complete ─▶ reviewed
                                                       ▲   │
                                                       └ awaiting_parts      (any open state → cancelled, with a reason)
```

The transitions live in `@integr8/core` (`WORK_ORDER_TRANSITIONS`) and in the
database (`work_order_transition_allowed`), and the schema-invariant suite
checks both agree. "Office" is `work_order.manage`, "crew" is
`work_order.progress` on an assigned job, sign-off is `work_order.review`. The
database refuses, for every client: a transition not in the table or missing its
reason; dispatching with nobody assigned; **completing while anything is
missing** (a required form, photos, the sign-off), answered 409
`completion_blocked` with one detail per missing thing. Transitions need
`expectedRevision`. A closed job refuses new forms and the office's part
changes; a part the phone recorded before the job closed is accepted and marked
`recordedAfterClose`, and on an invoiced job shows under "Parts not yet billed".

**Lists, saved views, bulk changes**, and **CSV import** of customers, sites and
jobs (`/v1/imports`).

**Visits and the schedule.** A job can take several trips; each is a visit
(`work_order_visits`) with its own time and people. The office plans them on the
desktop app's schedule board (drag and drop); visits close with their job.
Engineers clock in and out (`shifts`); time on a job is measured from its
states (travel, on site, working, waiting for parts; `jobTimes` in
`@integr8/core`), and timesheets add it up.

**Skills and certificates.** A company lists the qualifications it tracks
(skills never expire; certificates may). People hold them with dates, numbers
and scans; a renewal is a new record and the old one stays as history. A job
type lists what its jobs need, and each job copies the list. On each visit at
least one person must hold each requirement, valid on every day of the visit;
otherwise the API answers `visit_unqualified` (`missing`, `expired`,
`expires_before_visit`), and the change goes ahead only when sent again with a
reason, kept in `work_order_qualification_overrides` and the job's history.
The worker warns holders and managers `qualification_warning_days` (30) before
expiry; engineers see theirs on the phone.

**Contracts, maintenance plans, deadlines** (`0017_contracts`). A service
contract says what a customer has bought (sites, assets, job types, a period); a
job is checked against it (`work_order_coverage`). Maintenance plans make jobs
ahead of their due dates, daily, in the company's timezone and working days
(new companies: `Africa/Cairo`, 08:00–17:00, Sunday to Thursday). Deadline rules
give jobs response and fix deadlines counted in working hours; the worker warns
and records misses, and the deadline report lists them.

## Forms and submissions

Staff build forms on the desktop; companies fill them on web, desktop and
phone. Published versions are immutable; submissions are autosaved, checked
again on the server, corrected with a reason and a history, named at submit,
exported, and printed through PDF templates. Form actions make expense claims
and follow-up forms when a form is submitted. Everything is in
[form-engine/](../form-engine/README.md).

## Documents

PDF templates designed per form on the desktop, documents printed from
submissions, branded business PDFs for quotes, invoices, purchase orders and the
job report, uploaded PDFs with typed fields, and sharing by link and QR code
(also on the company's own website). See [documents/](../documents/README.md).

## CRM

Leads (with statuses and conversion into a customer and an opportunity),
pipelines and stages the company configures, opportunities with an amount
history and outcomes, activities and follow-ups linked to leads, customers and
opportunities, the customer 360 view, CRM reports and CSV exports. Domain rules
in `packages/core/src/crm.ts`.

## Sales

Quotes (numbered, printable, sent as a link the customer accepts at `/q/…`
without signing in; "no longer available online" while sales is off), sales
orders with stock reservations, jobs created from or linked to an order, and
deliveries. Numbering by `assign_sales_reference()`.

## Finance

The company's own invoices to its customers (not Integr8's billing), credit
notes, payment receipts with allocations, and job costing (parts at cost plus
hours at the labour cost, against what was invoiced). Lines round half up to
the currency's minor unit (two places for EGP) and a balance under one minor
unit counts as settled; an accountant still has to confirm the rule. A receipt
can be reversed with a reason, and both stay in the history. A company's
currency locks once it has any money record.

## General ledger

A chart of accounts, monthly periods that lock, balanced journals that freeze
once posted (`JV-000001` onwards, numbered when posted), automatic postings from
invoices, payments, credit notes and stock, an opening journal, reports (trial
balance and statements, by line date, bounded only when given), and a year-end
close. A manual journal is posted by someone other than its drafter unless the
company allows self-approval. Journal lines are split by year. A management
tool, not a statutory ledger.

## Inventory and purchasing

Items with categories and pictures, serial and batch tracking (lots), stock
locations including vans and sites, an append-only stock movement ledger (never
negative stock: a use that would go below zero becomes a conflict), counts,
reorder levels and reorder drafts, parts used on jobs and the usage report, van
requests. Purchasing: suppliers and their price lists, purchase orders
(numbered, printable, approved, in the company's currency), goods receipts and
returns, buying on a job.

## Assets

The customer's equipment: register, tags and scanning from the phone (also with
no signal), condition, warranty, service history from jobs, and import. A form
question can carry its answer over from the asset's last visit.

## HR, expenses, payroll

Employee profiles (sensitive fields sealed with `HR_DATA_KEY`; rotation with
`HR_DATA_KEYS_PREVIOUS` and `admin-cli hr-reseal`), expense categories and claims
with receipts (from the phone too), approval with an approved amount and a note
(the ledger, direct payment and payroll use `coalesce(approved_amount, amount)`),
and Egyptian payroll: pay terms, yearly rule sets the owner approves, pay runs
and payslips. A pay run refuses a rule set waiting for approval or from an
earlier year. An accountant has to sign off the figures before real use.

## Manufacturing

Bills of materials, assembly and disassembly orders that move stock, and
material planning that suggests what to buy or build.

## E-invoicing

Egyptian Tax Authority settings, item and unit codes, tax mappings, preparing,
signing and submitting invoices. Test only: nothing has been sent to the real
ETA, and no hardware signer ships yet. See [e-invoicing/](../e-invoicing/README.md).

## Company websites

A company's own website reads what Integr8 allows through `/v1/website`, with a
staff-made website key: the shared-document lookup (one search box, exact match
on key and search fields, up to 10 results), and, per flag, files, jobs, quotes
and invoices. Integr8 Forms for AI helps an AI tool build the website's page
([contributing/developer-tools.md](../contributing/developer-tools.md)).

## The demo company

`node dist/demo/cli.js --owner-email you@example.com` (or `pnpm --filter
@integr8/api demo-company …`) makes one new company with every module on and
realistic data in every section, by booting the API in-process and calling the
real routes as the company's people (plus a staff impersonation for staff-only
set-up), so every side effect is real. Sections are in
`apps/api/src/demo/sections/`, run in the order of `sections/index.ts`, and
share ids through `ctx.refs`. `--only <keys>` runs some sections; `--confirm-production`
is required on staging or production. When a feature adds a screen, add its data
to the matching section.
