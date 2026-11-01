import { describe, expect, it } from 'vitest';
import { sniffImage } from './images.js';
import { JPEG, PNG, WEBP_EXTENDED, WEBP_LOSSLESS, WEBP_LOSSY } from './test-support/fixtures.js';

describe('sniffImage', () => {
  it.each([
    ['PNG', PNG, 'image/png'],
    ['JPEG', JPEG, 'image/jpeg'],
    ['lossy WebP', WEBP_LOSSY, 'image/webp'],
    ['lossless WebP', WEBP_LOSSLESS, 'image/webp'],
    ['extended WebP', WEBP_EXTENDED, 'image/webp'],
  ])('reads a %s and its size', (_name, bytes, contentType) => {
    expect(sniffImage(bytes)).toEqual({ contentType, width: 3, height: 2 });
  });

  it.each([
    ['nothing', new Uint8Array()],
    ['text', new TextEncoder().encode('GIF89a this is not what it seems, not at all')],
    ['a GIF', Buffer.from('R0lGODlhAQABAAAAACw=', 'base64')],
    ['a PNG signature alone', PNG.subarray(0, 8)],
    ['a PNG cut short', PNG.subarray(0, 20)],
    ['a JPEG start alone', JPEG.subarray(0, 3)],
    ['a JPEG with no frame header', Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0])],
    ['a WebP cut short', WEBP_LOSSY.subarray(0, 24)],
  ])('refuses %s', (_name, bytes) => {
    expect(sniffImage(bytes)).toBeNull();
  });

  it('refuses a picture with no pixels', () => {
    const empty = Buffer.from(PNG);
    empty.writeUInt32BE(0, 16);
    expect(sniffImage(empty)).toBeNull();
  });

  it('refuses a WebP whose RIFF size runs past the file', () => {
    const lying = Buffer.from(WEBP_LOSSY);
    lying.writeUInt32LE(lying.length * 2, 4);
    expect(sniffImage(lying)).toBeNull();
  });
});
