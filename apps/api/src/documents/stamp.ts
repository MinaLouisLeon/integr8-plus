import { qrMatrix } from '@integr8/document-render';
import type { QrPlacement } from '@integr8/db';
import { PDFDocument, rgb } from 'pdf-lib';
import { z } from 'zod';

/**
 * The share QR code stamped into an uploaded PDF (0075).
 *
 * The person chose where it goes when uploading (or later, on the document's
 * page): the first, the last or every page, its top-left corner and its width
 * as fractions of the page, so the same choice fits a page of any size. The
 * code is drawn as vector squares on a white square, so it scans at any zoom
 * and prints sharp. The PDF as uploaded is never changed: this makes a copy,
 * and the original stays beside it to stamp again or to go back to.
 */

/** A placement as the API takes it: inside the page, between 5% and 50% of its width. */
export const qrPlacementSchema = z
  .object({
    page: z.enum(['first', 'last', 'all']),
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    size: z.number().min(0.05).max(0.5),
  })
  .refine((placement) => placement.x + placement.size <= 1.0001, {
    message: 'The QR code must fit across the page.',
    path: ['x'],
  });

export async function stampQr(
  bytes: Uint8Array,
  placement: QrPlacement,
  link: string,
): Promise<{ bytes: Uint8Array; pageCount: number }> {
  const pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
  const pages = pdf.getPages();
  const chosen =
    placement.page === 'all'
      ? pages
      : placement.page === 'last'
        ? pages.slice(-1)
        : pages.slice(0, 1);
  const code = qrMatrix(link);
  for (const page of chosen) {
    const { width, height } = page.getSize();
    const side = placement.size * width;
    // Kept inside the page whatever the page's shape: the fractions were
    // chosen on one page, and another page may be shorter.
    const left = Math.min(placement.x * width, width - side);
    const top = Math.min(placement.y * height, height - side);
    // PDF coordinates start at the bottom left.
    const bottom = height - top - side;
    page.drawRectangle({ x: left, y: bottom, width: side, height: side, color: rgb(1, 1, 1) });
    const module = side / code.size;
    for (let y = 0; y < code.size; y += 1) {
      for (let x = 0; x < code.size; x += 1) {
        if (code.dark(x, y)) {
          page.drawRectangle({
            x: left + x * module,
            y: bottom + side - (y + 1) * module,
            width: module,
            height: module,
            color: rgb(0, 0, 0),
          });
        }
      }
    }
  }
  return { bytes: await pdf.save(), pageCount: pages.length };
}
