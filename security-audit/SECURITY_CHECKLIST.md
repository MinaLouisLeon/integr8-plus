# Security checklist — Integr8 Plus (audit of 2026-11-16, commit 3326a4e)

Statuses: **PASS** verified secure for the behaviour reviewed (evidence given; source review, no runtime test unless stated) · **FAIL** confirmed vulnerability · **REVIEW** potential risk needing verification · **NOT TESTED** could not evaluate · **N/A** not in this architecture.

## Authentication and sessions

| Item                                                       | Status | Evidence                                                                 |
| ---------------------------------------------------------- | ------ | ------------------------------------------------------------------------ |
| JWT algorithm pinned, `kid` only selects a key             | PASS   | `packages/auth/src/tokens.ts` `#verify`: `algorithms: [ALGORITHM]`       |
| Issuer, audience, expiry validated                         | PASS   | same, `issuer`, `audience`, `currentDate`                                |
| Token type separation (access / offline / platform)        | PASS   | `packages/core/src/claims.ts:63,95,115` `typ` literals                   |
| Refresh rotation with reuse detection                      | PASS   | `session-service.ts` `refresh`, `markRefreshTokenUsed`, `#recordReuse`   |
| Revocation reaches live tokens                             | PASS   | `assertSessionLive` per request, 30 s cache cleared on revoke            |
| Uniform sign-in failures, no enumeration (company)         | PASS   | `sign-in-service.ts`; `auth.ts` magic-link 202 always                    |
| Uniform sign-in failures (staff)                           | FAIL   | SEC-007                                                                  |
| Brute-force protection                                     | PASS   | per-address lockout, per-IP failure limit, code request limits           |
| Password policy                                            | PASS   | `password-policy.ts`, min 12, no email local part                        |
| Staff second factor                                        | PASS   | `platform-session-service.ts` password + TOTP                            |
| TOTP replay protection                                     | FAIL   | SEC-008                                                                  |
| Cookie flags / CSRF                                        | N/A    | no cookie auth (bearer tokens; public site has no sign-in)               |
| OAuth/OIDC                                                 | N/A    | not used                                                                 |
| Session fixation                                           | PASS   | sessions created server-side at sign-in; ids never accepted from clients |
| Invitation acceptance cannot take over an existing account | PASS   | `workspace.ts` accept: password ignored for existing account             |
| Impersonation audited, time-boxed, re-checked              | PASS   | `impersonation-service.ts`, `server.ts` step 5                           |
| Impersonation claim cannot be lost                         | REVIEW | SEC-015                                                                  |
| Consistent auth across web/desktop/mobile/MCP              | PASS   | one token service; MCP signs in from terminal only                       |

## Authorization and multi-tenant isolation

| Item                                                                    | Status     | Evidence                                                                                                              |
| ----------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| Every authenticated route checks a permission or does so in its handler | PASS       | registry enumeration: 21 routes without route permission, all reviewed (self-scoped, HR `own()`, media `mayReadFile`) |
| Tenant from token, never from client input                              | PASS       | `withTenant(principal.tenantId)`; public routes resolve tenant from capability                                        |
| RLS armed on a non-bypassing role, asserted at startup                  | PASS       | `connection.ts` `assertRlsEnforced`                                                                                   |
| RLS policies keyed on tenant on every tenant table                      | PASS       | 176 policies; exceptions deliberate                                                                                   |
| Composite tenant foreign keys                                           | PASS       | schema-invariant suite                                                                                                |
| Object-level checks on files                                            | PASS       | `media-access.ts`                                                                                                     |
| Role/rank escalation                                                    | PASS       | `members.ts` `assertOutranks`, `role_beyond_own`; `member-rules.ts`                                                   |
| Company roles cannot hold owner/staff-only permissions                  | PASS       | `permissions.ts` `customRoleMayHold`                                                                                  |
| Limited staff session confined                                          | FAIL       | SEC-001                                                                                                               |
| Platform routes with `:tenantId` scoped correctly                       | PASS       | `session-scope.ts`; website keys match id and tenant                                                                  |
| Background jobs run inside the job's own tenant                         | PASS       | `connection.ts` `PlatformJobQueue` comment; worker claims then `withTenant` (sampled)                                 |
| Cache keys tenant-isolated                                              | PASS       | tenant data-source cache keyed by tenant; liveness cache keyed by session id + user id                                |
| WebSocket/SSE authorization                                             | N/A        | none found                                                                                                            |
| Mass assignment                                                         | PASS       | zod schemas declare accepted fields per route                                                                         |
| Every route exhaustively tested cross-tenant                            | NOT TESTED | needs T-TEN-1..6                                                                                                      |

