# MEMORY.md — project state and gotchas

The project's working memory: where things stand, what was decided and why, and what is
still open. Facts that are not obvious from the code and go stale. Update this file at
the end of any piece of work that changes one of them, and date each section.
`CLAUDE.md` and `AGENTS.md` are the how-to; this is the state.

## Snapshot (2026-11-01, after the form builder and PDF builder round)

- **Version:** root `package.json` is **2.0.0** (2026-11-14, branch `ccr-c6dc87d8-3hlhaw` from `dev`: P41's clean database restart, see Decisions). Before it, **1.4.0** (2026-11-10, branch `ccr-56fb45d1-5mq6bt`: carries the AI tooling stage P37–P39 and migration 0077; history below starts at 1.3.1). 1.3.0 reached `main` (PR #148) but its
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
- **Migrations (2.0.0):** a new baseline, **0001_foundation … 0019_assistant**, one per module (P41),
  then **0020_desktop_only** (P42, unreleased, branch `ccr-982c2137-h4as2m`), **0021_test_company_localhost** (P43, unreleased, branch `ccr-3cd2290c-d9znqu`) and **0022_definer_functions_closed** (SEC-002, branch `ccr-87dc93be-pye3tx`); the next one is **0023**. A 1.x database is refused (`before-baseline`) and is created again (setup guide
  Stage 11 part AJ). **Before 2.0.0** (history): `packages/db/migrations` reached **0079** (0079 `form_actions`, P40, unreleased,
  branch `ccr-916cc1b1-6sp5my`; 0078 `accountant_role`, unreleased, merged into `dev` in PR #188; 0077 `test_companies`, P38, unreleased, branch
  `ccr-56fb45d1-5mq6bt`). Before that it reached **0076** (0075 merged into `dev`, released
  with 1.3.4; **0076** `submissions.title` is unreleased, on branch
  `fix/submission-names-pdf-links-pickers`). **0059 was never used** (workers had reserved ranges) and the migrator
  does not need contiguous numbers; the next one is **0080**. 1.2.2 carries 0054–0057;
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
- **Plan (2026-11-15):** the phase files P01–P41 were removed with the old docs; `plan/README.md`
  now lists only what is unfinished: P40 (form actions; server side built, screens, phone, Forms
  for AI and the owner's six decisions open), the tooling and sign-in runs still to do, the owner's
  steps, and the phases not started (P20, P21, P28–P31, P33–P35). P42 (desktop only) is in progress; P43 (developer MCP server for company websites, and as an installable program) is built (2026-11-16), waiting for a release run and the owner's Windows run; the next new phase is P44.
- **P36 self-hosted sign-in**: merged into
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
  from the repository guide); update it when a setup or update step changes. **2026-11-15:** P42
  changed the guide (staff app instead of `/platform`, no Stripe, Stage 11 part AL); neither
  artifact has been republished yet. **2026-11-16:** the repository guide itself became the
  short checklist (see Decisions); republish `setup-checklist.html` to the first artifact.
  **2026-11-16 (branch `ccr-4623ab69-s5teku`):** the guide gained Stage 12, a Proxmox test
  machine filled by `db:volume` and read with `pg_stat_statements`, `db:plans` and
  `auto_explain` (12 stages, 107 tick boxes); not republished yet.
- **The guide on GitHub Pages (2026-11-15, branch `ccr-982c2137-h4as2m`), as the owner asked:**
  `.github/workflows/guide-pages.yml` publishes `scripts/guide/build-site.mjs`'s output when the
  guide reaches `main` or by hand: the guide encrypted (AES-GCM, PBKDF2 600 000 rounds) with the
  `GUIDE_USERNAME`/`GUIDE_PASSWORD` repository secrets, decrypted in the browser. The owner chose
  the credentials; they are not in the repository. To do once: Pages source "GitHub Actions", the
  two secrets, then a run from `main`. GitHub's search API reported the repository **public** on
  2026-11-15 (MEMORY said private since 2026-11-04), so the guide files are readable there anyway.
- **Since P42** `app.integr8-media.com` is the public site only (no sign-in): `/download`, `/q`,
  `/d`, `/a/<code>`, `/accept-invitation`, `/desktop-updates`, marketing, help, legal.

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
  `packages/tokens`, `packages/tokens`), always English unless Arabic is chosen (no browser
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
  `plan/README.md` holds P37 (a live preview window in Forms for AI: the web filler and
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
  (`plan/README.md`, proposed; its test-company evidence step is still to run).
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
  helpers live once in `apps/forms-ai/src/mcp/results.ts`. (The P38 phase file with its addenda is in git history.)
- **The accountant role and company roles on the desktop (2026-11-14, unreleased, branch
  `ccr-56130823-gs6hbv`; migration 0078), as the owner asked:** an eighth built-in role,
  `accountant`, ranked between `inventory_manager` and `dispatcher`: finance (manage + issue),
  ledger (post + manage), `expense.approve`, ETA prepare/sign/submit, and read-only customers,
  sales, purchasing, stock, assets, contracts, documents. Not `ledger.unlock`,
  `purchasing.approve`, `eta.configure`, payroll or HR (Claude's proposed default, for the owner
  to review; `permissions.table.md` has it). Not a grant; left out of work-order crews; the demo
  seeder adds Hana Mostafa as accountant, who drafts the manual journals. The desktop app has a
  **Company roles** tab (`/settings/roles`, nav key `companyRoles`, desktop-only, shown with
  `member.update_role`) using the shared `CompanyRolesScreen` (`peopleOnWeb`); roles are still
  given to people on the web. Older phones reject an accountant's offline grant (strict
  `roleSchema`).
- **Form actions, server side (2026-11-14, unreleased, branch `ccr-916cc1b1-6sp5my` from `dev`;
  migration 0079), as the owner asked ("start implementing P40", decisions to discuss later):**
  built on P40's recommended answers, not yet confirmed by the owner (claims wait for approval;
  the km rate lives in the form's calculation; a required follow-up holds the job; categories
  matched by name; the approved amount applies to every claim; a claim that cannot be made never
  refuses the submission). Actions sit beside the definition in `form_versions.actions`; their
  schema, checks and the plan of a submit are in `@integr8/form-engine` (`actions.ts`), not
  `form-package` (Node-only, and the web builder needs them). `apps/api/src/forms/actions.ts`
  runs them in the submit's transaction from both submit paths, each in a savepoint; a claim's
  `client_action_id` is a UUID v5 of submission + action, so it is made once. Outcomes are kept in
  `submission_action_results` (Make it now: `POST /v1/submissions/{id}/actions/retry`).
  Follow-ups are drafts linked in `submission_links`, and the form joins the job's forms (the
  database refuses a job submission for a form not on the job), so a required one blocks completing
  through the existing `completion_blocked`. Approving takes `approvedAmount` + `amountNote`; the
  ledger, direct payment and payroll use `payableAmount` (`coalesce(approved_amount, amount)`).
  Claim deciders read the claim's submission at `GET /v1/expenses/{id}/submission`. Not built: the
  builder's Actions tab and the other screens, the phone's next-form button and its "Update the
  app" gate (left out on purpose until a phone release reads follow-ups), Forms for AI, form-file
  import of actions, the demo seeder's trip form. Doc: `docs/form-engine/README.md`.
