/**
 * Photos are made smaller on the device, before they are uploaded.
 *
 * This is the single decision that most controls a company's storage bill, and
 * how long an upload takes over a site's weak signal, so it is fixed here rather
 * than left to each app:
 *
 * - **Longest edge 2048 pixels.** Enough to read a gauge, a serial plate or a
 *   crack in a flue at full-screen size on a laptop; a modern phone's 4000-pixel
 *   photo is four times the pixels for detail nobody zooms into.
 * - **Quality 0.82**, JPEG or WebP. Artefacts are not visible at that size, and a
 *   typical site photo lands between 400 KB and 900 KB, against 3–6 MB straight
 *   from the camera.
 *
 * A JPEG or WebP stays its own type; a PNG is resized but stays lossless, since
 * a PNG is usually a screenshot or a drawing where JPEG artefacts are ugly. The
 * original is sent unchanged when the browser cannot decode it (HEIC outside
 * Safari, say), when it is a type that is not a still photo (GIF), or when
 * re-encoding would not make it smaller. Re-encoding drops the camera's
 * metadata, GPS position included; a form that needs a location asks for it.
 */

export const PHOTO_MAX_EDGE = 2048;
export const PHOTO_QUALITY = 0.82;

const REENCODED = new Set(['image/jpeg', 'image/webp']);
const RESIZED = new Set(['image/jpeg', 'image/webp', 'image/png']);

/** The size a photo is drawn at: its own, or scaled so the longest edge is `maxEdge`. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge = PHOTO_MAX_EDGE,
): { width: number; height: number; scaled: boolean } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) {
    return { width, height, scaled: false };
  }
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
    scaled: true,
  };
}

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
