# MCP security audit — Integr8 Plus

Two MCP servers live in this repository:

| | MCP Server 1: **Integr8 Forms for AI** | MCP Server 2: **Integr8 developer MCP server** |
| --- | --- | --- |
| Package | `apps/forms-ai` (`@integr8/forms-ai`) | `apps/dev-mcp` (`@integr8/dev-mcp`) |
| Who runs it | Integr8 staff, installed as a single executable (Node SEA) and registered in their AI tools by the bundled installer | Developers, from the repository (`.mcp.json`: `pnpm dev-mcp serve`) or as the installed program `integr8-dev-mcp` (P43) |
| Transport | stdio only | stdio only |
| Network | **None** to the platform (`offline.test.ts` asserts no tool makes a network request); a loopback preview page on `127.0.0.1`; GitHub's public API for update checks | HTTPS to the configured Integr8 API (remote mode) or a local API it starts (local mode); signed upload links (R2) |
| Credentials | None | A staff session limited to test companies (`scope: test_companies`, 8 h), kept in the OS keychain (`@napi-rs/keyring`); website keys it creates, kept in the same vault |
| Filesystem | Reads/writes `.integr8form` files and change-request folders where the model says (absolute paths) | Same as Server 1 (it registers every Server 1 tool), plus `.env*.local` files, `plan/requests/` in the checkout, a trace folder (`0700`) |
| Tools | 23 | 45 (15 own + 7 website + 23 from Server 1) |

Both servers are local, single-user, stdio processes: there is no network listener for MCP itself, so origin checks, OAuth, token audience and session-id handling for Streamable HTTP do **not apply**. The relevant boundaries are (1) the model and whatever text it has read (prompt injection), (2) the local filesystem, and (3) for Server 2, the platform API and its staff session.

---

## MCP Server 1 — Integr8 Forms for AI

### Transport and process security

- **stdio only.** `apps/forms-ai/src/main.ts` / `mcp/server.ts`; no HTTP MCP endpoint.
- **Preview window server** (`apps/forms-ai/src/window/server.ts`): binds `127.0.0.1` on a random port (line ~447); every request must carry `Host: 127.0.0.1:<port>` exactly (defeats DNS rebinding), the 192-bit random token `?k=` compared with `timingSafeEqual`, and, if present, `Origin: http://127.0.0.1:<port>`; JSON bodies need `application/json`; responses carry a strict CSP, `Cross-Origin-Resource-Policy: same-origin`, `Cross-Origin-Opener-Policy: same-origin`. The page bundle has a `no-eval` guard. **PASS.**
- **Opening the browser** (`window/open-browser.ts`): the URL must match `^http://127\.0\.0\.1:\d+/\?k=[0-9a-f]+$` before `spawn` (no shell; Windows uses `rundll32 url.dll,FileProtocolHandler`). **PASS.**
- **PDF previews** run the machine's Chrome/Edge through CDP (`preview/*`); HTML is produced by `@integr8/document-render`, which escapes every text value.
- **Self-update** (`setup/update.ts`): downloads the new executable and a `.sha256` from the same GitHub release; no signature → **SEC-004**.

### Tool inventory

| Tool | What it does | Privileges | Input validation | Can model/external content alter it? | Tenant / secrets / side effects | Impact if called maliciously |
| --- | --- | --- | --- | --- | --- | --- |
| `get_format_guide` | Returns the form format guide generated from the real schemas | none | zod | no | none | none |
| `list_examples`, `get_example` | Built-in example forms | none | zod, fixed list | no | none | none |
| `new_picture_ids` | Fresh UUIDs for pictures | none | count bounded | no | none | none |
| `check_form`, `check_package` | Run the app's own validation on a form/package | none | zod + form-engine | content is data | none | CPU only (bounded sizes) |
| `get_interview_guide`, `summarize_form` | Guidance text / a summary of a form | none | zod | form text is echoed back to the model — injection text in a form reaches the model as data | none | low |
| `preview_pdf` | Renders a PDF preview through local Chrome/Edge | local browser process | zod; HTML escaped | form text is rendered, escaped | none | local CPU |
| `save_package` | Writes a `.integr8form` to a folder the model names | user's filesystem | absolute path; `flag: 'wx'` for new files; name derived from title | model chooses folder | writes anywhere the user can | overwrite only through its explicit replace path; same reach the AI tool already has |
| `open_package` | Reads a `.integr8form` from an absolute path; strict ZIP reader (`@integr8/form-package`), size cap | user's filesystem | absolute path, size limit, strict unpack | model chooses path | reads only valid packages | a non-package file is refused, so arbitrary file reading is not useful |
| `open_preview`, `update_preview`, `get_preview_state`, `close_preview` | Loopback preview page | local HTTP on 127.0.0.1 | see transport | form content rendered by the web filler (React, no `innerHTML`) | none | none beyond local page |
| `get_website_guide`, `get_website_api`, `get_website_example`, `check_website_integration` | Help an AI tool add the document search to a company's Next.js site; `check_*` reads the site's files | read-only filesystem | zod | site files are read as data | could read `.env` files in the site folder if pointed at them — returned as findings, not executed | low |
| `record_change_request`, `update_change_request`, list/get draft requests | Writes/reads `<output>/change-requests/CR-<n>-<slug>/` | filesystem | slug pattern, numbered folders | model writes the text | none | low |

