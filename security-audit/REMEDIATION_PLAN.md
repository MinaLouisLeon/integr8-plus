# Remediation plan — Integr8 Plus

Ordered by priority. Each task follows the repository's rules (CLAUDE.md / AGENTS.md): migrations are new and immutable with a `down`, API changes regenerate `openapi.json` and the client, deployment-affecting changes update both copies of the setup guide, permissions keep `permissions.table.md` in step, nothing breaking inside `/v1`.

## 1. Immediate critical fixes

### R1 — Confine limited staff sessions on cross-tenant tenant routes

- **Findings:** SEC-001
- **Priority:** P0
- **Changes:**
  1. `packages/core` claims: add an optional `lim: true` inside `imp` (`ImpersonationClaim`), parsed leniently so older tokens still verify.
  2. `packages/auth/src/services/session-service.ts` `#impersonationClaim`: set `lim` from `impersonation_grants.from_limited_session`.
  3. `packages/auth/src/services/impersonation-service.ts` `assertStillPermitted`: return (or attach to the principal) the grant's `fromLimitedSession` so the decision does not depend on the token alone.
  4. `apps/api/src/http/routes.ts`: new route flag `crossTenant?: true`; set it on `listCopyTargetsRoute`, `copyFormToCompanyRoute`, `saveToLibraryRoute` (`apps/api/src/routes/v1/form-copy.ts`).
  5. `apps/api/src/server.ts` after step 5: refuse a limited impersonation on `crossTenant` routes with 403 `session_scope`, audited like the platform refusal (reuse `sessionScopeRefusal` wording).
  6. Optional, if test-company-to-test-company copies are wanted: allow `copy-to-company` when both companies are test companies, and filter `copy-targets` to test companies for a limited grant.
  7. `apps/dev-mcp/src/server.ts` `call_api`: defence-in-depth deny-list of those operation ids.
- **Affected:** `@integr8/core`, `@integr8/auth`, `@integr8/api`, `@integr8/dev-mcp`; `openapi.json` only if the description of the three routes changes (document the 403).
- **Regression risk:** low — full staff sessions unchanged; older access tokens lack `lim`, so step 3 (grant lookup) is what makes it safe during the 15-minute overlap.
- **Tests:** see `SECURITY_TEST_PLAN.md` T-MCP-1..3; extend `session-scope.test.ts` to pin every `crossTenant` route.
- **Depends on:** nothing.
- **Acceptance:** a limited session's impersonation gets 403 on the three routes (or only test companies, per decision 6); full sessions behave as before; the refusal appears in the platform audit log.

### R2 — Close the SECURITY DEFINER ledger functions

- **Findings:** SEC-002
- **Priority:** P0
- **Changes:** migration `0022_definer_execute` (`up` + `down`):
  - `REVOKE ALL ON FUNCTION <every function in SECURITY_DEFINER_FUNCTIONS> FROM PUBLIC;`
  - `GRANT EXECUTE ON FUNCTION erp_ledger_try_post(uuid, uuid, boolean), erp_ledger_backfill(uuid) TO integr8_app;` and to `integr8_platform` where the worker needs them (check `ledger.ts` callers and jobs).
  - Replace the four function bodies to refuse a tenant mismatch for the runtime role: `if current_user = 'integr8_app' and p_tenant is distinct from app_current_tenant_id() then raise exception ... using errcode = 'insufficient_privilege'; end if;` (for `erp_ledger_try_post`, compare `p.tenant_id` after the `select … for update`).
  - Role bootstrap (`packages/db/src/migrator/cli.ts`): `ALTER DEFAULT PRIVILEGES FOR ROLE <owner> IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;`
  - Schema-invariant suite: for every definer function assert no `EXECUTE` for `PUBLIC`, `integr8_auth`, `supabase_auth_admin`, and an explicit allow-list for `integr8_app`/`integr8_platform`.
- **Affected:** `@integr8/db`; setup guide (new migration line); `MEMORY.md` migration count; `README.md` migration table.
- **Regression risk:** medium — a trigger function never needs `EXECUTE` for the caller, but any function the app calls directly must be granted; the integration suite (rolls every migration down and up) will catch omissions.
- **Tests:** T-DB-1..3.
- **Depends on:** nothing.
- **Acceptance:** invariant suite green with the new checks; ledger integration suites green.

## 2. High-priority fixes

### R3 — Image decoding: upgrade and restrict formats

- **Findings:** SEC-003, part of SEC-006
- **Priority:** P1
- **Changes:** sharp → ≥ 0.35.5 (exact pin); in `apps/api/src/media/thumbnails.ts` and `apps/api/src/documents/images.ts`, read `metadata()` first and continue only for the supported raster formats; mark the thumbnail failed otherwise. Optionally check magic bytes at `/v1/media/:id/complete` against the declared type.
- **Regression risk:** low; HEIC from iPhones must stay in the allow-list if it is supported today.
- **Tests:** T-API-4.
- **Acceptance:** SVG/PDF bytes declared as JPEG produce no decode and a failed thumbnail.

