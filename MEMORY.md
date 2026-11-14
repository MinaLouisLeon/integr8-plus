# MEMORY.md — project state and gotchas

The project's working memory: where things stand, what was decided and why, and what is
still open. Facts that are not obvious from the code and go stale. Update this file at
the end of any piece of work that changes one of them, and date each section.
`CLAUDE.md` and `AGENTS.md` are the how-to; this is the state.

## Snapshot (2026-11-01, after the form builder and PDF builder round)

- **Version:** root `package.json` is **1.4.0** (2026-11-10, branch `ccr-56fb45d1-5mq6bt`: carries the AI tooling stage P37–P39 and migration 0077; history below starts at 1.3.1). 1.3.0 reached `main` (PR #148) but its
  release never published: the publish job attached the secret scan's report folder
  (`dist/work`) and failed, so there is no v1.3.0 tag. The owner bumped `main` to 1.3.1 on
  GitHub (PR #151, `package.json` only, which failed `app-info.test.ts`); branch
  `ccr-4f86fb34-8uvkk9` carries the rest of the bump and the release fixes (publish downloads
  only `server-*`, `desktop-*`, `forms-ai-*`; company apps skip with a warning when the API
  is down or `BUILD_TOKEN` is missing; two gitleaks fingerprints for manual full-history runs).
  **2026-11-03:** `main` was bumped to 1.3.2 on GitHub (PR #163, `package.json` only) and its
  release failed again: `app-info.ts` still said 1.3.1, and two phone-sync integration tests
  failed on a slow runner (`/v1/sync/push` read the server clock after sign-in checks, so
  phone times landed ~300 ms late). Branch `fix/release-1.3.3` (from `main`) stamps the
  arrival time in `onRequest` (`context.receivedAt`) and bumps every copy to **1.3.3**; no
  v1.3.1 or v1.3.2 tag exists. **2026-11-04:** branch `bugfix/fix-build` bumps every copy to
  **1.3.4** (it carries migration 0075 and this round's fixes). Branch `chore/bump-1.3.5` (from
  `dev`) bumps every copy to **1.3.5**. Branch `fix/submission-names-pdf-links-pickers` bumps every copy to **1.3.6** (it carries migration 0076). Branch `ccr-56fb45d1-5mq6bt` bumps every copy to **1.4.0**. The root `package.json` is the only
  source: the phone (`app.config.ts`) and the web build (`next.config.ts`) read it, and
  `apps/api/src/app-info.ts` has a copy a test keeps equal. A version bump must also change
  every place listed under "Places that state the version".
- **Migrations:** `packages/db/migrations` reaches **0077** (0077 `test_companies`, P38,
  unreleased, branch `ccr-56fb45d1-5mq6bt`). Before that it reached **0076** (0075 merged into `dev`, released
  with 1.3.4; **0076** `submissions.title` is unreleased, on branch
  `fix/submission-names-pdf-links-pickers`). **0059 was never used** (workers had reserved ranges) and the migrator
  does not need contiguous numbers; the next one is **0078**. 1.2.2 carries 0054–0057;
  1.2.3 adds 0058 and 0060–0066; 1.2.4 adds 0067–0068; 1.3.0 adds 0069 and 0074 (0070–0073 were reserved by workers and never used).
- **Pre-production audit (2026-10-31):** plans, docs and code compared area by area; the
  report is the claude.ai artifact https://claude.ai/artifact/FB7vANrUc691VfMXkR5h2U. Its
  6 blockers and 14 High items shipped in 1.2.2 (PR #136). The owner then reviewed the 24
  Medium items one by one (decisions in the report); all were fixed on branch
  `ccr-4f86fb34-8uvkk9` for 1.2.3 (PR #138), maps by removing the map. The 15 Low items
  were decided the same way and built for 1.2.4 on the same branch name, restarted from
  `dev` (PR #139). The owner then reviewed 13 gaps in the form builder and PDF template
  builder one by one; all were built for 1.3.0 on the same branch name. What is left is the
  owner's own steps under "Open items".
- **Modules shipped:** field work (customers, sites, work orders, visits and the
  schedule, timesheets), forms and submissions, PDF documents, CRM, sales, finance,
  general ledger, inventory, purchasing, assets, HR, expenses, Egyptian payroll,
  manufacturing, company roles, serial/batch tracking, qualifications (0052), contracts +
  maintenance plans + deadlines (0053), the AI assistant (help library or a model), ETA
  e-invoicing (test-only, not certified), company website data API, the demo company
  seeder.
- **Plan:** P01, P04, P08 and P22 are complete. P25–P27 (scheduling), P23, P24 and P32
  (Arabic, mostly built) are `IN PROGRESS`; v1.3 (P28–P31) and P33–P35 are `NOT STARTED`,
  though parts exist (see the notes in `plan/README.md`). Modules planned outside the phase
  list are indexed in `plan/README.md` ("Module plans outside the phase list").
  P37–P39 (v1.4 AI tooling, planned 2026-11-10) are built (`IN PROGRESS`, see Decisions). P40
  (form actions, from CR-0001) is proposed and waits for the owner's decisions.
- **P36 self-hosted sign-in** (`plan/v1.0-launch/P36-self-hosted-sign-in.md`): merged into
  `main` in PRs #130 and #135; CI's database job, real Auth included, is green. Auth container in
  `deploy/compose.yml` (`supabase/auth:v2.197.0`, private ports, memory caps), bootstrap's
  `supabase_auth_admin` role, migration 0054, emailed 6-digit sign-in codes and Change
  password (API + web/desktop/phone), purge deleting orphaned accounts,
  `admin-cli user-password` through Auth, CI real-Auth suite, docs (setup guide
  renumbered; Railway and the Supabase runbook deleted). `SUPABASE_URL` is replaced by `SUPABASE_AUTH_URL`;
  the API refuses to start with the old name. Still to do: the test-box run. The plan file's
  "Implementation notes" lists where the build differs.
- **Company app builds from the dashboard** are finished in 1.2.3 (`APP_BUILDS=github`
  with a fine-grained `GITHUB_BUILD_TOKEN`; `off` by default keeps them manual).
- **Recently merged to `main`:** engineer qualifications (PR #125), maintenance
  contracts/deadlines (PR #126), version bump to 1.2.1 (PR #127), the demo company seeder
  and a built-in sign-in (PR #128; replaced by P36), self-hosted sign-in (PRs #130, #135),
  the audit's blockers and High fixes as 1.2.2 (PR #136).

## The deployment

- One Oracle Cloud Always Free ARM machine (Ampere A1, 4 cores, 24 GB), `/opt/integr8`,
  running `deploy/compose.yml` behind Caddy, settings in `deploy/.env`. It will be shared
  with the MyRooms project, which runs its own full self-hosted Supabase, PowerSync and
  GlitchTip; the two keep separate Auth containers.
- Domain `integr8-media.com`: web `app.integr8-media.com`, API `api.integr8-media.com`. R2
  for files, Resend for mail, Stripe test mode.
- **Sign-in:** the owner has only used the staff login so far and has no Supabase project.
  After P36 the machine needs the three Auth secrets (setup guide, Stage 11 part Q).
- The home test box is Ubuntu 24.04 with Docker, Arcane, Webmin and Samba (no longer
  ZimaOS).
- The owner keeps a published copy of the setup guide as a claude.ai artifact:
  https://claude.ai/artifact/HCVbJdp3u9YJT28cCaRw29 (the HTML with its CSS and JS as separate
  files). On 1 Nov it was republished from branch `ccr-4f86fb34-8uvkk9` (1.3.0);
  republish it from `setup-checklist.html` whenever the guide changes. **2026-11-04:** the owner
  asked for a short steps-only checklist instead (no per-release sections), in the Integr8 Media
  look: https://claude.ai/artifact/KrY8XQBYC5ehzjG7DU4khX, a hand-written page (not generated
  from the repository guide); update it when a setup or update step changes.

## Decisions

- **Self-hosted Supabase Auth, not a built-in sign-in** (2026-10-31, while merging main
  into PR #130). Main had added `IDENTITY_PROVIDER=local` (scrypt hashes in an
  `identities` table, emailed links). P36's design was kept instead: one way to sign in,
  through the Auth container, with codes rather than links. The local provider, its
  tables and `IDENTITY_PROVIDER` were removed; `admin-cli user-password` was rewritten to
  set the password in Auth.
- **The purge suspends triggers and foreign keys** (0055, 2026-10-31). Deleting with
  every guard live kept breaking as guards were added (20 of 101 test companies could not
  be purged). It now runs with `session_replication_role = replica` and empties every
  table whose `tenant_id` references `tenants`. Safe only while no table outside that list
  points into it: `tenant-purge.integration.test.ts` checks that, so a new table that
  breaks it fails the suite. Needs the schema owner to be a superuser.
- **No retention window by default** (0056, 2026-10-31). Setting one is a decision about
  customers' records, made from the dashboard and told to the companies first. The logo
  and app icon are never retired.
- **The per-address sign-in limit counts failures only** (2026-10-31), and the web
  server passes on the visitor's address (Caddy's `X-Forwarded-For`), so a busy office or
  the web app's single server address no longer locks everyone out.
- **Pre-production fixes (2026-10-31, audit branch).** The phone opens offline only on a
  signed 7-day grant, checked with Ed25519 (`@noble/curves`, since Hermes has no WebCrypto)
  against `EXPO_PUBLIC_AUTH_VERIFICATION_KEYS`. A company's currency locks once it has any
  money record, and purchase orders must use it. A pay run refuses a rule set waiting for
  the owner or from an earlier year. The data export names every company table, exported
  or not with a reason, and a test fails on a new one. The migrator lets a previous release
  start on a newer schema (`ahead-of-build`). New companies start on `Africa/Cairo`,
  Sunday–Thursday. Legal pages exist but wait for a lawyer (`LEGAL_REVIEWED = false`).
- **Medium fixes (2026-11-01, 1.2.3), as the owner chose them:** sessions re-checked per
  request with a 30 s cache; the API and worker connect as `integr8_platform` (BYPASSRLS, not
  superuser; `DATABASE_URL_PLATFORM`), and compose gives each service only its own settings
  (`compose-env.test.ts` fails when the API reads a setting compose doesn't pass);
  `/health*` is off the internet, with `deploy/vps/heartbeat.sh` reporting in; HSTS, and a
  report-only CSP; `BILLING_PROVIDER=none` (invoiced only; Paymob later); HR key rotation
  (`HR_DATA_KEYS_PREVIOUS`, `admin-cli hr-reseal`); versioned server images per release;
  desktop apps update themselves through `app.integr8-media.com/desktop-updates`; the site
  map is gone (coordinates + a Google Maps link); notifications follow the phone's or the
  company's language; amounts round to piastres and receipts can be reversed (accountant to
  confirm the rounding).
- **Low fixes (2026-11-01, 1.2.4), as the owner chose them:** the public pages, `/download`
  and the staff dashboard (and the staff desktop frame) wear the Integr8 Media website's look
  (source: MinaLouisLeon/integr8-media-website; tokens and self-hosted fonts in
  `packages/tokens`, `docs/brand/`), always English unless Arabic is chosen (no browser
  negotiation); the company workspace keeps company branding. Uploaded PDF documents and a
  per-document sharing switch (new ones start not shared, older ones stay shared; 0067);
  files follow their owning record (`media-access.ts`, refusals are 404); a file-use index
  (0068). Accepting an invitation creates no session, and a new sign-in must choose a
  password. Only the owner changes, re-activates or removes somebody with HR access; an
  admin may suspend them (audited, owners emailed). The assistant's per-app switch follows
  the session's recorded app. Production refuses `change-me`, `.example`/public `.local`
  addresses and database passwords under 16 characters (`deploy/vps/check-env.sh` lists
  them). The help library lives in `@integr8/i18n/help` and feeds the public Help centre.
  Exact versions everywhere and Node `>=22.22.1 <23` (`pnpm pins:check`); the permission
  table `packages/core/src/permissions.table.md`; Standard storage overage listed for
  invoicing; quote links say "no longer available online" while Sales is off.
- **Form builder and PDF builder (2026-11-01, 1.3.0), as the owner chose them:** staff copy a
  form to another company (as a draft, optionally with its PDF templates and their pictures)
  or save it as a staff-made library template (`form_templates.source = 'staff'`, managed on
  the dashboard's Templates page; built-ins stay code-managed by `db:templates`; pictures in a
  `platform-library` bucket). English and Arabic side by side plus a Translations tab;
  missing Arabic only warns. Form format 2 (`schemaVersion` 2): Information blocks
  (in a section's `fields`, never answers), page/section descriptions, date/time and number
  calculations with brackets; phones older than 1.3.0 get "Update the app" on such forms
  (`apps/api/src/sync/form-formats.ts`). A behaviour check holds the web filler, the phone
  and the builder's preview to the same screens. PDF templates (design version 2): a
  three-place header and footer, landscape, brand colour/palette/lines/fonts (the website
  fonts embedded as data URIs), drag and drop with undo, copy/duplicate with a
  question-matching step, "Preview as PDF" (rate-limited, not stored; api memory cap 1 GB),
  and templates that keep printing when a form version drops a question ("Needs
  attention"). Branded server PDFs for quotes, invoices, purchase orders and a job report
  (0074), in the Documents register, emailable.
- **Form files and AI form building (2026-11-01, 1.3.0), as the owner chose them:** a form with
  its PDF templates and pictures travels as one `.integr8form` file (`@integr8/form-package`,
  spec `docs/form-engine/package-format.md`; a strict ZIP reader of its own on Node's zlib, no
  library, so oversized or malformed files are refused). Staff export a form (published, or the
  draft) and import one as a new draft; the dashboard imports into and exports from the
  library (library import refuses a form that would not publish). "Integr8 Forms for AI"
  (`apps/forms-ai`) is an offline MCP server (no credentials, never calls the server) that
  AI coding tools use to build those files: format guide generated from the real schemas,
  checks with the app's own rules, PDF previews through the machine's Chrome/Edge, save and
  open files. It ships as one executable per OS from the release workflow (Node SEA, about
  130 MB, unsigned), linked from `/download`; double-clicked it opens a terminal installer
  that connects Claude Code, Codex, Claude Desktop, Cursor, VS Code, Windsurf and Gemini CLI
  globally and offers updates from GitHub releases.
- **Forms for AI also helps build company websites (2026-11-02, unreleased, on `dev`'s working
  tree), as the owner chose it:** four more tools (`get_website_guide`, `get_website_api`,
  `get_website_example`, `check_website_integration`, in `apps/forms-ai/src/website/`) help an
  AI tool add the shared PDF search to a company's own website. Next.js App Router only; one
  match or none (no list endpoint, no API change); still offline and keyless (the developer
  tests against the real API). The contract is hand-written and `contract.test.ts` holds it to
  `apps/api/openapi.json`. Website keys stay staff-made on the dashboard; the program stays in
  `/download`'s staff section.
- **Fewer workflows (2026-11-03, unreleased, on `dev`'s working tree), as the owner chose
  them:** `ci.yml` runs only on pull requests into `dev`; `release-dev.yml` (dev build),
  `release-staging.yml` (nightly pre-release, and with it the generic `preview` phone build)
  and `publish-images.yml` (GHCR images) are deleted. GitHub publishes no Docker images:
  every machine, production and the test box, builds its own with `--build`.
  `release-main.yml` keeps verify → artifacts → company apps → release, without the images
  job; `build-release-artifacts.yml` lost its `channel`/`eas-profile` inputs and mobile job.
  The `staging`/`main` rulesets require only `PR source is allowed` (CI no longer reports
  there). `STAGING_PUBLIC_API_URL`, `NIGHTLY_DESKTOP_PLATFORMS` and `RELEASE_EAS_PROFILE`
  are unused.
- **Company display and document links (2026-11-03, unreleased, branch `bugfix/ui-issue`;
  migration 0075), as the owner chose them:** staff switch each menu tab on or off per company
  (onboarding form and company page, `PUT /v1/platform/companies/{id}/tabs`); one switch hides
  the tab in web, desktop and phone (`PHONE_SCREEN_SECTIONS` maps the phone's home buttons) and
  its page says "Not available"; a tab switched on turns its module on, a module with none of its
  tabs on is turned off, and the tabs of a module that ends up off stay off the hidden list
  (`tabChoice` in `@integr8/core`). Data is still guarded by modules only. The dashboard, form
  builder, branding and e-invoicing switch cannot be hidden. "Show the company name beside the
  logo" on the staff branding screen (ignored without a logo). "Warranties ending soon" removed
  from web/desktop dashboards and the phone's warranty reminders removed. Uploaded documents take
  up to 10 typed fields (`lookup_role = 'search'`, editable via `PUT /v1/documents/{id}/fields`).
  The website lookup takes one box, `q`: exact match on key and search fields, never the customer
  name, up to 10 in `documents`; the old `reference`/`key` forms still work.
  `document_link_pattern` (staff, company page) points links and new QR codes at the company's
  site (`https://<site>/documents/{code}`, same host or below), served by the new
  `GET /v1/website/documents/by-code/{code}`; Forms for AI writes that page. Document list rows
  have Share (switch on + share menu: copy, email, WhatsApp, QR), Stop sharing and Delete. No
  demo data for uploads (the seeder cannot upload files). Second round, same branch: a template
  QR block is `content: share | fixed` (fixed = text with placeholders, incl. the new
  `{{company.website}}`); a share code prints blank until the document is shared, and sharing
  queues `documents.reprint`, which re-prints from `printed_design` (generated) or stamps the
  original with pdf-lib (uploaded, `qr_placement` page fractions, `original_file_id` kept);
  stopping sharing keeps the code; business PDFs unchanged. The "share now" boxes stay. Uploads
  place the code by dragging on a pdf.js page (each app passes `pdfPage` to operations-dom; web
  now depends on `pdfjs-dist` 4.10.38). Submitted photos open in a viewer (next/previous, zoom,
  open/download). Forms for AI interviews the person first (`get_interview_guide`,
  `summarize_form`, "To confirm" items for QR blocks without a kind).
- **Company phone builds and staff downloads (2026-11-04, branch `bugfix/fix-build`), as the
  owner chose them:** the repository is now **private**. Every company phone build failed in
  EAS ("Slug … (integr8-plus) does not match … (integr8-pioneers)"): the slug is now always
  `integr8-plus` (`EAS_PROJECT_SLUG`); one Expo account/project and one Firebase project (an
  Android app per company) for all companies, not one each. Company apps are built by hand
  from GitHub (Build company apps on `main`) for now; the dashboard button needs a new
  `GITHUB_BUILD_TOKEN` (Actions: read and write) for the private repository, and `/download`
  and desktop updates need `GITHUB_RELEASES_TOKEN`. `/download` shows companies' apps only;
  the staff app and Forms for AI moved to the dashboard's **Downloads** page
  (`/platform/downloads`, list from `/api/platform/downloads`, which checks `/v1/platform/me`).
  The file links themselves stay plain links (the staff app's updater needs them without a
  sign-in). Forms for AI's own update check reads GitHub's public API and finds nothing in a
  private repository (not fixed yet).
- **Submission names, desktop file links and date pickers (2026-11-08, unreleased, branch
  `fix/submission-names-pdf-links-pickers` from `dev`; migration 0076), as the owner asked:** the submit step asks for a **Name**
  (prefilled with the form's title) stored in `submissions.title` and shown in lists and on the
  submission page; phones send it in `submission.submit` only when changed (they do not know a
  name given elsewhere); the phone keeps listing its own submissions by form title. The
  desktop app's **View/Download** did nothing because a Tauri window ignores `window.open`:
  it now uses `tauri-plugin-opener` (`~2.5`, as 2.7 needs Tauri 2.12; `opener:default`), passed
  to the shared screens as `openLink`, and `routeOutsideLinks` sends `target="_blank"` links
  there too. In browsers, `openPendingLink` opens the tab at the click, before the link
  arrives. Date/time boxes open their picker on click (`openPickersOnClick`), a chosen
  `data-theme` sets `color-scheme`, and the phone's expense date uses `DateField`.
  `cargo check` could not run on this Windows machine (MinGW `windres` fails in the build
  script), so the desktop shell is untested in a real build.
- **AI tooling stage planned (2026-11-10, plan only, nothing built), as the owner chose it:**
  `plan/v1.4-ai-tooling/` holds P37 (a live preview window in Forms for AI: the web filler and
  the printed PDFs on a loopback page that refreshes as the AI edits; still offline), P38 (a
  developer MCP server run from the repository, `apps/dev-mcp`, signed in from a terminal with a
  staff account; migration 0077 adds `tenants.is_test`, unchangeable after creation, and a
  staff-session scope `test_companies` lasting 8 hours that the API confines to test companies,
  production included; test companies are made by the seeder on the machine, are left out of
  billing and totals and send no real mail or push) and P39 (change requests captured in Forms
  for AI as folders, copied into `plan/requests/`, planned in the repository and stopped for the
  owner's approval). The owner asked for the tooling first; the platform feature that started
  it, **form actions** (a form creates expense claims and opens a follow-up form; the
  accountant corrects amounts), waits as `plan/requests/CR-0001-form-actions.md`. Company
  plugins, hooks and splitting the product into installable modules were discussed and not
  chosen.
- **P37 preview window built (2026-11-10, unreleased, branch `ccr-56fb45d1-5mq6bt`):** Forms for
  AI gained `open_preview`, `update_preview`, `get_preview_state`, `close_preview` (19 tools) and
  a page it serves on `127.0.0.1` with a token, a strict CSP and Host/Origin checks
  (`apps/forms-ai/src/window/`). The page is React with the web filler, bundled with Tailwind into
  `dist/window/page.{js,css}` and carried as SEA assets; `build-sea.mjs` now runs the new
  executable's `--check-assets`. Strings are `formsAiWindow.*`. A smoke test drives the built
  page in the machine's Chrome. Still open: a run from a real AI tool, the PDF frame in Edge,
  Firefox and Safari, and the macOS/Linux builds' asset check (next release run). The page needs
  `form-renderer-dom`, `i18n` and `tokens` built first, which the release job's
  `--filter=@integr8/forms-ai^...` build now includes.
- **P38 developer MCP server and test companies built (2026-11-10, unreleased, branch
  `ccr-56fb45d1-5mq6bt`; migration 0077):** `tenants.is_test` (trigger: fixed at creation),
  `platform_sessions.scope` (`full` | `test_companies`, 8 hours), `impersonation_grants.from_limited_session`
  and `test_outbox` (7 days). The seeder and the onboarding switch make test companies; they are
  left out of billing, overage invoicing, the funnel and app builds, and their mail and push go
  to the outbox (`apps/api/src/test-companies/outbox.ts`). Platform routes declare
  `platformScopes`; a limited session is refused elsewhere (403 `session_scope`, audited) and on
  real companies (`http/session-scope.ts`, list pinned in `session-scope.test.ts`). `apps/dev-mcp`
  (`pnpm dev-mcp login|logout|status|serve [--local]`, `.mcp.json`) keeps the session in the
  keychain (`@napi-rs/keyring`) and hides secrets in its trace. The new integration suites were
  written but not run (no Postgres on the build machine). Storage cost projection still counts
  test companies (Cloudflare bills them).
- **P39 change requests built (2026-11-10, unreleased, branch `ccr-56fb45d1-5mq6bt`):** Forms
  for AI records what the platform cannot do yet as folders under
  `<output>/change-requests/CR-<n>-<slug>/` (`request.md` with a checked table header, the example
  `.integr8form`, pictures made with `?blank=1` so no typed answer is pictured) with four tools
  (23 in all); checks that refuse an unknown key, type or block end with an offer to record one;
  the window has "Suggest a change to the platform" and a requests list. Handed over by copying
  into `plan/requests/` (README there); planned with `docs/contributing/planning-a-change-request.md`
  (`/plan-change-request`); the developer MCP server lists and reads them. `offline.test.ts` now
  proves no Forms for AI tool makes a network request. CR-0001 became **P40 — Form actions**
  (`plan/v1.5-form-actions/`, proposed; its test-company evidence step is still to run).
- **One MCP server for developers (2026-11-14, unreleased, branch `ccr-712995a6-da3hqy` from
  `main`), as the owner asked:** the developer MCP server (`apps/dev-mcp`) carries every Forms for
  AI tool beside its own (37 tools), through `registerFormsTools` from `@integr8/forms-ai/tools`
  (the one app-to-app import allowed). Forms for AI's two change-request read tools are renamed
  there `list_draft_change_requests` / `get_draft_change_request`. The Forms tools need no
  sign-in; the preview page needs `pnpm --filter @integr8/forms-ai build`. Forms for AI's own
  program is unchanged and still what staff install.
- **Review of the two MCP servers (2026-11-14, unreleased, branch `ccr-11ad0982-coofjh` from
  `dev`):** the developer server now has 38 tools (`hand_over_change_request` copies a recorded
  request into `plan/requests/` and adds its README row). A grant is reused only for the same
  purpose, so each call's purpose reaches the audit log; the trace folder is `0700` and refuses a
  link or another user's folder; the handshake version comes from its `package.json`;
  `import_form_package` refuses anything but a `.integr8form` ZIP before sending; the tool-answer
  helpers live once in `apps/forms-ai/src/mcp/results.ts`. Details: P38's second addendum.
- **The demo seeder goes through the API**, in-process with Fastify's `inject`, as the
  company's own people (plus a staff impersonation for staff-only setup). Direct inserts
  were rejected: they skip numbering, stock, ledger postings and audit, and produce data
  the screens cannot show. It refuses staging/production without `--confirm-production`.
  Setup guide Stage 14.

## Places that state the version or migration count

Update them together at each release or new migration:

- `README.md`: "Current version" line and the migration table.
- `PROJECT_INDEX.md` ("Read carefully" line) and `PROJECT_INDEX.json` (`version`).
- `docs/deployment/setup-checklist.md` **and** `.html`: header line, Stage 0 "Nothing to
  merge", Stage 3 `APP_VERSION`/`API_RELEASE`, Stage 6 latest release, Stage 7 company
  release name, Stage 11 example bump and feature parts, Stage 13, footer. References
  like "included in v1.1.2" are history and stay as they are.
- `deploy/.env.example` (`APP_VERSION`, `API_RELEASE`) and `apps/api/src/app-info.ts`
  (`VERSION`; `app-info.test.ts` fails when it differs from the root `package.json`).
- Released versions: `gh release list`. v1.2.1 (2026-10-27) carries migrations 0051–0053.

## Open items

- **Owner steps for 1.3.0 (2026-11-01):** Stage 11 parts AC and AD (migrations 0069 and
  0074; the api container's 1 GB cap; wait a day after updating before publishing forms
  that use the new features, so phones have the 1.3.0 app). Check "Preview as PDF" and pdf.js
  in the real Tauri app on Windows and macOS (only tested in Chromium). The real Resend path
  with PDF attachments is untested. No job-report button on the phone yet. Forms for AI:
  the Windows and macOS executables are first built by the next release run (the
  `macos-15-intel` runner label is unverified); on a real machine check the installer's setup
  for Claude Desktop, Cursor, VS Code and Windsurf (their config formats could not be checked
  against their docs) and macOS/Linux need `chmod +x` after download.

- **Owner steps for 1.2.4 (2026-11-01):** run `sh deploy/vps/check-env.sh` and replace
  any value it names (Stage 11 part AA), comment out `API_UPDATE_URL`; tell companies using
  documents that new ones start not shared (part AB); the real-Auth CI suite for invitations
  runs only in CI. Not built (no screen existed): accepting an invitation inside the
  desktop or phone app; the email link opens the web page.

- **Owner steps for 1.2.3 (2026-11-01):** `INTEGR8_PLATFORM_PASSWORD` and `DATABASE_URL_PLATFORM` in `deploy/.env`; copy the
  new Caddyfile blocks; the heartbeat monitor, `HEALTH_PING_URL` and its cron line, then
  delete the public uptime monitor; `CLOUDFLARE_API_TOKEN`; `HR_DATA_KEY` set; watch
  Sentry's CSP reports ~2 weeks before enforcing; the Tauri updater key secrets (does anyone
  hold the key for `updater.key.pub`?) and `GITHUB_RELEASES_REPOSITORY`; reinstall every
  desktop app once; check each company's Seats field (it now limits them); an accountant
  confirms the rounding. Code signing only if certificates are bought (Windows: token or
  cloud signing; Azure may not accept Egypt). Reserve the company slug `staff`.

- **Owner steps from the audit (2026-10-31):** add the `R2_TEST_*` repository secrets (a
  separate Cloudflare account) so CI proves R2; set up the off-machine backup (R2 bucket,
  rclone remotes, `BACKUP_REMOTE`) and run `restore-drill.sh`; Firebase and the EAS
  variables `GOOGLE_SERVICES_JSON`, `EXPO_PUBLIC_SENTRY_DSN` and
  `EXPO_PUBLIC_AUTH_VERIFICATION_KEYS` per environment; a lawyer reviews `/legal/*` and fills
  `LEGAL_OPERATOR`; an accountant signs off the payroll figures and the year rule; decide
  whether the repository stays public, then apply the rulesets
  (`docs/contributing/branching.md`); check existing companies' timezone and working days.

- **The demo seeder against the real Auth container** has not been run (only the test
  fake). **Removing a demo company** is the normal close flow (suspend, export, close,
  purged after seven days); its people's sign-in accounts go with the purge.
- E-invoicing is test-only: nothing has been sent to the real ETA, and the desktop app
  cannot sign until a token driver is added.

## Gotchas

- GitHub branch protection is **not** in force. The repository became **private** on
  2026-11-04 (rulesets on a private repository need a paid plan); none were ever applied. The `staging` branch exists again since
  2026-11-01, created on GitHub from `dev` at `812a550` (1.3.0 with the Dependabot updates);
  since 2026-11-03 pushes to it run nothing on GitHub. The only guard against pushing to `main`/`staging`/`dev` is the local pre-push hook
  (`scripts/git-hooks/pre-push-branch-guard.sh`); `INTEGR8_ALLOW_PROTECTED_PUSH=1`
  bypasses it.
- Until 1.2.2 feature PRs were merged straight into `main`; from 1.2.3 work goes into `dev`
  and through `staging` to `main` as documented (`dev → staging → main`). Never edit `main`
  (or `staging`) directly on GitHub: a web edit of `apps/mobile/app.config.ts` on `main`
  (33e07cb, 2026-11-01) broke the file and failed every staging → main PR until `main` was
  merged back into `dev` with the working file. The Expo project ID is the one
  `EAS_PROJECT_ID` line in that file. Dependabot opens its PRs against `main`; apply them on
  a branch from `dev` instead of merging their branches.
- CI's database job always runs (there is no `DATABASE_TESTS` switch any more). The R2
  media suite inside it skips itself unless the `R2_TEST_*` secrets exist.
- Screen tests (`operations-dom`, `form-renderer-dom`) wait up to 5 s in `findBy…`;
  integration suites running beside them made the 1 s default fail by chance.
- Load `keygen`'s output into a shell line by line (`while IFS= read -r l; do export
"$l"; done`), not with `source`: the shell strips the quotes from `AUTH_SIGNING_KEY`'s
  JSON and the auth suites then fail with "not valid JSON".
- Integration tests refuse to run without `APP_ENV=test` and
  `INTEGR8_TEST_DATABASE=i-know-this-database-is-disposable`.
- TypeScript stays on 6.0.3: TypeScript 7 would silently switch off type-aware linting.
- This Windows checkout has `core.autocrlf=true`, so files are CRLF on disk while
  `.prettierrc` says `endOfLine: lf`. `prettier --write` on a directory rewrites hundreds
  of files to LF (no content change, but `git status` fills up). Format only the files you
  changed, with `--end-of-line auto`.
- `APP_ENV=production` refuses to start on any stand-in service.
- `PUBLIC_SIGNUP=off` by default: companies are created only by Integr8 staff.
- ETA e-invoicing is not production-validated (live PreProd submission and hardware-token
  signing untested). The ledger and payroll are management tools, not statutory.

## Idea backlog

`new-idea.md` (2026-10-26) lists candidate features for desktop/mobile, numbered so they
can be picked by number. None is approved; #2 (visual scheduling board) is marked done.
