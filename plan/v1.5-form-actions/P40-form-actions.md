# P40 — Form actions

**Version:** v1.5 Form actions
**Status:** `PROPOSED — waiting for the owner` (planned 2026-11-10 from
[CR-0001](../requests/CR-0001-form-actions.md) with the procedure in
`docs/contributing/planning-a-change-request.md`)
**Depends on:** P07 (form builder), P09/P13 (submissions and phone sync), the expenses module
(0037), P37–P39 (the tools it was planned with)

> **Evidence step not done yet.** This plan was written on a machine with no running API and no
> database, so step 2 of the procedure (reproduce today's behaviour on a test company with the
> developer MCP server) could not run. "Where things stand" below comes from reading the code.
> Before approval, run on a seeded test company: import a trip form, `submit_form` as an
> engineer with kilometres, then `call_api` `GET /v1/expenses` as the accountant and
> `GET /v1/submissions/{id}` — expected: no claim exists, and nothing links the two. Add the
> trace numbers under "Where things stand".

## Goal

A form says what happens when it is submitted. Staff set **actions** on a form in the form
builder: create expense claims from its answers, and open a follow-up form for the same job. A
company that pays mileage and allowances from a form stops typing every claim again, and
accounting sees each claim beside the form it came from.

## Scope

In:

- **Create expense claims** on submit: category, amount from an answer (usually a calculation),
  description, linked to the job and the person who submitted. Made by the server, through the
  same code as a hand-entered claim, so approval, ledger posting, audit and payment are unchanged.
- **Open another form** after submit, for the same job, optionally only when a condition holds;
  required or optional. The two submissions are linked.
- **Links for accounting**: a claim made by a form shows "From form: …" and opens that submission
  read-only beside approve and reject; a job lists its claims; a submission lists the claims it
  made and their status. Whoever may decide a claim may open that one submission.