- **Database restructure, P41 (2026-11-14, unreleased, branch `ccr-c6dc87d8-3hlhaw` from `dev`), as
  the owner chose it:** all data so far is test data, so no backup and a clean restart (2.0.0).
  **Shared tables** stay (every row keyed by `tenant_id`, RLS the backstop); per-company tables were
  discussed and not chosen. Migrations 0001–0079 were replaced by a baseline of 19 module migrations,
  generated from the 0079 schema and compared object by object. The tables that grow forever and
  that nothing points at are **split by UTC year** (`<table>_y<year>` + `_default`): `audit_log`,
  `platform_audit_log`, `work_order_events`, `submission_values`, `erp_journal_lines` (gained
  `entry_date`, kept by an `on update cascade` key), the three AI logs, `login_attempts`,
  `signup_events`, `eta_attempts`, `sync_touches`. Partitions carry no grants; `ensure_year_partitions()`
  (security definer) runs in migrations, daily in the worker (`partitions.ensure`) and after an
  import. `impersonation_grants` carries `audit_log_occurred_at`. Not partitioned on purpose (keys
  unique for all time): stock movements, submission events, asset events, sync reports.
  **Query audit:** `db:volume` (made-up test companies from SQL) and `db:plans` (EXPLAIN GENERIC_PLAN of
  every `pg_stat_statements` statement as the runtime role); compose's Postgres runs
  `pg_stat_statements` and `auto_explain` (500 ms). Findings fixed: ledger reports by line date with
  bounds only when given; login-attempt clean-up by key not `ctid`. **Transfer:** staff-only
  `transfer export|import|inspect` (`apps/api/src/transfer/`, compose service `transfer`, profile
  `tools`, the only one with both the owner's URL and the API's settings): a tar.gz with a manifest
  (format 1, release, schema, modules), rows as Postgres JSON text, sign-in accounts **with password
  hashes** (owner's choice; the archive is a credential; `IdentityProvider.importIdentity` sends GoTrue
  `id` + `password_hash`) and the files. Import: one transaction, triggers off, every foreign key
  checked, same ids, refuses an existing company or a newer archive; `--continue` finishes files and
  accounts. Untested here: the real GoTrue `password_hash` import (CI's real-Auth suite does not
  cover it) and the compose `transfer` service on a real machine.
