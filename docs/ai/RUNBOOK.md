# AI assistant — operator runbook

For Integr8's platform administrators and whoever runs the deployment. The
product decisions behind this are in [ADR-0001](./ADR-0001-ai-entitlements-and-tools.md)
and, for OpenAI, token allowances and members' shares,
[ADR-0002](./ADR-0002-openai-and-token-allowances.md); what each phase shipped
is in [IMPLEMENTATION_STATUS.md](./IMPLEMENTATION_STATUS.md) and
[OPENAI_TOKEN_QUOTAS_STATUS.md](./OPENAI_TOKEN_QUOTAS_STATUS.md).

## 1. What is on by default

Nothing. A fresh deployment has `AI_ENABLED=false`, every plan's assistant
policy at **Off**, no company override, every company's app switches off,
every member switched on and **no member holding a share** of their company's
allowance. Turning the assistant on is four deliberate steps, in this order,
and each can be undone on its own.

A missing AI key or model never stops the server or any other part of the
product: companies are answered from the help library instead (§2.2), and the
platform's AI **Provider** panel and the API's startup log say exactly what is
missing. A mistyped value (a provider name that does not exist, a price list
that is not valid JSON) does stop the API at startup, and its log names the
line.

## 2. Turning it on

### Step 1 — the server (a deploy)

In the API's environment (`deploy/.env` on the VPS; see `apps/api/.env.example`):

```dotenv
AI_ENABLED=true
AI_PROVIDER=openai          # or groq, gemini, anthropic; recording is the fake, switched off in production
AI_OPENAI_API_KEY=...       # from your secret manager; the key for the provider named above, never anything else
AI_OPENAI_REASONING_EFFORT=none   # OpenAI only; see §2.1
AI_MODEL_HELP=gpt-6-luna    # one model per level, exactly as the provider lists it today
AI_MODEL_INSIGHTS=gpt-6-luna
AI_MODEL_AGENT=gpt-6-luna
AI_MODEL_PRICES=[{"provider":"openai","model":"gpt-6-luna","inputPerMillion":100000,"cachedInputPerMillion":10000,"outputPerMillion":500000}]
AI_GLOBAL_MONTHLY_BUDGET_MICROUSD=5000000   # Integr8's own monthly ceiling for the deployment: 5,000,000 = USD 5
```

Restart the API and the worker. What happens with a setting missing:

| Missing                                                  | Effect                                                                          |
| -------------------------------------------------------- | ------------------------------------------------------------------------------- |
| The selected provider's key, or `AI_MODEL_HELP`          | No model answers anywhere; every company gets help-library answers, at Help     |
| `AI_MODEL_INSIGHTS` or `AI_MODEL_AGENT`                  | That level is not served; companies above it get the highest level with a model |
| `recording` in production, or a non-HTTPS OpenAI address | No model answers anywhere; every company gets help-library answers, at Help     |
| A price row for a model                                  | Costed at the conservative default rates, marked estimated, flagged on Provider |

Each level runs its own model; one level never borrows another's. The live
providers are interchangeable: change `AI_PROVIDER`, set that provider's key
and model ids, restart. Only the provider named is ever called: there is no
fallback to another one when it fails or runs out of credit. Usage and costs
keep accruing in the same tables.

`AI_PROVIDER=none` is no provider at all, on purpose: see §2.2.

`AI_PROVIDER_APPROVED_DATA_CLASSES` is only needed for insights and actions
(§6); the ceilings `AI_MAX_*` rarely need changing.

#### 2.1 OpenAI

1. In the OpenAI platform: create a project API key for this deployment, buy
   prepaid credit, and set the project's own usage limits and billing alerts.
   Integr8 cannot read the balance; OpenAI's alerts are how you hear it is low.
2. Check the model list and pricing pages for the exact model id, whether it
   supports tool calling through Chat Completions, and the current input,
   cached-input and output prices. Put the prices in `AI_MODEL_PRICES` in USD
   micros per million tokens. The figures above ($0.10 / $0.01 / $0.50 per
   million for GPT-6 Luna) were taken from search results citing OpenAI on
   15 October 2026, not from OpenAI's site, which the build environment could
   not reach: confirm them before going live.
3. `AI_OPENAI_REASONING_EFFORT`: GPT-6 Luna is a reasoning model, and tool
   calling through Chat Completions is reported to need `none`. Leave it unset
   for a model that does not reason, which refuses the parameter.
