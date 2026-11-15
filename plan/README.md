# The plan

Where Integr8 Plus stands at **2.0.0** (2026-11-15) and what comes next. It
replaces the phase files written before 2.0.0 (P01–P41, in git history before
the 2.0.0 docs commit). What is built is described in [`docs/`](../docs/README.md);
this file holds only what is **not finished**: work in progress, the owner's
open decisions and steps, and the phases not started. Phase numbers carry on
from the old plan, so the next new phase is **P42**.

## What 2.0.0 is

Every module in [`docs/modules/`](../docs/modules/README.md) is built and runs
on one shared Postgres with every company separated by `tenant_id` and row-level
security. 2.0.0 restarted the database: 19 module migrations replace the 79 of
1.x, the tables that grow forever are split by year, query plans can be checked
at real sizes (`db:volume`, `db:plans`), and a company can be moved between
servers (`transfer`). All data before 2.0.0 was test data, so a 1.x database is
created again rather than upgraded.

## Proposed

### P42 Desktop only

[P42](./2.1.0/P42-desktop-only.md): companies and staff work only in the desktop
apps. The web-only company screens and the whole platform dashboard move into
the desktop, and `apps/web` becomes a small public site (marketing, help, legal,
`/download`, quote and document links, the update feed, accepting an
invitation). Self-serve sign-up and card checkout go. **PROPOSED — waiting for
the owner** (six decisions, D1–D6).

## In progress

### P40 Form actions

From change request [CR-0001](./requests/CR-0001-form-actions.md): a form makes
expense claims from its answers and opens a follow-up form; the accountant
corrects amounts. How it works: [form actions](../docs/form-engine/README.md#form-actions).

**Built (server):** actions on form versions, checks, running them on submit from
both submit paths, results and **Make it now**, follow-ups as linked drafts that
can block completing a job, `approvedAmount` with a note on every claim, the
claim's submission for deciders.

**Not built:**

- [ ] The builder's Actions tab, and the screens that show a submission's
      actions and next forms (web, desktop).
- [ ] The phone's next-form button, and its "Update the app" gate (left out until
      a phone release reads follow-ups).
- [ ] Forms for AI: the format guide, checks and examples for actions.
- [ ] Actions in `.integr8form` files (export and import, with category
      matching).
- [ ] The demo seeder's trip form.
- [ ] The test-company evidence run with the developer MCP server.

**The owner's decisions.** The server follows the recommended answer to each;
each is small to change.

| #   | Question                                                                  | Built as (recommended)                                               |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | Do claims made by a form wait for approval?                               | Always wait; the accountant corrects the amount at approval          |
| 2   | Where does the rate per kilometre live?                                   | In the form's calculation (a rate change is a new version)           |
| 3   | Must a required follow-up form be submitted before the job can complete?  | Yes, through the job's required forms                                |
| 4   | How is a claim category matched when a form file goes to another company? | By name, asking "create it or choose another" (import not built yet) |
| 5   | Does the approved-amount correction apply to every claim?                 | Yes, every claim                                                     |
| 6   | Should a submission be refused when a claim cannot be made?               | No: the office is told and can make it with one button               |

### Tooling runs still to do

- [ ] **Forms for AI preview window**: a run from a real AI tool; the PDF frame in
      Edge, Firefox and Safari; the macOS and Linux builds' asset check (next
      release run).
- [ ] **Developer MCP server and test companies**: run the new integration suites
      against Postgres, and a run against a real API.
- [ ] **Database restructure**: the owner's run on the Proxmox test machine (below).

### Sign-in

- [ ] The test-box run of the self-hosted Auth container end to end.
- [ ] The demo seeder against the real Auth container (only the test fake so far).
- [ ] Accepting an invitation inside the desktop or phone app (today the email
      link opens the web page).

## Owner steps

For 2.0.0, on each machine (setup guide Stage 11 part AJ):

- [ ] `down -v`, `up -d --build`, create the super admins again, onboard or seed
      the companies again, delete the old companies' R2 buckets.
- [ ] On the Proxmox test machine: `db:volume` at scale 1, click through the app,
      `db:plans`, and one `transfer export`/`import` between two machines (checks
      the real Auth import of password hashes).

Still open from earlier releases:

