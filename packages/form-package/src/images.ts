/**
 * The pictures a package may carry: the three kinds the PDF designer accepts
 * for backgrounds and image blocks. A picture is only taken for what its first
 * bytes prove it is, and only once its width and height can be read from them —
 * a file named `.png` that is text, or a PNG named `.jpg`, is refused.
 */
export const PACKAGE_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type PackageImageType = (typeof PACKAGE_IMAGE_TYPES)[number];

/** The one extension each kind is stored under inside the package. */
export const PACKAGE_IMAGE_EXTENSIONS: Readonly<Record<PackageImageType, string>> = Object.freeze({
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
});

export interface ImageInfo {
  contentType: PackageImageType;
  width: number;
  height: number;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const u16be = (b: Uint8Array, at: number) => ((b[at] ?? 0) << 8) | (b[at + 1] ?? 0);
const u16le = (b: Uint8Array, at: number) => (b[at] ?? 0) | ((b[at + 1] ?? 0) << 8);
const u24le = (b: Uint8Array, at: number) => u16le(b, at) | ((b[at + 2] ?? 0) << 16);
const u32be = (b: Uint8Array, at: number) => u16be(b, at) * 0x10000 + u16be(b, at + 2);
const u32le = (b: Uint8Array, at: number) => u16le(b, at) + u16le(b, at + 2) * 0x10000;
const ascii = (b: Uint8Array, at: number, length: number) =>
  String.fromCharCode(...b.subarray(at, at + length));

const sized = (contentType: PackageImageType, width: number, height: number): ImageInfo | null =>
  width > 0 && height > 0 ? { contentType, width, height } : null;

function png(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 33 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) {
    return null;
  }
  // The first chunk is always IHDR, 13 bytes long.
  if (u32be(bytes, 8) !== 13 || ascii(bytes, 12, 4) !== 'IHDR') {
    return null;
  }
  return sized('image/png', u32be(bytes, 16), u32be(bytes, 20));
}

/** Start-of-frame markers, which carry the size; not DHT (C4), JPG (C8) or DAC (CC). */
const SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpeg(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    return null;
  }
  let at = 2;
  while (at + 4 <= bytes.length) {
    if (bytes[at] !== 0xff) {
      return null;
    }
    const marker = bytes[at + 1] ?? 0;
    if (marker === 0xff) {
      // Fill byte before a marker.
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      // The end, or the picture data, before any frame header: not a picture.
      return null;
    }
    const length = u16be(bytes, at + 2);
    if (length < 2) {
      return null;
    }
    if (SOF.has(marker)) {
      if (at + 9 > bytes.length) {
        return null;
      }
      return sized('image/jpeg', u16be(bytes, at + 7), u16be(bytes, at + 5));
    }
    at += 2 + length;
  }
  return null;
}

function webp(bytes: Uint8Array): ImageInfo | null {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    return null;
  }
  // The RIFF size counts everything after its own eight bytes.
  if (u32le(bytes, 4) + 8 > bytes.length) {
    return null;
  }
  switch (ascii(bytes, 12, 4)) {
    case 'VP8 ':
      if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) {
        return null;
      }
      return sized('image/webp', u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff);
    case 'VP8L': {
      if (bytes[20] !== 0x2f) {
        return null;
      }
      const bits = u32le(bytes, 21);
      return sized('image/webp', (bits & 0x3fff) + 1, (Math.floor(bits / 0x4000) & 0x3fff) + 1);
    }
    case 'VP8X':
      return sized('image/webp', u24le(bytes, 24) + 1, u24le(bytes, 27) + 1);
    default:
      return null;
  }
}

/**
 * What a picture's own bytes say it is, and its size; `null` when they are
 * not a PNG, JPEG or WebP whose size can be read.
 */
export function sniffImage(bytes: Uint8Array): ImageInfo | null {
  return png(bytes) ?? jpeg(bytes) ?? webp(bytes);
}
