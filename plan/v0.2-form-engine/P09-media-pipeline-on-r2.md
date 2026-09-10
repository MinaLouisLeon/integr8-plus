# P09 — Media pipeline on R2

**Version:** v0.2 Form Engine
**Status:** `NOT STARTED`
**Depends on:** P08

## Goal

Photos, videos and PDFs upload reliably to a per-company R2 bucket, and every byte is
accounted for in a ledger you can bill from.

## Scope

The storage layer and its accounting. The super admin views over this data are P16.

## Tasks

- [ ] R2 bucket created per company as part of tenant provisioning, named from the tenant id
- [ ] Single account-level R2 token held by the API; clients never receive R2 credentials
- [ ] Upload flow: client requests a short-lived presigned URL → uploads directly to R2 → calls back to confirm
- [ ] **Confirm step runs `HeadObject`** to read the true byte size and ETag before writing the ledger row — a client-declared size is never trusted
- [ ] `files` ledger: tenant, bucket, key, size, content type, linked entity, uploaded by, created at, deleted at
- [ ] `tenant_storage_usage` rollup maintained on every write and delete, broken down by media category
- [ ] Client-side image compression and resizing before upload, with the quality target documented
- [ ] Thumbnail generation in a background worker
- [ ] Signed, expiring download URLs; no object is ever publicly readable
- [ ] Soft delete with a restore window, then hard delete
- [ ] Orphan sweeper: remove objects never confirmed, abort stale multipart uploads
- [ ] `getStorage(tenantId)` abstraction, so the provider can change without touching feature code

## Exit criteria

- [ ] Uploading a file and querying `tenant_storage_usage` returns the exact byte count Cloudflare reports for that bucket
- [ ] A client that lies about file size in the presign request cannot corrupt the ledger
- [ ] An upload abandoned halfway leaves no ledger row and no permanent object after the sweeper runs
- [ ] Deleting a company's data removes both the ledger rows and the bucket contents

## Notes

- Cloudflare's GraphQL Analytics API reports storage **per bucket** and cannot break a
  bucket down by key prefix. That is the entire reason each company gets its own bucket.
- Client-side compression is the single decision that most controls your storage bill.
  Set the target before the first photo is ever uploaded.
