/**
 * Photos are made smaller in the browser, before they are uploaded, to the
 * size and quality `@integr8/form-input` fixes for every renderer (see there for
 * why those numbers).
 *
 * A JPEG or WebP stays its own type; a PNG is resized but stays lossless, since
 * a PNG is usually a screenshot or a drawing where JPEG artefacts are ugly. The
 * original is sent unchanged when the browser cannot decode it (HEIC outside
 * Safari, say), when it is a type that is not a still photo (GIF), or when
 * re-encoding would not make it smaller. Re-encoding drops the camera's
 * metadata, GPS position included; a form that needs a location asks for it.
 */

import { fitWithin, PHOTO_QUALITY } from '@integr8/form-input';

export { fitWithin, PHOTO_MAX_EDGE, PHOTO_QUALITY } from '@integr8/form-input';

const REENCODED = new Set(['image/jpeg', 'image/webp']);
const RESIZED = new Set(['image/jpeg', 'image/webp', 'image/png']);

export interface PreparedPhoto {
  blob: Blob;
  contentType: string;
  /** Whether what is sent differs from what was chosen. */
  compressed: boolean;
}

/** Makes a photo ready to upload, following the rules above. Never throws: the worst case is the original. */
export async function preparePhoto(file: Blob, contentType = file.type): Promise<PreparedPhoto> {
  const original = { blob: file, contentType, compressed: false };
  if (!RESIZED.has(contentType) || typeof createImageBitmap !== 'function') {
    return original;
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return original;
  }

  try {
    const size = fitWithin(bitmap.width, bitmap.height);
    if (!size.scaled && !REENCODED.has(contentType)) {
      return original;
    }
    const blob = await draw(bitmap, size, contentType);
    if (blob?.type !== contentType) {
      // The browser could not encode this type, and fell back to another.
      return original;
    }
    if (!size.scaled && blob.size >= file.size) {
      return original;
    }
    return { blob, contentType, compressed: true };
  } catch {
    return original;
  } finally {
    bitmap.close();
  }
}

async function draw(
  bitmap: ImageBitmap,
  size: { width: number; height: number },
  contentType: string,
): Promise<Blob | null> {
  const quality = REENCODED.has(contentType) ? PHOTO_QUALITY : undefined;
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(size.width, size.height);
    const context = canvas.getContext('2d');
    if (context === null) {
      return null;
    }
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    return canvas.convertToBlob(
      quality === undefined ? { type: contentType } : { type: contentType, quality },
    );
  }
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext('2d');
  if (context === null) {
    return null;
  }
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  return new Promise((resolve) => {
    canvas.toBlob(resolve, contentType, quality);
  });
}
