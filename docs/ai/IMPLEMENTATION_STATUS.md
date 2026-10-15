# AI assistant — implementation status

Branch `feat/ai-assistant-entitlements` from `main` at `8ee0499`. Plan:
[`INTEGR8_AI_IMPLEMENTATION_PLAN.md`](./INTEGR8_AI_IMPLEMENTATION_PLAN.md).
Decisions: [`ADR-0001`](./ADR-0001-ai-entitlements-and-tools.md).

Levels served by the code (`AI_MAX_LEVEL_SERVED` in `apps/api/src/ai/policy.ts`):
**off** until Phase C passes, then `help`; `insights` after Phase D; `agent` after
Phase E. A plan or company configured above the served level is capped to it.

| Phase | Status      | Commit | What shipped                                                                                                                                                               | Tests run        | Known limitations |
| ----- | ----------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ----------------- |
| A     | Complete    | —      | Repository audit, branch, plan saved, ADR-0001, this tracker. No code changes to existing flows.                                                                           | none (docs only) | —                 |
| B     | Not started | —      | Migration 0044, `@integr8/db` tables and repositories, policy resolver, quota admission, platform routes + UI, tenant usage/capabilities GET.                              | —                | —                 |
| C     | Not started | —      | Help articles, retrieval, providers (recording, groq, gemini, anthropic), L1 chat routes, shared chat UI, web/desktop/mobile pages, onboarding toggles, per-member switch. | —                | —                 |
| D     | Not started | —      | L2 tool registry and the eight read-only tools.                                                                                                                            | —                | —                 |
| E     | Not started | —      | L3 proposals, confirm/reject, four prepare actions.                                                                                                                        | —                | —                 |
| F     | Not started | —      | Reconciliation worker, retention sweep, lifecycle export/purge, runbook, full verification.                                                                                | —                | —                 |

## Verification log

Commands actually run, with their outcome. "Not run" means not run.

| When       | Command                             | Result |
| ---------- | ----------------------------------- | ------ |
| 2026-10-15 | (Phase A) none — documentation only | —      |
