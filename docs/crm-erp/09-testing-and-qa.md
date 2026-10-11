# 09 — Testing and QA

Every CRM and ERP phase lands with tests at each layer it touches. Nothing is
marked `DONE` in the [tracker](./README.md#phase-tracker) until these pass
locally and the repository's own checks (`pnpm turbo run typecheck lint test`)
are clean.

## How to run them

| Layer                    | Command                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| Domain rules             | `pnpm --filter @integr8/core test`                                                         |
| Screens (jsdom, axe)     | `pnpm --filter @integr8/operations-dom test`                                               |
| Translation parity       | `pnpm --filter @integr8/i18n test`                                                         |
| Database (real Postgres) | `pnpm --filter @integr8/db test:integration` (needs `DATABASE_URL` and the migrations run) |
| API (real Postgres)      | `pnpm --filter @integr8/api test:integration`                                              |

CI runs the integration suites against a Postgres service container.

## What each phase proves

### F1 — foundation

| File                                                            | Proves                                                                                                                             |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core/src/crm.test.ts`                                 | Lead statuses and transitions, decimal and currency validation, the CRM permission table                                           |
| `packages/core/src/navigation.test.ts`                          | CRM sections appear only with the module and the permission                                                                        |
| `packages/db/src/testing/crm-foundation.integration.test.ts`    | The flag is off by default, EGP default, RLS isolation, cross-company references refused, conversion trigger, money checks, paging |
| `packages/db/src/testing/schema-invariants.integration.test.ts` | Every CRM table has RLS, tenant keys, a vocabulary check, and is declared in `schema.ts`                                           |

### C1 — leads

| File                                                   | Proves                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/api/src/routes/v1/crm-leads.integration.test.ts` | Module gate off and on (`feature_disabled`, `/v1/me`), permission before module, viewer read-only, dispatcher manages, no customer created, audit, idempotency, assignee membership, decimal strings only, currency kept with a value, version conflicts, no shortcut to `converted`, archive and restore, filters and cursor, another company's lead unreachable, switch off again |
| `packages/operations-dom/src/crm/leads.test.tsx`       | List with filters sent to the API, new lead with an idempotency key, read-only seats see no actions, edits send only changed fields with `expectedVersion`, a version conflict offers a reload, converted leads are read-only and link to their customer, no axe violations                                                                                                         |
| `packages/i18n` parity test                            | Every `crm.*` key exists in English and Arabic                                                                                                                                                                                                                                                                                                                                      |

## Manual checks before the pilot (phase L)

- Arabic: open each CRM screen with the language set to Arabic and check the
  layout mirrors, numbers and amounts read correctly, and email and phone stay
  left-to-right.
- Keyboard only: every CRM action reachable and the dialogs trap focus.
- Desktop right-click on lead rows.
