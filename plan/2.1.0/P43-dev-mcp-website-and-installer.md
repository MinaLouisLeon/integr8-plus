# P43 — Developer MCP server: company websites, and an installable program

**Status:** IN PROGRESS — built 2026-11-16 on branch `ccr-3cd2290c-d9znqu`; waiting for the first release run and the owner's run on Windows

## Goal

The developer MCP server (`apps/dev-mcp`) becomes the one tool for building and
testing a company's website against a real API, from any repository. The website
will live in its own repository, not in integr8-plus. Two parts:

1. **Website work in test companies.** The server sets a test company up for its
   website (a key, the switches, the address and the link pattern), calls the
   `/v1/website` routes exactly as the website's server would, and makes shared
   documents with known search values to find.
2. **An installable program.** Like Forms for AI, one executable per operating
   system that, double-clicked, finds the AI tools on the machine and adds itself
   to each, signs in, and updates itself, with no integr8-plus checkout needed.

## Scope

**In:**

- (a) Website setup for test companies: API routes the limited staff session may
  use, and MCP tools over them.
- (b) `call_website_api`: requests sent with the test company's website key.
- (c) `seed_shared_documents`: made and uploaded documents, shared, with chosen
  field values.
- The installable program: SEA build, terminal installer, AI tool detection,
  sign-in, updates, release run, the staff app's Downloads page.
- Docs (`docs/contributing/developer-tools.md`, `docs/documents/`) and this plan.

**Out:**

- Changing how a real company's website works: the `/v1/website` routes, the
  search rules (exact match, any searchable field) and the link pattern for real
  companies are unchanged. Whether search names one field, and Arabic-digit
  normalisation, are separate decisions the owner has not taken yet.
- Code signing (D4: unsigned for now; P20 if certificates are bought).
- Merging the program with Forms for AI (D3: they stay separate).
- The company website itself (built by the owner in another repository).

## Where things stand

- **Running from another repository already works**, from source: the server finds
  its own checkout from `import.meta.url` (`apps/dev-mcp/src/paths.ts`, `REPO_ROOT`),
  reads `apps/api/openapi.json` and the version there, and keeps the sign-in in the
  keychain per API, not per folder. An AI tool in another folder starts it with
  `pnpm --silent --dir <integr8-plus> dev-mcp serve`. The website tools take
  absolute paths (`check_website_integration`'s `paths`).
- **Website tools exist, offline:** `get_website_guide`, `get_website_api`,
  `get_website_example`, `check_website_integration` (`apps/forms-ai/src/website/`),
  carried by the developer server through `registerFormsTools`.
- **What the server cannot do today:**
  - Website keys are made only by full staff sessions:
    `/v1/platform/companies/:tenantId/website-keys` (list, create, revoke, delete in
    `apps/api/src/routes/v1/platform/website-keys.ts`) declare no `platformScopes`,
    so a `test_companies` session gets 403 `session_scope`.
  - Integr8's `website_files` switch (`PUT /v1/platform/companies/:tenantId/flags/:key`,
    `platform/settings.ts`) and the website address and link pattern
    (`PUT /v1/platform/companies/:tenantId/settings`, `platform/companies.ts`) are
    full-session only too. Only `GET`/`POST /v1/platform/companies` and
    `GET /v1/platform/companies/:tenantId` allow the limited session.
  - The company's own switch (`PUT /v1/settings/website-access`) is a company route,
    so `call_api` as the owner already reaches it.
  - `call_api` treats routes with `websiteKeyAuth` (`security: 'website_key'` in
    `apps/dev-mcp/src/openapi.ts`) like signed-in routes: it sends a person's token,
    which the website routes refuse with 401 `website_key_invalid`.
  - Uploaded documents (`POST /v1/documents` with an uploaded `fileId`, typed
    fields through `PUT /v1/documents/:documentId/fields`) need a file upload the
    server cannot send; the demo seeder cannot either.
  - The link pattern must be `https` on the registered website's host
    (`documentLinkPatternProblem`, `apps/api/src/documents/render.ts`), so it cannot
    point at a website running on the developer's laptop.
