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