## Backend / API

| Item                                         | Status | Evidence                                                                                   |
| -------------------------------------------- | ------ | ------------------------------------------------------------------------------------------ |
| Runtime schema validation                    | PASS   | zod on params/query/body for every route                                                   |
| SQL injection                                | PASS   | Kysely parameters; `sql.raw` only with fixed maps (`submissions.ts:481`)                   |
| Command injection                            | PASS   | no shell in API paths reviewed                                                             |
| SSRF                                         | PASS   | outbound hosts from config; PDF renderer blocks all requests                               |
| Path traversal                               | PASS   | `OBJECT_KEY_PATTERN` forbids `..`                                                          |
| Upload type handling                         | REVIEW | SEC-003 (decoded by content)                                                               |
| Prototype pollution / unsafe deserialisation | PASS   | JSON via Fastify + zod; strict ZIP reader                                                  |
| Open redirect                                | PASS   | public file route redirects only to signed storage links                                   |
| CORS                                         | PASS   | exact-origin allow-list (`http/cors.ts`)                                                   |
| Security headers (API)                       | PASS   | HSTS and CSP at Caddy (report-only per MEMORY.md)                                          |
| Body size limits                             | PASS   | `API_MAX_BODY_BYTES`, per-route `bodyLimit`                                                |
| Rate limits                                  | PASS   | per IP, per tenant, per key, sign-in; fail-open noted (SEC-018)                            |
| Error responses hide internals               | PASS   | `toApiError` → `internal()`                                                                |
| Sensitive data in logs                       | FAIL   | SEC-009 (capability paths)                                                                 |
| Timing-safe comparisons                      | PASS   | build token `sameSecret`, preview token `timingSafeEqual`, TOTP                            |
| Race conditions on sensitive writes          | PASS   | refresh claim `where used_at is null`; stock lock functions; work-order `expectedRevision` |
| Idempotency scoped per user                  | PASS   | `idempotency.ts` claim by tenant + user                                                    |
| CSV formula injection                        | PASS   | `csvCell`                                                                                  |
| Webhook verification                         | N/A    | Stripe webhooks removed in P42                                                             |
| Service-to-service auth                      | PASS   | build list bearer token; Auth container on private network with service key                |
| Encryption of sensitive fields               | PASS   | AES-256-GCM with AAD (`hr/sealed-fields.ts`, `eta/credentials.ts`)                         |

## Web frontend

| Item                      | Status | Evidence                                                         |
| ------------------------- | ------ | ---------------------------------------------------------------- |
| XSS sinks                 | PASS   | no `dangerouslySetInnerHTML`/`innerHTML`/`eval` in the workspace |
| CSP enforced              | FAIL   | SEC-010 (report-only)                                            |
| Clickjacking              | PASS   | `X-Frame-Options: DENY`, `frame-ancestors 'none'`                |
| Tokens in localStorage    | PASS   | none (TokenStore contract)                                       |
| postMessage handling      | N/A    | none                                                             |
| Secrets in client bundles | PASS   | only `NEXT_PUBLIC_`/`VITE_`/`EXPO_PUBLIC_` public values found   |

## Tauri desktop

| Item                                    | Status           | Evidence                                                |
| --------------------------------------- | ---------------- | ------------------------------------------------------- |
| Capabilities minimal                    | PASS             | `capabilities/default.json`                             |
| Native commands validated               | PASS             | three keychain commands, no paths/shell                 |
| No shell/fs/http plugin exposure        | PASS             | only updater + opener                                   |
| CSP                                     | PASS (with note) | `script-src 'self'`; localhost origin left in (SEC-011) |
| Updater signature                       | PASS             | minisign pubkey in `tauri.conf.json`                    |
| Credential storage separation per build | FAIL             | SEC-011                                                 |
| Sensitive drafts on disk                | FAIL             | SEC-011 (localStorage)                                  |
| Debug features in release               | NOT TESTED       | real builds not run                                     |
| Code signing                            | NOT TESTED       | MEMORY.md: optional, certificates not bought            |

## Expo mobile