4. Keep `AI_OPENAI_BASE_URL` at `https://api.openai.com/v1` unless you route
   through your own HTTPS proxy.
5. Smoke test with one company: give one member a share, ask a Help question,
   an Insights question (`How many open jobs?`) and an Agent request
   (`Add a customer called Test Ltd`, then confirm). The company's members
   panel on the dashboard should show the tokens and spend.

**When the prepaid credit runs out**, OpenAI refuses calls with a billing code
(`insufficient_quota` and its relatives), which the assistant tells apart from
a rate limit. That API process stops calling OpenAI for
`AI_CREDIT_EXHAUSTED_PAUSE_SECONDS` (default 300), the Provider panel shows
the pause, and the log says `ai.provider.credit_exhausted`. The question that
met the billing stop is answered "temporarily unavailable" and charged
nothing; until the pause ends, every question is answered from the help
library with a first line saying only the help guide can answer for now
(§2.2). Those library answers count as messages but use no tokens and no
money. Nothing else in the product is affected. Top the credit up; the next
call after the pause, or a restart, resumes model answers.

`AI_GLOBAL_MONTHLY_BUDGET_MICROUSD` is Integr8's own ceiling, computed from
the configured prices: it is not the OpenAI balance, and either can run out
first.

#### 2.1a Anthropic (Claude)

The adapter sends no sampling parameter, so the current Claude models
(`claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`) and the older
ones (`claude-haiku-4-5`, `claude-sonnet-4-6`) all work. The 5.x models think
by default, and their thinking counts against the policy's **Max output
tokens**: set `AI_ANTHROPIC_EFFORT=low` and give the plan room, for example
1,500 output tokens. Leave the effort unset for Claude Haiku 4.5, which refuses
it. A turn that asked for tools is sent back exactly as Claude returned it,
thinking blocks included, which the API requires. Check the model ids and the
prices on Anthropic's own pages before writing `AI_MODEL_PRICES`.

#### 2.2 Without AI: the help library

The assistant can answer with no model at all (ADR-0002 D9–D12). A **library
answer** is the help article that best matches the question: its title, its
summary and the paragraph closest to the question, with up to three articles
as sources linking to their screens. It is not a conversation and it cannot
read company records or prepare changes, so it serves **Help only**.

Library answers call no provider and use **no tokens and no money**: no
deployment budget, no company cost cap, no member dollar cap, no credit
pause. They **need no share** — a member with their switch on can ask — and
they **count against the company's message limits**, which the plan sets.
Unlimited messages need no cost cap under the library.

They come about three ways:

1. **By policy**, per plan or per company: **Answers come from** → **The help
   library (no AI)** (step 2, step 3). The company runs at Help whatever its
   level says. Integr8 decides; the company sees the effect, not the switch.
2. **By server**: `AI_ENABLED=true` with `AI_PROVIDER=none` and no key, no
   model, no price list, no budget. Every company is answered from the
   library whatever its policy says. The Provider panel says "None (help
   library only)" and lists nothing to fix.
3. **As a fallback**: a company on model answers gets library answers when
   the server cannot give it model answers (no key or Help model, the fake
   provider in production), and while the provider is paused after a billing
   stop (§2.1). The company page's **AI assistant** panel shows "Answers come
   from now" and why.

### Step 2 — the plan (the dashboard, no deploy)

Dashboard → **Plans**. Each plan has an **AI assistant** section. Set:

- **Level**: Help (documentation only), Insights (Help + read-only company
  data), Agent (Insights + prepare-and-confirm actions). This build serves up
  to the level shown at the top of the page; a plan set above it is capped.
- **Answers come from**: an AI model (the default), or the help library with
  no AI (§2.2). Under the library the token limits, cost cap and model
  ceilings are hidden and do not apply; they are kept for when answers come
  from a model again.
- **Quota mode** and the message limits it names: daily, monthly, or both,
  pooled across the company.
- **Daily and monthly token limits**: input plus output tokens, pooled across
  the company. Empty means no token limit on that axis. Cached and reasoning
  tokens are part of these totals, never counted again.
- Members no longer have a per-member default: each gets a percentage of
  these allowances (step 4).
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

### Step 4 — each member's share (the company, or the dashboard)

