import type { PdfPageRenderer } from '@integr8/operations-dom';

/**
 * One page of a PDF drawn on a canvas, for placing an uploaded PDF's QR code
 * (0075). pdf.js is loaded only when first asked, its worker as a file the
 * bundler copies next to the page; no script in the PDF runs.
 */
export const renderPdfPage: PdfPageRenderer = async (bytes, page, canvas, width) => {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  const document = await pdfjs.getDocument({
    data: bytes.slice(),
    isEvalSupported: false,
    enableXfa: false,
  }).promise;
  try {
    const number = page === 'last' ? document.numPages : Math.min(page, document.numPages);
    const loaded = await document.getPage(number);
    const unscaled = loaded.getViewport({ scale: 1 });
    const ratio = window.devicePixelRatio || 1;
    const viewport = loaded.getViewport({ scale: (width / unscaled.width) * ratio });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const context = canvas.getContext('2d');
    if (context !== null) {
      await loaded.render({ canvasContext: context, viewport }).promise;
    }
    return { pages: document.numPages, aspect: unscaled.width / unscaled.height };
  } finally {
    await document.destroy();
  }
};
