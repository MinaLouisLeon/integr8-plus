/**
 * What may become a company logo, decided before any bytes leave the browser (P18).
 *
 * The API has its own rules — a type a browser would execute is refused, the
 * plan's storage allowance applies, and the settings route refuses anything
 * that is not a stored image — and those still run. This is the earlier, kinder
 * check: it tells somebody their 40 MB TIFF is not going to work before they
 * have waited for it to upload and been told by a 422.
 */

/**
 * The three formats every browser draws and every PDF renderer embeds.
 *
 * No SVG, although it is the natural format for a logo: the API refuses it
 * because an SVG is a document that can carry script, and a file that one
 * company's owner uploads is shown on pages other people in that company
 * read. No GIF because a logo does not need to move.
 */
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/**
 * Two megabytes, in the same SI units `formatBytes` shows.
 *
 * A logo is drawn at a few hundred pixels at most; anything larger than this
 * is a photograph of a logo, and will be downloaded by every document that
 * carries it.
 */
export const LOGO_MAX_BYTES = 2_000_000;

export type LogoProblem = 'wrong_type' | 'too_large';

/** Null when the file can be the logo; otherwise what is wrong with it, type first. */
export function checkLogo(file: { type: string; size: number }): LogoProblem | null {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) {
    return 'wrong_type';
  }
  if (file.size > LOGO_MAX_BYTES) {
    return 'too_large';
  }
  return null;
}
