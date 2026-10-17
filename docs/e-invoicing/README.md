# Egyptian Tax Authority eInvoicing — verified integration references

Reviewed: 2026-10-17. Source: https://sdk.invoicing.eta.gov.eg/

## Official resources

- SDK: https://sdk.invoicing.eta.gov.eg/
- Invoice v1.0: https://sdk.invoicing.eta.gov.eg/documents/invoice-v1-0/
- API directory: https://sdk.invoicing.eta.gov.eg/einvoicingapi/
- Common API: https://sdk.invoicing.eta.gov.eg/api/
- Authentication: https://sdk.invoicing.eta.gov.eg/api/01-login-as-taxpayer-system/
- Submission: https://sdk.invoicing.eta.gov.eg/einvoicingapi/01-submit-documents/
- Versioned schema endpoint: https://sdk.invoicing.eta.gov.eg/api/04-get-document-type-version/
- Validation: https://sdk.invoicing.eta.gov.eg/document-validation-rules/
- Signature: https://sdk.invoicing.eta.gov.eg/signature-creation/
- Canonicalization: https://sdk.invoicing.eta.gov.eg/document-serialization-approach/
- Environments and CA trust: https://sdk.invoicing.eta.gov.eg/faq/
- Postman collection: https://sdk.invoicing.eta.gov.eg/files/Egyptian%20eInvoicing%20SDK.postman_collection.json
- Official unsigned JSON fixture (older v0.9): https://sdk.invoicing.eta.gov.eg/files/one-doc.json
- Official signed JSON fixture (older v0.9): https://sdk.invoicing.eta.gov.eg/files/one-doc-I.json
- Official canonical text fixture: https://sdk.invoicing.eta.gov.eg/files/one-doc-serialized.json.txt

## Environments (ETA FAQ)

| Environment | Identity base                 | API base                                 | Portal                               |
| ----------- | ----------------------------- | ---------------------------------------- | ------------------------------------ |
| PreProd     | https://id.preprod.eta.gov.eg | https://api.preprod.invoicing.eta.gov.eg | https://preprod.invoicing.eta.gov.eg |
| Production  | https://id.eta.gov.eg         | https://api.invoicing.eta.gov.eg         | https://invoicing.eta.gov.eg         |

PreProd may require installing/trusting ETA's test root CA, **only in a controlled test environment**; do not disable TLS verification in deployed code. The FAQ includes a test CA download link.

## Auth/API

- OAuth 2.0 client credentials: POST {identityBase}/connect/token using HTTP Basic(client_id:client_secret), form grant_type=client_credentials and optional scope.
- Bearer tokens expire; refresh securely before expiry.
- Submit: POST {apiBase}/api/v1.0/documentsubmissions/ JSON `{ "documents": [<signed invoice>] }`.
- Discover document types and versions from authenticated common APIs. GET /api/v1.0/documenttypes/{id}/versions/{vid} returns `jsonSchema` as Base64: decode and save the **current active version** to `schemas/` only after authorized API access. Do not assume older bundled example JSON is an authoritative schema.
- Record ETA document UUID/submission IDs and asynchronous validation statuses; a successful transport/submission is not proof of final invoice validity.

## Document and signing

- Invoice document type is `i`, standard v1.0 according to its specification. Verify supported/active versions through the APIs rather than assuming historical examples remain usable.
- Each invoice needs issuer, receiver, invoice lines, totals, tax totals and signatures per active schema and business validations. Codes must come from ETA's code systems.
- Canonicalize each **document without signatures**; recursively uppercase property names, preserve original simple value representations and order, and repeat array property names before each entry. Hash the UTF-8 canonical representation using SHA-256; sign with appropriate eSeal/representative certificate in CAdES-BES; Base64-encode CMS into `signatures` type `I`.
- Do not substitute generic JSON stringify, alphabetical key sorting, JWS, a raw SHA256/RSA value, or an unrelated PDF signature.
- Keep token private key on the hardware device; server should never ask to upload its key. Design a local signing-agent interface to bridge browser/cloud SaaS to accountant's PC where necessary, with tenant-scoped authorization and replay protection.

## Known gaps

- Actual current authoritative schema **not downloaded**: this comes from ETA authenticated document-type-version API. Fetch after obtaining authorized PreProd credentials.
- USB token make/model, PKCS#11/CSP/KSP capabilities, driver, and accountant operating system are unknown; signing-agent implementation must await hardware confirmation.
- No PreProd client ID/secret supplied; live end-to-end validation is pending.
- These are integration notes and links, not an approval by ETA or compliance/legal signoff.

Run `python scripts/fetch_eta_refs.py` from repository root to fetch official public fixtures (requires outbound network); inspect downloaded files before committing. Script intentionally does **not** fetch authenticated schemas or secrets.
