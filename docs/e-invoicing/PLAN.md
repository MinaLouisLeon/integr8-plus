# Egyptian e-invoicing (ETA) — design, status and spec register

Decisions: [ADR-0014](../crm-erp/decisions/ADR-0014-egyptian-e-invoicing.md).
Task brief: [TASK-BRIEF.md](./TASK-BRIEF.md). References: [README.md](./README.md).
Accountant inputs: [ACCOUNTANT-CHECKLIST.md](./ACCOUNTANT-CHECKLIST.md).
Operating it: [RUNBOOK.md](./RUNBOOK.md).

**Status: offline integration built; not production-ready.** Live PreProd
submission and hardware-token signing are blocked (see "Blockers"). Nothing
here is an ETA approval or a compliance sign-off.

## 1. Discovery: what the repository already has

| Area                 | Where                                                                                                                 | Used for ETA                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Stack                | pnpm/Turborepo; Fastify + Kysely/Postgres API and worker; Next.js web; Tauri desktop; Expo phone                      | Same stack; no new runtime                                                                              |
| Tenancy              | `tenant_id` on every company table, RLS policy `app_current_tenant_id()`, `withTenant()`                              | Every ETA table is tenant-scoped with the same policy                                                   |
| Invoices             | `erp_invoices`, `erp_invoice_lines` (migration 0030), `/v1/finance/*`, `finance.*` permissions                        | Source of an ETA document; never changed by ETA                                                         |
| Amounts              | `numeric(20,4)`, discount and tax as basis points per line, `erp_line_total` rounds each step to 4 places             | Read as decimal strings; ETA amounts recomputed with BigInt decimals                                    |
| Issuer               | `erp_finance_settings` (legal name, address, tax reference) printed on invoices                                       | Not reused for ETA: the ETA issuer has structured address fields and a registration number of its own   |
| Customers            | `customers` (free-text address, `country_code`)                                                                       | ETA receiver identity kept beside it (`eta_receivers`)                                                  |
| Items                | `erp_items` (SKU, unit, barcode); invoice lines may have no item                                                      | ETA item code kept beside it (`eta_item_codes`); a company default code for lines with no item          |
| Units                | Fixed list on lines (`each`, `kg`, `hour`, …)                                                                         | Mapped per company to ETA unit types (`eta_unit_types`), entered by the company, never guessed          |
| Currency             | `erp_invoices.currency_code`; company default EGP                                                                     | EGP sent as is; any other currency needs an exchange rate typed when the document is prepared           |
| Time zone            | `tenant_settings.timezone`; `issued_at timestamptz`                                                                   | `dateTimeIssued` is the invoice's `issued_at` in UTC                                                    |
| Modules, permissions | `MODULE_FEATURES`, `MODULE_REQUIRES`, permission matrix in `@integr8/core`; routes declare `permission` and `feature` | New module `e_invoicing` (needs `finance`) and five `eta.*` permissions                                 |
| Secrets at rest      | `HR_DATA_KEY` + AES-256-GCM with bound context (`apps/api/src/hr/sealed-fields.ts`)                                   | Same construction under a separate key, `ETA_CREDENTIALS_KEY`                                           |
| Background work      | `jobs` table, leases, retries, dead letters (`apps/api/src/jobs`)                                                     | `eta.submit` and `eta.reconcile` queues                                                                 |
| Audit                | `audit_log` per company, append-only                                                                                  | Every ETA action, with ids and states only: no secrets, tokens or document bodies                       |
| i18n                 | `@integr8/i18n` EN/AR with parity tests; API error codes extracted and translated                                     | Every new string and error code in both                                                                 |
| Desktop native       | `apps/desktop/src-tauri`: keychain commands only                                                                      | Hardware signing needs a native module; **not added** (cannot be compiled or tested here, see Blockers) |

## 2. Module boundaries

- **`@integr8/eta`** (new package, no database, no network of its own):
  - `json-text`: a JSON reader and writer that keep every number exactly as
    written and every property in order. A document is never parsed into
    JavaScript numbers on its way to a signature.
  - `canonical`: the ETA serialisation and its SHA-256.
  - `decimal`: BigInt fixed-point arithmetic.
  - `invoice`: maps an Integr8 invoice to an ETA invoice document, and the
    readiness diagnostics that say what is missing.
  - `rules`: the arithmetic checks re-run on a built document.
  - `schema`: validation against the authoritative JSON Schema fetched from
    the ETA (Ajv).
  - `state`: the document state machine.
  - `cms`: CAdES-BES assembly from a signature made elsewhere.
  - `signer`: the signer contract and the signing-request protocol.
  - `client`: the ETA HTTP client (token cache, submit, status, PDF, cancel,
    document types), over an injected transport.
  - `@integr8/eta/node`: the HTTPS transport (with an optional PreProd CA)
    and server-side CMS verification.
  - `@integr8/eta/testing`: the **test-only** software signer.
