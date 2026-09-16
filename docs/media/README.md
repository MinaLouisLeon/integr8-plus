# Media storage

Photos, signatures, videos and documents live in Cloudflare R2, **one bucket per company**,
and every byte in a bucket is accounted for in a ledger the platform can bill from (P09).

```
@integr8/form-renderer-dom   compresses a photo on the device, then uploads it
        │  1. POST /v1/media           an upload intent, and a presigned link
        │  2. PUT  <link>              the bytes, straight to the company's bucket
        │  3. POST /v1/media/:id/complete
apps/api  routes/v1/media.ts   HEAD the object; record what storage reports, or discard it
        │
@integr8/db  migration 0009    upload_intents → files (the ledger) → tenant_storage_usage
        │
apps/api  src/media            MediaStorage: R2Storage in production, LocalDiskStorage in dev
        │
worker                         thumbnails; sweep, abort and purge on a timer
```

---

## Why a bucket per company

Cloudflare's GraphQL Analytics API reports storage **per bucket** and cannot break a
bucket down by key prefix. The figure Cloudflare bills from is therefore only a company's
figure if the bucket is the company's. Buckets are named `<prefix>-<company id>`, where the
prefix is `R2_BUCKET_PREFIX` or `integr8-<APP_ENV>`, so staging and production never share
one.

`tenant_storage` records which bucket belongs to whom. A bucket is created by
`provisionTenantStorage` — from the worker's maintenance run, which provisions any company
without one, or from `pnpm --filter @integr8/api storage provision <id>|--all`. Provisioning
also sets the bucket's CORS rules (the API's allowed origins may `PUT`, `GET` and `HEAD`)
and a lifecycle rule that aborts multipart uploads after eight days, the backstop behind
resumable uploads (below). Provisioning again re-applies both, so after a change to them run
`storage provision --all` once per environment. There is no company
creation flow in the product yet (P16); when there is, it calls the same function.

Requests never provision: they read their own bucket through the tenant transaction, and
answer `storage_not_ready` (503) if there is none yet.

## Credentials

One account-level R2 token (Admin Read & Write — it creates and deletes buckets), held by
the API and the worker in `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` with
`CLOUDFLARE_ACCOUNT_ID`. A client never receives it: it gets a presigned link for one
object, one method and fifteen minutes (uploads) or five (downloads). No bucket is public.

`CLOUDFLARE_API_TOKEN` (Account Analytics: Read) is only for `storage verify`.

## The upload

1. **Intent.** `POST /v1/media { contentType, byteSize }` checks the type is not one a
   browser would execute and the size is within `MEDIA_MAX_BYTES`, writes an
   `upload_intents` row, and returns a presigned `PUT`. The signature covers
   `content-type` and `content-length`, so R2 refuses a body of any other type or size
   (`403`). The declared values live only in the intent: it is not billing data.
2. **Bytes.** The client sends them to R2. The API is not in the path.
3. **Confirm.** `POST /v1/media/:id/complete` runs `HeadObject`. If nothing is there it
   answers `upload_incomplete` (409), and the client may try again. If the object's size or
   type differs from the intent, the object is deleted, the intent removed, and it answers
   `upload_mismatch` (409). Otherwise a `files` row is written from **what `HeadObject`
   reported** — size, type, ETag — and the intent is deleted in the same step, so two
   confirmations racing write one row. An image also gets a thumbnail job.

### Resumable uploads, from the phone (P12)

A phone chooses the file's id itself, so an upload survives the app being killed and the id can
go into a form's answers before the file has arrived:

- `PUT /v1/media/:mediaId { contentType, byteSize }` creates the intent, or — for an id it
  already knows — says where the upload stands: stored (nothing to send), or a fresh link or
  part plan. Repeating it is harmless; the same id with a different type or size is refused.
- Up to 8 MiB it is one presigned `PUT`, as above. Larger files are an R2 multipart upload in
  8 MiB **parts**: `POST /v1/media/:id/parts { partNumbers }` returns a link for each,
  `GET /v1/media/:id/parts` lists the parts storage already holds, and `complete` joins them
  (`CompleteMultipartUpload`) before the usual `HeadObject` check.
