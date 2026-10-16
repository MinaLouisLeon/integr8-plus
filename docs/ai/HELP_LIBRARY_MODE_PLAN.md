# Answers without a model — plan and status

Decided with the owner on 16 October 2026. Decisions: ADR-0002 D9–D12
([`ADR-0002-openai-and-token-allowances.md`](./ADR-0002-openai-and-token-allowances.md#addendum-16-october-2026-answers-without-a-model)).

## What the owner asked for

The assistant can run with an AI model or without one, and the platform admin
chooses per company. Without a model, answers come from the help library the
assistant already searches. A server can run with no AI provider at all.

## Agreed design

1. A policy field **Answers come from**: `model` or `library`, on plans and on a
   company's custom policy. Platform-set; companies see the effect only.
2. **Library answers** for Help: the best article's title, summary and most
   relevant paragraph, with the articles found as sources linking to their
   screens. Insights and Agent are not available from the library.
3. **Fallback always on**: a `model` company gets library answers when the
   provider is unconfigured, `none`, or paused after a billing stop.
4. **Shares not required** for library answers; only the member's own switch.
5. Library answers use **no tokens, no money**, ignore every cost cap and the
   credit pause, and **count against the company's message limits**.
6. **`AI_PROVIDER=none`**: no AI provider; valid in production; every company
   answered from the library. `recording` keeps its production warning.
7. No new secrets or environment lines for a library-only deployment.

Later, if wanted: a menu of fixed Insights questions as buttons in library mode.

## Phases

| Phase | Status   | What it covers                                                                                                            |
| ----- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| A     | Complete | This plan; ADR-0002 D9–D12.                                                                                               |
| B     | Pending  | `answerSource` in `@integr8/core`, migration 0047, repositories; `AI_PROVIDER=none`.                                      |
| C     | Pending  | Library answers in the chat, the fallback, admission without money or shares, capabilities and the platform's view of it. |
| D     | Pending  | Plan and company editors, provider panel, share editors' note, assistant screens, EN/AR, client regeneration, runbook.    |
| E     | Pending  | Full checks, commit, push.                                                                                                |

## Verification log

Commands actually run, with their outcome.

| When | Command | Result |
| ---- | ------- | ------ |
