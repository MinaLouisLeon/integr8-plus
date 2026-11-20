# Files

Photos, signatures, videos, receipts and PDFs live in Cloudflare R2, **one
bucket per company** (`<R2_BUCKET_PREFIX or integr8-<APP_ENV>>-<company id>`),
because Cloudflare reports storage per bucket and that is the only way its
figure is a company's figure. Locally, `MEDIA_STORAGE=local` writes to
`MEDIA_LOCAL_DIR`. Every stored byte is in a ledger (`files`) that metering and
billing read.

```
client       1. POST /v1/media (type, size)      → an upload intent and a presigned PUT
             2. PUT <link>                        → the bytes go straight to the bucket
             3. POST /v1/media/:id/complete       → HEAD the object, record what storage reports
worker       thumbnails; sweep, abort and purge on a timer; nightly metering
```

## Buckets and credentials

`provisionTenantStorage` makes a company's bucket (from onboarding, the worker's
maintenance, or `pnpm --filter @integr8/api storage provision <id>|--all`), with
CORS for the API's allowed origins and a rule aborting multipart uploads after
eight days; run `storage provision --all` again after changing either. Requests
never provision: no bucket yet answers 503 `storage_not_ready`.

One account-level R2 token (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
`CLOUDFLARE_ACCOUNT_ID`) held only by the API and worker; clients get presigned
links for one object and one method, 15 minutes for uploads, 5 for downloads. No
bucket is public. `CLOUDFLARE_API_TOKEN` (Account Analytics: Read only) lets
the nightly metering count operations and check the ledger against Cloudflare;
without it the check is recorded as `unavailable`. The staff-made library
templates' pictures live in a `<prefix>-platform-library` bucket.

## Uploading

- **Intent** checks the type is not one a browser would run and the size is
  within `MEDIA_MAX_BYTES`; the signed link covers type and length, so R2 refuses
  anything else.
- **Confirm** writes the `files` row from what `HeadObject` reports (size, type,
  ETag): nothing there is 409 `upload_incomplete`; a different size or type
  deletes the object, 409 `upload_mismatch`.
- **From the phone** the id is chosen on the device (`PUT /v1/media/:id`), so the
  upload survives the app being killed and the id can sit in answers before the
  file arrives; over 8 MiB it goes in 8 MiB parts (`POST`/`GET
/v1/media/:id/parts`). A resumable intent lasts 7 days, renewed on each ask.
- **On the device** photos are made smaller first (`preparePhoto`: longest edge
  2048 px, quality 0.82; PNG stays lossless), which also drops camera metadata.
- A submission naming a file not in the ledger, deleted, or described with a
  different size or type is refused.
- Thumbnails: the `media.thumbnail` job writes a 320 px WebP with `sharp`.
  Uploads are decoded as **real photos only** (`media/photo-decoder.ts`, SEC-003):
  every libvips loader is blocked for the process except JPEG, PNG, WebP and HEIF
  (HEIC/AVIF) from memory, so a file is refused unread when its bytes are SVG, PDF or
  anything else, whatever type it was uploaded as; it simply gets no thumbnail (and
  no picture in a PDF). Code that decodes SVG on purpose must do it before the first
  upload is decoded in that process.

## The ledger

What was stored (bucket, key, size, ETag, type, category, uploader, time) cannot
be changed by anyone (`protect_file_ledger`); the runtime role cannot delete a
ledger row. `tenant_storage_usage` (bytes and objects per category: image,
video, document, other, thumbnail) is kept by a trigger; a file counts until it
is **purged**, because until then its bytes are in the bucket. Owners and admins
see it (`GET /v1/storage/usage`, `storage.read`).

## Who may read a file

`GET /v1/media/:id` gives a five-minute link only to someone who may see a
record that uses the file (`apps/api/src/routes/v1/media-access.ts`): a
submission's answers or history, a job's attachment, photo or sign-off, a
customer or site, an expense receipt, a document's PDF, a template picture
(staff), an item's picture, an asset's picture, a part receipt, a certificate
scan, the company's logo and icon (every member). A file used by nothing yet is
its uploader's. A module that is off opens none of its files. Anyone else gets
the same 404 as for an id nobody uploaded. `submission_file_uses` indexes which
submissions name which file, so this never scans answers as text.

## Deleting

`DELETE /v1/media/:id` (the uploader, or `submission.amend`) is refused with 409
`media_in_use` while a submission, its history or a record names the file.
Otherwise it is soft-deleted for `MEDIA_RESTORE_DAYS` (30), restorable with `POST
/v1/media/:id/restore`, then purged by maintenance (the row stays as the record
that it existed). Maintenance runs every `MEDIA_MAINTENANCE_INTERVAL_SECONDS`
(15 minutes; by hand `storage maintain`): provision, sweep expired intents,
abort old multipart uploads, purge. Every step is idempotent.

`pnpm --filter @integr8/api storage purge <company id> --yes-delete-every-file`
empties and deletes a company's bucket and its file rows (bytes before records,
so a partial purge says what is left); the company purge does this too.

## Plans, metering and retention

`plan_allowances` (edited on the dashboard) gives each plan a storage
allowance (null is uncapped), seats, submissions a month, a warning threshold,
a retention window and what happens at 100%: `block` refuses new uploads (with
the numbers in the error), `allow` records the overage on the day's sample.
Trial and starter block; standard and enterprise allow.

- **The daily sample** (worker, once a night) records each company's bytes,
  objects, R2 operations and any overage. The ledger is what is billed;
  Cloudflare is what it is audited against, and a disagreement means the ledger
  is wrong until proven otherwise.
- **Overage** is invoiced by hand as the month's average GB-months over the
  allowance (`monthlyOverage` in `packages/core/src/storage-overage.ts`), listed
  on the dashboard's Storage page (`GET /v1/platform/storage?month=`); the
  company's own Storage page shows an "Over your plan" notice.
- **Retention**: no plan has a window until somebody sets one. Setting one is a
  decision about customers' records, made on the dashboard and told to the
  companies first. A window soft-deletes files past it, even ones a submission
  uses (that is what a window means), into the same 30-day restore period, and
  the normal purge removes the bytes. A PDF template's pictures and the logo and
  app icon are never taken.
- Test companies are left out of billing and overage invoicing, but their files
  are still in R2 and still counted in the storage cost projection.

## Testing

The suites use the local store. The R2 suite in CI's database job runs only
when the `R2_TEST_*` repository secrets exist (a separate Cloudflare account);
until then R2 is proven by hand on a real deployment.
