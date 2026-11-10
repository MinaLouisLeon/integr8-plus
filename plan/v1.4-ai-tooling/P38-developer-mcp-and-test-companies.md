# P38 — Developer MCP server and test companies

**Version:** v1.4 AI tooling
**Status:** `NOT STARTED`
**Depends on:** P15 (platform dashboard, impersonation), the demo company seeder
(`apps/api/src/demo/`), P04 (the route registry and `openapi.json`)

## Goal

An AI coding tool working in this repository can try a feature on a real running API: it acts
as the people of a test company, sends requests, and reads the full requests and responses. It
signs in with a staff account only, the person types the password and authenticator code
themselves, and the API guarantees it can never reach a real customer's company.

## Scope

Agreed on 2026-11-10:

- **A second MCP server, for developers, run from the repository source.** It is not part of
  Forms for AI, is never built into a download, and is not shipped to anybody.
- **Signs in with a staff account created from the terminal** (`admin-cli create`), the owner's
  own or a separate one. The person signs in once in a terminal; the AI never sees the
  password, the code or a token.
- **Test companies only, enforced by the API.** A company is a test company from the moment it
  is created and never becomes one later.
- **It may connect to production**, where the same rule holds: test companies only.
- **Inside a test company it may do everything**, as the company's people, exactly as locally.
  Every action is audited under the signed-in staff account.
- **On production a test company is created with the seeder command on the machine**, as a demo
  company is today. The MCP server uses companies that exist; it creates one only in local mode.
- **Test companies are left out of billing and totals, and send no real mail or push
  notifications.** They carry a "Test" badge on the dashboard.
- **The sign-in lasts 8 hours**, then the person signs in again.

Out of scope: driving the real phone or desktop apps (it can call the same routes they call),
creating test companies on a remote machine from the MCP server, a dashboard button that runs
the seeder, and any change to how company people sign in.

## Where things stand (2026-11-10)

| Need                                         | Today                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A company full of data to test on            | The seeder (`node dist/demo/cli.js`), run on the machine; it onboards through the platform services, not over HTTP       |
| A mark that says "this is a test company"    | None. `is_demo` marks sample rows inside a company (0018), not companies                                                 |
| Staff sign-in                                | `POST /v1/platform/auth/sign-in`: email, password and authenticator code together                                        |
| Acting as a company's people                 | `POST /v1/platform/companies/{id}/impersonate`, as the company or as one member (`targetUserId`), with a reason, audited |
| Limiting what one staff session may do       | None: every staff session can do everything a staff account can                                                          |
| Knowing every route's request and response   | `apps/api/openapi.json`, generated from the route registry                                                               |
| Calling the API without a network (dev only) | The seeder boots the API in-process and uses Fastify's `inject`                                                          |

## Design

### 1. Test companies (database and API)

Migration **0077** (the next free number; check again before writing it):

- `tenants.is_test boolean not null default false`. A trigger refuses any later change of the
  column, in either direction: a real company can never be turned into one the tool may enter.
- `platform_sessions.scope text not null default 'full'`, one of `full` or `test_companies`.

Setting the mark:

- The seeder always sets it: a demo company is a test company.
- The onboarding form on the dashboard gains a "Test company" switch, off by default, shown
  with a warning that it cannot be changed afterwards.

What the mark changes, each with a test:

| Area                         | Behaviour for a test company                                                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Dashboard                    | A "Test" badge on the companies list and the company page; a filter                                             |
| Billing                      | No invoices, no dunning, no storage-overage lines, not listed for invoicing                                     |
| Dashboard totals, analytics  | Not counted                                                                                                     |
| Email and push notifications | Not sent. They go to the recording sender for that company, and are readable for 7 days (section 4, the outbox) |
| Company app builds           | Refused: a test company has no phone or desktop build                                                           |
| Everything else              | Unchanged: plan limits, modules, tabs, export, close and purge work as for any company, so tests mean something |

Every place that sends mail or push, bills, or counts companies is found during the build by
searching for the senders and the billing provider; the list goes in "Implementation notes".

### 2. A staff session limited to test companies (API)

- `POST /v1/platform/auth/sign-in` accepts an optional `scope: "test_companies"` (additive, so
  nothing inside `/v1` breaks). Without it the session is `full`, as today.
- A `test_companies` session ends 8 hours after sign-in whatever happens; refreshing never
  extends it and never changes its scope.
- The route registry gains one field for platform routes: which scopes may call it. The default
  is `full` only, so a new platform route is closed to the tool unless somebody opens it on
  purpose. Open to `test_companies`:
  - `GET /v1/platform/me`, refresh and sign-out;
  - listing companies, which returns test companies only for such a session;
  - reading one test company's page (its people, modules and tabs);
  - starting, ending and listing impersonation in a test company;
  - reading a test company's outbox and its audit lines.
