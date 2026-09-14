import type { FastifyInstance } from 'fastify';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { MediaStorage, StoredObject, UploadTarget } from './storage.js';

/**
 * Media on local disk, behind signed links that behave like R2's.
 *
 * For development and the integration suites only; `assertProductionReady`
 * refuses it. The links it signs are served by two routes this adapter
 * registers outside `/v1`, because they are not part of the API contract — in
 * production the same links point at R2 and the API is not involved at all.
 *
 * A link names the method, the object, its type and size, and an expiry, and
 * is signed with HMAC-SHA256. The upload route writes at most the signed size,
 * refuses a different type, and only then moves the file into place, so a
 * half-finished upload is never mistaken for a stored object.
 */

export const LOCAL_MEDIA_PREFIX = '/local-media';

const KEY_PATTERN = /^[0-9a-f-]{36}\/[0-9a-f-]{36}$/u;

interface Sidecar {
  contentType: string;
  byteSize: number;
}

export class LocalDiskStorage implements MediaStorage {
  readonly #root: string;
  readonly #secret: Buffer;
  readonly #baseUrl: string;

  constructor(options: { directory: string; secret: string | undefined; publicUrl: string }) {
    this.#root = resolve(options.directory);
    this.#secret =
      options.secret === undefined ? randomBytes(32) : Buffer.from(options.secret, 'utf8');
    this.#baseUrl = options.publicUrl;
  }

  createUpload(input: {
    key: string;
    contentType: string;
    byteSize: number;
    expiresInSeconds: number;
  }): Promise<UploadTarget> {
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    const url = this.#signedUrl('PUT', input.key, input.contentType, input.byteSize, expiresAt);
    return Promise.resolve({
      url,
      method: 'PUT',
      headers: { 'content-type': input.contentType },
      expiresAt,
    });
  }

  async stat(key: string): Promise<StoredObject | undefined> {
    const paths = this.#paths(key);
    try {
      const [sidecar, file] = await Promise.all([
        readFile(paths.sidecar, 'utf8').then((text) => JSON.parse(text) as Sidecar),
        stat(paths.file),
      ]);
      return { contentType: sidecar.contentType, byteSize: file.size };
    } catch {
      return undefined;
    }
  }

  createDownload(input: {
    key: string;
    contentType: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; expiresAt: Date }> {
    const expiresAt = new Date(Date.now() + input.expiresInSeconds * 1000);
    return Promise.resolve({
      url: this.#signedUrl('GET', input.key, input.contentType, 0, expiresAt),
      expiresAt,
    });
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

        const paths = this.#paths(link.key);
        await mkdir(dirname(paths.file), { recursive: true });
        const partial = `${paths.file}.${randomBytes(6).toString('hex')}.partial`;
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
                yield chunk;
              }
            },
            createWriteStream(partial),
          );
        } catch {
          await rm(partial, { force: true });
          return reply.status(413).send();
        }
        if (written !== link.byteSize) {
          await rm(partial, { force: true });
          return reply.status(400).send();
        }
        await writeFile(
          paths.sidecar,
          JSON.stringify({ contentType: link.contentType, byteSize: written } satisfies Sidecar),
        );
        await rename(partial, paths.file);
        return reply.status(204).send();
      });

      instance.get(`${LOCAL_MEDIA_PREFIX}/*`, async (request, reply) => {
        const link = this.#verify(request.url, 'GET');
        const found = link === undefined ? undefined : await this.stat(link.key);
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
          .send(createReadStream(this.#paths(link.key).file));
      });

      done();
    });
  }

  #paths(key: string) {
    if (!KEY_PATTERN.test(key)) {
      throw new Error(`Not a media key: ${key}`);
    }
    const file = join(this.#root, ...key.split('/'));
    return { file, sidecar: `${file}.json` };
  }

  #signature(method: string, key: string, contentType: string, byteSize: number, expires: number) {
    return createHmac('sha256', this.#secret)
      .update([method, key, contentType, String(byteSize), String(expires)].join('\n'))
      .digest('base64url');
  }

  #signedUrl(
    method: 'PUT' | 'GET',
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
      signature: this.#signature(method, key, contentType, byteSize, expires),
    });
    return `${this.#baseUrl}${LOCAL_MEDIA_PREFIX}/${key}?${query.toString()}`;
  }

  #verify(url: string, method: 'PUT' | 'GET') {
    const parsed = new URL(url, 'http://local');
    const key = decodeURIComponent(parsed.pathname.slice(LOCAL_MEDIA_PREFIX.length + 1));
    const contentType = parsed.searchParams.get('type') ?? '';
    const byteSize = Number(parsed.searchParams.get('size'));
    const expires = Number(parsed.searchParams.get('expires'));
    const given = Buffer.from(parsed.searchParams.get('signature') ?? '', 'utf8');
    if (!KEY_PATTERN.test(key) || !Number.isInteger(byteSize) || !Number.isInteger(expires)) {
      return undefined;
    }
    if (expires * 1000 < Date.now()) {
      return undefined;
    }
    const expected = Buffer.from(
      this.#signature(method, key, contentType, byteSize, expires),
      'utf8',
    );
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return undefined;
    }
    return { key, contentType, byteSize };
  }
}
