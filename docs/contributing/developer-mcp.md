# The developer MCP server

An MCP server for AI coding tools working in this repository (P38). It lets the tool try a
feature on a running API as the people of a **test company**: find a route, call it as an
engineer or the owner, and read back the request, the answer, the audit lines and the mail the
company would have sent. It lives in `apps/dev-mcp` (`@integr8/dev-mcp`), runs from source, and
is never built into a download.

Three rules hold whatever the tool does, because the API enforces them, not the tool:

- **Test companies only.** The tool signs in with a staff session limited to test companies;
  the API refuses it on every other company and on every staff route outside a short list
  ([`docs/platform/README.md`](../platform/README.md#a-session-limited-to-test-companies-0077-p38)).
- **No secrets reach the AI.** You type the password and authenticator code in a terminal; the
  session lives in your keychain; no tool signs in or returns a token, and the trace hides
  tokens, passwords, codes and signed links.
- **Everything is on record.** Each action is audited under your staff account, and every
  impersonation reason starts `Developer MCP:`.

## Signing in (remote mode)

For the test box and production. A separate staff account keeps the audit log apart from your
own work, and is recommended (`node dist/platform/admin-cli.js create`, setup checklist, "You and your staff").

```bash
pnpm install
pnpm dev-mcp login --api https://api.example.com       # email, password, code; 8 hours
pnpm dev-mcp status                                    # which API, which account, time left
pnpm dev-mcp logout                                    # signs out and forgets the session
```

- The session is kept in the operating system's keychain (Windows Credential Manager, macOS
  Keychain, the Secret Service on Linux) through `@napi-rs/keyring`. A machine without one is
  refused unless you add `--file-store`, which writes a file only you can read in your
  configuration folder (`%APPDATA%\Integr8\dev-mcp`, `~/Library/Application Support/Integr8/dev-mcp`,
  `~/.config/integr8/dev-mcp`) and says so.
- An API whose `/v1/platform/me` reports production needs `--production`, and login prints what
  the tool will be able to do. Start there with read-only calls on a freshly seeded test
  company, with the audit log open.
- The session ends 8 hours after sign-in; sign in again then. Signing in again replaces it.
- On production and the test box, test companies are made on the machine with the seeder
  (CLAUDE.md, "The demo company seeder"); every company it makes is a test company.

## Local mode

For development on your laptop. `pnpm dev-mcp serve --local` boots the API from this repository
in a child process (`pnpm --filter @integr8/api dev-mcp-local`) against your local database, on
127.0.0.1 only, and signs a tool account (`dev-mcp@integr8.invalid`) in with a limited session.
It refuses unless `APP_ENV` is `development` or `test`. `create_test_company` runs the seeder
there (`--without-sign-in`: the people exist but cannot sign in; the tool acts as them through
impersonation).

## Connecting an AI tool

Claude Code reads the project's `.mcp.json`, which runs `pnpm --silent dev-mcp serve`. Other
tools take the same: command `pnpm`, arguments `--silent dev-mcp serve` (add `--local` for
local mode, or `--api <address>` when more than one API has a session), working directory the
repository, transport stdio. On Windows some tools need `cmd /c pnpm …`. With one signed-in API
it is chosen by itself; `INTEGR8_DEV_MCP_API` also names one.

## The tools

| Tool                   | What it does                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `status`               | Mode, API address, environment, signed-in account, time left, the chosen company, the trace file                               |
| `list_test_companies`  | The test companies the session can use                                                                                         |
| `create_test_company`  | Local mode: runs the seeder (all sections or `only`). Remote mode: explains the command to run on the machine                  |
| `use_company`          | Chooses the company and lists its people with roles, emails and user ids                                                       |
| `find_route`           | Searches `apps/api/openapi.json` by words, path or tag                                                                         |
| `get_route`            | One route in full: parameters, body and response schemas, permission, module, idempotency                                      |
| `call_api`             | One request as `company`, a role, an email or a user id: checked against the schema first, headers and `Idempotency-Key` added |
| `get_trace`            | This session's requests and answers, newest first, or one in full                                                              |
| `get_audit`            | The company's audit lines since a moment                                                                                       |
| `read_outbox`          | The email and push notifications the company would have sent (kept 7 days)                                                     |
| `import_form_package`  | Imports a `.integr8form` file (Forms for AI, P37) as a draft and publishes it if asked                                         |
| `list_change_requests` | The change requests handed to the repository (`plan/requests/`), with kind and status                                          |
| `get_change_request`   | One of them in full, with the files beside it ([planning-a-change-request.md](planning-a-change-request.md))                   |
| `submit_form`          | Starts and submits a form as a person, with given answers                                                                      |

`call_api` starts an impersonation grant for the person when there is none (reason
`Developer MCP: <purpose>`), reuses it until it lapses, and ends every grant when the server
stops. It sends `x-client-app: api` (the value the API keeps for callers that are not one of its
apps) and the repository's version as `x-client-version`. Staff routes are not called through it.

## The trace

Every request and answer goes to a JSON Lines file in the temporary folder
(`integr8-dev-mcp/trace-<time>-<pid>.jsonl`, written only you can read), one per session, and
`get_trace` reads the same. Before anything is written or returned, `src/redact.ts` replaces
tokens (JWTs, `i8…` refresh and invitation tokens, any `token`/`password`/`secret` field),
sign-in codes on the sign-in routes, `Authorization` and cookie headers, and signed file links
with `[hidden]`.

## For maintainers

```
src/cli.ts         login | logout | status | serve
src/store.ts       keychain or user-only file; apis.json lists APIs without secrets
src/connection.ts  staff session (refresh, persist), impersonation grants, every request traced
src/openapi.ts     route index from openapi.json; request check with zod's fromJSONSchema
src/local.ts       local mode: the API and the seeder as child processes
src/server.ts      the MCP tools
src/redact.ts      what is hidden
```

`pnpm --filter @integr8/dev-mcp test` runs without a database: the tools against a stand-in
API (`server.test.ts`), the route index against the real `openapi.json`, the store and the
redaction. The API's side (scopes, test companies, the outbox) is covered by its own suites,
which need a disposable Postgres (`apps/api/src/routes/v1/platform/test-companies.integration.test.ts`,
`packages/db/src/testing/test-companies.integration.test.ts`, and the platform session suite in
`@integr8/auth`).
