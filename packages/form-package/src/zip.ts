import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { refuse } from './errors.js';

/**
 * The ZIP underneath a `.integr8form` file, written and read here with
 * Node's own zlib rather than a library: the package reads files from anyone,
 * and a reader small enough to check line by line refuses everything the format
 * does not need — ZIP64, encryption, other compression methods, entries that
 * overlap, a central directory that disagrees with the entries — and inflates
 * nothing past the size the entry declared (`maxOutputLength` stops zlib as
 * soon as it would), so a ZIP bomb costs a few kilobytes of work.
 *
 * What it writes opens in any unzip tool: plain ZIP 2.0, UTF-8 names,
 * deflated JSON, pictures stored as they are (they are compressed already).
 */

const LOCAL = 0x04034b50;
const CENTRAL = 0x02014b50;
const END = 0x06054b50;
const ZIP64_END_LOCATOR = 0x07064b50;

const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
const FLAG_UTF8 = 0x0800;
const FLAG_MASKED_HEADER = 0x2000;

const STORED = 0;
const DEFLATED = 8;

export interface ZipEntryInput {
  name: string;
  data: Uint8Array;
  /** Deflate it (JSON) or store it as it is (pictures). */
  compress: boolean;
}

/** MS-DOS date and time, as ZIP keeps them, in UTC. */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getUTCFullYear(), 1980), 2107);
  return {
    time:
      (date.getUTCHours() << 11) |
      (date.getUTCMinutes() << 5) |
      Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

export function writeZip(entries: readonly ZipEntryInput[], modified: Date): Uint8Array {
  const stamp = dosDateTime(modified);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const body = entry.compress ? deflateRawSync(entry.data, { level: 9 }) : entry.data;
    const checksum = crc32(entry.data);
    const method = entry.compress ? DEFLATED : STORED;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, Buffer.from(body.buffer, body.byteOffset, body.length));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // Extra field, comment, disk, internal and external attributes: none.
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  const out = Buffer.concat([...locals, directory, end]);
  return new Uint8Array(out.buffer, out.byteOffset, out.length);
}

/** One entry as the central directory describes it, checked against its local header. */
export interface ZipRecord {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  dataStart: number;
}

const invalid = (message: string): never => refuse('package_invalid', message);

const decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * The entries of a ZIP, from its central directory, each checked against its
 * local header, without inflating anything. Refuses more than `maxEntries`.
 */
