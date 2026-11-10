# Planning a change request

How an AI coding tool working in this repository turns a change request in `plan/requests/`
into a phase plan the owner approves (P39). **It writes a plan and stops. It changes no product
code.** Claude Code runs it with the project command `/plan-change-request <number>`
(`.claude/commands/plan-change-request.md`); any other tool follows this page.

The tools it uses:

- the **developer MCP server** ([developer-mcp.md](developer-mcp.md)): `list_change_requests`,
  `get_change_request`, and a test company to try today's behaviour on;
- **Integr8 Forms for AI**, when the request has an example form: `open_package`, `check_package`,
  `preview_pdf`.

## The steps

1. **Read the request.** `get_change_request` (or open `plan/requests/CR-<n>…`). Read its four
   parts and its answers. Open its example with Forms for AI's `open_package` and check it, so
   you know exactly what the format refused.
2. **Reproduce today's behaviour on a test company.** With the developer MCP server:
   `status`, `use_company` (a seeded test company; in local mode `create_test_company`),
   `import_form_package` with the example, `submit_form`, then `call_api` for the screens the
   request is about, as the roles it names. Keep the requests and answers that show the gap
   (`get_trace` gives their numbers; `get_audit` and `read_outbox` show side effects). If no API
   can be reached, say so in the plan and list what should be tried; never invent results.
3. **Find the code the change touches**, in the usual order, and name the files:
   form format and engine (`packages/form-engine`, `packages/form-package`), database
   (`packages/db`, the next free migration number in `MEMORY.md`), API routes
   (`apps/api/src/routes`), builder and screens (`apps/web`, `apps/desktop`,
   `packages/form-renderer-dom`, `packages/operations-dom`), phone and sync (`apps/mobile`,
   `packages/offline`, `apps/api/src/sync`), Forms for AI's guide, examples and checks
   (`apps/forms-ai`), docs (`docs/<area>/`), and the setup guide when a migration or a setting
   is involved.
4. **Check the rules that are easy to break** (`AGENTS.md`, `CLAUDE.md`):
   - nothing breaking inside `/v1`; what phones on an older version do (form format numbers,
     `apps/api/src/sync/form-formats.ts`);
   - tenant isolation for every new table (`tenant_id`, grant, RLS, export entry, purge);
   - a permission for every role, and staff-only ones;
   - English and Arabic for every new string; logical directions;
   - plan limits and modules enforced by the API.
5. **Write the plan** as `plan/<version>/P<nn>-<slug>.md`, the next free phase number, in the
   house format (see the files in `plan/v1.4-ai-tooling/`):
   - **Goal**; **Scope** (what is in, what is out);
   - **Where things stand**, a table, with the evidence from step 2 (trace numbers, statuses,
     what the screens show);
   - **Design**, by area;
   - **Decisions for the owner**: each open question as a question, with the options and **one
     recommendation**, and why. Include the request's own "still open" items;
   - **Tasks** in commit order (`feat(db)` → `feat(api)` → `feat(web)`/`feat(desktop)` →
     `feat(mobile)` → `feat(forms-ai)` → `docs`), and **Exit criteria**, each one testable;
   - **Status:** `PROPOSED — waiting for the owner`.
6. **Update** `plan/README.md` (the phase, marked proposed) and the request's row in
   `plan/requests/README.md` (`planned`, with the phase file). Then **stop** and tell the owner
   the plan is ready for review, item by item. Write no product code, no migration, no test.

## After the owner approves

The owner answers the decisions in the plan file and changes its status; building follows the
phase like any other. When it ships: Forms for AI's guide is regenerated from the new schemas as
it is today, the feature's examples are added, the request's row becomes `built` with the
version, and the release notes name it. A check that used to refuse the feature now passes, so
the offer to record a request no longer appears for it.
