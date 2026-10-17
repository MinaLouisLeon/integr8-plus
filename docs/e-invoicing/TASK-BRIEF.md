# Claude Code task: ETA Egyptian eInvoicing integration

You are working in the existing integr8-plus repo. **First inspect the actual main branch**, technology stack, tenant model, billing/invoices, auth, RBAC, audit, existing accounting modules, queue/outbox, i18n, feature flags, CI and tests. Do not assume routes, services, tables, or language/runtime before inspection. Create a feature branch. Follow existing architecture and open-source libraries only; don't introduce paid SaaS dependencies. Preserve existing features.

## Goal

Implement a secure, optional per-company/tenant Egyptian Tax Authority (ETA) **B2B eInvoice** integration, designed for commercial multi-tenant SaaS. This task is **not** eReceipt/POS. Keep the connector modular, configurable per tenant, and disabled by default. Separate tenant internal sales invoice from its ETA document/attempt lifecycle. Never let one tenant see another's credentials, documents, logs, or results.

## Read documentation first

Read `docs/e-invoicing/README.md` and all public official fixtures fetched by `scripts/fetch_eta_refs.py`. Use https://sdk.invoicing.eta.gov.eg/ for source of truth. Be aware legacy official sample invoice has documentTypeVersion=0.9; do not promote it to a production 1.0 fixture. Do not invent schema constraints or field values. Implement a schema-fetch capability using the authorized ETA API once the sandbox taxpayer can authenticate. Annotate spec uncertainty explicitly.

## Delivery phases

1. **Discovery / ADR**: inspect repository; map current invoices, companies, branch/tax records, customers, products/services, tax calculations, approval workflow, app environments and translations; propose precise module boundaries and migrations; note confirmed and blocked requirements.
2. **Tenant configuration & security**: per-tenant ETA enablement, preprod/prod environment, tax registration, authorized branch/activity, encrypted ETA client ID/secret (or existing secret management), optional intermediary mode only when explicitly configured. RBAC for configuring, submitting, signing, reviewing. Server-only tokens. Audit with redaction; never log tokens, taxpayer secrets, PINs, or signed-document PII unnecessarily.
3. **Domain models**: invoice-to-ETA mapping; immutable/versioned document snapshots, status transitions (draft -> ready -> pending_sign -> signed -> submitting -> submitted/processing -> valid/invalid/rejected/cancelled as documented; adapt exact state machine to ETA), attempts, ETA UUID, submission ID, validation errors, timestamps, retry/duplicate safeguards and signed payload references. Reconcile on ambiguous network failures before retry.
4. **Mapping and validation**: map actual app entities to ETA document structure (issuer, receiver, lines, tax totals, discounts, amounts, activity/branch, currencies/exchange rates, GS1/EGS and other code tables). Validate against current authoritative schema when available; otherwise implement only independently documented rules and mark complete submission as gated. Monetary arithmetic deterministic decimal; preserve number serialization when signing; handle timezone/UTC. Include credit/debit notes as separately planned extensions, not mislabeled invoices.
5. **ETA API client**: configurable identity and API base URLs; OAuth2 client credentials and expiry-aware single-flight token caching scoped by credential/tenant; optional on-behalf-of header only if intermediary; submission, document detail/status, submission retrieval, PDF download, document type/version query, published code lookup as appropriate. Timeouts, backoff respecting ETA rate limits, correlation IDs, structured errors, idempotency/reconciliation, no tenant leakage. PreProd CA trust without globally disabling HTTPS validation.
6. **Signing subsystem**: pure, well-tested canonicalization compatible with official unsigned/canonical fixture. Make CAdES-BES signer an interface and design local signing agent protocol, restricted origin/auth, nonce + expiry, tenant/document binding, explicit confirmation and certificate details. **Do not claim end-to-end valid CAdES signing until tested with actual token + drivers on accountant machine**. No raw private key export or PIN transmission to cloud. Validate a real signature with ETA sandbox once credentials and token supplied. Separate test-only mock signer from production workflow.
7. **UI**: Arabic and English tenant settings, invoice ETA readiness diagnostics, submit/sign status, error details, retry/sync, history/audit, downloadable ETA PDF when available. Reuse existing design, navigation and permissions. Clearly label PreProd/Prod and never transmit to Prod accidentally.
8. **Testing**: unit tests for canonicalization using the official source and serialized output (byte-for-byte), money/taxes, validation, auth expiry, unauthorized tenants; API mocked integration tests; error/retry/duplicate/timeout cases; browser/manual acceptance. Build CI checks. No actual ETA requests in CI using credentials.
9. **Documentation**: env variable names, secret provisioning, ETA onboarding, PreProd CA trust, accountant token requirements, signing-agent setup, tenant-by-tenant rollout, operational troubleshooting, and reversible migrations.

## Hard acceptance gates

- Public fixtures fetched and checksum/URLs recorded; verify official sample numeric lexemes and property ordering with test; don't parse into JS floating values then stringify for signature.
- There must be no shared/global taxpayer credentials across tenants. Multi-tenant RBAC enforced server-side.
- Cannot submit unsigned v1.0 documents. Production integration disabled by default and behind explicit permission/feature flag.
- A 200 or accepted submission response is not the same as final valid document. Status reconciliation is mandatory.
- Without an authorized PreProd account, finish offline integration and tests, **report E2E tests blocked**. Without hardware details, finish signer interface/contract and fixture tests but **report real hardware signing blocked**. No faked green check.
- Use only free/open-source code libraries (verify licenses for commercial use). Infrastructure costs and ETA-issued token/certificate costs may be external.

## User/Accountant inputs outstanding

1. Confirm accountant/pilot taxpayer can issue ETA PreProd ERP client credentials; store them only in trusted secret storage; never paste credentials into repo, ChatGPT, or issues.
2. Token manufacturer, model, signature certificate provider, installed middleware/version, supported Windows crypto API (CSP/KSP) or PKCS#11 module, and accountant PC OS/version. Confirm Windows or other OS.
3. Taxpayer's authorized registration ID, branch code, business activity code, issued certificate subject, account permissions (requested securely and only as needed), and whether service-provider/intermediary flow applies.
4. ETA PreProd certificate chain and schemas fetched via authorized API.

## Final Claude report

Report files changed, migrations, offline test results, exact live blockers, supported scenarios, risks, manual setup, and next recommended iteration. Do not mark ETA integration production-ready until it passes live PreProd submissions and accountant-hardware signing.