- **The installer to copy from:** Forms for AI's `apps/forms-ai/src/setup/`
  (`tools.ts` adapters for Claude Code, Codex, Claude Desktop, Cursor, VS Code,
  Windsurf, Gemini CLI; `jsonc.ts`, `toml.ts`, `update.ts`, `install-self.ts`,
  `self-test.ts`), its SEA build `apps/forms-ai/scripts/build-sea.mjs`, the release
  job `forms-ai` in `.github/workflows/build-release-artifacts.yml`, and the asset
  names in `packages/releases/src/feed.ts` (`formsAiAssetOf`), which the staff
  app's Downloads page lists (`GET /v1/platform/downloads`).
- **The keychain is a native module:** `@napi-rs/keyring` (`apps/dev-mcp/src/store.ts`)
  ships a `.node` file per platform, which a single executable cannot load from
  inside itself. `--file-store` exists as a fallback for machines with no keychain.
- **The open known issue** (MEMORY.md): Forms for AI's update check reads GitHub's
  public API and finds nothing in the private repository. The new program has the
  same problem, solved once for both here (see Design, Updates).

## The owner's decisions (2026-11-16)

| #   | Question                                                       | Answer                                                                               |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| D1  | Where does the installed program keep the sign-in and keys?    | In the keychain, with the native keychain module shipped next to the executable      |
| D2  | May a test company's link pattern point at `http://localhost`? | Yes, test companies only; real companies keep `https` on their registered website    |
| D3  | One program with Forms for AI, or two?                         | Two: Forms for AI keeps its promise of offline and no sign-in                        |
| D4  | Sign the executables?                                          | Unsigned for now, like Forms for AI (Windows "Run anyway", macOS right-click → Open) |

## Design

### (a) Website setup for test companies

**API.** Add `platformScopes: ['full', 'test_companies']` to:

- the five website-key routes;
- `PUT /v1/platform/companies/:tenantId/flags/:key`, but in a limited session only
  for the flags a website needs (`website_files`, `website_jobs`, `website_quotes`,
  `website_invoices`); any other flag answers 403 `session_scope`;
- `PUT /v1/platform/companies/:tenantId/settings`, but in a limited session only
  `websiteUrl` and `documentLinkPattern`; any other field answers 403
  `session_scope`.

The existing check (`http/session-scope.ts`) already refuses a limited session on
a real company, and the list pinned in `session-scope.test.ts` grows by these
routes. Each change is audited as today, under the limited session.

**Localhost for test companies (D2).** `documentLinkPatternProblem` and the
`websiteUrl` schema accept `http://localhost:<port>` and `http://127.0.0.1:<port>`
when the company is a test company (`tenants.is_test`), and refuse it otherwise
with the same codes as today. No migration: `is_test` exists (0077 in 1.x, in the
2.0.0 baseline).

**MCP tools.**

- `create_website_key` (label): makes a key for the chosen test company, returns the
  secret **once** so the developer can put it in the website's `.env.local`, and
  keeps it in the keychain under the API and company for `call_website_api`.
- `list_website_keys`, `revoke_website_key`: list and revoke; revoking also removes
  the stored copy.
- `set_website_access`: one call that sets Integr8's switches, the company's own
  switch (through the company route, as the owner), `websiteUrl` and
  `documentLinkPattern`, and reports what each is now.

### (b) `call_website_api`

- Takes `method`, `path`, `query`, `body`, `purpose`, and optionally which stored key
  to use. Only routes whose security is `website_key` are accepted; anything else
  points to `call_api`.
- Sends `Authorization: Bearer <stored key>` and the client headers, with no person
  and no impersonation grant: the API sees exactly what the website's server sends.
- Returns status, body, timing, request id, and the key's last-used time and
  outcome (from the website-key list), so a test can see `recordUse` happened.
  The key is hidden in the trace (`redact.ts` already lists `websitekey`; the
  `Authorization` header is already hidden).
- `call_api` on a `website_key` route stops sending a person's token and answers
  "use `call_website_api`".

### (c) `seed_shared_documents`

- Input: a list of documents, each either
  - **made**: a published form with a lookup key on its PDF template, the answers,
    and the key's value; made through `submit_form`'s path, so the server prints the
    PDF; or
  - **uploaded**: a title and up to 10 typed fields (name and value); the server
    generates a small one-page PDF naming those values, uploads it through the
    normal media upload, creates the document and sets its fields.
- Every document is then shared (`POST /v1/documents/:documentId/share`). Options:
  an expiry, or left not shared, so the site's `found: false` path can be tested
  too.
