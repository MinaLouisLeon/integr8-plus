# CR-0001 — Form actions

**Date:** 2026-11-10
**Kind:** `form_action`
**Status:** `received` — not planned yet. It is planned with the tools of P37–P39
([`plan/v1.4-ai-tooling/`](../v1.4-ai-tooling/)), as the first change request.

This note keeps what the owner asked for and decided in the conversation of 2026-11-10, and
what was found in the code, so the plan starts from it. It is written by hand because the
change-request tools do not exist yet; it has no example file or pictures.

## What was wanted

A company needs behaviour other companies do not: after finishing a job, its engineers fill a
form with their allowances and the kilometres they travelled; the amounts are calculated and
reach the company's accounts. When accounting looks at a job's allowances, it opens the form
they came from.

Rather than code for one company, a general feature: **a form says what happens when it is
submitted.**

## The feature, as discussed

Staff set actions on a form in the form builder:

1. **Create expense claims.** For example: category "Mileage", amount = the answer to "Mileage
   total", linked to the job and the engineer; another for "Allowance". The claims are made
   through the same code as a hand-entered claim, so approval, ledger posting, audit and
   payment are unchanged.
2. **Open another form.** After this form is submitted the app opens a second form for the same
   job, optionally only when a condition holds, required or optional. The two submissions are
   linked.
3. **Links for accounting.** A claim made by a form shows "From form: …" and opens that
   submission read-only beside approve and reject; the job page lists its allowances; the
   submission lists the claims it made and their status. Whoever may decide a claim may open
   that one submission without wider access to forms.

Forms for AI then learns actions (guide, interview questions, checks, a worked example, and one
file carrying a form with its follow-up forms), and the preview window shows what a submit
would do.

## Decided by the owner

- **The accountant corrects a wrong amount** on the claim, audited, instead of sending it back
  to the engineer.
- **Form actions are the only platform feature in this request.** Hooks, company-specific
  plugins, custom fields, outgoing webhooks and a rule builder were discussed and are not asked
  for.
- This stage builds the AI tooling only; this feature is planned afterwards.

## Still open (to ask when planning)

- Do claims made by a form wait for approval, get approved automatically, or is that a switch
  per form? (Recommended: wait for approval.)
- Where does the rate per kilometre live: a number in the form's calculation, a company
  setting, or per engineer? (Recommended: in the form. The owner had no preference.)
- Is a follow-up form required before the job can be completed?
- What the category in a form file is matched to on import (categories belong to each company).

## Found in the code (2026-11-10)

- **Expenses already cover most of the money side**: `hr_expense_claims` (0037) with category,
  claimant, optional `work_order_id`, receipts as attachments, approve / reject / withdraw /
  pay, and ledger posting on approval (`apps/api/src/routes/v1/expenses.ts`).
- **A claim can already be paid through the payslip.** The approver chooses `settle_via`:
  `direct` or `payroll` (`packages/core/src/hr.ts`). No payroll work is needed for that.
- **A submitted claim is frozen by a database trigger** ("A submitted claim does not change;
  withdraw it and claim again", `hr_expense_claims_frozen`). So "the accountant corrects"
  cannot be an edit of the amount. The likely design is an approved amount recorded at
  approval, beside the claimed amount, with a reason, leaving the form and the claim it made in
  agreement and the difference visible.
- **Submissions carry their job** (`submissions.work_order_id`) and job types list their forms
  (`job_type_forms`). There is no link between two submissions and none between a claim and a
  submission.
- **Creating claims needs no phone change**: the server does it when the submission arrives,
  including by phone sync, and must do it once even when the phone retries.
- **Opening the next form needs a new phone build** and most likely a new form format number
  (`apps/api/src/sync/form-formats.ts`), so phones on an older version say "Update the app"
  instead of silently skipping a required follow-up.
- Publishing a form with a claim action should require the company's expenses module to be on.
