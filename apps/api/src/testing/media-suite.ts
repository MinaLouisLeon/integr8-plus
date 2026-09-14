import { CreateMultipartUploadCommand, UploadPartCommand } from '@aws-sdk/client-s3';
import { getPlatformDataSource, withTenant } from '@integr8/db';
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { publicUrl } from '../config.js';
import { createLogger } from '../http/logger.js';
import { buildJobHandlers } from '../jobs/handlers.js';
import { runMediaMaintenance } from '../media/maintenance.js';
import { R2Storage } from '../media/r2.js';
import { mediaKey, type ObjectStore } from '../media/storage.js';
import { getStorage, purgeTenantStorage } from '../media/tenant-storage.js';
import { THUMBNAIL_QUEUE } from '../media/thumbnails.js';
import { type ApiHarness, type Member, startApi } from './api-harness.js';

/**
 * The media pipeline through the API, against a real database and a real store.
 *
 * Run twice: over local disk always, and over Cloudflare R2 when credentials are
 * present — the claims are about the pipeline, so they must hold whichever
 * bucket is behind it. P09's exit criteria are proven here:
 *
 * - a client that lies about a file cannot corrupt the ledger;
 * - an abandoned upload leaves no ledger row and no object once swept;
 * - deleting a company's data removes its ledger rows and its bucket;
 * - the ledger's byte count is the bucket's (Cloudflare's own analytics lag
 *   by design, so the `storage verify` command checks that figure later).
 */

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

interface MediaResponse {
  id: string;
  contentType: string;
  byteSize: number;
  status: string;
  thumbnail: string;
  deletedAt: string | null;
  purgeAfter: string | null;
}

interface Created {
  media: { id: string };
  upload: { url: string; method: 'PUT'; headers: Record<string, string> };
}

const json = <T>(response: { body: string }) => JSON.parse(response.body) as T;

