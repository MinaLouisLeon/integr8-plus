# Audit progress record

Audit of commit `3326a4e`, 2026-11-16. Completed in one session; this records exactly what was and was not read, so a follow-up can resume without assuming coverage.

## Inspected in full
- `apps/api/src/server.ts`, `http/routes.ts`, `http/session-scope.ts`, `http/rate-limit.ts`, `http/cors.ts` (logic), `http/idempotency.ts` (logic)
- `apps/api/src/routes/v1/documents-public.ts`, `website-data.ts`, `form-copy.ts` (lines 1–440), `media-access.ts` (first 120 lines), `member-rules.ts`, `health.ts` (probe), `public-brand.ts` (build list)
- `packages/auth/src/tokens.ts`, `services/session-service.ts`, `services/sign-in-service.ts`, `services/platform-session-service.ts`, `services/impersonation-service.ts`, `totp.ts` (logic), `config.ts` (defaults)
- `packages/db/src/connection.ts` (tenant seam, pools, assertions); every `*.up.sql` scanned for SECURITY DEFINER, `search_path`, grants/revokes, policies; bodies of `purge_tenant`, `erp_ledger_capture`, `erp_ledger_try_post` (first half), `integr8_purging`, `app_current_tenant_id`
- `packages/core/src/permissions.ts` (`holds`, `seatCan`, `roleCan`, custom-role rules)
- `apps/dev-mcp/src/server.ts` (lines 180–660), `connection.ts` (request/upload/refresh), `envfile.ts`, `website.ts` (env writing), `local.ts` (spawn)
- `apps/forms-ai/src/window/server.ts` (checks), `window/open-browser.ts`, `setup/update.ts` (logic), `mcp/package-files.ts` (path handling)
- `apps/desktop/src-tauri/` (`tauri.conf.json`, `capabilities/default.json`, `src/lib.rs`, `Cargo.toml`), `scripts/stamp.mjs` (CSP/updater stamping)
- `apps/mobile/app.config.ts` (security-relevant keys), `src/lib/platform.ts`, `src/local/device.ts`, `src/lib/offline-grant.ts` (verification), `app/welcome.tsx` (WebView)
- `apps/web/src/lib/content-security-policy.ts`
- `apps/api/src/documents/printer.ts` (browser isolation), `packages/document-render/src/html.ts` (escaping)
- `apps/api/src/media/storage.ts` (type filter, key pattern), `media/local-disk.ts` (paths, signing), `media/thumbnails.ts`
- `deploy/compose.yml` (ports, images, Auth settings), `deploy/vps/Caddyfile.example`, `deploy/vps/backup-postgres.sh` (upload)
- `.github/workflows/*.yml` (actions used, permissions, expression injection), Dockerfiles

## Inspected by enumeration or sampling
- All 549 routes enumerated (security kind, permission, module, scopes) — `scratchpad/routes.tsv` method. ~40 handlers read; the 21 authenticated routes without a route permission all checked.
- `apps/api/src/sync/push.ts`: dispatch and authorization helpers read; individual handlers sampled.
- AI: `ai/tools/registry.ts` gate, `ai/actions/service.ts` confirm flow.
- Repositories: `documents.ts` (public lookups, website keys), `submissions.ts` (raw SQL spots).
- `members.ts` rank rules (grep-level), `hr.ts` own/sensitive checks (grep-level).
- `pnpm audit` over the lockfile; regex secret scan of tree and history.

## Not inspected (remaining)
- Remaining route handlers in full (finance, ledger, payroll, inventory, purchasing, manufacturing, contracts, e-invoicing beyond the switch, imports, analytics).
- Worker job handlers other than thumbnails (email delivery, ETA submission, app builds, transfer import/export in depth).
- `apps/api/src/transfer/*` (archive import trusts its contents by design; staff-only CLI).
- Desktop and phone UI code beyond storage and WebView; `packages/operations-dom`, `form-renderer-dom` beyond sink grep.
- GoTrue container configuration beyond compose; Caddy on the real machine; Cloudflare/R2; GitHub settings.
- Rust dependency audit (`cargo audit` not installed; crate graph not fetched).

## Validation status
| Finding | Status |
| --- | --- |
| SEC-001 | Source-traced end to end (MCP tool → impersonation → tenant route → platform connection write). Not executed. |
| SEC-002 | Grants and bodies read in migrations. Not queried on a live database. |
| SEC-003 | Reachability source-traced; CVE impact not reproduced. |
| SEC-004–SEC-013 | Source-confirmed. |
| SEC-014–SEC-018 | Informational / potential, as labelled. |