| Item                               | Status     | Evidence                                                        |
| ---------------------------------- | ---------- | --------------------------------------------------------------- |
| Tokens in secure storage           | PASS       | `src/lib/platform.ts` SecureStore                               |
| Local database encrypted           | PASS       | `src/local/device.ts` SQLCipher, random key, device-only        |
| Offline grant verification         | PASS       | `src/lib/offline-grant.ts` pinned EdDSA                         |
| WebView bridges                    | PASS       | none; cross-origin to system browser                            |
| Cleartext traffic / ATS exceptions | PASS       | none in `app.config.ts`                                         |
| Deep-link validation               | REVIEW     | scheme present; routes rely on API authorization; not exercised |
| OTA update channel isolation       | NOT TESTED | EAS configuration on Expo's side                                |
| Screenshot/clipboard protection    | NOT TESTED |                                                                 |

## PostgreSQL

| Item                                            | Status | Evidence                                                            |
| ----------------------------------------------- | ------ | ------------------------------------------------------------------- |
| Definer functions pin `search_path`             | PASS   | scan of all migrations; invariant suite                             |
| Definer functions restricted and tenant-checked | FAIL   | SEC-002                                                             |
| App role least privilege                        | PASS   | grants per table; not owner; no BYPASSRLS                           |
| Pre-auth role narrow                            | PASS   | `assertAuthRoleIsNarrow`                                            |
| Platform role not superuser                     | PASS   | compose and config comments; MEMORY.md 1.2.3                        |
| Global readable tables                          | REVIEW | `feature_flags` `USING (true)` for `integr8_app`                    |
| Secrets in migrations/seeds                     | PASS   | none found                                                          |
| Backups encrypted off-machine                   | FAIL   | SEC-013                                                             |
| DB not publicly reachable                       | PASS   | compose: Postgres has no published port (only api/web on 127.0.0.1) |

## MCP servers

| Item                                                         | Status | Evidence                      |
| ------------------------------------------------------------ | ------ | ----------------------------- |
| Transport                                                    | PASS   | stdio only (both)             |
| Forms for AI holds no credentials and makes no network calls | PASS   | `offline.test.ts`             |
| Preview server origin/host/token checks                      | PASS   | `window/server.ts`            |
| Developer server sign-in outside the model                   | PASS   | `cli.ts login`                |
| Secrets hidden from the model and trace                      | PASS   | `redact.ts`, vault            |
| Per-tool authorization via API scope                         | FAIL   | SEC-001 (tenant routes)       |
| Tool descriptions static                                     | PASS   | source strings                |
| Command execution guarded                                    | PASS   | `local.ts`, `open-browser.ts` |
| Env-file writes constrained                                  | REVIEW | SEC-012                       |
| Update integrity                                             | FAIL   | SEC-004                       |

## Supply chain

| Item                                        | Status     | Evidence                                        |
| ------------------------------------------- | ---------- | ----------------------------------------------- |
| Lockfile, exact pins, frozen installs       | PASS       | `pnpm-lock.yaml`, `pins:check`, Dockerfiles     |
| Known vulnerable runtime deps               | FAIL       | SEC-006 / SEC-003                               |
| Actions pinned by SHA                       | FAIL       | SEC-005                                         |
| Secrets in repo/history                     | PASS       | regex scan of tree and 399 commits; CI gitleaks |
| `cargo audit` / `cargo deny`                | NOT TESTED | tools not installed                             |
| Semgrep / Trivy / OSV-Scanner               | NOT TESTED | tools not installed                             |
| Release provenance/signing (desktop)        | PASS       | minisign updater                                |
| Release signing (Forms for AI, dev program) | FAIL       | SEC-004                                         |

## Infrastructure

| Item                                      | Status         | Evidence                         |
| ----------------------------------------- | -------------- | -------------------------------- |
| Services bound privately                  | PASS           | `compose.yml` `127.0.0.1:` ports |
| Non-root containers                       | PASS           | Dockerfiles `USER node`          |
| Resource limits                           | PASS           | `mem_limit` on every service     |
| Health endpoints not public               | PASS           | Caddyfile `respond @health 404`  |
| Production refuses stand-ins/weak secrets | PASS           | `config.ts`, `check-env.sh`      |
| Proxy trust narrow                        | REVIEW         | SEC-014                          |
| Images pinned                             | REVIEW         | SEC-018 (`postgres:16`)          |
| Branch protection                         | FAIL (process) | MEMORY.md: no rulesets in force  |
| TLS configuration at Caddy                | NOT TESTED     | machine not accessible           |
| R2 bucket policies                        | NOT TESTED     | Cloudflare not accessible        |
