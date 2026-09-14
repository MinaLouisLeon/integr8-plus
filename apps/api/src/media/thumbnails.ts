import { withTenant } from '@integr8/db';
import sharp from 'sharp';
import { getStorage } from './tenant-storage.js';
import { type MediaStorage, thumbnailKey } from './storage.js';

/**
 * Thumbnails, made in the worker after an image is confirmed.
 *
 * A list of submissions shows many photos at once; sending each at 2048 pixels
 * would cost the reader's data and the company's egress for nothing. A
 * thumbnail is 320 pixels on its longest edge, WebP, and counted in the
 * company's usage under its own category.
 */

export const THUMBNAIL_QUEUE = 'media.thumbnail';
export const THUMBNAIL_EDGE = 320;
export const THUMBNAIL_QUALITY = 70;

/** Images larger than this many pixels are not decoded: a decompression bomb costs memory, not bytes. */
const MAX_INPUT_PIXELS = 100_000_000;

export async function renderThumbnail(original: Uint8Array): Promise<Uint8Array> {
  const output = await sharp(original, { failOn: 'error', limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize(THUMBNAIL_EDGE, THUMBNAIL_EDGE, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: THUMBNAIL_QUALITY })
    .toBuffer();
  return new Uint8Array(output);
}

export type ThumbnailOutcome = 'ready' | 'failed' | 'skipped';

/**
 * Makes and records one file's thumbnail.
 *
 * An image sharp cannot read is marked failed, not retried: another attempt will
 * not make it readable. A storage or database error is thrown, so the job is
 * retried.
 */
export async function makeThumbnail(
  media: MediaStorage,
  tenantId: string,
  fileId: string,
): Promise<ThumbnailOutcome> {
  const file = await withTenant(tenantId, (tx) => tx.files.find(fileId));
  if (file?.thumbnailStatus !== 'pending' || file.purgedAt !== null) {
    return 'skipped';
  }
  const store = await getStorage(media, tenantId);
  const original = await store.get(file.storageKey);
  if (original === undefined) {
    await withTenant(tenantId, (tx) => tx.files.markThumbnailFailed(fileId));
    return 'failed';
  }

  let rendered: Uint8Array;
  try {
    rendered = await renderThumbnail(original);
  } catch {
    await withTenant(tenantId, (tx) => tx.files.markThumbnailFailed(fileId));
    return 'failed';
  }

  const key = thumbnailKey(fileId);
  const stored = await store.put({ key, body: rendered, contentType: 'image/webp' });
  const recorded = await withTenant(tenantId, (tx) =>
    tx.files.recordThumbnail(fileId, { key, bytes: stored.byteSize }),
  );
  if (!recorded) {
    // Purged, or thumbnailed by another attempt, while this one worked. Only an
    // object the ledger counts may stay in the bucket.
    const current = await withTenant(tenantId, (tx) => tx.files.find(fileId));
    if (current?.thumbnailKey !== key || current.purgedAt !== null) {
      await store.delete([key]);
    }
    return 'skipped';
  }
  return 'ready';
}
