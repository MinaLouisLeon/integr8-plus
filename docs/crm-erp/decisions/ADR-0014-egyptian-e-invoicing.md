# ADR-0014 — Egyptian e-invoicing is a second, separate lifecycle after an invoice is issued

**Status:** Accepted (2026-10-17). Offline integration built; not
production-ready until live PreProd submissions and hardware-token signing pass
(see `docs/e-invoicing/PLAN.md` §9).

## Context

ADR-0004 and ADR-0007 made a company's invoices and credit notes an internal
commercial record, with no claim of e-invoicing or tax compliance. The first
customers are in Egypt, where the Egyptian Tax Authority (ETA) requires B2B
invoices to be submitted electronically, signed with a certificate the
taxpayer holds on a hardware token. Integr8 is multi-tenant: each company is
its own taxpayer.

## Decision

1. **A separate lifecycle.** An issued invoice stays frozen. An **ETA
   document** is an immutable snapshot built from it, with its own states,
   attempts and history (`eta_documents`, `eta_attempts`). Rejection never
   edits the invoice; the company corrects as always, with a credit note and a
   new invoice.
2. **Per-company everything.** Each company holds its own ETA client id and
   secret, sealed with AES-256-GCM under `ETA_CREDENTIALS_KEY` and bound to the
   company. There are no deployment-wide taxpayer credentials. An intermediary
   login is possible only when a company's settings name the taxpayer it acts
   for.
3. **Off by default, PreProd by default.** A module `e_invoicing` (needs
   `finance`), a company switch, and PreProd unless the company chooses
   Production _and_ the server allows it (`ETA_ALLOW_PRODUCTION`). URLs come
   from server configuration, never from the person.
4. **Signing stays on the accountant's machine.** The server never holds a
   certificate, private key or PIN. It issues signing requests bound to the
   company, document, digest, nonce and expiry; an agent signs locally after an
   explicit confirmation; the server verifies the CMS (digest, pinned
   certificate, signature) before accepting it. The hardware signer itself is a
   contract until it can be built and tested on the real token.
5. **Exact text, exact numbers.** Documents are written and canonicalised from
   a lexeme-preserving JSON model and BigInt decimals. Nothing on the way to a
   signature is a JavaScript number.
6. **Submission is gated** on a signed, verified document, the company's
   authoritative schema fetched from the ETA API, validation against it, and
   the arithmetic rules. A 2xx answer is not validity: status is reconciled
   until final. A lost answer is never resubmitted automatically.
7. **Invoices first.** Credit and debit notes are a separate extension, not
   invoices with a different label. E-receipts (point of sale) are out of scope.
8. **Unverified is labelled.** Every rule written from memory rather than the
   provided references carries `SPEC-UNVERIFIED(<id>)` in the code and a row in
   the spec register.
9. **Payroll's missing legal review is not a code task.** It needs a qualified
   person to review the rule sets (ADR-0010).

## Consequences

- The invoice, ledger and payment code do not change.
- A company without credentials, a token or an agent computer issues invoices
  as before; its documents wait.
- Hardware signing needs a native module in the desktop app, with its own
  security review and a per-vendor support matrix.
- The first live run will likely surface schema errors; the readiness screen
  and validator show them field by field.