- **Database** (`@integr8/db`, migration `0049_e_invoicing`): settings,
  receivers, item codes, unit and tax mappings, documents, attempts, signing
  requests, fetched schemas.
- **API** (`apps/api`): routes under `/v1/eta/*`, the sealed credentials, the
  worker jobs, the audit trail.
- **Screens** (`@integr8/operations-dom`, web and desktop): Tax authority
  settings, receivers and codes, the e-invoice panel on an invoice, and the
  signing queue in the desktop app.

## 3. Lifecycle

An ETA document is separate from the invoice. Preparing builds an
**immutable snapshot**; preparing again supersedes an unsubmitted one and
never edits it.

```
ready ──request signature──► pending_signature ──agent returns a verified CMS──► signed
  ▲                                │ expiry or cancel                               │ submit (person)
  │                                ▼                                                ▼
  └──────────── prepare again ◄── ready                                       submitting (worker)
                                                                                    │
            ┌─────────────────────────┬───────────────────────────┬─────────────────┤
            ▼                         ▼                           ▼                 ▼
        rejected                  submitted ──poll──► valid / invalid      unknown (no answer)
   (refused in the response)        (accepted, not final)      cancelled         │ reconcile by hand:
                                                                                  │ "found it" (UUID) → submitted
                                                                                  │ "never arrived"   → signed
        failed (definite error before acceptance: auth, 4xx) ──retry──► signed
```

- A 2xx answer to a submission is **not** a valid document: it only moves the
  document to `submitted`, and the reconcile job polls until the ETA says
  `Valid`, `Invalid` or `Cancelled`.
- A submission whose answer was lost (timeout, connection reset) becomes
  `unknown` and is **never** sent again automatically. A person checks the
  portal and says which it was.
- A v1.0 document cannot be submitted unsigned: `submit` requires `signed`,
  a stored CMS that verified against the snapshot's digest, and a pinned
  certificate.

## 4. Security

- **Per company, nothing shared.** Each company's client id and secret are
  sealed with AES-256-GCM under `ETA_CREDENTIALS_KEY`, with the company and
  the field bound in. They are write-only through the API and never returned,
  logged or audited. There are no deployment-wide taxpayer credentials.
- **Tokens stay on the server**, cached in memory per company, environment and
  credential version, refreshed before expiry, one request at a time.
- **Environment from the server, not the person.** A company chooses PreProd or
  Production; the URLs come from server configuration. Production also needs
  `ETA_ALLOW_PRODUCTION=true` on the server. A document records its
  environment when prepared, and can only be submitted there.
- **Signing.** The certificate and its PIN never leave the accountant's
  machine. The server issues a signing request bound to the company, the
  document, the canonical digest, a random nonce and an expiry. The agent shows
  what it is signing and the certificate, and needs an explicit confirmation.
  The server verifies the returned CMS (digest, certificate pin, signature)
  before accepting it.
- **Logs and audit** carry ids, states, HTTP statuses and ETA error codes; never
  tokens, secrets, PINs or document bodies.

## 5. Permissions (module `e_invoicing`, which needs `finance`)

| Permission      | Owner | Admin | Dispatcher | Viewer | What                                                              |
| --------------- | ----- | ----- | ---------- | ------ | ----------------------------------------------------------------- |
| `eta.read`      | ✓     | ✓     | ✓          | ✓      | See settings (without secrets), readiness, statuses, history      |
| `eta.prepare`   | ✓     | ✓     | ✓          |        | Keep receivers, item codes and mappings; prepare a document       |
| `eta.configure` | ✓     | ✓     |            |        | Connection, issuer, environment, credentials, pinned certificates |
| `eta.sign`      | ✓     | ✓     |            |        | Act as the signing agent                                          |
| `eta.submit`    | ✓     | ✓     |            |        | Request a signature, submit, sync, cancel, reconcile              |

## 6. Spec register

Statements the code depends on, and where they come from. **Provided** means
the reviewed notes in `README.md` (which cite the official SDK pages);
**recalled** means written from memory of the SDK and not yet checked against
it. Recalled items are marked `SPEC-UNVERIFIED(<id>)` in the code. Submission
is gated on the authoritative schema (§7) for exactly this reason.

