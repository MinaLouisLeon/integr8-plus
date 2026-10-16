# ADR-0002 — OpenAI provider, per-level models and token allowances shared by percentage

| Field   | Value                                                                             |
| ------- | --------------------------------------------------------------------------------- |
| Status  | Accepted                                                                          |
| Date    | 2026-10-15                                                                        |
| Branch  | `feat/openai-provider-token-quotas` from `main` at `e67b718` (PR #95)             |
| Plan    | [`OPENAI_TOKEN_QUOTAS_PLAN.md`](./OPENAI_TOKEN_QUOTAS_PLAN.md) (15 Oct 2026)      |
| Tracker | [`OPENAI_TOKEN_QUOTAS_STATUS.md`](./OPENAI_TOKEN_QUOTAS_STATUS.md)                |
| Extends | [`ADR-0001`](./ADR-0001-ai-entitlements-and-tools.md); nothing in it is withdrawn |

## Context

The assistant (ADR-0001) is merged. This round adds OpenAI as a fifth provider,
fixes the model chosen for each level, and adds token allowances on top of the
message and money limits that already exist. The plan in this folder is the
starting point; the product owner's answers of 2026-10-15 change parts of it, and
where they do, this record wins.

## Phase A audit: what the plan says against what `main` holds

Checked on `main` at `e67b718`, which is the plan's `f1121d8` plus PR #95 (one
line in `.gitleaksignore`). Every fact in plan §1 holds:

