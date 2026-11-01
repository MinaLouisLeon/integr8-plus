import { PDFJS, readAsset } from '../assets.js';
import type { Chrome } from './cdp.js';

/**
 * Pictures of a PDF's first pages, for the AI to look at. pdf.js draws each
 * page on a canvas inside the same browser that printed it; nothing is
 * installed and nothing leaves the machine. The pages are pictures of the
 * real PDF, not of the HTML before printing, so what the AI sees is what
 * staff will get.
 */

export interface PagePictures {
  /** Every page the PDF has. */
  pageCount: number;
  /** PNG bytes, one per page drawn, first page first. */
  pages: Uint8Array[];
}

/** 1.25 × 96 dpi: an A4 page about 1,000 pixels wide, readable and not too heavy. */
const SCALE = 1.25;

export async function rasterizePdf(
  chrome: Chrome,
  pdf: Uint8Array,
  maxPages: number,
): Promise<PagePictures> {
  const decoder = new TextDecoder();
  const library = decoder.decode(readAsset(PDFJS.library));
  const worker = decoder.decode(readAsset(PDFJS.worker));
  const tab = await chrome.newPage({ javaScript: true });
  try {
    const script = `(async () => {
      const url = (source) => URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      // The worker's code runs on this page rather than in a Worker: pdf.js
      // does that when it finds the module on globalThis.pdfjsWorker.
      globalThis.pdfjsWorker = await import(url(${JSON.stringify(worker)}));
      const pdfjs = await import(url(${JSON.stringify(library)}));
      const base64 = ${JSON.stringify(Buffer.from(pdf).toString('base64'))};
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const doc = await pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
      const images = [];
      for (let number = 1; number <= Math.min(doc.numPages, ${String(maxPages)}); number += 1) {
        const page = await doc.getPage(number);
        const viewport = page.getViewport({ scale: ${String(SCALE)} });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext('2d');
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport }).promise;
        images.push(canvas.toDataURL('image/png').slice('data:image/png;base64,'.length));
      }
      return { pageCount: doc.numPages, images };
    })()`;
    const result = await tab.evaluate<{ pageCount: number; images: string[] }>(script);
    return {
      pageCount: result.pageCount,
      pages: result.images.map((image) => new Uint8Array(Buffer.from(image, 'base64'))),
    };
  } finally {
    await tab.close();
  }
}