A member uses the assistant only with their switch on **and a share**: a whole
percentage of every company allowance (messages and tokens, day and month),
reserved for them. A company's shares total 100% or less. The company's
owners and admins set them under **People** (web) or **Assistant settings**
(desktop); Integr8 can set them on the company page's **Members** panel.
Example: a company with 500,000 tokens a month gives one engineer 10%, so
they have 50,000 a month, and the company's other members cannot use those.

Shares matter for **model answers only**. A company answered from the help
library needs none (§2.2); its share editor says so, and any shares already
set are kept for when it moves to model answers.

**After this release is deployed, nobody has a share**, so the assistant is
off for every member until shares are set. Tell your companies before you
deploy, or set shares for them from the dashboard.

The company sees percentages only: how much of its allowance is left and how
much is assigned. A member sees their own percentage left and when it resets.
Token counts, message counts and money appear only on the dashboard.

On the same **Members** panel Integr8 alone can set a member's **monthly
dollar cap**. It is never shown to the company; a member who reaches it is
told their allowance is used up and when it resets.

## 3. Turning it off

- One member: People → switch them off, or remove their share. Immediate.
- One app for one company: the company's switches. Immediate.
- One company entirely: the company page → custom policy → level Off. Within
  thirty seconds.
- Every company on a plan: the plan's level → Off. Within thirty seconds.
- Everything, now: `AI_ENABLED=false` and restart the API. Every `/v1/ai`
  request answers 403 `ai_disabled`; usage and capabilities reads still work.

## 4. Reading usage and cost

- Company page → **AI assistant** shows today's and this month's messages
  and tokens (used and reserved), how much of the allowance is assigned to
  members, the next reset in UTC, spend reserved and settled, and provider
  calls with failures. **Members** shows each member's share, messages, tokens
  and spend this month, and their dollar cap.
- Tokens are held before each model call (the prompt's estimate plus the
  output ceiling) and settled to what the provider reported. An answer stops
  before a call that would not fit; a question whose first call would not fit
  is refused before any model is asked. A timed-out call keeps its hold as
  used, because it may have been billed.
- `GET /v1/platform/ai/usage?month=YYYY-MM` lists every company that used the
  assistant in a month with its spend, plus the deployment's own budget line.
- `GET /v1/platform/ai/health` shows the last 24 hours of provider calls, the
  failure and rate-limit counts, reservations waiting for the reconciler, and
  the month's budget.

Money is in USD micros everywhere in the API (1,000,000 = USD 1) and shown in
dollars on screens. A cost is an estimate when the model was not in
`AI_MODEL_PRICES` or the provider reported no token counts; the screens say so.

## 5. When something goes wrong

| Symptom                                       | Where to look                                       | What to do                                                                                                                                                                                         |
| --------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Members see "not included"                    | capabilities `blockedBy`                            | `global_off` → §2 step 1; `plan_off`/`custom_off` → step 2; `channel_off` → company switches; `member_off` → People; `no_share` → step 4                                                           |
| Members see "temporarily unavailable"         | API log `ai.request.failed`                         | The provider refused the call that was being answered. The next questions get help-library answers while a billing pause lasts (§2.1).                                                             |
| Answers are help articles, not conversation   | Company page → AI assistant → Answers come from now | `policy`: the plan or company says library; `no_provider`: `AI_PROVIDER=none`; `provider_unconfigured`: a key or model is missing, or the fake provider in production (Provider panel `problems`). |
| Every answer is 503 `ai_provider_unavailable` | API log `ai.request.failed`, health screen          | Key or model wrong, or the provider is rate-limiting (`rate_limited`). Fix the env, or wait out `retry-after`.                                                                                     |
| Log says `ai.provider.credit_exhausted`       | Provider panel credit pause                         | The provider account's prepaid credit is spent (§2.1). Top it up; calls resume after the pause or a restart.                                                                                       |
| Members told their allowance is used up       | Members panel, company usage                        | `ai_*_token_quota_exceeded`: the company's or the member's token share is spent; raise the limit or the share. `ai_member_budget_exceeded`: the member's dollar cap.                               |
| 503 `ai_budget_unavailable`                   | health → budget                                     | The deployment's month is spent. Raise `AI_GLOBAL_MONTHLY_BUDGET_MICROUSD` and restart, or wait for the month.                                                                                     |
| Counters look stuck (reserved > 0)            | health → stale reservations                         | The worker's reconciler settles them after `AI_RESERVATION_TTL_SECONDS`; check the worker is running.                                                                                              |
| A company's spend is unexpectedly high        | usage report, `ai_provider_calls`                   | Lower the company's cost ceiling or message limits; check `AI_MODEL_PRICES` matches the provider's current rates.                                                                                  |

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

