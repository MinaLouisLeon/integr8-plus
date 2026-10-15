# AI assistant — operator runbook

For Integr8's platform administrators and whoever runs the deployment. The
product decisions behind this are in [ADR-0001](./ADR-0001-ai-entitlements-and-tools.md);
what each phase shipped is in [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md).

## 1. What is on by default

Nothing. A fresh deployment has `AI_ENABLED=false`, every plan's assistant
policy at **Off**, no company override, every company's app switches off and
every member switched on. Turning the assistant on is three deliberate steps,
in this order, and each can be undone on its own.

## 2. Turning it on

### Step 1 — the server (a deploy)

In the API's environment (`deploy/.env` on the VPS; see `apps/api/.env.example`):

```dotenv
AI_ENABLED=true
AI_PROVIDER=groq            # or gemini, anthropic; recording is the fake and is refused in production
AI_GROQ_API_KEY=...         # the key for the provider named above, never anything else
AI_MODEL_HELP=...           # the model id exactly as the provider lists it today
AI_GLOBAL_MONTHLY_BUDGET_MICROUSD=5000000   # the whole deployment's monthly ceiling: 5,000,000 = USD 5
```

Optional: `AI_MODEL_PRICES` (prices per million tokens in USD micros, so the
cost figures on the dashboard are real rather than the conservative default),
`AI_PROVIDER_APPROVED_DATA_CLASSES` (only needed for insights and actions, see §6),
and the ceilings `AI_MAX_*`. Restart the API and the worker. A production API
refuses to start with `AI_ENABLED=true` and no key or model for the chosen
provider, so a mistake here is found at deploy time, not by a customer.

The three live providers are interchangeable: change `AI_PROVIDER`, set that
provider's key and model ids, redeploy. Nothing else changes; usage and costs
keep accruing in the same tables.

### Step 2 — the plan (the dashboard, no deploy)

Dashboard → **Plans**. Each plan has an **AI assistant** section. Set:

- **Level**: Help (documentation only), Insights (Help + read-only company
  data), Agent (Insights + prepare-and-confirm actions). This build serves up
  to the level shown at the top of the page; a plan set above it is capped.
- **Quota mode** and the limits it names: daily, monthly, or both, pooled
  across the company. Optional per-member daily and monthly caps that never
  widen the company's.
- **Monthly cost ceiling** in USD: the company's own share of the deployment
  budget. Unlimited messages is only allowed under a cost ceiling.
- **Retention** in days, token and call ceilings, whether history is kept.

Saving takes effect for every company inheriting the plan within thirty
seconds. Every save is in the platform audit log with the values before and
after.

### Step 3 — the company (onboarding or the company page)

Each company says which of its apps show the assistant: web, desktop, mobile.
Chosen at onboarding (all off by default) and changed later on the company's
page under **Website and apps**, or by the company's owner in its own
**Company settings**. A company's owners and admins can also switch individual
members off (and on again) from **People**.

The company's page also has **AI assistant**: inherit the plan (the default)
or set a custom policy, with the same fields as a plan. A custom policy stays
when the plan changes; the page says so. **Reset to plan** returns to
inheriting without touching counters.

## 3. Turning it off

- One member: People → switch them off. Immediate.
- One app for one company: the company's switches. Immediate.
- One company entirely: the company page → custom policy → level Off. Within
  thirty seconds.
- Every company on a plan: the plan's level → Off. Within thirty seconds.
- Everything, now: `AI_ENABLED=false` and restart the API. Every `/v1/ai`
  request answers 403 `ai_disabled`; usage and capabilities reads still work.

## 4. Reading usage and cost

- Company page → **AI assistant** shows today's and this month's messages
  (used and reserved), the next reset in UTC, spend reserved and settled, and
  provider calls with failures.
- `GET /v1/platform/ai/usage?month=YYYY-MM` lists every company that used the
  assistant in a month with its spend, plus the deployment's own budget line.
- `GET /v1/platform/ai/health` shows the last 24 hours of provider calls, the
  failure and rate-limit counts, reservations waiting for the reconciler, and
  the month's budget.

Money is in USD micros everywhere in the API (1,000,000 = USD 1) and shown in
dollars on screens. A cost is an estimate when the model was not in
`AI_MODEL_PRICES` or the provider reported no token counts; the screens say so.

## 5. When something goes wrong

| Symptom                                       | Where to look                              | What to do                                                                                                          |
| --------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Members see "not included"                    | capabilities `blockedBy`                   | `global_off` → §2 step 1; `plan_off`/`custom_off` → step 2; `channel_off` → company switches; `member_off` → People |
| Every answer is 503 `ai_provider_unavailable` | API log `ai.request.failed`, health screen | Key or model wrong, or the provider is rate-limiting (`rate_limited`). Fix the env, or wait out `retry-after`.      |
| 503 `ai_budget_unavailable`                   | health → budget                            | The deployment's month is spent. Raise `AI_GLOBAL_MONTHLY_BUDGET_MICROUSD` and restart, or wait for the month.      |
| Counters look stuck (reserved > 0)            | health → stale reservations                | The worker's reconciler settles them after `AI_RESERVATION_TTL_SECONDS`; check the worker is running.               |
| A company's spend is unexpectedly high        | usage report, `ai_provider_calls`          | Lower the company's cost ceiling or message limits; check `AI_MODEL_PRICES` matches the provider's current rates.   |

The worker's maintenance tick runs the reconciler every `MEDIA_MAINTENANCE_INTERVAL_SECONDS`
and the retention sweep once a day (`scheduled_task_runs.task = 'ai.retention'`).

## 6. Company data and the provider

Help answers only ever send the member's question, the last few turns and the
curated help text to the provider. Insights and actions would also send the
company's own records. That needs two approvals, both off by default:

1. The provider is listed for that data class in
   `AI_PROVIDER_APPROVED_DATA_CLASSES` (for example `groq:company_operational`),
   after its data-handling terms have been read for the plan you are on. Free
   tiers often allow training on submitted data; check before listing.
2. The company's page has **Company data may be sent to the AI provider**
   ticked, which is recorded in the audit log.

Until both are true, a company on Insights or Agent gets Help answers and a
note saying company data is not enabled.

## 7. Exports and deletion

A member's conversations, the actions prepared for them and the usage
counters are part of the company's export, and are purged with the company.
The provider-call ledger is kept for the platform's own accounting. Members can
delete their own conversations at any time; the retention sweep removes the
rest after the policy's retention window.

## 8. The help library

The assistant answers from `apps/api/src/ai/help/articles.ts`, in English and
Arabic. Editing an article and deploying re-seeds it by content hash on API
start; an article removed from the file is disabled, never cited again. No
company data is ever indexed.
