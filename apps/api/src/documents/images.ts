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
/** A4 at 300 dpi, for backgrounds drawn edge to edge. */
const BACKGROUND_WIDTH_PX = 2480;
const BACKGROUND_HEIGHT_PX = 3508;

export async function inlineImage(bytes: Uint8Array): Promise<string | undefined> {
  const prepared = await prepare(bytes, { width: CONTENT_MAX_PX, height: CONTENT_MAX_PX });
  return prepared === undefined
    ? undefined
    : `data:image/${prepared.format};base64,${Buffer.from(prepared.bytes).toString('base64')}`;
}

export async function backgroundImage(bytes: Uint8Array): Promise<BackgroundImage | undefined> {
  return prepare(bytes, { width: BACKGROUND_WIDTH_PX, height: BACKGROUND_HEIGHT_PX });
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