| Plan claim                                                 | Found                                                                                                                                           |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_PROVIDERS` lacks `openai`                              | Yes: `recording, groq, gemini, anthropic` in `packages/core/src/ai.ts` and `config.ts`.                                                         |
| The chat uses the Help model at every level                | Yes: `apps/api/src/ai/chat.ts` line 129, `config.AI_MODEL_HELP ?? 'recording-help'`.                                                            |
| Message counters only; calls already keep cached/reasoning | Yes: `ai_usage_periods` counts messages; `ai_provider_calls` has `cached_tokens` and `reasoning_tokens` columns, never filled until now.        |
| No token limits, no per-member override                    | Yes. Plan and company policies carry message limits, one shared per-member message default and a company monthly cost cap.                      |
| Next migration                                             | `0046`. `0044` and `0045` are applied and immutable.                                                                                            |
| Membership key for a composite FK                          | `tenant_users` is unique on `(tenant_id, user_id)` (`tenant_users_membership_unique`), so `ai_member_limits` references it as the plan asks.    |
| The prompt is bounded by `maxInputTokens`                  | **No.** The ceiling only bounds the worst-case cost; nothing truncates the prompt. Token holds use the prompt's estimate, not the ceiling.      |
| OpenAI documentation                                       | `platform.openai.com` and `developers.openai.com` are unreachable from the build environment; facts below come from search results citing them. |

What OpenAI's documentation says, as far as it could be confirmed from here:

- `gpt-6-luna` is the API id of GPT-6 Luna, listed at **$0.10** input, **$0.01**
  cached input and **$0.50** output per million tokens (above 272K input tokens
  a request costs more; our ceilings stay far below that).
- Its reasoning effort is configurable, and one listing says tool calling through
  Chat Completions needs effort `none`. The adapter therefore sends
  `reasoning_effort` only when `AI_OPENAI_REASONING_EFFORT` is set, and the
  example configuration sets it to `none`.
- A 429 is either a rate limit or a billing stop. The billing stop carries
  `insufficient_quota` in `error.code` or `error.type`; the documentation also
  lists `credit_balance_exhausted`, `organization_usage_limit_exceeded` and
  `organization_spend_limit_exceeded`. Anything else is a rate limit.

These must be checked against OpenAI's own pages before the key goes live; the
runbook says so.

## Decisions

### D1. OpenAI is one more adapter behind the one switch

`AI_PROVIDER=openai` with `AI_OPENAI_API_KEY`, `AI_OPENAI_BASE_URL` (HTTPS only in
production) and optional `AI_OPENAI_REASONING_EFFORT`. The adapter speaks the
**Chat Completions** API with `fetch`: the same message and tool-call shape the
Groq adapter already maps, stateless, with `max_completion_tokens` (never
`max_tokens`) and no `temperature`. The Responses API would need the model's
reasoning items carried between tool steps, which our provider contract has no
place for. Only the selected provider is built; there is no fallback to another.

### D2. AI configuration never stops the server

The product owner's rule: the server and every app run whatever the AI settings
say. A problem turns the assistant off and is shown on the platform AI screen; it
is never a startup refusal.

| Problem (with `AI_ENABLED=true`)                   | Effect                                                                                 |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| The selected provider's key is missing             | Assistant off everywhere: `provider_unconfigured`                                      |
| `AI_MODEL_HELP` is missing (live provider)         | Assistant off everywhere: `provider_unconfigured`                                      |
| `recording` selected in production                 | Assistant off everywhere: `provider_unconfigured`                                      |
| `AI_OPENAI_BASE_URL` is not HTTPS in production    | Assistant off everywhere: `provider_unconfigured`                                      |
| `AI_MODEL_INSIGHTS` or `AI_MODEL_AGENT` is missing | That level is not served; a company above it gets the highest level whose model is set |

This replaces ADR-0001's fail-fast check at load and the production refusal of
`recording` with `AI_ENABLED`; both now leave the server running.

### D3. Each level runs its own model

Help uses `AI_MODEL_HELP`, Insights `AI_MODEL_INSIGHTS`, Agent `AI_MODEL_AGENT`,
chosen from the member's effective level after every gate. The same model prices
the reservation and is recorded on every call. A missing level model is never
replaced by another level's model (D2 lowers the level instead). The recording
provider answers to `recording-help`, `recording-insights` and `recording-agent`.

### D4. Cached input is priced only when a cached price is configured

Price rows gain an optional `cachedInputPerMillion`. Cost is
`(input − cached) × input + cached × cached + output × output`, rounded up to the
micro, in BigInt. Without a cached price, all input is charged at the input rate.
Reasoning tokens are part of output and never charged twice. Reservations use the
undiscounted worst case. A model with no price row keeps today's behaviour: the
conservative default rates, marked estimated, and now flagged on the platform
provider screen.

### D5. Token allowances, counted per call

Plans and company overrides gain `dailyTokenLimit` and `monthlyTokenLimit`: the
company's pooled total of input plus output tokens per UTC day and month (cached
and reasoning tokens are subsets and never added again). Null on an axis means no
token limit there.

Tokens are reserved **before each model call**, not for the whole message: the
hold is the call's estimated prompt plus the output ceiling, against the
company's and the member's day and month, in one locked order. After the call the
hold becomes the provider's reported total. When the next call would not fit, the
answer stops there: with nothing asked yet the request is refused with a token
quota error; after earlier calls the model is not asked again and the member gets
what was gathered. A timed-out call keeps its hold as used, because it may have
been billed. A hold left by a crashed worker is charged by the reconciler.

### D6. Members get a percentage of the company's allowance

The product owner's model replaces the plan's per-member numeric overrides:

- Each member who may use the assistant has a **percentage** (1–100) of the
  company's allowance, set by the company's Owner or Admin (holders of
  `member.update_role`) or by the platform admin. One percentage covers daily and
  monthly messages and daily and monthly tokens.
- Percentages are **reserved slices**: across a company they total 100% or less,
  checked under a lock when saved.
- A member with **no percentage cannot use the assistant**, whatever the plan's
  shared per-member default says. That default stays stored but no longer decides
  access. Access needs the member's on/off switch on **and** a percentage above 0.
  On the day this ships nobody has a percentage, so the assistant is off for staff
  until one is set.
- A member's limit on an axis is the company's limit on that axis times the
  percentage, rounded down. A company axis with no limit gives the member none
  either. The company's own counters are still checked, so lowering a slice after
  it was used cannot let the company exceed its pool.
- Integr8 staff acting as a company hold no membership row and so no percentage:
  the assistant is not available to them in that seat.

### D7. Dollar amounts stay with the platform

The platform admin alone can set a member's **monthly dollar cap** and sees every
dollar figure. Company Owners and Admins see the company's allowance as a
**percentage remaining** and manage members by percentage; staff see their own
percentage remaining and the reset time. No tenant-facing response carries a
token count, a message count or a dollar figure. A member stopped by their dollar
cap is told their limit is reached and when it resets, without the amount.

### D8. Exhausted OpenAI credit pauses the assistant only

An OpenAI billing stop becomes the provider failure kind `credit_exhausted`,
distinct from `rate_limited`. The call is recorded with that code, the request's
unused reservations are released (earlier successful calls stay charged), the
member sees the generic `ai_provider_unavailable`, and this process asks no model
for `AI_CREDIT_EXHAUSTED_PAUSE_SECONDS` (default 300). The platform health view
counts those failures. Nothing claims to know the real OpenAI balance, there is
no automatic switch to another provider, and every other module keeps working.

## Consequences

- One additive migration (`0046_ai_token_quotas`): token columns on both policy
  tables, `ai_member_limits`, `ai_token_periods`, `ai_member_cost_periods`, and
  token bookkeeping on `ai_message_reservations`.
- The tenant-facing capability and usage responses change shape: message
  counts are replaced by percentages. The web, desktop and mobile clients in this
  repository move with them.
- After deployment, staff need a percentage before the assistant works for them.

## Addendum, 16 October 2026: answers without a model

Decided with the owner on 16 October 2026, after the OpenAI work merged.
Plan and status: [`HELP_LIBRARY_MODE_PLAN.md`](./HELP_LIBRARY_MODE_PLAN.md).

### D9. Each policy says where answers come from

Plan and company policies gain one field, `answerSource`: `model` (the default,
and what every existing policy means) or `library`. Only the platform sets it,
on a plan or on a company's custom policy, with the same audit, version check
and thirty-second refresh as every other policy field. A write that leaves the
field out keeps what is stored, so an older dashboard cannot change it.

### D10. A library answer is the help library itself, with no model

A `library` answer is built in the API from the articles the existing lexical
retrieval finds for the question: the best article's title and summary, the
paragraph of its body that shares most words with the question, and the
articles found as sources with their screen links. No provider is called, so
there are no tokens, no cost, no deployment budget, no company cost cap and no
member dollar cap; the credit pause never applies. The question still counts
against the company's message limits, which are the plan's to set. Library
answers serve Help only: a policy at Insights or Agent with `library` runs at
Help. Members need only their own switch: **no share is required**, because
shares divide something that costs money, and a member's share is ignored
while answers come from the library. Unlimited messages need no cost cap
under `library`, since nothing is spent.

### D11. Model answers fall back to the library rather than fail

A company whose policy says `model` gets library answers whenever the server
cannot give it model answers: no provider (D12), a missing key or Help model,
or the fake provider in production. It then runs at Help, the platform sees
why, and members are not told "temporarily unavailable". While the provider is
paused after a billing stop (D8), every question is answered from the library
with a line saying only the help guide can answer for now; the company keeps
its level, and model answers resume when the pause ends.

### D12. `AI_PROVIDER=none`

A sixth value for a server with no AI provider at all. It is valid in
production and raises no problem; every company is answered from the library
whatever its policy says, and the platform's provider panel says "None (help
library only)". `recording` keeps its production warning: it is a test double,
not a way to run without AI. `AI_ENABLED` remains the switch that shows the
assistant at all.

### Consequences of D9–D12

- One additive migration (`0047_ai_answer_source`): the column on both policy
  tables, defaulting to `model`, and the policy consistency checks relaxed for
  unlimited messages under `library`.
- The capabilities response gains `answerSource`; the platform's effective
  policy says where answers come from and why.