- Any other platform route, or one of these for a company that is not a test company, answers
  403 `session_scope`. The refusal is audited.
- Impersonation tokens are already bound to one company. The grant records that it came from a
  limited session, and the reason must start with `Developer MCP:`.
- A registry test lists the routes open to `test_companies` and fails when the list changes
  without the test being updated, the way the schema-invariant suite pins what `integr8_auth`
  may reach.

Staff-only actions inside the company (importing and publishing a form, job types, branding)
work as they do for staff today: by acting as the company through the grant.

### 3. The developer MCP server

A new private workspace app, `apps/dev-mcp` (`@integr8/dev-mcp`), TypeScript run from source.
It is not in the release workflow and has no executable. It depends on
`@modelcontextprotocol/sdk`, `@integr8/api-client` and `zod`, at the versions already pinned.
`commitlint.config.js` gains the scope `dev-mcp`.

Two ways to reach an API:

| Mode       | For                                   | How it reaches the API                                                                                                                         | Sign-in                |
| ---------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| **Remote** | The test box, production              | HTTPS to the machine's API address                                                                                                             | `login`, section below |
| **Local**  | Development on the developer's laptop | Boots the API in-process against the local database, as the seeder does; refuses unless `APP_ENV` is `development` or `test`; can run a seeder | None                   |

**Signing in (remote mode).** `pnpm dev-mcp login --api https://api.example.com`:

1. Asks for email, password and authenticator code in the terminal, without echo.
2. Signs in with `scope: "test_companies"`.
3. Stores the session in the operating system's keychain under the API's address. If the
   machine has no keychain, it refuses unless `--file-store` is given, which writes a file only
   the user can read, in the user's configuration folder, and says so.
4. For an API whose `/v1/platform/me` reports production, it needs `--production` and prints
   what the tool will be able to do.

`pnpm dev-mcp logout` signs out and deletes the stored session. `pnpm dev-mcp status` says
which API, which account and how long is left. The MCP server reads the stored session; it has
no tool that signs in, and no tool returns a token.

**Connecting an AI tool.** A project `.mcp.json` registers the server for Claude Code in this
repository; `docs/contributing/developer-mcp.md` gives the lines for other tools. The server's
instructions text states the rules: test companies only, say what you are about to do before a
write on production, never ask the person for a password or code.

**Tools.**