- Output: each document's id, code, link (following the link pattern), and its
  searchable values, ready to type into the search page.
- The upload path is a new helper in the developer server (multipart where the
  media route needs it); it uses only company routes, as the company's people.

### The installable program

**Build.** `apps/dev-mcp/scripts/build-sea.mjs`, modelled on Forms for AI's: a
Node single executable per OS (Windows x64, macOS arm64 and x64, Linux x64),
named `integr8-dev-mcp-<version>-<os>-<arch>[.exe]` with a `.sha256` beside it.
It carries, as SEA assets:

- the `apps/api/openapi.json` of its release, so it describes the API without a
  checkout; at start it compares with the API's reported version and warns on a
  mismatch;
- the Forms for AI tools and the preview page (`dist/window/page.{js,css}`), as the
  developer server already registers them;
- `--check-assets`, run by the build like Forms for AI's.

**Keychain (D1).** The archive per OS is the executable plus the matching
`@napi-rs/keyring` `.node` file in the same folder (a `.zip` for Windows and macOS,
a `.tar.gz` for Linux). The program loads it from beside itself
(`process.execPath`). If it is missing or the machine has no keychain, the
existing `--file-store` choice is offered at sign-in.

**Shared installer code.** Forms for AI's setup code moves to a place both
programs import (`@integr8/forms-ai/setup`, the same allowed app-to-app import as
`@integr8/forms-ai/tools`), parameterised by program name, server key in the AI
tools' configs (`integr8-dev`), executable path and arguments. Forms for AI's
behaviour is unchanged and its tests stay green.

**Double-clicked**, it opens a terminal installer:

1. Copies itself (and the keychain file) to the user's programs folder.
2. Finds the installed AI tools and asks which to connect (all found ones
   ticked); writes each one's global config with `integr8-dev` → the installed
   executable `serve`, keeping a backup of the file as Forms for AI does.
3. Asks for the API address (default `https://api.integr8-media.com`) and signs
   in with a staff account (password and authenticator code, echo off), storing a
   `test_companies` session.
4. Runs a self-test (starts `serve`, lists the tools) and says what to do next.

