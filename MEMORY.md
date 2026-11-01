# MEMORY.md — project state and gotchas

The project's working memory: where things stand, what was decided and why, and what is
still open. Facts that are not obvious from the code and go stale. Update this file at
the end of any piece of work that changes one of them, and date each section.
`CLAUDE.md` and `AGENTS.md` are the how-to; this is the state.

## Snapshot (2026-11-01, after the audit's Low fixes)

- **Version:** root `package.json` is **1.2.4** on branch `ccr-4f86fb34-8uvkk9` (not merged
  yet); `dev` is 1.2.3 (PR #138), `main` is 1.2.2 (released 31 Oct from PR #136). The root `package.json` is the only
  source: the phone (`app.config.ts`) and the web build (`next.config.ts`) read it, and
  `apps/api/src/app-info.ts` has a copy a test keeps equal.
- **Migrations:** `packages/db/migrations` reaches **0068**. **0059 was never used** (workers
  had reserved ranges) and the migrator does not need contiguous numbers; the next one is
  **0069**. 1.2.2 carries 0054–0057; 1.2.3 adds 0058 and 0060–0066; 1.2.4 adds 0067–0068.
- **Pre-production audit (2026-10-31):** plans, docs and code compared area by area; the
  report is the claude.ai artifact https://claude.ai/artifact/FB7vANrUc691VfMXkR5h2U. Its
  6 blockers and 14 High items shipped in 1.2.2 (PR #136). The owner then reviewed the 24
  Medium items one by one (decisions in the report); all were fixed on branch
  `ccr-4f86fb34-8uvkk9` for 1.2.3 (PR #138), maps by removing the map. The 15 Low items
  were decided the same way and built for 1.2.4 on the same branch name, restarted from
  `dev`. What is left is the owner's own steps under "Open items".
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
  https://claude.ai/artifact/HCVbJdp3u9YJT28cCaRw29. On 31 Oct it matched `main`'s HTML
  guide; the audit branch changes the guide (parts Q–S, versions, backups, Firebase), so
  republish it from `setup-checklist.html` once the branch is merged.

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

- **Owner steps for 1.2.4 (2026-11-01):** run `sh deploy/vps/check-env.sh` and replace
  any value it names (Stage 11 part AA), comment out `API_UPDATE_URL`; tell companies using
  documents that new ones start not shared (part AB); check the winget id
  `OpenJS.NodeJS.22` in the laptop step exists; the real-Auth CI suite for invitations
  runs only in CI. Not built (no screen existed): accepting an invitation inside the
  desktop or phone app; the email link opens the web page.

- **Owner steps for 1.2.3 (2026-11-01):** run Actions → Publish images with `tag=v1.2.2`
  once; `INTEGR8_PLATFORM_PASSWORD` and `DATABASE_URL_PLATFORM` in `deploy/.env`; copy the
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

- GitHub branch protection is **not** in force. The repository is **public** (rulesets
  would be free) but they have never been applied, and there is no `staging` branch. The
  only guard against pushing to `main`/`staging`/`dev` is the local pre-push hook
  (`scripts/git-hooks/pre-push-branch-guard.sh`); `INTEGR8_ALLOW_PROTECTED_PUSH=1`
  bypasses it.
- In practice feature PRs have been merged straight into `main`, despite the documented
  `dev → staging → main` flow.
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
