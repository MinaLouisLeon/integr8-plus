# 03 — Data model

CRM and ERP tables, as built. Each section names the migration that created it.
Every table here is tenant-scoped: `tenant_id` with a foreign key to `tenants`,
row-level security keyed on `app_current_tenant_id()`, `tenant_id` inside every
foreign key to another tenant table, and an entry in `TENANT_SCOPED` in
`packages/db/src/schema.ts`. The schema-invariant suite fails if any of these is
missing.

## 0024 — CRM foundation (phase F1)

### Changes to existing tables

| Change                                                            | Why                                                         |
| ----------------------------------------------------------------- | ----------------------------------------------------------- |
| `feature_flags` row `crm` (`default_enabled = false`)             | The CRM module switch; Integr8 staff turn it on per company |
| `tenant_settings.currency` default `GBP` → `EGP`; every row → EGP | Product decision 2026-10-11; the CRM's default currency     |

The down migration restores the GBP default for new companies but leaves
existing companies on EGP, because their previous value was not recorded.

### `crm_leads`

A prospect that is not a customer yet. Converts once into a `customers` row
(ADR-0002). Archived (`archived_at`), never deleted: the runtime role has no
`delete` grant.

| Column                                                  | Notes                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `display_name`                                          | Required, 1–200 characters                                                      |
| `company_name`, `email`, `phone`                        | Optional; bounded lengths                                                       |
| `source`                                                | `manual`, `referral`, `web`, `import`, `other` (= `LEAD_SOURCES`)               |
| `status`                                                | `new`, `contacted`, `qualified`, `unqualified`, `converted` (= `LEAD_STATUSES`) |
| `assigned_to`                                           | A member: `(tenant_id, assigned_to) → tenant_users (tenant_id, user_id)`        |
| `estimated_value`, `currency_code`                      | `numeric(20,4)` ≥ 0, ISO 4217; a value needs a currency                         |
| `notes`, `unqualified_reason`                           | Free text, bounded                                                              |
| `converted_customer_id`, `converted_contact_id`         | `→ customers`, `→ customer_contacts` of **that** customer (composite keys)      |
| `converted_at`, `converted_by`                          | Set together with the customer; `status = 'converted'` exactly when they are    |
| `version`                                               | Optimistic concurrency; starts at 1                                             |
| `created_by`, `created_at`, `updated_at`, `archived_at` | As elsewhere; `updated_at` by trigger                                           |
| `email_normalized`, `phone_digits`, `search`            | Generated; for suggesting an existing customer and for search                   |

**Rules enforced by the database:**

- `crm_leads_converted_pairing`: converted ⇔ customer and time are set.
- `crm_leads_conversion_final` (trigger): a converted lead's status and
  conversion columns never change. Notes and archiving still can.
- Cross-company conversion is impossible: the customer and contact keys include
  `tenant_id`.

**Indexes:** status and date; assignee and status; normalized email and phone
digits (partial); converted customer (partial); GIN on `search`.

**Tests:** `packages/db/src/testing/crm-foundation.integration.test.ts`, plus the
schema-invariant suite (vocabulary, RLS, tenant keys) and the migration suite
(up, down, up).

### Repository (phase C1)

`CrmLeadsRepository` (`packages/db/src/repositories/crm-leads.ts`), reached as
`tx.crmLeads` inside `withTenant`. Every query filters on the tenant as well as
relying on RLS. `update` takes the expected `version` and returns
`'version_conflict'` instead of overwriting a newer row. `list` orders by
`created_at` truncated to milliseconds, then `id`, so the keyset cursor (which
carries a JavaScript date) never skips or repeats rows created in the same
millisecond. Phase C1 added no migration.

### Conversion (phase C2)

No migration: 0024 already holds the conversion columns, the pairing checks and
the trigger that makes a conversion final. The repository adds:

- `findForUpdate(id)` — `select … for update`, so two conversions of one lead
  run one after the other inside their transactions.
