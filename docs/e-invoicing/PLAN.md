# Egyptian e-invoicing (Egyptian Tax Authority) — plan

**Status:** planned, not started. Decisions recorded 2026-10-17; see
[ADR-0014](../crm-erp/decisions/ADR-0014-egyptian-e-invoicing.md).

Today a company's invoices and credit notes are an internal commercial record
(ADR-0004, ADR-0007): every printed invoice says it is not a certified tax
document. This plan makes an issued invoice or credit note something a company
can **also** send to the Egyptian Tax Authority (ETA), get accepted, and show
the authority's identifier and status next to it.

## Scope (decided with the product owner)

| Question                     | Decision                                                                                                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What is built                | **E-invoices and credit notes** only: the existing finance documents, sent to the ETA, with status tracking. Not the e-receipt (retail point of sale) system.    |
| How a document is signed     | A **signing agent** on the company accountant's own computer, where the certificate's USB token or HSM is plugged in. The certificate never leaves that machine. |
| Who registers and holds keys | **Each company** is registered with the ETA as a taxpayer and enters its own client id and secret in its settings. Integr8 acts as no intermediary.              |
| What stays as it is          | An issued invoice is still frozen. Sending is a second, separate step; a rejected document never edits the invoice.                                              |
| Payroll "legal review"       | Not code. A person with the right qualification (an accountant or lawyer) reviews the payroll rule sets; the app already makes the owner confirm them first.     |

## What the company sees

1. The company's owner opens **Settings → Tax authority** and enters the
   taxpayer's registration number, activity code, branch address, the ETA
   environment (test or live), and the client id and secret the company got
   from the ETA portal. The secret is stored encrypted and never shown again.
2. Customers get a **tax identity** (business, person or foreigner, and the
   tax or national number); items get an **item code** (GS1 or EGS) and a unit
   type. Both are optional until a document needs them, and the screen says
   which one is missing.
3. On an issued invoice or credit note: **Send to the tax authority**. Its
   status is shown from then on: waiting for signature, signed, submitted,
   **valid** (with the authority's UUID and a link to its copy), **invalid**
   (with the authority's own error messages, in plain words), cancelled.
4. The accountant's computer runs the company's desktop app, signed in, with
   the token plugged in. It picks up documents waiting for a signature, signs
   them, and returns the signature. If the computer is off, documents wait and
   the screen says so; nothing is lost.
5. Rejected documents are corrected the way an invoice is always corrected:
   a credit note and a new invoice. The old document keeps its own status.

## How it works

```
issue invoice (exists)                              company's accountant PC
      │                                              (desktop app + token)
      ▼                                                       │
 "Send"  ──► build ETA document JSON ──► state: awaiting_signature
                                                  ◄── agent polls ──┤
                                                  ──► document bytes ┤  sign (CAdES-BES)
                                                  ◄── signature ─────┘
                  state: signed
                       │   worker
                       ▼
        submit with the company's credentials ──► ETA (test or live)
                       │
          poll status until valid / invalid ──► store UUID, long id, errors
```

- The document JSON is **derived** from the frozen invoice. It is rebuilt for
  every attempt and never edited by hand.
- Everything after "Send" runs in the existing worker, with the existing
  retry and lease rules. A failed attempt shows its reason and can be tried
  again; the document is never submitted twice (the ETA's own submission id and
  our attempt record are checked first).
- The ETA adapter is a port with two implementations, like the AI providers
  and Stripe: a **recording** one for tests and laptops, and the real one.
  Production refuses the recording one.

## Data (sketch, to be fixed in E1)

- **Company tax profile:** registration number, activity code, issuer branch
  and address, environment, client id, encrypted client secret, signing mode.
- **Customer tax identity:** receiver type and number.
- **Item e-codes:** code type (GS1 or EGS), code, unit type; and one for the
  labour line.
- **Submission record per document:** document, attempt, state, ETA UUID, long
  id, submission id, errors (JSON), timestamps, and who asked.
- **Tax mapping:** our per-line tax rate (basis points) to the ETA's tax type
  and subtype. First release: VAT only; any other tax stops the document with
  a clear message rather than guessing.

## Phases

| Phase  | What                                                                                                                                                                 | Needs from outside                                      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| **E0** | Specification intake: the ETA's official document schema, signing rules and API, kept in `docs/e-invoicing/` with sample files. Decisions and this plan.             | The official SDK documents (see below)                  |
| **E1** | Migration, repositories, settings and the screens for tax profile, customer identity and item codes. Permissions and the `e_invoicing` module switch.                | —                                                       |
| **E2** | The document builder and the canonical serialisation the signature covers; checked against the ETA's sample documents byte for byte; rounding and tax maths tests.   | E0 samples                                              |
| **E3** | The adapter, the submission queue, status polling, retries, cancellation and credit-note linking; the recording adapter; routes, audit and the status UI.            | A test taxpayer with client id and secret for live runs |
| **E4** | The signing agent: a queue the desktop app reads, token access (PKCS#11) and CAdES-BES signing in the desktop app's native part, with a clear setup and test button. | The company's token model and a Windows PC with it      |
| **E5** | Arabic and English text for every state and error, the setup guide (all copies), the runbook, and the printed invoice's wording once a document is valid.            | —                                                       |
| **E6** | A rehearsal on the ETA's test environment with a real company's accountant, then the first live document.                                                            | A pilot company                                         |

Each phase is one commit, pushed as it is done; one pull request against `main`
at the end of E5. E6 is a rehearsal, not a pull request.

## What is not known yet, and why it matters

This plan was written without access to the ETA's official documentation: the
sandbox that builds Integr8 cannot reach the authority's site, and the only
sources found were third-party summaries. Before E2 starts, **these must come
from the official documents, not memory**:

- the exact document schema version in force and its required fields for
  invoices and credit notes (issuer, receiver, lines, tax totals, signatures);
- how the document is canonicalised before signing, and the signature format;
- the token endpoint, the submission endpoints and the status values;
- how long a document can be cancelled or rejected after acceptance;
- the item code rules and the tax type and subtype codes;
- what the authority requires of an ERP before it is allowed to submit (any
  registration or certification of the software itself).

Any figure in this file about these points is a working assumption to be
replaced in E0.

## Risks to keep in front of us

- **A wrong document is a tax problem for the company**, not a bug report.
  Hence the byte-for-byte sample tests, the test environment first, and no
  automatic sending in the first release: the person presses **Send**.
- **The signing token is a hardware device** with a vendor driver. What works
  on one vendor's token may not on another's; E4 supports what the first pilot
  company owns and says so.
- **Numbers must match exactly.** The ETA recomputes every total. Money in
  Integr8 is exact (`numeric` and basis points), but rounding rules per line
  and per document have to be copied from the authority's, not ours.
- **Clocks and time zones.** The issue date and time on the document must be
  valid for the authority; the document's time is fixed when it is built.
- **Compliance language.** The "not a certified tax document" notice stays on
  every invoice until its own document is **valid**; only then does the
  printed copy show the authority's UUID and QR link.