export function defineMediaSuite(storage: 'local' | 'r2'): void {
  let api: ApiHarness;
  let engineer: Member;
  let tokens: Record<'owner' | 'engineer' | 'colleague', string>;
  let store: ObjectStore;
  const uploadedIds: string[] = [];
  const logger = createLogger({ level: 'error', write: () => undefined });

  /** Sends bytes to an upload link the way a client would: over HTTP, to wherever it points. */
  async function send(url: string, bytes: Uint8Array, headers: Record<string, string>) {
    const local = publicUrl(api.config);
    if (url.startsWith(local)) {
      const target = new URL(url);
      const response = await api.app.inject({
        remoteAddress: api.remoteAddress,
        method: 'PUT',
        url: target.pathname + target.search,
        headers,
        payload: Buffer.from(bytes),
      });
      return response.statusCode;
    }
    const response = await fetch(url, { method: 'PUT', headers, body: Buffer.from(bytes) });
    await response.arrayBuffer();
    return response.status;
  }

  async function fetchBytes(url: string) {
    const local = publicUrl(api.config);
    if (url.startsWith(local)) {
      const target = new URL(url);
      const response = await api.app.inject({
        remoteAddress: api.remoteAddress,
        method: 'GET',
        url: target.pathname + target.search,
      });
      return { status: response.statusCode, bytes: new Uint8Array(response.rawPayload) };
    }
    const response = await fetch(url);
    return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
  }

  const create = async (token: string, contentType: string, byteSize: number) => {
    const response = await api.call(token, {
      method: 'POST',
      url: '/v1/media',
      payload: { contentType, byteSize },
    });
    expect(response.statusCode, response.body).toBe(201);
    return json<Created>(response);
  };

  const complete = (token: string, id: string) =>
    api.call(token, { method: 'POST', url: `/v1/media/${id}/complete` });

  async function upload(token: string, bytes: Uint8Array, contentType = 'image/jpeg') {
    const created = await create(token, contentType, bytes.byteLength);
    expect(await send(created.upload.url, bytes, created.upload.headers)).toBe(200);
    const completed = await complete(token, created.media.id);
    expect(completed.statusCode, completed.body).toBe(200);
    const file = json<MediaResponse>(completed);
    uploadedIds.push(file.id);
    return file;
  }

  const usage = async () =>
    json<{
      categories: { category: string; bytes: number; objects: number }[];
      totalBytes: number;
      totalObjects: number;
    }>(await api.call(tokens.owner, { method: 'GET', url: '/v1/storage/usage' }));

  /** What is actually in the bucket, object by object. */
  async function bucketContents() {
    const objects = new Map<string, number>();
    for await (const object of store.list()) {
      objects.set(object.key, object.byteSize);
    }
    return objects;
  }

  const maintain = (now: Date) =>
    runMediaMaintenance({ media: api.services.media, now, tenantIds: [api.tenantId] });

  const photo = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 3, background: '#2f7d5b' } })
      .jpeg({ quality: 90 })
      .toBuffer()
      .then((buffer) => new Uint8Array(buffer));

  beforeAll(async () => {
    api = await startApi({ mediaStorage: storage });
    const owner = await api.member('owner', 'owner');
    engineer = await api.member('engineer', 'engineer');
    const colleague = await api.member('engineer', 'colleague');
    tokens = {
      owner: await api.signIn(owner),
      engineer: await api.signIn(engineer),
      colleague: await api.signIn(colleague),
    };
    store = await getStorage(api.services.media, api.tenantId);
  });

  afterAll(async () => {
    // Whatever happened above, leave no bucket behind.
    await purgeTenantStorage(api.services.media, api.tenantId).catch(() => undefined);
    await api.close();
  });

  describe(`media on ${storage}`, () => {
    it('gives the company its own bucket, named from its id', async () => {
      expect(store.bucket).toBe(api.services.media.bucketFor(api.tenantId));
      expect(store.bucket).toContain(api.tenantId);
      expect(await api.services.media.exists(store.bucket)).toBe(true);
    });

    it('records what storage holds, and counts exactly the bucket’s bytes', async () => {
      const before = await usage();
      const bytes = await photo(640, 480);
      const file = await upload(tokens.engineer, bytes);
      expect(file).toMatchObject({
        byteSize: bytes.byteLength,
        status: 'stored',
        thumbnail: 'pending',
      });

      const row = await withTenant(api.tenantId, (tx) => tx.files.find(file.id));
      const held = await store.head(mediaKey(file.id));
      expect(row).toMatchObject({ byteSize: held!.byteSize, etag: held!.etag });
      expect(held!.etag).toMatch(/^"[0-9a-f]{32}"$/u);

      const after = await usage();
      expect(after.totalBytes - before.totalBytes).toBe(bytes.byteLength);
      const inBucket = [...(await bucketContents()).values()].reduce((sum, size) => sum + size, 0);
      expect(after.totalBytes).toBe(inBucket);
    });

    it('confirms once, however many times it is asked', async () => {
      const bytes = new TextEncoder().encode('%PDF-1.4 a small document');
      const created = await create(tokens.engineer, 'application/pdf', bytes.byteLength);
      await send(created.upload.url, bytes, created.upload.headers);
      const before = await usage();
      const first = await complete(tokens.engineer, created.media.id);
      const second = await complete(tokens.engineer, created.media.id);
      expect(json(first)).toEqual(json(second));
      expect((await usage()).totalBytes - before.totalBytes).toBe(bytes.byteLength);
    });

    it('serves a file only through a signed, expiring link', async () => {
      const bytes = await photo(80, 60);
      const file = await upload(tokens.engineer, bytes);
      const link = json<{ url: string; expiresAt: string }>(
        await api.call(tokens.engineer, { method: 'GET', url: `/v1/media/${file.id}` }),
      );
      expect(new Date(link.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(5 * MINUTE);
      const fetched = await fetchBytes(link.url);
      expect(fetched.status).toBe(200);
      expect(Buffer.from(fetched.bytes).equals(Buffer.from(bytes))).toBe(true);

      const unsigned = await fetchBytes(link.url.split('?')[0]!);
      expect(unsigned.status).toBeGreaterThanOrEqual(400);
      const tampered = await fetchBytes(link.url.replace(/ignature=./u, 'ignature=0'));
      expect(tampered.status).toBeGreaterThanOrEqual(400);
    });

    describe('a client that lies cannot corrupt the ledger', () => {
      it('is refused by storage when it sends another type or size than it declared', async () => {
        const before = await usage();
        const created = await create(tokens.engineer, 'image/png', 4);
        const url = created.upload.url;

        expect(await send(url, new Uint8Array(4), { 'content-type': 'image/jpeg' })).toBe(403);
        expect(await send(url, new Uint8Array(4_000), { 'content-type': 'image/png' })).toBe(403);
        expect(await send(url, new Uint8Array(3), { 'content-type': 'image/png' })).toBe(403);
        expect(await store.head(mediaKey(created.media.id))).toBeUndefined();

        const early = await complete(tokens.engineer, created.media.id);
        expect(early.statusCode).toBe(409);
        expect(json<{ error: { code: string } }>(early).error.code).toBe('upload_incomplete');
        expect(
          await withTenant(api.tenantId, (tx) => tx.files.find(created.media.id)),
        ).toBeUndefined();
        expect(await usage()).toEqual(before);
      });

      it('discards what arrived if it is not what was declared, and records nothing', async () => {
        const before = await usage();
        const created = await create(tokens.engineer, 'image/jpeg', 90_000);
        // Something else under the key — as if a link had been signed differently.
        await store.put({
          key: mediaKey(created.media.id),
          body: new Uint8Array(2_000_000),
          contentType: 'image/jpeg',
        });

        const response = await complete(tokens.engineer, created.media.id);
        expect(response.statusCode).toBe(409);
        expect(json<{ error: { code: string } }>(response).error.code).toBe('upload_mismatch');
        expect(await store.head(mediaKey(created.media.id))).toBeUndefined();
        expect(
          await withTenant(api.tenantId, (tx) => tx.files.find(created.media.id)),
        ).toBeUndefined();
        expect(
          await withTenant(api.tenantId, (tx) => tx.files.findIntent(created.media.id)),
        ).toBeUndefined();
        expect(await usage()).toEqual(before);
      });

      it('cannot name in a submission a size it did not upload', async () => {
        const file = await upload(tokens.engineer, await photo(40, 40));
        const recorded = await withTenant(api.tenantId, (tx) => tx.files.find(file.id));
        expect(recorded?.byteSize).toBe(file.byteSize);
      });
    });

    it('makes a thumbnail in the worker, counted as its own kind', async () => {
      const file = await upload(tokens.engineer, await photo(2048, 1536));
      // The worker's own claim, across companies: older jobs in a shared test
      // database come first, so claim until this file's job turns up.
      const claimed = [];
      for (;;) {
        const batch = await getPlatformDataSource().jobs.claim({
          workerId: `test-${storage}`,
          limit: 100,
        });
        claimed.push(
          ...batch.filter((job) => job.queue === THUMBNAIL_QUEUE && job.payload.fileId === file.id),
        );
        if (batch.length === 0 || claimed.length > 0) {
          break;
        }
      }
      expect(claimed).toHaveLength(1);

      const before = await usage();
      await buildJobHandlers(api.services)[THUMBNAIL_QUEUE]!(claimed[0]!.payload, {
        tenantId: api.tenantId,
        jobId: claimed[0]!.id,
        attempt: 1,
        logger,
      });
      await getPlatformDataSource().jobs.complete(claimed[0]!.id);

      const recorded = await withTenant(api.tenantId, (tx) => tx.files.find(file.id));
      expect(recorded?.thumbnailStatus).toBe('ready');
      const thumbnail = await store.head(recorded!.thumbnailKey!);
      expect(thumbnail).toMatchObject({
        contentType: 'image/webp',
        byteSize: recorded!.thumbnailBytes,
      });
      const rendered = await sharp(await store.get(recorded!.thumbnailKey!)).metadata();
      expect([rendered.width, rendered.height]).toEqual([320, 240]);

      const thumbnails = (await usage()).categories.find(
        (entry) => entry.category === 'thumbnail',
      )!;
      const previous = before.categories.find((entry) => entry.category === 'thumbnail')!;
      expect(thumbnails.bytes - previous.bytes).toBe(thumbnail!.byteSize);

      const link = json<{ thumbnailUrl: string | null }>(
        await api.call(tokens.engineer, { method: 'GET', url: `/v1/media/${file.id}` }),
      );
      expect((await fetchBytes(link.thumbnailUrl!)).status).toBe(200);
    });

    it('marks a thumbnail failed, without retrying, for an image that cannot be read', async () => {
      const file = await upload(tokens.engineer, new TextEncoder().encode('not really a jpeg'));
      await buildJobHandlers(api.services)[THUMBNAIL_QUEUE]!(
        { fileId: file.id },
        { tenantId: api.tenantId, jobId: 'direct', attempt: 1, logger },
      );
      expect(
        (await withTenant(api.tenantId, (tx) => tx.files.find(file.id)))?.thumbnailStatus,
      ).toBe('failed');
    });

    it('deletes softly, refuses while a submission uses the file, restores, then purges', async () => {
      const used = await upload(tokens.engineer, await photo(50, 50));
      const form = await withTenant(api.tenantId, async (tx) => {
        const created = await tx.forms.createForm({ title: 'Photos', createdBy: engineer.userId });
        const draft = await tx.forms.createDraft({
          formId: created.id,
          definition: {
            schemaVersion: 1,
            title: { en: 'Photos' },
            pages: [
              {
                id: 'page_1',
                sections: [
                  {
                    id: 'section_1',
                    fields: [{ id: 'photo', type: 'photo', label: { en: 'Photo' } }],
                  },
                ],
              },
            ],
          },
          createdBy: engineer.userId,
        });
        return (await tx.forms.publishDraft(draft.id, engineer.userId))!;
      });
      await withTenant(api.tenantId, (tx) =>
        tx.submissions.startDraft({
          formVersionId: form.id,
          submittedBy: engineer.userId,
          answers: {
            photo: [{ mediaId: used.id, contentType: used.contentType, byteSize: used.byteSize }],
          },
        }),
      );
      const refused = await api.call(tokens.engineer, {
        method: 'DELETE',
        url: `/v1/media/${used.id}`,
      });
      expect(json<{ error: { code: string } }>(refused).error.code).toBe('media_in_use');

      const bytes = await photo(60, 60);
      const file = await upload(tokens.engineer, bytes);
      expect(
        (await api.call(tokens.colleague, { method: 'DELETE', url: `/v1/media/${file.id}` }))
          .statusCode,
      ).toBe(403);

      const before = await usage();
      const deleted = json<MediaResponse>(
        await api.call(tokens.engineer, { method: 'DELETE', url: `/v1/media/${file.id}` }),
      );
      expect(deleted.status).toBe('deleted');
      const window = new Date(deleted.purgeAfter!).getTime() - Date.now();
      expect(window).toBeGreaterThan(29.9 * DAY);
      expect(window).toBeLessThanOrEqual(30 * DAY);
      expect(
        (await api.call(tokens.engineer, { method: 'GET', url: `/v1/media/${file.id}` }))
          .statusCode,
      ).toBe(404);
      // Still in the bucket, so still counted, until it is purged.
      expect(await usage()).toEqual(before);

      const restored = json<MediaResponse>(
        await api.call(tokens.engineer, { method: 'POST', url: `/v1/media/${file.id}/restore` }),
      );
      expect(restored).toMatchObject({ status: 'stored', deletedAt: null, purgeAfter: null });

      await api.call(tokens.owner, { method: 'DELETE', url: `/v1/media/${file.id}` });
      // Inside the window, maintenance leaves it be.
      await maintain(new Date(Date.now() + 29 * DAY));
      expect(await store.head(mediaKey(file.id))).toBeDefined();

      const report = await maintain(new Date(Date.now() + 31 * DAY));
      expect(report.failures).toEqual([]);
      expect(await store.head(mediaKey(file.id))).toBeUndefined();
      const after = await usage();
      expect(before.totalBytes - after.totalBytes).toBe(bytes.byteLength);

      const late = await api.call(tokens.engineer, {
        method: 'POST',
        url: `/v1/media/${file.id}/restore`,
      });
      expect(json<{ error: { code: string } }>(late).error.code).toBe('restore_window_passed');

      // The file a submission names survives every maintenance run.
      expect(await store.head(mediaKey(used.id))).toBeDefined();
    });

    it('sweeps an upload never confirmed: no ledger row, no object', async () => {
      const bytes = new Uint8Array(12_345);
      const created = await create(tokens.engineer, 'application/octet-stream', bytes.byteLength);
      expect(await send(created.upload.url, bytes, created.upload.headers)).toBe(200);
      expect(await store.head(mediaKey(created.media.id))).toBeDefined();
      const before = await usage();

      await maintain(new Date(Date.now() + 10 * MINUTE));
      expect(await store.head(mediaKey(created.media.id))).toBeDefined();

      const report = await maintain(new Date(Date.now() + 31 * MINUTE));
      expect(report.failures).toEqual([]);
      expect(report.intentsSwept).toBeGreaterThanOrEqual(1);
      expect(await store.head(mediaKey(created.media.id))).toBeUndefined();
      expect(
        await withTenant(api.tenantId, (tx) => tx.files.findIntent(created.media.id)),
      ).toBeUndefined();
      expect(
        await withTenant(api.tenantId, (tx) => tx.files.find(created.media.id)),
      ).toBeUndefined();
      expect(await usage()).toEqual(before);

      const late = await complete(tokens.engineer, created.media.id);
      expect(late.statusCode).toBe(404);
    });

    it('refuses to confirm an upload whose window has closed', async () => {
      // An intent a second from expiry, rather than a faked clock: the rate
      // limiter keeps its windows in the database, and a clock moved forward
      // would leave them there for every suite after this one.
      const id = crypto.randomUUID();
      const bytes = new Uint8Array(10);
      await withTenant(api.tenantId, (tx) =>
        tx.files.createIntent({
          id,
          bucket: store.bucket,
          storageKey: mediaKey(id),
          contentType: 'application/octet-stream',
          declaredBytes: bytes.byteLength,
          category: 'other',
          createdBy: engineer.userId,
          expiresAt: new Date(Date.now() + 1000),
        }),
      );
      await store.put({ key: mediaKey(id), body: bytes, contentType: 'application/octet-stream' });
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const response = await complete(tokens.engineer, id);
      expect(json<{ error: { code: string } }>(response).error.code).toBe('upload_expired');
      expect(await withTenant(api.tenantId, (tx) => tx.files.find(id))).toBeUndefined();

      await maintain(new Date());
      expect(await store.head(mediaKey(id))).toBeUndefined();
    });

    it('aborts an upload abandoned halfway, leaving nothing in the bucket', async () => {
      const key = `media/${crypto.randomUUID()}`;
      if (api.services.media instanceof R2Storage) {
        const client = api.services.media.client;
        const started = await client.send(
          new CreateMultipartUploadCommand({
            Bucket: store.bucket,
            Key: key,
            ContentType: 'video/mp4',
          }),
        );
        await client.send(
          new UploadPartCommand({
            Bucket: store.bucket,
            Key: key,
            UploadId: started.UploadId,
            PartNumber: 1,
            Body: new Uint8Array(1024 * 1024),
          }),
        );
      } else {
        const uploads = join(api.config.MEDIA_LOCAL_DIR, store.bucket, 'uploads');
        await mkdir(uploads, { recursive: true });
        const partial = join(uploads, 'abandoned.partial');
        await writeFile(partial, new Uint8Array(5 * 1024 * 1024));
        const hourAgo = new Date(Date.now() - 2 * 60 * MINUTE);
        await utimes(partial, hourAgo, hourAgo);
      }

      const report = await maintain(new Date(Date.now() + 2 * 60 * MINUTE));
      expect(report.failures).toEqual([]);
      expect(report.uploadsAborted).toBeGreaterThanOrEqual(1);
      expect(await store.abortIncompleteUploads(new Date(Date.now() + DAY))).toBe(0);
      expect(await store.head(key)).toBeUndefined();
    });

    it('shows usage to owners and admins only', async () => {
      expect(
        (await api.call(tokens.engineer, { method: 'GET', url: '/v1/storage/usage' })).statusCode,
      ).toBe(403);
      const shown = await usage();
      const inBucket = [...(await bucketContents()).values()].reduce((sum, size) => sum + size, 0);
      expect(shown.totalBytes).toBe(inBucket);
      expect(shown.totalObjects).toBe((await bucketContents()).size);
    });

    it('removes the ledger rows and the bucket when the company’s data is deleted', async () => {
      const bucket = store.bucket;
      expect((await usage()).totalObjects).toBeGreaterThan(0);

      const removed = await purgeTenantStorage(api.services.media, api.tenantId);
      expect(removed.bucket).toBe(bucket);
      expect(removed.files).toBeGreaterThan(0);

      expect(await api.services.media.exists(bucket)).toBe(false);
      expect(await usage()).toMatchObject({ totalBytes: 0, totalObjects: 0 });
      expect(await withTenant(api.tenantId, (tx) => tx.files.findMany(uploadedIds))).toEqual([]);
      const refused = await api.call(tokens.engineer, {
        method: 'POST',
        url: '/v1/media',
        payload: { contentType: 'image/jpeg', byteSize: 10 },
      });
      expect(refused.statusCode).toBe(503);
      // Purging twice is not an error.
      await purgeTenantStorage(api.services.media, api.tenantId);
    });
  });
}
