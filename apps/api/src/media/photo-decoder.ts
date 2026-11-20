import sharp from 'sharp';

/**
 * The image decoder for files people upload: real photos only (SEC-003).
 *
 * libvips reads a file by what its bytes are, whatever type the uploader
 * declared, and it can read far more than photos: SVG through librsvg, PDF,
 * TIFF, and others with a history of parser bugs. A file uploaded as
 * `image/jpeg` whose bytes are SVG would reach librsvg in the thumbnail job.
 * So before this process decodes any upload, every libvips loader is blocked
 * and only the four photo loaders, reading from memory, are allowed back:
 * JPEG, PNG, WebP and HEIF (which reads HEIC and AVIF). Anything else is
 * refused before it is parsed ("unsupported image format"), and the callers
 * already treat a refusal as "no thumbnail" or "no picture".
 *
 * The block is process-wide and set once. Code that must decode SVG on purpose
 * (the business samples tool, which draws its own pictures) does so before it
 * first calls this.
 */

/** The libvips loaders a photo may use, reading from a buffer. */
export const PHOTO_LOADERS = [
  'VipsForeignLoadJpegBuffer',
  'VipsForeignLoadPngBuffer',
  'VipsForeignLoadWebpBuffer',
  'VipsForeignLoadHeifBuffer',
] as const;

let guarded = false;

/** sharp, with every loader but the photo ones blocked for this process. */
export function photoDecoder(): typeof sharp {
  if (!guarded) {
    sharp.block({ operation: ['VipsForeignLoad'] });
    sharp.unblock({ operation: [...PHOTO_LOADERS] });
    guarded = true;
  }
  return sharp;
}