- [ ] Run `sh deploy/vps/check-env.sh` and replace every value it names.
- [ ] `INTEGR8_PLATFORM_PASSWORD` and `DATABASE_URL_PLATFORM` in `deploy/.env`; the
      Caddyfile blocks; the heartbeat monitor and `HEALTH_PING_URL`, then delete
      the public uptime monitor; `CLOUDFLARE_API_TOKEN`; `HR_DATA_KEY`.
- [ ] Watch Sentry's CSP reports for about two weeks, then enforce the policy.
- [ ] The Tauri updater key secrets (does anyone hold the key for
      `updater.key.pub`?) and `GITHUB_RELEASES_REPOSITORY`; reinstall every desktop
      app once.
- [ ] The off-machine backup (R2 bucket, rclone remotes, `BACKUP_REMOTE`) and a
      `restore-drill.sh` run.
- [ ] The `R2_TEST_*` repository secrets (a separate Cloudflare account), so CI
      proves R2.
- [ ] Firebase and the EAS variables `GOOGLE_SERVICES_JSON`,
      `EXPO_PUBLIC_SENTRY_DSN`, `EXPO_PUBLIC_AUTH_VERIFICATION_KEYS` per
      environment.
- [ ] A new `GITHUB_BUILD_TOKEN` (Actions: read and write) for the private
      repository, and `GITHUB_RELEASES_TOKEN` for `/download` and desktop updates.
- [ ] Check "Preview as PDF" and pdf.js in the real Tauri app on Windows and
      macOS; the desktop shell's file links in a real build.
- [ ] Forms for AI on a real machine: the installer's set-up for Claude Desktop,
      Cursor, VS Code and Windsurf; the first Windows and macOS executables from a
      release run (the `macos-15-intel` runner label is unverified).
- [ ] The real Resend path with PDF attachments.
- [ ] A lawyer reviews `/legal/*` and fills `LEGAL_OPERATOR`
      ([docs/legal/](../docs/legal/README.md)).
- [ ] An accountant signs off the payroll figures and year rule, the invoice
      rounding rule, and the e-invoicing set-up.
- [ ] Review the accountant role's permissions (`permissions.table.md`).
- [ ] Code signing, only if certificates are bought (Windows: a token or cloud
      signing; Azure may not accept Egypt).
- [ ] Reserve the company slug `staff`; check each company's Seats field.

## Not started

| Phase | What                                              | Parts that already exist                                      |
| ----- | ------------------------------------------------- | ------------------------------------------------------------- |
| P20   | Packaging, signing and release                    | Release workflows; unsigned installers; desktop self-update   |
| P21   | First customer onboarding                         | The onboarding flow and the demo seeder                       |
| P28   | Reporting and dashboards                          | CSV exports, CRM and ledger reports, the deadline report      |
| P29   | Customer notifications                            | Branded business PDFs, emailing documents                     |
| P30   | AI form generation in the product                 | Forms for AI does it outside the product                      |
| P31   | Meetings and calendar sync                        | —                                                             |
| P33   | Public API, webhooks and integrations             | Website keys and `/v1/website`                                |
| P34   | Enterprise access and security review             | Company roles, audit logs, per-company export                 |
| P35   | A dedicated database per company (a premium tier) | `getTenantDataSource` is the seam; `transfer` moves a company |

Also known and not built: ETA production use (a hardware signer, live PreProd
validation), a job-report button on the phone, a Paymob billing adapter, Forms
for AI's own update check in a private repository, and removing the 1.x
idempotency fingerprint. Candidate features not yet approved are listed in
[`new-idea.md`](../new-idea.md).

## Writing a phase

A phase is a file `plan/<version>/P<nn>-<slug>.md` with: **Goal**; **Scope** (in
and out); **Where things stand** (with evidence); **Design** by area;
**Decisions for the owner** (each a question with options and one
recommendation); **Tasks** in commit order (`feat(db)` → `feat(api)` →
`feat(web)`/`feat(desktop)` → `feat(mobile)` → `feat(forms-ai)` → `docs`);
**Exit criteria**, each testable; and a status: `PROPOSED — waiting for the
owner`, `IN PROGRESS`, `BLOCKED` (with the reason) or `COMPLETED — YYYY-MM-DD`.
Add it to this file. A phase is complete when every exit criterion is verifiably
true; then tick them, set the status, update this file and commit as
`docs(plan): complete P<nn> — …`. Change requests are planned the same way
([planning-a-change-request.md](../docs/contributing/planning-a-change-request.md)).