### R4 — Pin GitHub Actions and protect signing secrets

- **Findings:** SEC-005
- **Priority:** P1
- **Changes:** replace every `uses: owner/repo@tag` with a full SHA plus a version comment; add `github-actions` to Dependabot; put the Tauri signing key, EAS/Apple/Google credentials and release token in a `release` environment with required reviewers; minimal `permissions:` per job.
- **Regression risk:** low.
- **Tests:** a `pins:check` extension or a `zizmor` job failing on unpinned actions.
- **Acceptance:** no tag-pinned third-party action remains.

### R5 — Signed self-updates for Forms for AI and the developer program

- **Findings:** SEC-004
- **Priority:** P1
- **Changes:** release workflow signs a manifest (version, file name, SHA-256) with a minisign/Ed25519 key kept in the protected environment; `apps/forms-ai/src/setup/update.ts` verifies the signature with an embedded public key before replacing itself; same for the `integr8-dev-mcp` profile. Code signing when certificates exist.
- **Depends on:** R4 (so the signing key is not exposed to unpinned actions).
- **Tests:** T-SC-1.
- **Acceptance:** an update with a matching checksum but no or wrong signature is refused.

### R6 — Dependency upgrades

- **Findings:** SEC-006
- **Priority:** P1
- **Changes:** kysely ≥ 0.28.17, zod ≥ 4.6.6, fastify ≥ 5.12.6, sharp (R3); later the Expo/RN toolchain. Add `pnpm audit --prod --audit-level high` to CI.
- **Regression risk:** medium for zod/fastify minor changes; run the whole suite.
- **Acceptance:** `pnpm audit --prod` shows no high/critical runtime advisories.

## 3. Medium-priority improvements

| Task                               | Findings | Change                                                                                                                                               | Tests         |
| ---------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| R7 Staff lockout answers uniformly | SEC-007  | Return the same 401 for a locked account; log the lock; consider throttling instead of hard lock                                                     | T-AUTH-5      |
| R8 TOTP replay guard               | SEC-008  | Store last accepted counter per staff account (`platform_users.totp_last_counter`, new migration), refuse ≤                                          | T-AUTH-6      |
| R9 Mask capability paths in logs   | SEC-009  | Log `request.routeOptions.url` instead of `request.url`                                                                                              | T-API-5       |
| R10 Enforce the web CSP            | SEC-010  | Nonce-based `script-src`, switch from report-only after the observation period                                                                       | T-WEB-1       |
| R11 Desktop hardening              | SEC-011  | Per-build keychain service name (bundle identifier); strip localhost from release CSP in `stamp.mjs`; encrypt or move form drafts, clear on sign-out | T-DESK-1..2   |
| R12 Website key env names          | SEC-012  | Refuse public prefixes in `envfile.ts`                                                                                                               | T-MCP-4       |
| R13 Encrypted off-machine backups  | SEC-013  | `age` or rclone `crypt` before upload; update `restore-drill.sh`, setup guide (both copies), `deploy/.env.example`                                   | restore drill |

## 4. Long-term security hardening

| Task                             | Findings   | Change                                                                                          |
| -------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| R14 Narrow proxy trust           | SEC-014    | `trustProxy` set to the Caddy/Docker addresses actually in front of the API                     |
| R15 Fail closed on missing grant | SEC-015    | Refuse/revoke when a session's grant cannot be read; refuse refresh after the grant ends        |
| R16 Staff management             | SEC-016    | Staff creation/reset from the CLI only, or a fresh second factor plus notification to all staff |
| R17 Website data minimisation    | SEC-017    | Confirm or drop `notes`; optional per-record website visibility for jobs                        |
| R18 Infra hygiene                | SEC-018    | Pin `postgres:16.x@sha256:…`; consider an in-memory first tier for the per-IP limit             |
| R19 Branch protection            | report §10 | Apply rulesets (private repositories need a paid plan) so releases do not rest on a local hook  |
| R20 Dynamic testing              | report §2  | Run the integration suites with the new tests; external penetration test                        |

## Dependency graph

```
R1, R2, R3, R6, R7–R13 independent
R4 ──► R5
R2 ──► invariant-suite extension (same PR)
```

## Suggested sequence

1. One PR: R1 + its tests (`fix(api): …`, `fix(auth): …`, `fix(dev-mcp): …`).
2. One PR: R2 (`fix(db): …`) with the invariant-suite checks, setup-guide line, MEMORY.md.
3. R3 + R6 together (dependency PR).
4. R4 then R5.
5. Hardening release with R7–R13.
6. R14–R20 as scheduled work.
