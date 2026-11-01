import sharp from 'sharp';
import type { BackgroundImage } from './backgrounds.js';

/**
 * Images, made fit to print (ADR-0001 D4).
 *
 * A phone photo is twelve megapixels; a PDF page needs a fraction of that. Each
 * picture is turned the right way up, shrunk to what an A4 page can show, and
 * re-encoded: JPEG for photographs, PNG where there is transparency (a
 * signature, a logo). Anything that is not an image sharp can read is left out
 * rather than failing the document.
 */

/** Longest side of a picture placed in the content, in pixels: a full-width photo at 200 dpi. */
const CONTENT_MAX_PX = 1600;
/**
 * A4 at 300 dpi, for backgrounds drawn edge to edge: 2480 x 3508 portrait,
 * 3508 x 2480 landscape (1.3.0). A picture of another shape is fitted inside
 * and stretched to the page when drawn, so the designer asks for these sizes.
 */
export const BACKGROUND_PIXELS = {
  portrait: { width: 2480, height: 3508 },
  landscape: { width: 3508, height: 2480 },
} as const;

/**
 * A picture as a data URI for the page. `maxPx` lowers the longest side for
 * pictures printed small, such as a job report's photo grid.
 */
export async function inlineImage(
  bytes: Uint8Array,
  maxPx: number = CONTENT_MAX_PX,
): Promise<string | undefined> {
  const prepared = await prepare(bytes, { width: maxPx, height: maxPx });
  return prepared === undefined
    ? undefined
    : `data:image/${prepared.format};base64,${Buffer.from(prepared.bytes).toString('base64')}`;
}

export async function backgroundImage(
  bytes: Uint8Array,
  orientation: 'portrait' | 'landscape' = 'portrait',
): Promise<BackgroundImage | undefined> {
  return prepare(bytes, BACKGROUND_PIXELS[orientation]);
}

async function prepare(
  bytes: Uint8Array,
  box: { width: number; height: number },
): Promise<BackgroundImage | undefined> {
  try {
    const image = sharp(bytes, { limitInputPixels: 80_000_000 }).rotate().resize({
      width: box.width,
      height: box.height,
      fit: 'inside',
      withoutEnlargement: true,
    });
    const { hasAlpha } = await image.metadata();
    if (hasAlpha) {
      return {
        format: 'png',
        bytes: new Uint8Array(await image.png({ compressionLevel: 9 }).toBuffer()),
      };
    }
    return {
      format: 'jpeg',
      bytes: new Uint8Array(
        await image.flatten({ background: '#ffffff' }).jpeg({ quality: 85 }).toBuffer(),
      ),
    };
  } catch {
    return undefined;
  }
}
