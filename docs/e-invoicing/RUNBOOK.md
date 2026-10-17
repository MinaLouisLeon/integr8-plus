# E-invoicing (ETA) runbook

How to run Egyptian e-invoicing on an Integr8 Plus deployment: what to set,
how a company is onboarded, how its documents are signed and sent, and what
to do when something goes wrong. The design is in `PLAN.md` and ADR-0014;
the accountant's own list is `ACCOUNTANT-CHECKLIST.md`.

> **Status: not production-ready.** Nothing here has been run against the
> ETA. No PreProd submission has been made, the official SDK fixtures have
> not been fetched, and no hardware signer exists yet (PLAN §9). Keep
> `ETA_ALLOW_PRODUCTION=false` until all three are done.

## 1. Server settings

| Variable                          | Default    | What it does                                                                                                                                                                    |
| --------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ETA_CREDENTIALS_KEY`             | unset      | 32 random bytes, base64 (`openssl rand -base64 32`). Seals every company's ETA client id and secret. Unset: credentials cannot be saved or used (503 `eta_key_missing`).        |
| `ETA_ALLOW_PRODUCTION`            | `false`    | Whether any company may choose the ETA production environment. While false, a company set to production is refused (403 `eta_production_disabled`), not sent to PreProd.        |
| `ETA_PREPROD_CA_FILE`             | unset      | A PEM file of extra certificate authorities trusted **for PreProd only**, if its chain is not in the system store. Production never uses it. TLS checks are never switched off. |
| `ETA_PREPROD_IDENTITY_URL` …      | ETA's URLs | Base URL overrides, for a local fake. Production refuses anything that is not `https://`.                                                                                       |
| `ETA_REQUEST_TIMEOUT_MS`          | `30000`    | Longest one call to the ETA may take.                                                                                                                                           |
| `ETA_SIGNING_REQUEST_TTL_SECONDS` | `900`      | How long a signing request waits for the accountant's machine.                                                                                                                  |
| `ETA_MAX_STATUS_CHECKS`           | `12`       | Background status checks after a submission (15 s, doubling, to an hour each) before the document is left for a person to sync.                                                 |

`ETA_CREDENTIALS_KEY` belongs with the database backups, like `HR_DATA_KEY`:
a restored database without it has credentials nobody can open, and every
company must enter theirs again (`eta_credentials_unreadable`). Rotating it
has the same effect. There is no deployment-wide taxpayer credential; never
add one.

The worker must run (`node dist/jobs/worker-main.js`): it sends submissions
(`eta.submit`) and checks statuses (`eta.reconcile`).

## 2. Switching a company on

1. Integr8 staff turn on the `finance` and `e_invoicing` modules for the
   company (Platform → Companies → Flags). Both are off by default.
2. The company's owner or an admin opens **E-invoicing → Settings** and
   enters, from the company's ETA registration:
   - tax registration number, registered name, branch id, activity code,
     registered address;
   - the default item code (EGS or GS1) for lines whose item has none;
   - the environment: **PreProd** first.
3. **Credentials**: the client id and secret of the company's ERP system,
   from the ETA portal. They are sealed on the server and never shown again.
   Integr8 staff acting as the company cannot enter them. **Check with the
   ETA** confirms them.
4. **Certificates**: the public certificate (PEM) of the signing token, never
   a private key. Only signatures by a listed certificate are accepted.
5. **Schema**: **List the ETA's document types**, pick the invoice type and
   version 1.0, **Fetch this schema**. Repeat after switching environment,
   and when the ETA publishes a new version.
6. **Codes**: the ETA unit type for each unit used, the ETA tax type and
   subtype for each tax rate used, and item codes where items have their own.
7. On each customer invoiced: the customer's ETA details (business, person or
   foreigner; registration number; address), from the invoice's panel.

Nothing in the codes is suggested or guessed: every value comes from the
ETA's own tables (PLAN §6).

## 3. Sending an invoice

1. Issue the invoice in Integr8 as usual.
2. On the invoice, the **E-invoicing (ETA)** panel lists what stops it
   (readiness). When nothing does, **Prepare ETA document** snapshots the
   document text and its SHA-256. Preparing again supersedes a document that
   was never accepted.
