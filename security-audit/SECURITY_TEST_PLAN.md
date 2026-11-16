# Security test plan — Integr8 Plus

Regression tests to add to the repository. Integration tests (`*.integration.test.ts`) need the disposable Postgres described in CLAUDE.md (`APP_ENV=test`, `INTEGR8_TEST_DATABASE=i-know-this-database-is-disposable`). Existing helpers: the API integration suites boot the server in-process with `FakeIdentityProvider`; `apps/api/src/testing/` builds companies and people.

Tests marked **(new behaviour)** fail today and pass after the matching remediation task; the others pin behaviour verified in source so it cannot regress.

## Tenant isolation and authorization

| ID       | Test                                                                                                                | Where                                                                                           | Expect                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| T-TEN-1  | For every authenticated `GET /…/:id` route, create the record in company B, call as an owner of company A           | new `apps/api/src/routes/v1/tenant-isolation.integration.test.ts`, driven by the route registry | 404 (never 200/403 that reveals existence)                                |
| T-TEN-2  | Same for `PATCH`/`PUT`/`DELETE` and state transitions                                                               | same                                                                                            | 404, and B's row unchanged                                                |
| T-TEN-3  | List/search/export routes in A never contain B's ids (seed both with recognisable names)                            | same                                                                                            | no B ids/names in any response, CSV included                              |
| T-TEN-4  | `/v1/sync/push` with each mutation kind naming B's job/submission/asset ids from A                                  | `sync.integration.test.ts`                                                                      | every mutation `rejected` (`not_found`/`forbidden`), nothing written in B |
| T-TEN-5  | `/v1/media/:id` for B's file from A; signed link for B's key with A's signature                                     | `media-access.integration.test.ts`                                                              | 404; signature mismatch                                                   |
| T-TEN-6  | Website key of A against B's job/quote/invoice/document ids                                                         | `website-data.integration.test.ts`                                                              | 404 / `found: false`                                                      |
| T-RBAC-1 | For every route with `permission`, call with each built-in role and assert allow/deny equals `permissions.table.md` | new registry-driven suite                                                                       | matches the table                                                         |
| T-RBAC-2 | Staff-only permissions refused for a company owner without impersonation                                            | same                                                                                            | 403 with the staff-only message                                           |
| T-RBAC-3 | Company role adding `role.manage`, `tenant.update`, `website.access.manage` or a staff-only permission              | `roles.integration.test.ts`                                                                     | refused / not effective                                                   |
| T-RBAC-4 | Admin changes own role to owner; admin assigns a company role holding a permission the admin lacks                  | `members.integration.test.ts`                                                                   | 403 / 422 `role_beyond_own`                                               |
| T-RBAC-5 | Non-owner gives or removes HR access                                                                                | `members.integration.test.ts`                                                                   | 403 `hr_access_owner_only`                                                |

## Authentication and sessions

| ID                               | Test                                                                                                                                                                | Expect                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| T-AUTH-1                         | Token signed with an unknown `kid`, with `alg: none`, with HS256 using the public key, wrong `aud`/`iss`, expired, `typ: platform` on a tenant route and vice versa | 401 each (unit test in `packages/auth/src/tokens.test.ts`)                                         |
| T-AUTH-2                         | Refresh token reused after rotation; two concurrent refreshes                                                                                                       | second use → 401 `auth.refresh_token_reuse`, session and offline grant revoked, audit line written |
| T-AUTH-3                         | Access token used after sign-out / password change / member suspension                                                                                              | 401 within 30 s (advance the liveness clock)                                                       |
| T-AUTH-4                         | Impersonation token after the grant is ended or expires                                                                                                             | 403 immediately                                                                                    |
| T-AUTH-5 **(new behaviour, R7)** | Six failed staff sign-ins for a known and an unknown address                                                                                                        | identical status and body                                                                          |
| T-AUTH-6 **(new behaviour, R8)** | Same valid TOTP used twice within its window                                                                                                                        | second attempt refused                                                                             |
| T-AUTH-7                         | `/v1/auth/magic-link` for unknown vs known address                                                                                                                  | same 202, same timing class (code issued after response)                                           |
| T-AUTH-8                         | Wrong sign-in codes count toward the lockout                                                                                                                        | lock after `AUTH_LOCKOUT_THRESHOLD`                                                                |
| T-AUTH-9                         | Accepting an invitation for an address that already signs in, with a password                                                                                       | password not applied (`existingAccount`)                                                           |

## MCP and staff scopes

