# ADR-0001 — Subscription-controlled AI assistant: entitlements, metering and tools

| Field   | Value                                                                                    |
| ------- | ---------------------------------------------------------------------------------------- |
| Status  | Accepted                                                                                 |
| Date    | 2026-10-15                                                                               |
| Branch  | `feat/ai-assistant-entitlements` from `main` at `8ee0499`                                |
| Plan    | [`INTEGR8_AI_IMPLEMENTATION_PLAN.md`](./INTEGR8_AI_IMPLEMENTATION_PLAN.md) (15 Oct 2026) |
| Tracker | [`IMPLEMENTATION_STATUS.md`](./IMPLEMENTATION_STATUS.md)                                 |

## Context

Integr8 Plus gets an assistant in three cumulative levels — **L1 Help** (bilingual
product guidance), **L2 Insights** (read-only, permission-scoped company data) and
**L3 Agent** (prepare → preview → confirm → execute a few low-risk actions) — whose
availability and limits are decided by Integr8's platform administrators per
subscription plan and, optionally, per company. Everything is **off by default**.

The plan in this folder is the source of truth. This record captures the decisions
that the code relies on, the points where the repository differs from the plan, and
the product-owner answers taken on 2026-10-15.

## Phase A audit: repository facts the plan depends on

| Item                            | Found                                                                                                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default branch / base commit    | `main` at `8ee0499` (PR #88). Branch `feat/ai-assistant-entitlements` created from it.                                                                                        |
| Next migration                  | `0044` (`0043_opportunity_amounts` is the last). Naming `NNNN_name.{up,down}.sql`; RLS policy `tenant_id = app_current_tenant_id()`; grants to `integr8_app` only.            |
| Plans                           | `TENANT_PLANS = ['trial','starter','standard','enterprise']` in `packages/db/src/schema.ts`. Not renamed.                                                                     |
| Billing mode                    | `BILLING_MODES = ['self_serve','invoiced']` on `tenants.billing_mode`. AI policy never reads it.                                                                              |
| Suspension / read-only          | `apps/api/src/http/suspension.ts`: 423 `tenant_suspended` refuses everything; 402 `tenant_read_only` refuses every non-GET unless the route sets `allowedWhenReadOnly`.       |
| Plan entitlements pattern       | `plan_allowances` row cached per plan (`media/quota.ts`, `billing/entitlements.ts`), edited by `PATCH /v1/platform/plans/:plan`.                                              |
| Module flags                    | `MODULE_FEATURES` in `packages/core/src/crm.ts`; `assertFeatureEnabled` / `isFeatureEnabled` in `http/features.ts` with a 30 s cache.                                         |
| Permissions                     | `PERMISSIONS`, `holds(seat, permission)`, custom roles and grants in `packages/core/src/permissions.ts`. Routes declare `permission` / `anyPermission` / `feature`.           |
| Request pipeline                | `apps/api/src/server.ts`: auth → servable → writable → permission → feature → tenant rate limit → idempotency (`http/idempotency.ts`, per-tenant `idempotency_keys`).         |
| Typed routes / OpenAPI / client | `defineRoute` in `http/routes.ts`; `pnpm --filter @integr8/api openapi` then `@integr8/api-client generate` + `build`.                                                        |
| Provider adapters               | `GEOCODER=fake                                                                                                                                                                | mapbox`, `PUSH_SENDER=recording | expo`, `BILLING_PROVIDER=recording | stripe`, `EMAIL_SENDER=recording | resend`, each with production fail-fast checks. |
| Background jobs                 | `jobs/worker.ts` + `jobs/handlers.ts`; queues enqueued through `tx.jobs.enqueue`; one tenant transaction per job.                                                             |
| Platform audit                  | `recordPlatformAction(context, …)` → append-only `platform_audit_log`. Company audit: `tx.auditLog.append`.                                                                   |
| Tenant lifecycle                | Export reads `EXPORTED_TABLES` (`repositories/tenant-data-export.ts`); purge is `purge_tenant()` in SQL. New AI tables are added to both.                                     |
| Error codes                     | Registry generated by `pnpm --filter @integr8/api error-codes`; EN/AR messages in `packages/i18n/src/messages/api-errors.{en,ar}.ts`; parity test forbids plural-suffix keys. |
| i18n                            | `packages/i18n/src/messages/{en,ar}.ts`, one catalogue in two languages, parity-tested. Namespaces `ai.*` and `platform.ai.*` are new.                                        |
| Licence policy                  | `scripts/licences/check.mjs` permissive allow-list. No AI SDK is added: provider adapters use `fetch`.                                                                        |
| Existing AI code / deps         | None. `docs/ai/` did not exist.                                                                                                                                               |

### Differences from the plan, and what was done about them

1. **Providers.** The plan names `recording`, `groq` and an optional `gemini`. The
   owner asked for Groq first (free plan) **and** ready-to-switch adapters for Gemini
   and Claude Haiku, chosen from `.env` later on price. `AI_PROVIDER` is therefore
   `recording | groq | gemini | anthropic`; each live adapter is a thin `fetch`
   client over the vendor's HTTP API, and production refuses a live provider
   whose key is unset.
2. **Company-side switches.** The plan's gates are platform-only. The owner added two
   company-side gates: per-channel toggles (web, desktop, mobile) chosen at
   onboarding and editable later, and per-member enablement by the company's
   admins. Both can only _narrow_ what the platform granted.
3. **Branch name.** This session's designated branch was already merged; the plan's
   `feat/ai-assistant-entitlements` is used, from `main`.
4. **PLAN.md §10.1** ("no usage-billed AI APIs required") is honoured: AI is off by
   default, the recording provider needs no account, and no paid dependency is added.
5. **ADR numbering.** `docs/crm-erp/decisions` already reaches ADR-0013; this folder
   starts its own series at 0001 as the plan asks.

## Decisions

### D1. Gate order (all must pass; fail closed)

```
AI_ENABLED (env kill switch)
  → plan policy  ai_plan_policies[tenant.plan]        (missing row ⇒ off)
  → company override  ai_tenant_policies (mode custom ⇒ replaces the plan policy entirely)
  → company channel toggle  tenant_settings.ai_{web,desktop,mobile}_enabled  (x-client-app header)
  → member switch  tenant_users.ai_enabled
  → tenant servable (423) and, for POST, writable (402) — the existing pipeline
  → seat permission + module flag + object visibility, per tool (L2/L3)
  → provider data-class approval, per tool (L2/L3)
```

- The tenant comes only from the verified principal.
- `custom` is a complete snapshot: every field explicit, nothing inherits. "Reset to
  plan" switches to `inherit` without touching counters.
- Resolved policy is cached 30 s per tenant, like suspension and features, and
  invalidated on every platform write. Quota admission never uses the cache.
- No separate `ai` module flag. The entitlement tables are the only truth.
- L2 and L3 are blocked server-side until their phase gates pass, whatever the
  configured level (`AI_MAX_LEVEL_SERVED`, set by the code, not by operators).

### D2. Periods and charging

- Periods are UTC calendar days and months, keyed by `period_start_utc`.
- One **durably stored assistant answer** = one message unit. A request that fails
  before the answer commits releases its reservation; a lost connection after the
  commit still counts. A retry of the same `Idempotency-Key` by the same user never
  counts twice (`ai_message_reservations` unique on `(tenant_id, user_id,
client_request_id)`); a replay while reserved answers 409 `ai_request_in_progress`;
  a completed one replays the stored answer; a different fingerprint answers 409.
- Counters: `ai_usage_periods(tenant|user, day|month)` locked in a fixed order
  (tenant-day, tenant-month, user-day, user-month) in one transaction;
  `used + reserved + 1 <= limit` or reject all. All four counters are always
  reserved, limited or not, so usage is known and a later policy change settles
  against the same rows; the reservation row records the periods it holds.
- No rollover, refill, overage or packs. A cap change applies to current usage.
- Confirming an L3 proposal is not a second message; it is an action execution.

### D3. Cost

- Money is integer **USD micros** (`bigint`). Never floats.
- Two-stage reservation: platform month budget (`AI_GLOBAL_MONTHLY_BUDGET_MICROUSD`,
  platform-only table `ai_platform_cost_periods`) first, then the tenant month budget
  (`ai_cost_periods`); a tenant refusal releases the global reservation.
- Worst case reserved = `max_provider_calls × (max_input_tokens × in_price +
max_output_tokens × out_price)`; settled from reported usage, or a conservative
  estimate flagged `tokens_estimated` when the provider reports none.
- Prices come from `AI_MODEL_PRICES` (JSON in server config, versioned by hash);
  unknown models use `AI_DEFAULT_PRICE_*` and are flagged estimated.
- Transactions commit before any provider call. Nothing holds a connection while
  waiting on a model.
- Stale `reserved` reservations are recovered by a worker (`ai.reconcile`) that is
  idempotent across instances; uncertain ones are settled as used only when an
  answer was stored.

### D4. Action confirmation boundary (L3)

- The model may only call `prepare_*` tools. A prepare creates a frozen
  `ai_action_proposals` row (payload, digest, resource versions, 5-minute TTL).
- Only `POST /v1/ai/actions/:id/confirm` from the **same user and tenant**, with an
  `Idempotency-Key`, executes it. Entitlement, role, grants, custom role, module,
  object visibility and resource versions are rechecked **at execution**.
- Execution goes through the existing domain code (customers, work orders, CRM
  activities, opportunity stage) inside the normal tenant transaction, with the
  user as the audit actor and `source: 'ai_assistant'` provenance. State moves by
  compare-and-swap; a duplicate confirm replays the stored result (409
  `ai_action_already_executed`).
- First four actions only: create customer, create work order, create CRM activity,
  move an opportunity's stage. No money, posting, payroll, deletion, PO approval or
  admin changes. No two-party approval in V1 (dangerous actions are excluded instead).

### D5. Provider data classes

- Tools carry `dataClass`: `public_help`, `company_operational`,
  `company_financial`, `restricted_personal`.
- `public_help` may go to any configured provider. The three company classes go to a
  provider only when the **tenant policy** says `company_data_to_provider = true`
  (platform-only write, default false) **and** the provider is listed in
  `AI_PROVIDER_APPROVED_DATA_CLASSES`. Otherwise L2/L3 tools are not offered and the
  user is told the company has not approved it.
- `restricted_personal` is not served in V1 by any tool.
- Secrets live only in server config; never logged, never in responses, never in
  stored messages.

### D6. Owner decisions taken on 2026-10-15

| Question                              | Decision                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Branch                                | `feat/ai-assistant-entitlements` from `origin/main`; one PR at the end.                         |
| Live providers                        | Groq first; Gemini and Claude Haiku adapters implemented and selectable by `.env`.              |
| Clients                               | Web, desktop and mobile (online-only), each behind a company channel toggle set at onboarding.  |
| Per-member enablement                 | Company admins choose which accounts have AI; editable in the web settings and the desktop app. |
| L1 while read-only (past due)         | Blocked (POST), as the pipeline already does; usage/capabilities GET still served.              |
| Company data to a provider            | Off until the platform admin enables it per company.                                            |
| AI as an entitlement                  | Included in the plan; no surcharges, no Stripe changes.                                         |
| Owners reading members' conversations | No.                                                                                             |
| Two-party approval for L3             | Not in V1.                                                                                      |
| AI form generator                     | Out of scope.                                                                                   |

### D7. Defaults the plan left to the implementer

- Per-member `ai_enabled` defaults to **true** for new and existing members: the
  platform level, plan policy and channel toggles are already off, so a fourth
  default-off gate would only make enablement a four-step chore. Admins turn
  individuals off.
- Channel toggles default to **false** at onboarding (the form shows the three
  boxes); the owner/admin may change them later (`tenant.update`).
- Help articles are seeded from a checked-in bilingual manifest
  (`apps/api/src/ai/help/articles/*.json`) and re-seeded idempotently by content hash
  at API start; no vector service.
- Retrieval is lexical: normalised tokens (Arabic alef/yaa/taa-marbuta variants,
  diacritics, tatweel removed; English lower-cased) with a BM25-style score over a
  `tsvector`-free in-process index built from the table. Top 5 passages.
- V1 answers are plain JSON (no streaming).

## Consequences

- Operators can enable AI per plan and per company from the dashboard without a
  deploy; every change is audited with before/after values.
- A company never pays, nor is Integr8 charged, for an answer that was not stored.
- Adding a provider is one adapter file and one `AI_PROVIDER` value.
- The L2/L3 surfaces stay dark until their phase gates in the status tracker read
  "Complete"; configuring a level above what the code serves is harmless.
