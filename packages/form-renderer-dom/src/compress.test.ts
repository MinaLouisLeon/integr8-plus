import { afterEach, describe, expect, it, vi } from 'vitest';
import { fitWithin, PHOTO_MAX_EDGE, PHOTO_QUALITY, preparePhoto } from './compress.js';

/**
 * The compression rules, with the browser's decoder and canvas stood in for:
 * jsdom has neither. That the real ones produce a 2048-pixel photo is checked
 * in a browser, against the running app.
 */

interface Encoded {
  width: number;
  height: number;
  type: string;
  quality: number | undefined;
}

function fakeBrowser(image: { width: number; height: number }, encodedBytes: number) {
  const encoded: Encoded[] = [];
  const close = vi.fn();
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(() => Promise.resolve({ width: image.width, height: image.height, close })),
  );
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      constructor(
        readonly width: number,
        readonly height: number,
      ) {}
      getContext() {
        return { drawImage: vi.fn(), imageSmoothingQuality: 'low' };
      }
      convertToBlob(options: { type: string; quality?: number }) {
        encoded.push({
          width: this.width,
          height: this.height,
          type: options.type,
          quality: options.quality,
        });
        return Promise.resolve(new Blob([new Uint8Array(encodedBytes)], { type: options.type }));
      }
    },
  );
  return { encoded, close };
}

const photo = (bytes: number, type = 'image/jpeg') =>
  new File([new Uint8Array(bytes)], 'photo', { type });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('fitting a photo', () => {
  it('scales the longest edge to 2048 pixels and keeps the shape', () => {
    expect(PHOTO_MAX_EDGE).toBe(2048);
    expect(fitWithin(4032, 3024)).toEqual({ width: 2048, height: 1536, scaled: true });
    expect(fitWithin(3024, 4032)).toEqual({ width: 1536, height: 2048, scaled: true });
    expect(fitWithin(2048, 100)).toEqual({ width: 2048, height: 100, scaled: false });
    expect(fitWithin(20_000, 3)).toEqual({ width: 2048, height: 1, scaled: true });
  });
});

describe('preparing a photo', () => {
  it('sends a large camera photo at 2048 pixels and quality 0.82, as its own type', async () => {
    const { encoded, close } = fakeBrowser({ width: 4032, height: 3024 }, 700_000);
    const prepared = await preparePhoto(photo(5_000_000));
    expect(prepared).toMatchObject({ contentType: 'image/jpeg', compressed: true });
    expect(prepared.blob.size).toBe(700_000);
    expect(encoded).toEqual([{ width: 2048, height: 1536, type: 'image/jpeg', quality: 0.82 }]);
    expect(PHOTO_QUALITY).toBe(0.82);
    expect(close).toHaveBeenCalled();
  });

  it('re-encodes a small JPEG only if that makes it smaller', async () => {
    fakeBrowser({ width: 800, height: 600 }, 90_000);
    const original = photo(60_000);
    expect(await preparePhoto(original)).toEqual({
      blob: original,
      contentType: 'image/jpeg',
      compressed: false,
    });

    fakeBrowser({ width: 800, height: 600 }, 40_000);
    expect((await preparePhoto(photo(60_000))).compressed).toBe(true);
  });

  it('resizes a PNG losslessly, and leaves a small one alone', async () => {
    const { encoded } = fakeBrowser({ width: 3000, height: 3000 }, 1_000);
    await preparePhoto(photo(2_000_000, 'image/png'));
    expect(encoded).toEqual([{ width: 2048, height: 2048, type: 'image/png', quality: undefined }]);

    const small = fakeBrowser({ width: 300, height: 300 }, 1_000);
    const original = photo(50_000, 'image/png');
    expect((await preparePhoto(original)).blob).toBe(original);
    expect(small.encoded).toEqual([]);
  });

  it('sends the original when the browser cannot decode or encode it', async () => {
    const heic = photo(3_000_000, 'image/heic');
    fakeBrowser({ width: 4000, height: 3000 }, 1);
    expect((await preparePhoto(heic)).blob).toBe(heic);

    vi.stubGlobal('createImageBitmap', () => Promise.reject(new Error('cannot decode')));
    const broken = photo(3_000_000);
    expect((await preparePhoto(broken)).blob).toBe(broken);

    vi.unstubAllGlobals();
    const unsupported = photo(3_000_000);
    expect((await preparePhoto(unsupported)).blob).toBe(unsupported);
  });

  it('never sends an animation as a still', async () => {
    const { encoded } = fakeBrowser({ width: 4000, height: 3000 }, 1);
    const gif = photo(3_000_000, 'image/gif');
    expect((await preparePhoto(gif)).blob).toBe(gif);
    expect(encoded).toEqual([]);
  });
});
