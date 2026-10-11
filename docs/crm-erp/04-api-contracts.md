# 04 — API contracts

CRM and ERP routes, as built. The OpenAPI document (`apps/api/openapi.json`,
emitted by `pnpm --filter @integr8/api openapi`) is the contract; the generated
client (`packages/api-client/src/generated/schema.ts`) follows it. This page says
what each route is for and what it promises beyond its schema.

Common to every CRM route:

- Signed in (`security: 'authenticated'`), a permission (see
  [05](./05-permissions-and-security.md)), and the `crm` module on
  (`feature: 'crm'`). In that order: a seat without the permission gets 403
  `forbidden` even when the module is off; a seat with it gets 403
  `feature_disabled` while the module is off.
- Errors use the platform shape `{ error: { code, message, details, requestId } }`.
- Money is a decimal **string** (`"1250.5"`), at most 16 digits before the point
  and 4 after. A JSON number is refused (422), so nothing rounds an amount
  through a float. Amounts come back without trailing zeros (`"99.9900"` →
  `"99.99"`).
- Lists are newest first, paged with an opaque `cursor` and `nextCursor`
  (keyset, never offset), `limit` 1–100 (default 50).
- Every change writes an audit entry; when Integr8 staff act as the company,
  the entry's metadata carries `impersonatedBy`.

## Leads (phase C1)

Source: `apps/api/src/routes/v1/crm.ts`. Tests:
`apps/api/src/routes/v1/crm-leads.integration.test.ts`.

| Method and path                | Permission        | What it does                                                   |
| ------------------------------ | ----------------- | -------------------------------------------------------------- |
| `GET /v1/crm/leads`            | `crm.read`        | List, filter and page leads                                    |
| `POST /v1/crm/leads`           | `crm.lead.manage` | Add a lead (`Idempotency-Key` honoured)                        |
| `GET /v1/crm/leads/{leadId}`   | `crm.read`        | One lead, with `can: { edit, convert }` for the seat           |
| `PATCH /v1/crm/leads/{leadId}` | `crm.lead.manage` | Change, assign, qualify, archive or restore, against a version |

### List filters

| Query             | Meaning                                                        |
| ----------------- | -------------------------------------------------------------- |
| `q`               | Words in the name, company, email or phone (case-insensitive)  |
| `status`          | One or more statuses (repeat the parameter)                    |
| `source`          | One or more sources                                            |
| `assignedTo`      | A member's id, `me` (the caller) or `none` (unassigned)        |
| `includeArchived` | `true` to include archived leads; they are left out by default |
| `cursor`, `limit` | Paging                                                         |

### Rules the routes enforce

| Rule                                                                                    | Refusal                        |
| --------------------------------------------------------------------------------------- | ------------------------------ |
| `converted` is reached only by converting (C2), never by create or edit                 | 422 (schema)                   |
| A converted lead keeps its details; only notes, the assignee and archiving change       | 409 `lead_already_converted`   |
| Open statuses (`new`, `contacted`, `qualified`, `unqualified`) move freely between them | 422 `invalid_transition` other |
| The assignee must be an active member of the company                                    | 422 `assignee_not_member`      |
| An edit names the `expectedVersion` it read; a newer version wins                       | 409 `version_conflict`         |
| A value always has a currency: the company's (EGP by default) when none is given        | —                              |
| A lead in another company does not exist                                                | 404 `not_found`                |
| Unknown fields in an edit                                                               | 422 (strict schema)            |

Creating a lead never creates a customer (ADR-0002).

### Audit actions

`crm_lead.created`, `crm_lead.updated` (with the changed field names and the
new version), `crm_lead.status_changed` (from, to), `crm_lead.archived`,
`crm_lead.restored`. Resource type `crm_lead`.
