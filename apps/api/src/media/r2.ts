import {
  AbortMultipartUploadCommand,
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  BUCKET_PATTERN,
  type MediaStorage,
  type ObjectStore,
  type StoredObject,
  type UploadTarget,
} from './storage.js';

/**
 * Cloudflare R2, through its S3-compatible API.
 *
 * One account-level token, held here and nowhere else: a client only ever sees a
 * presigned link for one object, one method, and a few minutes.
 *
 * The SDK is told to add checksums only where an operation requires one. Its
 * default adds a CRC to every upload, and a presigned PUT would then demand a
 * checksum header no browser sends.
 */

export interface R2Options {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** A bucket name is this, a hyphen, and the company id. */
  bucketPrefix: string;
  /** Origins that may upload from a browser, set on each bucket's CORS rules. */
  corsOrigins: readonly string[];
  /** For a jurisdiction-restricted account, such as `https://<account>.eu.r2.cloudflarestorage.com`. */
  endpoint?: string;
}

/** Deleting objects is batched at the S3 API's limit. */
const DELETE_BATCH = 1000;

export class R2Storage implements MediaStorage {
  readonly provider = 'r2' as const;
  readonly #client: S3Client;
  readonly #options: R2Options;

  constructor(options: R2Options) {
    this.#options = options;
    this.#client = new S3Client({
      region: 'auto',
      endpoint: options.endpoint ?? `https://${options.accountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
      // <account>.r2.cloudflarestorage.com/<bucket>/<key>: one certificate name
      // for every bucket, rather than a DNS label per company.
      forcePathStyle: true,
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  bucketFor(tenantId: string): string {
    const bucket = `${this.#options.bucketPrefix}-${tenantId}`;
    if (!BUCKET_PATTERN.test(bucket)) {
      throw new Error(`"${bucket}" is not a valid R2 bucket name; shorten R2_BUCKET_PREFIX.`);
    }
    return bucket;
  }

  async provision(bucket: string): Promise<void> {
    try {
      await this.#client.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (!isError(error, 'BucketAlreadyOwnedByYou', 'BucketAlreadyExists')) {
        throw error;
      }
    }
    await this.#client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: [...this.#options.corsOrigins],
              AllowedMethods: ['PUT', 'GET', 'HEAD'],
              AllowedHeaders: ['content-type'],
              ExposeHeaders: ['ETag'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
    // The sweeper aborts stale uploads itself; this is the backstop if it stops running.
    await this.#client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: 'abort-incomplete-uploads',
              Status: 'Enabled',
              Filter: { Prefix: '' },
              AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
            },
          ],
        },
      }),
    );
  }

  open(bucket: string): ObjectStore {
    return new R2Bucket(this.#client, bucket);
  }

  async exists(bucket: string): Promise<boolean> {
    try {
      await this.#client.send(new HeadBucketCommand({ Bucket: bucket }));
      return true;
    } catch (error) {
      if (isError(error, 'NotFound', 'NoSuchBucket')) {
        return false;
      }
      throw error;
    }
  }

  async destroy(bucket: string): Promise<void> {
    const store = this.open(bucket);
    try {
      const keys: string[] = [];
      for await (const object of store.list()) {
        keys.push(object.key);
      }
      await store.delete(keys);
      await store.abortIncompleteUploads(new Date(Date.now() + 24 * 60 * 60 * 1000));
      await this.#client.send(new DeleteBucketCommand({ Bucket: bucket }));
    } catch (error) {
      if (!isError(error, 'NoSuchBucket')) {
        throw error;
      }
    }
  }

  /** @internal For the conformance suite, which starts uploads no client would leave behind. */
  get client(): S3Client {
    return this.#client;
  }
}

class R2Bucket implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    readonly bucket: string,
  ) {}

  async createUpload(input: {
    key: string;
    contentType: string;
    byteSize: number;
    expiresInSeconds: number;
  }): Promise<UploadTarget> {
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.byteSize,
      }),
      {
        expiresIn: input.expiresInSeconds,
        // Signed, so R2 refuses a body of any other length or declared type.
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
    return {
      url,
      method: 'PUT',
      headers: { 'content-type': input.contentType },
      expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000),
    };
  }

  async head(key: string): Promise<StoredObject | undefined> {
    try {
      const found = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        byteSize: found.ContentLength ?? 0,
        contentType: found.ContentType ?? 'application/octet-stream',
        etag: found.ETag ?? null,
      };
    } catch (error) {
      if (isError(error, 'NotFound', 'NoSuchKey')) {
        return undefined;
      }
      throw error;
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      const found = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return await found.Body?.transformToByteArray();
    } catch (error) {
      if (isError(error, 'NotFound', 'NoSuchKey')) {
        return undefined;
      }
      throw error;
    }
  }

  async put(input: { key: string; body: Uint8Array; contentType: string }) {
    const written = await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
      }),
    );
    return {
      byteSize: input.body.byteLength,
      contentType: input.contentType,
      etag: written.ETag ?? null,
    };
  }

  async delete(keys: readonly string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += DELETE_BATCH) {
      const batch = keys.slice(start, start + DELETE_BATCH);
      const result = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        }),
      );
      const failed = (result.Errors ?? []).filter((entry) => entry.Code !== 'NoSuchKey');
      if (failed.length > 0) {
        throw new Error(
          `R2 refused to delete ${String(failed.length)} object(s) from ${this.bucket}: ${failed
            .map((entry) => `${entry.Key ?? '?'} ${entry.Code ?? ''}`)
            .join(', ')}`,
        );
      }
    }
  }

  async createDownload(input: { key: string; contentType: string; expiresInSeconds: number }) {
    const inline = input.contentType.startsWith('image/');
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.key,
        ResponseContentDisposition: inline ? 'inline' : 'attachment',
      }),
      { expiresIn: input.expiresInSeconds },
    );
    return { url, expiresAt: new Date(Date.now() + input.expiresInSeconds * 1000) };
  }

  async *list(): AsyncIterable<{ key: string; byteSize: number }> {
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, ContinuationToken: token }),
      );
      for (const object of page.Contents ?? []) {
        if (object.Key !== undefined) {
          yield { key: object.Key, byteSize: object.Size ?? 0 };
        }
      }
      token = page.IsTruncated === true ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
  }

  async abortIncompleteUploads(startedBefore: Date): Promise<number> {
    let aborted = 0;
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;
    do {
      const page = await this.client.send(
        new ListMultipartUploadsCommand({
          Bucket: this.bucket,
          KeyMarker: keyMarker,
          UploadIdMarker: uploadIdMarker,
        }),
      );
      for (const upload of page.Uploads ?? []) {
        if (
          upload.Key !== undefined &&
          upload.UploadId !== undefined &&
          upload.Initiated !== undefined &&
          upload.Initiated < startedBefore
        ) {
          await this.client.send(
            new AbortMultipartUploadCommand({
              Bucket: this.bucket,
              Key: upload.Key,
              UploadId: upload.UploadId,
            }),
          );
          aborted += 1;
        }
      }
      const more = page.IsTruncated === true;
      keyMarker = more ? page.NextKeyMarker : undefined;
      uploadIdMarker = more ? page.NextUploadIdMarker : undefined;
    } while (keyMarker !== undefined);
    return aborted;
  }
}

function isError(error: unknown, ...names: string[]): boolean {
  if (error instanceof S3ServiceException) {
    return (
      names.includes(error.name) ||
      (names.includes('NotFound') && error.$metadata.httpStatusCode === 404)
    );
  }
  return false;
}