- A resumable intent is kept for `RESUMABLE_UPLOAD_DAYS` (7) and renewed whenever the phone
  asks again, so a phone that is offline for days can still finish.

The engine that drives this is described in [offline sync](../sync/README.md#files).

The file keeps the intent's id, which is the `mediaId` a submission's answer carries. A
submission is refused if it names a file that is not in the ledger, is deleted, or is
described with a different size or type.

## The ledger

`files` is written by the API and protected by the database:

- what was stored — bucket, key, size, ETag, type, category, uploader, time — cannot be
  changed by anyone, owner included (`protect_file_ledger`);
- a purged file cannot be restored; a thumbnail is recorded once;
- the runtime role cannot delete a ledger row, and cannot write `tenant_storage_usage`.

`tenant_storage_usage` holds bytes and objects per company per category — `image`,
`video`, `document`, `other`, and `thumbnail` — and is kept by the security-definer trigger
`record_file_usage` on every insert, update and delete of `files`. A file counts from
confirmation until it is **purged**, not until it is deleted, because until then its bytes
are still in the bucket. So the rollup is always the sum of what is in the bucket.

`GET /v1/storage/usage` shows it to owners and admins (`storage.read`).

## Deleting

`DELETE /v1/media/:id` — by the uploader, or anyone with `submission.amend` — is refused
with `media_in_use` (409) while any submission or any entry in a submission's history names
the file. Otherwise the file is soft-deleted with `purge_after` set `MEDIA_RESTORE_DAYS`
(30) days ahead; `POST /v1/media/:id/restore` undoes it until then. After that, maintenance
deletes the object and its thumbnail, then marks the row purged. The row stays, as the
record that the file existed.

## Maintenance

`runMediaMaintenance` runs in the worker every `MEDIA_MAINTENANCE_INTERVAL_SECONDS` (15
minutes), and by hand as `storage maintain`. Every step is idempotent and ordered so a
crash leaves something the next run finishes:

| Step      | What                                                                                   | Order                                                                    |
| --------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| provision | a bucket for any company without one                                                   | bucket, then `tenant_storage`                                            |
| sweep     | intents past their window (link lifetime + 15 minutes; seven days for a resumable one) | object and any parts, then intent — confirmation refuses expired intents |
| abort     | multipart uploads started over eight days ago, not completed                           | `ListMultipartUploads` → `AbortMultipartUpload`                          |
| purge     | deleted files past `purge_after`                                                       | re-check no submission names it; objects, then `purged_at`               |

## Thumbnails

The `media.thumbnail` job reads the original, and `sharp` writes a WebP at most 320 pixels
on its longest edge, turned the way the camera recorded, at quality 70. Images over 100
million pixels are not decoded. An image `sharp` cannot read is marked `failed` and not
retried; a storage or database error is retried by the worker. `GET /v1/media/:id` returns
`thumbnailUrl` once one exists.

## Compression on the device

`preparePhoto` in `@integr8/form-renderer-dom` (`src/compress.ts`) runs before a photo is
uploaded:

- **longest edge 2048 pixels, quality 0.82**, JPEG and WebP kept as their own type;
- a PNG is resized but stays lossless;
- the original is sent when the browser cannot decode it (HEIC outside Safari), for a GIF,
  or when re-encoding would not make it smaller.

A question's `maxFileBytes` applies to what is sent. Re-encoding drops camera metadata,
GPS included; a form that needs a location asks for one.

## Deleting a company's data

```
pnpm --filter @integr8/api storage purge <company id> --yes-delete-every-file
```

`purgeTenantStorage` empties the bucket, aborts its uploads, deletes it, then deletes the
company's `files`, `upload_intents` and `tenant_storage_usage` rows and marks
`tenant_storage` purged. Bytes before records: if the bucket cannot be emptied, the ledger
still says what is in it. Running it again finishes a partial purge.

## Metering and quotas (P16)

The ledger is the number we **bill** from, because it is attributable to a company, a file
and a job. Cloudflare is the number we **audit** against. When they disagree, the ledger is
wrong until proven otherwise — investigate the sweeper.

### What a plan allows

`plan_allowances` holds one row per plan, edited from the dashboard rather than in a deploy:
a limit that needs an engineer to change it is a limit somebody works around by not setting
one. Each row carries the storage allowance (null is uncapped), the retention window, the
warning threshold, and what happens at a hundred percent:

|         |                                                                                          |
| ------- | ---------------------------------------------------------------------------------------- |
| `block` | new uploads are refused, with the numbers in the error so a client can say what is wrong |
| `allow` | uploads keep working, and the overage is recorded on that day's sample for P17 to bill   |

Trial and starter block; standard and enterprise allow. Until P17 exists, overage on the
larger plans **accrues unbilled** — the daily sample is what makes it billable
retrospectively rather than lost.

The check runs at both upload entry points (`POST /v1/media` and the resumable
`PUT /v1/media/:id`), before an intent exists or a link is signed, and the incoming bytes
count: checking only what is already stored would let one upload of any size through as long
as the company was a byte under. The plan comes off the same cached `tenants` row the
suspension check already reads, so enforcement costs no extra query.

### The daily sample

`tenant_storage_samples` gets one row per company per day: bytes, objects, the breakdown by
kind, what Cloudflare charged for in Class A and Class B operations, and **the allowance that
applied that day** — copied onto the row rather than joined, so an allowance edited next month
cannot rewrite last month's overage.

That is what the thirty and ninety day trends read, on both the platform's screen and the
company's own.

### Checking against Cloudflare

Every night the same pass records a `storage_reconciliations` row per company: what the ledger
says, what `r2StorageAdaptiveGroups` reports, and the difference. A result is **drift** only
when it clears both a one percent ratio and a ten megabyte floor — one percent of a trial
company is a few megabytes and would fire on a single unswept upload, and a flat ten megabytes
on a company storing terabytes would never fire.

Drift goes to Sentry and to the platform audit log, naming the company and both numbers; the
dashboard reads the table. When there is nothing to ask — local storage, no analytics token, a
bucket Cloudflare has not sampled — the row says `unavailable` rather than `matched`, because
"we could not check" and "we checked and it agreed" are different facts and only one is
reassuring.

### Retention

A plan's retention window is applied by **soft-deleting** past it, into the same thirty-day
restore window a person's delete uses; the existing purge step removes the bytes at the end of
it. So automatic deletion of a customer's data stays reversible for a month, and there is one
path that removes bytes rather than two.

A file still referenced by a submission is taken too. That is what a retention window means —
the record ages out — and a policy that quietly skipped anything in use would delete nothing at
all. Every plan starts with a window, so **set them deliberately**: nothing is deleted until
somebody does.

### There is no cron

The three nightly tasks run from the worker's housekeeping timer, and several workers run at
once, so each claims its turn in `scheduled_task_runs` with a conditional update exactly one of
them wins. The claim is on the _start_, so a run that dies holding its turn is retried after
the interval rather than never. The dashboard shows when each last ran and whether it finished.

## Checking the ledger against Cloudflare

```
pnpm --filter @integr8/api storage verify <company id>
```

prints the ledger's bytes and objects, the sum of listing the bucket, and Cloudflare's
latest `r2StorageAdaptiveGroups` sample (`payloadSize`, `objectCount`). The first two must
match exactly — the command exits non-zero if they do not. Cloudflare samples storage
periodically, so its figure matches once it has sampled the bucket after the last change.

## Local development

`MEDIA_STORAGE=local` keeps a bucket as a directory under `MEDIA_LOCAL_DIR`. Its links are
HMAC-signed for method, bucket, key, type, size and expiry, served by `/local-media/*`
outside `/v1`, and refuse what R2 refuses, so the client code is the same. A half-finished
upload sits in the bucket's `uploads/` directory, which the abort step clears. Production
refuses to start with local storage.

## Tests

- `packages/db/src/testing/media-ledger.integration.test.ts` — the ledger, the rollup,
  immutability and isolation, below the repository.
- `apps/api/src/testing/media-suite.ts` — the whole pipeline through the API, run by
  `media-local.integration.test.ts` always and by `media-r2.integration.test.ts` against real
  R2 when `apps/api/.env` has credentials (it creates and deletes `integr8-test-<id>`).
- `apps/api/src/media/media.test.ts` and `packages/form-renderer-dom/src/compress.test.ts`
  — the pure parts.
