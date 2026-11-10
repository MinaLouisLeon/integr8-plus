---
description: Plan a change request from plan/requests/ into a phase file, and stop for the owner
argument-hint: <request number, e.g. 1 or CR-0001>
---

Plan change request $ARGUMENTS by following `docs/contributing/planning-a-change-request.md`
exactly. In short:

1. Read the request (`get_change_request` from the `integr8-dev` MCP server, or the file in
   `plan/requests/`) and, if it has an example, open and check it with Integr8 Forms for AI.
2. Reproduce today's behaviour on a test company with the developer MCP server and keep the
   trace numbers that show the gap. If no API can be reached, say so; never invent results.
3. Find the code it touches, area by area, and check the rules in `AGENTS.md`.
4. Write `plan/<version>/P<nn>-<slug>.md` in the house format, with the evidence, the design,
   the owner's decisions as questions with one recommendation each, tasks in commit order and
   exit criteria. Status: `PROPOSED — waiting for the owner`.
5. Update `plan/README.md` and the request's row in `plan/requests/README.md`, then stop.

Write no product code, no migration and no test. Do not commit unless the person asks.
