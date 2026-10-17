# ETA pilot-company accountant checklist

- [ ] Confirm company has ETA eInvoicing PreProd onboarding and can issue authorized ERP API credentials (client ID/secret). Store in secure system; **do not share secrets over chat or commit them**.
- [ ] Confirm tax registration number, ETA branch ID, registered activity code, authorized representative and ETA role/permissions.
- [ ] Identify USB eSeal token vendor + exact model, certificate provider, driver/middleware version, CSP/KSP or PKCS#11 library, and whether machine is Windows (which version and architecture).
- [ ] Confirm token certificate is valid and properly associated with taxpayer/representative; whether PIN is entered locally and signing prompts appear.
- [ ] Install only ETA's published PreProd root CA certificate within isolated test environment; do not deploy test CA to Prod.
- [ ] Plan one safe sandbox invoice and expected validation results. No production submissions until separately approved.
