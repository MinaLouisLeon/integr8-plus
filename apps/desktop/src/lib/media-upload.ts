import type { Integr8Client } from '@integr8/api-client';

/**
 * Uploading a company's logo or app icon, and deciding beforehand whether it can be one.
 *
 * The API has its own rules — a type a browser would execute is refused, the
 * plan's storage allowance applies, and the settings route refuses anything
 * that is not a stored image — and those still run. This is the earlier,
 * kinder check: it tells somebody their 40 MB TIFF is not going to work before
 * they have waited for it to upload and been told by a 422.
 *
 * The upload itself is the same three steps a photo from a form takes (see
 * `apiMediaAdapter` in `@integr8/form-renderer-dom/screens`): ask for a signed
 * link, put the bytes there, then tell the API the bytes arrived. Written here
 * rather than imported because that adapter carries a form's progress and
 * caching concerns that a one-off settings upload has no use for.
 */

/**
 * The three formats every browser draws and every PDF renderer embeds. No SVG,
 * because an SVG is a document that can carry script and is shown to other
 * people in the company; no GIF, because a logo does not need to move.
 */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** Two megabytes: a logo is drawn at a few hundred pixels at most. */
export const IMAGE_MAX_BYTES = 2_000_000;

/** The smallest square an app store will accept as an icon. */
export const APP_ICON_MIN_SIZE = 512;

export type ImageProblem = 'wrong_type' | 'too_large' | 'not_square' | 'too_small' | 'unreadable';

/** Null when the file can be an image of ours; otherwise what is wrong, type first. */
export function checkImageFile(file: { type: string; size: number }): ImageProblem | null {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) {
    return 'wrong_type';
  }
  if (file.size > IMAGE_MAX_BYTES) {
    return 'too_large';
  }
  return null;
}

/** Null when the dimensions will do for an app icon. */
export function checkIconDimensions(size: { width: number; height: number }): ImageProblem | null {
  if (size.width !== size.height) {
    return 'not_square';
  }
  if (size.width < APP_ICON_MIN_SIZE) {
    return 'too_small';
  }
  return null;
}

/** Decodes just enough of the file to learn its size; null when it is not an image after all. */
export async function readImageSize(file: Blob): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      return size;
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
}

/** Everything that is checked before an app icon is uploaded: type, size, then shape. */
export async function checkAppIcon(file: File): Promise<ImageProblem | null> {
  const basic = checkImageFile(file);
  if (basic !== null) {
    return basic;
  }
  const size = await readImageSize(file);
  if (size === null) {
    return 'unreadable';
  }
  return checkIconDimensions(size);
}

/** Uploads the file and returns the id of the stored media, ready to be written to the settings. */
export async function uploadMedia(client: Integr8Client, file: File): Promise<string> {
  const created = (
    await client.POST('/v1/media', {
      params: { header: { 'Idempotency-Key': crypto.randomUUID() } },
      body: { contentType: file.type, byteSize: file.size },
    })
  ).data!;

  const put = await fetch(created.upload.url, {
    method: created.upload.method,
    headers: created.upload.headers,
    body: file,
  });
  if (!put.ok) {
    throw new Error(`upload refused: ${String(put.status)}`);
  }

  // The reference carries what storage confirmed, not what was declared.
  const stored = (
    await client.POST('/v1/media/{mediaId}/complete', {
      params: { path: { mediaId: created.media.id } },
    })
  ).data!;
  return stored.id;
}
