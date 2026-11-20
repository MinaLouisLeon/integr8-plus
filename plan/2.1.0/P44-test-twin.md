# P44 — Test twins: building for a real company with the developer MCP server

**Status:** IN PROGRESS — option A built 2026-11-20 on branch `feat/test-twin` (from `dev`); the integration suite and a click-through in the staff app are still to run

## Goal

Let the developer MCP server help build a **real** company (its forms, PDF
templates, job types, website) without ever reaching that company. Everything an
AI tool reads goes to its model provider, so a real company's customers, people,
money and HR records must stay out of reach. The owner chose **option A**: staff
make a **test twin** (a new test company with the real company's setup and none
of its business) and the AI tool works there with the tools it already has.
Option B (a session bound to one real company, setup routes only, drafts only)
was discussed and left for later, only if moving work back from a twin proves
painful.

## Built (2026-11-20)

- `POST /v1/platform/companies/{id}/test-twin` (`apps/api/src/routes/v1/platform/test-twin.ts`,
  logic in `apps/api/src/platform/test-twin.ts`): full staff session only (a
  `test_companies` session gets 403 `session_scope`), a reason required, audited
  in the platform audit log and in the real company's own log
  (`tenant.test_twin_made`), and in the twin's (`tenant.test_twin_filled`).
- What is copied and what is not: [platform/ → Test twins](../../docs/platform/README.md#test-twins-p44).
  Form actions that open another form are pointed at the twin's copy; one whose
  form is archived is left out and counted.
- One made-up active member per built-in role, `<role>@<slug>.test-twin.example.com`,
  no sign-in account.
- Pictures (logo, app icon, PDF template pictures) are copied into the twin's
  bucket before its transaction and removed again if it fails. When storage
  cannot take them, the twin is made without them and says why
  (`storageProblem`).
- `FilesRepository.recordGenerated` takes `linkedEntity: null` (a copied logo or
  app icon belongs to no record).
- Staff app: a **Test twin** panel on the company page (reason, **Make a test
  twin**, what was copied, **Open the twin**). Strings `platform.testTwin.*`.
- The developer MCP server's `list_test_companies` says how to get a twin.
- Tests: `apps/api/src/platform/test-twin.test.ts` (slugs, action remapping,
  addresses) and `test-twin.integration.test.ts` (refused to a limited session,
  reason required, setup copied and business not, remapped actions, audit line,
  second twin's slug, taken slug, unknown company).
- Docs: `docs/platform/README.md`, `docs/contributing/developer-tools.md`.

No migration: the twin's source is recorded in the audit logs, not in a column.

## Decisions taken by default (for the owner to confirm)

- [ ] **D1 What is copied.** Setup only, as listed in the docs. Not the chart of
      accounts (expense categories arrive without their ledger account), not
      e-invoicing settings, not the website address.
- [ ] **D2 The made-up people.** One per built-in role, none per company role
      (company roles are copied but nobody holds them).
- [ ] **D3 Twins of twins.** Allowed (any company that is not closed), so a
      twin can be copied before a risky change.
- [ ] **D4 The real company's log.** It records that a twin was made, by
      "Integr8 staff", with the reason, so the company's own audit screen shows
      its setup was copied.
- [ ] **D5 Going back.** Forms only, through the existing **Copy to another
      company** (arrives as a draft). Job types, roles and settings are changed by
      hand in the real company. A "send the setup back" step is not built.

## Left

- [ ] Run `test-twin.integration.test.ts` against a disposable Postgres (not run:
      no database on the build machine).
- [ ] In the staff app (a real Tauri build, or the staff flavour in a browser as
      MEMORY.md's gotchas describe): make a twin of a real company with forms
      and PDF templates, open it, then from the developer MCP server
      `use_company` the twin, `submit_form` as an engineer, and copy a form back.
- [ ] Owner's decisions D1–D5.