- **Documentation rewritten for 2.0.0 (2026-11-15, branch `ccr-8527348b-k9tfyv`), as the owner
  asked:** every old page under `docs/` and every phase file under `plan/` was deleted (in git
  history before that commit; `version2.md` and `PROJECT_IMPROVEMENTS.md` too) and replaced by a
  smaller set written from the code: `docs/README.md` (index and glossary), `architecture.md`,
  `apps/` (web, desktop and phone, with the desktop-only and web-only screen lists) and
  `apps/mobile.md`, `api/`, `auth/` (+ `offline-access.md`), `database/` (+ `migrations.md` with
  the map from 1.x migration numbers, the backup runbook kept), `modules/`, `form-engine/`
  (+ `package-format.md`), `documents/`, `media/`, `ai/`, `e-invoicing/` (its
  `official-public/` fixtures folder kept), `platform/`, `deployment/` (the setup guide kept),
  `contributing/` (+ `developer-tools.md`, `planning-a-change-request.md`), `legal/`. Folder names
  were kept where code comments point (`docs/ai`, `docs/documents`, …); comments naming removed
  files were repointed. `README.md` and `CONTRIBUTING.md` are short front pages. Kept as they
  were, for the owner to decide: `full-description.md` (an Arabic business description of
  1.1.0), `new-idea.md`, `PROJECT_INDEX.md`/`.json`. The owner wants to discuss the desktop app
  against the phone app next.
- **Desktop only, P42 (2026-11-15, unreleased, branch `ccr-982c2137-h4as2m`; migration 0020), as the
  owner chose it (D1–D6 in the phase file):** no web workspace and no web dashboard. A company's
  office works only in its own desktop app (Get started, People, Company roles, Company settings,
  Website access, Storage and a read-only Billing came over; the desktop's separate assistant
  settings screen folded into People and Company settings). Integr8 staff work only in the staff
  desktop app, which now holds the whole dashboard (`apps/desktop/src/features/platform/`, loaded
  lazily and left out of company builds, checked by `check:company-bundle` in CI): a memory-only
  platform session (D2, sign in at every start), **Work inside this company** as the company or
  **Act as this person** (D3), **Back to the dashboard** on the banner. `apps/web` is the public
  site; a route-list test pins it. Self-serve sign-up, the funnel, Stripe, checkout, portal,
  webhooks, dunning and the trial job are deleted with their tables and columns (D4). Reminder
  emails name the screen instead of linking (D1). Printed asset tags lead to a public `/a/<code>`
  page (D5, `GET /v1/public/asset-tags/:code`). **An invitation waits for the company's own desktop
  app** (D6, not the recommendation): 409 `company_app_not_built` (503 `releases_unavailable`) from
  the staff resend, onboarding's send, and the company's own invite and resend, unless it is a test
  company or `APP_RELEASES=off`; `APP_RELEASES=github` reads `GITHUB_RELEASES_REPOSITORY` with
  `GITHUB_RELEASES_TOKEN` through the new `@integr8/releases`, which also gives
  `GET /v1/platform/downloads`. The AI channel `web` is gone (`ai_web_enabled` dropped); old `web`
  sessions and staff count as desktop. Setup guide Stage 11 part AL. The developer MCP server's
  `call_api` sends public routes (asset tags, quote and document links, accepting an invitation) as a
  visitor with no sign-in; Forms for AI's guides name the staff and company desktop apps. Not checked: real Tauri
  builds, and a real GitHub release lookup.
