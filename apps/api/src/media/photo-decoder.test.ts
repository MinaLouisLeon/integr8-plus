import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderThumbnail } from './thumbnails.js';

/**
 * Uploads are decoded as real photos only (SEC-003). A file is judged by its
 * bytes, whatever type was declared, so the danger is an SVG or PDF sent as
 * `image/jpeg`; it must be refused before libvips parses it.
 *
 * The samples are made before the decoder's block is switched on (the first
 * thumbnail switches it on for this process), since making them needs the
 * loaders and savers the block leaves alone or that run first.
 */

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>',
);
const PDF = Buffer.from(
  '%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n',
  'latin1',
);

const photos: Record<string, Uint8Array> = {};

beforeAll(async () => {
  const base = sharp({ create: { width: 64, height: 48, channels: 3, background: '#2a7' } });
  photos.jpeg = new Uint8Array(await base.clone().jpeg().toBuffer());
  photos.png = new Uint8Array(await base.clone().png().toBuffer());
  photos.webp = new Uint8Array(await base.clone().webp().toBuffer());
  photos.avif = new Uint8Array(await base.clone().avif().toBuffer());
});

describe('the photo decoder', () => {
  it.each(['jpeg', 'png', 'webp', 'avif'])(
    'makes a thumbnail from a real %s photo',
    async (kind) => {
      const thumbnail = await renderThumbnail(photos[kind]!);
      expect((await sharp(thumbnail).metadata()).format).toBe('webp');
    },
  );

  it('refuses SVG bytes, whatever they were declared as, without reading them', async () => {
    await expect(renderThumbnail(new Uint8Array(SVG))).rejects.toThrow(
      /unsupported image format/iu,
    );
  });

  it('refuses PDF bytes dressed as a photo', async () => {
    await expect(renderThumbnail(new Uint8Array(PDF))).rejects.toThrow(
      /unsupported image format/iu,
    );
  });
});