**Authorization:** not applicable — no credentials, no platform access. **Tenant isolation:** not applicable (offline). **Secrets:** none held.

### Findings for Server 1
- **SEC-004 (Medium)** — unsigned self-update.
- **Prompt-injection note (Informational):** form text, examples and website files are returned to the model verbatim. Since the server has no credentials and no network, the worst outcome is the model writing a bad file where the user can already write. No change needed beyond keeping it offline (the `offline.test.ts` guard is valuable — keep it).

**Assessment:** well-contained. Its risk is supply chain (updates), not runtime.

---

## MCP Server 2 — Integr8 developer MCP server

### Transport, authentication and credentials

- **stdio only** (`apps/dev-mcp/src/cli.ts serve`). No listener of its own; local mode starts an API on `127.0.0.1` and refuses unless `APP_ENV` is development/test (`local.ts`).
- **Sign-in happens in a terminal, never through the model** (`pnpm dev-mcp login`): password + authenticator code, and the CLI always requests `scope: 'test_companies'` (`cli.ts:106`). The session lasts 8 hours and cannot be extended by refresh (`platform-session-service.ts`: refresh keeps `sessionExpiresAt` and scope).
- **Storage:** tokens in the OS keychain; website keys in the same vault and never shown to the model (`create_website_key` writes them to a file instead).
- **Trace file:** requests/answers with tokens, passwords, codes and signed links redacted (`redact.ts`); folder `0700`, refuses symlinks or another user's folder.
- **Server-side confinement (the platform API):** platform routes declare `platformScopes`; a limited session is refused elsewhere with 403 `session_scope` and audited; routes naming `:tenantId` refuse non-test companies (`apps/api/src/http/session-scope.ts`, pinned in `session-scope.test.ts`); `GET /v1/platform/companies` returns only test companies to it. **PASS for platform routes.**
- **Impersonation:** each `call_api` acts through an audited impersonation grant with reason `Developer MCP: <purpose>`; a grant is reused only for the same purpose, so each purpose lands in the company's audit log. The grant records `from_limited_session`.

### The critical gap — SEC-001

Tenant routes reached with the impersonation token are **not** confined. `call_api` refuses only `/v1/platform/*`, and three tenant routes act across companies on the impersonation claim alone (`/v1/forms/copy-targets`, `/v1/forms/:formId/copy-to-company`, `/v1/forms/:formId/library-template`). A model under prompt injection can list real companies and write into them or into the shared template library. Full details and fix in `VULNERABILITIES.md#sec-001`.

### Tool inventory (Server 2's own 22 tools; the other 23 are Server 1's, above)

