# Security audit — issues found

The issues found by the security audit of 2026-11-16, one section each, to be discussed and fixed
one at a time. The suggested fix order is: SEC-001, SEC-002, SEC-003 with SEC-006, SEC-005, SEC-004,
then SEC-007 to SEC-013, then the informational items. Add a **Status** line under a finding's
heading when it is decided or fixed.

## Rules decided with the owner (2026-11-16)

1. Form templates are for Integr8 staff only; a company's own people never see the library.
2. The MCP servers never reach real company data.
3. The developer MCP server works only in test companies.
4. Forms for AI touches no company or test data; staff import its files by hand in the staff app.
5. A company without a website cannot share anything. Shared documents, quote links and asset-tag
   pages open only on the company's own website, whose server reads them with its website key.
   Integr8's own site and API serve none of them without a key. No HMAC on links or requests:
   printed QR codes must keep working, and the website key already proves the caller.

Audit date: 2026-11-16. Commit audited: `3326a4e` (main, after PR #203). Method: source review and
read-only tooling. No integration suite, no live database and no running API were used, so
"Confirmed" here means **confirmed by source tracing**, not by executing an exploit. Each finding
says how to prove it at runtime.

| ID      | Title                                                                                                                          | Severity      | Confidence                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------- | ------------------------------------------ |
| SEC-001 | A limited (`test_companies`) staff session escapes to real companies through impersonation                                     | High          | Confirmed (source)                         |
| SEC-002 | SECURITY DEFINER ledger functions are executable by every role and ignore the caller's tenant                                  | Medium        | Confirmed (source)                         |
| SEC-003 | Uploaded files are decoded by sharp/libvips whatever their declared type; sharp 0.35.4 carries a librsvg advisory              | Medium        | Likely                                     |
| SEC-004 | Forms for AI and the developer MCP program update themselves from unsigned binaries                                            | Medium        | Confirmed (source)                         |
| SEC-005 | Release workflows run third-party actions pinned to mutable tags next to signing secrets                                       | Medium        | Confirmed (source)                         |
| SEC-006 | Runtime dependencies with published advisories                                                                                 | Low           | Confirmed (scanner), reachability assessed |
| SEC-007 | Staff sign-in reveals which staff addresses exist through the lockout answer, and lets anyone lock staff out                   | Low           | Confirmed (source)                         |
| SEC-008 | Staff authenticator codes can be replayed inside their 90-second window                                                        | Low           | Confirmed (source)                         |
| SEC-009 | Capability tokens (quote links, document codes) are written to the API's request logs                                          | Low           | Confirmed (source)                         |
| SEC-010 | The public site's content-security policy is report-only and allows inline script                                              | Low           | Confirmed (source)                         |
| SEC-011 | Desktop hardening gaps: one keychain entry for every build, a localhost origin in the release CSP, form drafts in localStorage | Low           | Confirmed (source)                         |
| SEC-012 | The developer MCP server lets the model choose the environment variable name a website key is written under                    | Low           | Potential                                  |
| SEC-013 | Off-machine database backups are not encrypted before they leave the machine                                                   | Low           | Confirmed (source)                         |
| SEC-014 | The API trusts every `X-Forwarded-For` hop                                                                                     | Informational | Confirmed (source)                         |
| SEC-015 | A refreshed impersonation token silently loses its `imp` claim if the grant row is missing                                     | Informational | Potential                                  |
| SEC-016 | Staff accounts are all equal: any full staff session can create staff and reset another staff member's credentials             | Informational | Confirmed (source)                         |
| SEC-017 | Website-key routes answer for any job/invoice by id and return invoice `notes`                                                 | Informational | Potential                                  |
| SEC-018 | Smaller hardening items (mutable `postgres:16` tag, sandbox-less Chromium, fail-open rate limiter)                             | Informational | Confirmed (source)                         |

CVSS v4.0 vectors are given where the preconditions are clear enough to score. They are the
auditor's estimate from source; none was produced by a scoring tool.

---

## SEC-001 — A limited (`test_companies`) staff session escapes to real companies through impersonation

**Status:** Fixed (2026-11-16, pushed on `ccr-87dc93be-pye3tx`). The grant's `from_limited_session` is read on every
request (and carried as `imp.lim` in new tokens); routes marked `crossTenant` (copy targets, copy to
company, save to library) refuse a limited seat with 403 `session_scope`, audited; the list is pinned
in `session-scope.test.ts`. The developer server's `call_api` also sends public routes only for the
chosen test company. Proven by `test-companies.integration.test.ts`, run on a local Postgres 16.

**Severity:** High
**Confidence:** Confirmed by source tracing (not executed)
**Affected component:** API (`apps/api`), auth (`packages/auth`), developer MCP server (`apps/dev-mcp`)
**Affected location:**

- `apps/api/src/routes/v1/form-copy.ts:53-61` (`staffOf` checks only that an impersonation claim exists)
- `apps/api/src/routes/v1/form-copy.ts:96-131` (`GET /v1/forms/copy-targets`: every company that is not closed)
- `apps/api/src/routes/v1/form-copy.ts:147-…` (`POST /v1/forms/:formId/copy-to-company`: writes into the company named in the body)
- `apps/api/src/routes/v1/form-copy.ts:347-…` (`POST /v1/forms/:formId/library-template`: writes the platform-wide template library)
- `apps/api/src/routes/v1/platform/impersonation.ts:82-113` (records `fromLimitedSession`, nothing reads it to refuse)
- `packages/auth/src/services/impersonation-service.ts:222-238` (`assertStillPermitted` checks liveness and user only)
- `apps/dev-mcp/src/server.ts:511-618` (`call_api` sends any non-`/v1/platform/` route as the company)

**CWE / OWASP:** CWE-269 Improper Privilege Management, CWE-441 Unintended Proxy (confused deputy); OWASP API5:2023 Broken Function Level Authorization.

**Description.** P38 introduced a staff session scope `test_companies` for the developer MCP server, which an AI coding tool holds. The design (MEMORY.md, `http/session-scope.ts`) promises that this session reaches only test companies, "production included". That confinement is enforced only on **platform** routes (`assertWithinSessionScope`, `server.ts` step 5′).

The limited session may call `POST /v1/platform/companies/:tenantId/impersonate` for a test company. The tenant token it gets back carries `imp: { pid, gid }` and the `owner` role; nothing in the token or in the per-request grant check (`assertStillPermitted`) says the grant came from a limited session. Tenant routes therefore treat it exactly like a full staff impersonation.

Three tenant routes act **outside** the impersonated company on the strength of `principal.impersonatedBy` alone:

1. `GET /v1/forms/copy-targets` lists up to 100 companies, real ones included (id, name, slug), read over the RLS-bypassing platform connection.
2. `POST /v1/forms/:formId/copy-to-company` creates a form and draft in the company given as `body.tenantId`, with no check that it is a test company.
3. `POST /v1/forms/:formId/library-template` creates a staff-made library template, which every company sees when it starts a form.

`form.manage` and `document.design` are staff-only permissions, and an impersonation seat holds them, so the permission check passes.

**Evidence.**

- `form-copy.ts:53-61`: `staffOf` returns `principal.impersonatedBy` and refuses only when it is undefined.
- `form-copy.ts:119-130`: `getPlatformDataSource().tenants.list()` filtered by status and search only.
- `form-copy.ts:189-197`: target company fetched by `body.tenantId`; refused only if deleted or cancelled.
- `grep -rn fromLimitedSession apps/api/src` finds it only in the impersonation route's request/response shapes and audit metadata; no authorization decision reads it.
- `apps/dev-mcp/src/server.ts:529-535`: `call_api` refuses only paths starting `/v1/platform/`; `/v1/forms/...` routes go through with the company's impersonation token.

**Attack prerequisites.** A live limited staff session. In practice: the AI tool running the developer MCP server is steered by prompt injection (from a change request, a form file, a repository file, or API data it reads), or the session tokens kept in the developer's keychain are stolen.

**Exploitation scenario (non-destructive description).** The model is told, through injected text in a change request it is reading, to "check copy targets". It calls `call_api GET /v1/forms/copy-targets` as `company` in a test company and receives the list of real customers. It then calls `copy-to-company` with a real company's id, placing a draft form in that company, or `library-template`, placing attacker-written text into the library every company draws from.

**Business impact.** Confidentiality: the list of customer companies leaks. Integrity: writes into real companies and into the shared template library, from a credential designed never to touch them. Tenant isolation: the documented boundary for the AI-held credential does not hold.

**CVSS v4.0 (estimate):** `CVSS:4.0/AV:N/AC:L/AT:P/PR:H/UI:N/VC:L/VI:L/VA:N/SC:L/SI:L/SA:N`, about 5.1 base. Rated **High** here despite that number because it defeats an explicit security boundary built for an AI-operated credential, where prompt injection supplies the "attacker" without needing a malicious insider.

**Remediation.**

1. Carry the limitation into the tenant token: add a claim (for example `imp.lim: true`) when the grant has `from_limited_session`, or look the grant up in `assertStillPermitted` (it is already read there) and expose `limited` on the principal.
2. In every route that acts outside the principal's own tenant (`copy-targets`, `copy-to-company`, `library-template`, and any future one), refuse a limited impersonation, or require the target to be a test company (`tenants.is_test`) and refuse library writes outright.
3. Add a registry-level flag (for example `crossTenant: true`) on such routes so `server.ts` refuses limited impersonations centrally, and pin the list in `session-scope.test.ts` the way platform routes are pinned.
4. Optionally make `call_api` in `apps/dev-mcp` refuse those operation ids as defence in depth.

**Verification.** Integration test: sign in with `scope: 'test_companies'`, impersonate a test company, then call the three routes. Expect `copy-targets` to list only test companies (or 403), `copy-to-company` with a real company id to return 403 `session_scope`, and `library-template` to return 403. The same calls from a full session must still work.

---

## SEC-002 — SECURITY DEFINER ledger functions are executable by every role and ignore the caller's tenant

**Status:** Fixed (2026-11-16, migration 0022). Every security-definer function is closed to PUBLIC
and opened only to the role that calls it; the four ledger functions refuse another company's id on
the runtime role's connection; new functions start closed. Proven by the database integration suite
(new tests in `schema-invariants` and `rls-backstop`), run on a local Postgres 16.

**Severity:** Medium
**Confidence:** Confirmed by source tracing (privileges not queried on a live database)
**Affected component:** `packages/db` migrations
**Affected location:**

- `packages/db/migrations/0010_inventory.up.sql:27` `erp_ledger_capture(p_tenant, …)`
- `packages/db/migrations/0010_inventory.up.sql:238` `erp_ledger_try_post(p_posting, p_actor, p_force)`
- `packages/db/migrations/0013_finance.up.sql:209` `erp_ledger_backfill(p_tenant)`
- `packages/db/migrations/0001_foundation.up.sql:61` `erp_ledger_backfill_more(p_tenant, …)`
- Compare `packages/db/migrations/0010_inventory.up.sql:1084-1088` (stock locks: `REVOKE … FROM PUBLIC`, granted to `integr8_app`, and they check `app_current_tenant_id()`)

**CWE / OWASP:** CWE-250 Execution with Unnecessary Privileges, CWE-639 Authorization Bypass Through User-Controlled Key; OWASP ASVS V4.1.

**Description.** The four functions run as the schema owner (a superuser in this deployment) and so bypass RLS. Postgres grants `EXECUTE` on new functions to `PUBLIC`, and the migrations revoke it only for `purge_tenant`, the partition helpers, `crm_opportunity_record_amount` and the stock-lock functions. None of the four compares `p_tenant` (or the posting's tenant) with `app_current_tenant_id()`. Any role that can connect to the database — `integr8_app`, `integr8_auth`, and GoTrue's `supabase_auth_admin` — can call them with another company's id or posting id:

- `erp_ledger_capture` inserts a queued posting into another company's `erp_ledger_postings` and tries to post it.
- `erp_ledger_try_post(<posting>, <actor>, true)` force-posts a pending posting in any company, skipping that company's "automatic posting off" switch, writing journal entries attributed to any actor id.
- `erp_ledger_backfill` / `_more` queue another company's historical documents for posting.

The application itself calls these correctly (`packages/db/src/repositories/ledger.ts:1097,1105` pass the transaction's own tenant and posting ids found under RLS), so this is not reachable through the API today. It removes the RLS "backstop" that CLAUDE.md and AGENTS.md rely on: SQL injection, a compromised API process, or a compromised Auth container would be able to write other companies' ledgers.

**Evidence.** `grep -n -i "revoke\|grant" packages/db/migrations/*.up.sql | grep -i function` lists no revoke for the four functions. Their bodies (quoted in the audit notes) contain no reference to `app_current_tenant_id()`; `prune_sync_touches`, `erp_stock_lock_balance` and `erp_stock_lock_lot_balance` do. The schema-invariant suite checks that every security-definer function is declared and pins `search_path`, but not who may execute it (only `purge_tenant` is checked, at `schema-invariants.integration.test.ts:455`).

**Attack prerequisites.** Ability to run SQL as any database role: SQL injection, code execution in the `api`/`worker`/`auth` containers, or a leaked runtime password.

**Exploitation scenario.** An attacker with code execution in the Auth container (GoTrue connects as `supabase_auth_admin`) runs `select erp_ledger_try_post('<posting uuid>', '<uuid>', true)` for postings in other companies, or `erp_ledger_capture` with fabricated sources.

**Business impact.** Integrity of every company's general ledger; cross-tenant writes; misleading audit attribution (`p_actor` is caller-supplied).

**CVSS v4.0 (estimate):** `CVSS:4.0/AV:N/AC:H/AT:P/PR:H/UI:N/VC:N/VI:H/VA:N/SC:N/SI:H/SA:N`.

**Remediation.**

1. New migration (0022): `REVOKE ALL ON FUNCTION … FROM PUBLIC;` for every security-definer function, then `GRANT EXECUTE` only to the role that needs it (`integr8_app` for `erp_ledger_try_post` and `erp_ledger_backfill`; trigger functions need no grant).
2. Inside each function that takes a tenant or posting id, refuse a mismatch when called by the runtime role, as the stock locks do: `if current_user = 'integr8_app' and p_tenant is distinct from app_current_tenant_id() then raise …`; for `erp_ledger_try_post`, compare the posting's `tenant_id`.
3. Consider `ALTER DEFAULT PRIVILEGES … REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` in role bootstrap so new functions start closed.
4. Extend the schema-invariant suite: for every function in `SECURITY_DEFINER_FUNCTIONS`, assert `has_function_privilege` is false for `PUBLIC`, `integr8_auth` and `supabase_auth_admin`, and true only for the declared caller.

**Verification.** As `integr8_app` with `app.tenant_id` set to company A, call `erp_ledger_try_post` with a pending posting of company B and expect an error; as `integr8_auth`, expect `permission denied for function`.

---

## SEC-003 — Uploaded files are decoded by sharp/libvips whatever their declared type; sharp 0.35.4 carries a librsvg advisory

**Severity:** Medium
**Confidence:** Likely (the advisory's details were not reproduced; reachability confirmed from source)
**Affected component:** API worker (thumbnails), PDF image preparation
**Affected location:**

- `apps/api/src/media/thumbnails.ts:23` `sharp(original, { failOn: 'error', limitInputPixels })`
- `apps/api/src/documents/images.ts:52` `sharp(bytes, { limitInputPixels })`
- `apps/api/src/media/storage.ts:219-232` (`isAcceptableMediaType` refuses `image/svg+xml` by **declared** type only)
- `apps/api/package.json:46` `"sharp": "0.35.4"`

**CWE / OWASP:** CWE-1395 Dependency on Vulnerable Third-Party Component, CWE-434 (content-type trust).

**Description.** `pnpm audit` reports "sharp <0.35.5: vulnerability in librsvg dependency (CVE-2026-96889)". The upload path refuses SVG by the content type the client states, but sharp detects the format from the bytes. A file uploaded as `image/jpeg` whose bytes are SVG (or another libvips-supported format such as PDF/HEIF, depending on the bundled build) is decoded by the worker when it makes a thumbnail. The exact impact of the librsvg flaw was not verified here.

**Attack prerequisites.** Any company member who can upload a file (form photo, expense receipt, attachment).

**Exploitation scenario.** An engineer's phone, or a script with their token, uploads crafted SVG bytes declared as `image/jpeg`; the worker's thumbnail job hands them to librsvg.

**Business impact.** Depends on the CVE: at least worker crashes/resource exhaustion; possibly memory corruption in the worker, which holds the platform database connection (BYPASSRLS).

**Remediation.**

1. Upgrade sharp to ≥ 0.35.5 (exact pin, per `pnpm pins:check`).
2. Before resizing, read `await sharp(bytes).metadata()` and continue only for `jpeg`, `png`, `webp`, `heif`/`avif` (whatever the product supports); refuse everything else, SVG and PDF included.
3. Optionally verify magic bytes at upload completion and refuse a mismatch with the declared type.

**Verification.** Unit test `renderThumbnail` with SVG bytes and with a PDF: expect a refusal without libvips decoding (spy on `metadata().format`). Re-run `pnpm audit` and see the sharp advisory gone.

---

## SEC-004 — Forms for AI and the developer MCP program update themselves from unsigned binaries

**Severity:** Medium
**Confidence:** Confirmed by source tracing
**Affected component:** `apps/forms-ai` (installer/updater), `apps/dev-mcp` (installed program, uses the same setup profile), release workflow
**Affected location:** `apps/forms-ai/src/setup/update.ts:86-178` (checksum asset from the same release, `chmod 755`, replace own executable); MEMORY.md P43 D4 ("unsigned"); release job `dev-mcp` and `forms-ai` artifacts.

**CWE / OWASP:** CWE-494 Download of Code Without Integrity Check, CWE-345.

**Description.** The updater downloads the new executable and a `.sha256` file **from the same GitHub release** and compares them. That proves the download was not corrupted, not who built it: anyone able to publish or edit a release (a compromised maintainer token, `GITHUB_TOKEN` in a compromised workflow — see SEC-005) can ship both a malicious binary and its matching checksum. The binaries are not code-signed (MEMORY.md: "unsigned (D4)"; Windows/macOS will warn, users learn to click through). The developer MCP program additionally holds a staff session in the keychain.

The Tauri desktop updater, by contrast, verifies a minisign signature against `updater.key.pub` — the right model.

**Attack prerequisites.** Write access to the repository's releases (or the release workflow).

**Exploitation scenario.** A tampered release is published; staff machines with Forms for AI or the developer program accept the update on next check and run it with the staff member's privileges and keychain.

**Business impact.** Code execution on Integr8 staff machines; theft of staff sessions (full or limited).

**Remediation.** Sign update manifests with an offline key (minisign/Ed25519, as the desktop app does), embed the public key in the program, and verify the signature before replacing the executable. Add OS code signing when certificates are available. Prefer GitHub artifact attestations (`actions/attest-build-provenance`) as an additional check.

**Verification.** Unit test: an update whose checksum matches but whose signature is missing or made with another key is refused.

---

## SEC-005 — Release workflows run third-party actions pinned to mutable tags next to signing secrets

**Severity:** Medium
**Confidence:** Confirmed by source tracing
**Affected component:** `.github/workflows/*.yml`
**Affected location:** e.g. `tauri-apps/tauri-action@v1`, `pnpm/action-setup@v6`, `swatinem/rust-cache@v2`, `gitleaks/gitleaks-action@v3`, `dtolnay/rust-toolchain@stable`, `expo/expo-github-action@v9` (also `actions/*` by major tag); `release-main.yml:110-125` and `build-company-apps.yml:564-565` grant `contents: write`.

**CWE / OWASP:** CWE-829 Inclusion of Functionality from Untrusted Control Sphere; OWASP CI/CD-SEC-3 (dependency chain abuse).

**Description.** A tag can be moved by the action's owner (or whoever compromises them). Jobs that build releases hold the Tauri updater signing key, EAS/Apple/Google build secrets and a token able to write releases. A moved tag runs arbitrary code with those secrets, which also defeats SEC-004's checksum and could sign a malicious desktop update with the real key. `dtolnay/rust-toolchain@stable` is a branch, not even a tag.

Positive: untrusted inputs reach `run:` steps through `env:` rather than `${{ }}` interpolation (checked in `build-company-apps.yml`, `branch-policy.yml`, `ci.yml`), and no workflow uses `pull_request_target`.

**Remediation.** Pin every third-party action to a full commit SHA with the version in a comment; let Dependabot (`package-ecosystem: github-actions`) propose bumps. Give each job the least `permissions:` it needs and keep signing secrets in a protected GitHub environment with required reviewers.

**Verification.** A CI check (for example `zizmor` or a grep in `pins:check`) that fails on `uses: owner/repo@` not followed by a 40-character SHA.

---

## SEC-006 — Runtime dependencies with published advisories

**Severity:** Low (overall; individual reachability below)
**Confidence:** Confirmed by `pnpm audit` (run 2026-11-16 against `pnpm-lock.yaml`); reachability assessed from source
**Affected component:** workspace

`pnpm audit`: 1 critical, 26 high, 31 moderate, 13 low. Most sit in build or development tooling:

| Package (version)                                                  | Where                                  | Reachable in production?                                                                                                               |
| ------------------------------------------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| shell-quote 1.10.0 (critical)                                      | `react-native > react-devtools-core`   | No — developer tooling, not in the shipped bundle                                                                                      |
| node-forge 1.4.0 (many)                                            | `expo > @expo/cli`                     | No — build CLI                                                                                                                         |
| vite 8.2.2, undici 8.10.2, source-map-js                           | desktop dev server / jsdom tests       | No — dev and test only                                                                                                                 |
| @hono/node-server 2.1.5                                            | `@modelcontextprotocol/sdk` in dev-mcp | No — the server uses stdio, not HTTP                                                                                                   |
| kysely 0.28.9 (3 high)                                             | `packages/db`                          | Not as used: no `JSONPathBuilder.key()/.at()` with input, no `Kysely<any>`, the MySQL issue does not apply to Postgres. Upgrade anyway |
| sharp 0.35.4                                                       | `apps/api`                             | **Yes** — see SEC-003                                                                                                                  |
| zod 4.6.1 (memory exhaustion on oversized constrained collections) | API validation                         | Bounded by `API_MAX_BODY_BYTES` and per-route `bodyLimit`; upgrade                                                                     |
| fastify 5.12.3 (HTTP/2 trailer DoS; header `propertyNames`)        | `apps/api`                             | HTTP/2 is not enabled; routes validate with zod. Upgrade                                                                               |
| fast-uri (via ajv)                                                 | fastify / eta                          | Low relevance                                                                                                                          |

**Remediation.** Upgrade kysely ≥ 0.28.17, zod ≥ 4.6.6, fastify ≥ 5.12.6, sharp ≥ 0.35.5, and refresh the Expo/RN toolchain on its normal cadence. Add `pnpm audit --prod --audit-level high` to CI so production advisories fail the build while dev-only ones are reported.

**Verification.** `pnpm audit --prod` shows no high/critical advisories for API, web, desktop or mobile runtime packages.

---

## SEC-007 — Staff sign-in reveals which staff addresses exist through the lockout answer, and lets anyone lock staff out

**Severity:** Low
**Confidence:** Confirmed by source tracing
**Affected location:** `packages/auth/src/services/platform-session-service.ts:117-143`

**CWE:** CWE-204 Observable Response Discrepancy; CWE-645 Overly Restrictive Account Lockout.

**Description.** For an unknown address the service runs scrypt against a decoy and answers 401 — carefully uniform. For a known address it checks `lockedUntil` **first** and answers 423 `auth.account_locked`. Five wrong attempts (`PLATFORM_LOCKOUT_THRESHOLD`) against a guessed address therefore tell an outsider it is a staff account (a 6th attempt gets 423), and lock that staff member out for 15 minutes, repeatably. Company sign-in locks per address too (10 per hour), but answers the same for unknown addresses, so only the lockout half applies there.

**Remediation.** Answer a locked account with the same 401 and message as any other failure (log the lock server-side), or apply a decoy "locked" state to unknown addresses after the same number of failures. Consider per-IP plus per-account throttling instead of a hard lock for staff.

**Verification.** Test: six failures for an unknown address and six for a known one produce identical status codes and bodies.

---

## SEC-008 — Staff authenticator codes can be replayed inside their 90-second window

**Severity:** Low
**Confidence:** Confirmed by source tracing
**Affected location:** `packages/auth/src/totp.ts:42-60`; `platform-session-service.ts:137`

**CWE:** CWE-294 Authentication Bypass by Capture-replay.

**Description.** `verifyTotp` accepts the current step ±1 and records nothing, so a code observed (shoulder-surfed, phished in real time, or logged) together with the password can be used again for up to ~90 s.

**Remediation.** Store the last accepted counter per staff account and refuse a counter ≤ the stored one.

**Verification.** Test: the same valid code succeeds once and fails on immediate reuse.

---

## SEC-009 — Capability tokens (quote links, document codes) are written to the API's request logs

**Status:** Open, reduced: the keyless public routes are gone, but the website routes still carry the
code or token in their path (`/v1/website/documents/by-code/:code`, `/v1/website/quotes/by-token/:token`).

**Severity:** Low
**Confidence:** Confirmed by source tracing
**Affected location:** `apps/api/src/server.ts:146-151` (child logger with `path: request.url`), `apps/api/src/routes/v1/sales-public.ts` (`/v1/public/quotes/:token`), `documents-public.ts` (`/v1/public/documents/:code`), `public/asset-tags/:code`.

**CWE:** CWE-532 Insertion of Sensitive Information into Log File.

**Description.** The 256-bit quote token and the 128-bit document code are bearer capabilities: whoever holds one can read (and, for quotes, accept or decline) without an account. Every log line for those requests carries the full URL, so anyone with log access (the machine, Sentry breadcrumbs if forwarded, log shipping) gains them. The logger's key-based redaction does not inspect path segments.

**Remediation.** Log the route template (`request.routeOptions.url`) instead of `request.url`, or mask known capability segments.

**Verification.** Logger unit test: a request to `/v1/public/quotes/<token>` logs `/v1/public/quotes/:token`.

---

## SEC-010 — The public site's content-security policy is report-only and allows inline script

**Severity:** Low
**Confidence:** Confirmed by source tracing
**Affected location:** `apps/web/src/lib/content-security-policy.ts:56,83-84`

**Description.** The enforced header is only `frame-ancestors 'none'`; the full policy is `Content-Security-Policy-Report-Only` and its `script-src` includes `'unsafe-inline'`. The site serves quote links with customer data and the invitation page that sets a password. No XSS sink was found (no `dangerouslySetInnerHTML` anywhere in the workspace), so this is defence in depth.

**Remediation.** After the observation period MEMORY.md mentions, enforce the policy, replacing `'unsafe-inline'` with nonces (Next.js supports per-request nonces in middleware) or hashes.

**Verification.** Response headers carry an enforced `Content-Security-Policy` without `'unsafe-inline'` in `script-src`.

---

## SEC-011 — Desktop hardening gaps

**Severity:** Low
**Confidence:** Confirmed by source tracing
**Affected location:**

- `apps/desktop/src-tauri/src/lib.rs:18-19` — service `"Integr8 Plus"`, account `"session"` for every build
- `apps/desktop/src-tauri/tauri.conf.json` (`security.csp`) — `http://localhost:3000` stays in `img-src`/`connect-src`; `scripts/stamp.mjs:100-104` replaces only the placeholder API host
- `apps/desktop/src/features/forms/model/recovery.ts:92-108` — form drafts in `localStorage`

**Description.** (a) Every company build and the staff build read and write the same OS keychain item, so on a shared Windows/macOS account one company's app reads another's refresh token, and signing into one overwrites the other. (b) A release build may talk to any local service on port 3000. (c) Unsubmitted form answers (which can include customer and personal data) persist in plain `localStorage` on disk. Tauri capabilities are otherwise narrow (`core:default`, `updater:default`, `opener:default`; three keychain commands with no arguments beyond the value), the CSP forbids inline and remote script, and the updater is signed.

**Remediation.** Use the stamped bundle identifier as the keychain service name; strip localhost origins from the CSP in `stamp.mjs` for release builds; keep drafts in the keychain-protected store or encrypt them with a key held in the keychain, and clear them on sign-out.

**Verification.** Two company builds on one machine keep separate sessions; a release `tauri.conf.json` contains no `localhost`.

---

## SEC-012 — The developer MCP server lets the model choose the environment variable name a website key is written under

**Severity:** Low
**Confidence:** Potential
**Affected location:** `apps/dev-mcp/src/website.ts:115-124` (`writeEnvValues(envFile, { [keyName]: key.secret, … })`), `apps/dev-mcp/src/envfile.ts:20-40`

**Description.** The tool keeps the key out of the model's view, but `keyName` is model-supplied and only checked as upper-case letters, digits and underscores. A model steered by injected text can name it `NEXT_PUBLIC_…`, which Next.js inlines into the browser bundle, publishing a server-only website key. Impact is limited to test companies today.

**Remediation.** Refuse names starting `NEXT_PUBLIC_`, `VITE_`, `EXPO_PUBLIC_`, `PUBLIC_` (or fix the name and drop the parameter).

**Verification.** Unit test: `keyName: 'NEXT_PUBLIC_X'` is refused.

---

## SEC-013 — Off-machine database backups are not encrypted before they leave the machine

**Severity:** Low
**Confidence:** Confirmed by source tracing
**Affected location:** `deploy/vps/backup-postgres.sh:140-165` (`rclone copyto` of the plain dump)

**Description.** Local copies are `umask 077`/`chmod 700`, but the dump is sent to `BACKUP_REMOTE` as-is. It contains every company's data and the `auth` schema's password hashes (HR identifiers are sealed with AES-GCM and stay protected). Security then rests entirely on the remote's access control.

**Remediation.** Encrypt client-side before upload (`age` to a recipient key kept off the machine, or an rclone `crypt` remote), and keep the decryption key out of `deploy/.env`. Update `restore-drill.sh` and the setup guide together.

**Verification.** Objects in the remote bucket are not readable as SQL; the restore drill decrypts with the offline key.

---

## SEC-014 — The API trusts every `X-Forwarded-For` hop (Informational)

`apps/api/src/server.ts:97` sets `trustProxy: true`. The client address used for sign-in throttling and the per-IP rate limit is the left-most `X-Forwarded-For` entry. Today the API binds to `127.0.0.1` (`deploy/compose.yml:329-330`) behind Caddy, which by default does not pass a client-supplied `X-Forwarded-For` through, so this is safe as deployed. It becomes spoofable if the port is ever published or another proxy appends instead of replacing. **Recommendation:** `trustProxy: '127.0.0.1'` (or the Docker bridge range), matching the real topology.

## SEC-015 — A refreshed impersonation token silently loses its `imp` claim if the grant row is missing (Informational, Potential)

**Status:** Fixed with SEC-001: a refresh whose grant cannot be read is refused.

`packages/auth/src/services/session-service.ts` `#impersonationClaim` returns `undefined` when the grant is not found, and `#issuePair` then mints a token **without** `imp`. Such a token skips `assertStillPermitted`, while `assertLive` still treats the session as impersonated and live without a membership. Grant rows are not deleted outside the purge, so no path to this was found. **Recommendation:** throw (and revoke the session) when a session has `impersonationGrantId` but the grant cannot be read; also refuse refresh once the grant has ended.

## SEC-016 — Staff accounts are all equal (Informational)

`apps/api/src/routes/v1/platform/staff.ts:99-209`: any full staff session can create staff, reset another staff member's credentials and remove staff. With a small team this is a choice, but one stolen full session can mint a persistent staff account. **Recommendation:** restrict staff management to the CLI on the machine, or require a fresh second factor and notify all staff on these actions.

## SEC-017 — Website-key routes answer for any job/invoice by id and return invoice `notes` (Informational, Potential)

**Status:** Open. Related change made: every website-key route now needs the company to have a
website (403 `website_missing`).

`apps/api/src/routes/v1/website-data.ts`: `GET /v1/website/jobs/:id` returns any job's title and state (no "shared" switch, unlike documents); `GET /v1/website/invoices/:id` returns `notes`, while the description says "internal notes are never exposed". Ids are UUIDs and keys are server-side, so this is minor. **Recommendation:** confirm `notes` is customer-facing text, or drop it; consider a per-record "visible to website" flag for jobs.

## SEC-018 — Smaller hardening items (Informational)

- `deploy/compose.yml:211` `image: postgres:16` is a moving tag; pin a patch version and digest (Auth is pinned to `v2.197.0`).
- `apps/api/src/documents/printer.ts:150-157` launches Chromium without its sandbox; mitigated by `javaScriptEnabled: false`, `offline: true` and aborting every non-`data:` request, and the container runs as `node`.
- `apps/api/src/http/rate-limit.ts` fails open when its store is unreachable, and every request costs a database round-trip for the per-IP bucket. Acceptable trade-off; consider an in-memory first tier.