**The figures are exact.** Every count and total an insight tool returns is
counted and summed in the database over all the company's records the member may
see (`apps/api/src/ai/tools/insights.ts`): unpaid and overdue invoices and what
is owed per currency (partly paid invoices included), the customers owing most
and the overdue invoices longest past due (`receivablesSummary`), customers and
assets by status, the open pipeline per stage, items below their reorder level.
Until 2026-10-31 some were worked out from a page of rows: the newest hundred
invoices, at most two hundred customers or assets, five hundred opportunities.
A list is still short; the total beside it (`customersOwing`, `overdue`,
`totalMatches`, `totalWarrantyEndingSoon`, `totalBelowMinimum`) says how many
exist, and the system prompt tells the model to say so ("the 10 oldest of 37").

## 7. Exports and deletion

A member's conversations, the actions prepared for them and the message and
token counters are part of the company's export, and are purged with the
company. Members' shares and spend are not exported, because those rows carry
the dollar figures the company is never shown.
The provider-call ledger is kept for the platform's own accounting. Members can
delete their own conversations at any time; the retention sweep removes the
rest after the policy's retention window.

## 8. The help library

The assistant answers from `apps/api/src/ai/help/articles.ts`, in English and
Arabic. Editing an article and deploying re-seeds it by content hash on API
start; an article removed from the file is disabled, never cited again. No
company data is ever indexed.

## 9. Voice

Voice needs nothing on the server: no environment variable, no migration, no
setting on a plan or a company (ADR-0002 D13–D14).

- **Speaking a question** is offered to members of a company whose answers come
  from a model. A company on the help library has no microphone button.
- **Reading answers aloud** is offered to every company. It is off until the
  member turns it on; a banner on their first visit says so.
- **Where the audio goes.** Only text reaches Integr8 Plus. The spoken audio is
  handled by the device's own recogniser: Google on Chrome and Android,
  Microsoft on Edge and Windows dictation, Apple on iOS, Safari and macOS
  dictation. Chrome 139 and later keeps recognition on the device for the
  languages it has a model for. Tell a company that asks.
- **Desktop app.** Its web view has no recogniser, so the button points at the
  operating system's dictation: **Win+H** on Windows, the **microphone key** (or
  fn twice) on macOS. Linux has none and shows no microphone. Arabic dictation on
  Windows needs the Arabic language pack installed.
- **Phone.** The first tap asks for the microphone and, on iOS, speech
  recognition. A phone must run a build that includes the feature: rebuild and
  reinstall each company's phone app (setup checklist, Stage 8).

**Checking it by hand** (CI uses fake recognisers and voices, so no automated
test hears a real microphone). On a company answered by a model:

1. Website in Chrome: tap **Speak your question**, say a question, see the words
   appear in the box, send. Block the microphone in the address bar and see the
   message that says so.
2. Website in Firefox: no microphone button, the text box works.
3. Desktop app on Windows and on a Mac: **Speak your question** focuses the box
   and shows the key to press; the key types what you say.
4. Phone: allow the permissions, speak, see the words, send. Repeat in Arabic.
5. Every app: turn **Read answers aloud** on, ask, hear the answer; mute and see
   it stop; reopen the screen and see the choice kept.
6. A library company: no microphone, but **Read answers aloud** works.

## 10. Rolling back

- **The provider**: set `AI_PROVIDER` back (for example to `groq`) with that
  provider's key and models, and restart the API and the worker. Nothing else
  changes.
- **The code**: deploy the previous release. Leave migration 0046 applied: its
  tables and columns are additive, the previous release ignores them, and
  rolling it back would lose the token accounting and every member's share.
  `0046_ai_token_quotas.down.sql` exists for development databases only.
  The same goes for 0047 (where answers come from): the previous release
  ignores the column, and every policy keeps its meaning.
- **No AI at all**: `AI_PROVIDER=none` and restart; companies keep a working
  assistant on the help library while you sort the provider out.
- **Voice**: nothing to undo on the server. Deploying the previous release
  removes the buttons; the stored choice on each device is ignored.
