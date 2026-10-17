# Dependencies and licences

PLAN.md §0.5 and §10: before any package is added, record its version, licence,
source and reason here. Paid, enterprise-gated and GPL/AGPL/SSPL packages are not
allowed without explicit approval.

## Added for the CRM and ERP work

| Package          | Version       | Licence                                                                                             | Phase | Reason                                                                                                                                                                  |
| ---------------- | ------------- | --------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `uqr`            | 0.1.3 (exact) | MIT (Project Nayuki, Anthony Fu); no dependencies, no install scripts; licence file read 2026-10-11 | E3    | Encodes the QR code printed on asset tags, in `@integr8/operations-dom`. Pure TypeScript, renders to an SVG the app draws itself; nothing leaves the device             |
| _otherwise none_ |               |                                                                                                     |       | The CRM MVP (F1–C3), the inventory and purchasing round (E1–E2), the sales round (S1) and the finance round (B1) are built with the packages already in the repository. |

Considered in PLAN.md §10.2 and **not installed**: `@tanstack/react-table`,
`recharts`, `decimal.js`, `@react-pdf/renderer`, `xlsx`, `ag-grid-community`,
`date-fns`, `react-hook-form`. Each is re-checked (exact version, licence file,
transitive licences, fonts) only if a later phase needs it. S1 needed neither:
money stays `numeric` in SQL with a BigInt helper for the one addition done in
code, and the quote prints through the browser's own print to PDF (decision,
2026-10-11). B1 needed neither either: invoices print through the browser the same way and
money stays in SQL `numeric`, with BigInt helpers for addition and
multiplication in code. A PDF renderer is re-checked only if a later phase
emails invoices as attachments.

## Added for Egyptian e-invoicing (ADR-0014)

In `@integr8/eta` only. Versions exact; each licence read from the installed
package's own `package.json` and licence file on 2026-10-17; `pnpm licences:check`
passes with their transitive dependencies.

| Package       | Version | Licence      | Reason                                                                                                              |
| ------------- | ------- | ------------ | ------------------------------------------------------------------------------------------------------------------- |
| `pkijs`       | 3.4.1   | BSD-3-Clause | Builds the detached CAdES-BES `SignedData` around the token's signature, and verifies a returned one on the server. |
| `asn1js`      | 3.1.0   | BSD-3-Clause | The DER encoding under `pkijs`: signed attributes, the issuer name taken byte for byte from the certificate.        |
| `ajv`         | 8.20.0  | MIT          | Validates each signed document against the JSON Schema the company fetched from the ETA, before anything is sent.   |
| `ajv-formats` | 3.0.1   | MIT          | The `date-time` and other formats such a schema may use.                                                            |