| ID                               | Test                                                                                  | Where                                     | Expect                                       |
| -------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------- |
| T-MCP-1 **(new behaviour, R1)**  | Limited session → impersonate test company → `GET /v1/forms/copy-targets`             | `test-companies.integration.test.ts`      | 403 `session_scope` (or only test companies) |
| T-MCP-2 **(new behaviour, R1)**  | Same → `POST /v1/forms/:id/copy-to-company` with a real company id                    | same                                      | 403; nothing created in the real company     |
| T-MCP-3 **(new behaviour, R1)**  | Same → `POST /v1/forms/:id/library-template`                                          | same                                      | 403; library unchanged                       |
| T-MCP-3b                         | Registry test: every route flagged `crossTenant` is listed in `session-scope.test.ts` | unit                                      | list equality                                |
| T-MCP-4 **(new behaviour, R12)** | `write_website_env` with `keyName: 'NEXT_PUBLIC_KEY'`                                 | `apps/dev-mcp` unit                       | refused                                      |
| T-MCP-5                          | Limited session on every platform route not opened to it                              | existing `session-scope.test.ts`          | 403                                          |
| T-MCP-6                          | Forms for AI makes no network request from any tool                                   | existing `offline.test.ts`                | keep                                         |
| T-MCP-7                          | Preview server: wrong Host, missing/wrong token, foreign Origin                       | `apps/forms-ai/src/window/server.test.ts` | 403/404 each                                 |

## Database

| ID                             | Test                                                                                                                                      | Expect                             |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| T-DB-1 **(new behaviour, R2)** | For every name in `SECURITY_DEFINER_FUNCTIONS`: `has_function_privilege('public'/'integr8_auth'/'supabase_auth_admin', fn, 'EXECUTE')`    | false                              |
| T-DB-2 **(new behaviour, R2)** | As `integr8_app` with `app.tenant_id = A`, call `erp_ledger_try_post` on B's pending posting and `erp_ledger_capture(B, …)`               | exception `insufficient_privilege` |
| T-DB-3                         | Existing invariants: RLS enabled on every tenant table, policy uses `app_current_tenant_id()`, composite tenant FKs, `search_path` pinned | keep green                         |
| T-DB-4                         | `integr8_app` with no `app.tenant_id` set reads every tenant table                                                                        | zero rows                          |

## API input handling

| ID                              | Test                                                                                                    | Expect                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| T-API-1                         | Oversized bodies per route (`bodyLimit`)                                                                | 413 `body_too_large`                           |
| T-API-2                         | CSV export cells starting `=`, `+`, `-`, `@`, tab                                                       | prefixed with `'` (unit, `csvCell`)            |
| T-API-3                         | Upload with `image/svg+xml`, `text/html`, `application/xml`                                             | refused at intent                              |
| T-API-4 **(new behaviour, R3)** | `renderThumbnail` with SVG bytes and PDF bytes                                                          | refused without decoding                       |
| T-API-5 **(new behaviour, R9)** | Logger line for `/v1/public/quotes/<token>`                                                             | logs the route template                        |
| T-API-6                         | PDF printer: template with `<img src="http://169.254.169.254/">` and `<link href="file:///etc/passwd">` | request aborted (assert via route handler spy) |
| T-API-7                         | `.integr8form` import: zip bomb, path traversal names, oversize                                         | refused by the strict reader                   |

## Native and clients

| ID                                | Test                                                                                             | Expect                                                                |
| --------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| T-DESK-1 **(new behaviour, R11)** | `stamp.mjs` output for a release build                                                           | CSP has no `localhost`; keychain service equals the bundle identifier |
| T-DESK-2                          | Tauri capability file contains only the reviewed permissions                                     | snapshot test on `capabilities/default.json`                          |
| T-MOB-1                           | `checkOfflineGrant` with `alg: none`, HS256, unknown `kid`, expired, future `iat`, `typ: access` | `ok: false` each                                                      |
| T-WEB-1 **(new behaviour, R10)**  | Response headers                                                                                 | enforced CSP, no `'unsafe-inline'` in `script-src`                    |

## Supply chain

| ID                             | Test                                                             | Expect             |
| ------------------------------ | ---------------------------------------------------------------- | ------------------ |
| T-SC-1 **(new behaviour, R5)** | Updater with valid checksum but invalid/missing signature        | refused            |
| T-SC-2 **(new behaviour, R4)** | Workflow lint: every third-party `uses:` pinned to a 40-char SHA | CI fails otherwise |
| T-SC-3 **(new behaviour, R6)** | `pnpm audit --prod --audit-level high` in CI                     | no failures        |
