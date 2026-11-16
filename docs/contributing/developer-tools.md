# Developer tools for AI coding tools

Two MCP servers, one program for staff and one for this repository.

| Program                      | Who uses it                   | Where                           | Reaches the server?            |
| ---------------------------- | ----------------------------- | ------------------------------- | ------------------------------ |
| **Integr8 Forms for AI**     | Integr8 staff building forms  | `apps/forms-ai`, a download     | Never: offline, no credentials |
| **The developer MCP server** | Developers in this repository | `apps/dev-mcp`, run from source | Yes, as test companies only    |

## Integr8 Forms for AI (23 tools)

An offline MCP server that AI coding tools use to build `.integr8form` files:
the format guide generated from the real schemas, checks with the app's own
rules, PDF previews through the computer's Chrome, Edge or Chromium
(`INTEGR8_FORMS_BROWSER` to name one), and a live preview window. It never makes a
network request (`offline.test.ts` proves it).

**For staff.** Download it from the staff desktop app's **Downloads** page (Windows,
macOS Apple silicon or Intel, Linux; one Node single-executable of about 130 MB,
unsigned: Windows "More info → Run anyway", macOS `chmod +x` then right-click →
Open, Linux `chmod +x`). Double-clicked it opens a terminal installer that copies
itself to a fixed place, connects the AI tools it finds (Claude Code, Codex,
Claude Desktop, Cursor, VS Code, Windsurf, Gemini CLI) under the name
`integr8-forms` with `serve`, runs a self-test, and later offers updates. Files
are saved in `Documents/Integr8 forms` (changeable) and imported from the
company's Forms page or the dashboard's Templates page.

| Tools                                                                                          | Do                                                                                                                                          |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_format_guide`, `get_interview_guide`, `summarize_form`                                    | The format; what to ask the person first; the plain summary to confirm                                                                      |
| `list_examples`, `get_example`, `new_picture_ids`                                              | Library and demo forms and templates as examples; ids for pictures                                                                          |
| `check_form`, `check_package`, `preview_pdf`                                                   | The publish check with JSON paths; PDF previews                                                                                             |
| `save_package`, `open_package`                                                                 | Write and read `.integr8form` files                                                                                                         |
| `open_preview`, `update_preview`, `get_preview_state`, `close_preview`                         | The preview window: a page on `127.0.0.1` with a token and strict CSP, with the web filler and the printed PDFs, refreshing as the AI edits |
| `record_change_request`, `list_change_requests`, `get_change_request`, `update_change_request` | Record what the platform cannot do yet (below)                                                                                              |
| `get_website_guide`, `get_website_api`, `get_website_example`, `check_website_integration`     | Help build a company website's document search (Next.js App Router), its contract held to `openapi.json` by `contract.test.ts`              |

The preview page is React with the web filler, bundled with Tailwind into
`dist/window/page.{js,css}` and carried as executable assets (`build-sea.mjs`
checks them with `--check-assets`); it needs `form-renderer-dom`, `i18n` and
`tokens` built first. Its strings are `formsAiWindow.*`. Release builds come from
`build-release-artifacts.yml`.

## The developer MCP server (45 tools)

Lets an AI tool in this repository try a feature on a running API as the people
of a **test company**: find a route, call it as an engineer or the owner, read
back the request, the answer, the audit lines and the mail the company would have
sent. It also carries every Forms for AI tool (`registerFormsTools` from
`@integr8/forms-ai/tools`; its installer comes from `@integr8/forms-ai/setup`:
the only app-to-app imports allowed), so a developer connects one server. It runs
from this repository or as an installed program (below); never offered to
companies.

Three rules, enforced by the API rather than the tool: **test companies only**
(a staff session with `scope: "test_companies"`,
[platform/](../platform/README.md#signing-in)); **no secrets reach the AI** (you
type the password and code in a terminal, the session lives in the keychain
through `@napi-rs/keyring`, the trace hides tokens, codes and signed links, and
its folder is `0700`); **everything is audited** under your staff account, every
impersonation reason starting `Developer MCP:`.

```bash
pnpm dev-mcp login --api https://api.example.com   # email, password, code; 8 hours (--production for production)
pnpm dev-mcp status | logout
pnpm dev-mcp serve [--local]                       # what .mcp.json runs (pnpm --silent dev-mcp serve)
```

`--local` boots the API from this repository on 127.0.0.1 against your local
database (`APP_ENV` development or test) and signs in a tool account with a
limited session. Use a separate staff account for it on real servers; test
companies there are made by the seeder on the machine.

| Tools                                                                                | Do                                                                                                                                    |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| `status`, `list_test_companies`, `create_test_company`, `use_company`                | Which API and session; pick or make a test company (local mode)                                                                       |
| `find_route`, `get_route`, `call_api`, `get_trace`                                   | Search the OpenAPI document (with who may call each route); call as a member, or as a visitor for a public route; read the trace      |
| `get_audit`, `read_outbox`                                                           | What a call changed; the mail and push the company would have sent                                                                    |
| `import_form_package`, `submit_form`                                                 | Put a `.integr8form` into the company (publish optional; refuses anything but a `.integr8form` ZIP); fill and submit as a member      |
| `list_change_requests`, `get_change_request`, `hand_over_change_request`             | Read `plan/requests/`; copy a recorded request there and add its row                                                                  |
| `create_website_key`, `write_website_env`, `list_website_keys`, `revoke_website_key` | A test company's website key (P43): made, kept here, written into the website's `.env.local`, never shown                             |
| `set_website_access`, `call_website_api`, `seed_shared_documents`                    | Switch website access on and point links at `http://localhost:<port>`; call `/v1/website` with the key; make shared documents to find |
| the 23 Forms for AI tools                                                            | As above; `list_draft_change_requests` and `get_draft_change_request` are Forms for AI's own two renamed                              |

