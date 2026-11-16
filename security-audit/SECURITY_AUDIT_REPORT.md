# Security audit report — Integr8 Plus

**Date:** 2026-11-16 **Commit:** `3326a4e` (main) **Version:** 2.0.0
**Companion files:** `VULNERABILITIES.md` (every finding in full), `MCP_SECURITY_AUDIT.md`, `REMEDIATION_PLAN.md`, `SECURITY_TEST_PLAN.md`, `SECURITY_CHECKLIST.md`, `AUDIT_PROGRESS.md`.

## 1. Executive summary

Integr8 Plus is, on the evidence of its source, a carefully engineered multi-tenant platform. Tenant isolation is built in layers (tenant-scoped repositories, a runtime database role that the API proves at startup cannot bypass RLS, RLS on every tenant table, tenant ids in every foreign key), authentication follows current practice (EdDSA tokens with pinned algorithm/issuer/audience, refresh rotation with reuse detection, per-request session liveness, staff two-factor), and the dangerous corners — server-side PDF rendering, the loopback preview server, CSV exports, file storage keys — are handled deliberately.

The audit found **18 findings: 1 High, 4 Medium, 8 Low, 5 Informational**. None is a direct, unauthenticated cross-tenant breach.

**Most important findings**

1. **SEC-001 (High)** — The staff session limited to test companies, which the developer MCP server gives an AI coding tool, can escape to real companies: after impersonating a test company it can call three tenant routes that act across companies (list every company; copy a form into any company; add a template to the library every company sees). The confinement promised for that credential holds only on platform routes.
2. **SEC-002 (Medium)** — Four SECURITY DEFINER ledger functions keep Postgres's default `EXECUTE` for every role and never check the caller's tenant. The API uses them correctly, but anyone able to run SQL as any database role (including the Auth container's role) could write other companies' ledgers, so the RLS backstop has a gap.
3. **SEC-003 (Medium, Likely)** — sharp 0.35.4 has a librsvg advisory, and the thumbnail worker decodes whatever bytes were uploaded, whatever their declared type.
4. **SEC-004 / SEC-005 (Medium)** — Supply chain: Forms for AI and the developer program replace themselves with unsigned binaries checked only against a checksum from the same release, and release workflows run third-party GitHub Actions by mutable tag next to signing secrets.

**Was cross-tenant isolation verified?** By source review, yes for the API's tenant routes: every tenant read/write goes through `withTenant`, which arms RLS on a role that cannot bypass it, and the public and website-key routes resolve their company from an unguessable capability or a hashed key before switching to it. Two exceptions were found and are reported (SEC-001 cross-company staff routes reachable from the limited session; SEC-002 callable definer functions). **No integration test or live database was used**, so runtime confirmation is still outstanding (see §2).

**Were authentication and authorization verified?** By source review, yes for the core flows (sign-in, codes, refresh, revocation, impersonation, staff sessions, role/rank rules for members and company roles). Minor weaknesses: staff lockout enumeration (SEC-007) and TOTP replay (SEC-008).

**MCP servers.** Forms for AI (Server 1) is offline and credential-free: low runtime risk, supply-chain risk only. The developer MCP server (Server 2) is well built but carries SEC-001.

**Before the next production deployment:** fix SEC-001 and SEC-002 (both small, contained changes), upgrade sharp and restrict decoded formats (SEC-003), pin GitHub Actions by SHA (SEC-005).

**Internal score: 77 / 100** — an internal prioritisation metric, not a certification (methodology in §8).

## 2. Scope and limitations

**In scope (all inspected):** `apps/api` (route registry, request pipeline, auth/platform/public/website/sync/AI/media/documents routes, worker jobs sampled), `apps/web`, `apps/desktop` (React + Tauri v2 config, Rust commands, capabilities, stamping), `apps/mobile` (Expo config, token and database storage, offline grants, WebView), `apps/forms-ai` and `apps/dev-mcp` (both MCP servers), `packages/auth`, `packages/db` (connection layer, repositories sampled, all 21 migrations for definer functions, grants, policies), `packages/core` (permission model), `packages/document-render`, `deploy/` (compose, Caddyfile, scripts), `.github/workflows`, Dockerfiles, dependency lockfile, git history for secrets.

**Methods:** manual source review and tracing; scripted enumeration of all 549 routes (security kind, permission, module, scopes); scripted scan of every SECURITY DEFINER function for `search_path` and tenant checks; `pnpm audit` (lockfile-based, read-only); regex secret scan of the working tree and full git history (399 commits).

**Limitations (honest list):**

- **No dynamic testing.** `node_modules` is not installed; integration suites need a disposable Postgres; nothing was run against an API or database. Every "Confirmed" finding is confirmed by source tracing. The test plan gives the runtime checks.
- **Tools not available here:** Semgrep, Gitleaks, Trivy, OSV-Scanner, `cargo audit`/`cargo deny` (only `cargo` is installed and the Tauri crate has not been fetched). Installing them needs your approval. The repository's own CI runs Gitleaks.
- **Not exhaustively read:** all 549 route handlers (authorization model verified centrally, ~40 handlers read in full, the rest covered by the registry enumeration), every sync mutation handler (sampled), every repository (sampled), mobile screens, operations-dom screens.
- **Not testable here:** real Tauri builds (Windows/macOS), real phone builds, Caddy behaviour on the machine, the GoTrue container's configuration beyond compose, R2 bucket policies, Cloudflare, Resend, GitHub repository settings and secrets, the CVE details behind dependency advisories.

## 3. System architecture and trust boundaries

```
 Internet ──TLS──► Caddy (VPS) ──► web  (Next.js, public site, 127.0.0.1:3001) ──► api
                                 └► api  (Fastify /v1, 127.0.0.1:3000)
 Staff desktop app (Tauri) ─────► api  platform routes (staff token: password + TOTP, memory-only)
 Company desktop app (Tauri) ───► api  tenant routes  (token in OS keychain)
 Phone app (Expo) ──────────────► api  tenant + /v1/sync (token in SecureStore, SQLCipher DB, 7-day offline grant)
 Company website server ────────► api  /v1/website/* (website key, sha256-hashed at rest)
 AI coding tool ── stdio ──► Forms for AI (offline) / developer MCP server ──► api (limited staff session)
 api / worker ──► Postgres:  integr8_app (RLS)  ·  integr8_auth (pre-auth tables only)  ·  integr8_platform (BYPASSRLS, staff/worker)
 api ──► Auth container (GoTrue, private) ──► Postgres auth schema (supabase_auth_admin)
 api ──► R2 (signed links), Resend, push, AI providers, ETA, GitHub releases
```

**Trust boundaries and where they are enforced**

| Boundary                   | Enforcement (verified in source)                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Internet → API             | Caddy TLS; per-IP rate limit; client-version gate; zod validation before authentication (`server.ts`)                                                                                                           |
| Anonymous → authenticated  | `verifyAccessToken` (EdDSA, `kid` selects key, alg pinned, iss/aud/exp checked, `typ` literal); session liveness re-read every 30 s; impersonation grant re-read every request                                  |
| Seat → action              | Route `permission`/`anyPermission` against the matrix in `@integr8/core`; staff-only permissions need an impersonation seat; module flags; read-only (unpaid) companies refuse writes by HTTP method            |
| Tenant A → tenant B        | `withTenant` sets `app.tenant_id` per transaction on `integr8_app`; startup assertion that the role neither bypasses RLS nor owns tables; RLS keyed on `app_current_tenant_id()`; composite tenant foreign keys |
| Staff → company            | Platform routes need a platform token; acting inside a company needs an audited impersonation grant with a reason; limited sessions confined (platform routes only — SEC-001)                                   |
| Public capability → record | 256-bit quote tokens, 128-bit document codes, hashed website keys; unknown/unshared answer 404 alike                                                                                                            |
| UI → native (desktop)      | Tauri capabilities `core:default`, `updater:default`, `opener:default`; three keychain commands; CSP `script-src 'self'`                                                                                        |
| Phone offline              | Ed25519 offline grant verified on device with pinned alg; SQLCipher key in SecureStore (this device only)                                                                                                       |
| API → PDF renderer         | Chromium with JavaScript off, offline, every non-`data:` request aborted; all text HTML-escaped                                                                                                                 |
| Model → MCP tools          | stdio; terminal-only sign-in; secrets never returned to the model; API-side scope checks                                                                                                                        |

**Untrusted input entry points:** 27 public routes (sign-in, codes, refresh, invitations, quote/document/asset-tag links, brand, plans, build list, website-key routes, health), 456 authenticated tenant routes, 66 platform routes, `/v1/sync/push` (batched mutations), file uploads (signed PUT, then worker processing), CSV imports, `.integr8form` imports, AI chat (model output and tool calls), MCP tool arguments, deep links/WebView on the phone.

## 4. Overall risk assessment

| Area                         | Risk       | Notes                                                         |
| ---------------------------- | ---------- | ------------------------------------------------------------- |
| Authentication & sessions    | Low        | Strong design; SEC-007, SEC-008 minor                         |
| Authorization & RBAC         | Low–Medium | Central, consistent; SEC-001 for the limited staff session    |
| Multi-tenant isolation       | Low–Medium | Layered; SEC-001, SEC-002 are the exceptions                  |
| Backend / API input handling | Low        | zod everywhere, no injection sinks found; SEC-003             |
| Web frontend                 | Low        | No sign-in on the site; no HTML sinks; SEC-010                |
| Desktop (Tauri)              | Low        | Narrow capabilities, signed updater; SEC-011                  |
| Mobile (Expo)                | Low        | Secure storage done right                                     |
| Database                     | Medium     | SEC-002                                                       |
| MCP servers                  | Medium     | SEC-001 via Server 2, SEC-004                                 |
| Supply chain                 | Medium     | SEC-004, SEC-005, SEC-006                                     |
| Infrastructure               | Low        | Private ports, memory caps, non-root images; SEC-013, SEC-018 |

## 5. Confirmed vulnerabilities (source-confirmed)

SEC-001 (High), SEC-002, SEC-004, SEC-005 (Medium), SEC-006 to SEC-011 and SEC-013 (Low). See `VULNERABILITIES.md`.

## 6. Likely vulnerabilities and unverified risks

- **SEC-003** (Likely): the advisory's exploitability was not reproduced.
- **SEC-012, SEC-015, SEC-017** (Potential).
- **Unverified:** that Caddy on the machine replaces `X-Forwarded-For` (SEC-014 depends on it); R2 bucket policies; GitHub branch protection (MEMORY.md says none is in force — the only guard against pushing to `main` is a local hook, which is a process risk for release integrity).

## 7. Findings by area

### 7.1 Web frontend (`apps/web`)

Public site only since P42; no sign-in, no tokens. Security headers set from `next.config.ts` (`X-Frame-Options: DENY`, `frame-ancestors 'none'`, `nosniff`, referrer policy, HSTS at Caddy). No `dangerouslySetInnerHTML`, `eval` or `postMessage` handlers anywhere in the workspace. Finding: **SEC-010** (CSP report-only, `'unsafe-inline'`).

### 7.2 Backend and API (`apps/api`)

- Single route registry: every route declares security kind, permission, module, idempotency and schemas; Fastify and OpenAPI both come from it.
- Validation with zod before authentication; errors never leak internals (`toApiError` → `internal()` with request id).
- Idempotency keyed by tenant + user + HMAC of the request (secrets stripped).
- Rate limits: per IP (before DB work), per tenant, per website key, sign-in per address and per IP (failures only), sign-in codes per address. Store-backed, fail-open (SEC-018).
- SQL: Kysely with bound parameters; the only `sql.raw`/`sql.ref` uses come from fixed lookup tables (`submissions.ts:415,481`).
- CSV exports neutralise formula prefixes (`core/ledger.ts:490`, `submissions.ts:1200`).
- File storage: object keys match a pattern that forbids `..`; signed links with HMAC and expiry; files follow their owning record (`media-access.ts`), refusals are 404.
- PDF rendering locked down (§3).
- HR identifiers and ETA credentials sealed with AES-256-GCM, random nonces, AAD bound to tenant/field.
- AI assistant: tools gated by permission, module and data class; actions are proposals the person confirms on screen, re-checked at confirmation (`ai/actions/service.ts`).
- Findings: **SEC-003, SEC-009, SEC-014, SEC-017, SEC-018**.

### 7.3 Authentication and authorization

- Company sign-in through the self-hosted GoTrue container; uniform failures; lockout per address (10/h); code requests answered 202 regardless, issued after the response; OTP 6 digits, 15 minutes.
- Tokens: EdDSA, 15-minute access tokens; refresh tokens 30 days within a 90-day session, rotated with reuse detection that revokes the session and its offline grant (`session-service.ts`).
- Revocation: sign-out, password change, membership end, suspension and staff action reach the API within 30 s (liveness cache) and immediately for impersonation.
- Staff: scrypt + TOTP, decoy hashing for unknown addresses, 5-minute access tokens, 8-hour sessions, re-checked every request.
- RBAC: matrix in `packages/core/src/permissions.ts`; staff-only permissions; company roles cannot add owner-only, owner/admin-only or staff-only permissions; members cannot act on or grant above their own rank; HR access changes are owner-only (`member-rules.ts`, `members.ts`).
- Findings: **SEC-001, SEC-007, SEC-008, SEC-015, SEC-016**.

### 7.4 Multi-tenant isolation

Verified layers listed in §3. Website-key and public routes resolve the company first over the platform connection, then read under RLS. Platform routes that take `:tenantId` act through repositories keyed by that id (website keys match id **and** tenant). Findings: **SEC-001, SEC-002**.

### 7.5 Tauri desktop (`apps/desktop`, Tauri v2)

- Capabilities: `core:default`, `updater:default`, `opener:default` for the `main` window only.
- Native commands: `keychain_read`, `keychain_write(value)`, `keychain_clear` — no paths, no shell, no arguments beyond the stored value; callable only by the app's own origin.
- CSP: `default-src 'self'; script-src 'self'`, no remote scripts; `object-src 'none'`.
- Updater: minisign public key in config; staff app holds the platform session in memory only.
- `opener:default` opens http(s)/mailto/tel in the system handler.
- Finding: **SEC-011**. Not verified: real builds, the updater feed's signatures in practice (MEMORY.md asks whether anyone holds the updater private key).

### 7.6 Expo mobile (`apps/mobile`)

- Tokens in `expo-secure-store` (`AFTER_FIRST_UNLOCK`); database key 32 random bytes in SecureStore (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`), SQLCipher `PRAGMA key`.
- Offline grant: Ed25519 verified on device with `alg` pinned to EdDSA, `kid` lookup, expiry and issued-at checks. Offline access necessarily trusts the device clock (Informational).
- Welcome WebView: no JavaScript bridge; cross-origin top-level navigation goes to the system browser.
- No AsyncStorage for secrets found. Deep-link scheme `integr8` (per company) — routes rely on API authorization.
- No findings of Low or above. Not verified: release builds, OTA update channel configuration in EAS.

### 7.7 PostgreSQL and SQL scripts

- 21 migrations; 176 RLS policies, all keyed on `app_current_tenant_id()` except deliberate global or pre-auth tables (`feature_flags`, `form_templates` readable; `rate_limit_buckets`, `account_locks`, `login_attempts` for `integr8_auth`; billing/sign-up tables closed).
- `app_current_tenant_id()` returns NULL when unset, so policies deny by default.
- Every SECURITY DEFINER function pins `search_path` (also asserted by the invariant suite).
- Roles: owner (migrations), `integr8_app` (RLS), `integr8_auth` (three tables and a view, asserted narrow at startup), `integr8_platform` (BYPASSRLS, not superuser), `supabase_auth_admin` (GoTrue).
- Finding: **SEC-002**. Review: whether `feature_flags` holds per-company rows readable by every company (`USING (true)` for `integr8_app`).

### 7.8 MCP Server 1 — Forms for AI

See `MCP_SECURITY_AUDIT.md`. Finding: **SEC-004**.

### 7.9 MCP Server 2 — developer MCP server

See `MCP_SECURITY_AUDIT.md`. Findings: **SEC-001, SEC-004, SEC-012**.

### 7.10 Supply chain and dependencies

Exact versions everywhere, `--frozen-lockfile` in Dockerfiles, Node pinned. Findings: **SEC-004, SEC-005, SEC-006**. Secret scan: placeholders only in the tree and in 399 commits of history.

### 7.11 Infrastructure

API and web bound to 127.0.0.1; Auth container private; `/health*` blocked at Caddy; memory caps on every service; images run as `node`; compose passes each service only its own settings (`compose-env.test.ts`); production refuses stand-in services and weak/example secrets (`config.ts`, `check-env.sh`). Findings: **SEC-013, SEC-014, SEC-018**. The machine is shared with another project (MyRooms): containers there can reach host-bound ports, which makes SEC-014 worth fixing.

## 8. Security strengths verified

- RLS startup assertion (`connection.ts` `assertRlsEnforced`, `assertAuthRoleIsNarrow`).
- Transaction-local tenant GUC, UUID re-parsed before `set_config`.
- Composite tenant foreign keys (invariant suite).
- Refresh-token reuse detection committed before refusing (comment explains the bug it fixed).
- Uniform authentication failures and decoy hashing for staff.
- Capability links with 404 parity for unknown/unshared.
- PDF renderer isolation; HTML escaping; CSV formula neutralising.
- Strict ZIP reader for `.integr8form` (size limits, no library).
- Loopback preview server with Host/Origin/token checks.
- Audited, reasoned, time-boxed impersonation re-checked per request.
- No secrets in the repository or its history.

## 9. Scoring methodology (internal metric)

Ten areas weighted by impact on a multi-tenant SaaS: authentication 15, authorization/tenant isolation 20, API/input 15, database 10, MCP 10, supply chain 10, desktop 5, mobile 5, web 5, infrastructure 5. Each area was scored 0–1 from verified controls minus findings (High −0.2, Medium −0.1, Low −0.03 to −0.05 within the area): authentication 0.90, authorization 0.80, API 0.90, database 0.80, MCP 0.75, supply chain 0.60, desktop 0.85, mobile 0.90, web 0.85, infrastructure 0.85 → 81.75. **Five points are then removed because no dynamic testing was possible** (untested areas lower the score rather than being assumed safe), giving **77/100**. The number exists to compare future audits of this repository, not to state that the application is secure.

## 10. Final recommendations

1. Fix SEC-001: carry "limited" into impersonation tokens and refuse it on cross-tenant routes (registry flag + pinned test).
2. Fix SEC-002: migration 0022 revoking `EXECUTE` from `PUBLIC` on definer functions and adding tenant checks; extend the invariant suite.
3. Upgrade sharp and restrict decoded formats (SEC-003); upgrade kysely, zod, fastify (SEC-006).
4. Pin Actions by SHA; protect signing secrets in an environment with reviewers (SEC-005); sign updates for both programs (SEC-004).
5. Low items in one hardening release (SEC-007 to SEC-013).
6. Run the integration suites with the new tests in `SECURITY_TEST_PLAN.md`, and commission a dynamic penetration test focused on: cross-tenant access through every route family, `/v1/sync/push` mutation authorization, file upload processing, the staff desktop app's platform session, and the developer MCP server under prompt injection.
7. Turn on GitHub branch protection/rulesets (MEMORY.md: none in force) so release integrity does not rest on a local hook.
