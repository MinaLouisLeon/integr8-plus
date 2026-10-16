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
| B     | Complete | `answerSource` in `@integr8/core`, migration 0047, repositories; `AI_PROVIDER=none`.                                      |
| C     | Complete | Library answers in the chat, the fallback, admission without money or shares, capabilities and the platform's view of it. |
| D     | Complete | Plan and company editors, provider panel, share editors' note, assistant screens, EN/AR, client regeneration, runbook.    |
| E     | Complete | Full checks, commit, push.                                                                                                |

## Verification log

Commands actually run, with their outcome.

| When       | Command                                                                                                                                                                                                                                      | Result                                                                                                   |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 2026-10-16 | `pnpm --filter @integr8/db db up`, then `db down --steps 1` and `db up` on the test database                                                                                                                                                 | 0047 applies, rolls back and applies again; every plan reads `model`                                     |
| 2026-10-16 | `vitest run --project integration` on ai-library, ai-no-provider, ai-chat                                                                                                                                                                    | pass: 21                                                                                                 |
| 2026-10-16 | `pnpm format:check`, `pnpm licences:check`, `pnpm typecheck` (26 tasks), `pnpm lint` (27 tasks), `pnpm test` (26 packages: api 215, operations-dom 272, core 166, desktop 98, mobile 66, web 67, i18n 52, db 38, …), `pnpm build` (15 tasks) | pass                                                                                                     |
| 2026-10-16 | `pnpm --filter @integr8/api openapi && pnpm --filter @integr8/api-client generate`                                                                                                                                                           | no diff                                                                                                  |
| 2026-10-16 | gitleaks 8.24.3 over `origin/main..HEAD`                                                                                                                                                                                                     | no leaks                                                                                                 |
| 2026-10-16 | Integration, one package after another on a freshly created database, as CI runs them                                                                                                                                                        | pass: db 384, auth 72, api 480 + 1 skipped                                                               |
| 2026-10-16 | Live provider call                                                                                                                                                                                                                           | not needed: library answers call none; the model path is unchanged and covered by the recording provider |
