import type { FastifyInstance } from 'fastify';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BUCKET_PATTERN,
  type MediaStorage,
  OBJECT_KEY_PATTERN,
  type ObjectStore,
  type StoredObject,
  type UploadTarget,
} from './storage.js';

/**
 * Media on local disk, behind signed links that behave like R2's.
 *
 * For development and the integration suites only; `assertProductionReady`
 * refuses it. A bucket is a directory. The links it signs are served by two
 * routes this adapter registers outside `/v1`, because they are not part of the
 * API contract — in production the same links point at R2 and the API is not
 * involved at all.
 *
 * A link names the method, the bucket, the object, its type and size, and an
 * expiry, and is signed with HMAC-SHA256. The upload route writes at most the
 * signed size into `uploads/`, refuses a different type, and only then moves the
 * file into place — so, as on R2, a half-finished upload is never an object,
 * and is what {@link ObjectStore.abortIncompleteUploads} clears away.
 */

export const LOCAL_MEDIA_PREFIX = '/local-media';

interface Sidecar {
  contentType: string;
  etag: string;
}

export class LocalDiskStorage implements MediaStorage {
  readonly provider = 'local' as const;
  readonly #root: string;
  readonly #secret: Buffer;
  readonly #baseUrl: string;

  constructor(options: { directory: string; secret: string | undefined; publicUrl: string }) {
    this.#root = resolve(options.directory);
    this.#secret =
      options.secret === undefined ? randomBytes(32) : Buffer.from(options.secret, 'utf8');
    this.#baseUrl = options.publicUrl;
  }

  bucketFor(tenantId: string): string {
    return `local-${tenantId}`;
  }