- **A short setup guide (2026-11-16, branch `ccr-5b9b85c7-8sidx1` from `main`), as the owner
  asked:** `docs/deployment/setup-checklist.{md,html,css,js}` rewritten as a steps-only
  checklist: 11 stages, 89 tick boxes, one line per step with a `laptop`/`machine`/`web`/`app`
  tag, no per-release parts, in the Integr8 Media look (dark, lime, the violet-cyan-lime
  gradient, Unbounded/Inter/JetBrains Mono), with per-stage Clear for the update stage. Same
  file names, so `pnpm guide:check` and the Pages workflow are unchanged; the HTML was
  generated from the Markdown once and is maintained by hand from here. Dropped from the guide:
  the per-release parts (Stage 11 A–AL), the test box, destroying the machine, the demo
  company, code signing, the stores, the AI provider walk-throughs. The occasional ones (HR key
  change, moving a company, code signing, stores, test box) moved to
  `docs/deployment/README.md` "Occasional procedures"; references to old stage letters were
  repointed. The old long edition is in git history.
- **The developer MCP server for company websites, and as a program, P43 (2026-11-16,
  unreleased, branch `ccr-3cd2290c-d9znqu`; migration 0021), as the owner chose it (D1–D4):**
  a company's website is built in its own repository. The limited `test_companies`
  staff session may now use the five website-key routes, set `documents` and the
  `website_*` flags (no other) and change only `websiteUrl` and `documentLinkPattern`, on
  test companies only (`session-scope.test.ts` list); a test company's keys need no staff
  manager. A test company (only) may use `http://localhost:<port>` / `127.0.0.1` for its
  website and link pattern (0021, a trigger backs the API's 422 `website_url_local_only`).
  Seven new tools (45 in all): `create_website_key` writes the key into the website's
  `.env*.local` and never shows it, `write_website_env`, `list_website_keys`,
  `revoke_website_key`, `set_website_access`, `call_website_api` (the key, no person or
  grant; `call_api` refuses website routes), `seed_shared_documents` (uploaded PDFs made in
  `src/pdf.ts`, or printed from a submission). The server is also an installed program,
  `integr8-dev-mcp`: Forms for AI's installer, now driven by a `SetupProfile`
  (`@integr8/forms-ai/setup`), with `DEV_PROFILE` (`src/program.ts`); `@napi-rs/keyring`'s
  file ships beside it as `integr8-keyring.node` (D1); OpenAPI built in, `status` warns
  when the API's `x-api-release` differs; updates through `GET /v1/platform/downloads`
  (now open to the limited session, with a `devMcp` entry); release job `dev-mcp`
  (zip + program + keyring, each with `.sha256`), unsigned (D4); separate from Forms for AI
  (D3). Local mode now passes its own port as `API_PUBLIC_URL` (uploads failed before).
  Only Linux x64 was built here; the made-document seeding was not run (needs the worker).
- **Security audit fixes, round 1 (2026-11-16, pushed on branch `ccr-87dc93be-pye3tx`), as the
  owner decided them:** the audit's findings are in `security-audit.md` (root; the full reports in
  `security-audit/`). SEC-001: a staff session limited to test companies stays in the test company it
  acts as; routes marked `crossTenant` (form copy targets, copy to company, save to library) refuse
  it (grant's `from_limited_session`, token claim `imp.lim`, pinned in `session-scope.test.ts`); a
  refresh whose impersonation grant is gone is refused (SEC-015). Form templates are staff-only
  (`form.manage`). **Outside links live on the company's own website only:** shared documents
  (`<websiteUrl>/documents/<code>` or the link pattern), quote links (`<websiteUrl>/q/<token>`) and
  asset tags (`<websiteUrl>/a/<code>`); the company's server reads them with its website key
  (`/v1/website/documents/by-code`, `/v1/website/quotes/by-token/:token` + `/answer`,
  `/v1/website/asset-tags/:code`). The keyless `/v1/public/documents|quotes|asset-tags` routes and the
  public site's `/d`, `/q`, `/a` pages are deleted. A company without a website cannot share (409
  `sharing_needs_website`), gets no quote link and prints bare tag codes; a key whose company has no
  website answers 403 `website_missing`. The developer server's `call_api` sends public routes only
  for the chosen test company. No migration for these.
