# P39 — Change requests and planning from the preview

**Version:** v1.4 AI tooling
**Status:** `NOT STARTED`
**Depends on:** P37 (the preview window), P38 (the developer MCP server)

## Goal

When building a form shows that the platform should do something it cannot do yet, that wish is
captured on the spot with its example, carried into the repository, tried on a test company, and
turned into a phase plan the owner approves before any code changes.

```
Chat + preview  →  change request  →  tried on a test company  →  plan in plan/  →  owner approves
      ↑                                                                               ↓
Forms for AI knows the new feature      ←      release      ←      the code is built
```

## Scope

Agreed on 2026-11-10:

- **Capture happens in Forms for AI**, offline, as files. No account, no GitHub token.
- **Planning happens in the repository**, where the code is, by an AI coding tool following a
  written procedure, using the developer MCP server for evidence.
- **The plan is a proposal.** It stops for the owner's approval; nothing is built from it
  before that.
- **Handing over is copying a folder** into `plan/requests/`.
- **The first request is form actions**, already written down from the owner's decisions
  ([`plan/requests/CR-0001-form-actions.md`](../requests/CR-0001-form-actions.md)).

Out of scope: sending requests to GitHub issues, requests about parts of the product the preview
cannot show (they can still be recorded as text), and building the requested features.

## Design

### 1. What a change request is

A folder, `CR-<number>-<slug>/`:

| File                  | What                                                                                                                                                                   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request.md`          | A short header (number, title, date, kind, status) and four parts: what was wanted, in the person's words; why; what blocked it; the answers to the AI's own questions |
| `example.integr8form` | The form and PDF templates being built at that moment, saved even if they do not pass the publish check                                                                |
| `preview-*.png`       | Pictures of the Form tab and the PDF, when a browser is available                                                                                                      |

Kinds: `form_format`, `pdf_design`, `form_action`, `app_screen`, `other`. Statuses in Forms for
AI: `open`, `merged` (into another request), `dropped`, `handed_over`.

The header is checked with a schema of its own (`apps/forms-ai/src/requests/`), and the format
is written down in `docs/forms-ai/change-requests.md`.

Rule for content: a request holds sample answers only. The AI is told never to put a real
customer's data in one, and the example file is saved with the window's sample answers removed.

### 2. Capturing, in Forms for AI

Three ways in, one result:

1. **The check refuses something.** When `check_form` or `check_package` reports a feature the
   format does not have, the report ends with a line telling the AI to offer:
   "The platform cannot do this yet. Shall I record it as a change request?"
2. **The person presses "Suggest a change to the platform"** in the preview window (the button
   P37 leaves room for). It opens a box for a few words; the note reaches the AI through
   `get_preview_state`, marked as a platform suggestion.
3. **The person says it in the chat.**

In each case the AI asks the few questions that make the request usable (what should happen,
for whom, on which apps, what today's workaround is), then calls a tool:

| Tool                    | What it does                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `record_change_request` | Writes the folder under the output folder's `change-requests/`, with the session's form and pictures |
| `list_change_requests`  | The requests on this computer, with status                                                           |
| `get_change_request`    | One request in full                                                                                  |
| `update_change_request` | Edit the text, merge into another, drop, or mark handed over                                         |

The window gains a "Change requests" list showing the same.

### 3. Handing over

The person copies the request's folder into `plan/requests/` in the repository (or the AI does,
when Forms for AI and the repository are on the same machine and the person says so). Requests
are numbered again on arrival if the number is taken; the file keeps its original number in the
header.

`plan/requests/README.md` explains the folder and lists the requests with their status in the
repository: `received`, `planned` (with the phase file), `built` (with the version), `declined`
(with the reason).

### 4. Planning, in the repository

A written procedure, `docs/contributing/planning-a-change-request.md`, and a project command
for Claude Code that follows it (`.claude/commands/plan-change-request.md`). `AGENTS.md` points
to the procedure so other tools find it. Given a request number, the AI tool:

1. Reads the request and opens its example with Forms for AI's `open_package`.
2. Reproduces today's behaviour on a test company with the developer MCP server
   (`import_form_package`, `submit_form`, `call_api`), and keeps the requests and responses that
   show the gap.
3. Finds the code the change touches, across the usual sequence: form format and engine,
   database, API routes, builder and screens, phone and sync, Forms for AI's guide and checks,
   docs, the setup guide when a migration or setting is involved.
4. Checks the rules that are easy to break: nothing breaking inside `/v1`, what phones on an
   older version do, tenant isolation for any new table, permissions for every role, English
   and Arabic.
5. Writes `plan/<version>/P<nn>-<slug>.md` in the house format: goal, scope, where things stand
   (with the evidence from step 2), design, **decisions for the owner as questions with a
   recommendation each**, tasks in commit order, exit criteria.
6. Updates `plan/README.md` and the request's status, and **stops**. It writes no product code.

The developer MCP server gains two read-only tools so the AI finds requests without being told
paths: `list_change_requests` and `get_change_request`, reading `plan/requests/`.

### 5. Closing the loop

When a planned feature ships, Forms for AI's guide is regenerated from the new schemas as it is
today, the feature's examples are added, the request is marked `built`, and the release notes
name it. A check that used to refuse the feature now passes, so the offer to record a request
no longer appears for it.

### 6. Testing

- Forms for AI: the request schema; recording from a session with and without a browser; the
  refusal line in check reports; merge and drop; sample answers removed from the example.
- The page: the suggestion box and the requests list.
- Developer MCP: the two read tools over a folder of sample requests.
- The procedure itself is exercised on CR-0001 (see the exit criteria).

### 7. Docs

`docs/forms-ai/change-requests.md`, `docs/forms-ai/README.md` (tools and the staff section),
`docs/contributing/planning-a-change-request.md`, `plan/requests/README.md`, `AGENTS.md`
pointer, `MEMORY.md`.

## Tasks

- [ ] `feat(forms-ai)`: the change-request format, the four tools, the refusal line in check
      reports
- [ ] `feat(forms-ai)`: the window's suggestion box and requests list
- [ ] `feat(dev-mcp)`: `list_change_requests` and `get_change_request`
- [ ] `docs`: the format, the planning procedure, the project command, `plan/requests/README.md`,
      the `AGENTS.md` pointer
- [ ] `docs(plan)`: plan CR-0001 (form actions) with the procedure, for the owner's review

## Exit criteria

- [ ] Asking the AI for something the form format cannot do ends with an offer to record it, and
      accepting writes a request folder with the text, the example file and pictures
- [ ] "Suggest a change to the platform" in the window reaches the AI and becomes a request
- [ ] A request copied into `plan/requests/` is found by the developer MCP server's tools
- [ ] Running the planning procedure on CR-0001 produces a phase file in the house format, with
      evidence from a test company and the owner's decisions listed as questions, and changes no
      product code
- [ ] No request contains a real customer's data (the example is saved without typed answers)
- [ ] Forms for AI still makes no network request (the existing offline test covers the new
      tools)

## Notes

- A plan written by an AI tool can misjudge effort or miss a side effect. Each one is reviewed
  by the owner item by item, as the audit items were, before work starts.
- The repository is private, so pictures and example forms in `plan/requests/` are not public.
  They still must hold sample data only.
