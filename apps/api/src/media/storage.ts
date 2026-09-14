import type { MediaCategory, StorageProvider } from '@integr8/db';

/**
 * Where uploaded files' bytes live.
 *
 * The API never streams a client's upload through itself: it hands out a
 * short-lived link, the client sends the bytes straight to storage, and the API
 * then reads back what arrived. That is how R2 presigned URLs work, and the
 * local adapter imitates it exactly — its links point back at this server, but
 * the client code that follows them is the same.
 *
 * Every company has its own bucket, because Cloudflare reports storage per
 * bucket and cannot split one by prefix; a bucket's usage is a company's usage.
 * So storage comes in two layers: {@link MediaStorage} manages buckets, and
 * {@link ObjectStore} is one bucket's objects. Feature code only ever sees the
 * second, through `getStorage(tenantId)`.
 */

export interface UploadTarget {
  url: string;
  method: 'PUT';
  /** Headers the client must send with the bytes, exactly. */
  headers: Record<string, string>;
  expiresAt: Date;
}

/** What storage says it holds. The only source of a ledger row's facts. */
export interface StoredObject {
  byteSize: number;
  contentType: string;
  etag: string | null;
}

/** One bucket's objects. */
export interface ObjectStore {
  readonly bucket: string;

  /**
   * A link the client may upload exactly this object to until it expires. The
   * type and the size are part of the signature: storage refuses anything else.
   */
  createUpload(input: {
    key: string;
    contentType: string;
    byteSize: number;
    expiresInSeconds: number;
  }): Promise<UploadTarget>;

  /** What storage holds under `key`, or `undefined` if nothing complete arrived. */
  head(key: string): Promise<StoredObject | undefined>;

  /** The bytes, for work the server does itself, such as thumbnails. */
  get(key: string): Promise<Uint8Array | undefined>;

  /** Writes an object the server made itself. */
  put(input: { key: string; body: Uint8Array; contentType: string }): Promise<StoredObject>;

  /** Removes objects. Keys that do not exist are not an error. */
  delete(keys: readonly string[]): Promise<void>;

  /** A short-lived link to read the object. Nothing in a bucket is ever public. */
  createDownload(input: {
    key: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; expiresAt: Date }>;

  /** Every complete object in the bucket, for reconciliation and teardown. */
  list(): AsyncIterable<{ key: string; byteSize: number }>;

  /**
   * Aborts uploads begun before `startedBefore` and never completed: their parts
   * occupy the bucket without being objects. Returns how many were aborted.
   */
  abortIncompleteUploads(startedBefore: Date): Promise<number>;
}

/** Buckets: one per company. */
export interface MediaStorage {
  readonly provider: StorageProvider;

  /** The bucket a company's files belong in, derived from its id. */
  bucketFor(tenantId: string): string;

  /** Creates the bucket, with the settings browsers need to upload to it. Idempotent. */
  provision(bucket: string): Promise<void>;

  open(bucket: string): ObjectStore;

  /** Whether the bucket exists. */
  exists(bucket: string): Promise<boolean>;

  /** Removes every object and upload in the bucket, then the bucket. Idempotent. */
  destroy(bucket: string): Promise<void>;
}

/** Where the original of an upload lives in its company's bucket. */
export const mediaKey = (fileId: string) => `media/${fileId}`;

/** Where a file's thumbnail lives. Always WebP. */
export const thumbnailKey = (fileId: string) => `thumbnails/${fileId}.webp`;

/**
 * Object keys this API writes. Lowercase segments that start with a letter or
 * digit, so `..` and absolute paths cannot be expressed.
 */
export const OBJECT_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9.-]*)*$/u;

/** R2's bucket naming rule, which migration 0009 also enforces. */
export const BUCKET_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;

/** The category a file's bytes are billed and reported under. */
export function categoryOf(contentType: string): MediaCategory {
  if (contentType.startsWith('image/')) {
    return 'image';
  }
  if (contentType.startsWith('video/')) {
    return 'video';
  }
  if (
    contentType === 'application/pdf' ||
    contentType === 'text/plain' ||
    contentType === 'text/csv' ||
    contentType.startsWith('application/vnd.openxmlformats-officedocument.') ||
    contentType === 'application/msword' ||
    contentType === 'application/vnd.ms-excel'
  ) {
    return 'document';
  }
  return 'other';
}

/**
 * Media types a person may upload.
 *
 * Refused, whatever a form's field says: types a browser would execute or render
 * as a page when the link is opened. An SVG is an image and also a script.
 */
export function isAcceptableMediaType(contentType: string): boolean {
  if (!/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(contentType)) {
    return false;
  }
  const refused = [
    /^text\/html$/u,
    /^application\/xhtml\+xml$/u,
    /^image\/svg\+xml$/u,
    /xml$/u,
    /javascript/u,
    /^text\/ecmascript$/u,
    /^application\/x-shockwave-flash$/u,
  ];
  return !refused.some((pattern) => pattern.test(contentType));
}
