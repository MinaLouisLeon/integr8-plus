# P09 — Media pipeline on R2

**Version:** v0.2 Form Engine
**Status:** `IN PROGRESS — built and verified on local storage; awaiting the R2 run`
**Depends on:** P08

## Goal

Photos, videos and PDFs upload reliably to a per-company R2 bucket, and every byte is
accounted for in a ledger you can bill from.

## Scope

The storage layer and its accounting. The super admin views over this data are P16.

## Tasks

- [x] R2 bucket created per company as part of tenant provisioning, named from the tenant id
- [x] Single account-level R2 token held by the API; clients never receive R2 credentials
- [x] Upload flow: client requests a short-lived presigned URL → uploads directly to R2 → calls back to confirm
- [x] **Confirm step runs `HeadObject`** to read the true byte size and ETag before writing the ledger row — a client-declared size is never trusted
- [x] `files` ledger: tenant, bucket, key, size, content type, linked entity, uploaded by, created at, deleted at
- [x] `tenant_storage_usage` rollup maintained on every write and delete, broken down by media category
- [x] Client-side image compression and resizing before upload, with the quality target documented
- [x] Thumbnail generation in a background worker
- [x] Signed, expiring download URLs; no object is ever publicly readable
- [x] Soft delete with a restore window, then hard delete
- [x] Orphan sweeper: remove objects never confirmed, abort stale multipart uploads
- [x] `getStorage(tenantId)` abstraction, so the provider can change without touching feature code

## Exit criteria

- [ ] Uploading a file and querying `tenant_storage_usage` returns the exact byte count Cloudflare reports for that bucket
- [ ] A client that lies about file size in the presign request cannot corrupt the ledger
- [ ] An upload abandoned halfway leaves no ledger row and no permanent object after the sweeper runs
- [ ] Deleting a company's data removes both the ledger rows and the bucket contents

## Notes

- **Already in place from P08.** `media_objects` records every upload; the API issues
  upload and download links through `MediaStorage` (`apps/api/src/media/storage.ts`),
  confirms what storage holds before a file can be used, and refuses a submission naming
  one it has not confirmed. The only implementation is `LocalDiskStorage`, which signs its
  own links. This phase adds the R2 implementation behind the same interface, and grows
  `media_objects` into the `files` ledger; the renderer, the routes and submission
  validation should not need to change.

- Cloudflare's GraphQL Analytics API reports storage **per bucket** and cannot break a
  bucket down by key prefix. That is the entire reason each company gets its own bucket.
- Client-side compression is the single decision that most controls your storage bill.
  Set the target before the first photo is ever uploaded.

---

## Progress

Everything in the task list is built and passes against local storage, the database and a
real browser. The R2 half of the pipeline suite (`media-r2.integration.test.ts`) and
`storage verify` against Cloudflare's analytics are written and have **not yet run**: they
need `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` and
`CLOUDFLARE_API_TOKEN` in `apps/api/.env`. The exit criteria stay open until they have.

| Claim                                           | How it was proven so far                                                                                                                                                                                                                        |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Usage equals the bucket's bytes                 | Pipeline suite (local): after every step the usage endpoint equals the sum of listing the bucket, object for object; the database suite proves the rollup equals the ledger after a mixed history of thumbnails, deletions, restores and purges |
| A lying client cannot corrupt the ledger        | Pipeline suite (local): another type, more bytes and fewer bytes are refused by the signed link (403); a different object under the key is deleted on confirm and nothing is recorded; usage unchanged. Removing the refusal fails the test     |
| An abandoned upload leaves no row and no object | Pipeline suite (local): an unconfirmed upload is swept after its window (object, then intent); a half-written upload is aborted. Removing the object deletion from the sweeper fails the test                                                   |
| Deleting a company removes rows and bucket      | Pipeline suite (local): `purgeTenantStorage` leaves no bucket, no ledger rows, zero usage, and the company's next upload is refused 503                                                                                                         |
| The ledger cannot be changed after confirmation | Database suite: size, ETag, type and key cannot be changed by the runtime role or the owner; the runtime role cannot delete a row or write usage; purged files cannot be restored                                                               |
| Photos are compressed before upload             | Real Chromium against the web app: a 7.1 MB, 4032×3024 JPEG was sent as 587 KB at 2048×1536; the worker made a 320×240 WebP thumbnail                                                                                                           |
| Nothing else regressed                          | Workspace lint, typecheck, unit tests and build (49 tasks); db integration 202, API integration 90                                                                                                                                              |

## Decisions taken during implementation

- **Intents, then a ledger.** `upload_intents` holds what a client declared; `files` is
  written only from `HeadObject`, keeping the intent's id so a P08 `mediaId` still resolves.
  The migration moved P08's `media_objects` rows into one or the other.
- **Usage by trigger, counted until purge.** A deleted file's bytes stay in the bucket for
  its restore window, so they stay in the rollup; thumbnails are their own category.
- **Provisioning is a platform operation.** There is no company creation flow yet (P16), so
  buckets are created by the worker's maintenance run for any company without one, or by
  `storage provision`. A request never provisions; it answers `storage_not_ready` (503).
- **Signed length and type.** The presigned PUT signs `content-length` and `content-type`,
  so R2 refuses a mismatched body before the confirm step has to.
- **Path-style R2 URLs,** so every bucket is reached under one certificate name.
- **A file a submission names cannot be deleted,** and the purge re-checks before removing bytes.
- **Restore window 30 days; photos 2048 px at quality 0.82,** as chosen before implementation.

## Found while building this

- **One crashed job could stop every company's queue (P04).** A job whose worker died on its
  final attempt was reclaimed when its lease ran out, which pushed its attempt count past
  `jobs_attempts_sane`; the refusal failed the whole claim, every poll. The claim now
  dead-letters such a job. `job-queue.integration.test.ts` fails on the old code with exactly
  that error.
- **The usage trigger's first version refused every purge.** A CHECK constraint is judged on
  the row an `INSERT … ON CONFLICT` proposes, before the conflict resolves, so a negative
  delta failed `bytes >= 0` however large the existing row. It now updates first.
- **Integration suites shared one rate-limit allowance.** They all call from 127.0.0.1 and
  the limiter keeps its windows in the database; each harness now calls from its own address.