A grant is reused only for the same purpose, so each call's purpose reaches the
audit log. From building to testing in one server: `save_package` →
`use_company` → `import_form_package` (`publish: true`) → `submit_form` →
`get_audit`, `read_outbox`. The preview page needs `pnpm --filter
@integr8/forms-ai build` once.

## A company's website, built in another repository (P43)

A company's website lives in its own repository and reaches Integr8 only through
`/v1/website`, with a website key, from its server
([documents/](../documents/README.md#the-companys-website)). The developer server
sets a test company up for it and calls those routes exactly as the website's
server will:

1. `use_company` (a test company), then `create_website_key` with `envFile`, the
   website's absolute `.env.local` path. The key and `INTEGR8_API_URL` are written
   there; the AI never sees the key (only `.env*.local` files are accepted).
2. `set_website_access` with `files: true`, `websiteUrl: "http://localhost:3000"` and
   `documentLinkPattern: "http://localhost:3000/documents/{code}"`. Only a test
   company may use localhost (migration 0021); its documents' QR codes and links
   then open the site running on your computer.
3. `seed_shared_documents`: uploaded documents with a reference and typed fields,
   or documents printed from a submission (`submit_form` first, needs the
   worker), shared or not. It answers each code and search value.
4. `call_website_api` to see what the website's server will get, then
   `get_website_guide`, `get_website_example` and `check_website_integration`
   (absolute paths of the website's folder) for the pages themselves.

The API lets a staff session limited to test companies make, disable, revoke and
delete keys, set `documents` and the `website_*` flags, and change `websiteUrl` and
`documentLinkPattern`, on test companies only; for a test company's keys any staff
member may, not only a staff manager (`test-company-websites.integration.test.ts`).

**From the website's repository, with a checkout of integr8-plus:**

```bash
claude mcp add integr8-dev --scope local -- pnpm --silent --dir "C:\path\to\integr8-plus" dev-mcp serve
```

### The installed program

`integr8-dev-mcp`, built like Forms for AI (`pnpm --filter @integr8/forms-ai build`,
then `pnpm --filter @integr8/dev-mcp sea`; the release job `dev-mcp` builds it for
Windows, macOS and Linux, unsigned). A single executable cannot load a native
module from inside itself, so `@napi-rs/keyring`'s file ships beside it as
`integr8-keyring.node`. Each release carries, per computer, a `.zip` with both (the
first download, on the staff app's Downloads screen) and each alone with its
`.sha256` (what the program updates itself with).

Unzip into one folder and double-click `integr8-dev-mcp`: Forms for AI's
installer, with this program's profile (`src/program.ts`), copies both files to
`%LOCALAPPDATA%\Integr8\dev-mcp` (macOS `~/Library/Application Support/Integr8/dev-mcp`,
Linux `~/.local/share/integr8/dev-mcp`), connects the AI tools it finds as
`integr8-dev`, runs a self-test, and offers **Sign in to an Integr8 API** and
**Remember my integr8-plus folder** (for change requests). `integr8-dev-mcp login
--api …`, `status`, `logout`, `serve`, `update`, `uninstall` and `--version` work
from a terminal too.

Without a checkout it carries the OpenAPI document of its own release: `status`
says when the API runs another release. It updates itself from
`GET /v1/platform/downloads` with your signed-in session (the repository is
private, so GitHub's public API finds nothing), checking each file against its
published SHA-256. `--local` is only for a checkout.

## Change requests

Forms for AI records what the platform cannot do yet as folders under
`<output>/change-requests/CR-<n>-<slug>/` (`request.md` with a checked table
header, the example `.integr8form`, pictures made with `?blank=1` so no typed
answer is pictured). A check that refuses an unknown key, type or block ends by
offering to record one; the preview window has "Suggest a change to the
platform". A request is handed over by copying its folder into `plan/requests/`
(or `hand_over_change_request`), then planned with
[planning-a-change-request.md](./planning-a-change-request.md).