| Tool                  | What it does                                                                                                                                                                                                      |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`              | Mode, API address, environment, signed-in account, time left, the chosen company                                                                                                                                  |
| `list_test_companies` | The test companies the session can use                                                                                                                                                                            |
| `create_test_company` | Local mode only: runs the seeder (all sections, or `only`) and returns the new company. In remote mode it explains the command to run on the machine                                                              |
| `use_company`         | Chooses the company for the calls that follow, and lists its people with their roles                                                                                                                              |
| `find_route`          | Searches `openapi.json` by words, path or tag; returns matching routes with one line each                                                                                                                         |
| `get_route`           | One route in full: parameters, body and response schemas, permission, whether it needs an `Idempotency-Key`                                                                                                       |
| `call_api`            | Sends one request as a chosen person (`as`: a role, a person's key, or `company`). Adds the required headers, checks the request against the route's schema first, returns status, body, timing and the audit ids |
| `get_trace`           | The recent requests and responses of this session, newest first, or one in full                                                                                                                                   |
| `get_audit`           | The company's audit lines since a moment, so a call's side effects can be read back                                                                                                                               |
| `read_outbox`         | Emails and push notifications the test company would have sent                                                                                                                                                    |
| `import_form_package` | Imports a `.integr8form` file as a draft and, if asked, publishes it: the step between P37's window and a real test                                                                                               |
| `submit_form`         | Starts and submits a form as a person, with given answers: the common flow in one call                                                                                                                            |

`call_api` starts an impersonation grant for the chosen person when it has none, reuses it
until it lapses, and ends its grants when the server stops. The reason text is
`Developer MCP: <what the AI said it is testing>`.

**The trace.** Every request and response is appended to a JSON Lines file in the user's
temporary folder, one file per session, and `get_trace` reads from it. Before anything is
written or returned, tokens, passwords, sign-in codes, `Authorization` and cookie headers, and
signed file links are replaced with `[hidden]`. The person can open the file to read along.

### 4. The outbox

Mail and push for a test company are written to a small tenant-scoped table (in 0077, with the
usual `tenant_id`, grant, RLS policy, export entry and purge coverage), kept for 7 days by the
worker's retention job, and read through `GET /v1/platform/companies/{id}/test-outbox`. This is
how the AI checks "the customer would have been emailed the PDF" without sending anything.

### 5. Safety, in one place

| Risk                                          | What stops it                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| The AI touches a real company                 | The API refuses a `test_companies` session everywhere else; the mark cannot be set on an existing company |
| The AI learns a password, code or token       | The person signs in in a terminal; the session lives in the keychain; the trace hides secrets             |
| A forgotten session                           | Ends by itself after 8 hours; `logout` ends it at once                                                    |
| Test activity looks like the person's own     | Works with any staff account; a separate one (`admin-cli create`) keeps the audit log apart. Recommended  |
| Real people get test emails                   | Test companies send nothing; it is recorded instead                                                       |
| Test companies distort invoices or totals     | Left out of both                                                                                          |
| A new staff route quietly opens to the tool   | Platform routes are closed to the limited session by default; a test pins the open list                   |
| Local mode pointed at a real database by slip | Local mode refuses unless `APP_ENV` is `development` or `test`                                            |

### 6. Setup guide and docs

- `docs/deployment/setup-checklist.md` **and** `.html`, together: a Stage 11 part for migration
  0077; Stage 14 says a demo company is now a test company (badge, no billing, no mail) and how
  the developer tool reaches it; `pnpm guide:check`.
- `docs/contributing/developer-mcp.md`: installing, signing in, the tools, the safety rules.
- `docs/platform/`: test companies and limited sessions. `docs/api/`: the `scope` field.
- `apps/api/openapi.json` and the api-client regenerated and committed.
- English and Arabic strings for the badge, the switch and its warning.
- The places that state the migration count (`MEMORY.md`, "Places that state the version or
  migration count").

### 7. Testing

- Database: the `is_test` trigger; schema invariants, export and purge suites know the outbox
  table.
- API integration: a limited session is refused on every platform route outside the open list
  and on every open route for a real company; it ends at 8 hours; refresh keeps the scope; a
  test company gets no invoice, sends no mail and is not counted.
- Developer MCP: tools against the in-process API (local mode) on a seeded company: find a
  route, call it as an engineer, read the trace and the audit lines; secrets are hidden in the
  trace; remote mode against the same app listening on a local port, signed in with a staff
  account whose authenticator code the test computes.
- Integration suites need a disposable Postgres, as always.

## Tasks

- [ ] `feat(db)`: 0077: `tenants.is_test` with its trigger, `platform_sessions.scope`, the
      test outbox table
- [ ] `feat(api)`: the seeder and the onboarding route set the mark; test companies left out of
      billing, totals and builds; mail and push recorded to the outbox
- [ ] `feat(api)`: `scope` at staff sign-in, the 8-hour limit, per-route scopes, the outbox and
      audit reads; OpenAPI and client regenerated
- [ ] `feat(web)`: the Test badge, filter and onboarding switch (English and Arabic)
- [ ] `feat(dev-mcp)`: the app, `login`/`logout`/`status`, the keychain store
- [ ] `feat(dev-mcp)`: remote and local modes, the tools, the trace with secrets hidden
- [ ] `chore(repo)`: `.mcp.json`, the commitlint scope
- [ ] `docs`: setup guide (both copies), developer MCP page, platform and API pages, `MEMORY.md`

## Exit criteria

- [ ] After `pnpm dev-mcp login`, an AI tool in the repository lists the test companies of a
      running API, calls a route as an engineer of one and shows the request and the response
- [ ] The same session is refused, by the API, on a company that is not a test company and on
      every staff route outside the open list (integration test)
- [ ] The password, the authenticator code and every token never appear in a tool result or in
      the trace file (test)
- [ ] The session stops working 8 hours after sign-in
- [ ] `is_test` cannot be changed on an existing company (database test)
- [ ] A test company is not invoiced, not counted in the dashboard's totals, and its emails and
      push notifications are recorded instead of sent
- [ ] Every action the tool takes is in the audit log under the signed-in staff account
- [ ] A form file saved from the P37 window is imported, published, filled and submitted in a
      test company through the tools
- [ ] Local mode creates a seeded test company and runs the same tools with no sign-in, and
      refuses to start outside development and test
- [ ] The setup guide's two copies agree (`pnpm guide:check`) and name migration 0077

## Notes

- To verify during the build:
  - how `x-client-app` values are checked, and whether a new value is needed for this tool;
  - that an impersonated member session may call the phone's sync routes (`/v1/sync/*`), which
    is how the server side of offline work is tested;
  - a maintained keychain library for Node on Windows, macOS and Linux, pinned exactly;
  - whether the seeder's people need sign-in accounts on production at all for this use, or
    `--without-sign-in` should be allowed there for test companies.
- Production carries real customers. Even with every guard above, the first use on production
  should be read-only calls on a freshly seeded test company, with the audit log open.
- The seeder against the real Auth container has still not been run (`MEMORY.md`, open items).