- **The accountant corrects a wrong amount** on the claim, audited (owner's decision), without
  editing what the engineer claimed.
- **Forms for AI** learns actions: guide, interview questions, checks, an example, one file
  carrying a form with its follow-up forms; the preview window shows what a submit would do.

Out (owner's decision): hooks, company plugins, custom fields, outgoing webhooks, a general rule
builder. Other action kinds (stock movements, invoices, notifications) are not part of this
phase; the design leaves room for them.

## Where things stand (from the code, 2026-11-10)

| Need                                   | Today                                                                                                                                                |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Expense claims                         | `hr_expense_claims` (0037): category, claimant, optional `work_order_id`, amount, `client_action_id` (a resent claim lands once); approve/reject/pay |
| Who submits and who decides            | `expense.submit`: every role but viewer; `expense.approve`: owner, admin, HR manager (`permissions.table.md`). Routes need the `hr` module           |
| Making a claim from code               | `submitClaim(tx, principal, body)` in `apps/api/src/routes/v1/expenses.ts`, shared with the phone's outbox                                           |
| Changing a claim's amount              | Impossible by design: trigger `hr_expense_claims_frozen` ("A submitted claim does not change; withdraw it and claim again")                          |
| Paying through the payslip             | Already: the approver chooses `settle_via` `direct` or `payroll`                                                                                     |
| Where a submit happens                 | Two places: `POST /v1/submissions/{id}/submit` (`submissions.ts`, `tx.submissions.submit`) and the phone's `submission.submit` in `sync/push.ts`     |
| A submission's job                     | `submissions.work_order_id`; job types list their forms (`job_type_forms`)                                                                           |
| Links submission ↔ submission or claim | None                                                                                                                                                 |
| Form settings beside the definition    | `forms.fill_roles`, `forms.signature_required`; definition and its format in `form_versions` (`definition_schema_version`)                           |
| Phones and new form features           | `apps/api/src/sync/form-formats.ts`: a definition newer than the phone's reader shows "Update the app" (format 2 needs 1.3.0)                        |
| Forms for AI                           | Refuses an unknown key such as `actions` ("Unrecognized key") and now offers to record a change request (P39)                                        |

## Design

### 1. Where actions live

Actions are part of the **form version**, beside the definition, not inside it: a new
`form_versions.actions jsonb not null default '[]'` (migration 0078). Reasons: claims are made by
the server, so phones need not read that part at all; the definition's format and its
byte-for-byte conformance suite (Node and Hermes) stay as they are; and a published version
keeps its actions, so a change of rules reaches only new submissions.

The one action a phone must understand, opening a follow-up form, is sent to phones with the
form version as `followUps` (section 4) and gated by an app version, the way format 2 is.

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
    "id": "allowance",
    "kind": "expense_claim",
    "category": "Allowance",
    "amount": { "field": "allowance_total" },
    "description": { "en": "Daily allowance", "ar": "بدل يومي" }
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
    "required": false
  }
]
```

`when` uses the engine's own expressions, evaluated on the submitted answers, so a condition means
exactly what it means in the form. `amount` names a number question or calculation of the
form, top level only (not inside a repeating section) in this phase.

Checked at save and publish (`packages/form-package` gains the actions schema and checks):
fields exist and are numbers, ids are unique, categories exist in the company (and are not
archived), the follow-up form exists and is published, no form opens itself, at most 10 actions.
**Publishing a form with a claim action needs the company's HR module on** (expenses live
there); otherwise 422 `form_action_needs_module`.

### 2. Making the claims (server only)

After a successful submit, in the same transaction, in **one function** called from both submit
paths (`apps/api/src/forms/actions.ts`, called by `submissions.ts` and `sync/push.ts`):

- for each `expense_claim` action whose `when` holds and whose amount is positive, call
  `submitClaim` as the submitter with: the category, the amount (rounded to piastres as claims
  are), `spent_on` = the submission's local date, the job, the description with placeholders
  filled, and `client_action_id` = a UUID v5 of `submission id + action id`. A resent phone
  submit or a retried request therefore makes each claim once, by the claim table's own unique
  key;
- record the link: `hr_expense_claims.submission_id` and `form_action_id` (new columns in 0078;
  added to the frozen trigger's list, so they never change after insert);
- a claim that cannot be made (category archived since publish, HR module switched off, amount
  missing) does **not** refuse the submission: the engineer's work is saved, the failure is
  written to the submission's history and the audit log, and the office sees "Claim not made:
  <reason>" on the submission with a **Make it now** button (which runs the same function).

A correction of a reopened submission (`reason` given) does not make new claims; claims already
made stay, and the submission page shows them beside the corrected answers.

### 3. The accountant's correction

The frozen trigger stays. Approval gains an **approved amount**: `hr_expense_claims.approved_amount`
(null = as claimed) and `amount_note` (required when it differs), set only in the
`submitted → approved` step. Ledger posting and payment use the approved amount; the claim shows
both ("Claimed 420.00, approved 380.00: wrong rate"). Audited as `expense.approved` with both
amounts. The engineer's claim, the form and the claim it made stay in agreement, and the
difference is visible. This applies to every claim, not only form-made ones.

### 4. Opening a follow-up form

- `submission_links (tenant_id, from_submission_id, to_submission_id, form_action_id)`; the
  follow-up is started for the same job when the first is submitted (server), as a draft owned by
  the same person, and linked.
- The submit answer (web, desktop) and the sync pull (phone) carry `nextForms`: the drafts to
  open now, required or optional. Web and desktop open the next draft at once; the phone does the
  same once it has the app version that reads them.
- **Required** follow-ups: completing the job is refused while one is not submitted
  (`job_follow_up_open`), if the owner chooses so (decision 3).
- Phones older than the release get the form with an "Update the app" mark when it has a
  follow-up action (`form-formats.ts` gains an action gate), so a required follow-up is never
  skipped silently; the server still makes the claims for them.

### 5. Screens

| Where           | What                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Form builder    | An **Actions** tab: add "Create an expense claim" or "Open another form", with the question pickers, condition and preview |
| Expense claim   | "From form: <title>", opening the submission read-only in a side panel beside Approve / Reject; approved amount and note   |
| Job page        | **Claims** panel: the claims of this job with status and amount                                                            |
| Submission page | **Made by this form**: the claims (status, amount, link) and the follow-up submission; "Claim not made" with Make it now   |
| Phone           | After submit, "Next: <form>" opens the follow-up draft; required ones are marked                                           |

Access: a person holding `expense.approve` may open, read-only, the one submission a claim they
can decide came from, even without `form.read` (a check by claim, in `media-access.ts` style).

### 6. Forms for AI

Guide section `actions` generated from the new schema; interview questions ("What should happen
when this form is submitted? Which amounts become claims, in which category? Is there a next
form?"); checks that match the server's; an example form with two claim actions and a follow-up;
a `.integr8form` that carries a form with its follow-up forms (package format version bump with
the strict reader taught both). The preview window's Submit shows "Would create: Mileage claim
120.00 for the job; would open: Handover form" instead of sending anything. Staff import maps
categories by name and stops at a missing one with a choice to create it (decision 4).

## Decisions for the owner

1. **Do claims made by a form wait for approval?** Options: always wait; approve automatically;
   a switch per action. **Recommended: always wait for approval.** The accountant's correction
   (section 3) is how a wrong amount is fixed, and it happens at approval.
2. **Where does the rate per kilometre live?** Options: a number in the form's calculation; a
   company setting the form reads; per engineer. **Recommended: in the form's calculation**
   (no new setting; a rate change is a new form version, which is also a record of when it
   changed). The owner had no preference.
3. **Is a required follow-up form needed before the job can be completed?** Options: yes,
   completing is refused until it is submitted; no, "required" only means it opens at once and is
   shown as outstanding. **Recommended: yes**, since "required" should mean something; a
   dispatcher can still cancel the job.
4. **What is a claim category matched to when a form file is imported into another company?**
   Options: by name, stopping at a missing one with "Create it / choose another"; by name,
   creating missing ones silently; leave actions out on import. **Recommended: by name, and ask.**
5. **Does the approved-amount correction apply to every claim**, or only to those a form made?
   **Recommended: every claim** (one rule for the accountant).
6. **When a claim cannot be made, should the submission be refused instead?** **Recommended:
   no** (section 2): the engineer's work is never lost to an office setting; the office is told
   and can make the claim with one button.

## Tasks

- [ ] `feat(db)`: 0078: `form_versions.actions`; `hr_expense_claims.submission_id`,
      `form_action_id`, `approved_amount`, `amount_note` (frozen-trigger list updated);
      `submission_links`; export and purge coverage
- [ ] `feat(form-engine)`: actions schema and checks in `@integr8/form-package` (server and Forms
      for AI share them)
- [ ] `feat(api)`: actions saved and published with a form version; `forms/actions.ts` called by
      both submit paths; claims made once (UUID v5); approved amount at approval; follow-up drafts
      and `nextForms`; `job_follow_up_open`; read-only submission access for claim deciders;
      OpenAPI and client
- [ ] `feat(web)`, `feat(desktop)`: the builder's Actions tab; claim, job and submission panels;
      opening the next form (operations-dom and form-renderer-dom)
- [ ] `feat(mobile)`: opening the follow-up draft; the update-the-app gate
- [ ] `feat(forms-ai)`: guide, interview, checks, example, multi-form package, preview of a submit
- [ ] `feat(api)`: the demo seeder's forms section gains a trip form with claim actions
- [ ] `docs`: forms, expenses, form package format, Forms for AI, setup guide (migration 0078
      part, both copies), `MEMORY.md`; CR-0001 marked `built`

## Exit criteria

- [ ] A form with two claim actions, submitted on the web and by a phone (offline, then synced
      twice), makes exactly two claims linked to the job, the engineer and the submission
- [ ] The accountant approves one at a lower amount with a note; the ledger posts the approved
      amount; the claim shows both; the audit log has both
- [ ] A person with `expense.approve` and no `form.read` opens the claim's submission read-only,
      and no other submission
- [ ] A conditional follow-up opens only when its condition holds, for the same job, linked; a
      required one blocks completing the job (if decision 3 says so)
- [ ] A phone older than the release shows "Update the app" for a form with a follow-up action
- [ ] A claim that cannot be made leaves the submission saved and says why, and **Make it now**
      makes it once
- [ ] Forms for AI builds, checks, previews and saves a form with actions, and staff import it
      into another company with categories matched
- [ ] Integration suites cover both submit paths, the retry, the trigger and the permissions

## Notes

- The plan was written by an AI tool from the code; effort and side effects need the owner's
  review item by item, as the audit items were.
- Planned from CR-0001's own notes ("Found in the code") and a fresh read of `expenses.ts`,
  `0037_*.up.sql`, `submissions.ts`, `sync/push.ts`, `sync/form-formats.ts`,
  `permissions.table.md` and `schema.ts`.