3. On the document, **Ask for signature** creates a signing request.
4. On the computer that holds the company's token, the desktop app's
   **Signing queue** shows the request. **Review** claims it, recomputes the
   document's digest on that computer, and shows what will be signed, read
   from the document itself.
5. The token signs (CAdES-BES, detached). The token's own middleware asks
   for the PIN; Integr8 never sees it. The server accepts the signature only
   from the member who claimed the request, before it expires, with its
   nonce, verifying against the stored digest and a pinned certificate.
6. **Send to the ETA**. The server checks, again, that the document is
   signed, in the environment it was prepared for, valid against the fetched
   schema, and that its amounts add up; then the worker sends it once.
7. The ETA's 202 is not validity. The worker checks the status until the ETA
   says **Valid** or **Invalid**; **Check status now** asks at once.

**Today, step 5 cannot happen**: the desktop app reports "this build cannot
sign yet". See §6.

## 4. When something goes wrong

| What you see             | What it means                                                         | What to do                                                                                                                                                                                                        |
| ------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Not sent** (`failed`)  | The ETA definitely did not accept the request (credentials, refusal). | Fix the cause shown, then **Send to the ETA** again.                                                                                                                                                              |
| **Outcome unknown**      | No clear answer: timeout, dropped connection, 5xx, 409/422.           | Search the ETA portal for the invoice number. Found: **Say what happened → shows it**, with the UUID. Not found: **does not show it**, then send again. Never send again without looking: it creates a duplicate. |
| **Rejected**             | The ETA refused the document on submission.                           | Read the ETA's errors on the document, correct the invoice or codes, **Prepare again**.                                                                                                                           |
| **Invalid**              | The ETA validated it and found errors.                                | Same as rejected. The invalid document stays in the history.                                                                                                                                                      |
| **Sent, awaiting**, long | Checks ran out without a final answer.                                | **Check status now**.                                                                                                                                                                                             |
| `eta_schema_invalid`     | The document does not pass the fetched schema.                        | Usually a code or a missing field; the details name the path. Fix and prepare again.                                                                                                                              |
| `eta_credentials_*`      | Missing, refused, or unreadable with this server's key.               | Enter the credentials again and **Check with the ETA**.                                                                                                                                                           |
| `eta_signature_refused`  | The returned signature did not verify.                                | Check the pinned certificate is the token's; ask for the signature again.                                                                                                                                         |

Every call to the ETA is listed on the document (**Calls to the ETA**) with
its correlation id, status and error code — never tokens, secrets or the
document's contents. The audit log records who did what, by id and state.

A valid document is cancelled with **Cancel at the ETA**; the invoice in
Integr8 does not change, so issue a credit note or void it as well.

## 5. Going to production

Only after, for this deployment:

1. the official SDK fixtures are fetched and their tests pass
   (`python scripts/fetch_eta_refs.py`, commit `docs/e-invoicing/official-public/`);
2. one company has signed with its real token and had documents accepted as
   **Valid** in PreProd, including a rejected and a cancelled case;
3. `ETA_ALLOW_PRODUCTION=true` is set, and the company's **owner**, on their
   own session, chooses production and confirms it.

Then fetch the production schema and repin certificates if they differ.

## 6. The signing agent

The desktop app is the agent: signed in as a member with `eta.sign`, on the
computer the token is plugged into. It needs, and does not yet have, a
native signer for the token (PKCS#11 on the token's middleware, or Windows
CNG), written against `DigestSigner` in `@integr8/eta`. Until then the queue
checks each request and says it cannot sign. What the signer needs is in
`ACCOUNTANT-CHECKLIST.md`: token model, middleware and its version, operating
system, and the certificate's issuing CA.

## 7. Removing the module

`0049_e_invoicing.down.sql` drops every e-invoicing table and the flag. It is
for development databases: on a live deployment it deletes every company's
settings, sealed credentials and the record of every document sent. The
invoices are untouched; what the ETA holds stays at the ETA. Turning the
`e_invoicing` flag off is the reversible way.