export function listZip(bytes: Uint8Array, maxEntries: number): ZipRecord[] {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  if (view.length < 22) {
    return invalid('This is not a .integr8form file: it is too short to be a ZIP.');
  }
  // The end record sits at the very end, after a comment of at most 64 KB.
  let end = -1;
  for (let at = view.length - 22; at >= Math.max(0, view.length - 22 - 0xffff); at -= 1) {
    if (view.readUInt32LE(at) === END && at + 22 + view.readUInt16LE(at + 20) === view.length) {
      end = at;
      break;
    }
  }
  if (end < 0) {
    return invalid('This is not a .integr8form file: no ZIP directory was found at its end.');
  }
  if (end >= 20 && view.readUInt32LE(end - 20) === ZIP64_END_LOCATOR) {
    return invalid('ZIP64 archives are not used by this format.');
  }
  const disk = view.readUInt16LE(end + 4);
  const directoryDisk = view.readUInt16LE(end + 6);
  const here = view.readUInt16LE(end + 8);
  const count = view.readUInt16LE(end + 10);
  const directorySize = view.readUInt32LE(end + 12);
  const directoryOffset = view.readUInt32LE(end + 16);
  if (disk !== 0 || directoryDisk !== 0 || here !== count) {
    return invalid('Archives split over several files are not used by this format.');
  }
  if (count === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    return invalid('ZIP64 archives are not used by this format.');
  }
  if (count > maxEntries) {
    refuse(
      'package_too_large',
      `The package has ${String(count)} entries; at most ${String(maxEntries)} are allowed.`,
    );
  }
  if (directoryOffset + directorySize !== end) {
    return invalid('The ZIP directory is not where the archive says it is.');
  }

  const records: ZipRecord[] = [];
  const spans: [number, number][] = [];
  let at = directoryOffset;
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > end || view.readUInt32LE(at) !== CENTRAL) {
      return invalid('The ZIP directory is damaged.');
    }
    const flags = view.readUInt16LE(at + 8);
    const method = view.readUInt16LE(at + 10);
    const crc = view.readUInt32LE(at + 16);
    const compressedSize = view.readUInt32LE(at + 20);
    const size = view.readUInt32LE(at + 24);
    const nameLength = view.readUInt16LE(at + 28);
    const extraLength = view.readUInt16LE(at + 30);
    const commentLength = view.readUInt16LE(at + 32);
    const startDisk = view.readUInt16LE(at + 34);
    const localOffset = view.readUInt32LE(at + 42);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end) {
      return invalid('The ZIP directory is damaged.');
    }
    const nameBytes = view.subarray(at + 46, at + 46 + nameLength);
    let name: string;
    try {
      name = decoder.decode(nameBytes);
    } catch {
      return invalid('An entry’s name is not valid UTF-8.');
    }
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION | FLAG_MASKED_HEADER)) {
      return invalid(`"${name}" is encrypted; packages are never encrypted.`);
    }
    if (method !== STORED && method !== DEFLATED) {
      return invalid(
        `"${name}" is compressed in a way this format does not use (method ${String(method)}).`,
      );
    }
    if (size === 0xffffffff || compressedSize === 0xffffffff || localOffset === 0xffffffff) {
      return invalid('ZIP64 archives are not used by this format.');
    }
    if (startDisk !== 0) {
      return invalid('Archives split over several files are not used by this format.');
    }
    if (method === STORED && compressedSize !== size) {
      return invalid(`"${name}" is stored, but its two sizes differ.`);
    }

    // The local header must agree with the directory.
    if (localOffset + 30 > directoryOffset || view.readUInt32LE(localOffset) !== LOCAL) {
      return invalid(`"${name}" is not where the ZIP directory says it is.`);
    }
    const localFlags = view.readUInt16LE(localOffset + 6);
    const localNameLength = view.readUInt16LE(localOffset + 26);
    const localExtraLength = view.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      view.readUInt16LE(localOffset + 8) !== method ||
      (localFlags & FLAG_ENCRYPTED) !== 0 ||
      localNameLength !== nameLength ||
      !view.subarray(localOffset + 30, localOffset + 30 + nameLength).equals(nameBytes) ||
      dataEnd > directoryOffset
    ) {
      return invalid(`"${name}" does not match its entry in the ZIP directory.`);
    }
    if (
      (localFlags & FLAG_DATA_DESCRIPTOR) === 0 &&
      (view.readUInt32LE(localOffset + 14) !== crc ||
        view.readUInt32LE(localOffset + 18) !== compressedSize ||
        view.readUInt32LE(localOffset + 22) !== size)
    ) {
      return invalid(`"${name}" does not match its entry in the ZIP directory.`);
    }
    spans.push([localOffset, dataEnd]);
    records.push({ name, method, crc, compressedSize, size, dataStart });
    at = next;
  }
  if (at !== end) {
    return invalid('The ZIP directory is damaged.');
  }
  // Two entries sharing bytes is how some ZIP bombs multiply themselves.
  spans.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < spans.length; index += 1) {
    if ((spans[index]?.[0] ?? 0) < (spans[index - 1]?.[1] ?? 0)) {
      return invalid('Two entries of the ZIP overlap.');
    }
  }
  return records;
}

/**
 * One entry's bytes. Inflating stops the moment it passes the size the entry
 * declared, which the caller has already held to its limits.
 */
export function readEntry(bytes: Uint8Array, record: ZipRecord): Uint8Array {
  const raw = bytes.subarray(record.dataStart, record.dataStart + record.compressedSize);
  let data: Uint8Array;
  if (record.method === STORED) {
    data = raw;
  } else {
    try {
      data = inflateRawSync(raw, { maxOutputLength: Math.max(1, record.size) });
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
        refuse(
          'package_too_large',
          `"${record.name}" inflates to more than the ${String(record.size)} bytes it declares.`,
          { entry: record.name },
        );
      }
      return refuse('package_invalid', `"${record.name}" could not be decompressed.`, {
        entry: record.name,
      });
    }
  }
  if (data.length !== record.size || crc32(data) !== record.crc) {
    return refuse('package_invalid', `"${record.name}" is damaged: its checksum does not match.`, {
      entry: record.name,
    });
  }
  return data;
}
