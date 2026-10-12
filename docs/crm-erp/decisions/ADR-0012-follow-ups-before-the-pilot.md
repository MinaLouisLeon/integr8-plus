# ADR-0012 — Follow-ups before the pilot

**Status:** Accepted (eighth round planning, 2026-10-12)

## Context

Seven rounds built CRM and ERP from leads to a general ledger, HR, payroll
and manufacturing. Each left follow-ups in the phase tracker. Before the
pilot (phase L), the product owner chose a round that clears most of them:
everything in CRM and sales, everything in inventory and the field, the CI
and self-hosting checks, and the follow-ups from the seventh round. The email
channel and server-rendered PDFs stay out (no new dependencies in this
round).

## Decision — platform (F2a)

- **Refusals in the reader's language.** Every error code the API can return
  is collected from the route definitions and given an English and an Arabic
  message; web, desktop and the phone show those instead of the server's
  English text. A test fails when a code has no translation.
- **Licence policy in CI.** Permissive licences only (MIT, ISC, BSD-2/3,
  Apache-2.0, 0BSD, Unlicense, CC0, BlueOak, Python-2.0 and the like); GPL,
  AGPL, LGPL, SSPL, unknown or missing licences fail the build, with a
  reviewed exceptions file. Built on `pnpm licenses`, no new dependency.
- **Self-hosting audit.** A document listing every service production needs,
  whether it can be self-hosted, and what replaces it (PLAN.md §10.4).
- **Seventh-round follow-ups.** Read any bill-of-materials version by id; a
  preferred-supplier picker on the item editor; the short quantity in
  shortage refusals; assembly order numbers on drafted plan rows; the reason
  a pay run cannot be approved; insurance export and HR-key availability told
  apart; company details on payslips; expense categories in the phone's sync;
  payslips on the phone.

## Decision — CRM and sales (F2b)

- **Pipelines.** Owners and admins add, rename, reorder and archive
  pipelines and stages (won and lost outcomes kept). Archiving a stage that
  holds open opportunities asks where to move them; archived stages stay in
  history. Dispatchers use pipelines but do not edit them.
- **Customer 360.** The customer screen gains its quotes, sales orders,
  invoices and account (what is owed, on account), each shown by module and
  permission, and one read-only timeline mixing CRM activities with job
  events, submissions and documents issued, newest first.
- **Analytics.** Quote conversion (accepted, declined, expired) and median
  days to acceptance; opportunity win rate and median days to close by
  source, owner and stage reached; pipeline value per stage at month ends,
  weighted and unweighted; parts used by engineer, customer and job type.
- **Exports.** CSV of leads and opportunities for whoever can manage CRM, and
  of stock movements for whoever can move stock; each export audited with
  its filters; formula-like cells escaped.

## Decision — inventory and the field (F2c)

- **Site locations.** Created from the screens. Each says whether its stock
  is **ours** (consignment or spares held at the customer: counted, valued,
  moved there by transfer, used on jobs at that site) or **the customer's**
  (a record of what they hold: not valued, not in our stock totals, planning
  or the ledger; moving there from our stock issues it from ours).
- **Item media.** Several images per item (one marked main) and PDF
  datasheets, through the existing media storage, for everyone who can see
  the item. The main image goes to the phone for offline use; datasheets open
  online.
- **Supplier price lists.** A price per supplier and item in the supplier's
  currency, valid from and to, with optional quantity breaks. A new purchase
  order line takes the price in force for its quantity; the person may change
  it. Planning's drafts use it too.
- **Reorder.** For a location, items below their reorder level are listed
  with the quantity to bring them back to it, net of what is on order and
  rounded up to a price break's minimum; chosen lines become one draft
  purchase order per supplier. Approval as usual.
- **Hand deliveries.** Whoever manages sales orders delivers some or all of a
  line from a chosen location (its reservation first), never more than
  ordered; stock leaves as a sale; a printable delivery note can be produced.
- **Phone stock work.**
  - Van replenishment: an engineer asks for items, or accepts what the van's
    reorder levels propose; a store person picks at a warehouse, which
    transfers to the van, possibly less than asked; the engineer sees it
    arrive. **Online only**, by the product owner's decision.
  - Parts bought at a merchant: recorded on the job with the price paid and a
    receipt photo, as a non-stock part used; nothing enters stock. Works
    offline like parts used today. Paying oneself back stays an expense
    claim.
  - Receiving purchase orders by barcode: store staff open an approved order
    on the phone, scan to count each item (or type a quantity), see ordered
    against scanned, then record the receipt. Online only.
  - The van's offline stock shows what is reserved and what is available.

## Decision — delivery

One branch, slices pushed as done (F2a platform, F2b CRM and sales, F2c
inventory and field), docs and the tracker at the end, one pull request to
`main`, then stop.

## Consequences

The pilot starts with the plan's follow-ups closed or decided. The email
channel (follow-up reminders, sending purchase orders and quotes) and
server-rendered PDFs remain open and need a decision on dependencies.

## As built

- **F2a.** 323 error codes, extracted from the API source
  (`pnpm --filter @integr8/api error-codes`) into
  `packages/i18n/src/api-error-codes.ts`, each with an English and an Arabic
  message under `apiErrors`; `apiErrorMessage` everywhere, the phone
  included. `pnpm licences:check` in CI with five reviewed exceptions
  (`scripts/licences/exceptions.json`). The self-hosting audit is
  `08-operations-selfhosting.md`. The seventh round's follow-ups landed in
  the API and the screens.
- **F2b.** No migration: permission `crm.pipeline.manage`; the customer
  timeline and the figures are read on request from the documents and their
  history. Value by stage at a month end uses today's amounts, because
  amount changes are not kept. Exports are capped at 50,000 rows and say so.
- **F2c.** Migration 0040. Moving our stock to a site holding the customer's
  stock is an issue at its average cost; deliveries by hand and stock left
  with a customer post to cost of parts used. Merchant parts are their own
  table, not part lines, so stock and its invariants are untouched; they
  count in the job's cost and in parts usage. Reorder suggestions are raised
  to the smallest price break in the company currency. Van refills, receiving
  by scan and payslips on the phone are online only and queue nothing.
- **Not done here.** Menu entries for the new screens (reached through
  links), a device run of the phone screens, and everything this ADR keeps
  out (email, server-rendered PDFs).