Considered and **not installed**: a JSON library keeping number lexemes (the
package's own `json-text.ts` does it, so no amount is ever a JavaScript
float), `node-forge` (larger, and `pkijs` already covers CMS), and any PKCS#11
binding (needs the token's model first; PLAN §9).

## Licence audit of the existing direct dependencies

Read on 2026-10-11 from each installed package's own `package.json`
(`license` field), for every `dependencies` and `devDependencies` entry in the
repository root, the four apps and the 13 packages. Transitive packages are not
listed; PLAN.md §10.3 asks for a CI check that covers them (a follow-up in the
[tracker](./README.md#follow-ups-that-must-not-be-lost)).

| Licence           | Count |
| ----------------- | ----- |
| MIT               | 85    |
| Apache-2.0        | 4     |
| Apache-2.0 OR MIT | 2     |
| MIT OR Apache-2.0 | 1     |
| MPL-2.0           | 1     |
| BSD-2-Clause      | 1     |

**Needs a human look:** `axe-core` is **MPL-2.0** (file-level copyleft). It is a
development dependency used only by tests to check accessibility, and it is not
shipped in any app, so it creates no obligation for the product. Nothing is GPL,
AGPL, SSPL or proprietary. The desktop app's Rust crates (`tauri`,
`tauri-plugin-updater`, `serde`, `serde_json`, `keyring`) are MIT or
Apache-2.0.

### Every direct dependency

| Package                                  | Version  | Licence           | Kind        | Used in                                                                                                                                                    |
| ---------------------------------------- | -------- | ----------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@aws-sdk/client-s3`                     | 3.1149.0 | Apache-2.0        | runtime     | api                                                                                                                                                        |
| `@aws-sdk/s3-request-presigner`          | 3.1149.0 | Apache-2.0        | runtime     | api                                                                                                                                                        |
| `@commitlint/cli`                        | 21.2.3   | MIT               | dev         | .                                                                                                                                                          |
| `@commitlint/config-conventional`        | 21.2.3   | MIT               | dev         | .                                                                                                                                                          |
| `@dnd-kit/core`                          | 6.3.1    | MIT               | runtime     | desktop                                                                                                                                                    |
| `@dnd-kit/sortable`                      | 10.0.0   | MIT               | runtime     | desktop                                                                                                                                                    |
| `@dnd-kit/utilities`                     | 3.2.2    | MIT               | runtime     | desktop                                                                                                                                                    |
| `@eslint/js`                             | 10.0.1   | MIT               | runtime     | eslint-config                                                                                                                                              |
| `@expo/metro-runtime`                    | 58.0.14  | MIT               | runtime     | mobile                                                                                                                                                     |
| `@react-native-community/datetimepicker` | 9.2.1    | MIT               | runtime     | mobile                                                                                                                                                     |
| `@sentry/nextjs`                         | 11.7.0   | MIT               | runtime     | web                                                                                                                                                        |
| `@sentry/node`                           | 10.74.0  | MIT               | runtime     | api                                                                                                                                                        |
| `@sentry/react`                          | 11.1.0   | MIT               | runtime     | desktop                                                                                                                                                    |
| `@sentry/react-native`                   | 8.28.0   | MIT               | runtime     | mobile                                                                                                                                                     |
| `@tailwindcss/postcss`                   | 4.3.3    | MIT               | dev         | web                                                                                                                                                        |
| `@tailwindcss/vite`                      | 4.3.3    | MIT               | dev         | desktop                                                                                                                                                    |
| `@tanstack/react-query`                  | 5.102.8  | MIT               | runtime+dev | web, desktop, form-renderer-dom, operations-dom                                                                                                            |
| `@tauri-apps/api`                        | 2.12.0   | Apache-2.0 OR MIT | runtime     | desktop                                                                                                                                                    |
| `@tauri-apps/cli`                        | 2.11.4   | Apache-2.0 OR MIT | dev         | desktop                                                                                                                                                    |
| `@tauri-apps/plugin-updater`             | 2.11.0   | MIT OR Apache-2.0 | runtime     | desktop                                                                                                                                                    |
| `@testing-library/dom`                   | 10.4.2   | MIT               | dev         | form-renderer-dom, operations-dom                                                                                                                          |
| `@testing-library/jest-dom`              | 7.0.1    | MIT               | dev         | form-renderer-dom, operations-dom                                                                                                                          |
| `@testing-library/react`                 | 16.3.3   | MIT               | dev         | form-renderer-dom, operations-dom                                                                                                                          |
| `@testing-library/user-event`            | 14.6.7   | MIT               | dev         | form-renderer-dom, operations-dom                                                                                                                          |
| `@types/leaflet`                         | 1.9.22   | MIT               | dev         | operations-dom                                                                                                                                             |
| `@types/node`                            | 26.6.5   | MIT               | dev         | api, web, desktop, mobile, api-client, auth, core, db, form-engine, form-input, form-renderer-dom, i18n, offline, operations-dom, tokens                   |
| `@types/pg`                              | 8.15.6   | MIT               | dev         | db                                                                                                                                                         |
| `@types/react`                           | 19.3.0   | MIT               | dev         | web, desktop, mobile, form-renderer-dom, i18n, operations-dom                                                                                              |
| `@types/react-dom`                       | 19.3.0   | MIT               | dev         | web, desktop, form-renderer-dom, operations-dom                                                                                                            |
| `@vitejs/plugin-react`                   | 6.1.1    | MIT               | dev         | desktop                                                                                                                                                    |
| `@vitest/coverage-v8`                    | 5.0.0    | MIT               | dev         | form-engine                                                                                                                                                |
| `axe-core`                               | 4.14.0   | MPL-2.0           | dev         | form-renderer-dom, operations-dom                                                                                                                          |
| `esbuild`                                | 0.28.2   | MIT               | dev         | form-engine                                                                                                                                                |
| `eslint`                                 | 10.12.0  | MIT               | dev         | ., api, web, desktop, mobile, api-client, auth, core, db, eslint-config, form-engine, form-input, form-renderer-dom, i18n, offline, operations-dom, tokens |
| `eslint-config-prettier`                 | 10.1.8   | MIT               | runtime     | eslint-config                                                                                                                                              |
| `eslint-plugin-jsx-a11y`                 | 6.10.2   | MIT               | runtime     | eslint-config                                                                                                                                              |
| `eslint-plugin-react-hooks`              | 7.1.1    | MIT               | runtime     | eslint-config                                                                                                                                              |
| `expo`                                   | 58.0.14  | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-background-task`                   | 58.0.11  | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-battery`                           | 58.0.3   | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-camera`                            | 58.0.10  | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-constants`                         | 58.0.12  | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-crypto`                            | 58.0.7   | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-device`                            | 58.0.5   | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-document-picker`                   | 58.0.4   | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-file-system`                       | 58.0.9   | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-image-manipulator`                 | 58.0.14  | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-image-picker`                      | 58.0.10  | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-local-authentication`              | 58.0.2   | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-localization`                      | 58.0.4   | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-location`                          | 58.0.17  | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-network`                           | 58.0.3   | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-notifications`                     | 58.1.5   | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-router`                            | 58.0.23  | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-secure-store`                      | 58.0.2   | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-sharing`                           | 58.0.19  | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-sqlite`                            | 58.0.13  | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-status-bar`                        | 58.0.3   | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-task-manager`                      | 58.0.12  | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-updates`                           | 58.0.17  | MIT               | runtime     | mobile                                                                                                                                                     |
| `expo-web-browser`                       | 58.0.6   | MIT               | runtime     | mobile                                                                                                                                                     |
| `fast-check`                             | 4.10.0   | MIT               | dev         | form-engine                                                                                                                                                |
| `fastify`                                | 5.12.3   | MIT               | runtime     | api                                                                                                                                                        |
| `husky`                                  | 9.1.7    | MIT               | dev         | .                                                                                                                                                          |
| `i18next`                                | 26.4.2   | MIT               | runtime     | i18n                                                                                                                                                       |
| `jose`                                   | 6.2.0    | MIT               | runtime     | auth                                                                                                                                                       |
| `jsdom`                                  | 30.0.1   | MIT               | dev         | form-renderer-dom, operations-dom                                                                                                                          |
| `kysely`                                 | 0.28.9   | MIT               | runtime     | db                                                                                                                                                         |
| `leaflet`                                | 1.9.4    | BSD-2-Clause      | runtime     | operations-dom                                                                                                                                             |
| `lint-staged`                            | 17.6.0   | MIT               | dev         | .                                                                                                                                                          |
| `next`                                   | 16.3.4   | MIT               | runtime     | web                                                                                                                                                        |
| `openapi-fetch`                          | 0.17.0   | MIT               | runtime     | api-client                                                                                                                                                 |
| `openapi-typescript`                     | 7.13.0   | MIT               | dev         | api-client                                                                                                                                                 |
| `pg`                                     | 8.16.3   | MIT               | runtime     | db                                                                                                                                                         |
| `prettier`                               | 3.9.9    | MIT               | dev         | .                                                                                                                                                          |
| `react`                                  | 19.3.0   | MIT               | runtime+dev | web, desktop, mobile, form-renderer-dom, i18n, operations-dom                                                                                              |
| `react-dom`                              | 19.3.0   | MIT               | runtime+dev | web, desktop, mobile, form-renderer-dom, operations-dom                                                                                                    |
| `react-i18next`                          | 17.0.13  | MIT               | runtime     | i18n                                                                                                                                                       |
| `react-native`                           | 0.88.0   | MIT               | runtime     | mobile                                                                                                                                                     |
| `react-native-safe-area-context`         | 5.10.1   | MIT               | runtime     | mobile                                                                                                                                                     |
| `react-native-screens`                   | 4.30.0   | MIT               | runtime     | mobile                                                                                                                                                     |
| `react-native-svg`                       | 15.16.0  | MIT               | runtime     | mobile                                                                                                                                                     |
| `react-native-view-shot`                 | 6.1.1    | MIT               | runtime     | mobile                                                                                                                                                     |
| `react-native-webview`                   | 14.0.1   | MIT               | runtime     | mobile                                                                                                                                                     |
| `react-router`                           | 8.3.1    | MIT               | runtime     | desktop                                                                                                                                                    |
| `sharp`                                  | 0.35.4   | Apache-2.0        | runtime     | api                                                                                                                                                        |
| `tailwindcss`                            | 4.3.3    | MIT               | dev         | web, desktop                                                                                                                                               |
| `tsx`                                    | 4.23.13  | MIT               | dev         | api, auth, db, form-engine, tokens                                                                                                                         |
| `turbo`                                  | 2.11.7   | MIT               | dev         | .                                                                                                                                                          |
| `typescript`                             | 6.0.3    | Apache-2.0        | dev         | ., api, web, desktop, mobile, api-client, auth, core, db, form-engine, form-input, form-renderer-dom, i18n, offline, operations-dom, tokens                |
| `typescript-eslint`                      | 8.71.1   | MIT               | runtime     | eslint-config                                                                                                                                              |
| `vite`                                   | 8.2.2    | MIT               | dev         | desktop                                                                                                                                                    |
| `vitest`                                 | 5.0.3    | MIT               | dev         | api, web, desktop, mobile, api-client, auth, core, db, form-engine, form-input, form-renderer-dom, i18n, offline, operations-dom, tokens                   |
| `zod`                                    | 4.6.1    | MIT               | runtime     | api, auth, core, db, form-engine                                                                                                                           |
