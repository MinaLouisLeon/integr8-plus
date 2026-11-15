import { createReadStream, createWriteStream, type WriteStream } from 'node:fs';
import { once } from 'node:events';
import { createGunzip, createGzip, type Gzip } from 'node:zlib';

/**
 * The container of a company transfer (P41): a gzipped tar, written and read
 * as a stream, so a company of any size moves in a few megabytes of memory.
 *
 * Plain ustar, the subset every `tar` reads, so an archive can be opened and
 * looked at with ordinary tools. Written by hand, like the `.integr8form` ZIP
 * reader, rather than taken from a library: an archive staff carry between
 * servers is untrusted input, and the reader below accepts only regular files
 * with short, plain names and bounded sizes, which is easier to say than to
 * configure. Corruption is caught by gzip's own checksum.
 */

const BLOCK = 512;

/** The largest single entry read: a file is at most MEDIA_MAX_BYTES (25 MB by default). */
export const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

/** Names: lowercase paths of plain segments, as the writer makes them. */
const ENTRY_NAME = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u;

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArchiveError';
  }
}

export class ArchiveWriter {
  readonly #gzip: Gzip;
  readonly #file: WriteStream;
  readonly #done: Promise<unknown>;

  constructor(path: string) {
    this.#gzip = createGzip({ level: 6 });
    this.#file = createWriteStream(path, { mode: 0o600 });
    this.#gzip.pipe(this.#file);
    this.#done = once(this.#file, 'close');
  }

  async add(name: string, body: Uint8Array | string): Promise<void> {
    if (!ENTRY_NAME.test(name) || name.length > 100) {
      throw new ArchiveError(`"${name}" cannot be an entry name`);
    }
    const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
    await this.#write(header(name, data.byteLength));
    await this.#write(data);
    const pad = (BLOCK - (data.byteLength % BLOCK)) % BLOCK;
    if (pad > 0) await this.#write(Buffer.alloc(pad));
  }

  async close(): Promise<void> {
    await this.#write(Buffer.alloc(BLOCK * 2));
    this.#gzip.end();
    await this.#done;
  }

  async #write(chunk: Buffer): Promise<void> {
    if (!this.#gzip.write(chunk)) {
      await once(this.#gzip, 'drain');
    }
  }
}

function header(name: string, size: number): Buffer {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, 'utf8');
  block.write('0000600\0', 100, 8, 'ascii');
  block.write('0000000\0', 108, 8, 'ascii');
  block.write('0000000\0', 116, 8, 'ascii');
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  block.write(
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, '0')}\0`,
    136,
    12,
    'ascii',
  );
  block.write('        ', 148, 8, 'ascii');
  block.write('0', 156, 1, 'ascii');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return block;
}

export interface ArchiveEntry {
  name: string;
  body: Buffer;
}

/** The entries of an archive, in the order they were written. */
export async function* readArchive(path: string): AsyncIterable<ArchiveEntry> {
  const stream = createReadStream(path).pipe(createGunzip());
  let buffer: Buffer = Buffer.alloc(0);
  let pending: { name: string; size: number } | undefined;

  for await (const chunk of stream as AsyncIterable<Buffer>) {
    buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
    for (;;) {
      if (pending === undefined) {
        if (buffer.length < BLOCK) break;
        const block = buffer.subarray(0, BLOCK);
        buffer = buffer.subarray(BLOCK);
        if (block.every((byte) => byte === 0)) {
          // The end: two empty blocks. Anything after them is ignored.
          return;
        }
        pending = parseHeader(block);
      }
      const padded = Math.ceil(pending.size / BLOCK) * BLOCK;
      if (buffer.length < padded) break;
      const body = Buffer.from(buffer.subarray(0, pending.size));
      buffer = buffer.subarray(padded);
      const entry = { name: pending.name, body };
      pending = undefined;
      yield entry;
    }
  }
  throw new ArchiveError('The archive ends before its last entry: it is incomplete.');
}

function parseHeader(block: Buffer): { name: string; size: number } {
  const stored = Number.parseInt(block.toString('ascii', 148, 156).replace(/[\0 ]+$/u, ''), 8);
  const copy = Buffer.from(block);
  copy.write('        ', 148, 8, 'ascii');
  let sum = 0;
  for (const byte of copy) sum += byte;
  if (sum !== stored) {
    throw new ArchiveError('An entry header is damaged.');
  }
  const type = block.toString('ascii', 156, 157);
  if (type !== '0' && type !== '\0') {
    throw new ArchiveError('The archive holds something other than plain files.');
  }
  const name = block.toString('utf8', 0, 100).replace(/\0.*$/su, '');
  if (!ENTRY_NAME.test(name) || block.toString('utf8', 345, 500).replace(/\0+$/u, '') !== '') {
    throw new ArchiveError(`The archive holds an entry with a name it may not have: "${name}".`);
  }
  const size = Number.parseInt(block.toString('ascii', 124, 136).replace(/[\0 ]+$/u, ''), 8);
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ENTRY_BYTES) {
    throw new ArchiveError(`"${name}" is larger than an entry may be.`);
  }
  return { name, size };
}
