# E-invoicing (Egyptian Tax Authority)

The `e_invoicing` module (needs `finance`): a company's issued invoices become
ETA documents, signed on the accountant's computer with the company's hardware
token and submitted to the ETA. **Test only**: nothing has been sent to the real
ETA yet, and no hardware signer ships (the token's model and middleware are not
known), so the desktop app checks a signing request and says "this build cannot
sign yet". Code: `packages/eta` (canonical form, documents, client),
`apps/api/src/eta`, routes `/v1/eta` (32 operations), the desktop's signing
queue (`apps/desktop/src/features/e-invoicing/signing-queue.tsx`).

## Permissions

`eta.read`, `eta.configure` (settings, credentials, codes; not given to the
accountant), `eta.prepare`, `eta.sign`, `eta.submit`, and `eta.switch`
(staff-only: the desktop's **E-invoicing switch**).

## Server settings

All optional; a deployment not using e-invoicing needs none.

| Setting                                     | Default | What it does                                                                                     |
| ------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------ |
| `ETA_CREDENTIALS_KEY`                       | unset   | 32 random bytes, base64. Seals each company's ETA client id and secret. Unset: none can be saved |
| `ETA_ALLOW_PRODUCTION`                      | `false` | While false, a company set to production is refused (403 `eta_production_disabled`)              |
| `ETA_PREPROD_CA_FILE`                       | unset   | Extra CAs trusted for PreProd only; TLS checks are never switched off                            |
| `ETA_PREPROD_*_URL`, `ETA_PRODUCTION_*_URL` | ETA's   | Base URL overrides for a local fake; production refuses anything not `https://`                  |
| `ETA_REQUEST_TIMEOUT_MS`                    | `30000` | Longest one ETA call may take                                                                    |
| `ETA_SIGNING_REQUEST_TTL_SECONDS`           | `900`   | How long a signing request waits for the accountant's computer                                   |
| `ETA_MAX_STATUS_CHECKS`                     | `12`    | Background status checks (15 s, doubling to an hour) before leaving it to a person               |

`ETA_CREDENTIALS_KEY` travels with the database backups like `HR_DATA_KEY`: a
database restored without it has credentials nobody can open
(`eta_credentials_unreadable`), and rotating it has the same effect. There is no
deployment-wide taxpayer credential; never add one. The worker sends
submissions (`eta.submit`) and checks statuses (`eta.reconcile`).

## Switching a company on

1. Staff turn on `finance` and `e_invoicing` (the desktop's E-invoicing switch,
   acting as the company, or the dashboard's flags).
2. The owner or an admin enters, in **E-invoicing → Settings**: tax registration
   number, registered name, branch, activity code, address, the default item code
   (EGS or GS1), the environment (**PreProd** first).
3. **Credentials**: the client id and secret of the company's ERP system from the
   ETA portal, sealed and never shown again. Staff acting as the company cannot
   enter them. **Check with the ETA** confirms them.
4. **Certificates**: the signing token's public certificate (never a private key).
5. **Schema**: list the ETA's document types, fetch invoice version 1.0 (again
   after switching environment or when the ETA publishes a new version).
6. **Codes**: ETA unit types, tax types and subtypes, item codes; and each
   invoiced customer's ETA details. Every value comes from the ETA's own tables;
   nothing is guessed.

## Sending an invoice

1. Issue the invoice as usual. Its **E-invoicing (ETA)** panel lists what stops it.
2. **Prepare ETA document** snapshots the canonical text and its SHA-256
   (preparing again supersedes one never accepted).
3. **Ask for signature** creates a signing request.
4. The desktop app's **Signing queue**, on the computer with the token, claims
   it, recomputes the digest there and shows what will be signed, read from the
   document itself; a request whose document does not match is refused before
   the token is touched.
5. The token signs (CAdES-BES, detached; its own middleware asks the PIN). The
   server accepts only the claiming member's signature, before expiry, with its
   nonce, against the stored digest and a pinned certificate. **Not possible in
   this build.**
6. **Send to the ETA**: checked again (signed, right environment, valid against
   the fetched schema, amounts add up), then sent once by the worker.
7. The ETA's 202 is not validity: the worker checks until **Valid** or
   **Invalid**; **Check status now** asks at once.

## Before production

1. Fetch the official public fixtures (`python scripts/fetch_eta_refs.py`, into
   `docs/e-invoicing/official-public/`; `packages/eta/src/canonical.test.ts`
   runs against them and skips while they are missing; see `FETCH-STATUS.md`
   there).
2. One company signs with its real token and has documents accepted **Valid** in
   PreProd, including a rejected and a cancelled case.
3. `ETA_ALLOW_PRODUCTION=true`, and the company's **owner**, on their own session,
   chooses production.

An accountant must review the setup and codes before real use.

## The ETA's references

SDK: https://sdk.invoicing.eta.gov.eg/ (invoice v1.0, the API, validation rules,
signature creation, canonicalisation). Environments:

| Environment | Identity                      | API                                      |
| ----------- | ----------------------------- | ---------------------------------------- |
| PreProd     | https://id.preprod.eta.gov.eg | https://api.preprod.invoicing.eta.gov.eg |
| Production  | https://id.eta.gov.eg         | https://api.invoicing.eta.gov.eg         |

Sign-in is OAuth 2.0 client credentials (`{identity}/connect/token`); submit is
`POST {api}/api/v1.0/documentsubmissions/`. The canonical form is the document
without signatures, property names upper-cased recursively, values kept as
given, array names repeated before each entry, hashed as UTF-8; never a generic
JSON stringify or a sorted-key form.
