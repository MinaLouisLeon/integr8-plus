# Change requests

Wishes for the platform found while building forms with Integr8 Forms for AI (P39), waiting to
be planned. Each is a folder copied from the person's computer (`CR-<number>-<slug>/` with
`request.md`, its example `.integr8form` and pictures; format in
[`docs/forms-ai/change-requests.md`](../../docs/forms-ai/change-requests.md)), or a note written
by hand (`CR-<number>-<slug>.md`).

**Handing one over:** copy its folder here. If its number is taken, give it the next free number
in the folder name and leave the number in its `request.md` as it was, so the person can still
find it on their computer. Then add a row below.

**Planning one:** an AI coding tool follows
[`docs/contributing/planning-a-change-request.md`](../../docs/contributing/planning-a-change-request.md)
(Claude Code: `/plan-change-request <number>`). It writes a phase plan and stops; nothing is
built before the owner approves the plan. The developer MCP server's `list_change_requests` and
`get_change_request` read this folder.

Content rule: sample data only, never a real customer's.

## Requests

| Request                                         | Kind          | Status in the repository | Plan or reason                                            |
| ----------------------------------------------- | ------------- | ------------------------ | --------------------------------------------------------- |
| [CR-0001](CR-0001-form-actions.md) Form actions | `form_action` | `planned`                | [P40](../v1.5-form-actions/P40-form-actions.md), proposed |

Statuses: `received` (here, not planned), `planned` (with its phase file), `built` (with the
version), `declined` (with the reason).