| Tool | What it does | Who can call it | Privileges | Input validation | Authorization enforced | Model/external content influence | Other tenants? | Secrets? | Dangerous side effects | Impact if malicious |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `status` | Mode, API, staff account, session time, grants, trace file | the AI tool | staff session (read) | none | API: `GET /v1/platform/me` | no | no | shows no tokens | none | none |
| `list_test_companies` | Test companies | AI | staff (read) | none | API filters to test companies | no | no | no | none | none |
| `create_test_company` | Local mode: runs the seeder via `pnpm` | AI | local process | email/name/sections against strict patterns (`safeSeedInput`); Windows shell quoting guarded | local mode only | model chooses name | no | no | creates data locally | local CPU |
| `use_company` | Chooses a test company, lists its people | AI | impersonation (as company) | must match a listed test company | API scope checks | no | no | no | opens a grant | none |
| `find_route`, `get_route` | Search/read the bundled OpenAPI | AI | none | zod | — | no | no | no | none | none |
| `call_api` | Any tenant route as a person in the chosen test company; public routes as a visitor | AI | impersonation (owner when "company") | schema check (can be skipped with `skipCheck`), refuses `/v1/platform/*` and website-key routes | API permissions for that seat; **no cross-tenant confinement** | fully model-driven | **Yes, via SEC-001** | no | any write the seat may make; destructive hint set | writes into real companies / library via SEC-001 |
| `get_trace` | Recent requests/answers | AI | local | ids bounded | — | — | no | redacted | none | none |
| `get_audit` | Company audit lines | AI | staff (`test-audit`, test companies only) | zod | API scope | no | no | no | none | none |
| `read_outbox` | Mail/push test companies would have sent | AI | staff (test companies only) | zod | API scope | no | no | may show sign-in codes sent to test people (test only) | none | low |
| `import_form_package` | Uploads a local `.integr8form` into the test company, optionally publishes | AI | impersonation | absolute path; refuses anything but a `.integr8form` ZIP before sending | API (staff-only `form.manage`) | model chooses path | no | no | creates/publishes a form in a test company | low |
| `submit_form` | Fills and submits a form as a person | AI | impersonation | zod + API | API | model-driven | no | no | creates submissions | low (test data) |
| `list_change_requests`, `get_change_request` | Read `plan/requests/` | AI | filesystem (repo) | numbered entries | — | file text reaches the model (an injection source) | no | no | none | none |
| `hand_over_change_request` | Copies a recorded request into `plan/requests/` and adds a README row | AI | filesystem (repo) | numeric id 1–9999; repository path must contain `plan/requests` and `apps/api/openapi.json` | — | model-driven | no | no | writes in the checkout | low |
| `create_website_key` | Makes a website key for the test company, keeps it, optionally writes it to `.env*.local` | AI | staff (test companies only) | `envFile` absolute and named `.env*.local`, plain file | API scope | `keyName` is model-chosen → **SEC-012** | no | key never shown to the model | creates a key (max two live) | key could be written under a public env name |
| `write_website_env` | Writes a kept key and API URL into `.env*.local` | AI | filesystem | as above; file left `0600` | — | `keyName`/`urlName` model-chosen → SEC-012 | no | writes the secret to disk | overwrites those two lines | same |
| `list_website_keys`, `revoke_website_key` | List/revoke keys | AI | staff | UUID | API scope (key and company both matched) | no | no | hints only | revokes a test key | low |
| `set_website_access` | Switches `documents` and `website_*` flags, `websiteUrl`, `documentLinkPattern` | AI | staff | API allows only these fields for the limited session; localhost only for test companies (migration 0021) | API scope | model-driven | no | no | changes test company settings | low |
| `call_website_api` | Calls `/v1/website/*` with a kept key | AI | website key | route must be a website route | key's own company | model-driven | no | key never shown | read-only routes | low |
| `seed_shared_documents` | Uploads made-up PDFs or prints from submissions in the test company | AI | impersonation | counts bounded | API | model-driven | no | no | creates documents | low |

### Injection and confused-deputy assessment

- **Sources of untrusted text that reach the model:** change requests (`plan/requests/`), form files, API answers (company data, audit lines, outbox mail), website repository files. All are returned as tool output; none is executed by the server.
- **Instruction laundering:** tool descriptions are static strings in source; no tool description is built from external data. **PASS.**
- **Confused deputy:** the server holds a staff credential; its safety depends on the API refusing what the scope forbids. That holds for platform routes and fails for the cross-company tenant routes (SEC-001).
- **SSRF:** the API base URL comes from the signed-in configuration, not from tool arguments; `uploadTo` PUTs only to signed links returned by the API. **PASS.**
- **Command execution:** `spawn` only in local mode with fixed arguments and pattern-checked inputs; `program.ts` runs fixed `login` with the API URL as an argument (no shell on POSIX). **PASS (reviewed).**
- **DoS:** request sizes bounded by zod schemas; the API rate-limits per tenant.

### Findings for Server 2
- **SEC-001 (High)** — limited session escapes through impersonation to cross-company routes.
- **SEC-004 (Medium)** — installed program updates from unsigned binaries (shares Server 1's updater; it also holds a staff session).
- **SEC-012 (Low, Potential)** — model-chosen env var name can publish a website key.

**Assessment:** carefully built (terminal-only sign-in, keychain, redacted traces, audited grants per purpose, server-side scope checks). One serious hole in the API's enforcement undermines the central promise "only test companies".

---

## Integration risks between the two servers

- Server 2 imports Server 1's tools (`@integr8/forms-ai/tools`, the one allowed app-to-app import). A form built offline with Server 1 can be imported and published with Server 2 in one model turn. Combined with SEC-001, a form file containing injected instructions could lead the model to copy that form into real companies or the library. Fixing SEC-001 closes this chain.
- Both servers share the same updater design (SEC-004).

## Remediation summary (MCP)

| Priority | Action | Finding |
| --- | --- | --- |
| 1 | Carry "limited" into impersonation tokens; refuse limited impersonations on cross-tenant routes; pin the list in a test | SEC-001 |
| 2 | Signed update manifests verified against an embedded public key | SEC-004 |
| 3 | Refuse public env-var prefixes for website keys | SEC-012 |
| 4 | Optional: `call_api` deny-list of cross-tenant operation ids | SEC-001 (defence in depth) |
