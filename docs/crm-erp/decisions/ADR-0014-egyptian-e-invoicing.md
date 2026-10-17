# ADR-0014 — Egyptian e-invoicing is a second step after an invoice is issued

**Status:** Accepted (planning, 2026-10-17). Not built.

## Context

ADR-0004 and ADR-0007 made a company's invoices and credit notes an internal
commercial record, with no claim of e-invoicing or tax compliance until a
jurisdiction was chosen and reviewed. The first customers are in Egypt, where
the Egyptian Tax Authority (ETA) requires taxpayers to submit invoices and
credit notes electronically, signed with a certificate the taxpayer holds on a
hardware token.

## Decision

- **Sending is separate from issuing.** An issued invoice or credit note stays
  frozen and keeps its number. "Send to the tax authority" creates a
  **submission record** beside it. A rejected submission never edits the
  invoice; the company corrects as it always does, with a credit note and a new
  invoice.
- **The ETA document is derived.** It is rebuilt from the frozen invoice for
  every attempt. Nothing in it is typed by hand.
- **Signing happens on the company's own computer.** The certificate's token
  stays plugged into the accountant's PC. The desktop app, signed in as the
  company, reads documents awaiting signature from the server, signs them, and
  returns the signature. Integr8's servers never hold the certificate or its
  PIN.
- **Each company is its own taxpayer.** It registers with the ETA, and enters
  its own client id and secret in settings; the secret is stored encrypted
  (like the HR data key) and never shown again. Integr8 is not an intermediary
  and holds no company's credentials in the clear.
- **The ETA is a port.** A `TaxAuthority` adapter has a recording
  implementation (tests, laptops) and the real one; production refuses the
  recording one. Submission, status polling and retries run in the existing
  worker with its lease rules.
- **Scope of the first release:** e-invoices and credit notes, VAT only (any
  other tax stops the document with a clear message), a person presses
  **Send** (no automatic sending). E-receipts for retail point of sale are a
  separate system and are not built.
- **A new module switch**, `e_invoicing`, off by default, needs `finance`.
  Permissions follow finance: issuers (`finance.issue`) may send; viewers read
  the status.
- **The notice stays until a document is valid.** Every printed invoice keeps
  saying it is not a certified tax document until its own submission is
  **valid**; then the copy shows the authority's identifier.
- **Payroll's missing legal review is not a code task.** It needs a qualified
  person to review the rule sets (ADR-0010); the product already makes the owner
  confirm them, and says on every payslip that an accountant must check them.

## Consequences

- The invoice, ledger and payment code do not change; the e-invoice layer
  reads them.
- A company with no token or no agent computer can still issue invoices as
  today; documents simply wait or are not sent.
- The agent is a new surface in the desktop app (token access and signing in
  its native part), with its own security review and a per-vendor support
  matrix.
- The ETA's official specification must be taken in before the document
  builder is written (plan phase E0); until then every ETA-specific detail in
  `docs/e-invoicing/PLAN.md` is a working assumption.
