# OpenAI provider and token allowances — implementation status

Branch `feat/openai-provider-token-quotas` from `main` at `e67b718`. Plan:
[`OPENAI_TOKEN_QUOTAS_PLAN.md`](./OPENAI_TOKEN_QUOTAS_PLAN.md). Decisions:
[`ADR-0002`](./ADR-0002-openai-and-token-allowances.md).

| Phase | Status      | What it covers                                                                                                            | Tests run |
| ----- | ----------- | ------------------------------------------------------------------------------------------------------------------------- | --------- |
| A     | Complete    | Re-audit of `main`, ADR-0002, this tracker, the plan saved. No code.                                                      | none      |
| B     | Not started | OpenAI adapter, per-level models, cached-input pricing, credit-exhausted vs rate-limited, AI config never blocks startup. | —         |
| C     | Not started | Migration 0046, token counters, member percentages, member dollar ledger, per-call token holds, reconciler, routes.       | —         |
| D     | Not started | Platform, company, staff and assistant screens; EN/AR; client regeneration; runbook.                                      | —         |
| E     | Not started | Full checks, push, PR.                                                                                                    | —         |

## Verification log

Commands actually run, with their outcome. "Not run" means not run.

| When       | Command                            | Result |
| ---------- | ---------------------------------- | ------ |
| 2026-10-15 | (Phase A) none: documentation only | —      |