- **SEC-002 (2026-11-16, branch `ccr-87dc93be-pye3tx`; migration 0022), as the owner agreed:** every
  security-definer function is closed to PUBLIC and opened only to its callers (pinned in the
  schema-invariant suite); the ledger's capture/try_post/backfill/backfill_more are wrappers that
  refuse another company's id on `integr8_app`'s connection, around bodies renamed `_unchecked`;
  **new functions start closed to PUBLIC** (`ALTER DEFAULT PRIVILEGES`), so a migration adding one the
  runtime role calls must grant EXECUTE. Proven on a local Postgres 16: db (505), auth (97) and API
  (713) integration suites all pass; running the API suites also caught and fixed six test mistakes
  from round 1.
- **The demo seeder goes through the API**, in-process with Fastify's `inject`, as the
  company's own people (plus a staff impersonation for staff-only setup). Direct inserts
  were rejected: they skip numbering, stock, ledger postings and audit, and produce data
  the screens cannot show. It refuses staging/production without `--confirm-production`.
  Setup guide Stage 14.

## Places that state the version or migration count

Update them together at each release or new migration:

- `README.md`: "Current version" line and the migration table.
- `PROJECT_INDEX.md` ("Read carefully" line) and `PROJECT_INDEX.json` (`version`).
- `docs/deployment/setup-checklist.md` **and** `.html`: the header line (and the HTML's
  eyebrow), Stage 4 `APP_VERSION`/`API_RELEASE`, Stage 6 latest release, Stage 8 company
  release name, Stage 10's example version lines, the "About this page" line.
- `deploy/.env.example` (`APP_VERSION`, `API_RELEASE`) and `apps/api/src/app-info.ts`
  (`VERSION`; `app-info.test.ts` fails when it differs from the root `package.json`).
- Released versions: `gh release list`. v1.2.1 (2026-10-27) carries migrations 0051–0053.

## Open items

- **Owner steps for P43 (2026-11-16):** after the next release, download the developer
  program from the staff app on Windows, install it, connect Claude Code, sign in, and run
  the website workflow from the website's repository (`docs/contributing/developer-tools.md`).
  Not run here: the Windows/macOS builds and seeding a printed (made) document.

- **Owner steps for P42 (2026-11-15):** click through the staff app and a company's app in real
  Tauri builds on Windows (and macOS) and sign a new person in through an invitation; on the
  machine, setup guide Stage 11 part AL (delete the billing and sign-up settings, add
  `APP_RELEASES=github` and the releases token, install the new staff app, build each company's
  app before inviting); republish the two setup-guide artifacts.

- **Owner steps for 2.0.0 (2026-11-14):** setup guide Stage 11 part AJ: `down -v`, `up -d --build`,
  create the super admins again, onboard or seed companies again, delete the old companies' R2
  buckets. Then the Proxmox test machine run: `db:volume` at scale 1, the app clicked through,
  `db:plans`, and one `transfer export`/`import` between two machines (checks the real Auth import of
  password hashes).

- **P40 decisions (2026-11-14):** the owner still has to go through P40's six decisions; the server
  follows the recommendations. Setup guide Stage 11 part AI covers migration 0079.

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
  (`docs/contributing/README.md`); check existing companies' timezone and working days.

- **The demo seeder against the real Auth container** has not been run (only the test
  fake). **Removing a demo company** is the normal close flow (suspend, export, close,
  purged after seven days); its people's sign-in accounts go with the purge.
- E-invoicing is test-only: nothing has been sent to the real ETA, and the desktop app
  cannot sign until a token driver is added.

## Gotchas

- **Test companies' people can sign in only with the development desktop build** (P42): test
  companies get no app builds, and the staff build has no company door. The developer MCP server
  needs no sign-in. The staff dashboard in a browser: `VITE_APP_FLAVOR=staff pnpm --filter
@integr8/desktop dev` (or no flavour for both doors), with the API's `API_CORS_ORIGINS`
  including `http://localhost:3002`.
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
