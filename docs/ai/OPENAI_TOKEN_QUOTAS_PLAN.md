# Integr8 Plus — OpenAI Provider Integration and Company/Staff Token Quotas

**Execution specification for Claude Code Cloud**  
**Prepared:** 15 October 2026  
**Repository:** `https://github.com/MinaLouisLeon/integr8-plus`  
**Verified source branch:** `main` at `f1121d87acb80edc87210557a1e7d3e0e7ecb862` (merge PR #94)  
**Proposed Claude implementation branch:** `feat/openai-provider-token-quotas`  
**Status:** Instructions only; this file is not a merged repository change.

> **Critical:** The entire previous AI Assistant plan has already been implemented and merged into `main`. Do NOT reimplement the Help/Insights/Agent architecture. Begin by pulling the **latest** `main`, checking whether anything changed after the SHA above, and extend the existing production code incrementally. Preserve all existing providers, routes, tenant RLS/security, subscriptions, UX, and migrations. Create a fresh feature branch and a PR; do not merge it yourself.

---

## 0. Master instruction to Claude Code

You are working as the lead TypeScript/Fastify/PostgreSQL engineer in **Integr8 Plus**, a commercial, multi-tenant SaaS with Next.js web, Tauri desktop, Expo mobile, Fastify API, Kysely-backed PostgreSQL, shared core/i18n/operations packages, generated OpenAPI client, and rigorously enforced tenant RLS.

**Implement exactly these outcomes:**

1. Add **OpenAI** as a first-class **fifth** AI provider alongside `recording`, `groq`, `gemini`, and `anthropic` (the latter supports Claude Haiku), selected by **one** `AI_PROVIDER` setting in the server `.env`. Only the selected provider may be invoked for a request. Never auto-switch providers after a billing, timeout, or rate-limit failure.
2. Keep all three existing access levels **Help**, **Insights**, and **Agent** and their permission/tool/confirmation flows. The provider must support the existing text and function-tool contract, Arabic and English, and safe failure behavior.
3. Add **enforceable daily and monthly total-token allowances** for each company and for each staff member, while preserving the current message quotas and global/tenant USD caps. Track provider-reported input, output, cached-input, and reasoning-token metadata without counting cached/reasoning tokens twice.
4. Add **per-staff configurable overrides** (not merely one shared `perUserDailyLimit` for everybody) for daily/monthly message and token allowances, and an **optional staff monthly USD cap**. A company owner/admin may assign a specific staff member a different allowance (higher or lower than the shared per-user default) **within the company's actual pooled entitlement**; the staff override can never bypass global/tenant limits or any explicit platform-admin hard cap.
5. Make usage and remaining allowances visible in existing platform/company/staff/assistant UI, in English and Arabic, and expose versioned APIs for them. Keep sensitive spending / cross-person reporting limited to authorized administrators.
6. Distinguish OpenAI **prepaid-credit exhaustion** from temporary rate limiting, authentication errors, and outages. Stop new model calls when exhausted, show a generic localized service-unavailable message, flag platform health, and do **not** charge a successful message quota unit for a request that produced no answer. Do not claim to know the actual OpenAI prepaid balance unless a documented authenticated provider endpoint really supports it.
7. Use the current shared `AI_MODEL_PRICES` / integer-microusd cost framework to account for OpenAI and cached-token discounts, with conservative reservation and auditable reconciliation. A configured application spending ceiling is not the same thing as OpenAI's actual prepaid balance.
8. Fix the currently verified **model-selection defect**: `apps/api/src/ai/chat.ts` uses `config.AI_MODEL_HELP` for every request, including `insights` and `agent`. Choose `AI_MODEL_HELP`, `AI_MODEL_INSIGHTS`, or `AI_MODEL_AGENT` according to the resolved **effective** access level, with explicit validation / a safe non-silent fallback policy. Price and record the model actually called.

**Non-goals:** No new standalone AI microservice, chat UI rewrite, new customer billing product, autonomous destructive tools, multi-provider failover, direct database access from model output, embedding/vector deployment, manual provider balance scraping, or changes to unrelated CRM/ERP modules. Do not implement a new AI framework beside the existing one.

**Licensing:** Existing project checks dependency licenses (`scripts/licences/check.mjs`). Prefer the existing `fetch` provider-adapter approach; if an SDK is truly needed, verify its license and run `pnpm licences:check`. The provider API itself is usage-billed, even if software dependencies are free.

**Delivery:** Implement in phases A–E below. Run relevant checks after each phase. Produce a PR with migration notes, test evidence, example `.env` config, a feature demo description, and a rollout/rollback plan. If a blocking product decision is needed, ask a precise question before implementing it; otherwise use the explicit defaults here.

---

## 1. Current main-branch code: verified facts, not assumptions

The following locations were inspected on `main` at the SHA above. Check them again before editing; do not assume the old `feat/ai-assistant-entitlements` branch is still the correct base.

| Concern                             | Existing implementation and change target                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AI state & feature levels           | `packages/core/src/ai.ts`: `AI_LEVELS`, `AI_QUOTA_MODES`, `AI_PROVIDERS = ['recording','groq','gemini','anthropic']`, `aiPolicySchema`                                         |
| Server environment                  | `apps/api/src/config.ts`: `AI_ENABLED`, `AI_PROVIDER`, provider keys/base URLs, `AI_MODEL_HELP/INSIGHTS/AGENT`, `aiProblems`, production safety                                |
| Example environment                 | `apps/api/.env.example`; deployment variables in `deploy/.env.example` and deployment docs as applicable                                                                       |
| Provider contract and HTTP helper   | `apps/api/src/ai/providers/provider.ts`: `AiProvider.generate`, `AiGeneration`, `AiProviderError`, `postJson`, usage fields                                                    |
| Provider switch/data classification | `apps/api/src/ai/providers/index.ts`: `providerStatus`, `approvedDataClasses`, `buildAiProvider`                                                                               |
| Existing provider examples          | `apps/api/src/ai/providers/groq.ts`, `gemini.ts`, `anthropic.ts`, `recording.ts`                                                                                               |
| Orchestration                       | `apps/api/src/ai/chat.ts`: admission, tool-loop, `recordProviderCall`, actual-token aggregation, model selection (currently incorrectly Help-only)                             |
| Price calculation                   | `apps/api/src/ai/pricing.ts`: `PriceTable`, integer USD micros, `AI_MODEL_PRICES`, `costOf`, `worstCaseCost`                                                                   |
| Authorization / switches            | `apps/api/src/ai/policy.ts`: global `AI_ENABLED`, plan policy, company override, served-level cap, client app switch, staff member switch                                      |
| Message/cost admission              | `apps/api/src/ai/admission.ts`, `apps/api/src/ai/periods.ts`, `packages/db/src/repositories/ai-usage.ts`, `ai-platform.ts`                                                     |
| Recovery                            | `apps/api/src/ai/reconcile.ts`: stale reservations, uncertain outcomes, retention; worker integration                                                                          |
| Platform endpoints                  | `apps/api/src/routes/v1/platform/ai.ts`: plans, company overrides, provider statuses, usage report/health                                                                      |
| Tenant endpoints                    | `apps/api/src/routes/v1/ai.ts`: capabilities, usage, chat/conversations, agent action confirmation                                                                             |
| Existing member AI toggle           | `PATCH /v1/members/:id/ai` and `tenant_users.ai_enabled`                                                                                                                       |
| Platform UI                         | `apps/web/src/components/ai-policy-editor.tsx`, company detail page, platform plans UI                                                                                         |
| Shared assistant UI                 | `packages/operations-dom/src/ai/assistant-screen.tsx`, `usage-meter.tsx`, and web/desktop/mobile routes                                                                        |
| Translations                        | `packages/i18n/src/messages/{en,ar}.ts`, existing API error catalogs and parity tests                                                                                          |
| Existing schema                     | `packages/db/migrations/0044_ai_assistant.up.sql` (message/cost counters, provider calls, reservations); `0045_ai_retention_grants`                                            |
| Schema guard                        | `packages/db/src/schema.ts` (`Database`, `PLATFORM_TABLES`, exhaustive `TENANT_SCOPED`), `connection.ts` repo interfaces                                                       |
| Architecture / status               | `docs/ai/ADR-0001-ai-entitlements-and-tools.md`, `IMPLEMENTATION_STATUS.md` (A–F complete), `RUNBOOK.md`                                                                       |
| Tests                               | `apps/api/src/ai/chat.test.ts`, `apps/api/src/routes/v1/ai-chat.integration.test.ts`, `ai-actions.integration.test.ts`, `packages/db/src/testing/ai-usage.integration.test.ts` |

**Key gaps confirmed on main:**

- `AI_PROVIDERS` and `AI_PROVIDER` lack `openai`; there is no `openai.ts` provider adapter.
- `ai_usage_periods` holds **used/reserved messages**, not token quotas; `ai_provider_calls` already stores input/output plus optional `cached_tokens` and `reasoning_tokens`.
- `ai_plan_policies` and `ai_tenant_policies` define daily/monthly messages, shared per-user message limits, and a tenant monthly cost cap, but no daily/monthly company/staff total-token limits or per-staff individual override policy.
- The global spending cap exists (`AI_GLOBAL_MONTHLY_BUDGET_MICROUSD`) and is reserved before a call. Preserve it.
- `apps/api/src/ai/chat.ts` selects `AI_MODEL_HELP` even for higher levels. Correct this with regression tests.
- Existing provider HTTP errors currently collapse to general unavailability at the user-facing edge; add a safe, distinguishable OpenAI prepaid-exhausted diagnostic.

---

## 2. Precise product behavior / quota hierarchy

**The platform uses one shared OpenAI API credential per deployment; all companies and staff draw from that provider account.** Integr8, not OpenAI, attributes usage and enforces these nested entitlements:

```text
OpenAI prepaid API credit (externally enforced, not an Integr8 quota)
       |
Integr8 global monthly USD budget, concurrency and request ceilings (.env)
       |
Company subscription plan AI level + pooled message/token/$ quotas
       |
Optional platform-admin company override (inherit | custom)
       |
Company app-channel switch (web | desktop | mobile)
       |
Member enabled switch + role/tool/feature permission
       |
Per-member defaults from plan/company + optional individual staff override
       |
One admitted message -> bounded number of model/tool calls
```

### 2.1 Definitions

- **Message quota** (existing): one completed chat turn, even if it causes several model/tool iterations. Existing daily/monthly company and staff counters remain unchanged.
- **Token quota** (new): **input tokens + output tokens** used by **all provider attempts attributable to a member's request**; counted over the UTC day/month of admission. Count the tokens from every successful model call in a multi-step turn, even if an eventual later call fails. For timeouts/unknown usage, hold or conservatively estimate capacity until reconciled. Never count a cached input token twice: `cachedTokens` is a subset of `inputTokens`, and `reasoningTokens` is normally a subset of `outputTokens`.
- **Cost quota** (extended): platform monthly cap (existing) → tenant monthly cap (existing) → optional **member monthly USD cap** (new). Keep integer **microusd** (`$1 = 1,000,000`) across all ledgers and APIs; display currency only in UI.
- **Daily/monthly periods:** UTC fixed calendar boundaries, matching existing `apps/api/src/ai/periods.ts`. Retain original admission period on a request completed across midnight; never charge twice because of a retry.
- **Per-member defaults:** The existing `perUserDailyLimit` and `perUserMonthlyLimit` are defaults that apply to all staff in a company. A member override replaces only the relevant member axes, not the parent company's pooled quotas or global caps.
- **Null vs zero:** `null` = no additional limit for that axis, bounded still by all parent layers. A configured zero limit is not a useful enabled-policy value; use `ai_enabled=false` for explicit disable. Avoid the ambiguity of silently converting `null` to unlimited access without parent controls.

### 2.2 Example / user story

A Standard company inherits monthly **500,000 total tokens**, daily **35,000 total tokens**, and **2,000 monthly chat messages**. A staff member inherits **50,000 monthly total tokens**, but the company owner sets that specific employee to **10,000 monthly tokens** and **$0.50 monthly spend**. Both the company and employee counters decrement from the same actual model usage. If either the member **or** pooled company token cap is reached, only future AI requests are denied; CRM/ERP and other app services continue working. Increasing a cap changes admission immediately (or within existing policy cache TTL); it does not reset historic usage.

### 2.3 Admin authority

- **Platform admin:** can set plan-wide AI policy and company custom overrides, including token and cost allowances; sees cross-tenant aggregated usage and provider status.
- **Company owner/admin:** can enable the member toggle (existing) and configure **specific members' additional restrictions** where they have the existing relevant membership-management permission. They cannot increase plan/tenant pooled budgets or set a staff limit to a value that bypasses a parent policy. Audit every change.
- **Staff:** can view their own message/token usage and remaining limits. They **cannot** view teammates' conversations, keys, company provider expense figures, or change their own limits.
- **Support impersonation:** keep the existing impersonation restrictions; no new privilege escalation path.

**Policy priority:** Global + tenant limits always win. Member overrides may differ from shared per-member defaults, but their effective limits must still be bounded by pooled company limits. Company admin must not gain the ability to change a platform-admin-configured AI service tier.

---

## 3. OpenAI adapter requirements

### 3.1 Provider/config changes

Extend these existing values (do not introduce a second switch):

- `packages/core/src/ai.ts`: `AI_PROVIDERS` adds `'openai'`; update enum type and tests/schema-invariant assumptions.
- `apps/api/src/config.ts`: `AI_PROVIDER: z.enum(['recording','groq','gemini','anthropic','openai'])`; `AI_OPENAI_API_KEY` optional secret; `AI_OPENAI_BASE_URL` default `https://api.openai.com/v1`, only permit HTTPS in production (never open proxy to an arbitrary untrusted host without explicit operator choice). Respect `AI_ENABLED=false`.
- `apps/api/src/ai/providers/index.ts`: `providerStatus('openai', config)`, `approvedDataClasses` already parses provider IDs generically, `buildAiProvider()` adds `OpenAiProvider`. Only instantiate/use **one selected** provider.
- `apps/api/.env.example`, deployment sample env and `docs/ai/RUNBOOK.md`: add OpenAI setup. Never put a real key into GitHub, Claude chat, frontend build variables, logs, telemetry, generated code, or tests.
- `apps/api/src/config.ts::aiProblems` and `assertProductionReady`: when `AI_ENABLED=true && AI_PROVIDER=openai`, fail startup clearly if the key or required model names are absent. When disabled or another provider is selected, an absent OpenAI key must not stop startup. Preserve `recording` production refusal.
- Existing `GET /v1/platform/ai/providers` must now show OpenAI configuration status and its approved data classes; never return the key.
- Add OpenAI's class opt-in to existing `AI_PROVIDER_APPROVED_DATA_CLASSES`, e.g. `openai:company_operational;company_financial`. Do **not** enable tenant data transfer by default. Existing tenant-level `companyDataToProvider` remains an independent, necessary switch. `restricted_personal` remains excluded by default.

Example `.env` for a deployment (placeholder values, **not a working secret**):

```dotenv
AI_ENABLED=true
AI_PROVIDER=openai
AI_OPENAI_API_KEY=<SET_IN_SERVER_SECRET_MANAGER>
AI_OPENAI_BASE_URL=https://api.openai.com/v1
AI_MODEL_HELP=<VALID_OPENAI_MODEL_ID_WITH_CHAT_SUPPORT>
AI_MODEL_INSIGHTS=<VALID_OPENAI_MODEL_ID_WITH_TOOL_SUPPORT>
AI_MODEL_AGENT=<VALID_OPENAI_MODEL_ID_WITH_TOOL_SUPPORT>
AI_GLOBAL_MONTHLY_BUDGET_MICROUSD=5000000
# Optional explicit approval for company-level data, still gated tenant by tenant:
# AI_PROVIDER_APPROVED_DATA_CLASSES=openai:company_operational;company_financial
# AI_MODEL_PRICES=[{"provider":"openai","model":"MODEL-ID","inputPerMillion":100000,"outputPerMillion":500000}]
```

`AI_GLOBAL_MONTHLY_BUDGET_MICROUSD=5000000` is **$5 per UTC calendar month in Integr8**, NOT a query of a $10 OpenAI prepaid balance and NOT an assertion that OpenAI will stop exactly at $5.

### 3.2 API and model behavior

Implement `apps/api/src/ai/providers/openai.ts` as `OpenAiProvider implements AiProvider` and wire through the existing adapter interface. Choose a **documented model-compatible OpenAI text endpoint** based on current official documentation. The Chat Completions API is already structurally similar to Groq's adapter (roles, `tool_calls`, `tool_call_id`, per-call usage); the Responses API is also permissible if its request/response formats, tool-call/result correlation, stateless history handling, and token details are properly normalized. **Do not copy Groq's `max_tokens` or `temperature: 0.2` blindly**: parameter support varies by OpenAI model. Verify `max_completion_tokens`, supported reasoning settings, and per-model tool-calling support from current model docs before implementing.

Required mapping of `AiGenerateInput` / `AiGeneration`:

1. System instructions are separate from untrusted user/tool content.
2. Preserve existing conversation turns and every assistant tool call's **exact ID** and name. Return tool results with the matching call ID, including multiple calls in one response.
3. Return `text`, `toolRequests`, `providerRequestId`, a normalized `finishReason` (`stop`, `tool`, `length`, `other`), and usage counters.
4. Parse usage from the actual response. Chat Completions typically reports `usage.prompt_tokens`, `completion_tokens`, with `prompt_tokens_details.cached_tokens` and `completion_tokens_details.reasoning_tokens` when available. Responses returns differently named usage fields; normalize them if that API is chosen. Cache and reasoning counts are **subsets**, not extra consumed tokens.
5. If the model returns no usage or malformed optional usage, use a conservative estimate flagged `estimated: true`; do not silently count zero. Do not log prompts, tool outputs, API key, raw customer data, or provider error bodies.
6. Keep timeout, authentication failure, rate-limit, invalid-model, content refusal, and provider outages distinct internally and mapped to safe user-facing error codes. Do not retry paid calls automatically after ambiguous timeout (risk of duplicate charges).
7. Verify real function tool workflow for **Insights** and `prepare_*` actions for **Agent** using mocked fixtures. The existing server authorization, tenant repository access, resource versioning, preview, and explicit confirm route must remain the only paths to changing data.
8. Guard untrusted provider payloads with schemas / safe parsing. Reject invalid tool arguments rather than executing them.
9. No provider SDK is required if native `fetch` already supports the chosen endpoint. Respect `AI_REQUEST_TIMEOUT_MS`, `AI_MAX_PROVIDER_CALLS`, `AI_MAX_TOOL_STEPS`, and model request caps.

**Important existing orchestrator fix:** In `apps/api/src/ai/chat.ts::answerMessage`, model is currently `config.AI_MODEL_HELP ?? 'recording-help'` regardless of level. Switch based on **resolved access.level** after all gates, with a test for each (`help`, `insights`, `agent`). No silent fallback from an unconfigured paid Insights/Agent model to Help. For `recording` tests, preserve explicit deterministic fake IDs. The selected model must flow consistently through both admission/cost reservation and every provider call record.

### 3.3 OpenAI pricing accounting

Keep `PriceTable` and its USD-microusd arithmetic. For each configurable OpenAI model, `AI_MODEL_PRICES` entries reflect verified **current** input and output USD rates **per 1,000,000 tokens**; version each price table. Add an **optional cached-input rate** to the existing schema and calculation, e.g. `cachedInputPerMillion`, without breaking legacy Groq/Gemini/Anthropic entries.

Required calculation (when known and supported):

```text
normal_input_tokens = max(0, input_tokens - cached_input_tokens)
input_charge = normal_input_tokens × input_price_per_million
cached_charge = cached_input_tokens × cached_input_price_per_million
output_charge = output_tokens × output_price_per_million
cost_microusd = ceil((input_charge + cached_charge + output_charge) / 1,000,000)
```

If there is no explicitly configured cached rate, conservatively price **all** input at the normal input rate; do not fabricate a discount. Do not treat reasoning tokens as a separate line item if already included in reported output total. Preserve original API for existing `costOf` call sites where reasonable. Conservatively reserve **un-discounted** worst-case input and full output; a cached discount may be credited when settling known actual usage. Reflect variable model pricing in docs; do not make price claims that Claude cannot verify against official pricing.

Do not silently use a guessed price for a billable production provider if a stricter safety policy is configured. Prefer fail-closed or a clearly flagged conservative default. Ensure all recorded `ai_provider_calls.provider` values include `openai` and existing filters/health/usage reports work without a migration just for the string.

Official references (verify model-specific availability at implementation time):

- https://platform.openai.com/docs/api-reference/chat/create
- https://platform.openai.com/docs/guides/function-calling
- https://platform.openai.com/docs/api-reference/responses/create
- https://platform.openai.com/docs/models
- https://platform.openai.com/pricing
- https://platform.openai.com/docs/guides/error-codes

### 3.4 Prepaid-credit exhaustion

OpenAI can reject calls when API credit is exhausted. Do **not** mistake every HTTP 429 for exhausted credit; it can also mean transient rate limiting. Parse the documented structured error `code/type` safely, mapping `insufficient_quota` (or another verified exhaustion code) to a new internal `quota_exhausted`/`billing_exhausted` failure class, and other 429s to `rate_limited` with a safe Retry-After. Do not rely on matching human-readable text. Avoid returning provider billing details or keys to a tenant.

When exhausted: release the **unused message reservation** (or settle usage already consumed by earlier steps), preserve unknown costs conservatively, show a localized temporary-unavailable message, and log non-sensitive provider status for the platform administrator. Other product modules must keep working. No Groq/Gemini/Anthropic fallback, no silent provider switch, and no auto-purchase/recharge from this feature. The customer should not be told that **their** subscription is exhausted when the shared OpenAI account is out of credit. Keep their message/token caps unchanged.

---

## 4. Database extension (additive migration only)

**Do not edit migrations `0044` or `0045`.** Write the next numbered `.up.sql` and `.down.sql` files following the latest migration present on the actual branch (at review time that would be `0046_ai_token_quotas`). Match schema conventions, scoped grants, composite `(tenant_id, ...)` foreign keys, indexes, row-level security, and rollback safety. Align Kysely definitions and repo surfaces accordingly.

### 4.1 Extend existing plan and tenant policy tables

Add to **both** `ai_plan_policies` and `ai_tenant_policies`:

| Column                         | SQL type      | Behavior                                     |
| ------------------------------ | ------------- | -------------------------------------------- |
| `daily_token_limit`            | `bigint null` | Company pooled total tokens per UTC day      |
| `monthly_token_limit`          | `bigint null` | Company pooled total tokens per UTC month    |
| `per_user_daily_token_limit`   | `bigint null` | Default limit for each staff user, per day   |
| `per_user_monthly_token_limit` | `bigint null` | Default limit for each staff user, per month |

Use `CHECK (>0 OR NULL)`; null is not a configured cap. Retain existing `quota_mode` meaning **message** quota mode; do not silently re-interpret it as token mode. Both token axes are independently optional. Existing data migrates with null token caps, so old tenants retain previous entitlements. Enforce appropriate DB/TS validation for token limits and optional combined policy rules. Never rewrite/clear existing usage on changing a policy.

### 4.2 Per-member custom allowances

Create an **RLS-protected** tenant table, e.g. `ai_member_limits`:

```text
tenant_id uuid NOT NULL
user_id uuid NOT NULL
mode TEXT NOT NULL CHECK (mode IN ('inherit','custom'))
daily_message_limit integer NULL
monthly_message_limit integer NULL
daily_token_limit bigint NULL
monthly_token_limit bigint NULL
monthly_cost_cap_microusd bigint NULL
version integer NOT NULL DEFAULT 1
updated_by uuid NULL
updated_at timestamptz NOT NULL DEFAULT now()
PRIMARY KEY (tenant_id, user_id)
FK (tenant_id, user_id) -> tenant_users (tenant_id, user_id), where compatible
```

The exact member identifier and composite FK must match the real `tenant_users` schema; confirm it rather than assuming. All overrides are **caps**, which may be higher or lower than shared staff defaults, but are always subordinate to the company's pooled entitlement and platform hard ceilings. `mode='inherit'` follows the company's default per-user rules. `mode='custom'` applies only explicitly set override axes; unset axes inherit defaults or remain uncapped as specified by the approved behavior. Never let staff config bypass pooled company caps. Platform admins may set company defaults; company owners/admins may set staff-specific caps under existing membership-management permissions. Use optimistic `expectedVersion`, audit and RLS.

### 4.3 Token counters and reservations

Create `ai_token_periods` with:

- `tenant_id`, `subject_type = 'tenant'|'user'`, `subject_id`, `period_type='day'|'month'`, `period_start_utc`;
- `used_tokens bigint NOT NULL DEFAULT 0`, `reserved_tokens bigint NOT NULL DEFAULT 0`, `updated_at`;
- unique `(tenant_id, subject_type, subject_id, period_type, period_start_utc)`;
- non-negative counters, tenant-specific RLS/grants, safe indexes.

Extend `ai_message_reservations` additively with e.g. `reserved_tokens bigint NOT NULL DEFAULT 0`, `settled_tokens bigint NULL`, and any necessary unknown-token hold or settlement bookkeeping to implement proper recovery. Store the exact UTC day/month at admission (already present). Extend `AiMessageReservation` and repositories. No duplicate provider-call log tables are needed: `ai_provider_calls` already has input/output, cached and reasoning metadata. Aggregate historical usage from `ai_provider_calls` where appropriate, but **do not fabricate historic token allowance consumption** for old periods and overwrite existing cost/message data.

### 4.4 Per-member cost ledger

Create `ai_member_cost_periods` keyed by `(tenant_id, user_id, period_start_utc)` with `reserved_microusd`, `spent_microusd`, `unknown_microusd` and RLS. Reuse the existing `ai_cost_periods` company ledger and `ai_platform_cost_periods` global ledger. Do not duplicate or separately charge provider cost: one provider call contributes once to global, tenant, and attributed member **views** of the same expenditure.

### 4.5 DB/package registration and invariants

Update `packages/db/src/schema.ts` `Database`/new tables and exhaustive `TENANT_SCOPED_TABLES`, `packages/db/src/connection.ts` `TenantTransaction` (add repository or extend `tx.aiUsage`), index/repository exports, tenant export, retention/deletion lifecycle if new data needs cleaning. No raw `pg`/Kysely in `apps/api`: DB access only through `@integr8/db` and `withTenant(...)`. Test RLS negative cases for two companies. Validate migration up/down from fresh DB and upgrade from existing `0045`.

---

## 5. Concurrency-safe enforcement and reconciliation

Extend the existing `admitMessage` → `tx.aiUsage.reserve` → `recordProviderCall` → `settleMessage` flow. Do not add a separate HTTP middleware that races with this ledger.

### 5.1 Token reservation strategy (correctness first)

Token quotas must remain enforced even when multiple chat requests run concurrently and a request makes multiple model calls. The simplest safe first implementation is **whole-message worst-case reservation**:

```text
max_possible_total_tokens = maxProviderCalls × (maxInputTokens + maxOutputTokens)
```

Reserve that many against **company day/month and staff day/month** token limits, in locked deterministic order, before provider calls. Use the **clamped effective policy limits** (`min(server ceiling, plan/company/user restrictions)`), not unchecked client values. At settlement, convert reserved to **actual** observed input+output totals and release unused reservation. For ambiguous failures, retain appropriate conservative unknown capacity until reconciliation. All steps are atomic for tenant/member counters. Separate global budget reservation is already platform-side; maintain existing reserve/release ordering and compensate on failure.

**Usability caveat:** full worst-case reservation can reject requests near a token cap even when a typical answer would fit. If feasible, implement **incremental per-provider-call token reservations** under row locks, granting only the budget needed before each call, stopping model iteration before exceeding remaining quota. Either strategy is acceptable if proven correct; document the chosen behavior. Do **not** use a non-atomic “SELECT used, then UPDATE” check. Do **not** set the reservation to zero before calling the provider merely to avoid over-reserving.

### 5.2 Required scenarios

- Company limit and staff limit checked together; any exhausted axis denies without calling OpenAI.
- Staff-specific override is resolved at admission time; user cannot submit arbitrary `userId`, `tenantId`, tokens or price from UI.
- One customer having five staff members never gets five independent copies of the pooled tenant allowance.
- Reservation released for demonstrably free upstream refusal (invalid key, `insufficient_quota`, validation failure) when no earlier calls consumed tokens; a partial multi-call request charges earlier successful calls even if later calls fail.
- A timed-out call is **uncertain** about billing and tokens; log estimated/unknown holding capacity, don't claim zero usage; recover through existing reconciler while avoiding indefinite permanent holds.
- A call returning provider usage settles actual tokens, cost and cached/reasoning details **once**. Cached input counts toward total tokens but benefits from cached price only when applicable.
- Retry with same idempotency key returns prior answer, or in-progress response, **without a second reservation** or model request.
- Crossing UTC midnight or month's end charges the original admission period. No negative counters.
- Downward quota edits do not erase already used tokens; if current consumption exceeds new cap, future admissions fail until period reset / cap increase.
- Different model prices and multiple tool rounds are included. Provider clock/rounding delays and OpenAI prepaid credit exhaustion can still differ from application cost estimates; explain that in UI/runbook.
- Suspended companies, turned-off member, disabled channel, downgraded plan and revoked tool permissions retain existing server-side restrictions, including **between** AI action preparation and confirmation.

### 5.3 Cost accounting, not double counting

Each provider call is a single cost/token event; aggregate per-message and per-member usage from its provider-call record. Extend `recordProviderCall` with cached/reasoning metadata, and ensure the `reconcile` worker settles tokens as well as messages/cost using idempotent state transitions. Be mindful of the existing crash window: model answer may have been stored before settlement. Reconciliation must charge it once and release leftover token reservations once. Keep the exact `tenant_id` and `user_id` attribution.

---

## 6. APIs and UI: reuse existing routes and screens

### 6.1 Plan and company policies (platform only)

Extend existing response/request schemas for:

- `GET /v1/platform/ai/plans`
- `PUT /v1/platform/ai/plans/:plan`
- `GET /v1/platform/companies/:tenantId/ai`
- `PUT /v1/platform/companies/:tenantId/ai`
- `GET /v1/platform/ai/usage`
- `GET /v1/platform/ai/providers`
- Existing platform health endpoint.

Keep the exact existing route definitions in `apps/api/src/routes/v1/platform/ai.ts` and their `security: 'platform'`, version check, audit, and localized error handling. Add token limits, aggregate token usage, and attribution where authorized. Backward compatibility: clients that send the old plan policy shape should not wipe newly configured fields silently; prefer explicit versioning / preserving values or coordinated client generation so a partial update cannot reset token caps. Do not create a second `/admin/openai` API.

### 6.2 Company member-specific routes

Add a narrowly authorized member limit endpoint (path naming should follow existing members conventions), for example:

```text
GET /v1/members/:id/ai/limits    // owner/admin with relevant membership permission
PUT /v1/members/:id/ai/limits    // set mode and optional message/token/$ cap, expectedVersion
GET /v1/ai/usage                 // current member only, extends existing response
GET /v1/ai/capabilities          // current member only, extends existing response
```

Staff limits must be readable in appropriate authorized membership-management views, but ordinary staff may only read **their own** resolved limits. Never permit a tenant-scoped route to inspect another company's user ID. `PUT` must be audited in the company's existing audit log, and an update should not reset counters.

### 6.3 Client UI

Extend **rather than replace**:

- `apps/web/src/components/ai-policy-editor.tsx`: daily/monthly token fields, shared per-user token defaults, USD cost cap display. Inherit vs custom semantics remain clear.
- `apps/web/src/app/platform/(dashboard)/companies/[tenantId]/page.tsx`: pooled token usage, reserved/used/remaining and monthly cost, with warnings near cap; provider availability remains platform-only.
- Company people/member management screens: individual AI limits editor for each staff user; disabled unless authorized. Show source (“company default” vs “custom”), version conflict, reset to inherit.
- Shared `packages/operations-dom/src/ai/usage-meter.tsx` and assistant screen: my own token daily/monthly remaining, message quotas, reset timestamp and specific reason when denied. Preserve current desktop/mobile layouts and RTL. If native mobile needs a small usage view, use the existing API-client/locale model; no offline token-spending or AI calls.
- `packages/i18n/src/messages/{en,ar}.ts`: complete EN/AR labels, help text, validation and error codes. Keep iconography, navigation and accessibility consistent with the current app. Show exact UTC reset times in user locale, do not mislabel calendar month as provider billing cycle.

Re-run the repository's OpenAPI generation workflow from the declared routes and update `packages/api-client/src/generated/schema.ts` and typed callers; never edit generated schema manually.

### 6.4 New error codes (examples; follow actual error registry)

- `ai_daily_token_quota_exceeded`
- `ai_monthly_token_quota_exceeded`
- `ai_member_budget_exceeded` (safe user-facing message, without exposing the staff USD number if not authorized)
- `ai_provider_credit_exhausted` (platform diagnostic; tenant sees generic temporarily-unavailable)
- `ai_member_limits_changed` for optimistic conflict (or reuse existing `ai_policy_changed` when appropriate)

Preserve existing `ai_daily_quota_exceeded` and `ai_monthly_quota_exceeded` as **message** errors. Error responses should include a reset timestamp when relevant, not another company's usage.

---

## 7. Test plan and acceptance criteria

**Do not rely on paid live API calls in CI.** Mock `fetch`/OpenAI responses; use `recording` provider and existing DB integration harness for quota tests. Add an opt-in manual smoke test using a developer-controlled secret and low limits; never record the key or real company prompts.

### 7.1 Adapter and configuration tests

- `AI_PROVIDER=openai`, valid key and valid model IDs → one `OpenAiProvider` with correct ID/capabilities.
- Selecting Groq/Gemini/Anthropic/recording stays unchanged and does not call OpenAI; missing unused OpenAI key is permitted.
- AI disabled → no live provider call. AI enabled with missing selected key/model → clear startup failure. Production recording-provider refusal preserved.
- OpenAI text-only completion, Arabic UTF-8, context/history, provider request ID, stop/length, empty/refusal, malformed response, timeout, 401/403, 429 temporary rate-limit, 429 insufficient quota, 5xx.
- Function call round trip with **two** tool calls, valid argument JSON, malformed JSON refusal, correct matching IDs, no direct execution bypass of permission/confirm.
- Provider usage parses input/output/cached/reasoning without double count; fallback estimated when absent. Prices: full/cached input, no cached-price row, multiple model rates, rounding and versioning.
- Help, Insights, Agent each use the correct `AI_MODEL_*` and correctly price the actual model. No paid silent fallback.

### 7.2 Quota + tenancy tests (real Postgres)

- Tenant daily/monthly token limits, staff defaults and individual overrides, combined message/token/cost quotas, role gating, zero/invalid values.
- Concurrency: simultaneous requests from two staff in one company may not collectively exceed the pooled token limit. High-contention tests across transactions/processes if feasible.
- Company A's usage and overrides never affect or become readable by Company B; RLS, repository guard and integration isolation tests all pass.
- Idempotent replay and in-progress deduplication: no duplicate spent/reserved tokens/costs/messages/provider calls.
- Tool round trip charges **both/all** model calls. Partial success followed by provider failure retains incurred usage/cost.
- Boundary UTC day/month, stale reservation, crash after stored answer, settlement after midnight, changing limits mid-period, suspension and member AI toggle.
- An exhausted shared OpenAI prepaid key pauses only AI, does not consume a successful answer message, does not silently call Groq, and does not break CRM/ERP.
- Plan or company policy editing generates an audit trail; member custom-limit changes do likewise. Old policy/consumer API behavior remains compatible.
- Migration upgrade/down and schema/RLS invariants; tenant purge/export/retention behavior reviewed for new tables.

### 7.3 UI / localization tests

- Platform plan and company editors show correct effective vs inherited token caps and company usage.
- Company owner/admin edits a specific member; ordinary member cannot. Three separate members can have different quotas.
- Assistant usage display properly handles limited, unlimited-by-axis (`null`), exhausted, reserved, reset time, and denied/disabled conditions.
- English/Arabic translations, RTL, responsive desktop/web/mobile, accessibility labels, form validation, keyboard navigation.

### 7.4 Definition of done

All acceptance scenarios pass. No regression in the original four providers or in existing message/cost limits. Model selection for all three levels fixed. All new tables tenant-scoped, API generated from routes, no secrets in repo/logs/UI, no added paid library dependencies, docs and runbook updated, PR created with test output and staged rollout instructions.

---

## 8. Execution phases for Claude Code

### Phase A — Re-audit latest main (no code yet)

1. Fetch latest `main`, compare to reviewed SHA, inspect all files in section 1 plus `AGENTS.md`, current plan/runbook and integration tests.
2. Create `feat/openai-provider-token-quotas` from **latest main**, never modify main directly. Confirm that migrations 0044/0045 are already applied in source and are immutable.
3. Summarize whether anything in this spec conflicts with current repository behavior, especially the exact membership FK and model API support. Resolve by using the current code as source of truth; ask only if a business decision is genuinely blocked.
4. Add an implementation tracker `docs/ai/OPENAI_TOKEN_QUOTAS_STATUS.md` with Phase A–E and tests.

**Gate:** Verified code map, no feature code written before architecture assessment.

### Phase B — OpenAI provider + correct level-specific models

1. Update core/provider enums, API config validation, provider switch/status, `.env.example` and base URL handling.
2. Implement `OpenAiProvider` with existing function tool and usage contract. Extend normalized optional cached/reasoning metadata if necessary.
3. Fix model mapping for Help/Insights/Agent; handle billed vs transient 429 distinctly, no fallback.
4. Add price configuration/cached input support, provider mocks and regression tests.

**Gate:** All previous providers unchanged, deterministic adapter tests pass, OpenAI visible as configured in platform provider status, correct models used for all levels.

### Phase C — Token/member budget schema and backend enforcement

1. Add **new** reversible migration; Kysely/schema, scoped repos, plan/company token policy fields, per-member overrides, token period counters and per-member cost ledger.
2. Implement atomic capacity reservation, actual token/cost settlement, idempotent replay, uncertain/billed partial calls, reconcile and retention updates.
3. Add narrowly authorized member endpoints and extended platform/tenant usage schemas, audit every policy change.
4. Add concurrency/tenant-isolation/partial-failure tests.

**Gate:** No provider call can bypass pooled company or individual staff quotas; existing message limits remain correct; cross-tenant and concurrency tests green.

### Phase D — Dashboard, assistants and bilingual UX

1. Extend platform plan/company AI settings and reports; member individual AI cap editor; assistant my-usage meter; integrate desktop/mobile as appropriate.
2. Add EN/AR translations and all new error-catalog entries; regenerate OpenAPI client, update UI tests.
3. Update runbook with OpenAI setup, prepaid failure modes, provider switch semantics, token metrics, cached pricing, global vs tenant/member budget distinction, rollback and migration notes.

**Gate:** Admin can configure a specific employee's cap, member can see their own remaining allowance, errors are clear, screen behavior is accessible and RTL-correct.

### Phase E — Verification, PR and delivery

1. Run typecheck, lint, format, license check, unit tests, database migration/integration tests, API and UI test suites. Respect `docs/ai/IMPLEMENTATION_STATUS.md`: root `pnpm test:integration` may collide when DB suites run concurrently; run per package per documented practice.
2. Confirm main is unchanged; write a PR summary with before/after behavior, all touched files, migration/rollback, test failures (if any), and a manual smoke-test procedure.
3. Provide exact environment variables / sample provider model IDs verified as available; identify any manual OpenAI account step (API key/billing) separately from code deployment.
4. Submit PR for user review. **Do not merge or enable OpenAI automatically.**

---

## 9. Rollout instructions and operational safeguards

**Safe rollout sequence:** merge PR after tests → deploy migration/code while `AI_PROVIDER` remains current provider and `AI_ENABLED` unchanged → configure priced OpenAI model IDs + secret in deployment environment → set budget guardrails → switch only `AI_PROVIDER=openai`, restart API/worker → enable for one test tenant through existing plan/company/channel gates → test Help/Insights/Agent and quotas → widen access deliberately.

**Provider rollback:** `AI_PROVIDER=groq` (or previous configured provider) and restart. Do **not** roll back the database migration in a production deployment containing new token usage; leaving unused, additive token columns/tables is safer than losing accounting. Never replace main branch content with the old feature branch.

**OpenAI prepaid credits:** A $10 prepaid purchase is an account-wide external funding balance, not a tenant token pool. It may be exhausted before/after Integr8's monthly estimate, which is based on configured models/prices and reserved/settled usage. Without a documented authorized balance API, do not invent a current balance widget or a perfect provider-side hard stop. Set conservative app limits, maintain provider billing alerts separately, and avoid automatic provider failover/recharge.

**Secrets:** Use server-side platform secrets for `AI_OPENAI_API_KEY`, not `NEXT_PUBLIC_*` or Expo `EXPO_PUBLIC_*`. Do not copy real secrets to GitHub, a PR, logs, monitoring breadcrumbs or example files.

## 10. Claude Code report format

At the end of each phase, report:

```text
Phase: [A/B/C/D/E] — [Complete/Partial/Blocked]
Base branch and base SHA: ...
Commit(s) on implementation branch: ...
Files changed: ...
Behavior implemented: ...
Tests actually run + their result: ...
Known limitations / manual provider verification: ...
Next phase: ...
```

At the very end, provide the PR URL, list of required `.env` values, precise rollout instructions, regression checklist, and all outstanding questions. Never claim a test or OpenAI API call occurred unless it actually ran.

---

## 11. Source of truth, currency and verification

- **Repository facts:** Read from `main` at `f1121d87acb80edc87210557a1e7d3e0e7ecb862`, October 15, 2026. Claude must refresh `main` at task start.
- **Official API surface:** https://platform.openai.com/docs/api-reference/chat/create ; https://platform.openai.com/docs/guides/function-calling ; https://platform.openai.com/docs/api-reference/responses/create
- **Model support / rates:** https://platform.openai.com/docs/models ; https://platform.openai.com/pricing (confirm model ID, service tier, token rates, cache discount and current constraints before configuring live calls).
- **Billing / error handling:** https://platform.openai.com/docs/guides/error-codes

> This document specifies the desired implementation; it does not assert that any code was changed, that provider prepaid credits were purchased, or that a PR was already created.
