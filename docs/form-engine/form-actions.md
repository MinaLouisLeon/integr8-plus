# Form actions (P40)

A form can say what happens when one of its submissions is submitted: **expense
claims** made from its answers, and **another form opened** for the same job. The
plan and the owner's decisions are in
[`plan/v1.5-form-actions/P40-form-actions.md`](../../plan/v1.5-form-actions/P40-form-actions.md).

## Where they live

Actions belong to the **form version**, beside the definition
(`form_versions.actions`, migration 0079), not inside it. The server alone makes
the claims, so phones never read them; the definition's format and its Node/Hermes
conformance corpus are unchanged. A published version is immutable, so its actions
are too: a change of rules reaches new submissions only. A new draft starts with
the live version's actions.

```json
[
  {
    "id": "mileage",
    "kind": "expense_claim",
    "when": { "kind": "answered", "field": "km" },
    "category": "Mileage",
    "amount": { "field": "mileage_total" },
    "description": { "en": "Mileage, {{job.reference}}", "ar": "بدل انتقال، {{job.reference}}" }
  },
  {
    "id": "handover",
    "kind": "open_form",
    "form": "<form id>",
    "when": {
      "kind": "compare",
      "operator": "eq",
      "left": { "kind": "answer", "field": "needs_handover" },
      "right": { "kind": "text", "value": "yes" }
    },
    "required": true
  }
]
```

- `when` is the engine's own expression, evaluated on the submitted answers. An
  unknown result (it reads an unanswered question) does not hold.
- `amount` names a number question or calculation at the form's top level (not in
  a repeating section). It is rounded half away from zero to piastres. Nothing,
  zero or less makes no claim (`skipped`).
- `category` is the company's expense category **by name**, matched ignoring case,
  so a form file can travel between companies. Renaming a category breaks the
  action until the form is changed; the submission then says so.
- `description` may use `{{job.reference}}`, `{{job.title}}`, `{{form.title}}`
  and `{{submission.date}}`.
- At most 10 actions; ids are lowercase letters, digits and underscores.

The schema, the checks that need only the form, and the plan of what a submit would
do are in `@integr8/form-engine` (`actions.ts`: `formActionsSchema`,
`checkFormActions`, `planFormActions`, `fillActionText`), so the server, the
builder and Forms for AI share them. The company's checks (category in use, next
form published, HR module on) are the API's (`apps/api/src/forms/action-checks.ts`).

## API

| Route                                     | What                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `PUT /v1/forms/{id}/draft/actions`        | Save the draft's actions (staff-only, like the builder); 422 `invalid_actions` on shape |
| `POST /v1/forms/{id}/draft/check`         | `actionIssues` lists what refuses them; `valid` counts them                             |
| `POST /v1/forms/{id}/draft/publish`       | 422 `invalid_actions`, or `form_action_needs_module` when claims need the HR module     |
| `POST /v1/submissions/{id}/submit`        | Runs the actions; the answer carries `formActions` and `nextForms`                      |
| `POST /v1/submissions/{id}/actions/retry` | **Make it now**: runs failed actions again, for those who amend or approve claims       |
| `POST /v1/expenses/{id}/approve`          | `approvedAmount` + `amountNote` approve a different amount (422 `amount_note_required`) |
| `GET /v1/expenses/{id}/submission`        | The submission a claim came from, read-only, for those who approve claims               |

Every claim body now carries `approvedAmount`, `amountNote`, `payableAmount` and
`submission` (`{ id, formId, title }` when a form made it).

## On submit

`runFormActions` (`apps/api/src/forms/actions.ts`) runs in the submit's own
transaction, from both submit paths: the screens' submit route and the phone's
`submission.submit` in `sync/push.ts`. A correction of a reopened submission runs
nothing; what the first submit made stays.

- **Claims are made once.** Each claim's `client_action_id` is a UUID v5 of the
  submission and the action, and `(submission_id, form_action_id)` is unique, so a
  phone's resend or a retried request finds the claim instead of making another.
  The claimant is the person who submitted, whoever runs the action.
- **Nothing refuses the submission.** Each action runs in its own savepoint; one
  that cannot be done is recorded as `failed` with a reason
  (`submission_action_results`), shown on the submission, and **Make it now** runs
  it again. A made action never changes.
- **Follow-up forms** start as a draft owned by the submitter, for the same job, and
  are linked (`submission_links`). The form joins the job's list of forms (a job's
  submissions are for its own forms), so phones list it like any other; a required
  one is added as required, so the job cannot complete until it is submitted (409
  `completion_blocked`, "submit <form>"). A form already on the job is never made
  optional by this.

## The approver's correction

The claim never changes (`hr_expense_claims_frozen`). Approving may set
`approved_amount` with `amount_note`; the database allows them only in the
`submitted → approved` step, and only when they differ from the amount claimed.
The ledger (`erp_ledger_proposal_more`), direct payment and payroll use
`coalesce(approved_amount, amount)`, which the API calls `payableAmount`. This
applies to every claim, not only those a form made.

## Not built yet

- The builder's **Actions** tab, the claim's side panel, the job's claims panel and
  the submission's "Made by this form" (web and desktop).
- The phone opening the next form after submit, and its "Update the app" gate for
  forms with follow-ups (`sync/form-formats.ts`). Until then phones see the
  follow-up in the job's forms; the server still makes the claims.
- Forms for AI (guide, interview, checks, example, a package carrying follow-up
  forms, the preview of a submit), and importing a form file with actions.
- The demo seeder's trip form.
