# The AI assistant

A chat panel in the web, desktop and phone apps (`/v1/ai`, `apps/api/src/ai/`).
It answers at one of three **levels**:

| Level    | Answers from                                                                                  |
| -------- | --------------------------------------------------------------------------------------------- |
| Help     | The help library (`@integr8/i18n/help`, also the public Help centre) and the question         |
| Insights | Help, plus read-only figures from the company's records the member may see                    |
| Agent    | Insights, plus actions it **prepares** and the member **confirms** before anything is written |

Answers come either from a model (OpenAI, Anthropic, Gemini or Groq) or from the
**help library with no model**, which needs no key and costs nothing. A missing
key or model never stops the server: companies are answered from the library and
the dashboard's Provider panel says what is missing. A mistyped setting stops the
API at start, naming the line.

## Nothing is on by default

A fresh deployment has `AI_ENABLED=false`, every plan's assistant **Off**, every
company's app switches off, every member switched on and **no member holding a
share**. Turning it on is four steps, each undoable on its own:

1. **The server** (`deploy/.env`, restart API and worker): `AI_ENABLED=true`,
   `AI_PROVIDER` (`openai`, `anthropic`, `gemini`, `groq`; `none` for library
   only; `recording` is the test fake, refused in production), that provider's
   key (`AI_OPENAI_API_KEY`, …), one model per level (`AI_MODEL_HELP`,
   `AI_MODEL_INSIGHTS`, `AI_MODEL_AGENT`), `AI_MODEL_PRICES` (USD micros per
   million tokens) and `AI_GLOBAL_MONTHLY_BUDGET_MICROUSD`, Integr8's own
   monthly ceiling. Each level uses its own model; only the named provider is
   ever called (no fallback). A model without a price row is costed at the
   conservative defaults and flagged. OpenAI reasoning models may need
   `AI_OPENAI_REASONING_EFFORT=none`; Claude 5.x models think by default, so set
   `AI_ANTHROPIC_EFFORT=low` and give the plan room for output tokens.
2. **The plan** (dashboard → Plans → AI assistant, no deploy): level, answers
   from a model or the library, message limits (daily, monthly or both), token
   limits pooled across the company, monthly cost ceiling, retention, token and
   call ceilings. Effective within 30 seconds; audited before and after.
3. **The company**: which apps show it (web, desktop, mobile; at onboarding or on
   the company page, or by the owner in Company settings), switching single
   members off, and optionally a custom policy instead of the plan's.
4. **Each member's share**: a whole percentage of every company allowance,
   reserved for them; shares total 100% or less. Set by owners and admins (People
   on the web, Assistant settings on the desktop) or by Integr8. Needed for model
   answers only. The company sees percentages; tokens and money appear only on
   the dashboard, where Integr8 alone can also set a member's monthly dollar
   cap.

**Turning it off**: a member (switch or share, at once), an app for a company (at
once), a company (custom policy Off) or a plan (level Off) within 30 seconds, or
everything with `AI_ENABLED=false` (403 `ai_disabled`).

## Company data and the provider

Help sends only the question, the last few turns (`AI_HISTORY_TURNS`) and help
text. Insights and Agent also send the company's records, which needs both: the
provider listed for that data class in `AI_PROVIDER_APPROVED_DATA_CLASSES` (for
example `openai:company_operational`, after reading its data terms), and the
company's **Company data may be sent to the AI provider** box ticked (audited).
Until then such a company gets Help answers and a note.

Insight figures are counted and summed in the database over everything the
member may see (`apps/api/src/ai/tools/insights.ts`); a list is short but its
total says how many exist. Agent actions are proposals (`ai_action_proposals`)
the member confirms within `AI_ACTION_TTL_SECONDS`; the action then runs through
the normal routes with the member's own permissions.

## Limits, usage and cost

Every request reserves a slot before calling the provider (per company and
per member concurrency `AI_MAX_CONCURRENT_*`, token and step ceilings
`AI_MAX_*`, timeouts `AI_REQUEST_TIMEOUT_MS`) and settles it after; the worker's
reconciliation frees slots that never settled and expires unconfirmed
proposals. Usage is kept per company, member and period (`ai_usage_periods`,
`ai_token_periods`, `ai_cost_periods`, `ai_member_cost_periods`), every provider
call in `ai_provider_calls` (split by year). When a provider reports its credit
is used up, that API process stops calling it for
`AI_CREDIT_EXHAUSTED_PAUSE_SECONDS` (300), answers from the library meanwhile,
and the Provider panel shows the pause.

## Voice

Nothing to configure. **Speaking a question** is offered to companies answered
by a model (not on the library); **reading answers aloud** to every company, off
until the member turns it on. Only text reaches Integr8: the device's own
recogniser handles the audio (Google on Chrome and Android, Microsoft on Edge and
Windows, Apple on iOS and macOS). The desktop window has no recogniser, so its
button points at the operating system's dictation (Win+H on Windows, the
microphone key on macOS; none on Linux).

## Exports and deletion

A member's conversations, prepared actions and message and token counters are
in the company's export and purged with it; shares and spend are not exported.
Members delete their own conversations at any time; retention deletes older
ones. The provider-call ledger is kept for Integr8's accounting.
