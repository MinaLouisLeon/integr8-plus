# Change requests

When building a form shows that the platform should do something it cannot do yet, Integr8 Forms
for AI records the wish on the spot, with the form that showed it (P39). The request is a folder
on the person's computer; handing it over is copying that folder into the repository's
[`plan/requests/`](../../plan/requests/README.md), where an AI coding tool plans it
([`docs/contributing/planning-a-change-request.md`](../contributing/planning-a-change-request.md))
and the owner approves the plan before any code changes.

## How a request starts

1. **A check refuses something the format does not have.** When `check_form`, `check_package` or
   any other check reports an unknown key, question type or PDF block, the report ends with a
   line telling the AI to offer: _"The platform cannot do this yet. Shall I record it as a change
   request?"_ (`isUnsupported` in `apps/forms-ai/src/mcp/report.ts`).
2. **The person presses "Suggest a change to the platform"** in the preview window. Their words
   reach the AI through `get_preview_state`, marked as a platform suggestion.
3. **The person says it in the chat.**

In each case the AI asks what should happen, for whom, on which apps (web, desktop, phone) and
what the person does today, and records the request only after they agree.

## The folder

Requests live in the output folder (default `Documents/Integr8 forms`) under `change-requests/`,
numbered in order:

```
change-requests/
  CR-0003-mileage-claims-from-a-form/
    request.md            the header and four parts below
    example.integr8form   the form and PDF templates being built, even if they do not pass the check
    example.json          instead of the file above, when the form cannot be packed yet
    preview-form.png      the window's Form tab, with nothing typed
    preview-pdf-1.png     the first page of each PDF template (up to five), with sample answers
```

The pictures need Chrome, Edge or Chromium, as PDF previews do; without one the request has
none and says so.

## request.md

```markdown
# CR-0003 — Mileage claims from a form

| Field     | Value                      |
| --------- | -------------------------- |
| Number    | 3                          |
| Date      | 2026-11-10                 |
| Kind      | `form_action`              |
| Status    | `open`                     |
| Form      | Car trip                   |
| Made with | Integr8 Forms for AI 1.3.6 |

## What was wanted

In the person's words.

## Why

The work it is for.

## What blocked it

The check's refusal, or what the format lacks.

## Answers to the questions

- **For whom?**
  Engineers, and the accountant who approves the claims.
```

| Field  | Values                                                                |
| ------ | --------------------------------------------------------------------- |
| Kind   | `form_format`, `pdf_design`, `form_action`, `app_screen`, `other`     |
| Status | `open`, `merged` (with a `Merged into` row), `dropped`, `handed_over` |
| Form   | The English title of the form being built, or `—`                     |

The header is checked with `requestHeaderSchema` (`apps/forms-ai/src/requests/format.ts`) every
time a request is written or read. The repository uses its own statuses once a request arrives:
see [`plan/requests/README.md`](../../plan/requests/README.md).

## The tools

| Tool                    | What it does                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `record_change_request` | Writes the folder, with the preview window's form and pictures (or a definition given, or none) |
| `list_change_requests`  | The requests on this computer, with status                                                      |
| `get_change_request`    | One request in full                                                                             |
| `update_change_request` | Edits the words, merges into another request, drops, opens again, or marks handed over          |

The preview window's Checks tab lists the same requests.

## Sample data only

A request holds sample answers only. The AI is told never to put a real customer's data in one.
The example file carries the form and its templates, never answers; the Form tab is pictured
with nothing typed (the window's `?blank=1`, which also sends nothing back); the PDFs print with
generated sample answers. The repository is private, but requests are read by more people than
a company's own records, so this holds there too.