| Id                  | Statement                                                                                                                  | Source                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `env-urls`          | PreProd and Production identity and API base URLs                                                                          | Provided                                     |
| `auth`              | `POST {id}/connect/token`, Basic client id/secret, `grant_type=client_credentials`                                         | Provided                                     |
| `submit`            | `POST {api}/api/v1.0/documentsubmissions/` with `{ "documents": [...] }`                                                   | Provided                                     |
| `schema-fetch`      | `GET {api}/api/v1.0/documenttypes/{id}/versions/{vid}` returns `jsonSchema` in Base64                                      | Provided                                     |
| `canonical`         | Upper-case names, values as written, array name repeated before each entry, signatures left out, SHA-256 of UTF-8          | Provided                                     |
| `canonical-array`   | The array's name also appears once before its entries                                                                      | Recalled                                     |
| `canonical-escapes` | How a string with quotes, backslashes or control characters is serialised                                                  | Unknown — such strings are refused           |
| `signature`         | CAdES-BES, Base64 CMS in `signatures` with `signatureType` `I`                                                             | Provided                                     |
| `cms-detached`      | Detached SignedData, content type `1.2.840.113549.1.7.5`, signing time and signing-certificate-v2 attributes               | Recalled                                     |
| `doc-type`          | `documentType` value and case (`I` or `i`), `documentTypeVersion` `1.0`                                                    | Provided (type `i`, v1.0); case recalled     |
| `doc-fields`        | Field names of issuer, receiver, address, lines, unit value, discount, taxable items, totals                               | Recalled                                     |
| `doc-arithmetic`    | salesTotal, netTotal, VAT amount, line total, document totals; 5 decimal places                                            | Recalled                                     |
| `rounding`          | Half away from zero at 5 places                                                                                            | Recalled                                     |
| `status-api`        | `GET documents/{uuid}/raw`, `GET documentsubmissions/{id}`, `GET documents/{uuid}/pdf`, `PUT documents/state/{uuid}/state` | Recalled                                     |
| `submit-response`   | `submissionId`, `acceptedDocuments[{uuid,longId,internalId}]`, `rejectedDocuments[{internalId,error}]`                     | Recalled                                     |
| `status-values`     | `Submitted`, `Valid`, `Invalid`, `Rejected`, `Cancelled`                                                                   | Recalled                                     |
| `intermediary`      | An on-behalf-of header naming the taxpayer when an intermediary logs in                                                    | Recalled                                     |
| `receiver-rules`    | Receiver types `B`, `P`, `F` and when an id is required                                                                    | Recalled                                     |
| `codes`             | Tax types and subtypes, unit types, GS1/EGS item codes come from ETA code tables                                           | Provided; values are entered by each company |

## 7. Gates (enforced in code)

1. The module is off by default; the company's own switch is off by default.
2. Production needs `ETA_ALLOW_PRODUCTION=true` and an explicit choice in the
   company's settings; PreProd is the default.
3. A document can be submitted only when:
   - it is `signed` with a verified CMS;
   - the company has an **authoritative schema** for that environment,
     fetched with its own credentials through the ETA API;
   - the document validates against that schema;
   - the arithmetic rules pass.
4. Without the schema, everything up to signing works and submission is
   refused with `eta_schema_missing`.

## 8. Phases and status

| Phase | What                                                                         | Status                                                  |
| ----- | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1     | Discovery, ADR, references, fetch script, spec register                      | Done                                                    |
| 2     | Tenant configuration and security                                            | Done                                                    |
| 3     | Domain model, state machine, attempts                                        | Done                                                    |
| 4     | Mapping and validation (invoices). Credit and debit notes: a later extension | Done (invoices)                                         |
| 5     | ETA API client                                                               | Done; not run live                                      |
| 6     | Canonicalisation, CMS, signer contract, signing-request protocol             | Done; hardware signer blocked                           |
| 7     | Screens (EN/AR)                                                              | Done                                                    |
| 8     | Tests                                                                        | Offline suites; official-fixture and live tests blocked |
| 9     | Documentation                                                                | Done                                                    |

## 9. Blockers (no faked green checks)

- **Official fixtures not fetched.** This build environment's network policy
  refuses `sdk.invoicing.eta.gov.eg` (and the web archive). The fetch script is
  in `scripts/fetch_eta_refs.py`; the fixture tests are skipped until its
  output is committed. Until then, `canonical-array` and the serialiser are
  tested only against hand-made cases.
- **No PreProd credentials:** no token, no schema, no submission has ever been
  made. End-to-end tests are blocked.
- **No hardware details:** no native signer exists. The desktop app reports
  "no signer in this build". The CMS assembly and the server's verification
  are tested with a software key only.
- **Credit and debit notes** are not mapped. They need the ETA reference
  fields and are a separate extension.

## 10. Next iteration

1. Run `python scripts/fetch_eta_refs.py` somewhere with access, commit
   `docs/e-invoicing/official-public/`, and un-skip the fixture tests. Fix
   anything they find.
2. With the pilot's PreProd credentials: fetch the schema from the settings
   screen, prepare one invoice, and fix every schema error the validator shows.
3. With the token details: write the native signer (PKCS#11 or Windows CNG)
   behind the existing contract, sign on the accountant's machine, and submit
   one document to PreProd.
4. Then credit notes.