- `markConverted(id, expectedVersion, …)` — one statement that checks the
  version and that the lead is not converted yet, and writes the conversion.
- `customerMatches(lead)` — customers sharing the lead's normalised email,
  phone digits (on the customer or a current contact) or name. Customers have
  no normalised columns, so this compares expressions; fine at today's sizes,
  and an expression index is the follow-up if it is ever slow.
- `convertedInto(customerId)` — for the customer's CRM summary.

## 0025 — pipeline, opportunities and activities (phase C3)

### `crm_pipelines` and `crm_pipeline_stages`

A company's sales pipeline. The default one is made the first time the
company's CRM asks for it (`CrmPipelinesRepository.ensureDefault`), not by the
migration, so new and existing companies get it the same way; a unique index on
the default makes two first requests at once leave one.

| Stage key     | Outcome | Usual chance |
| ------------- | ------- | ------------ |
| `new`         | open    | 10 %         |
| `qualified`   | open    | 25 %         |
| `proposal`    | open    | 50 %         |
| `negotiation` | open    | 75 %         |
| `won`         | won     | 100 %        |
| `lost`        | lost    | 0 %          |

Keys are stable and never reused (unique per pipeline, `^[a-z][a-z0-9_]{0,39}$`);
screens translate the built-in ones (`crm.stage.<key>`). Stages are archived,
not deleted. Chances are whole **basis points** (0–10000), never fractions.
There is no screen for editing pipelines yet (follow-up).

### `crm_opportunities`

| Rule                                                                  | Enforced by                                         |
| --------------------------------------------------------------------- | --------------------------------------------------- |
| For a customer, a lead, or both — never neither                       | `crm_opportunities_has_party`                       |
| Customer, lead, owner and stage are this company's                    | composite tenant foreign keys                       |
| The stage is in the opportunity's own pipeline                        | FK on `(tenant_id, pipeline_id, stage_id)`          |
| `status` is always the stage's outcome                                | trigger `crm_opportunities_check_stage`             |
| Closed exactly when not open; a lost reason only when lost            | `closed_pairing`, `lost_reason` checks              |
| `amount` is `numeric(20,4)`, not negative; `currency_code` always set | checks; read as a decimal string                    |
| `expected_close_date` is a calendar `date`                            | read as `YYYY-MM-DD` text, so no time zone moves it |
| Archived, never deleted; edits name the `version` they read           | no delete grant; `version` column                   |

### `crm_opportunity_events`

Append-only (the runtime role has `select, insert` only): `created`,
`stage_changed`, `won`, `lost`, `reopened`, with from/to stage and status, the
reason for a loss, who and when. Written in the same transaction as the move.

### `crm_activities` and the link tables

`kind` is `call`, `email`, `meeting`, `note`, `follow_up` or `task`; `status` is
`open`, `done` or `cancelled`, and done exactly when `completed_at` and
`completed_by` are set. Links go through `crm_activity_leads`,
`crm_activity_customers` and `crm_activity_opportunities`, each with
same-company foreign keys at both ends, rather than a free-form related id. The
API requires at least one link. Links are written once (no update or delete
grant).

### Repositories

`tx.crmPipelines`, `tx.crmOpportunities` (create, update, `move` with its
history entry, `attachCustomerForLead` for conversion, list, events),
`tx.crmActivities` (create with links, update, list in "due" or "recent" order
with millisecond keyset cursors, counts for the dashboard) and `tx.crmReports`
(the dashboard: sums in SQL as `numeric`, one total per currency, weighted by
`probability_bp / 10000`). "Today" and "overdue" are computed in the company's
time zone (`tenant_settings.timezone`).

### Company data export

All CRM tables (0024 and 0025) are in `EXPORTED_TABLES`
(`packages/db/src/repositories/tenant-data-export.ts`): a company's prospects,
deals and follow-ups are its own data. `crm_leads` was missing from the export
after F1; C3 added it with the rest.