  async provision(bucket: string): Promise<void> {
    await mkdir(join(this.#bucketDir(bucket), 'objects'), { recursive: true });
  }

  open(bucket: string): ObjectStore {
    return new LocalBucket(this, bucket);
  }

  async exists(bucket: string): Promise<boolean> {
    return (await stat(this.#bucketDir(bucket)).catch(() => undefined))?.isDirectory() === true;
  }

  async destroy(bucket: string): Promise<void> {
    await rm(this.#bucketDir(bucket), { recursive: true, force: true });
  }

  /** The two routes the signed links point at. */
  register(app: FastifyInstance, maxBytes: number): void {
    void app.register((instance, _options, done) => {
      // Encapsulated, so the JSON routes keep their parser and this one alone
      // receives the raw stream.
      instance.addContentTypeParser('*', (_request, payload, next) => {
        next(null, payload);
      });

      instance.put(`${LOCAL_MEDIA_PREFIX}/*`, async (request, reply) => {
        const link = this.#verify(request.url, 'PUT');
        if (link === undefined || link.byteSize > maxBytes) {
          return reply.status(403).send();
        }
        if (request.headers['content-type'] !== link.contentType) {
          return reply.status(403).send();
        }
        const declared = request.headers['content-length'];
        if (declared !== undefined && Number(declared) !== link.byteSize) {
          return reply.status(403).send();
        }

        const paths = this.paths(link.bucket, link.key);
        const uploads = join(this.#bucketDir(link.bucket), 'uploads');
        await mkdir(uploads, { recursive: true });
        const partial = join(uploads, `${randomBytes(8).toString('hex')}.partial`);
        const hash = createHash('md5');
        let written = 0;
        try {
          await pipeline(
            request.body as Readable,
            async function* limit(source: AsyncIterable<Buffer>) {
              for await (const chunk of source) {
                written += chunk.length;
                if (written > link.byteSize) {
                  throw new Error('larger than signed');
                }
                hash.update(chunk);
                yield chunk;
              }
            },
            createWriteStream(partial),
          );
        } catch {
          await rm(partial, { force: true });
          return reply.status(403).send();
        }
        if (written !== link.byteSize) {
          await rm(partial, { force: true });
          return reply.status(403).send();
        }
        const etag = `"${hash.digest('hex')}"`;
        await this.#place(paths, partial, { contentType: link.contentType, etag });
        return reply.status(200).header('etag', etag).send();
      });

      instance.get(`${LOCAL_MEDIA_PREFIX}/*`, async (request, reply) => {
        const link = this.#verify(request.url, 'GET');
        const found = link === undefined ? undefined : await this.open(link.bucket).head(link.key);
        if (link === undefined || found === undefined) {
          return reply.status(404).send();
        }
        const inline = found.contentType.startsWith('image/');
        return reply
          .header('content-type', found.contentType)
          .header('content-length', String(found.byteSize))
          .header('cache-control', 'private, max-age=300')
          .header('x-content-type-options', 'nosniff')
          .header('content-disposition', inline ? 'inline' : 'attachment')
          .send(createReadStream(this.paths(link.bucket, link.key).file));
      });

      done();
    });
  }

  /** @internal Where an object and its sidecar live. */
  paths(bucket: string, key: string) {
    if (!OBJECT_KEY_PATTERN.test(key)) {
      throw new Error(`Not an object key: ${key}`);
    }
    const base = this.#bucketDir(bucket);
    return {
      base,
      file: join(base, 'objects', ...key.split('/')),
      sidecar: join(base, 'meta', ...key.split('/')) + '.json',
    };
  }

  /** @internal */
  async place(bucket: string, key: string, body: Uint8Array, contentType: string) {
    const paths = this.paths(bucket, key);
    const uploads = join(paths.base, 'uploads');
    await mkdir(uploads, { recursive: true });
    const partial = join(uploads, `${randomBytes(8).toString('hex')}.partial`);
    await writeFile(partial, body);
    const etag = `"${createHash('md5').update(body).digest('hex')}"`;
    await this.#place(paths, partial, { contentType, etag });
    return etag;
  }

  /** @internal */
  signedUrl(
    method: 'PUT' | 'GET',
    bucket: string,
    key: string,
    contentType: string,
    byteSize: number,
    expiresAt: Date,
  ) {
    const expires = Math.floor(expiresAt.getTime() / 1000);
    const query = new URLSearchParams({
      type: contentType,
      size: String(byteSize),
      expires: String(expires),
      signature: this.#signature(method, bucket, key, contentType, byteSize, expires),
    });
    return `${this.#baseUrl}${LOCAL_MEDIA_PREFIX}/${bucket}/${key}?${query.toString()}`;
  }

  async #place(paths: { file: string; sidecar: string }, partial: string, sidecar: Sidecar) {
    await mkdir(dirname(paths.file), { recursive: true });
    await mkdir(dirname(paths.sidecar), { recursive: true });
    // Sidecar first: an object without one is invisible to `head`, never mis-described.
    await writeFile(paths.sidecar, JSON.stringify(sidecar));
    await rename(partial, paths.file);
  }

  #bucketDir(bucket: string) {
    if (!BUCKET_PATTERN.test(bucket)) {
      throw new Error(`Not a bucket name: ${bucket}`);
    }
    return join(this.#root, bucket);
  }

  #signature(
    method: string,
    bucket: string,
    key: string,
    contentType: string,
    byteSize: number,
    expires: number,
  ) {
    return createHmac('sha256', this.#secret)
      .update([method, bucket, key, contentType, String(byteSize), String(expires)].join('\n'))
      .digest('base64url');
  }

  #verify(url: string, method: 'PUT' | 'GET') {
    const parsed = new URL(url, 'http://local');
    const path = decodeURIComponent(parsed.pathname.slice(LOCAL_MEDIA_PREFIX.length + 1));
    const slash = path.indexOf('/');
    const bucket = path.slice(0, slash);
    const key = path.slice(slash + 1);
    const contentType = parsed.searchParams.get('type') ?? '';
    const byteSize = Number(parsed.searchParams.get('size'));
    const expires = Number(parsed.searchParams.get('expires'));
    const given = Buffer.from(parsed.searchParams.get('signature') ?? '', 'utf8');
    if (
      slash < 0 ||
      !BUCKET_PATTERN.test(bucket) ||
      !OBJECT_KEY_PATTERN.test(key) ||
      !Number.isInteger(byteSize) ||
      !Number.isInteger(expires)
    ) {
      return undefined;
    }
    if (expires * 1000 < Date.now()) {
      return undefined;
    }
    const expected = Buffer.from(
      this.#signature(method, bucket, key, contentType, byteSize, expires),
      'utf8',
    );
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return undefined;
    }
    return { bucket, key, contentType, byteSize };
  }
}

class LocalBucket implements ObjectStore {
  constructor(
    private readonly storage: LocalDiskStorage,
    readonly bucket: string,
  ) {}

  createUpload(input: {
    key: string;
    contentType: string;
    byteSize: number;
    expiresInSeconds: number;
  }): Promise<UploadTarget> {
    this.storage.paths(this.bucket, input.key);
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    return Promise.resolve({
      url: this.storage.signedUrl(
        'PUT',
        this.bucket,
        input.key,
        input.contentType,
        input.byteSize,
        expiresAt,
      ),
      method: 'PUT',
      headers: { 'content-type': input.contentType },
      expiresAt,
    });
  }

  async head(key: string): Promise<StoredObject | undefined> {
    const paths = this.storage.paths(this.bucket, key);
    try {
      const [sidecar, file] = await Promise.all([
        readFile(paths.sidecar, 'utf8').then((text) => JSON.parse(text) as Sidecar),
        stat(paths.file),
      ]);
      return { contentType: sidecar.contentType, byteSize: file.size, etag: sidecar.etag };
    } catch {
      return undefined;
    }
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    try {
      return new Uint8Array(await readFile(this.storage.paths(this.bucket, key).file));
    } catch {
      return undefined;
    }
  }

  async put(input: { key: string; body: Uint8Array; contentType: string }) {
    const etag = await this.storage.place(this.bucket, input.key, input.body, input.contentType);
    return { byteSize: input.body.byteLength, contentType: input.contentType, etag };
  }

  async delete(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      const paths = this.storage.paths(this.bucket, key);
      await rm(paths.file, { force: true });
      await rm(paths.sidecar, { force: true });
    }
  }

  createDownload(input: { key: string; contentType: string; expiresInSeconds: number }) {
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    return Promise.resolve({
      url: this.storage.signedUrl('GET', this.bucket, input.key, input.contentType, 0, expiresAt),
      expiresAt,
    });
  }

  async *list(): AsyncIterable<{ key: string; byteSize: number }> {
    const objects = join(this.storage.paths(this.bucket, 'x').base, 'objects');
    let entries;
    try {
      entries = await readdir(objects, { recursive: true, withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isFile()) {
        const path = join(entry.parentPath, entry.name);
        const key = relative(objects, path).split(sep).join('/');
        const found = await this.head(key);
        if (found !== undefined) {
          yield { key, byteSize: found.byteSize };
        }
      }
    }
  }

  async abortIncompleteUploads(startedBefore: Date): Promise<number> {
    const uploads = join(this.storage.paths(this.bucket, 'x').base, 'uploads');
    let names: string[];
    try {
      names = await readdir(uploads);
    } catch {
      return 0;
    }
    let aborted = 0;
    for (const name of names) {
      const path = join(uploads, name);
      const info = await stat(path).catch(() => undefined);
      if (info !== undefined && info.mtime < startedBefore) {
        await rm(path, { force: true });
        aborted += 1;
      }
    }
    return aborted;
  }
}