Commands stay those of `pnpm dev-mcp`: `login`, `logout`, `status`, `serve
[--api …]`, plus `setup` (the installer), `update`, `uninstall` (removes it from
every AI tool's config). `--local` exists only when run from a checkout.

**Without a checkout.** `hand_over_change_request` needs the integr8-plus folder:
it takes a `repository` path argument (remembered in the program's settings) and
is refused with a clear message when none is given. `list_change_requests` and
`get_change_request` read the same folder.

**Updates.** The program checks the release feed through the API
(`GET /v1/platform/downloads`, signed in), not GitHub's public API, so it works
with the private repository. Forms for AI cannot sign in, so its own update check
stays as it is (still the open item); the installer of the developer program
offers to update an installed Forms for AI too.

**Release and downloads.** A `dev-mcp` job in `build-release-artifacts.yml` beside
`forms-ai`; the publish step downloads `dev-mcp-*` too; `packages/releases` gains
`devMcpAssetOf`; the staff app's Downloads page lists it under Forms for AI, staff
only. Not on the public `/download`.

**Unsigned (D4).** The Downloads page and the docs say what each OS shows on first
open and how to get past it, as for Forms for AI.

## Implementation notes (2026-11-16)

Where the build differs from the design above:

- **A migration after all: 0021.** The database itself only accepted `https`
  websites and link patterns (`tenant_settings` check constraints), so
  `0021_test_company_localhost` widens both shapes to `http://localhost` and
  `http://127.0.0.1`, with a trigger refusing them for any company that is not a
  test company (a check constraint cannot see `tenants.is_test`).
- **The key is never shown.** The website guide says the key must not pass through
  the AI, and this server hides every secret, so `create_website_key` writes it
  into the website's `.env.local` (only `.env*.local` files) instead of returning
  it, and `write_website_env` writes a kept key later. Keys are kept in the same
  keychain entry family as the session (`<api>#website-keys`), forgotten on logout.
- **The staff-manager rule guards real companies only.** A test company's keys
  reach only test data, which any staff session can already read, and local
  mode's tool account is not a manager; so for a test company any staff member may
  make, disable, revoke and delete keys. `documents` joined the `website_*` flags a
  limited session may set (the website routes need the module too).
- **Made documents are printed from a submission** (`submissionId` + `templateId`,
  after `submit_form`), not from a form and answers in one go; seeding waits up to
  90 s for the worker. Uploaded documents use a one-page PDF written without a
  library (`src/pdf.ts`).
- **Release files.** Per computer: a `.zip` (program + `integr8-keyring.node`, the
  first download), the program alone and `integr8-dev-mcp-keyring-…node` alone,
  each with a `.sha256` (updates). The zip is written by the build script on
  Node's zlib, so every runner makes it the same way. The program carries the
  product version (as Forms for AI does), so updates compare like with like.
- **Local mode fix.** Local mode's API listened on a random port while signing
  upload links for port 3000, so no upload worked in local mode;
  `apps/api/src/demo/local-api.ts` now picks its port first and passes it as
  `API_PUBLIC_URL`.
- **Forms for AI's installer is driven by a `SetupProfile`** (`FORMS_PROFILE` keeps
  its behaviour; the developer program supplies `DEV_PROFILE` in `src/program.ts`),
  and the AI-tool adapters take the server's name from the context.

## Tasks (in commit order)

1. `feat(api)`: test-company scopes on the website-key, flag and settings routes,
   with the field and flag limits; localhost link patterns and website addresses
   for test companies; `session-scope.test.ts` list; integration tests; regenerate
   `openapi.json` and the api-client.
2. `feat(dev-mcp)`: `create_website_key`, `list_website_keys`, `revoke_website_key`,
   `set_website_access`; keys in the store.
3. `feat(dev-mcp)`: `call_website_api`, and `call_api` pointing to it.
4. `feat(dev-mcp)`: the upload helper and `seed_shared_documents`.
5. `refactor(forms-ai)`: setup code shared through `@integr8/forms-ai/setup`.
6. `feat(dev-mcp)`: `setup`, `update`, `uninstall`, the change-request repository
   path, bundled OpenAPI with the version warning, keychain loaded from beside the
   executable.
7. `build(dev-mcp)`: `build-sea.mjs`, `--check-assets`, archives with the keychain
   file.
8. `ci`: the `dev-mcp` release job and publish step; `feat(api)`/`packages/releases`:
   `devMcpAssetOf` in the downloads list; `feat(desktop)`: the Downloads page row.
9. `docs`: `docs/contributing/developer-tools.md` (install, connecting from another
   repository, the website workflow end to end), `docs/documents/` (localhost for
   test companies), `MEMORY.md`, this phase's status.

## Exit criteria

- [x] A `test_companies` session creates, lists and revokes a website key, sets
      `website_files`, `websiteUrl` and `documentLinkPattern` on a test company,
      and is refused (403 `session_scope`) for the same calls on a real company,
      for other flags and for other settings fields (integration tests).
- [x] A test company accepts `http://localhost:3000/documents/{code}` as its link
      pattern; a real company refuses it with today's codes (integration tests).
- [x] `call_website_api` gets `found: true` from `lookup` and `by-code` for a
      seeded document, and `found: false` for a not-shared one, with no impersonation
      grant written; the key never appears in the trace (tests).
- [ ] `seed_shared_documents` makes one made and one uploaded document, shared,
      and both are found by their values through `call_website_api` (tests against
      the in-process API). _Uploaded: done, through local mode against the real
      API (shared one found by `sn-77`, the unshared one not, `by-code` found).
      Made: not yet run, it needs the worker and Chromium printing._
- [x] Forms for AI's tests are unchanged and green after the setup code is shared.
- [ ] The release run builds the program for Windows, macOS and Linux, each
      archive passes `--check-assets`, and the staff Downloads page lists it.
      _Built and checked on Linux x64 only (12 assets, keychain module loaded; the
      unzipped program installed itself, connected Cursor and passed its self-test
      with 45 tools, and served a real API from its built-in route list); the
      other runners build at the next release._
- [ ] On a real Windows machine (the owner): the downloaded program runs after
      "Run anyway", the installer connects Claude Code, signs in, and an AI tool in
      the website's repository lists the `integr8-dev` tools and runs the website
      workflow: key, access, seed, `call_website_api`, `check_website_integration`.
- [x] `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm format:check` green;
      `openapi.json` and the api-client regenerated.
- [x] Docs and `MEMORY.md` updated.
